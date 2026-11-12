import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCopyRecord } from "@/lib/design-agent/quality-pipeline/copy-record";
import { pageText } from "@/lib/design-agent/quality-pipeline/copy-quality-page";
import {
  ALLOWED_SEVERITIES,
  checkCopyQualityReview,
  copyGateSendBlockers,
  copyReviewAppendBlockers,
  factsContentSha256,
  CopyQualityReview,
  genericSignals,
  isSloganShaped,
  MAX_COPY_REVISION_ROUNDS,
  nextCopyStep,
  reviewCopyQuality,
  shopContext,
  styleAndInformationFindings,
  unsourcedClaimSigns,
  validateCopyRevision,
  type AuditEntry,
  type CopyQualityFiles,
  type OwnerCopyApproval,
} from "@/lib/design-agent/quality-pipeline/copy-quality-review";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import * as fx from "./copy-quality-fixtures";

// DEV-199a (Issue #258, spec PR #257 and its review rules M2/M3/M5/L1–L6). Unit only: synthetic shops and 輪's
// committed research files read as immutable fixtures. No network, no model.

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const codes = (r: CopyQualityReview) => [...new Set(r.findings.map((f) => f.code))].sort();
const rules = (r: CopyQualityReview) => r.findings.map((f) => f.rule);

const RIN_COPY = `${fx.RIN_DIR}/fidelity/d1-v9/copy.json`;
const RIN_HTML = `${fx.RIN_DIR}/fidelity/d1-v9/index.html`;
const RIN_CSS = `${fx.RIN_DIR}/fidelity/d1-v9/style.css`;
// the committed bytes as recorded when DEV-199a was written: this test fails if anyone changes 輪's research files
const RIN_SHA = {
  facts: "b4c720a4a51fb9d142e581db587bdfa46b8914fcf0c89a9a4e59e6a5f9f9c3fc",
  copy: "0dad2a649de3e60936deb004c8135ad69610464b80902a4cbc9fefd45c658780",
  html: "de7ccbc2469f4e14c0db5cae6cf39c5b5a34a6c03ca7b685a6304dc0460e4503",
};
const rinFiles = (): CopyQualityFiles => ({
  factsPack: fx.rinFile("facts-pack.json"),
  copyRecord: readFileSync(resolve(fx.REPO, RIN_COPY)),
  pageHtml: readFileSync(resolve(fx.REPO, RIN_HTML)),
  pageCss: readFileSync(resolve(fx.REPO, RIN_CSS)),
});

describe("SR-001「輪」 as an immutable fixture", () => {
  it("the research files are the committed bytes (read only)", () => {
    const f = rinFiles();
    expect(sha(f.factsPack)).toBe(RIN_SHA.facts);
    expect(sha(f.copyRecord)).toBe(RIN_SHA.copy);
    expect(sha(f.pageHtml)).toBe(RIN_SHA.html);
  });

  it("passes the existing checks, and the ACCUMULATION of slogan headings gives REVISE", () => {
    const r = reviewCopyQuality(rinFiles());
    expect(r.base_checks).toEqual({ ok: true, codes: [] });
    expect(r.verdict).toBe("revise");
    expect(codes(r)).toEqual(["COPY_REPETITIVE_CADENCE", "COPY_RHETORICAL_OVERUSE"]);
    const overuse = r.findings.find((f) => f.code === "COPY_RHETORICAL_OVERUSE")!;
    for (const line of ["スポークの先に、修理がある。", "一本ずつ。", "空気を入れる日。", "一周して、店先へ。"]) expect(overuse.texts).toContain(line);
    // the hero's one strong line is not counted in the accumulation
    expect(overuse.texts).not.toContain("まがった車輪も、まっすぐに。");
    expect(overuse.evidence.some((e) => e.startsWith("hero line not counted") && e.includes("まがった車輪も、まっすぐに。"))).toBe(true);
    expect(r.axes.restraint_consistency.score).toBe(0);
    expect(r.axes.fact_correctness.score).toBe(5);
  });

  it("L4: 「一本ずつ。」 is sourced to F10; only the page-level accumulation is reported, never a finding on that line", () => {
    const r = reviewCopyQuality(rinFiles());
    const entry = r.sections.flatMap((s) => s.entries).find((e) => e.text === "一本ずつ。")!;
    expect(entry.kind).toBe("prose");
    for (const f of r.findings) {
      expect(f.location).toBeNull();
      expect(f.texts.length).toBeGreaterThan(1);
    }
    expect(r.findings.some((f) => f.location?.section === entry.position.section && f.location.entry === entry.position.entry)).toBe(false);
  });

  it("with only the hero line 「まがった車輪も、まっすぐに。」 and plain informative sections: no rhetorical overuse", () => {
    const r = reviewCopyQuality(fx.bicycleGood());
    expect(r.sections.flatMap((s) => s.entries).some((e) => e.text === "まがった車輪も、まっすぐに。" && e.kind === "prose")).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe("approve_candidate");
  });

  it("L5: sections and roles come from the page DOM (data-comp-section, heading elements, dt, aria-hidden)", () => {
    const { sections, otherTexts } = pageText(readFileSync(resolve(fx.REPO, RIN_HTML), "utf8"));
    expect(sections.map((s) => s.section_id)).toEqual(["_page", "hero", "spokes", "truing", "check", "lesson", "visit"]);
    const truing = sections.find((s) => s.section_id === "truing")!;
    expect(truing.entries.map((e) => [e.role, e.text])).toEqual([
      ["heading", "一本ずつ。"],
      ["body", "振れ取りでは、スポークを一本ずつ締めて車輪をまっすぐにします"],
      ["decoration", "締める"],
    ]);
    expect(sections[0]!.entries.filter((e) => e.role === "label").map((e) => e.text)).toEqual(["電話", "時間", "定休", "所在地"]);
    expect(otherTexts).toEqual(["架空自転車修理 輪"]);
  });
});

