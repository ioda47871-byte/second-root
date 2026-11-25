import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CaseStudyInspection } from "@/lib/design-agent/case-study/case-study";
import { checkRunAttachments, generateImageOnce, generateImagesInOneRun } from "@/lib/design-agent/design-image/image-once";
import { readImageFirstRun } from "@/lib/design-agent/image-first/builder";
import { buildRequestPlan, parseRequest, PHOTO_LABEL, WHOLE_PAGE_IMAGES, WHOLE_PAGE_PROMPT_VERSION, wholePageInventory, type DesignRequest, type RequestCaseStudyUse, type RequestPlan } from "@/lib/design-agent/image-first/request-prompt";
import { PromptStop } from "@/lib/design-agent/image-first/prompt";
import { validateImageFirst } from "@/lib/design-agent/image-first/validate";
import { IMAGE_TOOL_MAX_REFS, REFERENCE_DIR_TOKEN } from "@/lib/design-agent/image-tool-limits";
import { caseStudyUseOf, referenceRecordOf, selectReferenceImages } from "@/lib/design-agent/imagefirst-worker/request";
import { runRequestFullPageCall } from "@/lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import type { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { colourPng } from "../phase2f/fixtures";
import { cleanup as cleanupRuns, drawPart, makeRun } from "../image-first/fixtures";
import { cleanupTemps, fakeCodex, sha, tmp } from "./support";

// DEV-303 §6.1 row 3 (docs/design/image-first-production-flow.md §1 stage 2, §3.2, §3.5): the whole-page design of
// request mode — its plan and prompt, the real_shop rule, the success-case reference pictures (≤ 5, absolute staged paths),
// the refusal of photo_inputs, and the PC 1 + SP 1 counts of its records. FICTIONAL fixtures only: the "real_shop" pack
// and the case-study texts are invented for the test. No Codex, no model, no image tool, no network.

afterAll(() => {
  cleanupTemps();
  cleanupRuns();
});

const ID = "req-test-shop-w-1";
const SHOP = "test-shop-w";
const FACTS: FactsPack = {
  schema: "shop_facts_pack_v1",
  shop_id: SHOP,
  facts: [
    { id: "F1", key: "name", value: "架空書店 しおり堂", source_id: "S1" },
    { id: "F2", key: "category", value: "bookstore", source_id: "S1" },
    { id: "F3", key: "description", value: "テスト用の架空の書店です。実在しません。", source_id: "S1" },
    { id: "F4", key: "address", value: "架空市架空町7-7-7", source_id: "S1" },
    { id: "F5", key: "hours", value: "10:00〜19:00", source_id: "S1" },
    { id: "F6", key: "closed_days", value: "火曜", source_id: "S1" },
    { id: "F7", key: "statement_1", value: "架空の古書を一冊ずつ棚に並べます", source_id: "S1" },
    { id: "F8", key: "service_1", value: "架空の古書", source_id: "S1" },
    { id: "F9", key: "service_2", value: "架空の文具", source_id: "S1" },
  ],
};
const FACTS_BYTES = Buffer.from(`${JSON.stringify(FACTS, null, 2)}\n`);
const DIRECTION = {
  name: "紙の静けさ",
  concept: "紙の手ざわりと静かな余白で、ゆっくり選ぶ時間を見せる。",
  palette: "生成りの地に墨色と古い朱。",
  typography: "明朝体の見出しと細いゴシックの本文。",
  layout_pc: "広い余白に、縦書きの店名を大きく置く。",
  layout_sp: "一段。最初の画面で店名と営業時間が分かる。",
  avoid: "写真風の表現と派手な色。",
};
const CS_SHA = sha("invented case study bytes");
const CS_USE: RequestCaseStudyUse = {
  sha256: CS_SHA,
  shop_specific_principles: ["試験用の店固有の原理: 紙の余白を主役にする"],
  cases: [
    { id: "CP-002", principles_to_bring: ["試験用の原理 二の一"], do_not_copy: ["試験用の写さないこと 二"] },
    { id: "CP-001", principles_to_bring: ["試験用の原理 一の一", "試験用の原理 一の二"], do_not_copy: ["試験用の写さないこと 一"] },
  ],
  references: [
    { id: "ref-1", case_id: "CP-002", name: "ref-1.webp", sha256: sha("ref one"), media_type: "image/webp" },
    { id: "ref-2", case_id: "CP-001", name: "ref-2.png", sha256: sha("ref two"), media_type: "image/png" },
  ],
};
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
function requestObject(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "sr_imagefirst_request_v1",
    id: ID,
    shop_id: SHOP,
    kind: "real_shop",
    created_at: "2026-11-25T00:30:00Z",
    layout: "whole_page",
    direction: DIRECTION,
    case_study: { path: "case-study.json", sha256: CS_SHA },
    facts_ref: { root: "second-root-shops", shop_id: SHOP },
    facts_sha256: sha(FACTS_BYTES),
    max_images: 2,
    codex_runs: 1,
    ...over,
  };
}
const parseCode = (o: Record<string, unknown>) => {
  const b = bytesOf(o);
  try {
    parseRequest(b, sha(b), o.id as string);
    return "ok";
  } catch (error) {
    return error instanceof PromptStop ? error.code : String(error);
  }
};
const planCode = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (error) {
    return error instanceof PromptStop ? error.code : String(error);
  }
};
const REQUEST = parseRequest(bytesOf(requestObject()), sha(bytesOf(requestObject())), ID).request as DesignRequest;
const plan = (o: { request?: DesignRequest; caseStudy?: RequestCaseStudyUse | null; facts?: FactsPack } = {}) => buildRequestPlan({ request: o.request ?? REQUEST, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: o.facts ?? FACTS, caseStudy: o.caseStudy === undefined ? CS_USE : o.caseStudy });

