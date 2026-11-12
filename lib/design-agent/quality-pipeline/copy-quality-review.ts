/**
 * DEV-199a (owner Issue #258, spec PR #257 docs/design/copy-authenticity-quality-gate.md, and the rules of the spec's
 * independent review): the copy quality audit, a sidecar `copy_quality_review_v1` beside a comp's `comp_copy_v1`.
 *
 * NOT WIRED IN. Nothing calls this yet (DEV-199b connects it). It decides nothing about a real page today.
 *
 * What it does
 *   1. Runs the existing checks unchanged and wraps their result: the facts pack schema (facts-pack.ts), the server's
 *      own HTML / CSS check (lib/sales/demo-version/html-safety.ts checkArtifactHtml: everything it refuses is refused
 *      here, CSS-generated text included) and the artifact copy check (lib/sales/demo-version/copy-check.ts:
 *      checkCopyRecord + every visible text in the record + no joined text looking like a fact). Every text the
 *      server's extractor finds must be covered by a text this audit reads (PAGE_TEXT_NOT_COVERED otherwise), so SVG,
 *      MathML, <noscript> or template text cannot slip past (PR #259 review H1). Any failure there is
 *      `COPY_FACT_UNSUPPORTED` with severity `fail`, and the verdict is `fail`: nothing in this audit can rate a page
 *      better than those checks do.
 *   2. Reads the page's sections and roles from its DOM (./copy-quality-page.ts, rule L5) and ties each text to its
 *      copy-record item: a verbatim `fact`, a fact's `label`, or prose (`creative_expression` /
 *      `proposal_pending_review`).
 *   3. Judges only the prose with structural, deterministic signals (never a word blacklist):
 *        - slogan-shaped lines: a short prose line that ends in 。/！ or is cut at a comma into a fragment
 *          (…、…へ / …に / …ずつ). Polite explanatory sentences (…ます。) are not slogans.
 *        - poetic headings: a short noun-phrase heading with no 。 that names nothing from the shop's facts (fails the
 *          name-swap test) and is not a plain label (…のご案内, …について, メニュー, アクセス …) counts as a slogan
 *          too (review M5: 「朝の光」「棚の記憶」).
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
 *   4. Checks what information the page carries: offering (any fact beyond who / where / when, whatever its key),
 *      hours and location. Missing from the facts pack → HOLD (nothing is invented). In the facts but not on the page
 *      → REVISE. A non-hero section with prose but no fact → REVISE.
 *   5. A prose line with a claim-like sign (CLAIM_SIGNS: the copy-record categories plus routine / frequency and
 *      making method, e.g. 毎朝, 自家製) whose wording the facts do not hold is COPY_FACT_UNSUPPORTED with severity
 *      `hold`. Hospitality lines (ご来店をお待ちしております。) raise nothing (review M4).
 *   6. Lanes (rule M5): `quality_research_fictional` gets the full style audit. `real_shop_proposal` is judged only on
 *      which facts and labels are shown and how; its prose is never judged as the shop's own words, and the lane
 *      always carries COPY_APPROVAL_MISSING (HOLD).
 *
 * Verdict: the worst severity of the findings, fail > hold > revise; none → approve_candidate. `fail` is terminal
 * (rule L2): it is not revised into a pass. The five axis scores (0–5) are supporting signals; no score decides the
 * verdict. `approve_candidate` never means sendable (copyGateSendBlockers): the owner's approval is a separate record.
 *
 * Binding (rule L1): a review holds the sha256 of the facts pack, the copy record, the page HTML and its CSS, and the
 * auditor version, and from round 1 the previous round's copy sha256. checkCopyQualityReview recomputes the hashes
 * from the files at check time, re-runs the audit and compares the WHOLE record (axes, base checks, sections, findings
 * with their evidence); any difference makes the review invalid, so an old PASS is never reused for a changed page.
 *
 * Revisions (rules M2, L6): each round after the first must come with the earlier rounds (review, copy record, page),
 * linked by hash; every step must pass validateCopyRevision, which refuses fact laundering as FAIL (a changed
 * claim_type, a fact not verbatim, new prose making a claim, a deleted fact replaced by prose in its section) and
 * grades a prose heading that only echoes a fact term as REVISE. At most MAX_COPY_REVISION_ROUNDS rounds.
 *
 * Pure apart from sha256 (node:crypto). No network, no model call.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { checkArtifactCopy } from "@/lib/sales/demo-version/copy-check";
import { checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";
import { CopyRecord, factParts, INVENTED_FACT_SIGNS, type CopyItem } from "./copy-record";
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

/** Facts that say only who, where and when: a pack with nothing else has no material for shop-specific copy. */
export const NON_MATERIAL_KEYS = /^(name|category|ward|address|hours|closed_days|access|phone)$/;
/**
 * The information a visitor looks for, by the facts that hold it. The offering is any fact beyond who / where / when
 * (services, products, menus, statements, a workshop …), whatever its key is called (review L2): a pack is not read as
 * offering nothing just because its keys are named differently.
 */
