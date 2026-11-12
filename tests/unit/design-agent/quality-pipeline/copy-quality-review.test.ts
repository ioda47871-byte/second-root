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
  CopyQualityReview,
  genericSignals,
  isSloganShaped,
  MAX_COPY_REVISION_ROUNDS,
  nextCopyStep,
  reviewCopyQuality,
  shopContext,
  styleAndInformationFindings,
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
    const f = r.findings.find((x) => x.rule === "statement_terms_outside_facts")!;
    expect(f).toMatchObject({ code: "COPY_FACT_UNSUPPORTED", severity: "hold", texts: ["クロワッサンは毎朝焼きます。"] });
    expect(f.evidence.join(" ")).toContain("毎朝");
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

  it("a revision round follows only a revise review of a changed copy record, in order", () => {
    const first = reviewCopyQuality(fx.bakeryCliche());
    const nextFiles = fx.bakeryGood();
    const second = reviewCopyQuality(nextFiles, { round: 1 });
    expect(checkCopyQualityReview(second, nextFiles, { previous: first })).toEqual({ ok: true, codes: [] });
    expect(checkCopyQualityReview(second, nextFiles).codes).toEqual(["REVISION_WITHOUT_PREVIOUS"]);
    const failed = reviewCopyQuality({ ...nextFiles, factsPack: "{" });
    expect(checkCopyQualityReview(second, nextFiles, { previous: failed }).codes).toEqual(expect.arrayContaining(["REVISION_AFTER_FAIL"]));
    const skipped = reviewCopyQuality(nextFiles, { round: 2 });
    expect(checkCopyQualityReview(skipped, nextFiles, { previous: first }).codes).toEqual(["REVISION_ROUND_OUT_OF_ORDER"]);
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

  it("rewriting the F10 sentence as a creative line 「スポークを丁寧に締め直し…」 is FAIL", () => {
    const old = rin();
    const next = { ...old, items: [...old.items.filter((i) => i.id !== "truing"), fx.creative("truing-copy", "スポークを丁寧に締め直し、車輪をまっすぐにします。", ["F10"])] };
    expect(validateCopyRevision(old, next, { facts })).toEqual({ ok: false, findings: [{ code: "REVISION_PROSE_RESTATES_FACT", item: "truing-copy", detail: "F10" }] });
  });

  it("changing an item's claim_type (the F10 fact made creative under the same id) is FAIL", () => {
    const old = rin();
    const next = { ...old, items: old.items.map((i) => (i.id === "truing" ? fx.creative("truing", "スポークを丁寧に締め直し、車輪をまっすぐにします。", ["F10"]) : i)) };
    expect(validateCopyRevision(old, next, { facts }).findings.map((f) => f.code)).toEqual(["REVISION_CLAIM_TYPE_CHANGED", "REVISION_PROSE_RESTATES_FACT"]);
  });

  it("a fact item reworded is FAIL; re-selecting a whole sentence or removing a fact is allowed", () => {
    const old = rin();
    const reworded = { ...old, items: old.items.map((i) => (i.id === "truing" ? { ...i, text: "振れ取りでは、スポークを丁寧に締めます" } : i)) };
    expect(validateCopyRevision(old, reworded, { facts }).findings).toEqual([{ code: "REVISION_FACT_NOT_VERBATIM", item: "truing" }]);
    const reselected = { ...old, items: old.items.map((i) => (i.id === "fictional" ? { ...i, text: "実在の店ではありません。" } : i)).filter((i) => i.id !== "lesson") };
    expect(validateCopyRevision(old, reselected, { facts })).toEqual({ ok: true, findings: [] });
  });

  it("a rewritten slogan heading that does not restate a fact is allowed (e.g. 「空気を入れる日。」 → 「講座のご案内」)", () => {
    const old = rin();
    const next = { ...old, items: old.items.map((i) => (i.id === "h-lesson" ? { ...i, text: "講座のご案内" } : i)) };
    expect(validateCopyRevision(old, next, { facts })).toEqual({ ok: true, findings: [] });
  });
});

describe("isolation", () => {
  const src = (p: string) => readFileSync(resolve(fx.REPO, p), "utf8");
  const specifiers = (s: string) => [...s.matchAll(/^import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]).sort();
  it("the audit imports only zod, sha256, the existing checks and its page reader (no network, process, model or worker)", () => {
    expect(specifiers(src("lib/design-agent/quality-pipeline/copy-quality-review.ts"))).toEqual(["./copy-quality-page", "./copy-record", "./facts-pack", "@/lib/sales/demo-version/copy-check", "node:crypto", "zod"]);
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
    const callers = ["app", "lib", "scripts", "components"].flatMap(walk).filter((p) => /copy-quality-review/.test(src(p)));
    expect(callers).toEqual([]);
    expect(rules(reviewCopyQuality(fx.bakeryGood()))).toEqual([]);
  });
});