describe("DEV-303 §6.1 row 3 whole_page request schema: real shops use it, photo_inputs never", () => {
  it("a real_shop design request must be whole_page (PC 1 + SP 1); the section split stays for fictional requests", () => {
    expect(parseCode(requestObject())).toBe("ok");
    expect(REQUEST.layout).toBe("whole_page");
    expect(WHOLE_PAGE_IMAGES).toEqual({ pc: 1, sp: 1, total: 2 });
    // no layout, or the section split, on a real shop
    expect(parseCode(requestObject({ layout: undefined, max_images: 6 }))).toBe("REAL_SHOP_WHOLE_PAGE_REQUIRED");
    expect(parseCode(requestObject({ layout: "section_sequence", max_images: 6 }))).toBe("REAL_SHOP_WHOLE_PAGE_REQUIRED");
    // max_images must be the layout's count
    expect(parseCode(requestObject({ max_images: 6 }))).toBe("REQUEST_INVALID");
    expect(parseCode(requestObject({ layout: "section_sequence", max_images: 2, kind: "fictional" }))).toBe("REQUEST_INVALID");
    expect(parseCode(requestObject({ layout: "other" }))).toBe("REQUEST_INVALID");
    // a fictional request may use either; the section split is unchanged for it
    expect(parseCode(requestObject({ kind: "fictional" }))).toBe("ok");
    expect(parseCode(requestObject({ kind: "fictional", layout: undefined, max_images: 6, case_study: undefined }))).toBe("ok");
  });
  it("whole_page refuses photo_inputs (design → approval → materials) and needs the case study (its principles and references)", () => {
    const photo_inputs = { request_id: "req-test-shop-w-photos-1", files: [{ name: "photo-1.png", sha256: sha("1") }] };
    expect(parseCode(requestObject({ photo_inputs }))).toBe("WHOLE_PAGE_PHOTO_INPUTS_REFUSED");
    expect(parseCode(requestObject({ kind: "fictional", photo_inputs }))).toBe("WHOLE_PAGE_PHOTO_INPUTS_REFUSED");
    expect(parseCode(requestObject({ case_study: undefined }))).toBe("CASE_STUDY_REQUIRED");
    expect(parseCode(requestObject({ kind: "fictional", case_study: undefined }))).toBe("CASE_STUDY_REQUIRED");
    // the plan builder refuses them too
    expect(planCode(() => plan({ request: { ...REQUEST, photo_inputs } as DesignRequest }))).toBe("WHOLE_PAGE_PHOTO_INPUTS_REFUSED");
    expect(planCode(() => plan({ caseStudy: null }))).toBe("CASE_STUDY_REQUIRED");
    expect(planCode(() => plan({ caseStudy: { ...CS_USE, sha256: sha("another") } }))).toBe("CASE_STUDY_PLAN_MISMATCH");
  });
});

