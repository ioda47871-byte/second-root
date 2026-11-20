import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkPng } from "@/lib/design-agent/design-image/png";
import { verifyBundleDir } from "@/lib/design-agent/imagefirst-worker/bundle";
import { handOffToLocalInbox, InboxStop, localInboxTransport, removeFromInbox } from "@/lib/design-agent/imagefirst-worker/local-inbox";
import { buildPreviews, PREVIEW_LIMITS, previewsOf, PreviewStop, verifyPreviews } from "@/lib/design-agent/imagefirst-worker/preview";
import { COLOURS, DUMMY_ID, DUMMY_RECORD, makeDummyBundle, runReviewPoc, SHAPES } from "@/lib/design-agent/imagefirst-worker/review-poc";
import { ReceiverStop } from "@/lib/design-agent/imagefirst-worker/transport";

// Issue #302 P3: the local review hand-off (inbox + previews) and its dummy PoC. Harmless synthetic images generated at
// run time, temporary directories only. No Codex, no model, no image tool, no network.
vi.setConfig({ testTimeout: 120_000 });

const REPO = resolve(__dirname, "../../../..");
const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(d, 0o700);
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const NOW = Date.parse("2026-11-20T12:00:00Z");
/** A deterministic "random" (a different seed gives different pictures). */
const seeded = (seed: number) => {
  let x = seed;
  return (n: number) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % n;
  };
};
/** <root>/sr-runs (0700) and the inbox path below it, as on the worker user's home. */
const place = () => {
  const root = tmp("sr-rv-");
  const runs = join(root, "sr-runs");
  mkdirSync(runs, { mode: 0o700 });
  return { root, inbox: join(runs, "review-inbox"), work: tmp("sr-rv-work-") };
};
const codeOf = async (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof PreviewStop || e instanceof InboxStop || e instanceof ReceiverStop ? e.code : `THREW ${String(e)}`));
function walk(dir: string, out: { path: string; mode: number; dir: boolean }[] = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    out.push({ path: p, mode: st.mode & 0o777, dir: st.isDirectory() });
    if (st.isDirectory()) walk(p, out);
  }
  return out;
}

