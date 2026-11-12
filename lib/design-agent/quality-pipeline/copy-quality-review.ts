/**
 * DEV-199a (owner Issue #258, spec PR #257 docs/design/copy-authenticity-quality-gate.md, and the rules of the spec's
 * independent review): the copy quality audit, a sidecar `copy_quality_review_v1` beside a comp's `comp_copy_v1`.
 *
 * NOT WIRED IN. Nothing calls this yet (DEV-199b connects it). It decides nothing about a real page today.
 *
 * What it does
 *   1. Runs the existing checks unchanged and wraps their result: the facts pack schema (facts-pack.ts) and the
 *      artifact copy check (lib/sales/demo-version/copy-check.ts: checkCopyRecord + every visible text in the record
 *      + no joined text looking like a fact). Any failure there is `COPY_FACT_UNSUPPORTED` with severity `fail`, and
 *      the verdict is `fail`: nothing in this audit can rate a page better than those checks do.
 *   2. Reads the page's sections and roles from its DOM (./copy-quality-page.ts, rule L5) and ties each text to its
 *      copy-record item: a verbatim `fact`, a fact's `label`, or prose (`creative_expression` /
 *      `proposal_pending_review`).
 *   3. Judges only the prose with structural, deterministic signals (never a word blacklist):
 *        - slogan-shaped lines: a short prose line that ends in 。/！ or is cut at a comma into a fragment
 *          (…、…へ / …に / …ずつ). Polite explanatory sentences (…ます。) are not slogans.
 *        - accumulation: COPY_RHETORICAL_OVERUSE when three or more non-hero sections lead with a slogan line and they
 *          are at least half of the non-hero headline lines. The hero may keep its one strong line.
 *        - cadence: COPY_REPETITIVE_CADENCE when one shape (ends in 。, 「…、…」 split, 体言止め + 。, particle
 *          fragment) recurs in three or more sections.
 *        - shop specificity: a prose line is swappable when, with the shop's name and the fictional marker taken out,
 *          it carries no term (kanji / katakana / alphanumeric run) found in the shop's own facts. A swappable line
 *          that also matches a generic-phrase signal (GENERIC_PHRASE_SIGNALS, a signal only, never alone) is generic;
 *          two or more give COPY_GENERIC_FOR_SHOP — HOLD when the facts pack has no material to be specific with
 *          (rule M3: never invent specifics), else REVISE.
 *        - voice: plain-form prose sentences on a polite page, a short line cut by three or more commas, repeated
 *          exclamation marks.
 *      Verbatim facts, labels and decoration are never judged for style (rules M3, L3, L6).
 *   4. Checks what information the page carries: offering, hours and location. Missing from the facts pack → HOLD
 *      (nothing is invented). In the facts but not on the page → REVISE. A non-hero section with prose but no fact → REVISE.
 *   5. A prose statement (…ます。/ …る。) that names a term found nowhere in the facts is COPY_FACT_UNSUPPORTED with
 *      severity `hold`: the audit's own, stricter suspicion on top of the copy-record tripwire.
 *   6. Lanes (rule M5): `quality_research_fictional` gets the full style audit. `real_shop_proposal` is judged only on
 *      which facts and labels are shown and how; its prose is never judged as the shop's own words, and the lane
 *      always carries COPY_APPROVAL_MISSING (HOLD).
 *
 * Verdict: the worst severity of the findings, fail > hold > revise; none → approve_candidate. `fail` is terminal
 * (rule L2): it is not revised into a pass. The five axis scores (0–5) are supporting signals; no score decides the
 * verdict. `approve_candidate` never means sendable (copyGateSendBlockers): the owner's approval is a separate record.
 *
 * Binding (rule L1): a review holds the sha256 of the facts pack, the copy record, the page HTML and its CSS, and the
 * auditor version. checkCopyQualityReview recomputes all of them from the files at check time and re-runs the audit;
 * any difference makes the review invalid, so an old PASS is never reused for a changed page.
 *
 * Revisions (rules M2, L6): validateCopyRevision refuses fact laundering (a changed claim_type, a fact not verbatim,
 * new prose restating a fact) as FAIL; at most MAX_COPY_REVISION_ROUNDS rounds.
 *
 * Pure apart from sha256 (node:crypto). No network, no model call.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { checkArtifactCopy } from "@/lib/sales/demo-version/copy-check";
import { CopyRecord, factParts, type CopyItem } from "./copy-record";
import { FactsPack } from "./facts-pack";
import { OUTSIDE_SECTIONS, pageText, type EntryRole, type PageSection } from "./copy-quality-page";

export const COPY_QUALITY_AUDITOR_VERSION = "copy_quality_rules_v1";
/** The hard cap on audit → local revision → re-audit rounds (as comp-review.ts caps its self-critique rounds at 2). */
export const MAX_COPY_REVISION_ROUNDS = 2;

export const COPY_FINDING_CODES = [
  "COPY_FACT_UNSUPPORTED",
  "COPY_RHETORICAL_OVERUSE",
  "COPY_REPETITIVE_CADENCE",
  "COPY_GENERIC_FOR_SHOP",
  "COPY_INFORMATION_MISSING",
  "COPY_VOICE_UNNATURAL",
  "COPY_APPROVAL_MISSING",
] as const;
export type CopyFindingCode = (typeof COPY_FINDING_CODES)[number];
export type Severity = "fail" | "hold" | "revise";
export type Verdict = "fail" | "hold" | "revise" | "approve_candidate";