describe("DEV-303 §6.1 row 3 whole_page plan and prompt", () => {
  const p = plan();
  const pc = p.viewports.desktop_1440;
  const sp = p.viewports.mobile_390;
  const prompts = [pc.parts[0]!.prompt, sp.parts[0]!.prompt];

  it("one full-page picture per viewport, portrait 2:3, mode whole_page, recorded in the plan", () => {
    expect([pc.parts.length, sp.parts.length, p.batch.images]).toEqual([1, 1, 2]);
    expect(p.layout).toBe("whole_page");
    expect(p.prompt_version).toBe(WHOLE_PAGE_PROMPT_VERSION);
    for (const [v, tag] of [[pc, "pc"], [sp, "sp"]] as const) {
      expect(v).toMatchObject({ mode: "whole_page", section_order: ["page"], seams: [] });
      expect(v.parts[0]).toMatchObject({ index: 1, name: `${tag}-1`, file: `parts/${tag}-1.png`, prompt_file: `prompts/${tag}-1.txt`, frame: "portrait_2x3", sections: [{ id: "page", box: { x: 0, y: 0, w: 1, h: 1 } }] });
    }
    expect(p.case_study_sha256).toBe(CS_SHA);
    expect(p.references).toEqual(CS_USE.references);
    // deterministic; the references and case study are bound into the plan SHA
    expect(plan().plan_sha256).toBe(p.plan_sha256);
    expect(plan({ caseStudy: { ...CS_USE, references: CS_USE.references.slice(0, 1) } }).plan_sha256).not.toBe(p.plan_sha256);
  });

  it("no fixed section order: no section ids, no part-of-n split, the number and order left to the principles", () => {
    for (const t of prompts) {
      expect(t).not.toMatch(/区画「|この画像に入る区画|枚の画像に分けた|上から \d+ 枚|継ぎ目|上端:|下端:/);
      for (const id of ["hero", "intro", "words", "menu", "info", "visit"]) expect(t).not.toContain(`「${id}」`);
      expect(t).toContain("決まった区画の順番はない");
      expect(t).toContain("区画の数・順番・形・大きさ・余白は、下の原理と方向性から決める");
      expect(t).toContain("ページ全体（いちばん上のヘッダーから、いちばん下のフッターまで）");
      expect(t).toContain("縦長の枠（横:縦 = 2:3）");
    }
    expect(p.batch.prompt).not.toMatch(/section images|section_sequence/);
  });

  it("the information inventory (unordered, exact facts values), the labels, Japanese, and the photo frames labelled イメージ", () => {
    const inventory = wholePageInventory(FACTS);
    expect(inventory).toEqual(["name", "description", "address", "hours", "closed_days", "statement_1", "service_1", "service_2"]);
    const values = new Set(FACTS.facts.map((f) => f.value));
    const allowed = new Set([...values, "営業時間", "定休日", "所在地", PHOTO_LABEL]);
    for (const t of prompts) {
      expect(t).toContain("順不同");
      for (const k of inventory) expect(t, k).toContain(`「${FACTS.facts.find((f) => f.key === k)!.value}」`);
      // every quoted text is a facts value, a facts-schema label or the photo-frame label; the category is never drawn
      for (const q of [...t.matchAll(/「([^」]+)」/g)].map((m) => m[1]!)) expect(allowed.has(q), q).toBe(true);
      expect(t).not.toContain("「bookstore」");
      expect(t).toContain("情報の言語: ページの情報は日本語で示す");
      expect(t).toContain(`枠の隅に小さく「${PHOTO_LABEL}」と書く`);
      expect(t).toContain("写真や写真風の絵そのものは描かない");
      // the existing real-shop and Identity Lock lines
      expect(t).toContain("実在の店。この画像は社内のデザインの参考だけに使い");
      expect(t).toContain("商品・料理・店内・建物・人物の姿は描かない");
      expect(t).toContain("価格・受賞・歴史や創業の年・人物（店主・職人など）・評判・お客様の声・メニューの説明・予約・限定の表示を作らない");
      expect(t).toContain("言い換え・要約・翻訳・分割をしない");
      expect(t).not.toMatch(/https?:|<[a-z]/i);
    }
    expect(p.batch.prompt).toContain("never depict products, dishes, interiors, buildings or people");
    expect(p.batch.prompt).toContain("photo areas are plain replaceable frames labelled イメージ");
  });

  it("the case study's principles: the shop's own, and each case's principles_to_bring / do_not_copy in the owner's order", () => {
    for (const t of prompts) {
      expect(t).toContain("この店固有のデザインの原理");
      expect(t).toContain("- 試験用の店固有の原理: 紙の余白を主役にする");
      expect(t).toContain("- CP-002: 持ち込む原理: 試験用の原理 二の一。写さないこと: 試験用の写さないこと 二。");
      expect(t).toContain("- CP-001: 持ち込む原理: 試験用の原理 一の一 / 試験用の原理 一の二。写さないこと: 試験用の写さないこと 一。");
      expect(t.indexOf("CP-002:")).toBeLessThan(t.indexOf("CP-001:"));
      expect(t).toContain("成功例の原本 2 枚を参照画像として渡す");
    }
  });

  it("PC and SP are independent compositions under one direction", () => {
    expect(prompts[0]).toContain("この画像は PC 版だけの構図");
    expect(prompts[0]).toContain(`PC 版の組み方: ${DIRECTION.layout_pc}`);
    expect(prompts[0]).not.toContain(DIRECTION.layout_sp);
    expect(prompts[1]).toContain("PC 版を縮めたものでも、PC 版の区画を縦に積み直したものでもない");
    expect(prompts[1]).toContain(`スマートフォン版の組み方: ${DIRECTION.layout_sp}`);
    expect(prompts[1]).not.toContain(DIRECTION.layout_pc);
    for (const t of prompts) expect(t).toContain("同じデザインの方針");
  });

  it("the batch names each reference once as TOKEN/ref-N.<ext> (never a path), at most 5; per-image prompts carry no token", () => {
    expect(p.batch.prompt).toContain(`set referenced_image_paths to exactly ["${REFERENCE_DIR_TOKEN}/ref-1.webp", "${REFERENCE_DIR_TOKEN}/ref-2.png"]`);
    expect(p.batch.prompt.split(REFERENCE_DIR_TOKEN).length - 1).toBe(2);
    for (const t of prompts) expect(t).not.toContain(REFERENCE_DIR_TOKEN);
    expect(p.batch.prompt).toContain("Call the image generation tool exactly 2 times");
    // the prompt the run checks against: the token matches the references exactly
    expect(() => checkRunAttachments({ prompt: p.batch.prompt, referenceImages: CS_USE.references.map((r) => ({ name: r.name, bytes: Buffer.alloc(0) })) })).not.toThrow();
    expect(() => checkRunAttachments({ prompt: p.batch.prompt, referenceImages: [{ name: "ref-1.webp", bytes: Buffer.alloc(0) }] })).toThrow("reference paths");
    expect(() => checkRunAttachments({ prompt: p.batch.prompt })).toThrow("reference paths");
    // pinned (a change to the whole-page prompt is a reviewed change)
    expect([p.batch.sha256, p.batch.chars]).toEqual([WHOLE_PAGE_BATCH_PIN.sha256, WHOLE_PAGE_BATCH_PIN.chars]);
    expect(p.plan_sha256).toBe(WHOLE_PAGE_BATCH_PIN.plan);
  });

  it("references: 1..5, ref-1.. in order, names by media type, distinct, of a listed case; a text carrying the token stops", () => {
    const refs = (n: number) => Array.from({ length: n }, (_, k) => ({ id: `ref-${k + 1}`, case_id: "CP-001", name: `ref-${k + 1}.png`, sha256: sha(`r${k}`), media_type: "image/png" as const }));
    expect(planCode(() => plan({ caseStudy: { ...CS_USE, references: refs(5) } }))).toBe("ok");
    expect(planCode(() => plan({ caseStudy: { ...CS_USE, references: refs(6) } }))).toBe("REFERENCE_IMAGES_OVER_TOOL_LIMIT");
    expect(planCode(() => plan({ caseStudy: { ...CS_USE, references: [] } }))).toBe("REFERENCE_IMAGES_MISSING");
    for (const bad of [
      [{ ...refs(1)[0]!, id: "ref-2", name: "ref-2.png" }],
      [{ ...refs(1)[0]!, name: "ref-1.jpg" }],
      [{ ...refs(1)[0]!, case_id: "CP-009" }],
      [{ ...refs(1)[0]!, name: "../ref-1.png" }],
      [refs(2)[0]!, { ...refs(2)[1]!, sha256: refs(2)[0]!.sha256 }],
    ]) expect(planCode(() => plan({ caseStudy: { ...CS_USE, references: bad } })), JSON.stringify(bad)).toBe("REFERENCE_IMAGES_INVALID");
    expect(planCode(() => plan({ caseStudy: { ...CS_USE, shop_specific_principles: [`${REFERENCE_DIR_TOKEN}/x`] } }))).toBe("REFERENCE_TOKEN_IN_TEXT");
  });
});

