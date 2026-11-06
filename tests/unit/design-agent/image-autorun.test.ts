/**
 * DEV-186: the worker's approved demo image job — OFFLINE E2E with a mock generator. No Codex, no image tool, no
 * network. The real generation (generateImagesInOneRun) and the Codex sandbox are replaced by spies, so a test proves
 * they are never reached unless the switch is ON and every check passes. The 6 pictures are synthetic PNGs made at
 * test time under os.tmpdir() (never written to the repository); the d1-v10 PC/SP renders use the local Chromium.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDeadline } from "@/lib/design-agent/bounded-process";
import type { ImageBatchResult } from "@/lib/design-agent/design-image/image-once";
import { TSUGUTE_PHOTOS_APPROVAL_ID, TSUGUTE_PROMPT_SHA256, TSUGUTE_SLOTS } from "@/lib/design-agent/quality-pipeline/tsugute-ai-photos";

const real = vi.hoisted(() => ({ generate: vi.fn(), sandbox: vi.fn() }));
vi.mock("@/lib/design-agent/design-image/image-once", async (orig) => ({ ...(await orig<object>()), generateImagesInOneRun: real.generate }));
vi.mock("@/lib/design-agent/sandbox", async (orig) => ({ ...(await orig<object>()), prepareCodexSandbox: real.sandbox }));

import { IMAGE_AUTORUN_CONFIG, IMAGE_AUTORUN_GRANT, runImageAutorun, type ImageGenerate } from "../../../scripts/sales-design-worker/image-autorun";

const REPO = resolve(__dirname, "../../..");
// as photo-swap.ts and worker.ts: an explicit browser only when PLAYWRIGHT_CHROMIUM_EXECUTABLE is set, otherwise
// Playwright's own install (CI: `npx playwright install --with-deps chromium`)
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const SAVE = process.env.DEV186_RENDER_SAVE_DIR;
const COMMIT = "5c2e9d8b4193c66a084329a2be1c84b602c20f92";
const NOW = new Date();
const iso = (deltaMs: number) => new Date(NOW.getTime() + deltaMs).toISOString();
const HOUR = 60 * 60 * 1000;
const BOOT = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
beforeEach(() => {
  real.generate.mockReset();
  real.sandbox.mockReset();
});

function job(over: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) {
  return {
    version: 1,
    shop_id: "tsugute",
    page: "d1-v10",
    slot_ids: TSUGUTE_SLOTS.map((s) => s.slot_id),
    brief_sha256: TSUGUTE_PROMPT_SHA256,
    approval_id: "tsugute-autorun-test-01",
    approval_scope: { shop: "tsugute", max_images: 6, max_jobs: 1, expires_at: iso(12 * HOUR), ...scope },
    requested_at: iso(-60_000),
    ...over,
  };
}

function setup(o: { on?: boolean; approvals?: Array<Record<string, unknown>>; configMode?: number; noConfig?: boolean; jobId?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dev186-"));
  roots.push(root);
  const queue = join(root, "jobs");
  const out = join(root, "out");
  const state = join(root, "state");
  const etc = join(root, "etc");
  for (const d of [join(queue, "image-autorun", "inbox"), out, state, etc]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const configPath = join(etc, "image-autorun.json");
  if (!o.noConfig) {
    const approvals = o.approvals ?? [{ approval_id: "tsugute-autorun-test-01", job_id: o.jobId ?? "job-x", shop: "tsugute", max_images: 6, max_jobs: 1, expires_at: iso(12 * HOUR) }];
    writeFileSync(configPath, JSON.stringify({ version: 1, enabled: o.on ?? true, approvals }));
    chmodSync(configPath, o.configMode ?? 0o644);
  }
  // DEV-187: the grant root's cycle.sh writes (here in a 0755 dir of the test user, who stands in for root)
  const grantDir = join(root, "grant");
  mkdirSync(grantDir, { mode: 0o755 });
  chmodSync(grantDir, 0o755);
  const grantPath = join(grantDir, "grant.json");
  const grant = (over: Record<string, unknown>) => {
    writeFileSync(grantPath, JSON.stringify({ version: 1, approval_id: "tsugute-autorun-test-01", boot_id: BOOT, issued_at: iso(-60_000), expires_at: iso(15 * 60 * 1000), ...over }));
    chmodSync(grantPath, 0o644);
  };
  const put = (name: string, body: unknown, withGrant = true) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    writeFileSync(join(queue, "image-autorun", "inbox", `${name}.json`), text);
    const appr = typeof body === "object" && body !== null && typeof (body as { approval_id?: unknown }).approval_id === "string" ? (body as { approval_id: string }).approval_id : "tsugute-autorun-test-01";
    if (withGrant) grant({ job_id: name, approval_id: appr, job_sha256: createHash("sha256").update(text).digest("hex") });
  };
  const logs: string[] = [];
  const run = (extra: { generate?: ImageGenerate; trustedUid?: number; grantUid?: number; remainingMs?: number; launch?: () => Promise<never> } = {}) =>
    runImageAutorun({
      queueRoot: queue,
      outRoot: out,
      stateDir: state,
      workerCommit: COMMIT,
      deadline: new RunDeadline(Date.now() + (extra.remainingMs ?? 55 * 60 * 1000)),
      env: { ...process.env, HOME: root },
      launchBrowser: extra.launch ?? (() => chromium.launch({ headless: true, ...(CHROME ? { executablePath: CHROME } : {}) })),
      log: (l) => logs.push(l),
      configPath,
      trustedUid: extra.trustedUid ?? process.getuid!(),
      grantPath,
      ...(extra.grantUid !== undefined ? { grantUid: extra.grantUid } : {}),
      ...(extra.generate ? { generate: extra.generate } : {}),
    });
  const bucket = (b: string) => readdirSync(join(queue, "image-autorun", b)).sort();
  const audit = () => (existsSync(join(state, "image-autorun", "audit.jsonl")) ? readFileSync(join(state, "image-autorun", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  const marker = (id: string) => existsSync(join(state, "poc-approval-used", id));
  return { root, queue, out, state, configPath, grantDir, grantPath, grant, put, run, bucket, audit, marker, logs };
}

/** 6 synthetic flat-colour PNGs at each slot's 2× target, as the image tool would hand them back (in call order). */
async function mockBatch(over: Partial<ImageBatchResult> = {}): Promise<ImageBatchResult> {
  const images = [];
  for (const [i, s] of TSUGUTE_SLOTS.entries()) {
    const png = await sharp({ create: { width: s.target.width, height: s.target.height, channels: 3, background: { r: 60 + 30 * i, g: 110 + 10 * i, b: 170 - 20 * i } } }).png().toBuffer();
    images.push({ png, width: s.target.width, height: s.target.height });
  }
  return { images, outcome: "IMAGE_SAVED", stopCode: null, imageCalls: 6, imageFailed: 0, threadId: null, cliVersion: "mock-0.0.0", model: "mock-image-model", codexMs: 1, ...over };
}