/** Which severities each code may carry. A fact or safety failure is `fail`; style is never worse than `revise` unless facts are missing. */
export const ALLOWED_SEVERITIES: Readonly<Record<CopyFindingCode, readonly Severity[]>> = {
  COPY_FACT_UNSUPPORTED: ["fail", "hold"],
  COPY_RHETORICAL_OVERUSE: ["revise"],
  COPY_REPETITIVE_CADENCE: ["revise"],
  COPY_GENERIC_FOR_SHOP: ["revise", "hold"],
  COPY_INFORMATION_MISSING: ["revise", "hold"],
  COPY_VOICE_UNNATURAL: ["revise"],
  COPY_APPROVAL_MISSING: ["hold"],
};

/**
 * Phrases that read the same for any shop of any trade. A SIGNAL ONLY: a line counts as generic only when it also
 * fails the name-swap test (no term from the shop's own facts). A line is never refused for containing one of these.
 */
export const GENERIC_PHRASE_SIGNALS: readonly string[] = [
  "こだわり",
  "特別なひととき",
  "特別な時間",
  "至福",
  "癒し",
  "癒やし",
  "くつろぎ",
  "心を込め",
  "真心",
  "上質",
  "あなただけ",
  "ワンランク上",
  "贅沢",
  "素敵な",
  "想いを",
  "おもてなし",
  "居心地",
  "心地よい",
  "安らぎ",
  "笑顔",
];

/** The information a visitor looks for, by the facts-pack keys that hold it. */
export const INFORMATION_FAMILIES: ReadonlyArray<readonly [family: string, key: RegExp]> = [
  ["offering", /^(service|menu|product|item|course|treatment|dish|drink)(_\d{1,3})?$/],
  ["hours", /^hours$/],
  ["location", /^(address|access)$/],
];
/** Facts that say only who and where: a pack with nothing else has no material for shop-specific copy. */
const NON_MATERIAL_KEYS = /^(name|category|ward|address|hours|closed_days|access|phone)$/;
/** Words every fictional research shop carries (架空市…): never evidence that a line is about this shop. */
const FICTIONAL_MARKERS = ["架空"];

// ---- the record --------------------------------------------------------------------------------------------------

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Line = z.string().min(1).max(400);
const Position = z.strictObject({ section: z.number().int().min(0).max(199), entry: z.number().int().min(0).max(999) });
const KINDS = ["fact", "label", "prose", "decoration", "unrecorded"] as const;
const Axis = z.strictObject({ score: z.number().int().min(0).max(5), evidence: z.array(Line).min(1).max(12) });
const Finding = z.strictObject({
  code: z.enum(COPY_FINDING_CODES),
  severity: z.enum(["fail", "hold", "revise"]),
  rule: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  /** the one entry the finding is about; null for a page-level finding (accumulation, cadence, missing facts) */
  location: Position.nullable(),
  /** the exact texts that triggered the rule (entries' texts), or none for a page-level fact gap */
  texts: z.array(Line).max(40),
  reason: Line,
  evidence: z.array(Line).min(1).max(40),
});
export type CopyQualityFinding = z.infer<typeof Finding>;

const RANK: Record<Verdict, number> = { approve_candidate: 0, revise: 1, hold: 2, fail: 3 };
export const worstVerdict = (severities: readonly Severity[]): Verdict => severities.reduce<Verdict>((w, s) => (RANK[s] > RANK[w] ? s : w), "approve_candidate");

export const CopyQualityReview = z
  .strictObject({
    schema: z.literal("copy_quality_review_v1"),
    auditor_version: z.literal(COPY_QUALITY_AUDITOR_VERSION),
    shop_id: z.string().min(1).max(80),
    lane: CopyRecord.shape.lane,
    facts_sha256: Sha,
    copy_sha256: Sha,
    page_html_sha256: Sha,
    page_css_sha256: Sha,
    /** 0 = the first audit; each local revision adds one, at most MAX_COPY_REVISION_ROUNDS */
    round: z.number().int().min(0).max(MAX_COPY_REVISION_ROUNDS),
    /** the existing checks this audit wraps (facts pack schema, artifact copy check), their codes as found */
    base_checks: z.strictObject({ ok: z.boolean(), codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/)).max(80) }),
    sections: z
      .array(
        z.strictObject({
          section_id: z.string().min(1).max(80),
          index: z.number().int().min(0).max(199),
          entries: z
            .array(
              z.strictObject({
                position: Position,
                role: z.enum(["heading", "body", "label", "decoration"]),
                kind: z.enum(KINDS),
                text: z.string().min(1).max(4000),
                copy_item_id: z.string().max(41).nullable(),
              }),
            )
            .max(1000),
        }),
      )
      .max(200),
    axes: z.strictObject({ natural_japanese: Axis, shop_specificity: Axis, usefulness: Axis, restraint_consistency: Axis, fact_correctness: Axis }),
    findings: z.array(Finding).max(200),
    verdict: z.enum(["fail", "hold", "revise", "approve_candidate"]),
    /** the codes still open (sorted, unique) */
    unresolved: z.array(z.enum(COPY_FINDING_CODES)).max(COPY_FINDING_CODES.length),
  })
  .superRefine((r, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    if (r.verdict !== worstVerdict(r.findings.map((f) => f.severity))) bad("verdict_not_worst_severity");
    for (const f of r.findings) if (!ALLOWED_SEVERITIES[f.code].includes(f.severity)) bad(`severity_not_allowed:${f.code}:${f.severity}`);
    const hasFail = r.findings.some((f) => f.severity === "fail");
    if (!r.base_checks.ok && !hasFail) bad("base_failure_not_fail");
    if (r.base_checks.ok && hasFail) bad("fail_without_base_failure");
    if (r.lane === "real_shop_proposal" && !r.findings.some((f) => f.code === "COPY_APPROVAL_MISSING")) bad("real_shop_without_approval_missing");
    if (hasFail && r.axes.fact_correctness.score !== 0) bad("fact_axis_on_fail");
    const codes = [...new Set(r.findings.map((f) => f.code))].sort();
    if (JSON.stringify(codes) !== JSON.stringify(r.unresolved)) bad("unresolved_not_finding_codes");
  });
