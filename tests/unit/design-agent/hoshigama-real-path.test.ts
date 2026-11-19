/**
 * Issue #290 P0 (after the run verified in Issue #139 comment 6990007019): ほし窯's (bakery, a FICTIONAL bakery) real path
 * is CLOSED. DEV-139 (owner approval 2026-11-18) opened it for ONE approved run; that run is used (3 image calls, DONE,
 * the root switch OFF). This file used to prove the open chain; it now proves that NO chain reaches a generation any
 * more — not with the owner's switch entry for exactly the job, not with root's grant for its exact bytes, not under a
 * NEW approval id or job id: the worker refuses the job (REFUSED_JOB_INVALID) with 0 generate calls and 0 Codex sandbox,
 * and root's own matcher refuses ほし窯 before any grant (IMAGE_GRANT_SCOPE_MISMATCH). Offline: no Codex, no image tool,
 * no network (the real generation and the Codex sandbox are spies; the test's generator would succeed if called).
 *
 * Kept (tested in photo-swap-hoshigama.test.ts and hoshigama-photo-pipeline.test.ts): the offline intake, swap and v2
 * package of the photos already made, verified against HOSHIGAMA_APPROVAL and both prompt pins.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDeadline } from "@/lib/design-agent/bounded-process";
import type { ImageBatchResult } from "@/lib/design-agent/design-image/image-once";
import { buildHoshigamaRunPrompt, HOSHIGAMA_APPROVAL, HOSHIGAMA_PHOTOS } from "@/lib/design-agent/quality-pipeline/hoshigama-ai-photos";

const real = vi.hoisted(() => ({ generate: vi.fn(), sandbox: vi.fn() }));
vi.mock("@/lib/design-agent/design-image/image-once", async (orig) => ({ ...(await orig<object>()), generateImagesInOneRun: real.generate }));
vi.mock("@/lib/design-agent/sandbox", async (orig) => ({ ...(await orig<object>()), prepareCodexSandbox: real.sandbox }));

import { ImageAutorunJobSchema, runImageAutorun, type ImageGenerate } from "../../../scripts/sales-design-worker/image-autorun";
import { AUTORUN_SHOP_IDS, AUTORUN_SHOPS, CLOSED_SHOPS } from "../../../scripts/sales-design-worker/autorun-shops";

const REPO = resolve(__dirname, "../../..");
const NOW = new Date();
const iso = (deltaMs: number) => new Date(NOW.getTime() + deltaMs).toISOString();
const HOUR = 60 * 60 * 1000;
const BOOT = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
/** a NEW approval id (never used anywhere): even a fresh id must not reach a generation */
const APPROVAL = "s0-hoshigama-photos-20261119-02";
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