describe("DEV-186 OFF by default: real generation is never invoked", () => {
  it("the switch is a root-owned file outside the repository, absent in the repository; no queue dir = nothing happens", async () => {
    expect(IMAGE_AUTORUN_CONFIG).toBe("/etc/sr-design-worker/image-autorun.json");
    expect(IMAGE_AUTORUN_GRANT).toBe("/var/cache/sr-design-image-grant/grant.json");
    const tracked = spawnSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" }).stdout;
    expect(tracked).not.toMatch(/image-autorun\.json/);
    const f = setup();
    rmSync(join(f.queue, "image-autorun"), { recursive: true });
    expect(await f.run()).toBeNull();
    expect(existsSync(join(f.queue, "image-autorun"))).toBe(false);
  });

  for (const [label, o, uidDelta] of [
    ["no switch file", { noConfig: true }, 0],
    ["enabled: false", { on: false }, 0],
    ["group/other-writable switch file", { configMode: 0o666 }, 0],
    ["switch file not owned by the trusted uid (root)", {}, 1],
  ] as const) {
    it(`${label}: HELD_AUTORUN_DISABLED, no Codex sandbox, no generation, approval not consumed`, async () => {
      const f = setup(o);
      f.put("job-a", job());
      const r = await f.run({ trustedUid: process.getuid!() + uidDelta });
      expect(r).toEqual({ code: "HELD_AUTORUN_DISABLED", jobId: "job-a" });
      expect(real.generate).not.toHaveBeenCalled();
      expect(real.sandbox).not.toHaveBeenCalled();
      expect(f.marker("tsugute-autorun-test-01")).toBe(false);
      expect(f.bucket("held")).toEqual(["job-a.json", "job-a.result.json"]);
      expect(f.audit().map((a) => a.code)).toEqual(["HELD_AUTORUN_DISABLED"]);
    });
  }
});

