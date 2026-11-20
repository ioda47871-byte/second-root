/**
 * Issue #302 P3: hand ONE sealed private bundle to a LOCAL review inbox that the owner's jailed Claude Code
 * (`claude remote-control`, sr-jail-claude.service) can read, then write Claude-readable previews next to it. Offline:
 * no socket, no API, no child process, no model, no Codex (a test pins the import list).
 *
 * Why this place needs no new permission (docs/operations/imagefirst-review-handoff.md §1): the jailed Claude runs as
 * the requester user sr-designgen (admin.sh jail_props: `User=$req`, `BindPaths=$home`), the same user that runs the
 * IMAGE_FIRST worker and owns ~/sr-runs (0700). Inside the jail ProtectHome=tmpfs hides every other home, and the
 * requester's own home is bound back read-write. So a 0700 inbox under ~/sr-runs is readable by that Claude and by
 * nobody else, with no chmod, no group, no extra bind mount. The worker and the jailed Claude never run at the same
 * time (imagefirst-autostart.sh refuses while sr-jail-claude is active): the hand-off runs after the worker finished.
 *
 *   <inbox>/<bundle id>/           the bundle, re-verified by the receiver and renamed into place (0700 / 0600)
 *   <inbox>/.records/<id>.json     the receiver's own receive time and deletion time (RECEIVER_TERMS, 7 days)
 *   <inbox>/previews/<id>/         preview.ts: downscaled / tiled PNGs + INDEX.md / INDEX.json (source SHA-256 each)
 *
 * The receiving side is transport.ts's receiver (verifyBundleDir against the EXPECTED record, staging dir, atomic
 * rename, same ID + same SHA = duplicate, same ID + other bytes = BUNDLE_ID_CONFLICT): on one machine that receiver is
 * the endpoint itself, so it is reused here instead of written again. Its in-memory retrieval grant has no meaning for a
 * local inbox and is ignored. The delivery state machine (registerSealed / deliverBundle) is reused unchanged: a re-send
 * is only ever of the same sealed bytes, nothing here can regenerate anything.
 */
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { APPROVAL_ID_RE, type ExpectedRecord, type SealedBundle } from "./bundle";
import { buildPreviews, type PreviewResult } from "./preview";
import { createFakeReceiver, deliverBundle, registerSealed, type BundlePayload, type BundleTransport, type DeliverResult, type DeliveryAck } from "./transport";

/** The inbox under the worker's private runs directory (~/sr-runs/review-inbox). */
export const REVIEW_INBOX = "review-inbox";
export const PREVIEWS = "previews";
/** The receiver's own records (transport.ts RECORDS). */
const RECORDS = ".records";

export type InboxCode = "INBOX_PARENT_UNSAFE" | "INBOX_ID_INVALID" | "INBOX_SUBDIR_UNSAFE";
export class InboxStop extends Error {
  constructor(readonly code: InboxCode) {
    super(code);
    this.name = "InboxStop";
  }
}