describe("sourced and unsourced claims", () => {
  it("「クロワッサンは毎朝焼きます。」 is allowed when the bakery's facts pack sources it", () => {
    const r = reviewCopyQuality(fx.bakeryGood());
    expect(r.verdict).toBe("approve_candidate");
    expect(r.sections.flatMap((s) => s.entries).find((e) => e.text === "クロワッサンは毎朝焼きます。")!.kind).toBe("fact");
  });

  const unsourcedFacts = fx.bakeryFacts({ withCroissantSentence: false });
  const unsourced = (claim: "fact" | "creative_expression") => {
    const items = (fx.bakeryGood().record.items as fx.Item[]).map((i) =>
      i.id === "croissant-how" ? (claim === "fact" ? fx.fact(i.id, i.text, [fx.idOf(unsourcedFacts, "product_1")]) : fx.creative(i.id, i.text)) : i,
    );
    return fx.shopFiles({ facts: unsourcedFacts, items, sections: [{ id: "hero", blocks: [["h1", "name"], ["p", "name-full"], ["p", "tagline"]] }, { id: "croissant", blocks: [["h2", "croissant"], ["p", "croissant-how"]] }, { id: "bread", blocks: [["h2", "bread"], ["p", "bread-how"]] }] });
  };

  it("without a source, written as a fact: the copy-record check fails and the audit is FAIL (the existing failure, not a softer code)", () => {
    const r = reviewCopyQuality(unsourced("fact"));
    expect(r.base_checks.ok).toBe(false);
    expect(r.base_checks.codes).toContain("FACT_TEXT_NOT_FROM_FACTS");
    expect(r.findings[0]).toMatchObject({ code: "COPY_FACT_UNSUPPORTED", severity: "fail", rule: "base_check" });
    expect(r.verdict).toBe("fail");
    expect(r.axes.fact_correctness.score).toBe(0);
  });

  it("without a source, written as creative copy (which the copy-record tripwire lets through): HOLD on the fact path", () => {
    const r = reviewCopyQuality(unsourced("creative_expression"));
    expect(r.base_checks.ok).toBe(true);
    const f = r.findings.find((x) => x.rule === "claim_sign_outside_facts")!;
    expect(f).toMatchObject({ code: "COPY_FACT_UNSUPPORTED", severity: "hold", texts: ["クロワッサンは毎朝焼きます。"] });
    expect(f.evidence.join(" ")).toContain("routine_or_frequency");
    expect(r.verdict).toBe("hold");
  });

  // review M4: HOLD only for claim-like signs; hospitality lines raise nothing on the fact path
  const withProse = (lines: string[]) => {
    const g = fx.bakeryGood();
    const extra = lines.map((t, i) => fx.creative(`extra-${i}`, t));
    return fx.shopFiles({
      facts: fx.bakeryFacts(),
      items: [...(g.record.items as fx.Item[]), ...extra],
      sections: [
        { id: "hero", blocks: [["h1", "name"], ["p", "name-full"], ["p", "tagline"]] },
        { id: "croissant", blocks: [["h2", "croissant"], ["p", "croissant-how"], ...extra.map((e) => ["p", e.id] as fx.Block)] },
        { id: "bread", blocks: [["h2", "bread"], ["p", "bread-how"]] },
        { id: "info", blocks: [["dt", "hours", "label"], ["dd", "hours"], ["dt", "address", "label"], ["dd", "address"]] },
      ],
    });
  };
  it.each(["ご来店をお待ちしております。", "焼き上がりの時間は店頭でお知らせします。", "お気軽にお立ち寄りください。"])("M4: the hospitality line 「%s」 does not HOLD", (line) => {
    const r = reviewCopyQuality(withProse([line]));
    expect(r.base_checks.ok).toBe(true);
    expect(r.findings.filter((f) => f.code === "COPY_FACT_UNSUPPORTED")).toEqual([]);
    expect(r.verdict).not.toBe("hold");
  });
  it("M4: a claim-like unsourced line still HOLDs (a making method the facts do not hold)", () => {
    const r = reviewCopyQuality(withProse(["パンは自家製の酵母で焼きます。"]));
    expect(r.findings.find((f) => f.code === "COPY_FACT_UNSUPPORTED")).toMatchObject({ severity: "hold", rule: "claim_sign_outside_facts", texts: ["パンは自家製の酵母で焼きます。"] });
    expect(r.verdict).toBe("hold");
  });

  it("a base failure is never rated better: a page with good style but a broken copy record is FAIL", () => {
    const f = fx.bakeryGood();
    const broken = { ...f, copyRecord: JSON.stringify({ ...f.record, facts_sha256: "0".repeat(64) }) };
    const r = reviewCopyQuality(broken);
    expect(r.base_checks.codes).toContain("COPY_FACTS_SHA_MISMATCH");
    expect(r.verdict).toBe("fail");
    expect(nextCopyStep(r)).toBe("stop_fail");
  });

  it("a page text missing from the record (UNVERIFIED_COPY) and an unparsable facts pack are FAIL", () => {
    const f = fx.bakeryGood();
    expect(reviewCopyQuality({ ...f, pageHtml: String(f.pageHtml).replace("</main>", "<p>焼きたてです</p></main>") }).base_checks.codes).toContain("UNVERIFIED_COPY");
    const bad = reviewCopyQuality({ ...f, factsPack: "{" });
    expect(bad.base_checks.codes).toContain("FACTS_PACK_INVALID");
    expect(bad.verdict).toBe("fail");
  });
});

describe("genericness", () => {
  it.each([
    ["beauty salon", fx.salonCliche()],
    ["cafe", fx.cafeCliche()],
    ["seitai", fx.seitaiCliche()],
  ])("%s copy filled with 「こだわりの」「特別なひととき」 is flagged generic", (_n, f) => {
    const r = reviewCopyQuality(f);
    const g = r.findings.find((x) => x.code === "COPY_GENERIC_FOR_SHOP")!;
    expect(g.severity).toBe("revise");
    expect(g.texts.some((t) => t.includes("こだわり"))).toBe(true);
    expect(g.texts.some((t) => t.includes("特別なひととき"))).toBe(true);
    expect(r.verdict).toBe("revise");
  });

  it("M3: with no material in the facts pack, generic copy is HOLD (no specifics may be invented)", () => {
    const r = reviewCopyQuality(fx.salonCliche({ withServices: false }));
    expect(r.findings.find((x) => x.code === "COPY_GENERIC_FOR_SHOP")).toMatchObject({ severity: "hold", rule: "generic_lines_no_material" });
    expect(r.verdict).toBe("hold");
  });

  it("plain メニュー / アクセス / 営業時間 headings are not penalised, even as prose", () => {
    const facts = FactsPack.parse(JSON.parse(fx.cafeFacts()));
    const e = (section_id: string, s: number, role: AuditEntry["role"], text: string, kind: AuditEntry["kind"]): AuditEntry => ({ section_id, role, text, kind, item: null, position: { section: s, entry: 0 } });
    const entries = [e("hero", 0, "heading", "ほとり", "fact"), e("menu", 1, "heading", "メニュー", "prose"), e("menu", 1, "body", "ブレンドコーヒー", "fact"), e("access", 2, "heading", "アクセス", "prose"), e("access", 2, "body", "架空線架空駅 北口から徒歩4分", "fact"), e("hours", 3, "heading", "営業時間", "prose"), e("hours", 3, "body", "8:00〜18:00", "fact")];
    const out = styleAndInformationFindings(entries, shopContext(facts.facts), "quality_research_fictional");
    expect(out.findings.filter((f) => f.code !== "COPY_INFORMATION_MISSING")).toEqual([]);
    for (const t of ["メニュー", "アクセス", "営業時間"]) expect(isSloganShaped(t)).toBe(false);
  });

  it("L3/L6: labels in the full pipeline (営業時間 / 定休日 / 住所 / アクセス, also as a heading) never trip cadence or genericness", () => {
    const r = reviewCopyQuality(fx.cafeGood());
    const labels = r.sections.flatMap((s) => s.entries).filter((x) => x.kind === "label").map((x) => x.text);
    expect(labels).toEqual(["アクセス", "営業時間", "定休日", "住所", "アクセス"]);
    expect(r.findings).toEqual([]);
  });

  it("a generic phrase alone decides nothing: a line naming the shop's own facts is not generic", () => {
    const c = shopContext(FactsPack.parse(JSON.parse(fx.cafeFacts())).facts);
    expect(genericSignals("こだわりのブレンドコーヒー")).toEqual(["こだわり"]);
    const e: AuditEntry[] = [0, 1, 2].map((i) => ({ section_id: `s${i}`, role: "body", text: i ? "こだわりのブレンドコーヒー" : "ほとり", kind: i ? "prose" : "fact", item: null, position: { section: i, entry: 0 } }));
    expect(styleAndInformationFindings(e, c, "quality_research_fictional").findings.filter((f) => f.code === "COPY_GENERIC_FOR_SHOP")).toEqual([]);
  });
});

describe("plain copy is not penalised", () => {
  it.each([
    ["bakery", fx.bakeryGood()],
    ["beauty salon (no tagline at all)", fx.salonGood()],
    ["cafe", fx.cafeGood()],
    ["bicycle repair", fx.bicycleGood()],
  ])("%s: short, plain, sourced copy is approve_candidate with high axis scores", (_n, f) => {
    const r = reviewCopyQuality(f);
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe("approve_candidate");
    for (const a of Object.values(r.axes)) expect(a.score).toBeGreaterThanOrEqual(4);
  });
});

