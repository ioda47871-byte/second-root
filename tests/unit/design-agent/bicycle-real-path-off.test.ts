/**
 * DEV-191: evidence that 輪's (bicycle) REAL generation path is OFF, after the prompt text was approved and the bundle
 * writer and intake were prepared. Offline: no Codex, no image tool, no network, no browser.
 *  - the worker refuses a 輪 image job (not in AUTORUN_SHOPS; an OFF candidate only) even with the switch ON, an owner
 *    entry and a root grant for its exact bytes — and the real generation and the Codex sandbox are called 0 times;
 *  - root's cycle.sh keeps IMAGE_AUTORUN_SHOPS='tsugute:6' and its own matcher refuses 輪 (no grant);
 *  - nothing outside the guarded hook and the one-shot つぐ手 entry can reach the real generation; no 輪 entry, CLI or
 *    swap flag exists that could.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDeadline } from "@/lib/design-agent/bounded-process";
import { BICYCLE_PHOTOS, BICYCLE_PROMPT_SHA256, BICYCLE_RUN_APPROVAL_ID, BICYCLE_RUN_PROMPT_CANDIDATE_SHA256 } from "@/lib/design-agent/quality-pipeline/bicycle-ai-photos";

const real = vi.hoisted(() => ({ generate: vi.fn(), sandbox: vi.fn() }));
vi.mock("@/lib/design-agent/design-image/image-once", async (orig) => ({ ...(await orig<object>()), generateImagesInOneRun: real.generate }));
vi.mock("@/lib/design-agent/sandbox", async (orig) => ({ ...(await orig<object>()), prepareCodexSandbox: real.sandbox }));

import { ImageAutorunJobSchema, runImageAutorun, type ImageGenerate } from "../../../scripts/sales-design-worker/image-autorun";
import { AUTORUN_CANDIDATES, AUTORUN_SHOP_IDS, AUTORUN_SHOPS, UNIMPLEMENTED_SHOPS } from "../../../scripts/sales-design-worker/autorun-shops";

const REPO = resolve(__dirname, "../../..");
const NOW = new Date();
const iso = (deltaMs: number) => new Date(NOW.getTime() + deltaMs).toISOString();
const HOUR = 60 * 60 * 1000;
const BOOT = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const APPROVAL = "bicycle-autorun-test-01";
const PHOTO_IDS = BICYCLE_PHOTOS.map((p) => p.photo_id);
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
beforeEach(() => {
  real.generate.mockReset();
  real.sandbox.mockReset();
});

/** a 輪 job as a future run would have to look (d1-v9, the 6 photos, the approved prompt), every value allowlist-shaped */
const bicycleJob = (over: Record<string, unknown> = {}) => ({
  version: 1,
  shop_id: "bicycle",
  page: "d1-v9",
  slot_ids: PHOTO_IDS,
  brief_sha256: BICYCLE_PROMPT_SHA256,
  approval_id: APPROVAL,
  approval_scope: { shop: "bicycle", max_images: 6, max_jobs: 1, expires_at: iso(12 * HOUR) },
  requested_at: iso(-60_000),
  ...over,
});

