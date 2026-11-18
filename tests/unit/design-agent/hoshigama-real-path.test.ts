/**
 * DEV-139 (owner approval 2026-11-18, Issue #139 comment 6970468763 follow-up): ほし窯's (bakery, a FICTIONAL bakery) real
 * path is open for ONE approved run, on the same terms as 輪's (bicycle-real-path-off.test.ts). This file proves that the
 * worker accepts a ほし窯 job ONLY with the full approval chain, and that any missing link refuses it with 0 generate
 * calls. Offline: no Codex, no image tool, no network (the real generation and the Codex sandbox are spies); the one
 * full-chain run uses a mock generator, 3 stub PNGs made under os.tmpdir() and the local Chromium for the PC 1440 /
 * SP 390 renders.
 *
 * The chain: the worker's fixed manifest (shop, page d2-v2, the 3 photo ids, the approved run prompt SHA) → the root
 * switch file with the owner's entry for exactly this job → root's grant for these exact bytes (cycle.sh, after root's
 * atomic use record) → the worker's one-use ledger → one generation → bundle → intake (≤2× for the 2 listed photos) →
 * swap → renders. Root's allowlist ('bakery:3') and its matcher are checked at the end.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDeadline } from "@/lib/design-agent/bounded-process";
import type { ImageBatchResult } from "@/lib/design-agent/design-image/image-once";
import { HOSHIGAMA_APPROVAL, HOSHIGAMA_GENERATOR, HOSHIGAMA_PHOTOS, HOSHIGAMA_PROMPT_DRAFT_SHA256, HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256 } from "@/lib/design-agent/quality-pipeline/hoshigama-ai-photos";

const real = vi.hoisted(() => ({ generate: vi.fn(), sandbox: vi.fn() }));
vi.mock("@/lib/design-agent/design-image/image-once", async (orig) => ({ ...(await orig<object>()), generateImagesInOneRun: real.generate }));
vi.mock("@/lib/design-agent/sandbox", async (orig) => ({ ...(await orig<object>()), prepareCodexSandbox: real.sandbox }));

import { ImageAutorunJobSchema, runImageAutorun, type ImageGenerate } from "../../../scripts/sales-design-worker/image-autorun";
import { AUTORUN_SHOPS } from "../../../scripts/sales-design-worker/autorun-shops";

const REPO = resolve(__dirname, "../../..");
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const NOW = new Date();
const iso = (deltaMs: number) => new Date(NOW.getTime() + deltaMs).toISOString();
const HOUR = 60 * 60 * 1000;
const BOOT = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const APPROVAL = "s0-hoshigama-photos-test-01";
const PHOTO_IDS = HOSHIGAMA_PHOTOS.map((p) => p.photo_id);
const RUN_SHA = "a7b7d524470a6e271503ca1820db0f0693cecd28e9c51bf4b19b3543f62be7f1";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
beforeEach(() => {
  real.generate.mockReset();
  real.sandbox.mockReset();
});

/** a ほし窯 job: only allowlisted values (shop, the fixed page, the fixed photo ids, the pinned run prompt SHA, ids, scope, times) */
const bakeryJob = (over: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
  version: 1,
  shop_id: "bakery",
  page: "d2-v2",
  slot_ids: PHOTO_IDS,
  brief_sha256: RUN_SHA,
  approval_id: APPROVAL,
  approval_scope: { shop: "bakery", max_images: 3, max_jobs: 1, expires_at: iso(2 * HOUR), ...scope },
  requested_at: iso(-60_000),
  ...over,
});
const entry = (over: Record<string, unknown> = {}) => ({ approval_id: APPROVAL, job_id: "job-bakery", shop: "bakery", max_images: 3, max_jobs: 1, expires_at: iso(2 * HOUR), ...over });

type World = { queue: string; state: string; out: string; marker: (id: string) => boolean; put: (name: string, body: unknown, grant?: boolean) => void; run: (gen: ImageGenerate, launch?: boolean) => ReturnType<typeof runImageAutorun> };