describe("industry spread: good / AI cliché / facts missing", () => {
  const table: Array<[string, () => number, () => ReturnType<typeof fx.shopFiles>, () => ReturnType<typeof fx.shopFiles>, () => ReturnType<typeof fx.shopFiles>]> = [
    ["bakery", () => 0, fx.bakeryGood, fx.bakeryCliche, fx.bakeryMissing],
    ["beauty salon", () => 0, fx.salonGood, () => fx.salonCliche(), fx.salonMissing],
    ["cafe", () => 0, fx.cafeGood, fx.cafeCliche, fx.cafeMissing],
    ["bicycle repair", () => 0, fx.bicycleGood, fx.bicycleCliche, fx.bicycleMissing],
  ];
  it.each(table)("%s", (_n, _x, good, cliche, missing) => {
    for (const f of [good(), cliche(), missing()]) {
      // L3: every fixture passes the existing copy-record check unchanged
      const pack = FactsPack.parse(JSON.parse(String(f.factsPack)));
      expect(checkCopyRecord(f.record, { shopId: pack.shop_id, factsSha256: sha(f.factsPack), facts: pack.facts })).toEqual({ ok: true, findings: [] });
    }
    expect(reviewCopyQuality(good()).verdict).toBe("approve_candidate");
    const c = reviewCopyQuality(cliche());
    expect(c.verdict).toBe("revise");
    expect(codes(c)).toEqual(expect.arrayContaining(["COPY_RHETORICAL_OVERUSE", "COPY_REPETITIVE_CADENCE", "COPY_GENERIC_FOR_SHOP"]));
    const m = reviewCopyQuality(missing());
    expect(m.verdict).toBe("hold");
    expect(m.findings.filter((f) => f.severity === "hold").every((f) => f.code === "COPY_INFORMATION_MISSING" && f.rule.startsWith("facts_missing_"))).toBe(true);
  });

  it("facts in the pack but left off the page is REVISE, not HOLD", () => {
    const f = fx.cafeGood();
    const items = (f.record.items as fx.Item[]).filter((i) => !["hours", "closed"].includes(i.id));
    const r = reviewCopyQuality(fx.shopFiles({ facts: fx.cafeFacts(), items, sections: [{ id: "hero", blocks: [["h1", "name"], ["p", "name-full"], ["p", "tagline"]] }, { id: "coffee", blocks: [["h2", "coffee"], ["p", "roast"]] }, { id: "info", blocks: [["dt", "address", "label"], ["dd", "address"], ["dt", "access", "label"], ["dd", "access"]] }] }));
    expect(r.findings).toEqual([expect.objectContaining({ code: "COPY_INFORMATION_MISSING", severity: "revise", rule: "copy_omits_hours" })]);
    expect(r.verdict).toBe("revise");
  });
});

describe("voice", () => {
  it("a plain-form prose sentence on a polite page is COPY_VOICE_UNNATURAL (REVISE), located on that line", () => {
    const f = fx.bakeryGood();
    const items = [...(f.record.items as fx.Item[]), fx.creative("plain", "焼きたてを毎朝並べる。")];
    const r = reviewCopyQuality(fx.shopFiles({ facts: fx.bakeryFacts(), items, sections: [{ id: "hero", blocks: [["h1", "name"], ["p", "name-full"], ["p", "tagline"]] }, { id: "croissant", blocks: [["h2", "croissant"], ["p", "croissant-how"], ["p", "plain"]] }, { id: "bread", blocks: [["h2", "bread"], ["p", "bread-how"]] }, { id: "info", blocks: [["dt", "hours", "label"], ["dd", "hours"], ["dt", "address", "label"], ["dd", "address"]] }] }));
    expect(r.findings).toEqual([expect.objectContaining({ code: "COPY_VOICE_UNNATURAL", rule: "plain_form_on_polite_page", texts: ["焼きたてを毎朝並べる。"], location: { section: 1, entry: 2 } })]);
    expect(r.verdict).toBe("revise");
  });
});

describe("M5: lanes", () => {
  it("real-shop lane: always COPY_APPROVAL_MISSING (HOLD), even with facts and labels only", () => {
    const r = reviewCopyQuality(fx.realShop());
    expect(r.lane).toBe("real_shop_proposal");
    expect(r.findings).toEqual([expect.objectContaining({ code: "COPY_APPROVAL_MISSING", severity: "hold" })]);
    expect(r.verdict).toBe("hold");
  });

  it("real-shop lane: prose is proposal_pending_review, never judged for style as the shop's words, and HOLD", () => {
    const r = reviewCopyQuality(fx.realShop({ prose: ["こだわりの朝を、あなたに。", "特別なひとときを。", "心を込めて、毎日。"] }));
    expect(codes(r)).toEqual(["COPY_APPROVAL_MISSING", "COPY_INFORMATION_MISSING"]);
    expect(r.findings.find((f) => f.code === "COPY_APPROVAL_MISSING")!.texts).toEqual(["こだわりの朝を、あなたに。", "特別なひとときを。", "心を込めて、毎日。"]);
    expect(r.verdict).toBe("hold");
  });

  it("a record claiming the real-shop lane without COPY_APPROVAL_MISSING does not parse", () => {
    const r = reviewCopyQuality(fx.realShop());
    expect(CopyQualityReview.safeParse({ ...r, findings: [], verdict: "approve_candidate", unresolved: [] }).success).toBe(false);
  });
});

describe("L1: hash binding", () => {
  it("a review is valid for exactly the files it was made against", () => {
    const f = fx.bakeryGood();
    const r = reviewCopyQuality(f);
    expect(r).toMatchObject({ facts_sha256: sha(f.factsPack), copy_sha256: sha(f.copyRecord), page_html_sha256: sha(f.pageHtml), page_css_sha256: sha(f.pageCss), auditor_version: "copy_quality_rules_v1" });
    expect(checkCopyQualityReview(r, f)).toEqual({ ok: true, codes: [] });
  });

  it("changing the copy record (its sha256) invalidates the review; so do the facts, the HTML and the CSS", () => {
    const f = fx.bakeryGood();
    const r = reviewCopyQuality(f);
    expect(checkCopyQualityReview(r, { ...f, copyRecord: `${String(f.copyRecord)} ` }).codes).toContain("REVIEW_STALE_COPY");
    expect(checkCopyQualityReview(r, { ...f, factsPack: `${String(f.factsPack)} ` }).codes).toContain("REVIEW_STALE_FACTS");
    expect(checkCopyQualityReview(r, { ...f, pageHtml: `${String(f.pageHtml)} ` }).codes).toContain("REVIEW_STALE_PAGE_HTML");
    expect(checkCopyQualityReview(r, { ...f, pageCss: "body{margin:1px}\n" }).codes).toContain("REVIEW_STALE_PAGE_CSS");
  });

  it("an old PASS cannot be reused for a new page, and a hand-edited PASS does not match the re-run audit", () => {
    const good = reviewCopyQuality(fx.bakeryGood());
    const cliche = fx.bakeryCliche();
    const reused = checkCopyQualityReview(good, cliche);
    expect(reused.ok).toBe(false);
    expect(reused.codes).toEqual(expect.arrayContaining(["REVIEW_STALE_COPY", "REVIEW_STALE_PAGE_HTML", "REVIEW_DOES_NOT_MATCH_AUDIT"]));
    const forged = { ...reviewCopyQuality(cliche), findings: [], verdict: "approve_candidate", unresolved: [] };
    expect(CopyQualityReview.safeParse(forged).success).toBe(true);
    expect(checkCopyQualityReview(forged, cliche).codes).toEqual(["REVIEW_DOES_NOT_MATCH_AUDIT"]);
    expect(checkCopyQualityReview({ ...good, auditor_version: "copy_quality_rules_v0" }, fx.bakeryGood()).codes).toEqual(["REVIEW_SCHEMA"]);
  });

  it("the record is strict and self-consistent (verdict = worst severity, allowed severities, fail only from a base failure)", () => {
    const r = reviewCopyQuality(fx.bakeryCliche());
    expect(CopyQualityReview.safeParse({ ...r, verdict: "approve_candidate" }).success).toBe(false);
    expect(CopyQualityReview.safeParse({ ...r, extra: 1 }).success).toBe(false);
    expect(CopyQualityReview.safeParse({ ...r, findings: r.findings.map((f) => ({ ...f, severity: "hold" })), verdict: "hold" }).success).toBe(false);
    expect(CopyQualityReview.safeParse({ ...r, findings: [...r.findings, { ...r.findings[0]!, code: "COPY_FACT_UNSUPPORTED", severity: "fail" }], verdict: "fail", unresolved: [...r.unresolved, "COPY_FACT_UNSUPPORTED"].sort() }).success).toBe(false);
    for (const [code, sev] of Object.entries(ALLOWED_SEVERITIES)) if (code !== "COPY_FACT_UNSUPPORTED") expect(sev).not.toContain("fail");
  });
});