describe("the dummy PoC end to end (temporary directories)", () => {
  it("packs six dummy PNGs + composites, delivers them to the inbox, and writes SHA-indexed previews within the limits", async () => {
    const { inbox, work } = place();
    const r = await runReviewPoc({ workDir: work, inboxDir: inbox, now: () => NOW, rand: seeded(7) });
    expect(r.delivery.state).toBe("delivered");
    expect(r.delivery.ack?.status).toBe("accepted");
    expect(r.previews?.status).toBe("built");
    const bundleDir = join(inbox, DUMMY_ID);
    expect(r.bundleDir).toBe(bundleDir);

    // the inbox copy is the exact sealed bundle, verified against the expected record
    const v = await verifyBundleDir(bundleDir, { expected: { ...DUMMY_RECORD, bundle_sha256: r.bundle_sha256 } });
    expect(v.manifest.counts).toEqual({ pc: 2, sp: 4, composites: 2, files: 9 });
    expect(sha(readFileSync(join(bundleDir, "manifest.json")))).toBe(r.bundle_sha256);

    // previews: each within the limits, a well-formed PNG, and indexed by its source's SHA-256 (= the bundle's SHA256SUMS line)
    const ix = await verifyPreviews(join(inbox, "previews", DUMMY_ID), { bundle_sha256: r.bundle_sha256 });
    const sums = new Map(readFileSync(join(bundleDir, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => [l.slice(66), l.slice(0, 64)] as const));
    expect(ix.previews.length).toBeGreaterThan(8);
    for (const p of ix.previews) {
      const bytes = readFileSync(join(inbox, "previews", DUMMY_ID, p.file));
      expect(bytes.length).toBeLessThanOrEqual(PREVIEW_LIMITS.maxBytes);
      const info = checkPng(bytes, { maxBytes: PREVIEW_LIMITS.maxBytes, minSide: 1, maxSide: PREVIEW_LIMITS.maxSide, maxPixels: PREVIEW_LIMITS.maxSide ** 2 });
      expect([info.width, info.height]).toEqual([p.width, p.height]);
      expect(sums.get(p.source)).toBe(p.source_sha256);
      expect(sha(bytes)).toBe(p.preview_sha256);
    }
    // every part has one full preview; the tall composites are tiled (whole height covered) with an overview
    for (const n of ["pc-1", "pc-2", "sp-1", "sp-2", "sp-3", "sp-4"]) expect(ix.previews.filter((p) => p.source === `parts/${n}.png` && p.kind === "full")).toHaveLength(1);
    for (const c of ["pc", "sp"]) {
      const tiles = ix.previews.filter((p) => p.source === `composites/${c}.png` && p.kind === "tile");
      expect(tiles.length).toBeGreaterThan(1);
      expect(tiles[0]!.tile!.y0).toBe(0);
      expect(tiles.at(-1)!.tile!.y1).toBe(tiles[0]!.source_height);
      for (let i = 1; i < tiles.length; i++) expect(tiles[i]!.tile!.y0).toBeLessThan(tiles[i - 1]!.tile!.y1);
      expect(ix.previews.filter((p) => p.source === `composites/${c}.png` && p.kind === "overview")).toHaveLength(1);
    }
    const md = readFileSync(join(inbox, "previews", DUMMY_ID, "INDEX.md"), "utf8");
    expect(md).toContain(r.bundle_sha256);
    for (const p of ix.previews) expect(md).toContain(p.source_sha256);

    // what the pictures show is returned to the caller only: no inbox file names a colour, a shape or a number
    expect(r.challenges).toHaveLength(6);
    const texts = ["INDEX.json", "INDEX.md"].map((f) => readFileSync(join(inbox, "previews", DUMMY_ID, f), "utf8")).concat(["manifest.json", "receipt.json"].map((f) => readFileSync(join(bundleDir, f), "utf8")));
    const words = new RegExp(`\\b(${[...COLOURS.map((c) => c[0]), ...SHAPES].join("|")}|number|colour)\\b`, "i");
    for (const t of texts) expect(t).not.toMatch(words);
    for (const c of r.challenges) for (const t of texts) expect(t).not.toContain(`number ${c.number}`);
  });

  it("a preview really shows the dummy's colour (the background pixel matches the challenge)", async () => {
    const { inbox, work } = place();
    const r = await runReviewPoc({ workDir: work, inboxDir: inbox, now: () => NOW, rand: seeded(11) });
    for (const c of r.challenges) {
      const { data } = await sharp(join(inbox, "previews", DUMMY_ID, `${c.part}.png`)).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      const hex = `#${[...data.subarray(0, 3)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
      expect(hex).toBe(COLOURS.find((x) => x[0] === c.colour)![1]);
    }
  });

  it("writes nothing world- or group-readable: files 0600, directories 0700 (≤ 0750)", async () => {
    const { root, inbox, work } = place();
    await runReviewPoc({ workDir: work, inboxDir: inbox, now: () => NOW, rand: seeded(3) });
    const all = walk(join(root, "sr-runs"));
    expect(all.length).toBeGreaterThan(20);
    for (const e of all) {
      if (e.dir) expect(e.mode & 0o027, e.path).toBe(0);
      else expect(e.mode & 0o077, e.path).toBe(0);
    }
  });

  it("a second PoC run replaces only the fixed dummy ID (never another bundle)", async () => {
    const { inbox, work } = place();
    const a = await runReviewPoc({ workDir: work, inboxDir: inbox, now: () => NOW, rand: seeded(1) });
    const b = await runReviewPoc({ workDir: tmp("sr-rv-work2-"), inboxDir: inbox, now: () => NOW, rand: seeded(2) });
    expect(b.delivery.state).toBe("delivered");
    expect(b.bundle_sha256).not.toBe(a.bundle_sha256);
    expect((await verifyPreviews(join(inbox, "previews", DUMMY_ID))).bundle_sha256).toBe(b.bundle_sha256);
    expect(await codeOf(removeFromInbox(inbox, "../x"))).toBe("INBOX_ID_INVALID");
  });
});

describe("local inbox delivery", () => {
  it("is idempotent: the same bundle again is a no-op (same job) or a duplicate (fresh job), previews unchanged", async () => {
    const { inbox, work } = place();
    const { sealed } = await makeDummyBundle({ workDir: work, now: () => NOW, rand: seeded(5) });
    const state = join(work, "state");
    const first = await handOffToLocalInbox({ sealed, stateDir: state, inboxDir: inbox, expected: { ...DUMMY_RECORD }, now: () => NOW });
    expect(first.delivery.state).toBe("delivered");
    const before = readFileSync(join(inbox, "previews", DUMMY_ID, "INDEX.json"));
    const again = await handOffToLocalInbox({ sealed, stateDir: state, inboxDir: inbox, expected: { ...DUMMY_RECORD }, now: () => NOW });
    expect([again.delivery.state, again.delivery.sent, again.previews?.status]).toEqual(["delivered", false, "duplicate"]);
    // a lost job (fresh state) re-sends the same sealed bytes: the inbox answers "duplicate", nothing is replaced
    const fresh = await handOffToLocalInbox({ sealed, stateDir: join(work, "state2"), inboxDir: inbox, expected: { ...DUMMY_RECORD }, now: () => NOW });
    expect([fresh.delivery.state, fresh.delivery.ack?.status, fresh.previews?.status]).toEqual(["delivered", "duplicate", "duplicate"]);
    expect(readFileSync(join(inbox, "previews", DUMMY_ID, "INDEX.json")).equals(before)).toBe(true);
  });

  it("refuses another bundle under the same ID (conflict): the inbox keeps the first, no previews are rebuilt", async () => {
    const { inbox, work } = place();
    const a = await makeDummyBundle({ workDir: work, now: () => NOW, rand: seeded(21) });
    const b = await makeDummyBundle({ workDir: tmp("sr-rv-workb-"), now: () => NOW, rand: seeded(22) });
    expect(b.sealed.bundle_sha256).not.toBe(a.sealed.bundle_sha256);
    await handOffToLocalInbox({ sealed: a.sealed, stateDir: join(work, "state"), inboxDir: inbox, expected: { ...DUMMY_RECORD }, now: () => NOW });
    const r = await handOffToLocalInbox({ sealed: b.sealed, stateDir: join(work, "stateb"), inboxDir: inbox, expected: { ...DUMMY_RECORD }, now: () => NOW });
    expect([r.delivery.state, r.delivery.code, r.previews]).toEqual(["sealed", "TRANSPORT_FAILED", null]);
    const t = localInboxTransport({ inboxDir: inbox, expected: () => ({ ...DUMMY_RECORD }) });
    const payload = { bundle_id: DUMMY_ID, bundle_sha256: b.sealed.bundle_sha256, entries: (await verifyBundleDir(b.sealed.dir)).entries };
    expect(await codeOf(t.send(payload))).toBe("BUNDLE_ID_CONFLICT");
    expect((await verifyBundleDir(join(inbox, DUMMY_ID))).bundle_sha256).toBe(a.sealed.bundle_sha256);
    expect((await verifyPreviews(join(inbox, "previews", DUMMY_ID))).bundle_sha256).toBe(a.sealed.bundle_sha256);
  });

  it("refuses tampering: a changed sealed bundle is never sent; a forged payload, an unexpected ID and a changed inbox copy are refused", async () => {
    const { inbox, work } = place();
    const { sealed } = await makeDummyBundle({ workDir: work, now: () => NOW, rand: seeded(31) });
    const part = join(sealed.dir, "parts", "pc-1.png");
    const good = readFileSync(part);
    const bad = Buffer.from(good);
    bad[bad.length - 20] ^= 0xff;
    writeFileSync(part, bad);
    const r = await handOffToLocalInbox({ sealed, stateDir: join(work, "state"), inboxDir: inbox, expected: { ...DUMMY_RECORD }, now: () => NOW });
    expect([r.delivery.state, r.delivery.code]).toEqual(["sealed", "BUNDLE_CHANGED"]);
    expect(existsSync(join(inbox, DUMMY_ID))).toBe(false);
    writeFileSync(part, good);

    // the receiver re-verifies against the record it expects, not the bundle's claims
    const entries = (await verifyBundleDir(sealed.dir)).entries;
    const other = localInboxTransport({ inboxDir: inbox, expected: () => ({ ...DUMMY_RECORD, commit: "1".repeat(40) }) });
    expect(await codeOf(other.send({ bundle_id: DUMMY_ID, bundle_sha256: sealed.bundle_sha256, entries }))).toBe("BUNDLE_RECORD_MISMATCH");
    const none = localInboxTransport({ inboxDir: inbox, expected: () => null });
    expect(await codeOf(none.send({ bundle_id: DUMMY_ID, bundle_sha256: sealed.bundle_sha256, entries }))).toBe("NOT_EXPECTED");
    const forged = entries.map((e) => (e.path === "parts/pc-1.png" ? { path: e.path, bytes: bad } : e));
    const t = localInboxTransport({ inboxDir: inbox, expected: () => ({ ...DUMMY_RECORD }) });
    expect(await codeOf(t.send({ bundle_id: DUMMY_ID, bundle_sha256: sealed.bundle_sha256, entries: forged }))).toBe("BUNDLE_FILE_SHA_MISMATCH");
    expect(await codeOf(t.send({ bundle_id: DUMMY_ID, bundle_sha256: sealed.bundle_sha256, entries: [...entries, { path: "../escape.png", bytes: good }] }))).toBe("PAYLOAD_INVALID");
    expect(existsSync(join(inbox, DUMMY_ID))).toBe(false);

    // delivered, then the inbox copy changes: previews are not built from it
    const ok = await handOffToLocalInbox({ sealed, stateDir: join(work, "state-ok"), inboxDir: inbox, expected: { ...DUMMY_RECORD }, now: () => NOW });
    expect(ok.delivery.state).toBe("delivered");
    writeFileSync(join(inbox, DUMMY_ID, "parts", "sp-1.png"), bad);
    expect(await codeOf(buildPreviews({ bundleDir: join(inbox, DUMMY_ID), expected: { ...DUMMY_RECORD, bundle_sha256: sealed.bundle_sha256 }, outDir: join(inbox, "previews", "other") }))).toBe("BUNDLE_UNVERIFIED");
    expect(existsSync(join(inbox, "previews", "other"))).toBe(false);
  });

  it("refuses an open inbox parent or inbox before anything is written", async () => {
    const { root, work } = place();
    const { sealed } = await makeDummyBundle({ workDir: work, now: () => NOW, rand: seeded(41) });
    const open = join(root, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(await codeOf(handOffToLocalInbox({ sealed, stateDir: join(work, "s1"), inboxDir: join(open, "inbox"), expected: { ...DUMMY_RECORD } }))).toBe("INBOX_PARENT_UNSAFE");
    expect(existsSync(join(open, "inbox"))).toBe(false);
    const groupInbox = join(root, "sr-runs", "review-inbox");
    mkdirSync(groupInbox, { mode: 0o750 });
    chmodSync(groupInbox, 0o750);
    const r = await handOffToLocalInbox({ sealed, stateDir: join(work, "s2"), inboxDir: groupInbox, expected: { ...DUMMY_RECORD } });
    expect([r.delivery.state, r.delivery.code]).toEqual(["sealed", "TRANSPORT_FAILED"]);
    expect(readdirSync(groupInbox)).toEqual([]);
    expect(await codeOf(handOffToLocalInbox({ sealed, stateDir: join(work, "s3"), inboxDir: join(root, "sr-runs", "x"), expected: { ...DUMMY_RECORD, approval_id: "hoshigama-imagefirst-d3-20261120-01" } }))).toBe("INBOX_ID_INVALID");
  });

  it("purges bundles past the receiver's retention together with their previews", async () => {
    const { inbox, work } = place();
    const { sealed } = await makeDummyBundle({ workDir: work, now: () => NOW, rand: seeded(51) });
    await handOffToLocalInbox({ sealed, stateDir: join(work, "state"), inboxDir: inbox, expected: { ...DUMMY_RECORD }, now: () => NOW });
    expect(await localInboxTransport({ inboxDir: inbox, expected: () => null, now: () => NOW + 86_400_000 }).purgeExpired()).toEqual([]);
    expect(await localInboxTransport({ inboxDir: inbox, expected: () => null, now: () => NOW + 8 * 86_400_000 }).purgeExpired()).toEqual([DUMMY_ID]);
    expect(existsSync(join(inbox, DUMMY_ID))).toBe(false);
    expect(existsSync(join(inbox, "previews", DUMMY_ID))).toBe(false);
  });
});

describe("previews", () => {
  it("a tampered or extra preview file fails verification", async () => {
    const { inbox, work } = place();
    await runReviewPoc({ workDir: work, inboxDir: inbox, now: () => NOW, rand: seeded(61) });
    const dir = join(inbox, "previews", DUMMY_ID);
    const p = join(dir, "pc-1.png");
    const good = readFileSync(p);
    writeFileSync(p, Buffer.concat([good.subarray(0, good.length - 1), Buffer.from([good.at(-1)! ^ 1])]));
    expect(await codeOf(verifyPreviews(dir))).toBe("PREVIEW_SHA_MISMATCH");
    writeFileSync(p, good);
    writeFileSync(join(dir, "extra.png"), good, { mode: 0o600 });
    expect(await codeOf(verifyPreviews(dir))).toBe("PREVIEW_FILE_SET_MISMATCH");
    rmSync(join(dir, "extra.png"));
    expect(await codeOf(verifyPreviews(dir, { bundle_sha256: "0".repeat(64) }))).toBe("PREVIEWS_CONFLICT");
  });

  /** One delivered dummy bundle in a fresh inbox (previews built). */
  const delivered = async (seed: number) => {
    const { root, inbox, work } = place();
    const { sealed } = await makeDummyBundle({ workDir: work, now: () => NOW, rand: seeded(seed) });
    const r = await handOffToLocalInbox({ sealed, stateDir: join(work, "state"), inboxDir: inbox, expected: { ...DUMMY_RECORD }, now: () => NOW });
    expect(r.previews?.status).toBe("built");
    const expected = { ...DUMMY_RECORD, bundle_sha256: sealed.bundle_sha256 };
    return { root, inbox, work, sealed, expected, bundleDir: join(inbox, DUMMY_ID), previewsDir: join(inbox, "previews", DUMMY_ID) };
  };

  it("PR #308 review L1: an existing previews dir that is self-consistent but not derived from this bundle is refused, never reused", async () => {
    const a = await delivered(71);
    const b = await delivered(72);
    expect(b.sealed.bundle_sha256).not.toBe(a.sealed.bundle_sha256);
    // plant B's previews (other pictures) under A's name, re-labelled with A's bundle SHA: internally consistent
    rmSync(a.previewsDir, { recursive: true });
    mkdirSync(a.previewsDir, { mode: 0o700 });
    for (const f of readdirSync(b.previewsDir)) {
      let bytes = readFileSync(join(b.previewsDir, f));
      if (f.startsWith("INDEX.")) bytes = Buffer.from(bytes.toString("utf8").split(b.sealed.bundle_sha256).join(a.sealed.bundle_sha256));
      writeFileSync(join(a.previewsDir, f), bytes, { mode: 0o600 });
    }
    expect((await verifyPreviews(a.previewsDir, { bundle_sha256: a.sealed.bundle_sha256 })).bundle_sha256).toBe(a.sealed.bundle_sha256);
    expect(await codeOf(buildPreviews({ bundleDir: a.bundleDir, expected: a.expected, outDir: a.previewsDir }))).toBe("PREVIEWS_NOT_FROM_BUNDLE");
    // the hand-off (a re-run of the same sealed bundle) says the same instead of "duplicate"
    expect(await codeOf(handOffToLocalInbox({ sealed: a.sealed, stateDir: join(a.work, "state"), inboxDir: a.inbox, expected: { ...DUMMY_RECORD }, now: () => NOW }))).toBe("PREVIEWS_NOT_FROM_BUNDLE");
    // the genuine previews of A, rebuilt, are a duplicate again
    rmSync(a.previewsDir, { recursive: true });
    expect((await buildPreviews({ bundleDir: a.bundleDir, expected: a.expected, outDir: a.previewsDir })).status).toBe("built");
    expect((await buildPreviews({ bundleDir: a.bundleDir, expected: a.expected, outDir: a.previewsDir })).status).toBe("duplicate");
  });

  it("PR #308 review L2: concurrent builders: one builds, the other waits for it and reports duplicate; a claim never filled is PREVIEWS_BUSY", async () => {
    const a = await delivered(81);
    const out = (n: string) => join(a.inbox, "previews", n);
    const both = await Promise.all([0, 1].map(() => buildPreviews({ bundleDir: a.bundleDir, expected: a.expected, outDir: out("race") })));
    expect(both.map((r) => r.status).sort()).toEqual(["built", "duplicate"]);
    // the loser sees the winner's empty claim first: it waits, then verifies the winner's result
    mkdirSync(out("claimed"), { mode: 0o700 });
    const waiting = buildPreviews({ bundleDir: a.bundleDir, expected: a.expected, outDir: out("claimed"), wait: { totalMs: 20_000, stepMs: 20 } });
    await new Promise((r) => setTimeout(r, 300));
    const winner = await buildPreviews({ bundleDir: a.bundleDir, expected: a.expected, outDir: out("winner") });
    rmSync(out("claimed"), { recursive: true });
    renameSync(winner.dir, out("claimed"));
    expect((await waiting).status).toBe("duplicate");
    // a claim nobody fills: PREVIEWS_BUSY, never "duplicate" (and nothing is written into it)
    mkdirSync(out("stuck"), { mode: 0o700 });
    expect(await codeOf(buildPreviews({ bundleDir: a.bundleDir, expected: a.expected, outDir: out("stuck"), wait: { totalMs: 100, stepMs: 20 } }))).toBe("PREVIEWS_BUSY");
    expect(readdirSync(out("stuck"))).toEqual([]);
  });

  it("PR #308 review L3: removal and purge never follow a symlinked previews or .records directory", async () => {
    for (const sub of ["previews", ".records"]) {
      const a = await delivered(91);
      const outside = tmp("sr-rv-outside-");
      // what rm -rf <link>/<id> would have deleted outside the inbox
      mkdirSync(join(outside, DUMMY_ID), { mode: 0o700 });
      writeFileSync(join(outside, DUMMY_ID, "keep.txt"), "x");
      writeFileSync(join(outside, `${DUMMY_ID}.json`), "x");
      renameSync(join(a.inbox, sub), join(a.root, `moved-${sub.replace(".", "")}`));
      symlinkSync(outside, join(a.inbox, sub));
      expect(await codeOf(removeFromInbox(a.inbox, DUMMY_ID))).toBe("INBOX_SUBDIR_UNSAFE");
      expect(await codeOf(localInboxTransport({ inboxDir: a.inbox, expected: () => null, now: () => NOW + 8 * 86_400_000 }).purgeExpired())).toBe("INBOX_SUBDIR_UNSAFE");
      expect(existsSync(join(outside, DUMMY_ID, "keep.txt"))).toBe(true);
      expect(existsSync(join(outside, `${DUMMY_ID}.json`))).toBe(true);
      // nothing in the inbox was removed either (refused before the first rm)
      expect(existsSync(join(a.bundleDir, "manifest.json"))).toBe(true);
      // a group-readable one is refused the same way
      rmSync(join(a.inbox, sub));
      renameSync(join(a.root, `moved-${sub.replace(".", "")}`), join(a.inbox, sub));
      chmodSync(join(a.inbox, sub), 0o750);
      expect(await codeOf(removeFromInbox(a.inbox, DUMMY_ID))).toBe("INBOX_SUBDIR_UNSAFE");
      chmodSync(join(a.inbox, sub), 0o700);
      await removeFromInbox(a.inbox, DUMMY_ID);
      expect(existsSync(a.bundleDir)).toBe(false);
    }
  });

  it("a large noisy picture is brought under the byte cap (palette / smaller), a very tall one is tiled", async () => {
    const w = 2400;
    const h = 2400;
    // random bytes: losslessly a 1568 × 1568 preview of this would be ~7 MiB, so only the fallback can meet the cap
    const noise = randomBytes(w * h * 3);
    const png = await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
    expect(png.length).toBeGreaterThan(PREVIEW_LIMITS.maxBytes);
    const out = await previewsOf("parts/pc-1.png", png);
    expect(out).toHaveLength(1);
    expect(out[0]!.bytes.length).toBeLessThanOrEqual(PREVIEW_LIMITS.maxBytes);
    expect(Math.max(out[0]!.entry.width, out[0]!.entry.height)).toBeLessThanOrEqual(PREVIEW_LIMITS.maxSide);
    const tall = await sharp({ create: { width: 512, height: 8192, channels: 3, background: "#123456" } }).png().toBuffer();
    const tiles = await previewsOf("parts/sp-1.png", tall);
    expect(tiles.filter((t) => t.entry.kind === "tile").length).toBe(Math.ceil((8192 - PREVIEW_LIMITS.overlap) / (PREVIEW_LIMITS.maxSide - PREVIEW_LIMITS.overlap)));
    for (const t of tiles) expect(Math.max(t.entry.width, t.entry.height)).toBeLessThanOrEqual(PREVIEW_LIMITS.maxSide);
  });
});

describe("the PoC CLI", () => {
  const CLI = "scripts/sales-design-worker/imagefirst-review-poc.ts";
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: REPO, encoding: "utf8", timeout: 90_000 });

  it("refuses an inbox inside the repository and bad usage, writing nothing", () => {
    const inRepo = join(REPO, ".sr-review-inbox-test");
    const r = run(["--inbox", inRepo]);
    expect([r.status, r.stdout.trim()]).toEqual([2, "IMAGEFIRST_REVIEW_POC INBOX_INSIDE_REPO: the inbox must be outside the repository"]);
    expect(existsSync(inRepo)).toBe(false);
    expect(run(["--other"]).status).toBe(2);
  });

  it("delivers the dummy into a temporary inbox and prints the paths, the INDEX and the owner-only answers", () => {
    const { inbox } = place();
    const r = run(["--inbox", inbox]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^IMAGEFIRST_REVIEW_POC DELIVERED bundle=hoshigama-imagefirst-d3-00000000-00 sha256=[0-9a-f]{64} previews=built$/m);
    expect(r.stdout).toContain(`previews:     ${join(inbox, "previews", DUMMY_ID)}`);
    expect(r.stdout).toContain("# IMAGE_FIRST review previews");
    expect(r.stdout).toMatch(/OWNER ONLY[\s\S]*pc-1: background \w+, \w+, number \d{4}/);
    expect(existsSync(join(inbox, DUMMY_ID, "manifest.json"))).toBe(true);
  });
});

describe("the hand-off cannot reach Codex, the worker or the network", () => {
  it("imports only node built-ins, sharp, the PNG check and the existing bundle / transport modules", () => {
    const files: Record<string, string[]> = {
      "lib/design-agent/imagefirst-worker/local-inbox.ts": ["node:fs/promises", "node:path", "./bundle", "./preview", "./transport"],
      "lib/design-agent/imagefirst-worker/preview.ts": ["node:crypto", "node:fs", "node:fs/promises", "node:path", "sharp", "../design-image/png", "./bundle"],
      "lib/design-agent/imagefirst-worker/review-poc.ts": ["node:crypto", "node:fs", "node:fs/promises", "node:path", "sharp", "./bundle", "./local-inbox"],
      "scripts/sales-design-worker/imagefirst-review-poc.ts": ["node:fs/promises", "node:os", "node:path", "../../lib/design-agent/imagefirst-worker/local-inbox", "../../lib/design-agent/imagefirst-worker/review-poc"],
    };
    for (const [file, allowed] of Object.entries(files)) {
      const src = readFileSync(resolve(REPO, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
      expect(imports.filter((i) => !allowed.includes(i)), file).toEqual([]);
      expect(src, file).not.toMatch(/\brequire\(|import\(|child_process|node:net|node:http|node:https|fetch\(|cycle|imagefirst-worker\.ts|image-first-generate|codex|image-once|phase2f-live|bounded-process|anthropic|openai/i);
    }
  });

  it("nothing starts the PoC CLI (run by hand by the owner only)", () => {
    const g = spawnSync("git", ["grep", "--untracked", "-lE", "(tsx|node|npx|bun|sh|ExecStart)\\b.*imagefirst-review-poc", "--", ".", ":!tests/**", ":!docs/**", ":!.ai/**", ":!scripts/sales-design-worker/imagefirst-review-poc.ts"], { cwd: REPO, encoding: "utf8" });
    expect([g.status, g.stdout.trim()]).toEqual([1, ""]);
  });
});