type World = { queue: string; state: string; out: string; marker: (id: string) => boolean; put: (name: string, body: unknown, grant?: boolean) => void; run: (gen: ImageGenerate) => ReturnType<typeof runImageAutorun> };

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
  const run = (generate: ImageGenerate) =>
    runImageAutorun({
      queueRoot: queue,
      outRoot: out,
      stateDir: state,
      workerCommit: "c543dd30bc38a02d4f39b3da24c31f9b80442d0e",
      deadline: new RunDeadline(Date.now() + 55 * 60 * 1000),
      env: { ...process.env, HOME: root },
      launchBrowser: () => Promise.reject(new Error("no browser")),
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
/** a generator that WOULD succeed (3 tiny images): the closed route must still never call it */
const wouldSucceed = () =>
  vi.fn<ImageGenerate>(async (): Promise<ImageBatchResult> => ({ images: [], outcome: "IMAGE_SAVED", stopCode: null, imageCalls: 3, imageFailed: 0, threadId: null, cliVersion: "mock-0.0.0", model: "mock-image-model", codexMs: 1 }));

describe("Issue #290 P0 the worker's fixed manifest: ほし窯 is gone, recorded as closed", () => {
  it("bakery is not an auto-run shop; the shop ids are つぐ手 and 輪 only", () => {
    expect(Object.prototype.hasOwnProperty.call(AUTORUN_SHOPS, "bakery")).toBe(false);
    expect([...AUTORUN_SHOP_IDS]).toEqual(["tsugute", "bicycle"]);
    expect(CLOSED_SHOPS.bakery!.approval_record).toBe(HOSHIGAMA_APPROVAL!.approval_record);
  });
  it("no listed shop carries ほし窯's page, photos or run prompt", () => {
    for (const id of AUTORUN_SHOP_IDS) {
      const shop = AUTORUN_SHOPS[id];
      expect(shop.pageDir, id).not.toContain("/poc/bakery/");
      expect(shop.prompt.sha256, id).not.toBe(RUN_SHA);
      expect(sha(shop.prompt.build()), id).not.toBe(RUN_SHA);
      for (const p of PHOTO_IDS) expect(shop.slotIds as readonly string[], id).not.toContain(p);
    }
  });
  it("the job schema refuses a ほし窯 job outright (the shop enum), and still takes no free text, path, URL or shell", () => {
    expect(ImageAutorunJobSchema.safeParse(bakeryJob()).success).toBe(false);
    expect(ImageAutorunJobSchema.safeParse(bakeryJob({}, { shop: "tsugute" })).success).toBe(false);
    for (const extra of [{ prompt: "anything" }, { path: "/etc/passwd" }, { url: "https://example.com" }, { cmd: "rm -rf /" }]) expect(ImageAutorunJobSchema.safeParse({ ...bakeryJob(), ...extra }).success, Object.keys(extra)[0]).toBe(false);
  });
  it("the approved run prompt still builds (for verifying the photos already made), but only the offline code reads it", () => {
    expect([sha(buildHoshigamaRunPrompt()), buildHoshigamaRunPrompt().length]).toEqual([RUN_SHA, 2668]);
  });
});

describe("Issue #290 P0 a ほし窯 job with the FULL chain is refused: 0 generate calls, 0 sandbox, approval not used, nothing written", () => {
  // every link that used to open the run is present: the owner's root switch entry for exactly this job, root's grant
  // for the job's exact bytes, a fresh approval id and job id, the approved run prompt's SHA, d2-v2 and its 3 photos
  const ids: Array<[string, string]> = [
    ["a NEW approval id and job id", APPROVAL],
    ["the run sheet's proposed id of the used run", "s0-hoshigama-photos-20261118-01"],
    ["another fresh id", "bakery-photos-20261201-01"],
  ];
  for (const [label, appr] of ids) {
    it(`${label} (${appr}): REFUSED_JOB_INVALID`, async () => {
      const f = world({ approvals: [entry({ approval_id: appr })] });
      f.put("job-bakery", bakeryJob({ approval_id: appr }), true);
      const gen = wouldSucceed();
      expect((await f.run(gen))?.code).toBe("REFUSED_JOB_INVALID");
      expect(gen).toHaveBeenCalledTimes(0);
      expect(real.generate).toHaveBeenCalledTimes(0);
      expect(real.sandbox).toHaveBeenCalledTimes(0);
      expect(f.marker(appr)).toBe(false);
      expect(readdirSync(f.out)).toEqual([]);
    });
  }

  it("ほし窯's page, photos and run prompt under a listed shop id (つぐ手, 輪): REFUSED_JOB_INVALID, 0 calls", async () => {
    for (const shop of ["tsugute", "bicycle"] as const) {
      const max = AUTORUN_SHOPS[shop].maxImages;
      const f = world({ approvals: [entry({ shop, max_images: max })] });
      f.put("job-bakery", bakeryJob({ shop_id: shop }, { shop, max_images: max }), true);
      const gen = never();
      expect((await f.run(gen))?.code, shop).toBe("REFUSED_JOB_INVALID");
      expect(gen).toHaveBeenCalledTimes(0);
      expect(real.sandbox).toHaveBeenCalledTimes(0);
      expect(f.marker(APPROVAL)).toBe(false);
      expect(readdirSync(f.out)).toEqual([]);
    }
  });
});

describe("Issue #290 P0 root's cycle.sh: back to 'tsugute:6 bicycle:6', its own matcher refuses ほし窯 before any grant", () => {
  const cycle = readFileSync(join(REPO, "scripts/sales-design-worker/cycle.sh"), "utf8");
  const allow = /^IMAGE_AUTORUN_SHOPS='([^']*)'$/m.exec(cycle)![1]!;
  const py = /\nIMAGE_MATCH_PY='\n([\s\S]*?)\n'\n/.exec(cycle)![1]!;
  const match = (shop: string, mi: number, appr = APPROVAL) => {
    const dir = mkdtempSync(join(tmpdir(), "dev139-root-"));
    roots.push(dir);
    const conf = join(dir, "image-autorun.json");
    const exp = "2030-01-01T00:00:00Z";
    writeFileSync(conf, JSON.stringify({ version: 1, enabled: true, approvals: [{ approval_id: appr, job_id: "job-x", shop, max_images: mi, max_jobs: 1, expires_at: exp }] }));
    const now = String(Math.floor(Date.parse(exp) / 1000) - 3600);
    const r = spawnSync("python3", ["-I", "-c", py, conf, "job-x", appr, shop, String(mi), "1", exp, now, allow], { encoding: "utf8" });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  it("the allowlist is exactly 'tsugute:6 bicycle:6', one assignment", () => {
    expect(cycle.split("\n").filter((l) => /^IMAGE_AUTORUN_SHOPS=/.test(l))).toEqual(["IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6'"]);
  });
  it("ほし窯 with the owner's matching entry and a NEW id → IMAGE_GRANT_SCOPE_MISMATCH for any image count; the others unchanged", () => {
    for (let mi = 1; mi <= 6; mi++) expect(match("bakery", mi), String(mi)).toBe("IMAGE_GRANT_SCOPE_MISMATCH");
    expect(match("bakery", 3, "s0-hoshigama-photos-20261118-01")).toBe("IMAGE_GRANT_SCOPE_MISMATCH");
    expect(match("bicycle", 6)).toBe("IMAGE_GRANT_MATCH");
    expect(match("tsugute", 6)).toBe("IMAGE_GRANT_MATCH");
    expect(match("sento", 3)).toBe("IMAGE_GRANT_SCOPE_MISMATCH");
  });
  it("the grant stays 20 minutes (the timer is not installed on WSL)", () => {
    expect(cycle).toMatch(/^GRANT_TTL=1200$/m);
  });
  it("the run sheet's close step pins exactly this cycle.sh (the file SHA-256 the owner checks after the root clone update)", () => {
    const sheet = readFileSync(join(REPO, "docs/operations/hoshigama-one-time-run-sheet.md"), "utf8");
    expect(sheet).toContain(`= ${sha(cycle)} ] || { echo STOP_CLOSE_CYCLE_SHA; exit 1; }`);
    expect(sheet).toContain("IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6'$");
  });
});