describe("L2/L6: rounds", () => {
  it("fail is terminal, hold stops, revise only within MAX_COPY_REVISION_ROUNDS = 2", () => {
    expect(MAX_COPY_REVISION_ROUNDS).toBe(2);
    expect(nextCopyStep({ verdict: "fail", round: 0 })).toBe("stop_fail");
    expect(nextCopyStep({ verdict: "hold", round: 0 })).toBe("stop_hold");
    expect(nextCopyStep({ verdict: "revise", round: 0 })).toBe("revise");
    expect(nextCopyStep({ verdict: "revise", round: 1 })).toBe("revise");
    expect(nextCopyStep({ verdict: "revise", round: 2 })).toBe("stop_hold");
    expect(nextCopyStep({ verdict: "approve_candidate", round: 0 })).toBe("owner_review");
    expect(CopyQualityReview.safeParse({ ...reviewCopyQuality(fx.bakeryGood()), round: 3 }).success).toBe(false);
  });

  it("a revision round follows only a revise review of a changed copy record, in order, with the whole chain", () => {
    const firstFiles = fx.bakeryCliche();
    const first = reviewCopyQuality(firstFiles);
    const prior = [{ review: first, copyRecord: firstFiles.copyRecord, pageHtml: firstFiles.pageHtml, pageCss: firstFiles.pageCss }];
    const nextFiles = fx.bakeryGood();
    const second = reviewCopyQuality(nextFiles, { round: 1, previousCopySha256: first.copy_sha256 });
    expect(checkCopyQualityReview(second, nextFiles, { previous: prior })).toEqual({ ok: true, codes: [] });
    expect(checkCopyQualityReview(second, nextFiles).codes).toEqual(["REVISION_WITHOUT_PREVIOUS"]);
    // the chain must match its hashes and links
    expect(checkCopyQualityReview(second, nextFiles, { previous: [{ ...prior[0]!, copyRecord: `${String(firstFiles.copyRecord)} ` }] }).codes).toContain("PREVIOUS_COPY_DOES_NOT_MATCH_REVIEW");
    const unlinked = reviewCopyQuality(nextFiles, { round: 1, previousCopySha256: "2".repeat(64) });
    expect(checkCopyQualityReview(unlinked, nextFiles, { previous: prior }).codes).toEqual(["REVISION_CHAIN_BROKEN"]);
    // fail is terminal
    const failedFiles = { ...firstFiles, factsPack: "{" };
    const failed = reviewCopyQuality(failedFiles);
    expect(checkCopyQualityReview(second, nextFiles, { previous: [{ review: failed, copyRecord: failedFiles.copyRecord, pageHtml: failedFiles.pageHtml, pageCss: failedFiles.pageCss }] }).codes).toContain("REVISION_AFTER_FAIL");
    const skipped = reviewCopyQuality(nextFiles, { round: 2, previousCopySha256: first.copy_sha256 });
    expect(checkCopyQualityReview(skipped, nextFiles, { previous: prior }).codes).toEqual(["REVISION_CHAIN_LENGTH"]);
    expect(CopyQualityReview.safeParse({ ...second, previous_copy_sha256: null }).success).toBe(false);
  });

  it("M2: the chain runs validateCopyRevision; a fact laundered into prose in the next round invalidates the review", () => {
    const f0 = rinFiles();
    const r0 = reviewCopyQuality(f0);
    expect(r0.verdict).toBe("revise");
    const rec = JSON.parse(String(f0.copyRecord)) as { items: fx.Item[] } & Record<string, unknown>;
    const items = rec.items.filter((i) => i.id !== "truing").concat([fx.creative("truing-2", "車輪のゆがみを整えます")]);
    const copy1 = JSON.stringify({ ...rec, items });
    const html1 = String(f0.pageHtml).replace("振れ取りでは、<wbr>スポークを<wbr>一本ずつ<wbr>締めて<wbr>車輪を<wbr>まっすぐに<wbr>します", "車輪のゆがみを整えます");
    expect(html1).not.toBe(String(f0.pageHtml));
    const f1 = { ...f0, copyRecord: copy1, pageHtml: html1 };
    const r1 = reviewCopyQuality(f1, { round: 1, previousCopySha256: r0.copy_sha256 });
    const check = checkCopyQualityReview(r1, f1, { previous: [{ review: r0, copyRecord: f0.copyRecord, pageHtml: f0.pageHtml, pageCss: f0.pageCss }] });
    expect(check.codes).toEqual(expect.arrayContaining(["REVISION_INVALID", "REVISION_PROSE_TAKES_OVER_FACT", "REVISION_FACT_REPLACED_BY_PROSE"]));
  });
});

describe("M1: a revised review can pass the send gate only with its verified chain", () => {
  it("real shop: round 0 revise (prose without a fact), round 1 clean, owner approval → this gate does not block", () => {
    const f0 = fx.realShop({ prose: ["朝の棚に、焼きたてを。"] });
    const r0 = reviewCopyQuality(f0);
    expect(nextCopyStep(r0)).toBe("revise");
    const f1 = fx.realShop();
    const r1 = reviewCopyQuality(f1, { round: 1, previousCopySha256: r0.copy_sha256 });
    const approval: OwnerCopyApproval = { shop_id: r1.shop_id, facts_sha256: r1.facts_sha256, copy_sha256: r1.copy_sha256, page_html_sha256: r1.page_html_sha256, page_css_sha256: r1.page_css_sha256, decision: "approve" };
    const previous = [{ review: r0, copyRecord: f0.copyRecord, pageHtml: f0.pageHtml, pageCss: f0.pageCss }];
    expect(copyGateSendBlockers(r1, f1, approval, { previous })).toEqual([]);
    expect(copyGateSendBlockers(r1, f1, approval)).toEqual(["REVIEW_INVALID", "REVISION_WITHOUT_PREVIOUS"]);
  });
});

describe("approve_candidate is never sendable by itself", () => {
  const approval = (r: CopyQualityReview, decision: OwnerCopyApproval["decision"] = "approve"): OwnerCopyApproval => ({ shop_id: r.shop_id, facts_sha256: r.facts_sha256, copy_sha256: r.copy_sha256, page_html_sha256: r.page_html_sha256, page_css_sha256: r.page_css_sha256, decision });

  it("a fictional research page is never a send candidate, even at approve_candidate", () => {
    const f = fx.bakeryGood();
    const r = reviewCopyQuality(f);
    expect(r.verdict).toBe("approve_candidate");
    expect(copyGateSendBlockers(r, f, null)).toEqual(["FICTIONAL_RESEARCH_NOT_SENDABLE", "OWNER_APPROVAL_MISSING"]);
  });

  it("real-shop lane: blocked without the owner's approval; the approval must be for the same five inputs and say approve", () => {
    const f = fx.realShop();
    const r = reviewCopyQuality(f);
    expect(copyGateSendBlockers(r, f, null)).toEqual(["OWNER_APPROVAL_MISSING"]);
    expect(copyGateSendBlockers(r, f, approval(r, "revise"))).toEqual(["OWNER_APPROVAL_NOT_APPROVE"]);
    expect(copyGateSendBlockers(r, f, { ...approval(r), copy_sha256: "1".repeat(64) })).toEqual(["OWNER_APPROVAL_FOR_OTHER_INPUTS"]);
    // only now does THIS gate not block (the design review and the send path keep their own gates)
    expect(copyGateSendBlockers(r, f, approval(r))).toEqual([]);
  });

  it("the owner's approval does not override a style or fact problem, or a stale review", () => {
    const f = fx.realShop({ prose: ["朝の棚に、焼きたてを。"] });
    const r = reviewCopyQuality(f);
    expect(copyGateSendBlockers(r, f, approval(r))).toEqual(["REVIEW_NOT_PASSED"]);
    const clean = fx.realShop();
    const rc = reviewCopyQuality(clean);
    expect(copyGateSendBlockers(rc, { ...clean, pageCss: "p{}\n" }, approval(rc))).toEqual(expect.arrayContaining(["REVIEW_INVALID", "REVIEW_STALE_PAGE_CSS"]));
  });
});