/** The whole-page batch prompt of the fixture above (fictional; recomputed only for a reviewed prompt change). */
const WHOLE_PAGE_BATCH_PIN = { sha256: "a7fc62ca3b5988e5f10ee2f7d4d00038d8c789f3c43cd0d39aa42eeabff27ccd", chars: 5124, plan: "a188ddf6b35332264f291bbf808190f1364474804dd0f1690809a502f2950196" };

describe("DEV-303 §6.1 row 3 reference selection from the gate-checked case study (deterministic, ≤ 5)", () => {
  const PNG = colourPng(8, 8);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
  const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(40, 2)]);
  const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40, 3)]);
  const file = (case_id: string, path: string, bytes: Buffer | null) => ({ case_id, path, sha256: sha(bytes ?? path), bytes });
  const caseOf = (id: string) => ({ id, evidence_kind: "image" as const, files: [], observations: { composition: "x", information_design: "x", shop_character: "x", pc_sp: "x" }, principles_to_bring: [`原理 ${id}`], do_not_copy: [`写さない ${id}`] });
  const inspection = (o: { counted: string[]; selected: string[]; files: ReturnType<typeof file>[] }) =>
    ({
      case_study_sha256: CS_SHA,
      counted: o.counted,
      files: o.files,
      record: { schema: "sr_case_study_v1", shop_id: SHOP, cases: o.counted.map(caseOf), shop_specific_principles: ["店の原理"], owner_confirmation: { confirmed: true, confirmed_at: "2026-11-25T00:00:00Z", selected_ids: o.selected, page_sha256: "0".repeat(64) } },
    }) as unknown as Pick<CaseStudyInspection, "case_study_sha256" | "counted" | "record" | "files">;

  it("owner order, the first PNG / JPEG / WebP per case (never page HTML, a GIF or an archive), capped at IMAGE_TOOL_MAX_REFS", () => {
    const ids = ["CP-001", "CP-002", "CP-003", "CP-004", "CP-005", "CP-006", "CP-007"];
    const files = [
      file("CP-001", "design-library/a/page.html", Buffer.from("<html>")),
      file("CP-001", "design-library/a/shot.png", PNG),
      file("CP-001", "design-library/a/shot-2.png", colourPng(9, 9)),
      file("CP-002", "/private/b/one.JPG", JPEG),
      file("CP-003", "/private/c/anim.gif", GIF),
      file("CP-003", "/private/c/src.zip", null),
      file("CP-004", "/private/d/view.webp", WEBP),
      file("CP-005", "/private/e/x.png", colourPng(10, 10)),
      file("CP-006", "/private/f/y.png", colourPng(11, 11)),
      file("CP-007", "/private/g/z.png", colourPng(12, 12)),
    ];
    const selected = [...ids].reverse();
    const refs = selectReferenceImages(inspection({ counted: ids, selected, files }));
    expect(IMAGE_TOOL_MAX_REFS).toBe(5);
    expect(refs.map((r) => [r.id, r.case_id, r.name, r.media_type])).toEqual([
      ["ref-1", "CP-007", "ref-1.png", "image/png"],
      ["ref-2", "CP-006", "ref-2.png", "image/png"],
      ["ref-3", "CP-005", "ref-3.png", "image/png"],
      ["ref-4", "CP-004", "ref-4.webp", "image/webp"],
      // CP-003 has no picture it may attach (a GIF and an archive): skipped
      ["ref-5", "CP-002", "ref-5.jpg", "image/jpeg"],
    ]);
    expect(refs.map((r) => r.sha256)).toEqual([12, 11, 10].map((n) => sha(colourPng(n, n))).concat([sha(WEBP), sha(JPEG)]));
    // record order when the owner chose 3: CP-001 contributes only its first picture
    const three = selectReferenceImages(inspection({ counted: ids.slice(0, 3), selected: ids.slice(0, 3), files }));
    expect(three.map((r) => [r.case_id, r.sha256])).toEqual([["CP-001", sha(PNG)], ["CP-002", sha(JPEG)]]);
    // the plan's part: metadata only (no bytes, no path), the counted cases in the owner's order
    const { use, references } = caseStudyUseOf(inspection({ counted: ids, selected, files }));
    expect(use.cases.map((c) => c.id)).toEqual(selected);
    expect(use.references).toEqual(references.map((r) => ({ id: r.id, case_id: r.case_id, name: r.name, sha256: r.sha256, media_type: r.media_type })));
    expect(JSON.stringify(use)).not.toMatch(/private|design-library|\.html/);
    expect(referenceRecordOf(references)).toEqual(references.map((r) => ({ id: r.id, case_id: r.case_id, sha256: r.sha256 })));
  });

  it("a picture whose magic bytes are not its type is skipped; one over the input cap or with another SHA-256 stops", () => {
    const fake = file("CP-001", "/private/a/fake.png", JPEG);
    expect(selectReferenceImages(inspection({ counted: ["CP-001"], selected: ["CP-001"], files: [fake] }))).toEqual([]);
    const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]);
    expect(planCode(() => selectReferenceImages(inspection({ counted: ["CP-001"], selected: ["CP-001"], files: [file("CP-001", "/private/a/big.png", big)] })))).toBe("REFERENCE_IMAGE_TOO_LARGE");
    expect(planCode(() => selectReferenceImages(inspection({ counted: ["CP-001"], selected: ["CP-001"], files: [{ ...file("CP-001", "/private/a/x.png", PNG), sha256: sha("other") }] })))).toBe("REFERENCE_IMAGE_SHA_MISMATCH");
  });
});