export type CopyQualityReview = z.infer<typeof CopyQualityReview>;

// ---- text helpers ------------------------------------------------------------------------------------------------

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
const TERMINAL = /[。!?]$/;
const stripEnd = (s: string) => s.replace(/[。.!?]+$/, "");
const POLITE = /(ます|ました|ません|ましょう|です|でした|ください)$/;
const PLAIN_STATEMENT = /[るただい]$/;
const FRAGMENT_END = /(へ|に|を|と|で|も|から|まで|て|ずつ)$/;
const NOUN_END = /[一-鿿々ァ-ヺー]$/;
const TERM = /[一-鿿々〆ヵヶ]{2,}|[ァ-ヺー]{2,}|[A-Za-z0-9]{2,}/g;
const KANJI = /^[一-鿿々〆ヵヶ]+$/;
const terms = (s: string) => [...s.matchAll(TERM)].map((m) => m[0]);
const isPolite = (t: string) => POLITE.test(stripEnd(norm(t)));
/** A sentence that asserts something: polite or plain form, closed with 。 (a request or a fragment is not one). */
const isStatement = (t: string) => {
  const n = norm(t);
  const core = stripEnd(n);
  if (/ください$|ましょう$/.test(core)) return false;
  return POLITE.test(core) || (TERMINAL.test(n) && PLAIN_STATEMENT.test(core));
};

type Shape = "terminal_period" | "comma_split" | "noun_period" | "particle_fragment";
function shapes(t: string): Shape[] {
  const n = norm(t);
  const core = stripEnd(n);
  const out: Shape[] = [];
  if (TERMINAL.test(n)) out.push("terminal_period");
  if ((n.match(/、/g) ?? []).length === 1 && n.length <= 20) out.push("comma_split");
  if (TERMINAL.test(n) && NOUN_END.test(core)) out.push("noun_period");
  if (FRAGMENT_END.test(core)) out.push("particle_fragment");
  return out;
}
/** A short prose line written as a slogan: closed with 。/！, or cut at a comma into a particle fragment. Never a polite sentence. */
export function isSloganShaped(t: string): boolean {
  const n = norm(t);
  if (n.length > 30 || isPolite(n)) return false;
  return TERMINAL.test(n) || (n.includes("、") && FRAGMENT_END.test(stripEnd(n)));
}

function bigrams(s: string): string[] {
  const t = norm(s).replace(/[、。,.!?・|｜「」『』()（）\-]/g, "");
  const out: string[] = [];
  for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
  return out;
}

// ---- the audit ---------------------------------------------------------------------------------------------------

export type CopyQualityFiles = { factsPack: string | Uint8Array; copyRecord: string | Uint8Array; pageHtml: string | Uint8Array; pageCss: string | Uint8Array };

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const utf8 = (b: string | Uint8Array) => (typeof b === "string" ? b : new TextDecoder("utf-8", { fatal: false }).decode(b));
const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

type Kind = (typeof KINDS)[number];
export type AuditEntry = { role: EntryRole; text: string; position: { section: number; entry: number }; kind: Kind; item: CopyItem | null; section_id: string };
type Fact = FactsPack["facts"][number];

/** What the style rules know about the shop: its facts as text, the strings that name it, whether it has material. */
export type ShopContext = { facts: readonly Fact[]; corpus: string; nameStrings: string[]; hasMaterial: boolean };

export function shopContext(facts: readonly Fact[]): ShopContext {
  const name = facts.find((f) => f.key === "name")?.value ?? "";
  // the full name and its space-separated parts of two or more characters (one character, e.g. 輪, also sits inside 車輪)
  const nameStrings = [norm(name), ...name.split(/ +/).map(norm).filter((p) => p.length >= 2)].filter(Boolean).sort((a, b) => b.length - a.length);
  const corpus = facts.filter((f) => f.key !== "name" && f.key !== "category").map((f) => norm(f.value)).join("\u0000");
  return { facts, corpus, nameStrings, hasMaterial: facts.some((f) => !NON_MATERIAL_KEYS.test(f.key)) };
}