describe("M2: no fact laundering in a revision", () => {
  const facts = FactsPack.parse(JSON.parse(fx.rinFile("facts-pack.json").toString("utf8"))).facts;
  const rin = () => JSON.parse(readFileSync(resolve(fx.REPO, RIN_COPY), "utf8")) as { items: fx.Item[] } & Record<string, unknown>;

  const ok = { ok: true, verdict: "ok", findings: [] };

  it("rewriting the F10 sentence as a creative line 「スポークを丁寧に締め直し…」 is FAIL", () => {
    const old = rin();
    const next = { ...old, items: [...old.items.filter((i) => i.id !== "truing"), fx.creative("truing-copy", "スポークを丁寧に締め直し、車輪をまっすぐにします。", ["F10"])] };
    expect(validateCopyRevision(old, next, { facts })).toEqual({ ok: false, verdict: "fail", findings: [{ code: "REVISION_PROSE_RESTATES_FACT", severity: "fail", item: "truing-copy", detail: "F10" }] });
  });

  it("changing an item's claim_type (the F10 fact made creative under the same id) is FAIL", () => {
    const old = rin();
    const next = { ...old, items: old.items.map((i) => (i.id === "truing" ? fx.creative("truing", "スポークを丁寧に締め直し、車輪をまっすぐにします。", ["F10"]) : i)) };
    expect(validateCopyRevision(old, next, { facts }).findings.map((f) => f.code)).toEqual(["REVISION_CLAIM_TYPE_CHANGED", "REVISION_PROSE_RESTATES_FACT"]);
  });

  it("a fact item reworded is FAIL; re-selecting a whole sentence or removing a fact is allowed", () => {
    const old = rin();
    const reworded = { ...old, items: old.items.map((i) => (i.id === "truing" ? { ...i, text: "振れ取りでは、スポークを丁寧に締めます" } : i)) };
    expect(validateCopyRevision(old, reworded, { facts }).findings).toEqual([{ code: "REVISION_FACT_NOT_VERBATIM", severity: "fail", item: "truing" }]);
    const reselected = { ...old, items: old.items.map((i) => (i.id === "fictional" ? { ...i, text: "実在の店ではありません。" } : i)).filter((i) => i.id !== "lesson") };
    expect(validateCopyRevision(old, reselected, { facts })).toEqual(ok);
  });

  it("a rewritten slogan heading that does not restate a fact is allowed (e.g. 「空気を入れる日。」 → 「講座のご案内」)", () => {
    const old = rin();
    const next = { ...old, items: old.items.map((i) => (i.id === "h-lesson" ? { ...i, text: "講座のご案内" } : i)) };
    expect(validateCopyRevision(old, next, { facts })).toEqual(ok);
  });

  // review M3: not too strict ...
  it.each(["パンク修理の相談", "振れ取りで車輪をまっすぐに"])("M3: a heading that only echoes a fact term with no claim (「%s」) is REVISE, not FAIL", (text) => {
    const old = rin();
    const next = { ...old, items: old.items.map((i) => (i.id === "h-spokes" ? { ...i, text } : i)) };
    const v = validateCopyRevision(old, next, { facts });
    expect(v).toMatchObject({ ok: true, verdict: "revise" });
    expect(v.findings.map((f) => [f.code, f.severity])).toEqual([["REVISION_PROSE_ECHOES_FACT", "revise"]]);
  });

  // ... and not easy to evade
  it("M3 / round 3 M2: a synonym paraphrase (「車輪のゆがみを整えます」) taking over the F10 item it drops or changes is FAIL, even with no shared wording", () => {
    const old = rin();
    const para = (i: fx.Item) => (i.id === "h-truing" ? { ...i, text: "車輪のゆがみを整えます" } : i);
    const dropped = { ...old, items: old.items.filter((i) => i.id !== "truing").map(para) };
    expect(validateCopyRevision(old, dropped, { facts }).findings).toEqual([{ code: "REVISION_PROSE_TAKES_OVER_FACT", severity: "fail", item: "h-truing", detail: "車輪" }]);
    const changed = { ...old, items: old.items.map((i) => (i.id === "truing" ? { ...i, text: "振れ取りでは、スポークを丁寧に締めます" } : para(i))) };
    expect(validateCopyRevision(old, changed, { facts }).findings.map((f) => f.code)).toEqual(["REVISION_PROSE_TAKES_OVER_FACT", "REVISION_FACT_NOT_VERBATIM"]);
    // while the F10 item stays verbatim, the same sentence is about the facts: REVISE (the re-audit and the owner judge it)
    const kept = { ...old, items: old.items.map(para) };
    expect(validateCopyRevision(old, kept, { facts })).toEqual({ ok: true, verdict: "revise", findings: [{ code: "REVISION_PROSE_ABOUT_FACTS", severity: "revise", item: "h-truing" }] });
  });

  it("M3: a deleted fact item re-added as prose under a new id in the same section is FAIL (with the pages)", () => {
    const old = rin();
    const oldHtml = readFileSync(resolve(fx.REPO, RIN_HTML), "utf8");
    const next = { ...old, items: old.items.filter((i) => i.id !== "truing").concat([fx.creative("truing-2", "車輪のゆがみ取り")]) };
    const newHtml = oldHtml.replace("振れ取りでは、<wbr>スポークを<wbr>一本ずつ<wbr>締めて<wbr>車輪を<wbr>まっすぐに<wbr>します", "車輪のゆがみ取り");
    expect(validateCopyRevision(old, next, { facts }).verdict).toBe("ok");
    expect(validateCopyRevision(old, next, { facts, oldPageHtml: oldHtml, newPageHtml: newHtml }).findings).toEqual([{ code: "REVISION_FACT_REPLACED_BY_PROSE", severity: "fail", detail: "truing" }]);
  });
});

describe("H1: every visible text reaches the base check (probes from review round 1)", () => {
  const probes: Array<[string, (f: ReturnType<typeof fx.shopFiles>) => CopyQualityFiles, string]> = [
    ["svg <text>", (f) => ({ ...f, pageHtml: String(f.pageHtml).replace("</main>", '<svg viewBox="0 0 10 10"><text x="0" y="5">創業100年の味</text></svg></main>') }), "UNVERIFIED_COPY"],
    ["<noscript>", (f) => ({ ...f, pageHtml: String(f.pageHtml).replace("</main>", "<noscript><p>創業100年の味</p></noscript></main>") }), "HTML_FORBIDDEN_ELEMENT"],
    ["<math><mtext>", (f) => ({ ...f, pageHtml: String(f.pageHtml).replace("</main>", "<math><mtext>創業100年の味</mtext></math></main>") }), "HTML_ELEMENT_NOT_ALLOWED"],
    ["CSS content", (f) => ({ ...f, pageCss: 'main::after{content:"創業100年の味"}\n' }), "CSS_TEXT_IN_CSS"],
  ];
  it.each(probes)("%s with invented text is FAIL, and the real-shop send gate blocks even with an owner approval", (_n, probe, code) => {
    const files = probe(fx.realShop());
    const r = reviewCopyQuality(files);
    expect(r.base_checks.codes).toContain(code);
    expect(r.verdict).toBe("fail");
    const approval: OwnerCopyApproval = { shop_id: r.shop_id, facts_sha256: r.facts_sha256, copy_sha256: r.copy_sha256, page_html_sha256: r.page_html_sha256, page_css_sha256: r.page_css_sha256, decision: "approve" };
    expect(copyGateSendBlockers(r, files, approval)).toEqual(["REVIEW_NOT_PASSED"]);
  });
  it("the server's extractor and this reader agree on 輪 (the <wbr>-split text nodes are covered by the joined blocks)", () => {
    expect(reviewCopyQuality(rinFiles()).base_checks.codes).not.toContain("PAGE_TEXT_NOT_COVERED");
  });
});

