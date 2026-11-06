/**
 * DEV-191 proved 輪's (bicycle) real path OFF. DEV-192 (owner GO 2026-11-07, Issue #193 comment 6689664215) opens it for
 * ONE approved run, so this file now proves the opposite half: 輪 is accepted ONLY with the full approval chain, and any
 * missing link refuses the job with 0 generate calls. Offline: no Codex, no image tool, no network (the real generation
 * and the Codex sandbox are spies); the one full-chain run uses a mock generator, 6 stub PNGs made under os.tmpdir() and
 * the local Chromium for the PC 1440 / tablet 768 / SP 390 renders.
 *
 * The chain: the worker's fixed manifest (shop, page d1-v9, the 6 photo ids, the approved run prompt SHA) → the root
 * switch file with the owner's entry for exactly this job → root's grant for these exact bytes (cycle.sh, after root's
 * atomic use record) → the worker's one-use ledger → one generation → bundle → intake → swap → renders.
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
import { BICYCLE_GENERATOR, BICYCLE_PHOTOS, BICYCLE_PROMPT_FILE, BICYCLE_PROMPT_SHA256, BICYCLE_RUN_APPROVAL_ID, BICYCLE_RUN_PROMPT_APPROVAL, BICYCLE_RUN_PROMPT_CANDIDATE_SHA256, buildBicycleRunPrompt } from "@/lib/design-agent/quality-pipeline/bicycle-ai-photos";

const real = vi.hoisted(() => ({ generate: vi.fn(), sandbox: vi.fn() }));
vi.mock("@/lib/design-agent/design-image/image-once", async (orig) => ({ ...(await orig<object>()), generateImagesInOneRun: real.generate }));
vi.mock("@/lib/design-agent/sandbox", async (orig) => ({ ...(await orig<object>()), prepareCodexSandbox: real.sandbox }));

import { ImageAutorunJobSchema, runImageAutorun, type ImageGenerate } from "../../../scripts/sales-design-worker/image-autorun";
import { AUTORUN_SHOP_IDS, AUTORUN_SHOPS, UNIMPLEMENTED_SHOPS } from "../../../scripts/sales-design-worker/autorun-shops";

const REPO = resolve(__dirname, "../../..");
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const NOW = new Date();
const iso = (deltaMs: number) => new Date(NOW.getTime() + deltaMs).toISOString();
const HOUR = 60 * 60 * 1000;
const BOOT = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const APPROVAL = "bicycle-run-test-01";
const PHOTO_IDS = BICYCLE_PHOTOS.map((p) => p.photo_id);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
beforeEach(() => {
  real.generate.mockReset();
  real.sandbox.mockReset();
});

/** a 輪 job: only allowlisted values (shop, the fixed page, the fixed photo ids, the pinned run prompt SHA, ids, scope, times) */
const bicycleJob = (over: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
  version: 1,
  shop_id: "bicycle",
  page: "d1-v9",
  slot_ids: PHOTO_IDS,
  brief_sha256: BICYCLE_RUN_PROMPT_CANDIDATE_SHA256,
  approval_id: APPROVAL,
  approval_scope: { shop: "bicycle", max_images: 6, max_jobs: 1, expires_at: iso(2 * HOUR), ...scope },
  requested_at: iso(-60_000),
  ...over,
});

type World = { root: string; queue: string; state: string; out: string; marker: (id: string) => boolean; put: (name: string, body: unknown, grant?: boolean) => void; run: (gen: ImageGenerate, launch?: boolean) => ReturnType<typeof runImageAutorun> };