/** The line's terms that the shop's facts do not hold (name and fictional marker taken out first). */
export function termsOutsideFacts(text: string, c: ShopContext): { all: string[]; outside: string[] } {
  let t = norm(text);
  for (const s of [...c.nameStrings, ...FICTIONAL_MARKERS]) t = t.split(s).join("\u0000");
  const all = terms(t);
  const inFacts = (term: string) => {
    if (c.corpus.includes(term)) return true;
    if (KANJI.test(term) && term.length >= 3) for (let i = 0; i + 2 <= term.length; i++) if (c.corpus.includes(term.slice(i, i + 2))) return true;
    return false;
  };
  return { all, outside: all.filter((x) => !inFacts(x)) };
}

/** Name-swap test: the line holds no term from the shop's own facts, so it would read the same for another shop. */
export const isSwappable = (text: string, c: ShopContext) => {
  const { all, outside } = termsOutsideFacts(text, c);
  return all.length === outside.length;
};
export const genericSignals = (text: string) => GENERIC_PHRASE_SIGNALS.filter((p) => norm(text).includes(norm(p)));

function classify(sections: readonly PageSection[], record: CopyRecord | null): AuditEntry[] {
  const facts = new Map<string, CopyItem>();
  const labels = new Map<string, CopyItem>();
  const prose = new Map<string, CopyItem>();
  for (const i of record?.items ?? []) {
    const m = i.claim_type === "fact" ? facts : prose;
    if (!m.has(norm(i.text))) m.set(norm(i.text), i);
    if (i.label && !labels.has(norm(i.label))) labels.set(norm(i.label), i);
  }
  return sections.flatMap((s) =>
    s.entries.map((e) => {
      const n = norm(e.text);
      const fact = facts.get(n);
      const label = labels.get(n);
      const p = prose.get(n);
      const item = fact ?? label ?? p ?? null;
      const kind: Kind = e.role === "decoration" ? "decoration" : fact ? "fact" : e.role === "label" || label ? "label" : p ? "prose" : "unrecorded";
      return { ...e, kind, item, section_id: s.section_id };
    }),
  );
}

const pos = (e: AuditEntry) => `[${e.section_id}#${e.position.entry}]`;
const quote = (e: AuditEntry) => `${pos(e)} 「${e.text.slice(0, 120)}」`;
const clamp = (n: number) => Math.max(0, Math.min(5, Math.round(n)));

/**
 * The style and information findings for a page whose base checks are known. Exported for tests of single rules;
 * reviewCopyQuality is the entry point.
 */
