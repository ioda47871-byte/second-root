import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCompReview, type ReviewInputs } from "../../../../lib/design-agent/quality-pipeline/comp-review";
import { checkCopyRecord, CopyRecord, textsNotInRecord } from "../../../../lib/design-agent/quality-pipeline/copy-record";
import { checkReviewFile, insideRepo } from "../../../../scripts/design-artifact/comp-lane";

// DEV-159 (Issue #193): the comp lane. Every word a comp shows has a claim type and a source; Claude's review of the
// renders is tied to its own VISUAL_VERIFIED reads. A pass is never a quality verdict.

const REPO = resolve(__dirname, "../../../..");
const POC = join(REPO, "design-library/research/quality-pipeline/poc/tsugute");
const COMP = join(POC, "comps/d1-seam-across");
const factsRaw = readFileSync(join(POC, "facts-pack.json"));
const facts = JSON.parse(factsRaw.toString("utf8")) as { shop_id: string; facts: Array<{ id: string; key: string; value: string }> };
const factsOpts = { shopId: facts.shop_id, factsSha256: createHash("sha256").update(factsRaw).digest("hex"), facts: facts.facts };
const copy = () => JSON.parse(readFileSync(join(COMP, "copy.json"), "utf8"));
const copyCodes = (r: unknown) => checkCopyRecord(r, factsOpts).findings.map((f) => f.code);