/** the worker's world: the switch file (root's, here the test user's) and, per job, root's grant for its exact bytes */
function world(o: { enabled?: boolean; approvals?: Array<Record<string, unknown>> } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "dev192-"));
  roots.push(root);
  const queue = join(root, "jobs");
  const inbox = join(queue, "image-autorun", "inbox");
  const state = join(root, "state");
  const out = join(root, "out");
  for (const d of [inbox, out, state, join(root, "etc")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const configPath = join(root, "etc", "image-autorun.json");
  const approvals = o.approvals ?? [{ approval_id: APPROVAL, job_id: "job-bicycle", shop: "bicycle", max_images: 6, max_jobs: 1, expires_at: iso(2 * HOUR) }];
  writeFileSync(configPath, JSON.stringify({ version: 1, enabled: o.enabled ?? true, approvals }));
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
  return { root, queue, state, out, marker: (id) => existsSync(join(state, "poc-approval-used", id)), put, run };
}

const never = () =>
  vi.fn<ImageGenerate>(async () => {
    throw new Error("must not be called");
  });

/** 6 stub PNGs at each photo's 2× target (the PC bench at the tool's largest landscape, 1536×1152), in call order */
async function stubBatch(): Promise<ImageBatchResult> {
  const sizes: Record<string, [number, number]> = { "ph-d": [980, 735], "ph-a": [1040, 694], "ph-c": [1040, 694], "ph-b": [980, 735], "ph-bench-pc": [1536, 1152], "ph-bench-sp": [590, 885] };
  const images = [];
  for (const [i, id] of PHOTO_IDS.entries()) {
    const [width, height] = sizes[id]!;
    images.push({ png: await sharp({ create: { width, height, channels: 3, background: { r: 50 + 25 * i, g: 80 + 15 * i, b: 120 - 10 * i } } }).png().toBuffer(), width, height });
  }
  return { images, outcome: "IMAGE_SAVED", stopCode: null, imageCalls: 6, imageFailed: 0, threadId: null, cliVersion: "mock-0.0.0", model: "mock-image-model", codexMs: 1 };
}

describe("DEV-192 the worker's fixed 輪 entry: pinned, no free values", () => {
  it("bicycle is an auto-run shop with page d1-v9, the 6 photo ids, the approved run prompt and max 6 images", () => {
    expect([...AUTORUN_SHOP_IDS].sort()).toEqual(["bicycle", "tsugute"]);
    expect(Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_SHOPS, "bicycle")).toBe(false);
    const b = AUTORUN_SHOPS.bicycle;
    expect([b.page, b.slotIds, b.maxImages, b.bundle]).toEqual(["d1-v9", ["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench-pc", "ph-bench-sp"], 6, "bicycle_ai_photos_v0"]);
    expect(b.photoToSlot).toEqual({ "ph-d": "ph-d", "ph-a": "ph-a", "ph-c": "ph-c", "ph-b": "ph-b", "ph-bench-pc": "ph-bench", "ph-bench-sp": "ph-bench" });
    expect([b.prompt.sha256, b.prompt.chars]).toEqual(["4b8081e02c08e1d0842c27bf28afab2bc647a9c80acce8464c23acf20e6d7447", 4566]);
    expect(sha(b.prompt.build())).toBe(b.prompt.sha256);
    expect(b.promptApproval).toBe(BICYCLE_RUN_PROMPT_APPROVAL);
    expect(b.rights).toEqual({ sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: 2, upscaleMethod: "sharp-lanczos3" });
    // no run approval id in code: the owner chooses the one-use id at run time (root's config)
    expect(BICYCLE_RUN_APPROVAL_ID).toBeNull();
  });
  it("the job schema still takes no free text, path, URL or shell; only the allowlisted shop ids", () => {
    expect(ImageAutorunJobSchema.safeParse(bicycleJob()).success).toBe(true);
    for (const extra of [{ prompt: "anything" }, { path: "/etc/passwd" }, { url: "https://example.com" }, { cmd: "rm -rf /" }]) expect(ImageAutorunJobSchema.safeParse({ ...bicycleJob(), ...extra }).success, Object.keys(extra)[0]).toBe(false);
    expect(ImageAutorunJobSchema.safeParse(bicycleJob({ shop_id: "sento" }, { shop: "sento" })).success).toBe(false);
    expect(ImageAutorunJobSchema.safeParse(bicycleJob({ page: "../d1-v9" })).success).toBe(false);
  });
});