describe("DEV-186 ON + mock generator: job → validation → hook → 6 PNGs → ai_generated_demo → intake → swap → PC/SP renders", () => {
  it("runs the whole chain exactly once; the approval is then used up", async () => {
    const f = setup({ jobId: "job-ok" });
    const body = job();
    f.put("job-ok", body);
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    const r = await f.run({ generate: gen });
    expect(r?.code, JSON.stringify(f.audit())).toBe("DONE");
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0]![0].maxImages).toBe(6);
    expect(createHash("sha256").update(gen.mock.calls[0]![0].prompt).digest("hex")).toBe(TSUGUTE_PROMPT_SHA256);
    expect(gen.mock.calls[0]![0].timeoutMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(real.generate).not.toHaveBeenCalled();
    expect(f.marker("tsugute-autorun-test-01")).toBe(true);
    const out = r!.out!;
    // the run bundle: the manifest names this job's approval and the generator, never the consumed DEV-185 id
    const photosDir = join(out, "photos", readdirSync(join(out, "photos"))[0]!);
    const manifest = JSON.parse(readFileSync(join(photosDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ status: "complete", approval_id: "tsugute-autorun-test-01", prompt_sha256: TSUGUTE_PROMPT_SHA256, demo_only: true, model: "mock-image-model" });
    // the rights records: ai_generated_demo with provenance
    const swapManifest = JSON.parse(readFileSync(join(out, "swap-manifest.json"), "utf8")) as { slots: Array<{ slot_id: string; pc: { rights: Record<string, unknown> & { ai_provenance: Record<string, unknown> } } }> };
    expect(swapManifest.slots.map((s) => s.slot_id)).toEqual(TSUGUTE_SLOTS.map((s) => s.slot_id));
    for (const s of swapManifest.slots) {
      expect(s.pc.rights.source_kind).toBe("ai_generated_demo");
      expect(s.pc.rights.ai_provenance).toMatchObject({ approval_id: "tsugute-autorun-test-01", demo_only: true, prompt_sha256: TSUGUTE_PROMPT_SHA256 });
    }
    // PC 1440 and SP 390 renders
    expect(r!.renders!.map((p) => p.split("/").pop()).sort()).toEqual(["desktop_1440.png", "mobile_390.png"]);
    for (const p of r!.renders!) expect((await sharp(p).metadata()).width).toBe(p.endsWith("desktop_1440.png") ? 1440 : 390);
    if (SAVE) {
      mkdirSync(SAVE, { recursive: true });
      for (const p of r!.renders!) copyFileSync(p, join(SAVE, `dev186-mock-${p.split("/").pop()}`));
    }
    expect(f.bucket("done")).toEqual(["job-ok.json", "job-ok.result.json"]);
    expect(f.audit().map((a) => a.code)).toEqual(["APPROVAL_RESERVED", "GENERATED", "DONE"]);
    // the audit never carries the prompt or picture bytes
    const auditText = readFileSync(join(f.state, "image-autorun", "audit.jsonl"), "utf8");
    expect(auditText).not.toContain("kintsugi");
    expect(auditText.length).toBeLessThan(4000);

    // the same approval again (a new job file): refused, no second generation
    f.put("job-again", job({ requested_at: iso(-30_000) }));
    expect((await f.run({ generate: gen }))?.code).toBe("REFUSED_APPROVAL_REUSED");
    // the identical job file under another name: a duplicate
    f.put("job-copy", body);
    expect((await f.run({ generate: gen }))?.code).toBe("REFUSED_DUPLICATE");
    expect(gen).toHaveBeenCalledTimes(1);
  }, 180_000);
});