describe("Issue #335 review Low: the reference limit holds for every image call, before anything is staged", () => {
  it("generateImageOnce and the batch both refuse more than 5 input + reference pictures; nothing runs", async () => {
    const f = fakeCodex("six");
    const six = Array.from({ length: 6 }, (_, k) => colourPng(20 + k, 20));
    await expect(generateImageOnce({ sandbox: f.sandbox, prompt: "p", timeoutMs: 1_000, tmpBase: f.tmpBase, inputImages: six })).rejects.toThrow("at most 5 input and reference images");
    const refs = Array.from({ length: 3 }, (_, k) => ({ name: `ref-${k + 1}.png`, bytes: colourPng(30 + k, 20) }));
    const prompt = `refs ["${refs.map((r) => `${REFERENCE_DIR_TOKEN}/${r.name}`).join('", "')}"]`;
    await expect(generateImagesInOneRun({ sandbox: f.sandbox, prompt, timeoutMs: 1_000, tmpBase: f.tmpBase, maxImages: 2, inputImages: six.slice(0, 3), referenceImages: refs })).rejects.toThrow("at most 5 input and reference images");
    await expect(generateImageOnce({ sandbox: f.sandbox, prompt: "no token", timeoutMs: 1_000, tmpBase: f.tmpBase, referenceImages: refs })).rejects.toThrow("reference paths");
    await expect(generateImageOnce({ sandbox: f.sandbox, prompt, timeoutMs: 1_000, tmpBase: f.tmpBase, referenceImages: [...refs.slice(0, 2), { name: "ref-3.gif", bytes: refs[2]!.bytes }] })).rejects.toThrow("reference names");
    expect(f.execs).toBe(0);
  });
});