describe("M5: poetic headings without 。", () => {
  it("the bicycle cliché with every 。 stripped still accumulates", () => {
    const f = fx.bicycleCliche();
    const items = (f.record.items as fx.Item[]).map((i) => (i.claim_type === "fact" ? i : { ...i, text: i.text.replace(/。$/, "") }));
    const r = reviewCopyQuality(fx.shopFiles({ facts: String(f.factsPack), items, sections: fx.bicycleClicheSections }));
    expect(codes(r)).toContain("COPY_RHETORICAL_OVERUSE");
  });
  const bakeryWithHeadings = (h: [string, string, string]) => {
    const g = fx.bakeryGood();
    const items = [...(g.record.items as fx.Item[]), fx.creative("h1x", h[0]), fx.creative("h2x", h[1]), fx.creative("h3x", h[2])];
    return fx.shopFiles({
      facts: fx.bakeryFacts(),
      items,
      sections: [
        { id: "hero", blocks: [["h1", "name"], ["p", "name-full"]] },
        { id: "croissant", blocks: [["h2", "h1x"], ["p", "croissant"], ["p", "croissant-how"]] },
        { id: "bread", blocks: [["h2", "h2x"], ["p", "bread"], ["p", "bread-how"]] },
        { id: "info", blocks: [["h2", "h3x"], ["dt", "hours", "label"], ["dd", "hours"], ["dt", "address", "label"], ["dd", "address"]] },
      ],
    });
  };
  it("「朝の光」「棚の記憶」「通りの角」 raise COPY_RHETORICAL_OVERUSE", () => {
    const r = reviewCopyQuality(bakeryWithHeadings(["朝の光", "棚の記憶", "通りの角"]));
    expect(r.findings.find((f) => f.code === "COPY_RHETORICAL_OVERUSE")!.texts).toEqual(["朝の光", "棚の記憶", "通りの角"]);
  });
  it("plain headings 「パンのご案内」「焼き菓子について」「店舗情報」 do not", () => {
    const r = reviewCopyQuality(bakeryWithHeadings(["パンのご案内", "焼き菓子について", "店舗情報"]));
    expect(r.findings).toEqual([]);
  });
  // PR #259 round 2 M4: greeting / guide headings are plain, not poetic
  it.each([
    ["ごあいさつ", "こんな方へ", "ご利用の手順"],
    ["はじめに", "よくあるご相談", "おすすめ"],
    ["パンのご案内", "食パンについて", "お店の情報"],
  ] as Array<[string, string, string]>)("round 2 M4: plain headings 「%s」「%s」「%s」 raise nothing", (...h) => {
    const r = reviewCopyQuality(bakeryWithHeadings(h));
    expect(r.findings).toEqual([]);
  });
  it("round 3 L1: a ご / お店 opening that is no guide word stays poetic (「ご褒美の朝」「お店の灯り」「ご縁の棚」)", () => {
    expect(reviewCopyQuality(bakeryWithHeadings(["ご褒美の朝", "お店の灯り", "ご縁の棚"])).findings.find((f) => f.code === "COPY_RHETORICAL_OVERUSE")!.texts).toEqual(["ご褒美の朝", "お店の灯り", "ご縁の棚"]);
  });
  it("round 2 M4: the poetic headings stay flagged next to the widened plain set", () => {
    expect(codes(reviewCopyQuality(bakeryWithHeadings(["朝の光", "棚の記憶", "通りの角"])))).toContain("COPY_RHETORICAL_OVERUSE");
    expect(codes(reviewCopyQuality(bakeryWithHeadings(["朝の光", "特別な朝へ", "通りの角"])))).toContain("COPY_RHETORICAL_OVERUSE");
  });
});

describe("PR #259 round 2: claim signs behind plain labels (M2) and every match sourced (L1)", () => {
  // the bakery pack without the croissant sentence: 毎朝 is not sourced; 仕込 is (statement_2)
  const facts = FactsPack.parse(JSON.parse(fx.bakeryFacts({ withCroissantSentence: false }))).facts;
  const c = shopContext(facts);
  const withLine = (tag: "h2" | "p", line: string) => {
    const F = fx.bakeryFacts({ withCroissantSentence: false });
    const items = [...(fx.bakeryGood().record.items as fx.Item[]).filter((i) => i.id !== "croissant-how"), fx.creative("extra", line)];
    return fx.shopFiles({
      facts: F,
      items,
      sections: [
        { id: "hero", blocks: [["h1", "name"], ["p", "name-full"]] },
        { id: "croissant", blocks: [[tag, "extra"], ["p", "croissant"]] },
        { id: "bread", blocks: [["h2", "bread"], ["p", "bread-how"]] },
        { id: "info", blocks: [["dt", "hours", "label"], ["dd", "hours"], ["dt", "address", "label"], ["dd", "address"]] },
      ],
    });
  };
  it.each(["自家製パンのご案内", "毎朝焼きたて案内", "石窯パン紹介", "手作り商品"])("M2: 「%s」 (a claim sign in front of a plain word) is HOLD", (line) => {
    expect(unsourcedClaimSigns(line, c).length).toBeGreaterThan(0);
    for (const tag of ["h2", "p"] as const) {
      const r = reviewCopyQuality(withLine(tag, line));
      expect(r.base_checks.ok).toBe(true);
      expect(r.findings.find((f) => f.code === "COPY_FACT_UNSUPPORTED")).toMatchObject({ severity: "hold", rule: "claim_sign_outside_facts", texts: [line] });
      expect(r.verdict).toBe("hold");
    }
  });
  it.each(["メニュー", "営業時間", "メニュー一覧", "営業時間のご案内", "料金のご案内", "パンのご案内", "ご案内", "商品紹介"])("M2: the plain label 「%s」 claims nothing", (line) => {
    expect(unsourcedClaimSigns(line, c)).toEqual([]);
  });
  it("L1: every match must be sourced: 「毎朝焼いて毎晩仕込みます。」 with only 毎朝 sourced is HOLD", () => {
    const sourced = shopContext(FactsPack.parse(JSON.parse(fx.bakeryFacts())).facts);
    expect(unsourcedClaimSigns("毎朝焼きます。", sourced)).toEqual([]);
    expect(unsourcedClaimSigns("毎朝焼いて毎晩仕込みます。", sourced)).toEqual(["routine_or_frequency"]);
  });
});