export function styleAndInformationFindings(entries: readonly AuditEntry[], c: ShopContext, lane: CopyRecord["lane"]): { findings: CopyQualityFinding[]; axes: Omit<CopyQualityReview["axes"], "fact_correctness">; unsourcedStatements: number } {
  const findings: CopyQualityFinding[] = [];
  const sectionIds = [...new Set(entries.map((e) => e.section_id))];
  const heroId = sectionIds.includes("hero") ? "hero" : sectionIds.find((s) => s !== OUTSIDE_SECTIONS);
  const contentSections = sectionIds.filter((s) => s !== heroId && s !== OUTSIDE_SECTIONS);
  // only prose headlines and prose body lines are judged for style (facts, labels, decoration never)
  const prose = entries.filter((e) => e.kind === "prose" && (e.role === "heading" || e.role === "body"));
  const fictional = lane === "quality_research_fictional";

  // -- facts named by prose statements but held nowhere in the facts (both lanes)
  let unsourcedStatements = 0;
  for (const e of prose) {
    if (!isStatement(e.text)) continue;
    const { outside } = termsOutsideFacts(e.text, c);
    if (!outside.length) continue;
    unsourcedStatements++;
    findings.push({
      code: "COPY_FACT_UNSUPPORTED",
      severity: "hold",
      rule: "statement_terms_outside_facts",
      location: e.position,
      texts: [e.text.slice(0, 400)],
      reason: "A prose statement names something the shop's facts do not hold; it is not invented, it waits for a sourced fact.",
      evidence: [quote(e), `terms not in the facts pack: ${outside.slice(0, 8).join(", ")}`],
    });
  }

  // -- information: what the facts hold and what the page shows
  const shownFactIds = new Set(entries.filter((e) => e.kind === "fact" && e.item?.claim_type === "fact").flatMap((e) => e.item!.source_fact_ids));
  const familyGaps: string[] = [];
  for (const [family, key] of INFORMATION_FAMILIES) {
    const inPack = c.facts.filter((f) => key.test(f.key));
    if (!inPack.length) {
      familyGaps.push(family);
      findings.push({
        code: "COPY_INFORMATION_MISSING",
        severity: "hold",
        rule: `facts_missing_${family}`,
        location: null,
        texts: [],
        reason: `The facts pack holds no ${family} information; the copy must not invent it, so the page waits for a sourced fact.`,
        evidence: [`no fact key matches ${key.source}`],
      });
    } else if (!inPack.some((f) => shownFactIds.has(f.id))) {
      familyGaps.push(family);
      findings.push({
        code: "COPY_INFORMATION_MISSING",
        severity: "revise",
        rule: `copy_omits_${family}`,
        location: null,
        texts: [],
        reason: `The facts pack holds ${family} information but no verbatim fact item on the page shows it.`,
        evidence: [`facts not shown: ${inPack.map((f) => `${f.id}(${f.key})`).join(", ")}`],
      });
    }
  }
  const sectionsWithFact = contentSections.filter((s) => entries.some((e) => e.section_id === s && (e.kind === "fact" || e.kind === "label")));
  for (const s of contentSections) {
    if (sectionsWithFact.includes(s)) continue;
    const lines = prose.filter((e) => e.section_id === s);
    if (!lines.length) continue;
    findings.push({
      code: "COPY_INFORMATION_MISSING",
      severity: "revise",
      rule: "section_without_fact",
      location: lines[0]!.position,
      texts: lines.map((e) => e.text.slice(0, 400)),
      reason: "This section shows prose only: no fact or label tells the visitor anything.",
      evidence: lines.map(quote),
    });
  }
  const usefulness = {
    score: clamp((contentSections.length ? (5 * sectionsWithFact.length) / contentSections.length : 5) - familyGaps.length),
    evidence: [`${sectionsWithFact.length} of ${contentSections.length} non-hero sections carry a fact or label`, familyGaps.length ? `information not on the page: ${familyGaps.join(", ")}` : "offering, hours and location are on the page"],
  };

  if (!fictional) {
    const note = "real-shop lane: prose is proposal_pending_review and is not judged as the shop's words; only the facts and labels shown are judged";
    return { findings, unsourcedStatements, axes: { natural_japanese: { score: 5, evidence: [note] }, shop_specificity: { score: 5, evidence: [note] }, usefulness, restraint_consistency: { score: 5, evidence: [note] } } };
  }

  // -- accumulation of slogan lines (the hero may keep one strong line)
  const headline = prose.filter((e) => e.section_id !== heroId && e.section_id !== OUTSIDE_SECTIONS && (e.role === "heading" || isSloganShaped(e.text)));
  const slogans = headline.filter((e) => isSloganShaped(e.text));
  const sloganSections = new Set(slogans.map((e) => e.section_id));
  const heroSlogans = prose.filter((e) => e.section_id === heroId && isSloganShaped(e.text));
  const share = headline.length ? slogans.length / headline.length : 0;
  if (sloganSections.size >= 3 && share >= 0.5)
    findings.push({
      code: "COPY_RHETORICAL_OVERUSE",
      severity: "revise",
      rule: "slogan_accumulation",
      location: null,
      texts: slogans.map((e) => e.text.slice(0, 400)),
      reason: "Section after section leads with a slogan line instead of saying what the section is about; the accumulation, not any one line, is the problem.",
      evidence: [`${slogans.length} of ${headline.length} non-hero headline lines are slogan-shaped, in ${sloganSections.size} sections`, ...slogans.map(quote), ...(heroSlogans.length ? [`hero line not counted: ${heroSlogans.map(quote).join(" ")}`] : [])],
    });

  // -- one shape repeated across sections
  const shaped = prose.filter((e) => e.section_id !== OUTSIDE_SECTIONS && norm(e.text).length <= 30 && !isPolite(e.text) && (e.role === "heading" || isSloganShaped(e.text)));
  const cadence: string[] = [];
  for (const shape of ["terminal_period", "comma_split", "noun_period", "particle_fragment"] as const) {
    const hit = shaped.filter((e) => shapes(e.text).includes(shape));
    const secs = new Set(hit.map((e) => e.section_id));
    if (secs.size < 3) continue;
    cadence.push(shape);
    findings.push({
      code: "COPY_REPETITIVE_CADENCE",
      severity: "revise",
      rule: `cadence_${shape}`,
      location: null,
      texts: hit.map((e) => e.text.slice(0, 400)),
      reason: `The same line shape (${shape}) recurs in ${secs.size} sections, so the page reads as one formula repeated.`,
      evidence: [`${hit.length} lines in ${secs.size} sections share the shape ${shape}`, ...hit.map(quote)],
    });
  }
  const restraint = {
    score: clamp(5 - 5 * share - cadence.length),
    evidence: [`slogan-shaped non-hero headline lines: ${slogans.length} of ${headline.length}`, cadence.length ? `repeated shapes: ${cadence.join(", ")}` : "no line shape repeats in three sections", `hero slogan lines (allowed): ${heroSlogans.length}`],
  };

  // -- shop specificity (name-swap test + generic-phrase signal; never the signal alone)
  const swappable = prose.filter((e) => isSwappable(e.text, c));
  const generic = swappable.filter((e) => genericSignals(e.text).length > 0);
  if (generic.length >= 2)
    findings.push({
      code: "COPY_GENERIC_FOR_SHOP",
      severity: c.hasMaterial ? "revise" : "hold",
      rule: c.hasMaterial ? "generic_lines_swappable" : "generic_lines_no_material",
      location: null,
      texts: generic.map((e) => e.text.slice(0, 400)),
      reason: c.hasMaterial
        ? "These lines would read the same for any shop of any trade: no term from this shop's facts, only generic phrasing."
        : "These lines would read the same for any shop, and the facts pack holds no material to make them specific; nothing may be invented, so the page waits for facts.",
      evidence: [...generic.map((e) => `${quote(e)} signals: ${genericSignals(e.text).join(", ")}`), `${swappable.length} of ${prose.length} prose lines carry no term from the shop's facts`],
    });
  // the score counts only lines that name something (a line of particles and single characters is neither specific nor generic)
  const naming = prose.filter((e) => termsOutsideFacts(e.text, c).all.length > 0);
  const specific = naming.filter((e) => !isSwappable(e.text, c)).length;
  const shopSpecificity = {
    score: clamp((naming.length ? (5 * specific) / naming.length : 5) - (generic.length >= 2 ? 2 : 0)),
    evidence: [`${specific} of ${naming.length} prose lines that name something carry a term from the shop's own facts`, generic.length ? `generic lines: ${generic.map(quote).join(" ")}` : "no swappable line with a generic phrase"],
  };

  // -- voice
  const body = entries.filter((e) => e.role === "body" && (e.kind === "prose" || e.kind === "fact"));
  const politeCount = body.filter((e) => isStatement(e.text) && isPolite(e.text)).length;
  const voice: AuditEntry[] = [];
  for (const e of prose.filter((x) => x.role === "body")) {
    const n = norm(e.text);
    if (politeCount >= 2 && isStatement(e.text) && !isPolite(e.text)) {
      voice.push(e);
      findings.push({ code: "COPY_VOICE_UNNATURAL", severity: "revise", rule: "plain_form_on_polite_page", location: e.position, texts: [e.text.slice(0, 400)], reason: "A plain-form sentence on a page that otherwise speaks politely to the visitor.", evidence: [quote(e), `${politeCount} polite sentences in the page body`] });
    } else if ((n.match(/、/g) ?? []).length >= 3 && n.length <= 30) {
      voice.push(e);
      findings.push({ code: "COPY_VOICE_UNNATURAL", severity: "revise", rule: "comma_fragmented", location: e.position, texts: [e.text.slice(0, 400)], reason: "A short line cut by three or more commas reads as fragments, not as speech.", evidence: [quote(e)] });
    }
  }
  const exclaimed = prose.filter((e) => /[!！]/.test(e.text));
  if (exclaimed.length >= 2) {
    voice.push(...exclaimed);
    findings.push({ code: "COPY_VOICE_UNNATURAL", severity: "revise", rule: "repeated_exclamation", location: null, texts: exclaimed.map((e) => e.text.slice(0, 400)), reason: "Exclamation marks on several lines: a shop does not talk to its visitors that way.", evidence: exclaimed.map(quote) });
  }
  const natural = { score: clamp(5 - 2 * new Set(voice).size - (cadence.length ? 1 : 0)), evidence: [voice.length ? `unnatural lines: ${[...new Set(voice)].map(quote).join(" ")}` : "no plain/polite mixing, comma fragments or repeated exclamation in the prose", cadence.length ? "repeated line shapes lower the score" : "no repeated line shape"] };

  return { findings, unsourcedStatements, axes: { natural_japanese: natural, shop_specificity: shopSpecificity, usefulness, restraint_consistency: restraint } };
}