describe("DEV-303 §6.1 row 3 the run refuses a real_shop section split and references that are not the plan's", () => {
  const sectionPlan = () => {
    const fictional = parseRequest(bytesOf(requestObject({ kind: "fictional", layout: undefined, max_images: 6, case_study: undefined })), sha(bytesOf(requestObject({ kind: "fictional", layout: undefined, max_images: 6, case_study: undefined }))), ID).request as DesignRequest;
    return buildRequestPlan({ request: { ...fictional, kind: "real_shop" } as DesignRequest, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS });
  };
  const after: (() => void)[] = [];
  const call = (p: RequestPlan, references?: Parameters<typeof runRequestFullPageCall>[0]["references"]) => {
    const repo = tmp("sr-wp-repo-");
    const out = join(tmp("sr-wp-out-"), "run");
    const ledgerDir = join(tmp("sr-wp-ledger-"), "ledger");
    after.push(() => expect([existsSync(out), existsSync(ledgerDir)]).toEqual([false, false]));
    return runRequestFullPageCall(
      { plan: p, inputs: { factsBytes: FACTS_BYTES, directionBytes: bytesOf(DIRECTION) }, requestId: ID, requestSha256: "a".repeat(64), expected: { promptSha256: p.batch.sha256, promptChars: p.batch.chars, commit: "0".repeat(40), planSha256: p.plan_sha256 }, outDir: out, repoRoot: repo, ...(references ? { references } : {}) },
      { ledger: openLedger(ledgerDir), commit: async () => ({ head: "0".repeat(40), base: "0".repeat(40), clean: true }), batch: async () => Promise.reject(new Error("never")) },
    );
  };
  it("REAL_SHOP_WHOLE_PAGE_REQUIRED for a real_shop section plan; REFERENCE_IMAGES_MISMATCH unless the exact references come", async () => {
    expect(await call(sectionPlan())).toMatchObject({ status: "stopped", code: "REAL_SHOP_WHOLE_PAGE_REQUIRED", stage: "precheck" });
    const p = plan();
    expect(await call(p)).toMatchObject({ status: "stopped", code: "REFERENCE_IMAGES_MISMATCH", stage: "precheck" });
    const wrong = CS_USE.references.map((r) => ({ ...r, bytes: Buffer.from("not the bytes") }));
    expect(await call(p, wrong)).toMatchObject({ status: "stopped", code: "REFERENCE_IMAGES_MISMATCH" });
    // refused before anything: no run directory, no ledger
    for (const check of after.splice(0)) check();
  });
});