describe("DEV-192 a 輪 job without the full chain: refused, 0 generate calls, 0 sandbox, approval not used", () => {
  const cases: Array<[string, Parameters<typeof world>[0], unknown, boolean, string]> = [
    ["no root switch entry for it", { approvals: [] }, bicycleJob(), true, "REFUSED_NO_APPROVAL"],
    ["a root entry for another job id", { approvals: [{ approval_id: APPROVAL, job_id: "job-other", shop: "bicycle", max_images: 6, max_jobs: 1, expires_at: iso(2 * HOUR) }] }, bicycleJob(), true, "REFUSED_NO_APPROVAL"],
    ["the switch OFF (enabled: false)", { enabled: false }, bicycleJob(), true, "HELD_AUTORUN_DISABLED"],
    ["no root grant", {}, bicycleJob(), false, "REFUSED_NO_GRANT"],
    ["the core text's SHA instead of the approved run prompt's", {}, bicycleJob({ brief_sha256: BICYCLE_PROMPT_SHA256 }), true, "REFUSED_JOB_INVALID"],
    ["another page (d1-v7)", {}, bicycleJob({ page: "d1-v7" }), true, "REFUSED_JOB_INVALID"],
    ["the 5 swap slots instead of the 6 photos", {}, bicycleJob({ slot_ids: ["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench"] }), true, "REFUSED_JOB_INVALID"],
    ["the photos out of order", {}, bicycleJob({ slot_ids: ["ph-a", "ph-d", "ph-c", "ph-b", "ph-bench-pc", "ph-bench-sp"] }), true, "REFUSED_JOB_INVALID"],
    ["7 images", { approvals: [{ approval_id: APPROVAL, job_id: "job-bicycle", shop: "bicycle", max_images: 7, max_jobs: 1, expires_at: iso(2 * HOUR) }] }, bicycleJob({}, { max_images: 7 }), true, "REFUSED_LIMIT_EXCEEDED"],
    ["a window over 24 h", {}, bicycleJob({}, { expires_at: iso(25 * HOUR) }), true, "REFUSED_LIMIT_EXCEEDED"],
    ["the consumed つぐ手 id tsugute-photos-20261106-01", { approvals: [{ approval_id: "tsugute-photos-20261106-01", job_id: "job-bicycle", shop: "bicycle", max_images: 6, max_jobs: 1, expires_at: iso(2 * HOUR) }] }, bicycleJob({ approval_id: "tsugute-photos-20261106-01" }), true, "REFUSED_APPROVAL_REUSED"],
  ];
  for (const [label, w, body, grant, code] of cases) {
    it(`${label}: ${code}`, async () => {
      const f = world(w);
      f.put("job-bicycle", body, grant);
      const gen = never();
      expect((await f.run(gen))?.code).toBe(code);
      expect(gen).toHaveBeenCalledTimes(0);
      expect(real.generate).toHaveBeenCalledTimes(0);
      expect(real.sandbox).toHaveBeenCalledTimes(0);
      expect(f.marker(APPROVAL)).toBe(false);
      expect(readdirSync(f.out)).toEqual([]);
    });
  }

  it("after use: an approval already in the worker's one-use ledger → REFUSED_APPROVAL_REUSED, 0 calls", async () => {
    const f = world();
    mkdirSync(join(f.state, "poc-approval-used", APPROVAL), { recursive: true });
    f.put("job-bicycle", bicycleJob());
    const gen = never();
    expect((await f.run(gen))?.code).toBe("REFUSED_APPROVAL_REUSED");
    expect(gen).toHaveBeenCalledTimes(0);
    expect(real.sandbox).toHaveBeenCalledTimes(0);
  });

  it("the approved bytes changed in the checkout (the run prompt no longer matches its pin) → REFUSED_JOB_INVALID before any reservation", async () => {
    const prompt = AUTORUN_SHOPS.bicycle.prompt as { build: () => string };
    const original = prompt.build;
    const text = readFileSync(join(REPO, BICYCLE_PROMPT_FILE), "utf8");
    prompt.build = () => buildBicycleRunPrompt(text.replace("No hands.", "No hands!"));
    try {
      const f = world();
      f.put("job-bicycle", bicycleJob());
      const gen = never();
      expect((await f.run(gen))?.code).toBe("REFUSED_JOB_INVALID");
      expect(gen).toHaveBeenCalledTimes(0);
      expect(f.marker(APPROVAL)).toBe(false);
    } finally {
      prompt.build = original;
    }
  });
});

