import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { BUNDLE_LIMITS, BundleStop, packBundle, verifyBundleDir, type BundleLimits, type PackOptions } from "@/lib/design-agent/imagefirst-worker/bundle";
import type { WorkerReceipt } from "@/lib/design-agent/imagefirst-worker/cycle";
import { createFakeReceiver, deliverBundle, DeliveryStop, fakeTransport, registerSealed, ReceiverStop, type BundlePayload } from "@/lib/design-agent/imagefirst-worker/transport";
import { colourPng } from "../phase2f/fixtures";

// Hashing, PNG checks and copies of multi-MB fixtures: under a loaded runner a test can take longer than vitest's
// default 5 s (seen as a timeout, never a wrong result). The same limit as the other imagefirst-worker files.
vi.setConfig({ testTimeout: 60_000 });

// Issue #302 P2: the private result bundle and its delivery, against a FAKE transport and receiver only. No Codex, no
// worker, no network. The run directory and receipt are built here in the exact shape cycle.ts writes them.

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
const NOW = Date.parse("2026-11-20T04:00:00Z");
const ID = "hoshigama-imagefirst-d3-20261120-01";
const PLAN_ID = "hoshigama-imagefirst-p3-20261120";
const COMMIT = "c".repeat(40);
const NAMES = ["pc-1", "pc-2", "sp-1", "sp-2", "sp-3", "sp-4"];
const EXPECTED = { approval_id: ID, plan_id: PLAN_ID, commit: COMMIT };

type Run = { runs: string; runDir: string; receiptPath: string; receipt: WorkerReceipt; comps: { pc: string; sp: string }; bundles: string; state: string; inbox: string };