/** The audit of one page: the existing checks wrapped, then style and information (see the file comment). */
export function reviewCopyQuality(files: CopyQualityFiles, o: { round?: number } = {}): CopyQualityReview {
  const factsRaw = parseJson(utf8(files.factsPack));
  const copyRaw = parseJson(utf8(files.copyRecord));
  const facts = FactsPack.safeParse(factsRaw);
  const record = CopyRecord.safeParse(copyRaw);
  const hashes = { facts_sha256: sha256(files.factsPack), copy_sha256: sha256(files.copyRecord), page_html_sha256: sha256(files.pageHtml), page_css_sha256: sha256(files.pageCss) };

  const baseCodes: string[] = [];
  let sections: PageSection[] = [];
  let otherTexts: string[] = [];
  try {
    ({ sections, otherTexts } = pageText(utf8(files.pageHtml)));
  } catch {
    baseCodes.push("PAGE_UNREADABLE");
  }
  if (!facts.success) baseCodes.push("FACTS_PACK_INVALID");
  const factList = facts.success ? facts.data.facts : [];
  const base = checkArtifactCopy({
    texts: [...sections.flatMap((s) => s.entries.map((e) => e.text)), ...otherTexts],
    copyRecord: copyRaw,
    shopId: facts.success ? facts.data.shop_id : "",
    factsSha256: hashes.facts_sha256,
    facts: factList,
  });
  baseCodes.push(...base.findings.map((f) => f.code));
  const baseCodesUnique = [...new Set(baseCodes)].sort().slice(0, 80);
  const baseOk = baseCodesUnique.length === 0;

  // a record that does not parse is judged on the stricter lane
  const lane = record.success ? record.data.lane : "real_shop_proposal";
  const shopId = (record.success ? record.data.shop_id : facts.success ? facts.data.shop_id : "") || "_unknown";
  const entries = classify(sections, record.success ? record.data : null);
  const c = shopContext(factList);

  const findings: CopyQualityFinding[] = [];
  if (!baseOk)
    findings.push({
      code: "COPY_FACT_UNSUPPORTED",
      severity: "fail",
      rule: "base_check",
      location: null,
      texts: [],
      reason: "The existing facts pack / copy record checks fail; the audit reports that failure as it is and rates nothing above it.",
      evidence: baseCodesUnique.slice(0, 40),
    });
  const style = styleAndInformationFindings(entries, c, lane);
  findings.push(...style.findings);
  if (lane === "real_shop_proposal") {
    const prose = entries.filter((e) => e.kind === "prose");
    findings.push({
      code: "COPY_APPROVAL_MISSING",
      severity: "hold",
      rule: "real_shop_needs_owner_approval",
      location: null,
      texts: prose.map((e) => e.text.slice(0, 400)).slice(0, 40),
      reason: "Copy proposed for a real shop is never the shop's own words and never sent before the owner approves it (a separate record).",
      evidence: [`lane real_shop_proposal; ${prose.length} proposal_pending_review lines on the page`],
    });
  }
  const verdict = worstVerdict(findings.map((f) => f.severity));
  const factAxis = {
    score: !baseOk ? 0 : style.unsourcedStatements ? 2 : 5,
    evidence: [!baseOk ? `base checks fail: ${baseCodesUnique.slice(0, 10).join(", ")}` : "facts pack and copy record checks pass", `prose statements naming terms outside the facts: ${style.unsourcedStatements}`],
  };
  return CopyQualityReview.parse({
    schema: "copy_quality_review_v1",
    auditor_version: COPY_QUALITY_AUDITOR_VERSION,
    shop_id: shopId.slice(0, 80),
    lane,
    ...hashes,
    round: o.round ?? 0,
    base_checks: { ok: baseOk, codes: baseCodesUnique },
    sections: sections.map((s) => ({
      section_id: s.section_id.slice(0, 80),
      index: s.index,
      entries: entries.filter((e) => e.position.section === s.index).map((e) => ({ position: e.position, role: e.role, kind: e.kind, text: e.text.slice(0, 4000), copy_item_id: e.item?.id ?? null })),
    })),
    axes: { ...style.axes, fact_correctness: factAxis },
    findings,
    verdict,
    unresolved: [...new Set(findings.map((f) => f.code))].sort(),
  });
}

