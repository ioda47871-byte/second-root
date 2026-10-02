import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SandboxError } from "@/lib/design-agent/sandbox";
import { estimateRuntime, pocPreflight } from "@/lib/design-agent/worker/poc";
import { passthroughSandbox } from "../../support/passthrough-sandbox";
import { fakePng, writeStore, type FakeAsset } from "./photo-fixtures";
import { fakeCodex, makeLayout } from "./worker-support";

// DEV-029 stage 5: the photo PoC's preflight and its runtime estimate. The
// report after a real worker run is tested in photo-worker.test.ts.

vi.setConfig({ testTimeout: 60_000 });

const A = "asset-aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "asset-bbbbbbbbbbbbbbbbbbbbbbbb";
const concept: FakeAsset[] = [{ id: A, png: fakePng(360, 450, { seed: 1 }), sourceKind: "generated_concept" }];

function setup(assets: FakeAsset[] | null, login: "chatgpt" | "apikey" | "none" = "chatgpt") {
  const l = makeLayout();
  const env = { PATH: process.env.PATH, HOME: l.root, CODEX_HOME: join(l.root, "codex-home"), TMPDIR: l.tmp };
  const store = join(l.root, ".local", "share", "second-root-design-assets");
  const bin = fakeCodex(l, [], login);
  const options = (jobId: string, prepare?: () => Promise<never>) => ({
    jobId,
    queueRoot: l.queue,
    outRoot: l.out,
    env,
    repoDir: process.cwd(),
    prepareSandbox: prepare ?? (async () => passthroughSandbox(bin, env)),
  });
  return { l, store, options, ready: assets ? writeStore(store, "poc-photo-1", assets) : Promise.resolve() };
}

const codes = (r: { checks: Array<{ check: string; ok: boolean; code?: string }> }) => Object.fromEntries(r.checks.map((c) => [c.check, c.ok ? "ok" : c.code]));

describe("poc preflight", () => {
  it("is ready for an unused job with verified generated_concept photos, a sandbox and a ChatGPT sign-in", async () => {
    const s = setup(concept);
    await s.ready;
    const r = await pocPreflight(s.options("poc-photo-1"));
    expect(codes(r)).toEqual({
      job_id_unused: "ok",
      queue_idle: "ok",
      asset_store_safe: "ok",
      manifest: "ok",
      photos_verified: "ok",
      generated_concept_only: "ok",
      no_people: "ok",
      sandbox_store_hidden: "ok",
      codex_chatgpt_sign_in: "ok",
    });
    expect(r).toMatchObject({ ready: true, photos: 1 });
    // codes and counts only
    expect(JSON.stringify(r)).not.toContain(s.l.root);
  });

  it("refuses a job id already queued or run (no second run of the same job)", async () => {
    const s = setup(concept);
    await s.ready;
    for (const dir of ["inbox", "done"]) {
      mkdirSync(join(s.l.queue, dir), { recursive: true });
      writeFileSync(join(s.l.queue, dir, `poc-photo-1.json`), "{}");
      const r = await pocPreflight(s.options("poc-photo-1"));
      expect(r.ready).toBe(false);
      expect(codes(r).job_id_unused).toMatch(/^JOB_ALREADY_/);
    }
    const busy = setup(concept);
    await busy.ready;
    mkdirSync(join(busy.l.queue, "inbox"), { recursive: true });
    writeFileSync(join(busy.l.queue, "inbox", "shop-001.json"), "{}");
    expect(codes(await pocPreflight(busy.options("poc-photo-1"))).queue_idle).toBe("OTHER_JOBS_WAITING");
    const t = setup(concept);
    await t.ready;
    mkdirSync(join(t.l.out, "poc-photo-1"), { recursive: true });
    expect(codes(await pocPreflight(t.options("poc-photo-1"))).job_id_unused).toBe("JOB_ALREADY_RESULTS");
  });

  it("is not ready without a manifest, with a changed photo, with an approved photo, without the sandbox or the sign-in", async () => {
    const none = setup(null);
    expect(codes(await pocPreflight(none.options("poc-photo-1"))).manifest).toBe("NO_PHOTOS");

    const changed = setup(concept);
    await changed.ready;
    writeFileSync(join(changed.store, "poc-photo-1", `${A}.png`), fakePng(360, 450, { seed: 7 }));
    expect(codes(await pocPreflight(changed.options("poc-photo-1"))).photos_verified).toBe("PHOTO_INPUT_REJECTED");

    const real = setup([...concept, { id: B, png: fakePng(480, 320, { seed: 2 }), sourceKind: "approved_real" }]);
    await real.ready;
    expect(codes(await pocPreflight(real.options("poc-photo-1"))).generated_concept_only).toBe("NOT_GENERATED_CONCEPT");

    const leak = setup(concept);
    await leak.ready;
    const r = await pocPreflight(
      leak.options("poc-photo-1", async () => {
        throw new SandboxError("CODEX_SANDBOX_LEAK");
      }),
    );
    expect(codes(r)).toMatchObject({ sandbox_store_hidden: "CODEX_SANDBOX_LEAK" });
    expect(r.checks.some((c) => c.check === "codex_chatgpt_sign_in")).toBe(false);

    for (const login of ["none", "apikey"] as const) {
      const s = setup(concept, login);
      await s.ready;
      expect(codes(await pocPreflight(s.options("poc-photo-1"))).codex_chatgpt_sign_in).toBe(login === "none" ? "CODEX_NOT_SIGNED_IN" : "CODEX_API_KEY_AUTH");
    }
  });
});

describe("runtime estimate", () => {
  const min = 60_000;
  const call = (stage: string, duration_ms: number, result = "ok") => ({ stage, duration_ms, schema: "strict", result }) as never;

  it("scales revision 0 / 1 / 2 from the measured calls, with a conservative figure from the slowest", () => {
    const e = estimateRuntime(
      {
        capture_ms: 1 * min,
        pipeline_ms: 14 * min,
        codex_ms: 12 * min,
        call_list: [call("profile_brief", 4 * min), call("photo_analysis", 2 * min), call("image_direction", 2 * min), call("visual_review", 4 * min)],
      },
      50 * min,
    );
    // 1 capture + 4 brief + 2 analysis + (r + 1) × (2 + 4) + (r + 2) × 1 (2 min besides Codex over 2 renders)
    expect(e.mean_ms).toEqual([15 * min, 22 * min, 29 * min]);
    expect(e.conservative_ms).toEqual(e.mean_ms);
    expect(e.verdict).toBe("OK");
  });

  it("flags a run that would not fit, and says when there is nothing to go on", () => {
    const slow = estimateRuntime(
      { capture_ms: 2 * min, pipeline_ms: 30 * min, codex_ms: 28 * min, call_list: [call("profile_brief", 8 * min), call("photo_analysis", 6 * min), call("image_direction", 6 * min), call("visual_review", 8 * min)] },
      50 * min,
    );
    expect(slow.verdict).toBe("OVER");
    const risky = estimateRuntime(
      { capture_ms: 1 * min, pipeline_ms: 20 * min, codex_ms: 19 * min, call_list: [call("profile_brief", 5 * min), call("photo_analysis", 4 * min), call("image_direction", 4 * min), call("visual_review", 5 * min), call("visual_review", 6 * min, "CODEX_TIMEOUT")] },
      50 * min,
    );
    expect(risky.conservative_ms[2]).toBeGreaterThan(40 * min);
    expect(risky.verdict).toBe("AT_RISK");
    expect(estimateRuntime(null, 50 * min).verdict).toBe("NO_DATA");
  });
});