/** A real directory (not a link), ours, closed to group and others. */
async function ownPrivateDir(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

/** The inbox's parent must already exist and be ours and private (e.g. ~/sr-runs, 0700): the inbox is never created in an open place. */
async function inboxParent(inboxDir: string): Promise<void> {
  if (!(await ownPrivateDir(dirname(inboxDir)))) throw new InboxStop("INBOX_PARENT_UNSAFE");
}

/**
 * Before anything is removed under `previews` or `.records` (PR #308 review L3): each must be missing or a real directory
 * of ours, 0700, reached as `<inbox>/<name>` with no link anywhere (lstat on the name itself, and its real path equal to
 * the inbox's real path + name). A symlinked or foreign one is refused, never followed: `rm` would otherwise delete
 * `<link target>/<id>` outside the inbox. Checked again right before each removal.
 */
async function safeSubdirs(inboxDir: string): Promise<void> {
  const root = await realpath(inboxDir);
  for (const name of [PREVIEWS, RECORDS]) {
    const p = join(inboxDir, name);
    const info = await lstat(p).catch((e: { code?: string }) => (e.code === "ENOENT" ? "missing" : null));
    if (info === "missing") continue;
    if (!(await ownPrivateDir(p)) || (await realpath(p).catch(() => null)) !== join(root, name)) throw new InboxStop("INBOX_SUBDIR_UNSAFE");
  }
}

export type LocalInboxOptions = { inboxDir: string; expected: (bundleId: string) => ExpectedRecord | null; now?: () => number };

/** A transport whose far end is the local review inbox. send() throws on any refusal (deliverBundle records it). */
export function localInboxTransport(o: LocalInboxOptions): BundleTransport & { purgeExpired(): Promise<string[]> } {
  const receiver = createFakeReceiver({ inboxDir: o.inboxDir, expected: o.expected, ...(o.now ? { now: o.now } : {}) });
  return {
    async send(payload: BundlePayload, signal?: AbortSignal): Promise<DeliveryAck> {
      if (signal?.aborted) throw new Error("aborted");
      await inboxParent(o.inboxDir);
      // the receiver gets its own copies of the bytes (as across a real boundary)
      return receiver.receive({ ...payload, entries: payload.entries.map((e) => ({ path: e.path, bytes: Buffer.from(e.bytes) })) });
    },
    /** Deletes bundles past the receiver's own retention, and their previews. */
    async purgeExpired(): Promise<string[]> {
      await inboxParent(o.inboxDir);
      if (!(await lstat(o.inboxDir).then(() => true, () => false))) return [];
      if (!(await ownPrivateDir(o.inboxDir))) throw new InboxStop("INBOX_PARENT_UNSAFE");
      await safeSubdirs(o.inboxDir);
      const gone = await receiver.purgeExpired();
      for (const id of gone) {
        await safeSubdirs(o.inboxDir);
        await rm(join(o.inboxDir, PREVIEWS, id), { recursive: true, force: true });
      }
      return gone;
    },
  };
}

export type HandOffOptions = {
  sealed: SealedBundle;
  /** The sender's delivery state (0700, outside the repository). */
  stateDir: string;
  inboxDir: string;
  /** What the bundle must be: the owner's approval record (not read from the bundle). */
  expected: ExpectedRecord;
  now?: () => number;
  signal?: AbortSignal;
};
export type HandOffResult = { delivery: DeliverResult; previews: PreviewResult | null; bundleDir: string | null };

/**
 * Registers the sealed bundle, delivers it to the inbox (one attempt; a failed one leaves the job sealed for a re-send of
 * the same bytes), and once delivered builds the previews from the inbox copy (verified again there).
 */
export async function handOffToLocalInbox(o: HandOffOptions): Promise<HandOffResult> {
  const id = o.sealed.bundle_id;
  if (!APPROVAL_ID_RE.test(id) || id !== o.expected.approval_id) throw new InboxStop("INBOX_ID_INVALID");
  await inboxParent(o.inboxDir);
  await registerSealed(o.stateDir, o.sealed, o.now);
  const transport = localInboxTransport({ inboxDir: o.inboxDir, expected: (b) => (b === id ? o.expected : null), ...(o.now ? { now: o.now } : {}) });
  const delivery = await deliverBundle({ stateDir: o.stateDir, bundleDir: o.sealed.dir, bundleId: id, transport, ...(o.now ? { now: o.now } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  if (delivery.state !== "delivered") return { delivery, previews: null, bundleDir: null };
  const inbox = await realpath(o.inboxDir);
  const bundleDir = join(inbox, id);
  await mkdir(join(inbox, PREVIEWS), { mode: 0o700 }).catch((e: { code?: string }) => (e.code === "EEXIST" ? undefined : Promise.reject(e)));
  const previews = await buildPreviews({ bundleDir, expected: { ...o.expected, bundle_sha256: delivery.job.bundle_sha256 }, outDir: join(inbox, PREVIEWS, id) });
  return { delivery, previews, bundleDir };
}

/** Removes one bundle (copy, record, previews) from the inbox. For the dummy PoC's fixed ID only (see review-poc.ts). */
export async function removeFromInbox(inboxDir: string, id: string): Promise<void> {
  if (!APPROVAL_ID_RE.test(id)) throw new InboxStop("INBOX_ID_INVALID");
  if (!(await lstat(inboxDir).then(() => true, () => false))) return;
  if (!(await ownPrivateDir(inboxDir))) throw new InboxStop("INBOX_PARENT_UNSAFE");
  await safeSubdirs(inboxDir);
  for (const p of [join(inboxDir, id), join(inboxDir, RECORDS, `${id}.json`), join(inboxDir, PREVIEWS, id)]) {
    await safeSubdirs(inboxDir);
    await rm(p, { recursive: true, force: true });
  }
}