describe("copy record (DEV-159, Issue #193 T5)", () => {
  it("the つぐ手 copy passes: facts come from the pack, creative lines carry no fact-like claim and wait for the owner", () => {
    expect(checkCopyRecord(copy(), factsOpts)).toEqual({ ok: true, findings: [] });
    const c = CopyRecord.parse(copy());
    expect(c.items.filter((i) => i.claim_type !== "fact").every((i) => i.owner_review_needed)).toBe(true);
  });

  it("a fact must be the pack's words (or a part of them); nothing may be added to it", () => {
    const r = copy();
    r.items.find((i: { id: string }) => i.id === "hours").text = "10:00〜18:00";
    expect(copyCodes(r)).toContain("FACT_TEXT_NOT_FROM_FACTS");
    const s = copy();
    s.items.find((i: { id: string }) => i.id === "month").source_fact_ids = [];
    expect(copyCodes(s)).toContain("FACT_WITHOUT_SOURCE");
    const t = copy();
    t.items.find((i: { id: string }) => i.id === "month").source_fact_ids = ["F99"];
    expect(copyCodes(t)).toEqual(expect.arrayContaining(["COPY_FACT_UNKNOWN"]));
  });

  it("creative lines may not invent facts: numbers, prices, history, awards, reputation, efficacy, stock", () => {
    for (const text of ["創業百年の技で直します", "受賞歴のある職人", "人気の工房", "料金は3000円から", "器が長持ちする効果", "予約は不要です", "伝統の技"]) {
      const r = copy();
      r.items.find((i: { id: string }) => i.id === "tagline").text = text;
      expect(copyCodes(r), text).toContain("CREATIVE_LOOKS_LIKE_FACT");
    }
  });

  it("creative copy needs the owner's review, belongs to the fictional research lane, and carries no label", () => {
    const r = copy();
    r.items.find((i: { id: string }) => i.id === "tagline").owner_review_needed = false;
    expect(copyCodes(r)).toContain("CREATIVE_WITHOUT_OWNER_REVIEW");
    const s = copy();
    s.lane = "real_shop_proposal";
    expect(copyCodes(s)).toContain("CREATIVE_OUTSIDE_RESEARCH_LANE");
    const t = copy();
    t.items.find((i: { id: string }) => i.id === "tagline").label = "見出し";
    expect(copyCodes(t)).toContain("LABEL_ON_NON_FACT");
    const u = copy();
    u.facts_sha256 = "0".repeat(64);
    u.shop_id = "other";
    expect(copyCodes(u)).toEqual(expect.arrayContaining(["COPY_FACTS_SHA_MISMATCH", "COPY_SHOP_MISMATCH"]));
  });

  it("a fact is the whole value, whole sentences of it, or a whole part of the name: nothing added, nothing cut mid-sentence (review H1/M2)", () => {
    for (const text of ["架空金継ぎ工房 つぐ手 創業百年、職人三代目", "評判の架空金継ぎ工房 つぐ手", "実在の工房", "金継", "修理には一か月ほど"]) {
      const r = copy();
      Object.assign(r.items.find((i: { id: string }) => i.id === "name-full"), { text, source_fact_ids: ["F1", "F9", "F10"] });
      expect(copyCodes(r), text).toContain("FACT_TEXT_NOT_FROM_FACTS");
    }
    // whole sentences (one or consecutive) and the name alone are fine
    for (const [text, id] of [["割れた器を漆でつなぎ、継ぎ目に金を蒔いて仕上げます。", "F9"], ["実在の工房ではありません。", "F9"], ["つぐ手", "F1"]] as const) {
      const r = copy();
      Object.assign(r.items.find((i: { id: string }) => i.id === "name-full"), { text, source_fact_ids: [id] });
      expect(copyCodes(r), text).toEqual([]);
    }
    // a full-width space does not make a sentence cuttable (round 2 M2)
    const f9 = facts.facts.find((x) => x.id === "F9")!;
    const spaced = { ...factsOpts, facts: factsOpts.facts.map((x) => (x.id === "F9" ? { ...f9, value: "実在の工房では\u3000ありません。" } : x)) };
    const cut = copy();
    Object.assign(cut.items.find((i: { id: string }) => i.id === "fictional"), { text: "実在の工房では", source_fact_ids: ["F9"] });
    expect(checkCopyRecord(cut, spaced).findings.map((x) => x.code)).toContain("FACT_TEXT_NOT_FROM_FACTS");
    // a soft hyphen in the copy is refused (round 4 M1)
    const shy = copy();
    shy.items.find((i: { id: string }) => i.id === "tagline").text = "割れたところに、金の\u00ad線を引く。";
    expect(copyCodes(shy)).toContain("COPY_SOFT_HYPHEN");
    // a label is taken from the fact the text matches, not from any extra source id (round 3 L1)
    const laundered = copy();
    Object.assign(laundered.items.find((i: { id: string }) => i.id === "name-full"), { text: "架空市架空区架空町一丁目3-2", source_fact_ids: ["F4", "F1"], label: "店名" });
    expect(copyCodes(laundered)).toContain("LABEL_NOT_ALLOWED");
    // a label belongs to its fact: 電話 on the name is refused (round 2 L4)
    const wrong = copy();
    wrong.items.find((i: { id: string }) => i.id === "name-full").label = "電話";
    expect(copyCodes(wrong)).toContain("LABEL_NOT_ALLOWED");
    // a label is shown on the page, so it comes from a fixed list
    const s = copy();
    s.items.find((i: { id: string }) => i.id === "address").label = "創業1920年・受賞";
    expect(copyCodes(s)).toContain("LABEL_NOT_ALLOWED");
  });

  it("creative lines are checked against every category the owner named (review M1), without tripping on ordinary words (L1)", () => {
    const owner = ["百年つづく継ぎの手", "三代続く", "半世紀の技", "昭和から続く", "江戸から続く", "伝統を守る", "匠の手で", "名工の手", "熟練の手仕事", "年中無休", "割れても保証します", "二度と割れない", "一生ものの器", "テレビで紹介された", "雑誌掲載", "歴史ある工房", "代々受け継がれた技", "職人の名前は田中です", "三代目の店主", "師匠から学んだ技", "本漆と純金だけで", "原材料にこだわる", "素材にこだわる", "季節のメニュー", "料金は応相談", "お客様に喜ばれる", "レビューで好評", "愛され続ける", "唯一無二", "最高の仕上がり", "表彰された技", "安心して使えます"];
    for (const text of owner) {
      const r = copy();
      r.items.find((i: { id: string }) => i.id === "tagline").text = text;
      expect(copyCodes(r), text).toContain("CREATIVE_LOOKS_LIKE_FACT");
    }
    for (const text of ["器と過ごす時間", "想いをお届けします", "割れた線は、器のいちばん新しい景色になる。", "たくさんの器", "みなさんの器", "代表作のような一枚", "素材感のある線", "一時の割れ"]) {
      const r = copy();
      r.items.find((i: { id: string }) => i.id === "tagline").text = text;
      expect(copyCodes(r), text).toEqual([]);
    }
  });

  it("a page may show only the record's texts and labels", () => {
    const c = CopyRecord.parse(copy());
    expect(textsNotInRecord(["つぐ手", "所在地", " 架空市架空区架空町一丁目3-2 "], c)).toEqual([]);
    expect(textsNotInRecord(["つぐ手", "創業百年"], c)).toEqual(["創業百年"]);
  });
});

