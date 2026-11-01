/**
 * DEV-143 (Issue #180, EXPERIMENTAL, opt-in): the common shop brief of the three-method study, WITHOUT visual DNA.
 *
 * The study compares who decides the look and the composition (Codex for VISUAL_FIRST / DIRECTION_FIRST, Claude for
 * LAYOUT_FIRST). A brief that already fixed the Design DNA would decide that variable outside the methods, so this
 * brief carries only the shop's intent and constraints: what the page is for, which facts it must show, and the
 * content rules. The schema has nowhere to put a DNA part, and its texts are refused when they name a visual choice
 * (a colour code, a DNA part, layout or type words). That word check is a guard against accidents, not a proof.
 *
 * This lane itself has no real port, no Codex, no image tool, no ledger and no file access. DEV-150 (Issue #180) wired
 * it into the existing real-call entries, by exact path only (the lane's isolation test lists them): the design prompt
 * (tm0), the image call (a page's picture), the direction call and its CLI, and the offline three-method steps CLI.
 * The offline pin CLI (scripts/research/three-methods-pins.ts) still imports it too.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { DNA_PARTS, FactsPack, Text } from "../artifact/schema";

export { DNA_PARTS, FactsPack, Text };

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** A prompt as the owner approves it: its exact text, SHA-256 (UTF-8) and length in UTF-16 code units (as the live steps count). */
export type BuiltPrompt = { prompt: string; sha256: string; chars: number };
export const built = (prompt: string): BuiltPrompt => ({ prompt, sha256: sha256(prompt), chars: prompt.length });

const FactId = z.string().regex(/^F\d{1,3}$/);

/** Words that would carry a visual direction into the brief (heuristic). */
export const VISUAL_WORDS = /#[0-9a-f]{3,8}\b|\b(?:hero|typography|palette|product_visual|section_rhythm|navigation|layout|font|colou?r)\b|配色|色調|書体|フォント|構図|レイアウト|余白/i;
const Plain = (max: number) => Text(max).refine((s) => !VISUAL_WORDS.test(s), "visual_direction");

export const ThreeMethodBrief = z.strictObject({
  schema: z.literal("three_method_brief_v0"),
  shop_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/),
  /** What is made: one page, at both widths. */
  page: Plain(200),
  /** What the page is for (intent only; never how it looks). */
  intent: Plain(600),
  /** Facts every page must show (the study: the same facts, all of them, in every method). */
  must_show_fact_ids: z.array(FactId).min(1).max(200),
  /** Rules for the words on the page (facts verbatim or short neutral labels, nothing invented). */
  content_rules: z.array(Plain(300)).min(1).max(12),
  /** Things the page must not do, other than visual ones. */
  avoid: z.array(Plain(200)).max(12),
});
export type ThreeMethodBrief = z.infer<typeof ThreeMethodBrief>;

/** The brief and the facts pack checked together: same shop, every named fact exists, no fact named twice. */
export function checkBrief(brief: unknown, facts: unknown): { ok: true; brief: ThreeMethodBrief; facts: FactsPack } | { ok: false; code: string } {
  const f = FactsPack.safeParse(facts);
  if (!f.success) return { ok: false, code: "FACTS_INVALID" };
  const b = ThreeMethodBrief.safeParse(brief);
  if (!b.success) return { ok: false, code: b.error.issues.some((i) => i.message === "visual_direction") ? "BRIEF_HAS_VISUAL_DIRECTION" : "BRIEF_INVALID" };
  if (b.data.shop_id !== f.data.shop_id) return { ok: false, code: "BRIEF_SHOP_MISMATCH" };
  const ids = new Set(f.data.facts.map((x) => x.id));
  if (new Set(b.data.must_show_fact_ids).size !== b.data.must_show_fact_ids.length) return { ok: false, code: "BRIEF_INVALID" };
  if (b.data.must_show_fact_ids.some((id) => !ids.has(id))) return { ok: false, code: "BRIEF_FACT_UNKNOWN" };
  return { ok: true, brief: b.data, facts: f.data };
}

/** The facts as every prompt of the lane quotes them (the same projection as the existing design prompt). */
export const factsJson = (facts: FactsPack) => JSON.stringify(facts.facts.map((f) => ({ id: f.id, key: f.key, value: f.value })));