/** A finished run as cycle.ts leaves it: <runs>/<id>-<UTC>/ (0700) with parts/, call.json, prompts/, and the 0600 receipt. */
function makeRun(o: { composites?: boolean; editReceipt?: (r: WorkerReceipt) => void } = {}): Run {
  const runs = tmp("sr-runs-");
  const runDir = join(runs, `${ID}-20261120T040000Z`);
  mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const images = NAMES.map((n, i) => {
    const bytes = colourPng(512 + i, 520);
    writeFileSync(join(runDir, "parts", `${n}.png`), bytes, { mode: 0o600 });
    return { file: `parts/${n}.png`, sha256: sha(bytes), bytes: bytes.length };
  });
  // the run's other private files are never bundled (the prompt text in particular)
  mkdirSync(join(runDir, "prompts"), { mode: 0o700 });
  writeFileSync(join(runDir, "prompts", "pc-1.txt"), "PROMPT TEXT NEVER BUNDLED", { mode: 0o600 });
  writeFileSync(join(runDir, "call.json"), JSON.stringify({ status: "succeeded", images }), { mode: 0o600 });
  const comps = { pc: "", sp: "" };
  if (o.composites !== false) {
    mkdirSync(join(runDir, "composites"), { mode: 0o700 });
    const pc = colourPng(720, 1600);
    const sp = colourPng(390, 1800);
    writeFileSync(join(runDir, "composites", "pc.png"), pc, { mode: 0o600 });
    writeFileSync(join(runDir, "composites", "sp.png"), sp, { mode: 0o600 });
    comps.pc = sha(pc);
    comps.sp = sha(sp);
  }
  const receipt: WorkerReceipt = {
    schema: "imagefirst_worker_receipt_v1",
    status: "succeeded",
    stop_code: null,
    stage: null,
    cli_exit: 0,
    cli_timed_out: false,
    interrupted: false,
    shop: "hoshigama",
    direction: "d3",
    approval_id: ID,
    plan_id: PLAN_ID,
    commit: COMMIT,
    packet_sha256: "a".repeat(64),
    plan_sha256: "b".repeat(64),
    prompt_sha256: "d".repeat(64),
    prompt_chars: 12338,
    run_dir: runDir,
    images,
    stopped_images: [],
    counts: { pc: 2, sp: 4, total: 6, stopped: 0 },
    verified: true,
    timings: { started_at: "2026-11-20T04:00:00.000Z", finished_at: "2026-11-20T04:10:00.000Z", elapsed_ms: 600_000 },
  };
  o.editReceipt?.(receipt);
  const receiptPath = join(runs, `${ID}-20261120T040000Z.receipt.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  const base = tmp("sr-bundle-");
  return { runs, runDir, receiptPath, receipt, comps, bundles: join(base, "bundles"), state: join(base, "state"), inbox: join(base, "inbox") };
}
/** Replaces one file and rewrites manifest.json and SHA256SUMS to agree with it (a forger who knows the format). */
function reseal(dir: string, path: string, bytes: Buffer): BundlePayload["entries"] {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { files: { path: string; sha256: string; bytes: number }[]; total_bytes: number; sha256sums_sha256: string };
  writeFileSync(join(dir, path), bytes);
  const f = m.files.find((x) => x.path === path)!;
  m.total_bytes += bytes.length - f.bytes;
  Object.assign(f, { sha256: sha(bytes), bytes: bytes.length });
  const sums = m.files.map((x) => `${x.sha256}  ${x.path}\n`).join("");
  m.sha256sums_sha256 = sha(sums);
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  return [...m.files.map((x) => x.path), "SHA256SUMS", "manifest.json"].map((p) => ({ path: p, bytes: readFileSync(join(dir, p)) }));
}
const packOf = (r: Run, extra: Partial<PackOptions> = {}) => packBundle({ runDir: r.runDir, receiptPath: r.receiptPath, bundlesDir: r.bundles, composites: r.comps.pc ? r.comps : undefined, now: () => NOW, ...extra });
const codeOf = async (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof BundleStop || e instanceof DeliveryStop || e instanceof ReceiverStop ? e.code : `THREW ${String(e)}`));
const receiverFor = (r: Run, now = () => NOW) => createFakeReceiver({ inboxDir: r.inbox, expected: (id) => (id === ID ? EXPECTED : null), now });

describe("pack → sealed → delivered → receiver verifies (success)", () => {
  it("seals PC 2 + SP 4 + both composites + receipt, delivers once, and the receiver reads the same bytes", async () => {
    const r = makeRun();
    const sealed = await packOf(r);
    expect(sealed.bundle_id).toBe(ID);
    expect(sealed.dir).toBe(join(realpathSync(r.bundles), ID));
    expect(statSync(sealed.dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(sealed.dir, { recursive: true }).map(String).sort();
    expect(files).toEqual(["SHA256SUMS", "composites", "composites/pc.png", "composites/sp.png", "manifest.json", "parts", ...NAMES.map((n) => `parts/${n}.png`), "receipt.json"].sort());
    for (const f of files) expect(statSync(join(sealed.dir, f)).mode & 0o777).toBe(statSync(join(sealed.dir, f)).isDirectory() ? 0o700 : 0o600);

    // the bundle SHA is the manifest's bytes; the manifest pins every file, and carries no prompt text and no path
    const manifestBytes = readFileSync(join(sealed.dir, "manifest.json"));
    expect(sealed.bundle_sha256).toBe(sha(manifestBytes));
    const m = sealed.manifest;
    expect(m).toMatchObject({ approval_id: ID, plan_id: PLAN_ID, commit: COMMIT, counts: { pc: 2, sp: 4, composites: 2, files: 9 }, access: { visibility: "private", retrieval_ttl_seconds: 900 }, retention: { retain_days: 7, delete_after: "2026-11-27T04:00:00.000Z" } });
    for (const i of r.receipt.images) expect(m.files).toContainEqual({ path: i.file, role: "part", sha256: i.sha256, bytes: i.bytes });
    expect(m.files).toContainEqual({ path: "composites/pc.png", role: "composite", sha256: r.comps.pc, bytes: expect.any(Number) });
    // the bundled receipt is the original with the local run_dir redacted; the original bytes' SHA is kept in the manifest
    const bundledReceipt = readFileSync(join(sealed.dir, "receipt.json"));
    expect(m.receipt_original_sha256).toBe(sha(readFileSync(r.receiptPath)));
    expect(m.receipt_sha256).toBe(sha(bundledReceipt));
    expect(JSON.parse(bundledReceipt.toString("utf8"))).toEqual({ ...r.receipt, run_dir: "private_outside_repo" });
    expect(bundledReceipt.toString("utf8")).not.toContain(r.runDir);
    const text = manifestBytes.toString("utf8");
    expect(text).not.toContain("PROMPT");
    expect(text).not.toContain(r.runDir);
    const sums = readFileSync(join(sealed.dir, "SHA256SUMS"), "utf8");
    expect(sha(sums)).toBe(m.sha256sums_sha256);
    expect(sums.trim().split("\n")).toHaveLength(9);
    for (const line of sums.trim().split("\n")) {
      const [h, p] = line.split("  ");
      expect(sha(readFileSync(join(sealed.dir, p!)))).toBe(h);
    }

    const job = await registerSealed(r.state, sealed, () => NOW);
    expect(job).toMatchObject({ state: "sealed", attempts: 0, bundle_sha256: sealed.bundle_sha256 });
    const receiver = receiverFor(r);
    const transport = fakeTransport(receiver);
    const res = await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport, now: () => NOW });
    expect(res).toMatchObject({ state: "delivered", sent: true, code: null, ack: { status: "accepted", bundle_sha256: sealed.bundle_sha256 } });
    expect(res.job.attempts).toBe(1);
    expect(JSON.parse(readFileSync(join(r.state, "deliveries", `${ID}.json`), "utf8"))).toMatchObject({ state: "delivered", bundle_sha256: sealed.bundle_sha256 });

    // the owner's side reads every picture back with the short-lived grant, byte for byte
    const got = await receiver.read(ID, res.ack!.retrieval.token);
    for (const n of NAMES) expect(got.find((e) => e.path === `parts/${n}.png`)!.bytes).toEqual(readFileSync(join(r.runDir, "parts", `${n}.png`)));
    expect(got.find((e) => e.path === "composites/sp.png")!.bytes).toEqual(readFileSync(join(r.runDir, "composites", "sp.png")));
    expect(await verifyBundleDir(join(r.inbox, ID), { expected: { ...EXPECTED, bundle_sha256: sealed.bundle_sha256 } })).toMatchObject({ bundle_sha256: sealed.bundle_sha256 });

    // delivered is final: another deliver() sends nothing
    const again = await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport, now: () => NOW });
    expect(again).toMatchObject({ state: "delivered", sent: false });
    expect(transport.calls).toBe(1);
  });

  it("composites are optional; once sealed, a second pack of the same approval is refused (immutable)", async () => {
    const r = makeRun({ composites: false });
    const sealed = await packOf(r);
    expect(sealed.manifest.counts).toMatchObject({ composites: 0, files: 7 });
    const before = readFileSync(join(sealed.dir, "manifest.json"));
    expect(await codeOf(packOf(r, { now: () => NOW + 1000 }))).toBe("BUNDLE_EXISTS");
    expect(readFileSync(join(sealed.dir, "manifest.json"))).toEqual(before);
    expect(readdirSync(realpathSync(r.bundles))).toEqual([ID]);
  });
});

describe("pack fails closed and leaves nothing under the bundle's name", () => {
  const refused = async (r: Run, code: string, extra: Partial<PackOptions> = {}) => {
    expect(await codeOf(packOf(r, extra))).toBe(code);
    expect(existsSync(join(r.bundles, ID))).toBe(false);
    if (existsSync(r.bundles)) expect(readdirSync(r.bundles)).toEqual([]);
  };

  it("a tampered picture (SHA differs from the receipt)", async () => {
    const r = makeRun();
    writeFileSync(join(r.runDir, "parts", "sp-2.png"), colourPng(600, 600));
    await refused(r, "RUN_FILE_SHA_MISMATCH");
  });
  it("a missing picture", async () => {
    const r = makeRun();
    rmSync(join(r.runDir, "parts", "pc-2.png"));
    await refused(r, "RUN_FILE_MISSING");
  });
  it("an extra file in parts/ or an unnamed composite", async () => {
    const r = makeRun();
    writeFileSync(join(r.runDir, "parts", "sp-5.png"), colourPng(512, 512), { mode: 0o600 });
    await refused(r, "RUN_FILE_UNEXPECTED");
    const r2 = makeRun();
    await refused(r2, "RUN_FILE_UNEXPECTED", { composites: { pc: r2.comps.pc } }); // sp.png present, its SHA not given
  });
  it("a symlinked picture, a symlinked parts/ directory, a symlinked run dir", async () => {
    const r = makeRun();
    const elsewhere = join(tmp("sr-else-"), "x.png");
    writeFileSync(elsewhere, readFileSync(join(r.runDir, "parts", "pc-1.png")));
    rmSync(join(r.runDir, "parts", "pc-1.png"));
    symlinkSync(elsewhere, join(r.runDir, "parts", "pc-1.png"));
    await refused(r, "RUN_FILE_LINK");

    const r2 = makeRun();
    const moved = join(tmp("sr-else-"), "parts");
    mkdirSync(moved);
    for (const n of readdirSync(join(r2.runDir, "parts"))) writeFileSync(join(moved, n), readFileSync(join(r2.runDir, "parts", n)));
    rmSync(join(r2.runDir, "parts"), { recursive: true });
    symlinkSync(moved, join(r2.runDir, "parts"));
    await refused(r2, "RUN_FILE_LINK");

    const r3 = makeRun();
    const link = join(r3.runs, "link-run");
    symlinkSync(r3.runDir, link);
    await refused(r3, "RUN_DIR_UNSAFE", { runDir: link });
  });
  it("path traversal in the receipt ('../') is refused before anything is read", async () => {
    const r = makeRun({ editReceipt: (x) => void (x.images[0]!.file = "parts/../../../etc/passwd.png") });
    await refused(r, "RUN_FILE_OUTSIDE");
    const r2 = makeRun({ editReceipt: (x) => void (x.images[0]!.file = "/etc/pc-1.png") });
    await refused(r2, "RUN_FILE_OUTSIDE");
    const r3 = makeRun({ editReceipt: (x) => void (x.images[0]!.file = "prompts/pc-1.txt") });
    await refused(r3, "RUN_FILE_OUTSIDE");
  });
  it("an oversized picture (lowered limit) and the hard total cap", async () => {
    const r = makeRun();
    const small: BundleLimits = { ...BUNDLE_LIMITS, part: { ...BUNDLE_LIMITS.part, maxBytes: 1000 } };
    await refused(r, "RUN_FILE_TOO_LARGE", { limits: small });
    await refused(makeRun(), "TOTAL_TOO_LARGE", { limits: { ...BUNDLE_LIMITS, totalBytes: 50_000 } });
    // limits can only be lowered
    await refused(makeRun(), "LIMITS_RAISED", { limits: { ...BUNDLE_LIMITS, totalBytes: BUNDLE_LIMITS.totalBytes + 1 } });
  });
  it("an oversized picture at the real 24 MiB cap", async () => {
    const big = Buffer.concat([colourPng(512, 512), Buffer.alloc(BUNDLE_LIMITS.part.maxBytes)]);
    const r = makeRun({ editReceipt: (x) => void Object.assign(x.images[0]!, { sha256: sha(big), bytes: big.length }) });
    writeFileSync(join(r.runDir, "parts", "pc-1.png"), big);
    await refused(r, "RUN_FILE_TOO_LARGE");
  });
  it("a file that is not a PNG (right SHA, wrong signature or a truncated PNG)", async () => {
    const fake = Buffer.from("GIF89a not a png at all, but the receipt names its SHA");
    const r = makeRun({ editReceipt: (x) => void Object.assign(x.images[1]!, { sha256: sha(fake), bytes: fake.length }) });
    writeFileSync(join(r.runDir, "parts", "pc-2.png"), fake);
    await refused(r, "RUN_FILE_NOT_PNG");
    const cut = colourPng(512, 512).subarray(0, 400);
    const r2 = makeRun({ editReceipt: (x) => void Object.assign(x.images[2]!, { sha256: sha(cut), bytes: cut.length }) });
    writeFileSync(join(r2.runDir, "parts", "sp-1.png"), cut);
    await refused(r2, "RUN_FILE_NOT_PNG");
  });
  it("receipt mismatches: a stopped run, wrong counts, another run dir, a size mismatch, an open receipt, a bad id", async () => {
    await refused(makeRun({ editReceipt: (x) => Object.assign(x, { status: "stopped", stop_code: "CLI_TIMEOUT" }) }), "RECEIPT_NOT_SUCCEEDED");
    await refused(makeRun({ editReceipt: (x) => void (x.verified = false) }), "RECEIPT_NOT_SUCCEEDED");
    await refused(makeRun({ editReceipt: (x) => void x.images.pop() }), "RECEIPT_NOT_SUCCEEDED");
    await refused(makeRun({ editReceipt: (x) => void (x.run_dir = "/somewhere/else") }), "RECEIPT_RUN_DIR_MISMATCH");
    await refused(makeRun({ editReceipt: (x) => void (x.images[3]!.bytes += 1) }), "RUN_FILE_SHA_MISMATCH");
    await refused(makeRun({ editReceipt: (x) => void (x.approval_id = "otherkiln-imagefirst-d3-20261120-01") }), "RECEIPT_INVALID");
    const open = makeRun();
    chmodSync(open.receiptPath, 0o644);
    await refused(open, "RECEIPT_UNREADABLE");
    const gone = makeRun();
    rmSync(gone.receiptPath);
    await refused(gone, "RECEIPT_UNREADABLE");
    await refused(makeRun(), "COMPOSITE_SHA_INVALID", { composites: { pc: "nothex" } });
  });
});

describe("the sealed bundle cannot be changed without detection", () => {
  it("tampered, missing, extra, symlinked files in a sealed bundle stop verify and stop delivery (stays sealed)", async () => {
    const cases: [string, (dir: string) => void][] = [
      ["BUNDLE_FILE_SHA_MISMATCH", (d) => writeFileSync(join(d, "parts", "sp-3.png"), colourPng(513, 520))],
      ["BUNDLE_FILE_SET_MISMATCH", (d) => rmSync(join(d, "parts", "sp-3.png"))],
      ["BUNDLE_FILE_SET_MISMATCH", (d) => writeFileSync(join(d, "parts", "sp-9.png"), colourPng(512, 512), { mode: 0o600 })],
      ["BUNDLE_LINK_OR_SPECIAL", (d) => symlinkSync("/etc/hostname", join(d, "parts", "zz.png"))],
      ["BUNDLE_SUMS_MISMATCH", (d) => writeFileSync(join(d, "SHA256SUMS"), "0".repeat(64) + "  receipt.json\n")],
      ["BUNDLE_DIR_UNSAFE", (d) => chmodSync(d, 0o755)],
    ];
    for (const [code, edit] of cases) {
      const r = makeRun();
      const sealed = await packOf(r);
      await registerSealed(r.state, sealed, () => NOW);
      edit(sealed.dir);
      expect(await codeOf(verifyBundleDir(sealed.dir))).toBe(code);
      const transport = fakeTransport(receiverFor(r));
      const res = await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport, now: () => NOW });
      expect(res).toMatchObject({ state: "sealed", sent: false, code: "BUNDLE_CHANGED" });
      expect(transport.calls).toBe(0);
    }
  });

  it("a re-packed bundle with the same ID but different bytes is never sent under the registered job", async () => {
    const r = makeRun();
    const sealed = await packOf(r);
    await registerSealed(r.state, sealed, () => NOW);
    // swap the directory for a fresh, internally consistent pack of the same approval made at another time
    rmSync(sealed.dir, { recursive: true });
    const other = await packOf(r, { now: () => NOW + 60_000 });
    expect(other.bundle_sha256).not.toBe(sealed.bundle_sha256);
    const transport = fakeTransport(receiverFor(r));
    expect(await deliverBundle({ stateDir: r.state, bundleDir: other.dir, bundleId: ID, transport })).toMatchObject({ state: "sealed", code: "BUNDLE_CHANGED", sent: false });
    expect(transport.calls).toBe(0);
    expect(await codeOf(registerSealed(r.state, other))).toBe("JOB_EXISTS_DIFFERENT");
  });
});

describe("delivery: interrupted send, duplicates, conflicts, the receiver's own checks", () => {
  it("an interrupted send stays sealed; the re-send is of the SAME SHA and succeeds; nothing is regenerated", async () => {
    const r = makeRun();
    const sealed = await packOf(r);
    await registerSealed(r.state, sealed, () => NOW);
    const receiver = receiverFor(r);
    const transport = fakeTransport(receiver, { fail: ["before", "after", null] });
    const sent: string[] = [];
    const spy = { send: (p: BundlePayload, s?: AbortSignal) => (sent.push(p.bundle_sha256), transport.send(p, s)) };

    const a = await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport: spy });
    expect(a).toMatchObject({ state: "sealed", code: "TRANSPORT_FAILED" });
    expect(existsSync(join(r.inbox, ID))).toBe(false);
    // the receiver stored it, the ack was lost: still sealed (never "delivered" without the receiver's confirmation)
    const b = await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport: spy });
    expect(b).toMatchObject({ state: "sealed", code: "TRANSPORT_FAILED" });
    expect(existsSync(join(r.inbox, ID))).toBe(true);
    // the re-send: the receiver already has this SHA → duplicate, acknowledged → delivered
    const c = await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport: spy, now: () => NOW });
    expect(c).toMatchObject({ state: "delivered", code: null, ack: { status: "duplicate", bundle_sha256: sealed.bundle_sha256 } });
    expect(c.job.attempts).toBe(3);
    expect(sent).toEqual([sealed.bundle_sha256, sealed.bundle_sha256, sealed.bundle_sha256]);
    expect(readFileSync(join(sealed.dir, "manifest.json"))).toEqual(readFileSync(join(r.inbox, ID, "manifest.json")));
  });

  it("a process killed mid-send (job left 'delivering') is re-sendable; a wrong ack is not 'delivered'; attempts are capped", async () => {
    const r = makeRun();
    const sealed = await packOf(r);
    const job = await registerSealed(r.state, sealed, () => NOW);
    writeFileSync(join(r.state, "deliveries", `${ID}.json`), JSON.stringify({ ...job, state: "delivering", attempts: 1 }), { mode: 0o600 });
    const bad = fakeTransport(receiverFor(r), { tamperAck: true });
    expect(await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport: bad })).toMatchObject({ state: "sealed", code: "RECEIVER_SHA_MISMATCH" });
    const down = fakeTransport(receiverFor(r), { fail: ["before", "before", "before", "before", "before", "before"] });
    for (let i = 0; i < 3; i++) await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport: down });
    const capped = await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport: down });
    expect(capped).toMatchObject({ state: "sealed", code: "ATTEMPTS_EXHAUSTED", sent: false });
    expect(down.calls).toBe(3);
    expect(await codeOf(deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: "hoshigama-imagefirst-d3-20261120-02", transport: down }))).toBe("JOB_MISSING");
  });

  it("duplicate delivery of the same SHA is a no-op; the same ID with different bytes is refused", async () => {
    const r = makeRun();
    const sealed = await packOf(r);
    const receiver = receiverFor(r);
    const payload = { bundle_id: ID, bundle_sha256: sealed.bundle_sha256, entries: (await verifyBundleDir(sealed.dir)).entries };
    expect((await receiver.receive(payload)).status).toBe("accepted");
    const kept = lstatSync(join(r.inbox, ID, "manifest.json")).ino;
    expect((await receiver.receive(payload)).status).toBe("duplicate");
    expect(lstatSync(join(r.inbox, ID, "manifest.json")).ino).toBe(kept);

    // a second, internally consistent bundle for the same approval (a re-pack at another time): refused, nothing replaced
    const r2 = makeRun();
    const other = await packOf({ ...r2, bundles: join(tmp("sr-b2-"), "bundles") }, { now: () => NOW + 5000 });
    const conflict = { bundle_id: ID, bundle_sha256: other.bundle_sha256, entries: (await verifyBundleDir(other.dir)).entries };
    expect(await codeOf(receiver.receive(conflict))).toBe("BUNDLE_ID_CONFLICT");
    expect(lstatSync(join(r.inbox, ID, "manifest.json")).ino).toBe(kept);
    expect(readdirSync(r.inbox).sort()).toEqual([".records", ID]); // no staging left behind
    expect(readdirSync(join(r.inbox, ".records"))).toEqual([`${ID}.json`]);
  });

  it("the receiver re-checks everything: claimed SHA, paths, PNGs, the expected approval / plan / commit", async () => {
    const r = makeRun();
    const sealed = await packOf(r);
    const entries = (await verifyBundleDir(sealed.dir)).entries;
    const ok = { bundle_id: ID, bundle_sha256: sealed.bundle_sha256, entries };
    const swap = (path: string, bytes: Buffer) => entries.map((e) => (e.path === path ? { path, bytes } : e));
    const check = async (receiver: ReturnType<typeof receiverFor>, p: BundlePayload, code: string) => {
      expect(await codeOf(receiver.receive(p))).toBe(code);
      expect(existsSync(join(r.inbox, ID))).toBe(false);
    };
    const rec = receiverFor(r);
    await check(rec, { ...ok, bundle_sha256: "f".repeat(64) }, "BUNDLE_SHA_MISMATCH");
    await check(rec, { ...ok, entries: [...entries, { path: "../escape.png", bytes: Buffer.from("x") }] }, "PAYLOAD_INVALID");
    await check(rec, { ...ok, entries: [...entries, { path: "parts/../../x.png", bytes: Buffer.from("x") }] }, "PAYLOAD_INVALID");
    await check(rec, { ...ok, entries: entries.filter((e) => e.path !== "parts/sp-4.png") }, "BUNDLE_FILE_SET_MISMATCH");
    await check(rec, { ...ok, entries: [...entries, entries[0]!] }, "PAYLOAD_INVALID");
    await check(rec, { ...ok, entries: swap("parts/pc-1.png", colourPng(512, 512)) }, "BUNDLE_FILE_SHA_MISMATCH");
    await check(rec, { ...ok, entries: swap("SHA256SUMS", Buffer.from("tampered\n")) }, "BUNDLE_SUMS_MISMATCH");
    await check(rec, { ...ok, bundle_id: "hoshigama-imagefirst-d3-20261120-02" }, "NOT_EXPECTED");
    for (const wrong of [{ ...EXPECTED, plan_id: "hoshigama-imagefirst-p3-20261121" }, { ...EXPECTED, commit: "e".repeat(40) }, { ...EXPECTED, approval_id: "hoshigama-imagefirst-d3-20261120-09" }]) {
      await check(createFakeReceiver({ inboxDir: r.inbox, expected: () => wrong, now: () => NOW }), ok, "BUNDLE_RECORD_MISMATCH");
    }
    // a non-PNG that the manifest and SHA256SUMS were rewritten to agree with is still refused by the receiver
    const forged = makeRun();
    const fs = await packOf(forged);
    const forgedEntries = reseal(fs.dir, "composites/pc.png", Buffer.from("GIF89a not a png"));
    await check(rec, { bundle_id: ID, bundle_sha256: sha(forgedEntries.find((e) => e.path === "manifest.json")!.bytes), entries: forgedEntries }, "BUNDLE_FILE_NOT_PNG");
    expect(await codeOf(verifyBundleDir(fs.dir))).toBe("BUNDLE_FILE_NOT_PNG");
    expect(readdirSync(r.inbox)).toEqual([]);
  });

  it("the retrieval grant is short-lived; retention deletes the receiver's copy", async () => {
    const r = makeRun();
    const sealed = await packOf(r);
    let t = NOW;
    const receiver = receiverFor(r, () => t);
    const ack = await receiver.receive({ bundle_id: ID, bundle_sha256: sealed.bundle_sha256, entries: (await verifyBundleDir(sealed.dir)).entries });
    expect(Date.parse(ack.retrieval.expires_at) - NOW).toBe(15 * 60 * 1000);
    expect(await codeOf(receiver.read(ID, "nope"))).toBe("GRANT_INVALID");
    t = NOW + 15 * 60 * 1000 + 1;
    expect(await codeOf(receiver.read(ID, ack.retrieval.token))).toBe("GRANT_EXPIRED");
    expect(await receiver.purgeExpired()).toEqual([]);
    t = Date.parse(sealed.manifest.retention.delete_after) + 1;
    expect(await receiver.purgeExpired()).toEqual([ID]);
    expect(existsSync(join(r.inbox, ID))).toBe(false);
  });

  it("retention and grant come from the RECEIVER's clock and constants, never from the sender's manifest", async () => {
    // the sender packed it a year ago: the receiver still keeps it 7 days from ITS receive time and grants 15 minutes
    const r = makeRun();
    const sealed = await packOf(r, { now: () => NOW - 365 * 86_400_000 });
    let t = NOW;
    const receiver = receiverFor(r, () => t);
    const ack = await receiver.receive({ bundle_id: ID, bundle_sha256: sealed.bundle_sha256, entries: (await verifyBundleDir(sealed.dir)).entries });
    expect(Date.parse(ack.retrieval.expires_at)).toBe(NOW + 15 * 60 * 1000);
    expect(await receiver.purgeExpired()).toEqual([]);
    t = NOW + 7 * 86_400_000 + 1;
    expect(await receiver.purgeExpired()).toEqual([ID]);
    // fail closed: a kept bundle without the receiver's own record is deleted on the next purge
    const r2 = makeRun();
    const s2 = await packOf(r2);
    const rec2 = receiverFor(r2);
    await rec2.receive({ bundle_id: ID, bundle_sha256: s2.bundle_sha256, entries: (await verifyBundleDir(s2.dir)).entries });
    rmSync(join(r2.inbox, ".records", `${ID}.json`));
    expect(await rec2.purgeExpired()).toEqual([ID]);
  });

  it("the sender's declared terms must be exact: a bad, far, or missing delete_after (and friends) is refused", async () => {
    type Terms = { created_at?: unknown; access: Record<string, unknown>; retention?: Record<string, unknown> };
    const edits: [string, (m: Terms) => void][] = [
      ["not-a-date", (m) => void (m.retention!.delete_after = "not-a-date")],
      ["year 2999", (m) => void (m.retention!.delete_after = "2999-01-01T00:00:00.000Z")],
      ["missing delete_after", (m) => void delete m.retention!.delete_after],
      ["missing retention", (m) => void delete m.retention],
      ["retain_days 99999", (m) => void (m.retention!.retain_days = 99999)],
      ["created_at x", (m) => void (m.created_at = "x")],
      ["ttl 99999", (m) => void (m.access.retrieval_ttl_seconds = 99999)],
      ["public", (m) => void (m.access.visibility = "public")],
      ["extra term", (m) => void (m.retention!.keep_forever = true)],
    ];
    for (const [label, edit] of edits) {
      const r = makeRun();
      const sealed = await packOf(r);
      const m = JSON.parse(readFileSync(join(sealed.dir, "manifest.json"), "utf8")) as Terms;
      edit(m);
      const bytes = Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
      writeFileSync(join(sealed.dir, "manifest.json"), bytes);
      const code = await codeOf(verifyBundleDir(sealed.dir));
      expect([label, code]).toEqual([label, label === "missing retention" || label === "public" ? expect.stringMatching(/^BUNDLE_(MANIFEST|TERMS)_INVALID$/) : "BUNDLE_TERMS_INVALID"]);
      const entries = [...sealed.manifest.files.map((f) => f.path), "SHA256SUMS"].map((p) => ({ path: p, bytes: readFileSync(join(sealed.dir, p)) }));
      const receiver = receiverFor(r);
      expect(await codeOf(receiver.receive({ bundle_id: ID, bundle_sha256: sha(bytes), entries: [...entries, { path: "manifest.json", bytes }] }))).toMatch(/^BUNDLE_(MANIFEST|TERMS)_INVALID$/);
      expect(existsSync(join(r.inbox, ID))).toBe(false);
    }
  });

  it("an invalid job file is refused (never more than 5 sends); a caller cannot raise the cap", async () => {
    const r = makeRun();
    const sealed = await packOf(r);
    const job = await registerSealed(r.state, sealed, () => NOW);
    const file = join(r.state, "deliveries", `${ID}.json`);
    const t = fakeTransport(receiverFor(r), { fail: Array(10).fill("before") as "before"[] });
    for (const bad of [{ ...job, attempts: undefined }, { ...job, attempts: 99 }, { ...job, attempts: -1 }, { ...job, attempts: 1.5 }]) {
      writeFileSync(file, JSON.stringify(bad), { mode: 0o600 });
      expect(await codeOf(deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport: t }))).toBe("JOB_UNREADABLE");
    }
    expect(t.calls).toBe(0);
    writeFileSync(file, JSON.stringify(job), { mode: 0o600 });
    for (let i = 0; i < 8; i++) await deliverBundle({ stateDir: r.state, bundleDir: sealed.dir, bundleId: ID, transport: t, maxAttempts: 10 });
    expect(t.calls).toBe(5);
  });

  it("the receiver checks sizes before writing, and concurrent receives of one ID give duplicate / conflict codes", async () => {
    const r = makeRun();
    const sealed = await packOf(r);
    const entries = (await verifyBundleDir(sealed.dir)).entries;
    const small: BundleLimits = { ...BUNDLE_LIMITS, part: { ...BUNDLE_LIMITS.part, maxBytes: 1000 } };
    const tiny = createFakeReceiver({ inboxDir: r.inbox, expected: () => EXPECTED, now: () => NOW, limits: small });
    expect(await codeOf(tiny.receive({ bundle_id: ID, bundle_sha256: sealed.bundle_sha256, entries }))).toBe("BUNDLE_FILE_TOO_LARGE");
    expect(existsSync(r.inbox)).toBe(false); // nothing was written, not even the inbox

    const receiver = receiverFor(r);
    const ok = { bundle_id: ID, bundle_sha256: sealed.bundle_sha256, entries };
    const both = await Promise.all([receiver.receive(ok), receiver.receive(ok)]);
    expect(both.map((a) => a.status).sort()).toEqual(["accepted", "duplicate"]);

    const r2 = makeRun();
    const a = await packOf({ ...r2, bundles: join(tmp("sr-b3-"), "bundles") });
    const b = await packOf({ ...r2, bundles: join(tmp("sr-b4-"), "bundles") }, { now: () => NOW + 1000 });
    const rec2 = createFakeReceiver({ inboxDir: join(tmp("sr-in-"), "inbox"), expected: () => EXPECTED, now: () => NOW });
    const results = await Promise.all([a, b].map(async (s) => codeOf(rec2.receive({ bundle_id: ID, bundle_sha256: s.bundle_sha256, entries: (await verifyBundleDir(s.dir)).entries }))));
    expect(results.sort()).toEqual(["BUNDLE_ID_CONFLICT", "OK"]);
  });
});

describe("the bundle and transport cannot reach Codex or the worker", () => {
  it("imports only node built-ins and the PNG checker (no worker, entry, Codex, image tool, process or network)", () => {
    for (const file of ["lib/design-agent/imagefirst-worker/bundle.ts", "lib/design-agent/imagefirst-worker/transport.ts"]) {
      const src = readFileSync(resolve(REPO, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((x) => x[1]!).sort();
      expect(imports).toContain("node:fs/promises");
      // ./run-directions: the per-direction allowlist (data and pure lookups; its own imports are pinned below)
      const allowed = new Set(["node:crypto", "node:fs", "node:fs/promises", "node:path", "../design-image/png", "./bundle", "./run-directions"]);
      expect(imports.filter((i) => !allowed.has(i))).toEqual([]);
      expect(src).not.toMatch(/\brequire\(|import\(|child_process|node:net|node:http|node:https|fetch\(|cycle|imagefirst-worker\.ts|image-first-generate|codex|image-once|phase2f-live|bounded-process/i);
    }
    // the allowlist table reaches only the packet table, which imports nothing
    const code = (rel: string) => readFileSync(resolve(REPO, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const importsOf = (rel: string) => [...code(rel).matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((x) => x[1]!);
    expect(importsOf("lib/design-agent/imagefirst-worker/run-directions.ts")).toEqual(["../phase2f-live/approval-packets"]);
    expect(importsOf("lib/design-agent/phase2f-live/approval-packets.ts")).toEqual([]);
    for (const rel of ["lib/design-agent/imagefirst-worker/run-directions.ts", "lib/design-agent/phase2f-live/approval-packets.ts"]) expect(code(rel)).not.toMatch(/\brequire\(|import\(|node:|fetch\(/);
  });
});