describe("DEV-303 §6.1 row 3 the comp check of a whole_page run: PC 1 + SP 1, one picture each", { timeout: 120_000 }, () => {
  const ALL = [{ id: "header", y0: 0, y1: 0.08 }, { id: "hero", y0: 0.08, y1: 0.4 }, { id: "story", y0: 0.4, y1: 0.65 }, { id: "info", y0: 0.65, y1: 0.92 }, { id: "footer", y0: 0.92, y1: 1 }];
  const SP_BANDS = [{ id: "header", y0: 0, y1: 0.06 }, { id: "hero", y0: 0.06, y1: 0.5 }, { id: "info", y0: 0.5, y1: 0.7 }, { id: "story", y0: 0.7, y1: 0.94 }, { id: "footer", y0: 0.94, y1: 1 }];
  const whole = (extra: Parameters<typeof makeRun>[0] = {}) =>
    makeRun({
      pictures: { "pc-01": drawPart(1024, 1536, ALL, "pc", 1), "sp-01": drawPart(1024, 1536, SP_BANDS, "sp", 2) },
      ...extra,
      mutate: (r) => {
        for (const v of ["desktop_1440", "mobile_390"] as const) {
          const c = r.viewports[v]!;
          r.viewports[v] = { target_css_width: c.target_css_width, mode: "whole_page", section_order: ["page"], parts: [{ ...c.parts[0]!, sections: [{ id: "page", box: { x: 0, y: 0, w: 1, h: 1 } }] }], seams: [] };
        }
        r.generation.image_calls = 2;
        r.generation.image_completed = 2;
        extra.mutate?.(r);
      },
      mutateRead: (read) => {
        for (const part of read.parts) {
          part.observed_section_ids = ["header", "hero", "story", "info", "footer"];
          part.header_visible = true;
          part.footer_visible = true;
          part.web_structure = { nav: true, text_blocks: true, info_block: true };
        }
        extra.mutateRead?.(read);
      },
    });
  const verdict = async (extra: Parameters<typeof makeRun>[0] = {}) => validateImageFirst(await readImageFirstRun(whole(extra).dir));

  it("every machine check holds with one 2:3 picture per viewport (the screen-height floors do not apply to a whole page)", async () => {
    const v = await verdict();
    expect(v.rejects, JSON.stringify(v.details)).toEqual([]);
    expect(v.status).toBe("AWAITING_OWNER_EVALUATION");
    expect(v.parts.map((x) => [x.viewport, x.index, x.width, x.height])).toEqual([
      ["desktop_1440", 1, 1024, 1536],
      ["mobile_390", 1, 1024, 1536],
    ]);
  });

  it("two pictures, a seam, another order, a mixed layout, a read without the page's sections or footer: refused", async () => {
    const twoParts = await verdict({ mutate: (r) => r.viewports.desktop_1440!.parts.push({ ...r.viewports.desktop_1440!.parts[0]!, index: 2 }) });
    expect(twoParts.rejects).toContain("COMP_SECTION_SEQUENCE_INVALID");
    expect(twoParts.details).toContainEqual({ code: "COMP_SECTION_SEQUENCE_INVALID", detail: "desktop_1440_MODE_PART_COUNT" });
    expect((await verdict({ mutate: (r) => (r.viewports.mobile_390!.section_order = ["hero"]) })).details).toContainEqual({ code: "COMP_SECTION_SEQUENCE_INVALID", detail: "mobile_390_WHOLE_PAGE_ORDER" });
    expect((await verdict({ mutate: (r) => (r.viewports.mobile_390!.parts[0]!.sections = [{ id: "page", box: { x: 0, y: 0, w: 1, h: 0.5 } }]) })).details).toContainEqual({ code: "COMP_SECTION_SEQUENCE_INVALID", detail: "mobile_390_WHOLE_PAGE_BOX" });
    expect((await verdict({ mutate: (r) => (r.viewports.mobile_390!.mode = "single") })).details).toContainEqual({ code: "COMP_SECTION_SEQUENCE_INVALID", detail: "layout_mixed" });
    expect((await verdict({ mutate: (r) => (r.generation.image_completed = 6) })).rejects).toContain("CODEX_IMAGE_COUNT_MISMATCH");
    expect((await verdict({ mutateRead: (read) => (read.parts[0]!.observed_section_ids = ["page"]) })).details).toContainEqual({ code: "COMP_HERO_ONLY", detail: "desktop_1440_sections_not_seen" });
    expect((await verdict({ mutateRead: (read) => (read.parts[1]!.footer_visible = false) })).details).toContainEqual({ code: "COMP_HERO_ONLY", detail: "mobile_390_no_footer" });
  });
});