export const INFORMATION_FAMILIES: ReadonlyArray<readonly [family: string, holds: (key: string) => boolean, describe: string]> = [
  ["offering", (k) => !NON_MATERIAL_KEYS.test(k), `any key but ${NON_MATERIAL_KEYS.source}`],
  ["hours", (k) => k === "hours", "hours"],
  ["location", (k) => k === "address" || k === "access", "address | access"],
];
/**
 * Claim-like signs in prose (review M4): the copy-record categories, reused unchanged, plus a routine or frequency and
 * a making method — claims about what the shop does that copy-record's tripwire does not cover. A prose line with one
 * of these whose wording the facts do not hold is HOLD; any other prose raises nothing on the fact path.
 */
export const CLAIM_SIGNS: ReadonlyArray<readonly [string, RegExp]> = [
  ...INVENTED_FACT_SIGNS,
  ["routine_or_frequency", /毎(朝|晩|夜|週|月|年|回)|[週月日年]に[一二三四五六七八九十何数0-9]/],
  ["making_method", /自家製|手作り|手づくり|手焼き|手ごね|石窯|直火|焙煎|仕込/],
];
/** Headings that say plainly what a section holds; never counted as poetic (review M5). */
export const PLAIN_HEADING = /(案内|について|紹介|一覧|メニュー|アクセス|営業時間|定休日|店舗情報|お知らせ|料金|地図|所在地|住所|連絡先|問い合わせ|よくある質問|サービス|商品|ギャラリー|写真|概要|内容|流れ)$/;
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
    /** the copy record the previous round reviewed (null in round 0): the link of the revision chain */
    previous_copy_sha256: Sha.nullable(),
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
    if ((r.round === 0) !== (r.previous_copy_sha256 === null)) bad("previous_copy_sha_and_round_disagree");
    if (r.previous_copy_sha256 !== null && r.previous_copy_sha256 === r.copy_sha256) bad("revision_without_change");
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
export type ShopContext = { facts: readonly Fact[]; corpus: string; allFacts: string; nameStrings: string[]; hasMaterial: boolean };