// ---- binding, rounds and sending ---------------------------------------------------------------------------------

const signature = (r: Pick<CopyQualityReview, "findings">) => r.findings.map((f) => `${f.code}|${f.severity}|${f.rule}|${f.location ? `${f.location.section}.${f.location.entry}` : "-"}`).sort();

/**
 * Is this stored review valid for these exact files? Recomputes every hash from the files and re-runs the audit
 * (rule L1): a changed facts pack, copy record, HTML or CSS, another shop, or findings / a verdict the audit does not
 * reproduce, all make it invalid. With `previous`, also checks the revision round (rules L2, L6): only a `revise`
 * review may be followed, by the next round, of a changed copy record, for the same shop and facts.
 */
export function checkCopyQualityReview(raw: unknown, files: CopyQualityFiles, o: { previous?: unknown } = {}): { ok: boolean; codes: string[] } {
  const p = CopyQualityReview.safeParse(raw);
  if (!p.success) return { ok: false, codes: ["REVIEW_SCHEMA"] };
  const r = p.data;
  const codes: string[] = [];
  if (r.facts_sha256 !== sha256(files.factsPack)) codes.push("REVIEW_STALE_FACTS");
  if (r.copy_sha256 !== sha256(files.copyRecord)) codes.push("REVIEW_STALE_COPY");
  if (r.page_html_sha256 !== sha256(files.pageHtml)) codes.push("REVIEW_STALE_PAGE_HTML");
  if (r.page_css_sha256 !== sha256(files.pageCss)) codes.push("REVIEW_STALE_PAGE_CSS");
  const again = reviewCopyQuality(files, { round: r.round });
  if (r.shop_id !== again.shop_id) codes.push("REVIEW_OF_ANOTHER_SHOP");
  if (r.lane !== again.lane) codes.push("REVIEW_LANE_MISMATCH");
  if (r.verdict !== again.verdict || JSON.stringify(signature(r)) !== JSON.stringify(signature(again))) codes.push("REVIEW_DOES_NOT_MATCH_AUDIT");
  if (o.previous !== undefined) {
    const q = CopyQualityReview.safeParse(o.previous);
    if (!q.success) codes.push("PREVIOUS_REVIEW_SCHEMA");
    else {
      if (q.data.verdict === "fail") codes.push("REVISION_AFTER_FAIL");
      else if (q.data.verdict !== "revise") codes.push("REVISION_AFTER_NON_REVISE");
      if (r.round !== q.data.round + 1) codes.push("REVISION_ROUND_OUT_OF_ORDER");
      if (q.data.shop_id !== r.shop_id || q.data.facts_sha256 !== r.facts_sha256) codes.push("REVISION_OF_ANOTHER_SHOP_OR_FACTS");
      if (q.data.copy_sha256 === r.copy_sha256) codes.push("REVISION_COPY_UNCHANGED");
    }
  } else if (r.round !== 0) codes.push("REVISION_WITHOUT_PREVIOUS");
  return { ok: codes.length === 0, codes };
}

/** What happens after a review: fail is terminal, hold waits for facts or the owner, revise only within the round cap. */
export function nextCopyStep(r: Pick<CopyQualityReview, "verdict" | "round">): "stop_fail" | "stop_hold" | "revise" | "owner_review" {
  if (r.verdict === "fail") return "stop_fail";
  if (r.verdict === "hold") return "stop_hold";
  if (r.verdict === "revise") return r.round < MAX_COPY_REVISION_ROUNDS ? "revise" : "stop_hold";
  return "owner_review";
}