describe("PR #259 round 2 M1: every earlier round is re-audited", () => {
  // round 0: the bakery page as audited (approve_candidate); round 1: the same shop without the tagline
  const f0 = fx.bakeryGood();
  const f1 = fx.shopFiles({
    facts: fx.bakeryFacts(),
    items: (f0.record.items as fx.Item[]).filter((i) => i.id !== "tagline"),
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "name-full"]] },
      { id: "croissant", blocks: [["h2", "croissant"], ["p", "croissant-how"]] },
      { id: "bread", blocks: [["h2", "bread"], ["p", "bread-how"]] },
      { id: "info", blocks: [["dt", "hours", "label"], ["dd", "hours"], ["dt", "address", "label"], ["dd", "address"]] },
    ],
  });
  const r0 = reviewCopyQuality(f0);
  const forged: CopyQualityReview = {
    ...r0,
    findings: [{ code: "COPY_RHETORICAL_OVERUSE", severity: "revise", rule: "slogan_accumulation", location: null, texts: ["朝の棚に、焼きたてを。"], reason: "forged", evidence: ["forged"] }],
    verdict: "revise",
    unresolved: ["COPY_RHETORICAL_OVERUSE"],
  };
  const r1 = reviewCopyQuality(f1, { round: 1, previousCopySha256: r0.copy_sha256 });
  const prior = (review: unknown, css = f0.pageCss) => [{ review, copyRecord: f0.copyRecord, pageHtml: f0.pageHtml, pageCss: css }];

  it("a forged round-0 `revise` with matching hashes does not open a revision", () => {
    expect(r0.verdict).toBe("approve_candidate");
    expect(CopyQualityReview.safeParse(forged).success).toBe(true);
    expect(checkCopyQualityReview(r1, f1, { previous: prior(forged) }).codes).toEqual(["PREVIOUS_REVIEW_DOES_NOT_MATCH_AUDIT"]);
    // the honest round 0 says approve_candidate, which does not open a revision either
    expect(checkCopyQualityReview(r1, f1, { previous: prior(r0) }).codes).toEqual(["REVISION_AFTER_NON_REVISE"]);
  });
  it("the earlier round's CSS must match its review", () => {
    expect(checkCopyQualityReview(r1, f1, { previous: prior(forged, "p{}\n") }).codes).toContain("PREVIOUS_PAGE_CSS_DOES_NOT_MATCH_REVIEW");
  });

  it("copyReviewAppendBlockers (for the DEV-199b store): append-only per shop + facts, no fresh round 0 once a review exists", () => {
    const c0 = fx.bakeryCliche();
    const q0 = reviewCopyQuality(c0);
    expect(nextCopyStep(q0)).toBe("revise");
    const q1 = reviewCopyQuality(f0, { round: 1, previousCopySha256: q0.copy_sha256 });
    const replay = reviewCopyQuality(f0);
    expect(copyReviewAppendBlockers([], q0)).toEqual([]);
    expect(copyReviewAppendBlockers([], q1)).toEqual(["FIRST_REVIEW_NOT_ROUND_0"]);
    expect(copyReviewAppendBlockers([q0], q1)).toEqual([]);
    // the fixed copy audited as a fresh round 0 (it would get approve_candidate without validateCopyRevision)
    expect(replay.verdict).toBe("approve_candidate");
    expect(copyReviewAppendBlockers([q0], replay)).toEqual(["ROUND_0_ALREADY_STORED", "NOT_LINKED_TO_LAST_ROUND"]);
    // nothing follows a round that does not allow a revision (approve_candidate here; fail and hold alike)
    expect(copyReviewAppendBlockers([r0], r1)).toEqual(["LAST_ROUND_DOES_NOT_ALLOW_REVISION"]);
    expect(copyReviewAppendBlockers([q0, q1], reviewCopyQuality(f1, { round: 2, previousCopySha256: q1.copy_sha256 }))).toEqual(["LAST_ROUND_DOES_NOT_ALLOW_REVISION"]);
    // another facts pack is another chain; a stored chain must be in order
    expect(copyReviewAppendBlockers([reviewCopyQuality(fx.realShop({ prose: ["朝の棚に、焼きたてを。"] }))], q1)).toContain("STORED_REVIEW_OF_ANOTHER_SHOP");
    expect(copyReviewAppendBlockers([q0], reviewCopyQuality(f1, { round: 2, previousCopySha256: q0.copy_sha256 }))).toEqual(["ROUND_NOT_NEXT"]);
    expect(copyReviewAppendBlockers([{}], q1)).toEqual(["STORED_REVIEW_SCHEMA"]);
  });
});

describe("PR #259 round 2 M3: a new plain sentence in a revision is not a terminal FAIL", () => {
  const facts = FactsPack.parse(JSON.parse(fx.rinFile("facts-pack.json").toString("utf8"))).facts;
  const rin = () => JSON.parse(readFileSync(resolve(fx.REPO, RIN_COPY), "utf8")) as { items: fx.Item[] } & Record<string, unknown>;
  it.each(["ご来店をお待ちしております。", "お近くにお越しの際はお立ち寄りいただけます。"])("「%s」 added in a revision is REVISE at most", (line) => {
    const old = rin();
    const v = validateCopyRevision(old, { ...old, items: [...old.items, fx.creative("welcome", line)] }, { facts });
    expect(v).toEqual({ ok: true, verdict: "revise", findings: [{ code: "REVISION_NEW_PROSE_STATEMENT", severity: "revise", item: "welcome" }] });
  });
  it("a claim sign or a sentence about the shop's facts in new words still FAILs", () => {
    const old = rin();
    const add = (line: string) => validateCopyRevision(old, { ...old, items: [...old.items, fx.creative("extra", line)] }, { facts }).findings;
    expect(add("毎朝タイヤを点検します。")).toEqual([{ code: "REVISION_NEW_PROSE_CLAIM", severity: "fail", item: "extra", detail: "routine_or_frequency" }]);
    // round 3 M2: naming a fact term while every fact stays verbatim is REVISE, not FAIL
    expect(add("車輪のゆがみを整えます")).toEqual([{ code: "REVISION_PROSE_ABOUT_FACTS", severity: "revise", item: "extra" }]);
  });
});

describe("PR #259 round 3 M2: a new sentence about facts that stay on the page is REVISE", () => {
  const facts = FactsPack.parse(JSON.parse(fx.bakeryFacts())).facts;
  it.each(["パンの香りが通りに広がります。", "焼きたてのパンが並ぶ店です。", "食パンは厚切りもおすすめです。"])("「%s」 added in a revision of the bakery is REVISION_PROSE_ABOUT_FACTS (REVISE)", (line) => {
    const old = fx.bakeryGood().record as { items: fx.Item[] } & Record<string, unknown>;
    const v = validateCopyRevision(old, { ...old, items: [...old.items, fx.creative("extra", line)] }, { facts });
    expect(v).toEqual({ ok: true, verdict: "revise", findings: [{ code: "REVISION_PROSE_ABOUT_FACTS", severity: "revise", item: "extra" }] });
  });
  it("the same sentence FAILs when the revision drops the fact item that held its term", () => {
    const old = fx.bakeryGood().record as { items: fx.Item[] } & Record<string, unknown>;
    const items = [...old.items.filter((i) => i.id !== "bread" && i.id !== "bread-how"), fx.creative("extra", "食パンは厚切りもおすすめです。")];
    expect(validateCopyRevision(old, { ...old, items }, { facts }).findings).toEqual([{ code: "REVISION_PROSE_TAKES_OVER_FACT", severity: "fail", item: "extra", detail: "パン" }]);
  });
});