/** the worker's world: the switch file (root's, here the test user's) and, per job, root's grant for its exact bytes */
function world(o: { enabled?: boolean; approvals?: Array<Record<string, unknown>> } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "dev139-run-"));
  roots.push(root);
  const queue = join(root, "jobs");
  const inbox = join(queue, "image-autorun", "inbox");
  const state = join(root, "state");
  const out = join(root, "out");
  for (const d of [inbox, out, state, join(root, "etc")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const configPath = join(root, "etc", "image-autorun.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, enabled: o.enabled ?? true, approvals: o.approvals ?? [entry()] }));
  chmodSync(configPath, 0o644);
  const grantDir = join(root, "grant");
  mkdirSync(grantDir, { mode: 0o755 });
  chmodSync(grantDir, 0o755);
  const grantPath = join(grantDir, "grant.json");
  const put = (name: string, body: unknown, grant = true) => {
    const text = JSON.stringify(body);
    writeFileSync(join(inbox, `${name}.json`), text);
    rmSync(grantPath, { force: true });
    const appr = (body as { approval_id?: string }).approval_id ?? APPROVAL;
    if (grant) {
      writeFileSync(grantPath, JSON.stringify({ version: 1, approval_id: appr, job_id: name, job_sha256: sha(text), boot_id: BOOT, issued_at: iso(-60_000), expires_at: iso(15 * 60 * 1000) }));
      chmodSync(grantPath, 0o644);
    }
  };
  const run = (generate: ImageGenerate, launch = false) =>
    runImageAutorun({
      queueRoot: queue,
      outRoot: out,
      stateDir: state,
      workerCommit: "c543dd30bc38a02d4f39b3da24c31f9b80442d0e",
      deadline: new RunDeadline(Date.now() + 55 * 60 * 1000),
      env: { ...process.env, HOME: root },
      launchBrowser: launch ? () => chromium.launch({ headless: true, ...(CHROME ? { executablePath: CHROME } : {}) }) : () => Promise.reject(new Error("no browser")),
      log: () => undefined,
      configPath,
      trustedUid: process.getuid!(),
      grantPath,
      generate,
    });
  return { queue, state, out, marker: (id) => existsSync(join(state, "poc-approval-used", id)), put, run };
}

const never = () =>
  vi.fn<ImageGenerate>(async () => {
    throw new Error("must not be called");
  });

/** 3 stub PNGs at the tool's largest sizes in each shape (the loaf needs its listed ≤2× enlargement), in call order */
async function stubBatch(): Promise<ImageBatchResult> {
  const sizes: Array<[number, number]> = [[1536, 1536], [1024, 1536], [1536, 1024]];
  const images = [];
  for (const [i, [width, height]] of sizes.entries()) images.push({ png: await sharp({ create: { width, height, channels: 3, background: { r: 150 + 30 * i, g: 80 + 10 * i, b: 40 } } }).png().toBuffer(), width, height });
  return { images, outcome: "IMAGE_SAVED", stopCode: null, imageCalls: 3, imageFailed: 0, threadId: null, cliVersion: "mock-0.0.0", model: "mock-image-model", codexMs: 1 };
}

describe("DEV-139 the worker's fixed ほし窯 entry: pinned, no free values", () => {
  it("bakery is an auto-run shop with page d2-v2, the 3 photo ids, the approved run prompt and max 3 images", () => {
    const b = AUTORUN_SHOPS.bakery;
    expect([b.page, b.slotIds, b.maxImages, b.bundle]).toEqual(["d2-v2", ["ph-mouth-pc", "ph-mouth-sp", "ph-loaf"], 3, "hoshigama_ai_photos_v0"]);
    expect([b.prompt.sha256, b.prompt.chars]).toEqual([RUN_SHA, 2668]);
    expect([sha(b.prompt.build()), b.prompt.build().length]).toEqual([RUN_SHA, 2668]);
    expect(b.promptApproval).toBe(HOSHIGAMA_APPROVAL);
    expect(b.rights).toEqual({ sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: 2, upscaleMethod: "sharp-lanczos3" });
  });
  it("the job schema still takes no free text, path, URL or shell", () => {
    expect(ImageAutorunJobSchema.safeParse(bakeryJob()).success).toBe(true);
    for (const extra of [{ prompt: "anything" }, { path: "/etc/passwd" }, { url: "https://example.com" }, { cmd: "rm -rf /" }]) expect(ImageAutorunJobSchema.safeParse({ ...bakeryJob(), ...extra }).success, Object.keys(extra)[0]).toBe(false);
    expect(ImageAutorunJobSchema.safeParse(bakeryJob({ page: "../d2-v2" })).success).toBe(false);
  });
});

describe("DEV-139 a ほし窯 job without the full chain: refused, 0 generate calls, 0 sandbox, approval not used", () => {
  const cases: Array<[string, Parameters<typeof world>[0], unknown, boolean, string]> = [
    ["no root switch entry for it", { approvals: [] }, bakeryJob(), true, "REFUSED_NO_APPROVAL"],
    ["a root entry for another job id", { approvals: [entry({ job_id: "job-other" })] }, bakeryJob(), true, "REFUSED_NO_APPROVAL"],
    ["the switch OFF (enabled: false)", { enabled: false }, bakeryJob(), true, "HELD_AUTORUN_DISABLED"],
    ["no root grant", {}, bakeryJob(), false, "REFUSED_NO_GRANT"],
    ["the core text's SHA instead of the approved run prompt's", {}, bakeryJob({ brief_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256 }), true, "REFUSED_JOB_INVALID"],
    ["another page (d2-v1)", {}, bakeryJob({ page: "d2-v1" }), true, "REFUSED_JOB_INVALID"],
    ["the 2 swap slots instead of the 3 photos", {}, bakeryJob({ slot_ids: ["ph-mouth", "ph-loaf"] }), true, "REFUSED_JOB_INVALID"],
    ["the photos out of order", {}, bakeryJob({ slot_ids: ["ph-mouth-sp", "ph-mouth-pc", "ph-loaf"] }), true, "REFUSED_JOB_INVALID"],
    ["4 images", { approvals: [entry({ max_images: 4 })] }, bakeryJob({}, { max_images: 4 }), true, "REFUSED_LIMIT_EXCEEDED"],
    ["a window over 24 h", {}, bakeryJob({}, { expires_at: iso(25 * HOUR) }), true, "REFUSED_LIMIT_EXCEEDED"],
    ["the consumed つぐ手 id tsugute-photos-20261106-01", { approvals: [entry({ approval_id: "tsugute-photos-20261106-01" })] }, bakeryJob({ approval_id: "tsugute-photos-20261106-01" }), true, "REFUSED_APPROVAL_REUSED"],
  ];
  for (const [label, w, body, grant, code] of cases) {
    it(`${label}: ${code}`, async () => {
      const f = world(w);
      f.put("job-bakery", body, grant);
      const gen = never();
      expect((await f.run(gen))?.code).toBe(code);
      expect(gen).toHaveBeenCalledTimes(0);
      expect(real.generate).toHaveBeenCalledTimes(0);
      expect(real.sandbox).toHaveBeenCalledTimes(0);
      expect(f.marker(APPROVAL)).toBe(false);
      expect(readdirSync(f.out)).toEqual([]);
    });
  }

  it("the approved bytes changed in the checkout (the run prompt no longer matches its pin) → REFUSED_JOB_INVALID before any reservation", async () => {
    const prompt = AUTORUN_SHOPS.bakery.prompt as { build: () => string };
    const original = prompt.build;
    prompt.build = () => `${original()} `;
    try {
      const f = world();
      f.put("job-bakery", bakeryJob());
      const gen = never();
      expect((await f.run(gen))?.code).toBe("REFUSED_JOB_INVALID");
      expect(gen).toHaveBeenCalledTimes(0);
      expect(f.marker(APPROVAL)).toBe(false);
    } finally {
      prompt.build = original;
    }
  });
});

describe("DEV-139 the full chain with a mock generator: exactly one run → 3-photo bundle → intake → swap → PC 1440 / SP 390", () => {
  it("runs once, uses the approval up, and a second job under the same approval is refused", async () => {
    const f = world();
    f.put("job-bakery", bakeryJob());
    const gen = vi.fn<ImageGenerate>(async () => stubBatch());
    const r = await f.run(gen, true);
    expect(r?.code).toBe("DONE");
    expect(gen).toHaveBeenCalledTimes(1);
    const call = gen.mock.calls[0]![0];
    expect([sha(call.prompt), call.prompt.length, call.maxImages]).toEqual([RUN_SHA, 2668, 3]);
    expect(call.timeoutMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(real.generate).toHaveBeenCalledTimes(0);
    expect(real.sandbox).toHaveBeenCalledTimes(0);
    expect(f.marker(APPROVAL)).toBe(true);
    const out = r!.out!;
    // the bundle: 3 photos in call order + manifest, this job's approval, the real generator's label, both prompt pins
    const bundle = join(out, "photos", readdirSync(join(out, "photos"))[0]!);
    expect(readdirSync(bundle).sort()).toEqual([...PHOTO_IDS.map((id) => `${id}.png`), "manifest.json"].sort());
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as Record<string, unknown> & { photos: Array<{ photo_id: string }> };
    expect(manifest).toMatchObject({ schema: "hoshigama_ai_photos_v0", status: "complete", approval_id: APPROVAL, generator: HOSHIGAMA_GENERATOR, prompt_approval_record: "hoshigama-one-time-run-20261118", prompt_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256, run_prompt_sha256: HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256, demo_only: true, public_web: false, image_tool_calls: 3 });
    expect(manifest.photos.map((p) => p.photo_id)).toEqual(PHOTO_IDS);
    // the intake: ai_generated_demo, demo only, never public web, with this job's approval id
    const swapManifest = JSON.parse(readFileSync(join(out, "swap-manifest.json"), "utf8")) as { shop: string; slots: Array<{ slot_id: string; pc: { rights: Record<string, unknown> & { allowed_uses: { public_web: boolean }; ai_provenance: Record<string, unknown> } }; sp?: unknown }> };
    expect(swapManifest.shop).toBe("bakery");
    expect(swapManifest.slots.map((s) => [s.slot_id, Boolean(s.sp)])).toEqual([["ph-mouth", true], ["ph-loaf", false]]);
    for (const s of swapManifest.slots) {
      expect(s.pc.rights.source_kind).toBe("ai_generated_demo");
      expect(s.pc.rights.allowed_uses.public_web).toBe(false);
      expect(s.pc.rights.ai_provenance).toMatchObject({ approval_id: APPROVAL, demo_only: true, prompt_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256 });
    }
    expect(existsSync(join(out, "swap-manifest.json.provenance.json"))).toBe(true);
    // the renders: PC 1440 and SP 390 (ほし窯's swap renders these two)
    expect(r!.renders!.map((p) => p.split("/").pop()).sort()).toEqual(["desktop_1440.png", "mobile_390.png"]);
    for (const p of r!.renders!) expect((await sharp(p).metadata()).width).toBe(p.endsWith("desktop_1440.png") ? 1440 : 390);
    expect(readdirSync(join(f.queue, "image-autorun", "done")).sort()).toEqual(["job-bakery.json", "job-bakery.result.json"]);

    // after use: the same approval in a new job → refused, no second generation
    f.put("job-bakery-2", bakeryJob({ requested_at: iso(-30_000) }));
    expect((await f.run(gen))?.code).toBe("REFUSED_APPROVAL_REUSED");
    expect(gen).toHaveBeenCalledTimes(1);
  }, 240_000);
});

describe("DEV-139 root's cycle.sh: 'bakery:3' in the allowlist, its own matcher", () => {
  const cycle = readFileSync(join(REPO, "scripts/sales-design-worker/cycle.sh"), "utf8");
  const allow = /^IMAGE_AUTORUN_SHOPS='([^']*)'$/m.exec(cycle)![1]!;
  const py = /\nIMAGE_MATCH_PY='\n([\s\S]*?)\n'\n/.exec(cycle)![1]!;
  const match = (shop: string, mi: number) => {
    const dir = mkdtempSync(join(tmpdir(), "dev139-root-"));
    roots.push(dir);
    const conf = join(dir, "image-autorun.json");
    const exp = "2030-01-01T00:00:00Z";
    writeFileSync(conf, JSON.stringify({ version: 1, enabled: true, approvals: [{ approval_id: APPROVAL, job_id: "job-x", shop, max_images: mi, max_jobs: 1, expires_at: exp }] }));
    const now = String(Math.floor(Date.parse(exp) / 1000) - 3600);
    const r = spawnSync("python3", ["-I", "-c", py, conf, "job-x", APPROVAL, shop, String(mi), "1", exp, now, allow], { encoding: "utf8" });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  it("ほし窯 3 images with a matching entry → MATCH; 4 images → SCOPE_MISMATCH; the others unchanged", () => {
    expect(allow).toBe("tsugute:6 bicycle:6 bakery:3");
    expect(match("bakery", 3)).toBe("IMAGE_GRANT_MATCH");
    expect(match("bakery", 4)).toBe("IMAGE_GRANT_SCOPE_MISMATCH");
    expect(match("bicycle", 6)).toBe("IMAGE_GRANT_MATCH");
    expect(match("tsugute", 6)).toBe("IMAGE_GRANT_MATCH");
    expect(match("sento", 3)).toBe("IMAGE_GRANT_SCOPE_MISMATCH");
  });
  it("the grant stays 20 minutes (the timer is not installed on WSL; the run sheet checks it is not-found)", () => {
    expect(cycle).toMatch(/^GRANT_TTL=1200$/m);
  });
  it("the run sheet pins exactly this cycle.sh (the file SHA-256 its (b) checks after the root clone update)", () => {
    const sheet = readFileSync(join(REPO, "docs/operations/hoshigama-one-time-run-sheet.md"), "utf8");
    expect(sheet).toContain(`= ${sha(cycle)} ] || { echo STOP_CYCLE_SHA; exit 1; }`);
  });
});