export function shopContext(facts: readonly Fact[]): ShopContext {
  const name = facts.find((f) => f.key === "name")?.value ?? "";
  // the full name and its space-separated parts of two or more characters (one character, e.g. 輪, also sits inside 車輪)
  const nameStrings = [norm(name), ...name.split(/ +/).map(norm).filter((p) => p.length >= 2)].filter(Boolean).sort((a, b) => b.length - a.length);
  const corpus = facts.filter((f) => f.key !== "name" && f.key !== "category").map((f) => norm(f.value)).join("\u0000");
  const allFacts = facts.map((f) => norm(f.value)).join("\u0000");
  return { facts, corpus, allFacts, nameStrings, hasMaterial: facts.some((f) => !NON_MATERIAL_KEYS.test(f.key)) };
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

/** A short noun-phrase heading with no 。 that names nothing from the shop's facts and is no plain label (review M5). */
export function isPoeticHeading(text: string, c: ShopContext): boolean {
  const n = norm(text);
  if (!n || n.length > 12 || /[、。!?]/.test(n) || isPolite(n) || PLAIN_HEADING.test(n)) return false;
  return isSwappable(text, c);
}

/** Words of routine that are rhetoric in a slogan (素敵な毎日へ) and a claim only in a sentence (毎日焼きます。). */
const ROUTINE_IN_STATEMENT = /毎日|いつも|必ず/;

/** The claim-like signs (CLAIM_SIGNS) in a line whose matched wording no fact of the shop holds. */
export function unsourcedClaimSigns(text: string, c: ShopContext): string[] {
  const n = norm(text);
  // a plain section label (メニュー, 営業時間) names a kind of information; it claims nothing
  if (n.length <= 10 && PLAIN_HEADING.test(n) && !/[0-9]/.test(n)) return [];
  const unsourced = (re: RegExp) => {
    const m = n.match(re);
    return m !== null && !c.allFacts.includes(norm(m[0]));
  };
  const out = CLAIM_SIGNS.filter(([, re]) => unsourced(re)).map(([name]) => name);
  if (isStatement(text) && unsourced(ROUTINE_IN_STATEMENT)) out.push("routine_in_statement");
  return out;
}

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

  // -- claim-like prose the facts do not hold (both lanes; review M4: only claim-like signs, never hospitality lines)
  let unsourcedStatements = 0;
  for (const e of prose) {
    const signs = unsourcedClaimSigns(e.text, c);
    if (!signs.length) continue;
    unsourcedStatements++;
    findings.push({
      code: "COPY_FACT_UNSUPPORTED",
      severity: "hold",
      rule: "claim_sign_outside_facts",
      location: e.position,
      texts: [e.text.slice(0, 400)],
      reason: "A prose line makes a claim-like statement (routine, method, price, years, reservation …) that the shop's facts do not hold; it is not invented, it waits for a sourced fact.",
      evidence: [quote(e), `claim signs without a fact: ${signs.join(", ")}`],
    });
  }

  // -- information: what the facts hold and what the page shows
  const shownFactIds = new Set(entries.filter((e) => e.kind === "fact" && e.item?.claim_type === "fact").flatMap((e) => e.item!.source_fact_ids));
  const familyGaps: string[] = [];
  for (const [family, holds, describe] of INFORMATION_FAMILIES) {
    const inPack = c.facts.filter((f) => holds(f.key));
    if (!inPack.length) {
      familyGaps.push(family);
      findings.push({
        code: "COPY_INFORMATION_MISSING",
        severity: "hold",
        rule: `facts_missing_${family}`,
        location: null,
        texts: [],
        reason: `The facts pack holds no ${family} information; the copy must not invent it, so the page waits for a sourced fact.`,
        evidence: [`no fact key matches ${describe}`],
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
  const sloganLike = (e: AuditEntry) => isSloganShaped(e.text) || (e.role === "heading" && isPoeticHeading(e.text, c));
  const headline = prose.filter((e) => e.section_id !== heroId && e.section_id !== OUTSIDE_SECTIONS && (e.role === "heading" || isSloganShaped(e.text)));
  const slogans = headline.filter(sloganLike);
  const sloganSections = new Set(slogans.map((e) => e.section_id));
  const heroSlogans = prose.filter((e) => e.section_id === heroId && sloganLike(e));
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

/** Options that change what the audit sees; the same ones must be passed when a review is checked. */
export type ReviewOptions = {
  /** 0 for the first audit; a revision round also names the copy record it revises */
  round?: number;
  previousCopySha256?: string | null;
  /** the photo URLs the page may reference (as the server's check takes them); none by default */
  photoUrls?: ReadonlySet<string>;
};

/** Codes from checkArtifactHtml that mean the page was not parsed to the end (no section reading after them). */
const PARSE_LIMIT = /^(HTML_TOO_|VALIDATION_BUDGET_EXCEEDED)/;

/** The audit of one page: the existing checks wrapped, then style and information (see the file comment). */
export function reviewCopyQuality(files: CopyQualityFiles, o: ReviewOptions = {}): CopyQualityReview {
  const factsRaw = parseJson(utf8(files.factsPack));
  const copyRaw = parseJson(utf8(files.copyRecord));
  const facts = FactsPack.safeParse(factsRaw);
  const record = CopyRecord.safeParse(copyRaw);
  const hashes = { facts_sha256: sha256(files.factsPack), copy_sha256: sha256(files.copyRecord), page_html_sha256: sha256(files.pageHtml), page_css_sha256: sha256(files.pageCss) };
  const html = utf8(files.pageHtml);

  const baseCodes: string[] = [];
  // the server's own HTML / CSS check: whatever it refuses is refused here, and its texts are the ones that count
  const safety = checkArtifactHtml(html, utf8(files.pageCss), o.photoUrls ?? new Set());
  baseCodes.push(...safety.findings.map((f) => f.code));
  let sections: PageSection[] = [];
  let otherTexts: string[] = [];
  if (!safety.findings.some((f) => PARSE_LIMIT.test(f.code)))
    try {
      ({ sections, otherTexts } = pageText(html));
    } catch {
      baseCodes.push("PAGE_UNREADABLE");
    }
  const read = [...sections.flatMap((s) => s.entries.map((e) => e.text)), ...otherTexts];
  // every text node the server finds must sit inside a text this audit reads (blocks join what <wbr> splits)
  const readNorm = read.map(norm);
  if (safety.texts.some((t) => !readNorm.some((r) => r.includes(norm(t))))) baseCodes.push("PAGE_TEXT_NOT_COVERED");
  if (!facts.success) baseCodes.push("FACTS_PACK_INVALID");
  const factList = facts.success ? facts.data.facts : [];
  const base = checkArtifactCopy({ texts: read, copyRecord: copyRaw, shopId: facts.success ? facts.data.shop_id : "", factsSha256: hashes.facts_sha256, facts: factList });
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
      reason: "The existing facts pack / HTML / copy record checks fail; the audit reports that failure as it is and rates nothing above it.",
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
    evidence: [!baseOk ? `base checks fail: ${baseCodesUnique.slice(0, 10).join(", ")}` : "facts pack, HTML and copy record checks pass", `prose lines with a claim sign the facts do not hold: ${style.unsourcedStatements}`],
  };
  return CopyQualityReview.parse({
    schema: "copy_quality_review_v1",
    auditor_version: COPY_QUALITY_AUDITOR_VERSION,
    shop_id: shopId.slice(0, 80),
    lane,
    ...hashes,
    round: o.round ?? 0,
    previous_copy_sha256: o.previousCopySha256 ?? null,
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

/** JSON with object keys sorted, so two records compare by content, not by key order. */
const canonical = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** An earlier round of the revision chain: its review, and the copy record and page it reviewed (matched by hash). */
export type PriorRound = { review: unknown; copyRecord: string | Uint8Array; pageHtml: string | Uint8Array };
export type CheckOptions = { previous?: readonly PriorRound[]; photoUrls?: ReadonlySet<string> };

/**
 * Is this stored review valid for these exact files? Recomputes every hash from the files, re-runs the audit and
 * compares the whole record (rule L1, review L1): a changed facts pack, copy record, HTML or CSS, another shop, or any
 * field the audit does not reproduce (axes, base checks, sections, findings with their evidence) makes it invalid.
 *
 * A review of round n must come with rounds 0 … n-1 (`previous`, in order). Each earlier review must be a `revise`
 * (COPY_APPROVAL_MISSING aside, see copyVerdict) of the same shop and facts, its copy record and page must match its hashes, each round must name the copy record of
 * the one before (`previous_copy_sha256`), and each step must pass validateCopyRevision (review M1, M2). A `fail` is
 * terminal: nothing follows it.
 */
export function checkCopyQualityReview(raw: unknown, files: CopyQualityFiles, o: CheckOptions = {}): { ok: boolean; codes: string[] } {
  const p = CopyQualityReview.safeParse(raw);
  if (!p.success) return { ok: false, codes: ["REVIEW_SCHEMA"] };
  const r = p.data;
  const codes: string[] = [];
  if (r.facts_sha256 !== sha256(files.factsPack)) codes.push("REVIEW_STALE_FACTS");
  if (r.copy_sha256 !== sha256(files.copyRecord)) codes.push("REVIEW_STALE_COPY");
  if (r.page_html_sha256 !== sha256(files.pageHtml)) codes.push("REVIEW_STALE_PAGE_HTML");
  if (r.page_css_sha256 !== sha256(files.pageCss)) codes.push("REVIEW_STALE_PAGE_CSS");
  const again = reviewCopyQuality(files, { round: r.round, previousCopySha256: r.previous_copy_sha256, photoUrls: o.photoUrls });
  if (r.shop_id !== again.shop_id) codes.push("REVIEW_OF_ANOTHER_SHOP");
  if (r.lane !== again.lane) codes.push("REVIEW_LANE_MISMATCH");
  if (canonical(r) !== canonical(again)) codes.push("REVIEW_DOES_NOT_MATCH_AUDIT");
  codes.push(...chainCodes(r, files, o.previous ?? []));
  return { ok: codes.length === 0, codes: [...new Set(codes)] };
}

function chainCodes(r: CopyQualityReview, files: CopyQualityFiles, previous: readonly PriorRound[]): string[] {
  if (r.round === 0) return previous.length ? ["REVISION_CHAIN_FOR_ROUND_0"] : [];
  if (!previous.length) return ["REVISION_WITHOUT_PREVIOUS"];
  if (previous.length !== r.round) return ["REVISION_CHAIN_LENGTH"];
  const codes: string[] = [];
  const facts = FactsPack.safeParse(parseJson(utf8(files.factsPack)));
  const factList = facts.success ? facts.data.facts : [];
  const steps = [...previous.map((x) => ({ review: CopyQualityReview.safeParse(x.review), copyRecord: x.copyRecord, pageHtml: x.pageHtml })), { review: { success: true as const, data: r }, copyRecord: files.copyRecord, pageHtml: files.pageHtml }];
  for (let i = 0; i < previous.length; i++) {
    const cur = steps[i]!;
    const next = steps[i + 1]!;
    if (!cur.review.success) {
      codes.push("PREVIOUS_REVIEW_SCHEMA");
      continue;
    }
    const q = cur.review.data;
    if (q.round !== i) codes.push("REVISION_ROUND_OUT_OF_ORDER");
    const v = copyVerdict(q);
    if (v === "fail") codes.push("REVISION_AFTER_FAIL");
    else if (v !== "revise") codes.push("REVISION_AFTER_NON_REVISE");
    if (q.shop_id !== r.shop_id || q.facts_sha256 !== r.facts_sha256 || q.lane !== r.lane) codes.push("REVISION_OF_ANOTHER_SHOP_OR_FACTS");
    if (sha256(cur.copyRecord) !== q.copy_sha256) codes.push("PREVIOUS_COPY_DOES_NOT_MATCH_REVIEW");
    if (sha256(cur.pageHtml) !== q.page_html_sha256) codes.push("PREVIOUS_PAGE_DOES_NOT_MATCH_REVIEW");
    if (next.review.success && next.review.data.previous_copy_sha256 !== q.copy_sha256) codes.push("REVISION_CHAIN_BROKEN");
    const step = validateCopyRevision(parseJson(utf8(cur.copyRecord)), parseJson(utf8(next.copyRecord)), { facts: factList, oldPageHtml: utf8(cur.pageHtml), newPageHtml: utf8(next.pageHtml) });
    if (step.verdict === "fail") codes.push("REVISION_INVALID", ...step.findings.filter((f) => f.severity === "fail").map((f) => f.code));
  }
  return codes;
}

/**
 * The verdict with COPY_APPROVAL_MISSING set aside: what the copy itself earns. Only the owner's approval answers that
 * one hold, so a real-shop page whose copy is otherwise clean goes to the owner, and one with a style problem may be
 * revised like any other.
 */
export function copyVerdict(r: Pick<CopyQualityReview, "findings">): Verdict {
  return worstVerdict(r.findings.filter((f) => f.code !== "COPY_APPROVAL_MISSING").map((f) => f.severity));
}

/** What happens after a review: fail is terminal, hold waits for facts, revise only within the round cap, then the owner. */
export function nextCopyStep(r: Pick<CopyQualityReview, "verdict" | "round"> & Partial<Pick<CopyQualityReview, "findings">>): "stop_fail" | "stop_hold" | "revise" | "owner_review" {
  const v = r.findings ? copyVerdict({ findings: r.findings }) : r.verdict;
  if (v === "fail") return "stop_fail";
  if (v === "hold") return "stop_hold";
  if (v === "revise") return r.round < MAX_COPY_REVISION_ROUNDS ? "revise" : "stop_hold";
  return "owner_review";
}

/** The owner's approval of a page's copy: a separate record, never part of the review (its shape is the caller's). */
export type OwnerCopyApproval = { shop_id: string; facts_sha256: string; copy_sha256: string; page_html_sha256: string; page_css_sha256: string; decision: "approve" | "revise" | "reject" };

/**
 * Why the copy of this page may NOT be sent. `approve_candidate` alone is never enough: the review must be valid for
 * the exact files (with its whole revision chain from round 1 on), pass (COPY_APPROVAL_MISSING aside, which only the
 * owner's approval answers), be for a real shop, and the owner's approval must exist for the same five inputs. An
 * empty list means only that THIS gate does not block; the design review, the sales send path and its own approvals
 * still apply.
 */
export function copyGateSendBlockers(raw: unknown, files: CopyQualityFiles, ownerApproval: OwnerCopyApproval | null, o: CheckOptions = {}): string[] {
  const blockers: string[] = [];
  const check = checkCopyQualityReview(raw, files, o);
  if (!check.ok) blockers.push("REVIEW_INVALID", ...check.codes);
  const p = CopyQualityReview.safeParse(raw);
  if (p.success) {
    const r = p.data;
    if (r.lane === "quality_research_fictional") blockers.push("FICTIONAL_RESEARCH_NOT_SENDABLE");
    if (copyVerdict(r) !== "approve_candidate") blockers.push("REVIEW_NOT_PASSED");
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

/** Prose that says what a fact says: holds a whole fact value, or most of its letter pairs come from one fact. */
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

export type RevisionFinding = { code: string; severity: "fail" | "revise"; item?: string; detail?: string };

/**
 * A local revision of a copy record, against the record it revises (review M2, M3). FAIL (terminal):
 *  - another shop, lane or facts SHA; an item whose claim_type changed;
 *  - a fact item that is not a verbatim whole-sentence selection of its source fact (re-selecting or removing is fine);
 *  - new or rewritten prose that makes a claim: a sentence (…ます。/ …る。, synonyms of a fact included — a
 *    paraphrase is caught by its form, not by its words) or a claim-like sign (CLAIM_SIGNS);
 *  - with both pages: a fact item removed and new prose put in the section where it stood (a fact re-added as prose
 *    under a new id).
 * REVISE (not terminal; the audit then judges the line): a new prose heading that only echoes a fact's words with no
 * claim (「パンク修理の相談」「振れ取りで車輪をまっすぐに」).
 */
export function validateCopyRevision(oldRaw: unknown, newRaw: unknown, o: { facts: readonly Fact[]; oldPageHtml?: string; newPageHtml?: string }): { ok: boolean; verdict: "ok" | "revise" | "fail"; findings: RevisionFinding[] } {
  const a = CopyRecord.safeParse(oldRaw);
  const b = CopyRecord.safeParse(newRaw);
  if (!a.success || !b.success) return { ok: false, verdict: "fail", findings: [{ code: "REVISION_SCHEMA", severity: "fail" }] };
  const f: RevisionFinding[] = [];
  if (a.data.shop_id !== b.data.shop_id) f.push({ code: "REVISION_SHOP_CHANGED", severity: "fail" });
  if (a.data.lane !== b.data.lane) f.push({ code: "REVISION_LANE_CHANGED", severity: "fail" });
  if (a.data.facts_sha256 !== b.data.facts_sha256) f.push({ code: "REVISION_FACTS_CHANGED", severity: "fail" });
  const before = new Map(a.data.items.map((i) => [i.id, i]));
  const byId = new Map(o.facts.map((x) => [x.id, x.value]));
  const c = shopContext(o.facts);
  const changedProse = new Set<string>();
  for (const i of b.data.items) {
    const old = before.get(i.id);
    if (old && old.claim_type !== i.claim_type) f.push({ code: "REVISION_CLAIM_TYPE_CHANGED", severity: "fail", item: i.id, detail: `${old.claim_type}->${i.claim_type}` });
    if (i.claim_type === "fact") {
      if (!i.source_fact_ids.some((s) => byId.has(s) && factParts(byId.get(s)!).has(norm(i.text)))) f.push({ code: "REVISION_FACT_NOT_VERBATIM", severity: "fail", item: i.id });
      continue;
    }
    if (old && norm(old.text) === norm(i.text) && old.claim_type === i.claim_type) continue;
    changedProse.add(norm(i.text));
    const fact = restatesFact(i.text, o.facts);
    const signs = unsourcedClaimSigns(i.text, c);
    if (isStatement(i.text) || signs.length) f.push({ code: fact ? "REVISION_PROSE_RESTATES_FACT" : "REVISION_NEW_PROSE_CLAIM", severity: "fail", item: i.id, ...(fact ? { detail: fact } : signs.length ? { detail: signs.join(",") } : {}) });
    else if (fact) f.push({ code: "REVISION_PROSE_ECHOES_FACT", severity: "revise", item: i.id, detail: fact });
  }
  // a fact removed and prose put where it stood
  if (o.oldPageHtml !== undefined && o.newPageHtml !== undefined) {
    const kept = new Set(b.data.items.filter((i) => i.claim_type === "fact").map((i) => norm(i.text)));
    const removed = new Set(a.data.items.filter((i) => i.claim_type === "fact" && !kept.has(norm(i.text))).map((i) => norm(i.text)));
    if (removed.size && changedProse.size) {
      try {
        const oldSections = pageText(o.oldPageHtml).sections;
        const newSections = pageText(o.newPageHtml).sections;
        const where = new Set(oldSections.filter((s) => s.entries.some((e) => removed.has(norm(e.text)))).map((s) => s.section_id));
        for (const s of newSections)
          if (where.has(s.section_id)) for (const e of s.entries) if (changedProse.has(norm(e.text))) f.push({ code: "REVISION_FACT_REPLACED_BY_PROSE", severity: "fail", detail: s.section_id.slice(0, 40) });
      } catch {
        f.push({ code: "REVISION_PAGE_UNREADABLE", severity: "fail" });
      }
    }
  }
  const verdict = f.some((x) => x.severity === "fail") ? "fail" : f.length ? "revise" : "ok";
  return { ok: verdict !== "fail", verdict, findings: f };
}
