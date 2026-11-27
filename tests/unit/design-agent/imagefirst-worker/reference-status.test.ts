import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inspectCaseStudy, ORIGINALS_INDEX_PATH } from "@/lib/design-agent/case-study/case-study";
import { PromptStop } from "@/lib/design-agent/image-first/prompt";
import { buildRequestPlan, parseRequest, referencesEn, referencesJa, type DesignRequest, type PlanReference, type RequestCaseStudyUse } from "@/lib/design-agent/image-first/request-prompt";
import { caseStudyUseOf } from "@/lib/design-agent/imagefirst-worker/request";
import type { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { caseStudyObject, cleanupTemps, REPO, sha } from "./support";

// DEV-364 (owner decision 2026-11-27): the whole-page prompt says what the attached references are — originals, or
// viewing copies (never called originals) — from the status the originals index records. A plan of originals stays byte
// for byte what it was. FICTIONAL fixtures only. No Codex, no model, no network.

afterAll(cleanupTemps);

const FACTS: FactsPack = {
  schema: "shop_facts_pack_v1",
  shop_id: "test-shop-w",
  facts: [
    { id: "F1", key: "name", value: "架空書店 しおり堂", source_id: "S1" },
    { id: "F2", key: "category", value: "bookstore", source_id: "S1" },
    { id: "F3", key: "description", value: "テスト用の架空の書店です。実在しません。", source_id: "S1" },
    { id: "F5", key: "hours", value: "10:00〜19:00", source_id: "S1" },
    { id: "F7", key: "statement_1", value: "架空の古書を一冊ずつ棚に並べます", source_id: "S1" },
  ],
};
const FACTS_BYTES = Buffer.from(`${JSON.stringify(FACTS, null, 2)}\n`);
const CS_SHA = sha("invented case study bytes");
const REQUEST_OBJ = {
  schema: "sr_imagefirst_request_v1", id: "req-test-shop-w-1", shop_id: "test-shop-w", kind: "fictional", created_at: "2026-11-25T00:30:00Z", layout: "whole_page",
  direction: { name: "紙の静けさ", concept: "紙の手ざわりと静かな余白。", palette: "生成りの地に墨色。", typography: "明朝体の見出し。", layout_pc: "広い余白。", layout_sp: "一段。", avoid: "写真風の表現。" },
  case_study: { path: "case-study.json", sha256: CS_SHA }, facts_ref: { root: "second-root-shops", shop_id: "test-shop-w" }, facts_sha256: sha(FACTS_BYTES), max_images: 2, codex_runs: 1,
};
const REQUEST_BYTES = Buffer.from(`${JSON.stringify(REQUEST_OBJ, null, 2)}\n`);
const REQUEST = parseRequest(REQUEST_BYTES, sha(REQUEST_BYTES), REQUEST_OBJ.id).request as DesignRequest;
const ORIGINAL: PlanReference = { id: "ref-1", case_id: "CP-001", name: "ref-1.png", sha256: sha("ref one"), media_type: "image/png" };
const use = (references: PlanReference[], cases = ["CP-001"]): RequestCaseStudyUse => ({ sha256: CS_SHA, shop_specific_principles: ["試験用の原理"], cases: cases.map((id) => ({ id, principles_to_bring: ["原理"], do_not_copy: ["写さない"] })), references });
const plan = (references: PlanReference[], cases?: string[]) => buildRequestPlan({ request: REQUEST, requestSha256: sha(REQUEST_BYTES), factsBytes: FACTS_BYTES, facts: FACTS, caseStudy: use(references, cases) });

describe("DEV-364 reference status in the whole-page prompt", () => {
  it("a plan of originals is byte-identical to origin/develop 41d35fbd (before DEV-364)", () => {
    // computed with that commit's request-prompt.ts from exactly this fixture
    const p = plan([ORIGINAL]);
    expect([p.plan_sha256, p.batch.sha256]).toEqual(["c06bf74e4e2eea33d9de62581d9b9af8bb554253ababbfc6cb3c005cbcf357a4", "78b3b00f7bf7eb3d1bcf89f39851bc47d0184ee7b537ef058e0babd2cd0d1707"]);
    expect(p.batch.prompt).toContain("参照画像: 成功例の原本 1 枚を参照画像として渡す");
    expect(p.batch.prompt).toContain("(1 success-case originals, absolute paths,");
    expect(p.references).toEqual([ORIGINAL]);
  });

  it("viewing copies are named as such, never as originals; the status is bound into the plan", () => {
    const copy: PlanReference = { ...ORIGINAL, copy: "viewing" };
    const p = plan([copy]);
    expect(p.batch.prompt).toContain("参照画像: 成功例の閲覧用コピー 1 枚（原本ではない）を参照画像として渡す");
    expect(p.batch.prompt).toContain("(1 success-case viewing copies, not the originals, absolute paths,");
    expect(p.batch.prompt).not.toMatch(/成功例の原本|success-case originals/);
    expect(p.references).toEqual([copy]);
    expect(p.plan_sha256).not.toBe(plan([ORIGINAL]).plan_sha256);
  });

  it("a mix says both counts; an unknown status is refused", () => {
    const refs: PlanReference[] = [ORIGINAL, { id: "ref-2", case_id: "CP-002", name: "ref-2.webp", sha256: sha("ref two"), media_type: "image/webp", copy: "viewing" }];
    expect(referencesJa(refs)).toBe("成功例の原本 1 枚と閲覧用コピー 1 枚（閲覧用コピーは原本ではない）");
    expect(referencesEn(refs)).toBe("1 success-case originals and 1 viewing copies (not originals)");
    expect(plan(refs, ["CP-001", "CP-002"]).batch.prompt).toContain("成功例の原本 1 枚と閲覧用コピー 1 枚");
    const bad = [{ ...ORIGINAL, copy: "original" } as unknown as PlanReference];
    expect(() => plan(bad)).toThrow(PromptStop);
    try {
      plan(bad);
    } catch (error) {
      expect((error as PromptStop).code).toBe("REFERENCE_IMAGES_INVALID");
    }
  });

  it("the index records CP-001..003's committed WebPs as viewing copies, and the case study carries that into the references", async () => {
    const index = JSON.parse(readFileSync(resolve(REPO, ORIGINALS_INDEX_PATH), "utf8")) as { originals: { id: string; files: { copy?: string }[] }[] };
    for (const id of ["CP-001", "CP-002", "CP-003"]) expect(index.originals.find((o) => o.id === id)!.files.every((f) => f.copy === "viewing"), id).toBe(true);
    // SR-001 (its own page files) is not marked
    expect(index.originals.find((o) => o.id === "SR-001")!.files.some((f) => f.copy !== undefined)).toBe(false);
    const record = caseStudyObject("test-shop-w", { owner_confirmation: undefined });
    const i = await inspectCaseStudy(Buffer.from(JSON.stringify(record)), { repo: REPO });
    const u = caseStudyUseOf(i);
    expect(u.use.references.map((r) => [r.case_id, r.copy])).toEqual([["CP-001", "viewing"], ["CP-002", "viewing"], ["CP-003", "viewing"]]);
    expect(u.references.every((r) => r.copy === "viewing")).toBe(true);
  });
});