describe("DEV-186 refusals (switch ON, mock generator never called)", () => {
  const cases: Array<[string, unknown, string, Parameters<typeof setup>[0]?]> = [
    ["not JSON", "{", "REFUSED_JOB_INVALID"],
    ["free text field", { ...job(), prompt: "anything; rm -rf /" }, "REFUSED_JOB_INVALID"],
    ["another shop", job({ shop_id: "wagashi" }), "REFUSED_JOB_INVALID"],
    ["another brief", job({ brief_sha256: "0".repeat(64) }), "REFUSED_JOB_INVALID"],
    ["not the 6 slots", job({ slot_ids: TSUGUTE_SLOTS.slice(0, 5).map((s) => s.slot_id) }), "REFUSED_JOB_INVALID"],
    ["approval id with shell characters", job({ approval_id: "a;b$(x)" }), "REFUSED_JOB_INVALID"],
    ["more than 6 images", job({}, { max_images: 7 }), "REFUSED_LIMIT_EXCEEDED"],
    ["fewer images allowed than slots", job({}, { max_images: 5 }), "REFUSED_LIMIT_EXCEEDED"],
    ["more than one job per approval", job({}, { max_jobs: 2 }), "REFUSED_LIMIT_EXCEEDED"],
    ["a window over 24 h (PR #228 M1)", job({}, { expires_at: iso(25 * HOUR) }), "REFUSED_LIMIT_EXCEEDED"],
    ["expired", job({ requested_at: iso(-2 * HOUR) }, { expires_at: iso(-HOUR) }), "REFUSED_APPROVAL_EXPIRED"],
    ["the consumed DEV-185 approval", job({ approval_id: TSUGUTE_PHOTOS_APPROVAL_ID }), "REFUSED_APPROVAL_REUSED"],
    ["no owner approval entry", job({ approval_id: "tsugute-autorun-unknown" }), "REFUSED_NO_APPROVAL"],
    ["scope differs from the owner's entry", job({}, { expires_at: iso(6 * HOUR) }), "REFUSED_NO_APPROVAL"],
    ["the owner's entry names another job_id (PR #228 M1)", job(), "REFUSED_NO_APPROVAL", { jobId: "job-other" }],
  ];
  for (const [label, body, code, o] of cases) {
    it(`${label}: ${code}`, async () => {
      const f = setup(o);
      f.put("job-x", body);
      const gen = vi.fn<ImageGenerate>(async () => mockBatch());
      const r = await f.run({ generate: gen });
      expect(r?.code).toBe(code);
      expect(gen).not.toHaveBeenCalled();
      expect(real.generate).not.toHaveBeenCalled();
      expect(real.sandbox).not.toHaveBeenCalled();
      expect(f.marker("tsugute-autorun-test-01")).toBe(false);
      expect(f.bucket("failed").filter((n) => n.endsWith(".result.json"))).toHaveLength(1);
      expect(f.audit().at(-1)?.code).toBe(code);
    });
  }

  it("a job file that is a link is never followed (O_NOFOLLOW): REFUSED_JOB_INVALID", async () => {
    const f = setup();
    const target = join(f.root, "elsewhere.json");
    writeFileSync(target, JSON.stringify(job()));
    symlinkSync(target, join(f.queue, "image-autorun", "inbox", "job-x.json"));
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    expect((await f.run({ generate: gen }))?.code).toBe("REFUSED_JOB_INVALID");
    expect(gen).not.toHaveBeenCalled();
  });

  it("an owner entry whose own expires_at is more than 24 h from now: REFUSED_LIMIT_EXCEEDED (re-review L2)", async () => {
    const far = iso(30 * HOUR);
    const f = setup({ approvals: [{ approval_id: "tsugute-autorun-test-01", job_id: "job-x", shop: "tsugute", max_images: 6, max_jobs: 1, expires_at: far }] });
    // the job itself is in its 24 h window; only the owner's entry reaches too far (without the cap: REFUSED_NO_APPROVAL)
    f.put("job-x", job());
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    expect((await f.run({ generate: gen }))?.code).toBe("REFUSED_LIMIT_EXCEEDED");
    expect(gen).not.toHaveBeenCalled();
  });

  it("a throw after generation is FAILED_UNEXPECTED with a fixed step sub-code (no error text) and stops the path", async () => {
    const f = setup();
    f.put("job-x", job());
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    const r = await f.run({ generate: gen, launch: () => Promise.reject(new Error("secret-looking text /home/x")) });
    expect(r?.code).toBe("FAILED_UNEXPECTED");
    const last = f.audit().at(-1)!;
    expect(last).toMatchObject({ code: "FAILED_UNEXPECTED", step: "BROWSER_LAUNCH" });
    expect(JSON.stringify(f.audit())).not.toContain("secret-looking");
    expect(existsSync(join(f.state, "image-autorun", "STOPPED"))).toBe(true);
  });

  it("an approval id already in the shared one-use ledger: REFUSED_APPROVAL_REUSED", async () => {
    const f = setup();
    mkdirSync(join(f.state, "poc-approval-used", "tsugute-autorun-test-01"), { recursive: true });
    f.put("job-x", job());
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    expect((await f.run({ generate: gen }))?.code).toBe("REFUSED_APPROVAL_REUSED");
    expect(gen).not.toHaveBeenCalled();
  });

  it("a job id already done/failed: REFUSED_DUPLICATE", async () => {
    const f = setup();
    mkdirSync(join(f.queue, "image-autorun", "failed"), { recursive: true });
    writeFileSync(join(f.queue, "image-autorun", "failed", "job-x.json"), "{}");
    f.put("job-x", job());
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    expect((await f.run({ generate: gen }))?.code).toBe("REFUSED_DUPLICATE");
    expect(gen).not.toHaveBeenCalled();
  });

  it("a failed generation stops everything after it (no retry, also not with a new approval)", async () => {
    const f = setup({ approvals: [
      { approval_id: "tsugute-autorun-test-01", job_id: "job-1", shop: "tsugute", max_images: 6, max_jobs: 1, expires_at: iso(12 * HOUR) },
      { approval_id: "tsugute-autorun-test-02", job_id: "job-2", shop: "tsugute", max_images: 6, max_jobs: 1, expires_at: iso(12 * HOUR) },
    ] });
    f.put("job-1", job());
    const gen = vi.fn<ImageGenerate>(async () => mockBatch({ images: [], stopCode: "CODEX_QUOTA", imageCalls: 0, outcome: "not_applicable" }));
    const first = await f.run({ generate: gen });
    expect(first?.code).toBe("FAILED_GENERATION");
    expect(f.marker("tsugute-autorun-test-01")).toBe(true);
    expect(existsSync(join(f.state, "image-autorun", "STOPPED"))).toBe(true);
    f.put("job-2", job({ approval_id: "tsugute-autorun-test-02" }));
    expect((await f.run({ generate: gen }))?.code).toBe("REFUSED_AFTER_FAILURE");
    expect(gen).toHaveBeenCalledTimes(1);
    expect(f.marker("tsugute-autorun-test-02")).toBe(false);
  });

  it("a job left in processing/ by a cut-off run is FAILED_INTERRUPTED and stops the path", async () => {
    const f = setup();
    mkdirSync(join(f.queue, "image-autorun", "processing"), { recursive: true });
    writeFileSync(join(f.queue, "image-autorun", "processing", "job-old.json"), JSON.stringify(job()));
    f.put("job-new", job({ approval_id: "tsugute-autorun-test-01" }));
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    expect((await f.run({ generate: gen }))?.code).toBe("REFUSED_AFTER_FAILURE");
    expect(f.audit().map((a) => a.code)).toEqual(["FAILED_INTERRUPTED", "REFUSED_AFTER_FAILURE"]);
    expect(gen).not.toHaveBeenCalled();
  });

  it("concurrency 1: while another hook holds the lock, nothing is touched", async () => {
    const f = setup();
    mkdirSync(join(f.state, "image-autorun"), { recursive: true });
    writeFileSync(join(f.state, "image-autorun", "image-autorun.lock"), JSON.stringify({ pid: process.pid, token: "t", at: NOW.toISOString(), bootId: null, startTime: null }));
    f.put("job-x", job());
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    expect((await f.run({ generate: gen }))?.code).toBe("REFUSED_CONCURRENT");
    expect(f.bucket("inbox")).toEqual(["job-x.json"]);
    expect(gen).not.toHaveBeenCalled();
  });

  it("not enough of the worker's run left: the job waits in the inbox, approval untouched", async () => {
    const f = setup();
    f.put("job-x", job());
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    expect((await f.run({ generate: gen, remainingMs: 10 * 60 * 1000 }))?.code).toBe("DEFERRED_TIME_BUDGET");
    expect(f.bucket("inbox")).toEqual(["job-x.json"]);
    expect(gen).not.toHaveBeenCalled();
  });
});