describe("DEV-192 the full chain with a mock generator: exactly one run → 6-photo bundle → intake → swap → PC 1440 / tablet 768 / SP 390", () => {
  it("runs once, uses the approval up, and a second job under the same approval is refused", async () => {
    const f = world();
    f.put("job-bicycle", bicycleJob());
    const gen = vi.fn<ImageGenerate>(async () => stubBatch());
    const r = await f.run(gen, true);
    expect(r?.code).toBe("DONE");
    expect(gen).toHaveBeenCalledTimes(1);
    const call = gen.mock.calls[0]![0];
    expect([sha(call.prompt), call.prompt.length, call.maxImages]).toEqual([BICYCLE_RUN_PROMPT_CANDIDATE_SHA256, 4566, 6]);
    expect(call.timeoutMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(real.generate).toHaveBeenCalledTimes(0);
    expect(real.sandbox).toHaveBeenCalledTimes(0);
    expect(f.marker(APPROVAL)).toBe(true);
    const out = r!.out!;
    // the bundle: 6 photos in call order + manifest, this job's approval, the real generator's label, both prompt pins
    const bundle = join(out, "photos", readdirSync(join(out, "photos"))[0]!);
    expect(readdirSync(bundle).sort()).toEqual([...PHOTO_IDS.map((id) => `${id}.png`), "manifest.json"].sort());
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as Record<string, unknown> & { photos: Array<{ photo_id: string }> };
    expect(manifest).toMatchObject({ schema: "bicycle_ai_photos_v0", status: "complete", approval_id: APPROVAL, generator: BICYCLE_GENERATOR, prompt_sha256: BICYCLE_PROMPT_SHA256, run_prompt_sha256: BICYCLE_RUN_PROMPT_CANDIDATE_SHA256, demo_only: true, public_web: false, image_tool_calls: 6 });
    expect(manifest.photos.map((p) => p.photo_id)).toEqual(PHOTO_IDS);
    // the intake: ai_generated_demo, demo only, never public web, with this job's approval id
    const swapManifest = JSON.parse(readFileSync(join(out, "swap-manifest.json"), "utf8")) as { shop: string; slots: Array<{ slot_id: string; pc: { rights: Record<string, unknown> & { allowed_uses: { public_web: boolean }; ai_provenance: Record<string, unknown> } }; sp?: unknown }> };
    expect(swapManifest.shop).toBe("bicycle");
    expect(swapManifest.slots.map((s) => [s.slot_id, Boolean(s.sp)])).toEqual([["ph-d", false], ["ph-a", false], ["ph-c", false], ["ph-b", false], ["ph-bench", true]]);
    for (const s of swapManifest.slots) {
      expect(s.pc.rights.source_kind).toBe("ai_generated_demo");
      expect(s.pc.rights.allowed_uses.public_web).toBe(false);
      expect(s.pc.rights.ai_provenance).toMatchObject({ approval_id: APPROVAL, demo_only: true, prompt_sha256: BICYCLE_PROMPT_SHA256 });
    }
    expect(existsSync(join(out, "swap-manifest.json.provenance.json"))).toBe(true);
    // the renders: PC 1440, tablet 768, SP 390
    expect(r!.renders!.map((p) => p.split("/").pop()).sort()).toEqual(["desktop_1440.png", "mobile_390.png", "tablet_768.png"]);
    for (const p of r!.renders!) expect((await sharp(p).metadata()).width).toBe(p.endsWith("desktop_1440.png") ? 1440 : p.endsWith("tablet_768.png") ? 768 : 390);
    expect(readdirSync(join(f.queue, "image-autorun", "done")).sort()).toEqual(["job-bicycle.json", "job-bicycle.result.json"]);

    // after use: the same approval in a new job → refused, no second generation
    f.put("job-bicycle-2", bicycleJob({ requested_at: iso(-30_000) }));
    expect((await f.run(gen))?.code).toBe("REFUSED_APPROVAL_REUSED");
    expect(gen).toHaveBeenCalledTimes(1);
  }, 240_000);
});

describe("DEV-192 root's cycle.sh: 'tsugute:6 bicycle:6', its own matcher, the consumed つぐ手 id", () => {
  const cycle = readFileSync(join(REPO, "scripts/sales-design-worker/cycle.sh"), "utf8");
  const allow = /^IMAGE_AUTORUN_SHOPS='([^']*)'$/m.exec(cycle)![1]!;
  const py = /\nIMAGE_MATCH_PY='\n([\s\S]*?)\n'\n/.exec(cycle)![1]!;
  const match = (shop: string, mi: number, allowlist = allow) => {
    const dir = mkdtempSync(join(tmpdir(), "dev192-root-"));
    roots.push(dir);
    const conf = join(dir, "image-autorun.json");
    const exp = "2030-01-01T00:00:00Z";
    writeFileSync(conf, JSON.stringify({ version: 1, enabled: true, approvals: [{ approval_id: APPROVAL, job_id: "job-x", shop, max_images: mi, max_jobs: 1, expires_at: exp }] }));
    const now = String(Math.floor(Date.parse(exp) / 1000) - 3600);
    const r = spawnSync("python3", ["-I", "-c", py, conf, "job-x", APPROVAL, shop, String(mi), "1", exp, now, allowlist], { encoding: "utf8" });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  it("the allowlist is exactly 'tsugute:6 bicycle:6', one assignment", () => {
    expect(cycle.split("\n").filter((l) => /^IMAGE_AUTORUN_SHOPS=/.test(l))).toEqual(["IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6'"]);
  });
  it("輪 6 images with a matching entry → MATCH; 7 images or another shop → SCOPE_MISMATCH; つぐ手 still MATCH", () => {
    expect(match("bicycle", 6)).toBe("IMAGE_GRANT_MATCH");
    expect(match("bicycle", 7)).toBe("IMAGE_GRANT_SCOPE_MISMATCH");
    expect(match("sento", 6)).toBe("IMAGE_GRANT_SCOPE_MISMATCH");
    expect(match("tsugute", 6)).toBe("IMAGE_GRANT_MATCH");
  });
  it("the consumed つぐ手 id is refused for any shop, after the matcher (unchanged line)", () => {
    expect(cycle).toContain('[ "$appr" != tsugute-photos-20261106-01 ] || { say "image grant: IMAGE_GRANT_APPROVAL_USED (job $job)"; return 0; }');
  });
});

describe("DEV-192 the real generation is still reached only through the guarded hook", () => {
  const grep = (re: string, ...paths: string[]) => spawnSync("git", ["grep", "--untracked", "-lE", re, "--", ...paths], { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();
  it("only the つぐ手 one-shot entry and the worker hook call it; no 輪 run entry or CLI exists", () => {
    expect(grep("generateImagesInOneRun", "lib", "app", "components", "scripts")).toEqual(["lib/design-agent/design-image/image-once.ts", "lib/design-agent/design-image/tsugute-photos.ts", "scripts/sales-design-worker/image-autorun.ts", "scripts/sales-design-worker/tsugute-photos.ts"]);
    expect(readFileSync(join(REPO, "lib/design-agent/design-image/bicycle-photos.ts"), "utf8")).toMatch(/^import type \{ ImageBatchResult \} from "\.\/image-once";$/m);
    expect(readdirSync(join(REPO, "scripts/sales-design-worker")).filter((f) => /bicycle/i.test(f))).toEqual([]);
    expect(readFileSync(join(REPO, "scripts/design-artifact/bicycle-ai-intake.ts"), "utf8")).not.toMatch(/require\.main|process\.argv/);
  });
});