/** the worker's world with the switch ON, an owner entry for exactly this 輪 job, and root's grant for its exact bytes */
function onWorld(body: unknown) {
  const root = mkdtempSync(join(tmpdir(), "dev191-off-"));
  roots.push(root);
  const queue = join(root, "jobs");
  const inbox = join(queue, "image-autorun", "inbox");
  for (const d of [inbox, join(root, "out"), join(root, "state"), join(root, "etc")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const configPath = join(root, "etc", "image-autorun.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, enabled: true, approvals: [{ approval_id: APPROVAL, job_id: "job-bicycle", shop: "bicycle", max_images: 6, max_jobs: 1, expires_at: iso(12 * HOUR) }] }));
  chmodSync(configPath, 0o644);
  const grantDir = join(root, "grant");
  mkdirSync(grantDir, { mode: 0o755 });
  chmodSync(grantDir, 0o755);
  const text = JSON.stringify(body);
  writeFileSync(join(inbox, "job-bicycle.json"), text);
  const grantPath = join(grantDir, "grant.json");
  writeFileSync(grantPath, JSON.stringify({ version: 1, approval_id: APPROVAL, job_id: "job-bicycle", job_sha256: createHash("sha256").update(text).digest("hex"), boot_id: BOOT, issued_at: iso(-60_000), expires_at: iso(15 * 60 * 1000) }));
  chmodSync(grantPath, 0o644);
  const generate = vi.fn<ImageGenerate>(async () => {
    throw new Error("must not be called");
  });
  const run = () =>
    runImageAutorun({
      queueRoot: queue,
      outRoot: join(root, "out"),
      stateDir: join(root, "state"),
      workerCommit: "38e396eedf2de3f7472fd29052036b8ca0f7541e",
      deadline: new RunDeadline(Date.now() + 55 * 60 * 1000),
      env: { ...process.env, HOME: root },
      launchBrowser: () => Promise.reject(new Error("no browser")),
      log: () => undefined,
      configPath,
      trustedUid: process.getuid!(),
      grantPath,
      generate,
    });
  return { root, queue, generate, run };
}

describe("DEV-191 the worker refuses a 輪 image job: REFUSED_JOB_INVALID, 0 generate calls, 0 sandbox", () => {
  it("輪 is an OFF candidate, never an auto-run shop", () => {
    expect(AUTORUN_SHOP_IDS).toEqual(["tsugute"]);
    expect(Object.prototype.hasOwnProperty.call(AUTORUN_SHOPS, "bicycle")).toBe(false);
    const c = AUTORUN_CANDIDATES.bicycle;
    expect(c.runnable).toBe(false);
    expect(c.runApprovalId).toBeNull();
    expect(BICYCLE_RUN_APPROVAL_ID).toBeNull();
    expect([c.page, c.slotIds, c.photoIds, c.maxImages, c.bundle]).toEqual(["d1-v9", ["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench"], PHOTO_IDS, 6, "bicycle_ai_photos_v0"]);
    expect(c.prompt).toMatchObject({ sha256: BICYCLE_PROMPT_SHA256, bytes: 3865, runCandidateSha256: BICYCLE_RUN_PROMPT_CANDIDATE_SHA256 });
    expect(c.rights).toEqual({ sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: 2, upscaleMethod: "sharp-lanczos3" });
    expect(c.enableRequires).toHaveLength(3);
    expect(UNIMPLEMENTED_SHOPS.bicycle).toContain("未承認");
    // the candidate's files exist (the page, its d1-v9 inventory and edges, the prompt and brief)
    for (const f of [`${c.pageDir}/index.html`, c.slotInventory, c.slotEdges, c.prompt.file, c.prompt.brief, c.prompt.source]) expect(existsSync(join(REPO, f)), f).toBe(true);
  });

  it("the job schema itself refuses shop_id bicycle (whatever the page, slots or brief)", () => {
    for (const j of [bicycleJob(), bicycleJob({ brief_sha256: BICYCLE_RUN_PROMPT_CANDIDATE_SHA256 }), bicycleJob({ slot_ids: ["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench"] })]) expect(ImageAutorunJobSchema.safeParse(j).success).toBe(false);
    // control: the same shape for つぐ手 parses (the shop id is what is refused)
    expect(ImageAutorunJobSchema.safeParse(bicycleJob({ shop_id: "tsugute", approval_scope: { shop: "tsugute", max_images: 6, max_jobs: 1, expires_at: iso(12 * HOUR) } })).success).toBe(true);
  });

  for (const [label, body] of [
    ["the approved prompt's SHA", bicycleJob()],
    ["the run prompt candidate's SHA", bicycleJob({ brief_sha256: BICYCLE_RUN_PROMPT_CANDIDATE_SHA256 })],
    ["the 5 swap slots", bicycleJob({ slot_ids: ["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench"] })],
  ] as const) {
    it(`switch ON + owner entry + root grant, ${label}: refused before anything can start Codex`, async () => {
      const w = onWorld(body);
      const r = await w.run();
      expect(r?.code).toBe("REFUSED_JOB_INVALID");
      expect(w.generate).toHaveBeenCalledTimes(0);
      expect(real.generate).toHaveBeenCalledTimes(0);
      expect(real.sandbox).toHaveBeenCalledTimes(0);
      expect(existsSync(join(w.root, "state", "poc-approval-used", APPROVAL))).toBe(false);
      expect(readdirSync(join(w.queue, "image-autorun", "failed")).sort()).toEqual(["job-bicycle.json", "job-bicycle.result.json"]);
      expect(readdirSync(join(w.root, "out"))).toEqual([]);
    });
  }
});

describe("DEV-191 root's cycle.sh refuses 輪 (IMAGE_AUTORUN_SHOPS unchanged)", () => {
  const cycle = readFileSync(join(REPO, "scripts/sales-design-worker/cycle.sh"), "utf8");
  const allow = /^IMAGE_AUTORUN_SHOPS='([^']*)'$/m.exec(cycle)![1]!;
  const py = /\nIMAGE_MATCH_PY='\n([\s\S]*?)\n'\n/.exec(cycle)![1]!;
  const match = (shop: string, mi: number, allowlist = allow) => {
    const dir = mkdtempSync(join(tmpdir(), "dev191-root-"));
    roots.push(dir);
    const conf = join(dir, "image-autorun.json");
    const exp = "2030-01-01T00:00:00Z";
    writeFileSync(conf, JSON.stringify({ version: 1, enabled: true, approvals: [{ approval_id: APPROVAL, job_id: "job-x", shop, max_images: mi, max_jobs: 1, expires_at: exp }] }));
    const now = String(Math.floor(Date.parse(exp) / 1000) - 3600);
    const r = spawnSync("python3", ["-I", "-c", py, conf, "job-x", APPROVAL, shop, String(mi), "1", exp, now, allowlist], { encoding: "utf8" });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  it("the allowlist is still exactly tsugute:6, one assignment", () => {
    expect(cycle.split("\n").filter((l) => /^IMAGE_AUTORUN_SHOPS=/.test(l))).toEqual(["IMAGE_AUTORUN_SHOPS='tsugute:6'"]);
    expect(cycle).not.toMatch(/bicycle/);
  });
  it("root's own matcher: 輪 with 6 images and a matching owner entry → IMAGE_GRANT_SCOPE_MISMATCH (no grant); つぐ手 → MATCH", () => {
    expect(match("bicycle", 6)).toBe("IMAGE_GRANT_SCOPE_MISMATCH");
    expect(match("bicycle", 5)).toBe("IMAGE_GRANT_SCOPE_MISMATCH");
    expect(match("tsugute", 6)).toBe("IMAGE_GRANT_MATCH");
    // the allowlist is the gate: only root's own clone adding bicycle:6 would change the answer (not done here)
    expect(match("bicycle", 6, "tsugute:6 bicycle:6")).toBe("IMAGE_GRANT_MATCH");
  });
});

describe("DEV-191 no path to the real generation for 輪", () => {
  const grep = (re: string, ...paths: string[]) => spawnSync("git", ["grep", "--untracked", "-lE", re, "--", ...paths], { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();
  it("the real generation is reached only from the one-shot つぐ手 entry and the worker's guarded hook (no 輪 file among them)", () => {
    expect(grep("generateImagesInOneRun", "lib", "app", "components", "scripts")).toEqual(["lib/design-agent/design-image/image-once.ts", "lib/design-agent/design-image/tsugute-photos.ts", "scripts/sales-design-worker/image-autorun.ts", "scripts/sales-design-worker/tsugute-photos.ts"]);
    // the 輪 writer only takes a batch's TYPE from image-once
    expect(readFileSync(join(REPO, "lib/design-agent/design-image/bicycle-photos.ts"), "utf8")).toMatch(/^import type \{ ImageBatchResult \} from "\.\/image-once";$/m);
  });
  it("the worker's hook has no 輪 bundle writer and never passes the swap's test-only candidate flag", () => {
    const hook = readFileSync(join(REPO, "scripts/sales-design-worker/image-autorun.ts"), "utf8");
    expect(hook).toContain("const BUNDLE_WRITERS = { tsugute_ai_photos_v0: writeTsugutePhotos } as const;");
    expect(hook).not.toMatch(/bicycle|offlineAiDemoCandidate/i);
    expect(grep("offlineAiDemoCandidate", "lib", "app", "components", "scripts")).toEqual(["lib/design-agent/quality-pipeline/bicycle-ai-photos.ts", "lib/design-agent/quality-pipeline/photo-swap-shops.ts", "scripts/design-artifact/photo-swap.ts"]);
    // photo-swap.ts's CLI never sets it (only the option's definition and the one use in swapPage)
    const swap = readFileSync(join(REPO, "scripts/design-artifact/photo-swap.ts"), "utf8");
    expect(swap.match(/offlineAiDemoCandidate/g)).toHaveLength(2);
  });
  it("no 輪 run entry exists, and the 輪 intake has no command-line entry", () => {
    expect(readdirSync(join(REPO, "scripts/sales-design-worker")).filter((f) => /bicycle/i.test(f))).toEqual([]);
    expect(readFileSync(join(REPO, "scripts/design-artifact/bicycle-ai-intake.ts"), "utf8")).not.toMatch(/require\.main|process\.argv/);
  });
});