describe("DEV-187 the root grant: without it, 0 generate calls", () => {
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  const refused = async (f: ReturnType<typeof setup>, extra: { grantUid?: number } = {}) => {
    const gen = vi.fn<ImageGenerate>(async () => mockBatch());
    const r = await f.run({ generate: gen, ...extra });
    expect(r?.code).toBe("REFUSED_NO_GRANT");
    expect(gen).not.toHaveBeenCalled();
    expect(real.generate).not.toHaveBeenCalled();
    expect(real.sandbox).not.toHaveBeenCalled();
    expect(f.marker("tsugute-autorun-test-01")).toBe(false);
  };
  it("no grant file", async () => {
    const f = setup();
    f.put("job-x", job(), false);
    await refused(f);
  });
  it("a grant not owned by root (here: not the trusted uid) — e.g. one the worker wrote itself", async () => {
    const f = setup();
    f.put("job-x", job());
    await refused(f, { grantUid: process.getuid!() + 1 });
  });
  it("a grant that is group/other-writable, or in a dir that is not 0755", async () => {
    const f = setup();
    f.put("job-x", job());
    chmodSync(f.grantPath, 0o666);
    await refused(f);
    const g = setup();
    g.put("job-x", job());
    chmodSync(g.grantDir, 0o775);
    await refused(g);
  });
  it("a grant that is a link", async () => {
    const f = setup();
    f.put("job-x", job());
    const real2 = join(f.root, "real-grant.json");
    writeFileSync(real2, readFileSync(f.grantPath));
    rmSync(f.grantPath);
    symlinkSync(real2, f.grantPath);
    await refused(f);
  });
  it("a stale grant (expired), or one spanning more than one run", async () => {
    const f = setup();
    f.put("job-x", job());
    f.grant({ job_id: "job-x", job_sha256: sha(JSON.stringify(job())), issued_at: iso(-2 * HOUR), expires_at: iso(-60_000) });
    await refused(f);
    const g = setup();
    g.put("job-x", job());
    g.grant({ job_id: "job-x", job_sha256: sha(JSON.stringify(job())), issued_at: iso(-60_000), expires_at: iso(25 * 60 * 1000) });
    await refused(g);
  });
  it("a grant from another boot (H1c: a grant never survives a reboot)", async () => {
    const f = setup();
    f.put("job-x", job());
    f.grant({ job_id: "job-x", job_sha256: sha(JSON.stringify(job())), boot_id: "00000000-0000-4000-8000-000000000000" });
    await refused(f);
  });

  it("job bytes changed after the grant (same name, same approval)", async () => {
    const f = setup();
    f.put("job-x", job());
    writeFileSync(join(f.queue, "image-autorun", "inbox", "job-x.json"), JSON.stringify(job({ requested_at: iso(-30_000) })));
    await refused(f);
  });
  it("a grant for another job id or another approval id", async () => {
    const f = setup();
    f.put("job-x", job());
    f.grant({ job_id: "job-y", job_sha256: sha(JSON.stringify(job())) });
    await refused(f);
    const g = setup();
    g.put("job-x", job());
    g.grant({ job_id: "job-x", approval_id: "tsugute-autorun-test-09", job_sha256: sha(JSON.stringify(job())) });
    await refused(g);
  });
});