describe("Claude's review of the comp renders (DEV-159)", () => {
  const review = () => JSON.parse(readFileSync(join(COMP, "review.json"), "utf8"));
  const base: ReviewInputs = (() => {
    const learn = (p: string) => (JSON.parse(readFileSync(join(REPO, p), "utf8")) as { observation: { learn: string[] } }).observation.learn;
    const R = "design-library/research/quality-pipeline/visual-reads/";
    const sha = (f: string) => createHash("sha256").update(readFileSync(join(COMP, f))).digest("hex");
    return {
      renders: null,
      verifiedReads: Object.fromEntries(["CP-001/concept", "CP-002/concept", "CP-003/desktop", "CP-003/mobile"].map((k) => [`${R}${k}.read.json`, learn(`${R}${k}.read.json`)])),
      failureCodes: ["IMAGE_TYPE_RELATION_WEAK", "READABLE_BUT_FLAT"],
      comp: { html_sha256: sha("index.html"), css_sha256: sha("style.css"), copy_sha256: sha("copy.json") },
    };
  })();
  const codes = (r: unknown, o: ReviewInputs = base) => checkCompReview(r, o).codes;

  it("the committed review passes against this comp and Claude's VISUAL_VERIFIED reads, and its verdict is to revise", () => {
    expect(checkReviewFile(COMP)).toEqual({ ok: true, codes: [] });
    expect(review().verdict).toBe("revise");
    expect(review().remaining.length).toBeGreaterThan(0);
  });

  it("references must be Claude's VISUAL_VERIFIED reads, quoting their own learn lines", () => {
    const r = review();
    r.references[0].read = "design-library/research/quality-pipeline/visual-reads/CP-009/desktop.read.json";
    expect(codes(r)).toContain("REFERENCE_NOT_VISUAL_VERIFIED");
    const s = review();
    s.references[0].learn = "ChatGPT の要約: 豆の弧が良い";
    expect(codes(s)).toContain("REFERENCE_LEARN_NOT_IN_READ");
  });

  it("the review must be of this comp, cover the renders, and place its observations over them", () => {
    expect(codes(review(), { ...base, comp: { ...base.comp, css_sha256: "0".repeat(64) } })).toContain("REVIEW_OF_ANOTHER_COMP");
    const r = review();
    r.viewed_crops.mobile = [{ x: 0, y: 0, w: 390, h: 1308 }];
    expect(codes(r)).toContain("CROPS_DO_NOT_COVER_MOBILE");
    const s = review();
    for (const o of s.observations.desktop) o.box = { ...o.box, y: 10, h: 40 };
    expect(codes(s)).toContain("OBSERVATIONS_NOT_SPREAD_DESKTOP");
    const t = review();
    expect(codes(t, { ...base, renders: { desktop: { ...t.renders.desktop, sha256: "a".repeat(64) }, mobile: t.renders.mobile } })).toContain("RENDER_MISMATCH_DESKTOP");
  });

  it("at most 2 rounds, in order; no quality verdict; known failure codes only", () => {
    const r = review();
    r.rounds.push({ ...r.rounds[1], n: 3 });
    expect(codes(r)).toEqual(["REVIEW_SCHEMA"]);
    const s = review();
    s.verdict = "success";
    expect(codes(s)).toEqual(["REVIEW_SCHEMA"]);
    const t = review();
    t.rounds.reverse();
    expect(codes(t)).toContain("ROUNDS_OUT_OF_ORDER");
    const u = review();
    u.failure_codes = ["LOOKS_GREAT"];
    expect(codes(u)).toContain("FAILURE_CODE_UNKNOWN");
  });

  it("renders are 1440 and 390 wide and at least one screen tall; show_owner may not carry a known failure (review H3/M3)", () => {
    const r = review();
    r.renders.desktop.height = 100;
    r.viewed_crops.desktop = [{ x: 0, y: 0, w: 1440, h: 100 }];
    expect(codes(r)).toEqual(["REVIEW_SCHEMA"]);
    const s = review();
    s.renders.mobile.width = 400;
    expect(codes(s)).toEqual(["REVIEW_SCHEMA"]);
    const t = review();
    t.verdict = "show_owner";
    expect(codes(t)).toContain("SHOW_WITH_KNOWN_FAILURE");
    t.failure_codes = [];
    expect(codes(t)).not.toContain("SHOW_WITH_KNOWN_FAILURE");
    // never shown without at least one round of critique
    t.rounds = [];
    expect(codes(t)).toContain("SHOW_WITHOUT_A_ROUND");
  });

  it("the CLI checks and renders the comp offline (copy, safety, unrecorded text, PC/SP) and checks the review", () => {
    const cli = join(REPO, "scripts/design-artifact/comp-lane.ts");
    const out = mkdtempSync(join(tmpdir(), "comp-"));
    const r = JSON.parse(execFileSync("npx", ["tsx", cli, "--dir", COMP, "--facts", join(POC, "facts-pack.json"), "--out", out], { encoding: "utf8" })) as {
      status: string;
      renders: Record<string, { width: number }>;
    };
    expect(r.status).toBe("OK");
    // the review is checked against these renders; its structure must hold, the bytes may differ by machine (fonts)
    expect((r as unknown as { review: { structural_ok: boolean } }).review.structural_ok).toBe(true);
    expect(r.renders.desktop_1440!.width).toBe(1440);
    expect(r.renders.mobile_390!.width).toBe(390);
    expect(JSON.parse(execFileSync("npx", ["tsx", cli, "--check-review", COMP], { encoding: "utf8" }))).toEqual({ ok: true, codes: [] });
    // words put on the page by CSS or attributes are caught (review H2); renders inside the repository are refused (L4)
    const probe = mkdtempSync(join(tmpdir(), "comp-probe-"));
    cpSync(COMP, probe, { recursive: true });
    writeFileSync(join(probe, "index.html"), readFileSync(join(probe, "index.html"), "utf8").replace('<p class="lead">', '<p class="lead" title="受賞歴あり">'));
    writeFileSync(
      join(probe, "style.css"),
      `${readFileSync(join(probe, "style.css"), "utf8")}
.tagline::after { content: "創業百年・日本一"; }
.lead::after { CONTENT: "upper"; }
.how::after { cont\\65nt: "escaped"; }
.how::before { content: attr(data-x); }
.hero-copy { quotes: "創業百年" ""; }
.info { list-style-type: "創業 "; }
.class-fact::after { content: counter(y); }
@media (min-width: 1px) { .month-c::after { content: "in media"; } }
@counter-style probe { system: cyclic; symbols: "a"; }
`,
    );
    writeFileSync(join(probe, "index.html"), readFileSync(join(probe, "index.html"), "utf8").replace("</main>", '<ol start="1926"></ol></main>'));
    let failed: { status: string; findings: Array<{ code: string; detail?: string }> } | null = null;
    try {
      execFileSync("npx", ["tsx", cli, "--dir", probe, "--facts", join(POC, "facts-pack.json"), "--out", mkdtempSync(join(tmpdir(), "comp-"))], { encoding: "utf8" });
    } catch (e) {
      failed = JSON.parse((e as { stdout: string }).stdout);
    }
    expect(failed?.status).toBe("FAIL");
    expect(failed?.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["COMP_CSS_CONTENT_TEXT", "COMP_TEXT_NOT_IN_COPY"]));
    const css = failed!.findings.filter((f) => f.code === "COMP_CSS_CONTENT_TEXT").map((f) => f.detail ?? "");
    for (const needle of ["創業百年・日本一", "upper", "escaped", "attr(data-x)", "quotes", "list-style-type", "counter(y)", "in media", "@counter-style"])
      expect(css.some((d) => d.includes(needle)), needle).toBe(true);
    expect(failed!.findings.filter((f) => f.code === "COMP_TEXT_NOT_IN_COPY").map((f) => f.detail)).toEqual(expect.arrayContaining(["受賞歴あり", "1926"]));
    // round 3: a shadow tree, an unquoted link, and a script (which stops the run before anything is opened again)
    const run = (mutate: (html: string) => string, css = "") => {
      const dir = mkdtempSync(join(tmpdir(), "comp-probe-"));
      cpSync(COMP, dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), mutate(readFileSync(join(dir, "index.html"), "utf8")));
      if (css) writeFileSync(join(dir, "style.css"), `${readFileSync(join(dir, "style.css"), "utf8")}\n${css}\n`);
      try {
        return { code: 0, out: JSON.parse(execFileSync("npx", ["tsx", cli, "--dir", dir, "--facts", join(POC, "facts-pack.json"), "--out", mkdtempSync(join(tmpdir(), "comp-"))], { encoding: "utf8" })) };
      } catch (e) {
        return { code: (e as { status: number }).status, out: JSON.parse((e as { stdout: string }).stdout) };
      }
    };
    const shadow = run((h) => h.replace("</main>", '<div><template shadowrootmode="open"><p>創業百年の老舗</p></template></div></main>'));
    expect(shadow.code).toBe(1);
    expect(shadow.out.findings.map((f: { detail?: string }) => f.detail ?? "").join("|")).toMatch(/shadow root or <template>/);
    const unquoted = run((h) => h.replace('<link rel="stylesheet" href="style.css">', "<link rel=stylesheet href=style.css>"), '.hero::after { content: "創業百年"; }');
    expect(unquoted.code).toBe(1);
    expect(unquoted.out.findings.map((f: { detail?: string }) => f.detail ?? "").join("|")).toContain("創業百年");
    const script = run((h) => h.replace("</main>", "<script>document.title = 'x'</script></main>"));
    expect(script.code).toBe(1);
    expect(script.out.findings.map((f: { code: string }) => f.code)).toEqual(["PROTOTYPE_UNSAFE"]);
    expect(script.out.renders).toBeUndefined();
    // round 4: closed and upper-case shadow roots, hyphenation characters, counters, emphasis marks, browser captions
    for (const tpl of ['<template shadowrootmode="closed"><p>日本一の名工</p></template>', '<template SHADOWROOTMODE="CLOSED"><p>x</p></template>']) {
      const r = run((h) => h.replace("</main>", `<div>${tpl}</div></main>`));
      expect(r.code, tpl).toBe(1);
      expect(r.out.findings.map((f: { detail?: string }) => f.detail ?? "").join("|"), tpl).toMatch(/template/);
    }
    const css4 = run(
      (h) => h.replace("</main>", '<input type="submit"><details><p>x</p></details></main>').replace("線の終わりは、ここ。", "線\u00adの終わりは、ここ。"),
      `.visit-h { hyphenate-character: "日本一の名工"; }\n.info { counter-set: list-item 100; }\n.tagline { text-emphasis-style: "百"; }`,
    );
    expect(css4.code).toBe(1);
    const d4 = css4.out.findings.map((f: { detail?: string }) => f.detail ?? "").join("|");
    for (const needle of ["hyphenate-character", "counter-set", "text-emphasis", "soft hyphen", "input type=submit", "details without summary"]) expect(d4, needle).toContain(needle);
    // round 5: var() is resolved before the check (list markers, emphasis marks), and date inputs write their own text
    const viaVar = run(
      (h) => h.replace("</main>", '<ul class="zz"><li>割れの修理</li></ul><input type="date"></main>'),
      `.zz { --m: "日本一の名工・創業百年 "; list-style-type: var(--m); }\n.tagline { --e: "百"; text-emphasis: var(--e) red; }`,
    );
    expect(viaVar.code).toBe(1);
    const d5 = viaVar.out.findings.map((f: { detail?: string }) => f.detail ?? "").join("|");
    for (const needle of ["list-style-type", "text-emphasis", "input type=date"]) expect(d5, needle).toContain(needle);
    // an SVG <style> is a style sheet, not page text (no false COMP_TEXT_NOT_IN_COPY)
    const svgStyle = run((h) => h.replace("</main>", "<svg><style>.q { fill: #000; }</style></svg></main>"));
    expect(svgStyle.out.findings.filter((f: { code: string }) => f.code === "COMP_TEXT_NOT_IN_COPY")).toEqual([]);
    // renders inside the repository are refused, however the path is spelled (L4, round 2 L1)
    for (const out of [join(REPO, "tmp-renders"), join(REPO, "..renders"), "tmp-renders"]) {
      let code = 0;
      try {
        execFileSync("npx", ["tsx", cli, "--dir", COMP, "--facts", join(POC, "facts-pack.json"), "--out", out], { encoding: "utf8", stdio: "pipe", cwd: REPO });
      } catch (e) {
        code = (e as { status: number }).status;
      }
      expect(code, out).toBe(2);
    }
    expect(insideRepo(join(REPO, "..renders"))).toBe(true);
    expect(insideRepo(join(tmpdir(), "x"))).toBe(false);
  }, 240_000);

});