/** The owner's approval of a page's copy: a separate record, never part of the review (its shape is the caller's). */
export type OwnerCopyApproval = { shop_id: string; facts_sha256: string; copy_sha256: string; page_html_sha256: string; page_css_sha256: string; decision: "approve" | "revise" | "reject" };

/**
 * Why the copy of this page may NOT be sent. `approve_candidate` alone is never enough: the review must be valid for
 * the exact files, pass (COPY_APPROVAL_MISSING aside, which only the owner's approval answers), be for a real shop,
 * and the owner's approval must exist for the same five inputs. An empty list means only that THIS gate does not
 * block; the design review, the sales send path and its own approvals still apply.
 */
export function copyGateSendBlockers(raw: unknown, files: CopyQualityFiles, ownerApproval: OwnerCopyApproval | null): string[] {
  const blockers: string[] = [];
  const check = checkCopyQualityReview(raw, files);
  if (!check.ok) blockers.push("REVIEW_INVALID", ...check.codes);
  const p = CopyQualityReview.safeParse(raw);
  if (p.success) {
    const r = p.data;
    if (r.lane === "quality_research_fictional") blockers.push("FICTIONAL_RESEARCH_NOT_SENDABLE");
    if (worstVerdict(r.findings.filter((f) => f.code !== "COPY_APPROVAL_MISSING").map((f) => f.severity)) !== "approve_candidate") blockers.push("REVIEW_NOT_PASSED");
    if (!ownerApproval) blockers.push("OWNER_APPROVAL_MISSING");
    else {
      const same = ownerApproval.shop_id === r.shop_id && ownerApproval.facts_sha256 === r.facts_sha256 && ownerApproval.copy_sha256 === r.copy_sha256 && ownerApproval.page_html_sha256 === r.page_html_sha256 && ownerApproval.page_css_sha256 === r.page_css_sha256;
      if (!same) blockers.push("OWNER_APPROVAL_FOR_OTHER_INPUTS");
      if (ownerApproval.decision !== "approve") blockers.push("OWNER_APPROVAL_NOT_APPROVE");
    }
  } else if (!ownerApproval) blockers.push("OWNER_APPROVAL_MISSING");
  return [...new Set(blockers)];
}

// ---- revisions (rule M2: no fact laundering) ---------------------------------------------------------------------

/** New prose that says what a fact says: holds a whole fact value, or most of its letter pairs come from one fact. */
export function restatesFact(text: string, facts: readonly Fact[]): string | null {
  const t = norm(text);
  const grams = bigrams(text);
  for (const f of facts) {
    if (f.key === "name" || f.key === "category") continue;
    const v = norm(f.value);
    if (v.length >= 4 && t.includes(v)) return f.id;
    if (!grams.length) continue;
    const vg = new Set(bigrams(f.value));
    const shared = grams.filter((g) => vg.has(g)).length;
    if (shared >= 4 && shared / grams.length >= 0.4) return f.id;
  }
  return null;
}

/**
 * A local revision of a copy record, against the record it revises: the same shop, lane and facts; no item changes
 * its claim_type; every fact item stays a verbatim whole-sentence selection of its source fact (re-selecting or
 * removing is allowed); no new or rewritten prose item restates a fact. Every finding is a FAIL.
 */
export function validateCopyRevision(oldRaw: unknown, newRaw: unknown, o: { facts: readonly Fact[] }): { ok: boolean; findings: Array<{ code: string; item?: string; detail?: string }> } {
  const a = CopyRecord.safeParse(oldRaw);
  const b = CopyRecord.safeParse(newRaw);
  if (!a.success || !b.success) return { ok: false, findings: [{ code: "REVISION_SCHEMA" }] };
  const f: Array<{ code: string; item?: string; detail?: string }> = [];
  if (a.data.shop_id !== b.data.shop_id) f.push({ code: "REVISION_SHOP_CHANGED" });
  if (a.data.lane !== b.data.lane) f.push({ code: "REVISION_LANE_CHANGED" });
  if (a.data.facts_sha256 !== b.data.facts_sha256) f.push({ code: "REVISION_FACTS_CHANGED" });
  const before = new Map(a.data.items.map((i) => [i.id, i]));
  const byId = new Map(o.facts.map((x) => [x.id, x.value]));
  for (const i of b.data.items) {
    const old = before.get(i.id);
    if (old && old.claim_type !== i.claim_type) f.push({ code: "REVISION_CLAIM_TYPE_CHANGED", item: i.id, detail: `${old.claim_type}->${i.claim_type}` });
    if (i.claim_type === "fact") {
      if (!i.source_fact_ids.some((s) => byId.has(s) && factParts(byId.get(s)!).has(norm(i.text)))) f.push({ code: "REVISION_FACT_NOT_VERBATIM", item: i.id });
    } else if (!old || norm(old.text) !== norm(i.text)) {
      const fact = restatesFact(i.text, o.facts);
      if (fact) f.push({ code: "REVISION_PROSE_RESTATES_FACT", item: i.id, detail: fact });
    }
  }
  return { ok: f.length === 0, findings: f };
}
