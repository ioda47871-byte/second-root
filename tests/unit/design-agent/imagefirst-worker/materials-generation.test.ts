import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packBundle } from "@/lib/design-agent/imagefirst-worker/bundle";
import { MATERIALS_GENERATOR, settleRun } from "@/lib/design-agent/imagefirst-worker/cycle";
import { readDeliveredMaterials } from "@/lib/design-agent/imagefirst-worker/materials-approval";
import { solidPng } from "@/experiments/pages-cms/fixtures";

// DEV-364 PR 3c (Lead's decision 2026-11-27, option (1)): a completed photo-materials run SEALS its generation facts into
// its bundle — the generator, the Codex SESSION model as the entry recorded it (null when unknown), when, the batch
// prompt's SHA-256 and the request id — and the materials gate exposes them. FICTIONAL data; no Codex, no process
// (settleRun reads the run directory a fake entry left; it never invokes anything). Temp homes only.

const temps: string[] = [];
const tmp = (p = "sr-gen-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  chmodSync(d, 0o700);
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const ID = "req-hoshigama-gen-photos-1";
const PROMPT = "d".repeat(64);
const START = Date.parse("2026-11-27T01:00:00Z");
const APPROVED = { bundle_id: "req-hoshigama-gen-design-1", bundle_sha256: "a".repeat(64), review_sha256: "b".repeat(64), approval_sha256: "c".repeat(64) };

/** A finished photo-materials run as the entry leaves it: parts, call.json, photo-plan.json (its generation facts). */
function finishedRun(o: { sessionModel?: string | null; plan?: boolean } = {}) {
  const runsDir = tmp("sr-gen-runs-");
  const runDir = join(runsDir, `${ID}-20261127T010000Z`);
  mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const pic = solidPng(768, 512, [150, 98, 60]);
  writeFileSync(join(runDir, "parts", "photo-1.png"), pic, { mode: 0o600 });
  writeFileSync(join(runDir, "call.json"), JSON.stringify({ schema: "image_first_call_v0", status: "succeeded", images: [{ file: "parts/photo-1.png", sha256: sha(pic) }] }), { mode: 0o600 });
  if (o.plan !== false)
    writeFileSync(join(runDir, "photo-plan.json"), JSON.stringify({ schema: "image_first_photo_run_v0", generation: { cli_version: "0.0.0-test", session_model: o.sessionModel === undefined ? "gpt-test-session" : o.sessionModel, finished_at: "2026-11-27T01:04:00.000Z" } }), { mode: 0o600 });
  writeFileSync(join(runDir, "approved-design-input.json"), JSON.stringify({ schema: "image_first_approved_design_input_v0", ...APPROVED, materials_sha256: "9".repeat(64) }), { mode: 0o600 });
  return { runsDir, runDir, pic };
}
const settle = (r: ReturnType<typeof finishedRun>) =>
  settleRun(
    {
      runsDir: r.runsDir,
      runDir: r.runDir,
      receiptName: `${ID}-20261127T010000Z`,
      started: START,
      now: () => START + 300_000,
      images: { pc: 0, sp: 0, photo: 1 },
      fields: { shop: "hoshigama", direction: "request", approval_id: ID, plan_id: ID, commit: "c".repeat(40), packet_sha256: "e".repeat(64), plan_sha256: "f".repeat(64), prompt_sha256: PROMPT, prompt_chars: 1000 },
      extra: { mode: "request", kind: "fictional", request_id: ID, request_sha256: "e".repeat(64), facts_sha256: "1".repeat(64), request_stage: "photo_materials", approved_design: APPROVED, materials_sha256: "9".repeat(64) },
    },
    { code: 0, signal: null, stdout: '{"status":"succeeded"}\n', stderr: "", timedOut: false },
    false,
  );
const receiptOf = (r: ReturnType<typeof finishedRun>) => JSON.parse(readFileSync(join(r.runsDir, `${ID}-20261127T010000Z.receipt.json`), "utf8")) as Record<string, unknown>;

describe("DEV-364 PR 3c: a photo-materials run seals its generation facts", () => {
  it("the receipt carries them (session model as recorded), the bundle seals them, the materials gate exposes them", async () => {
    const r = finishedRun();
    expect((await settle(r)).status).toBe("succeeded");
    const receipt = receiptOf(r);
    expect(receipt.generation).toEqual({ generator: MATERIALS_GENERATOR, session_model: "gpt-test-session", generated_at: "2026-11-27T01:04:00.000Z", prompt_sha256: PROMPT, request_id: ID });
    const sealed = await packBundle({ runDir: r.runDir, receiptPath: join(r.runsDir, `${ID}-20261127T010000Z.receipt.json`), bundlesDir: join(tmp(), "review-inbox"), now: () => START + 400_000 });
    expect(JSON.parse(readFileSync(join(sealed.dir, "receipt.json"), "utf8")).generation).toEqual(receipt.generation);
    expect((await readDeliveredMaterials(sealed.dir)).generation).toEqual(receipt.generation);
  });

  it("an unknown session model is sealed as null (never invented); a run without its plan file seals none (still a valid bundle)", async () => {
    const unknown = finishedRun({ sessionModel: null });
    await settle(unknown);
    expect((receiptOf(unknown).generation as { session_model: unknown }).session_model).toBeNull();
    const none = finishedRun({ plan: false });
    await settle(none);
    expect(receiptOf(none).generation).toBeUndefined();
    const sealed = await packBundle({ runDir: none.runDir, receiptPath: join(none.runsDir, `${ID}-20261127T010000Z.receipt.json`), bundlesDir: join(tmp(), "review-inbox"), now: () => START + 400_000 });
    expect((await readDeliveredMaterials(sealed.dir)).generation).toBeNull();
  });

  it("the bundle refuses malformed facts: another prompt, another request, extra keys, a model that is not a slug", async () => {
    for (const bad of [{ prompt_sha256: "0".repeat(64) }, { request_id: "req-other-photos-1" }, { extra: 1 }, { session_model: "not a slug!" }, { generated_at: "yesterday" }]) {
      const r = finishedRun();
      await settle(r);
      const path = join(r.runsDir, `${ID}-20261127T010000Z.receipt.json`);
      const receipt = JSON.parse(readFileSync(path, "utf8")) as { generation: Record<string, unknown> };
      writeFileSync(path, JSON.stringify({ ...receipt, generation: { ...receipt.generation, ...bad } }), { mode: 0o600 });
      const code = await packBundle({ runDir: r.runDir, receiptPath: path, bundlesDir: join(tmp(), "review-inbox"), now: () => START + 400_000 }).then(() => "ok", (e: { code?: string }) => e.code ?? String(e));
      expect(code, JSON.stringify(bad)).toBe("RECEIPT_INVALID");
    }
  });
});