describe("PR #259 round 3 M1 / L2: chains keyed on the facts content; owner-requested revision", () => {
  const f0 = fx.bakeryCliche();
  const q0 = reviewCopyQuality(f0);
  const reserialised = (f: CopyQualityFiles) => ({ ...f, factsPack: JSON.stringify(JSON.parse(String(f.factsPack))) });

  it("a re-serialised facts pack has new bytes but the same content hash, so it cannot start a fresh round 0", () => {
    const g = fx.bakeryGood();
    const rg = reserialised(g);
    expect(sha(rg.factsPack)).not.toBe(sha(g.factsPack));
    expect(factsContentSha256(rg.factsPack)).toBe(factsContentSha256(g.factsPack));
    // the copy record names the new bytes (as an attacker would), and the fixed copy is audited as round 0
    const rec = { ...(g.record as Record<string, unknown>), facts_sha256: sha(rg.factsPack) };
    const replayFiles = { ...rg, copyRecord: `${JSON.stringify(rec, null, 2)}\n` };
    const replay = reviewCopyQuality(replayFiles);
    expect(replay.verdict).toBe("approve_candidate");
    expect(replay.facts_sha256).not.toBe(q0.facts_sha256);
    expect(replay.facts_content_sha256).toBe(q0.facts_content_sha256);
    expect(copyReviewAppendBlockers([q0], replay)).toEqual(["ROUND_0_ALREADY_STORED", "NOT_LINKED_TO_LAST_ROUND", "FACTS_BYTES_CHANGED_IN_CHAIN"]);
    // a round 1 on the re-serialised bytes is refused too: the chain keeps its facts bytes
    expect(copyReviewAppendBlockers([q0], reviewCopyQuality(replayFiles, { round: 1, previousCopySha256: q0.copy_sha256 }))).toEqual(["FACTS_BYTES_CHANGED_IN_CHAIN"]);
  });

  it("facts with different content start their own chain; every stored review of the shop is passed and filtered", () => {
    const other = fx.shopFiles({ facts: fx.bakeryFacts({ withInfo: false }), items: [fx.fact("name", "こむぎ", ["F1"]), fx.fact("croissant", "クロワッサン", ["F3"])], sections: [{ id: "hero", blocks: [["h1", "name"]] }, { id: "products", blocks: [["h2", "croissant"]] }] });
    const r = reviewCopyQuality(other);
    expect(r.facts_content_sha256).not.toBe(q0.facts_content_sha256);
    expect(copyReviewAppendBlockers([q0], r)).toEqual([]);
  });

  it("a recorded review whose content hash was edited does not match the re-run audit", () => {
    expect(checkCopyQualityReview({ ...q0, facts_content_sha256: "3".repeat(64) }, f0).codes).toEqual(["REVIEW_DOES_NOT_MATCH_AUDIT"]);
  });

  it("L2: real shop at owner review, the owner asks for a revision of exactly that round: the next round may follow", () => {
    const g0 = fx.realShop();
    const p0 = reviewCopyQuality(g0);
    expect(nextCopyStep(p0)).toBe("owner_review");
    const g1 = fx.realShop({ prose: ["クロワッサンをどうぞ"] });
    const p1 = reviewCopyQuality(g1, { round: 1, previousCopySha256: p0.copy_sha256 });
    const ask = (decision: OwnerCopyApproval["decision"], copy = p0.copy_sha256): OwnerCopyApproval => ({ shop_id: p0.shop_id, facts_sha256: p0.facts_sha256, copy_sha256: copy, page_html_sha256: p0.page_html_sha256, page_css_sha256: p0.page_css_sha256, decision });
    expect(copyReviewAppendBlockers([p0], p1)).toEqual(["LAST_ROUND_DOES_NOT_ALLOW_REVISION"]);
    expect(copyReviewAppendBlockers([p0], p1, { ownerRevision: ask("approve") })).toEqual(["LAST_ROUND_DOES_NOT_ALLOW_REVISION"]);
    expect(copyReviewAppendBlockers([p0], p1, { ownerRevision: ask("revise", "4".repeat(64)) })).toEqual(["LAST_ROUND_DOES_NOT_ALLOW_REVISION"]);
    expect(copyReviewAppendBlockers([p0], p1, { ownerRevision: ask("revise") })).toEqual([]);
    const prior = { review: p0, copyRecord: g0.copyRecord, pageHtml: g0.pageHtml, pageCss: g0.pageCss };
    expect(checkCopyQualityReview(p1, g1, { previous: [prior] }).codes).toEqual(["REVISION_AFTER_NON_REVISE"]);
    // the revision still runs through validateCopyRevision and the re-audit
    expect(checkCopyQualityReview(p1, g1, { previous: [{ ...prior, ownerRevision: ask("revise") }] })).toEqual({ ok: true, codes: [] });
    // never for the fictional research lane (no owner)
    const b0 = fx.bakeryGood();
    const s0 = reviewCopyQuality(b0);
    const fictionalAsk: OwnerCopyApproval = { shop_id: s0.shop_id, facts_sha256: s0.facts_sha256, copy_sha256: s0.copy_sha256, page_html_sha256: s0.page_html_sha256, page_css_sha256: s0.page_css_sha256, decision: "revise" };
    const s1 = reviewCopyQuality(f0, { round: 1, previousCopySha256: s0.copy_sha256 });
    expect(copyReviewAppendBlockers([s0], s1, { ownerRevision: fictionalAsk })).toEqual(["LAST_ROUND_DOES_NOT_ALLOW_REVISION"]);
  });
});

describe("L1 / L2", () => {
  it("L1: any field the audit does not reproduce invalidates the review (axes evidence, section kind, finding reason)", () => {
    const f = fx.bakeryCliche();
    const r = reviewCopyQuality(f);
    const axes = { ...r.axes, usefulness: { ...r.axes.usefulness, evidence: ["edited"] } };
    expect(checkCopyQualityReview({ ...r, axes }, f).codes).toEqual(["REVIEW_DOES_NOT_MATCH_AUDIT"]);
    const sections = r.sections.map((s, i) => (i === 1 ? { ...s, entries: s.entries.map((e) => ({ ...e, kind: "fact" as const })) } : s));
    expect(checkCopyQualityReview({ ...r, sections }, f).codes).toEqual(["REVIEW_DOES_NOT_MATCH_AUDIT"]);
    const findings = r.findings.map((x, i) => (i === 0 ? { ...x, reason: "edited" } : x));
    expect(checkCopyQualityReview({ ...r, findings }, f).codes).toEqual(["REVIEW_DOES_NOT_MATCH_AUDIT"]);
  });
  it("L2: the offering is any fact beyond who / where / when, whatever its key (specialty_1, plan_a)", () => {
    const facts = fx.factsPack("fictional-tart-kasane", [
      ["name", "架空タルト店 かさね"],
      ["category", "patisserie"],
      ["specialty_1", "季節の果物のタルト"],
      ["plan_a", "焼き菓子の詰め合わせ"],
      ["hours", "11:00〜18:00"],
      ["address", "架空市架空区架空町六丁目1-1"],
    ]);
    const items = [fx.fact("name", "かさね", ["F1"]), fx.fact("tart", "季節の果物のタルト", ["F3"]), fx.fact("hours", "11:00〜18:00", ["F5"], "営業時間"), fx.fact("address", "架空市架空区架空町六丁目1-1", ["F6"], "住所")];
    const r = reviewCopyQuality(fx.shopFiles({ facts, items, sections: [{ id: "hero", blocks: [["h1", "name"]] }, { id: "tart", blocks: [["h2", "tart"]] }, { id: "info", blocks: [["dt", "hours", "label"], ["dd", "hours"], ["dt", "address", "label"], ["dd", "address"]] }] }));
    expect(r.findings).toEqual([]);
    const plain = fx.factsPack("fictional-tart-kasane", [["name", "架空タルト店 かさね"], ["hours", "11:00〜18:00"], ["address", "架空市架空区架空町六丁目1-1"]]);
    const r2 = reviewCopyQuality(fx.shopFiles({ facts: plain, items: [fx.fact("name", "かさね", ["F1"]), fx.fact("hours", "11:00〜18:00", ["F2"], "営業時間"), fx.fact("address", "架空市架空区架空町六丁目1-1", ["F3"], "住所")], sections: [{ id: "hero", blocks: [["h1", "name"]] }, { id: "info", blocks: [["dt", "hours", "label"], ["dd", "hours"], ["dt", "address", "label"], ["dd", "address"]] }] }));
    expect(rules(r2)).toEqual(["facts_missing_offering"]);
  });
});

describe("isolation", () => {
  const src = (p: string) => readFileSync(resolve(fx.REPO, p), "utf8");
  const specifiers = (s: string) => [...s.matchAll(/^import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]).sort();
  it("the audit imports only zod, sha256, the existing checks and its page reader (no network, process, model or worker)", () => {
    expect(specifiers(src("lib/design-agent/quality-pipeline/copy-quality-review.ts"))).toEqual(["./copy-quality-page", "./copy-record", "./facts-pack", "@/lib/sales/demo-version/copy-check", "@/lib/sales/demo-version/html-safety", "node:crypto", "zod"]);
    expect(specifiers(src("lib/design-agent/quality-pipeline/copy-quality-page.ts"))).toEqual(["@/lib/sales/demo-version/html-safety", "parse5"]);
    for (const p of ["lib/design-agent/quality-pipeline/copy-quality-review.ts", "lib/design-agent/quality-pipeline/copy-quality-page.ts"])
      expect(src(p)).not.toMatch(/\bfetch\(|import\s*\(|require\s*\(|child_process|anthropic|openai|codex|\/worker\//i);
  });
  it("nothing in the app, lib or scripts calls the audit yet (DEV-199b wires it in): the gate is not active", () => {
    const walk = (dir: string): string[] =>
      readdirSync(resolve(fx.REPO, dir), { withFileTypes: true }).flatMap((d) => {
        const p = `${dir}/${d.name}`;
        if (d.isDirectory()) return d.name === "node_modules" ? [] : walk(p);
        return /\.(ts|tsx|mts|mjs|js)$/.test(d.name) ? [p] : [];
      });
    const callers = ["app", "lib", "scripts", "components"].flatMap(walk).filter((p) => /from\s*["'][^"']*copy-quality-(review|page)["']/.test(src(p)) && !p.includes("quality-pipeline/copy-quality-"));
    expect(callers).toEqual([]);
    expect(rules(reviewCopyQuality(fx.bakeryGood()))).toEqual([]);
  });
});