describe("DEV-186 isolation", () => {
  it("only the one-shot entry and the worker's guarded hook call generateImagesInOneRun; the worker reaches it only via the hook", () => {
    const grep = (re: string, ...paths: string[]) => spawnSync("git", ["grep", "--untracked", "-lE", re, "--", ...paths], { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();
    expect(grep("generateImagesInOneRun", "lib", "app", "components", "scripts")).toEqual(["lib/design-agent/design-image/image-once.ts", "lib/design-agent/design-image/tsugute-photos.ts", "scripts/sales-design-worker/image-autorun.ts", "scripts/sales-design-worker/tsugute-photos.ts"]);
    expect(grep("sales-design-worker/image-autorun|from \"\\./image-autorun\"", "lib", "app", "components", "scripts")).toEqual(["scripts/sales-design-worker/worker.ts"]);
    // the switch path is fixed in code: no environment variable can point it elsewhere, and run.sh passes none
    const hook = readFileSync(join(REPO, "scripts/sales-design-worker/image-autorun.ts"), "utf8");
    expect(hook).not.toMatch(/process\.env/);
    expect(readFileSync(join(REPO, "scripts/sales-design-worker/run.sh"), "utf8")).not.toMatch(/IMAGE_AUTORUN/);
    const worker = readFileSync(join(REPO, "scripts/sales-design-worker/worker.ts"), "utf8");
    expect(worker).not.toMatch(/configPath|trustedUid|grantPath|grantUid|generate:/);
  });
});
