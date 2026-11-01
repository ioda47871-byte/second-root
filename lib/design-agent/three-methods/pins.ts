/**
 * DEV-143 (EXPERIMENTAL, opt-in): every prompt of the three-method pilot and its pin (SHA-256, length), from the
 * study's inputs. What the owner would compare with an approval. Pure: the caller reads the files.
 *
 * VISUAL_FIRST has two candidate design prompts (route B: no image; route C: exactly one image since DEV-150). The
 * owner's provisional pilot policy uses route C; both are printed so the comparison pin stays visible.
 */
import { checkBrief, sha256 } from "./brief";
import { buildDirectionPrompt, directionJsonSchema } from "./direction";
import { buildPageAssetRequests, type PageMethod } from "./page-assets";
import { buildVisualFirstPrompt } from "./visual-first";

export type Pin = {
  id: string;
  method: "VISUAL_FIRST" | "LAYOUT_FIRST" | "DIRECTION_FIRST";
  purpose: "design" | "direction" | "asset";
  /** The receipt's kind and route this call would have (today's for design; the proposed ones otherwise). */
  kind: string;
  route: string;
  answer_schema: string;
  answer_schema_sha256: string | null;
  prompt_sha256: string;
  prompt_chars: number;
  /** For a page asset: the page it was asked for by. */
  page?: { path: string; html_sha256: string; asset_id: string; essential: boolean; measured: boolean };
};

export type PilotPins = { ok: true; pins: Pin[] } | { ok: false; code: string };

export function pilotPins(o: { facts: unknown; brief: unknown; pages?: { method: PageMethod; path: string; html: string }[] }): PilotPins {
  const c = checkBrief(o.brief, o.facts);
  if (!c.ok) return c;
  const pins: Pin[] = [];
  for (const route of ["B_html_prototype", "C_hybrid"] as const) {
    const b = buildVisualFirstPrompt({ route, facts: c.facts, brief: c.brief });
    pins.push({ id: `VISUAL_FIRST.design.${route}`, method: "VISUAL_FIRST", purpose: "design", kind: "design", route, answer_schema: "codex_design_v1", answer_schema_sha256: null, prompt_sha256: b.sha256, prompt_chars: b.chars });
  }
  const d = buildDirectionPrompt({ facts: c.facts, brief: c.brief });
  pins.push({ id: "DIRECTION_FIRST.direction", method: "DIRECTION_FIRST", purpose: "direction", kind: "direction", route: "direction_text", answer_schema: "three_method_direction_v0", answer_schema_sha256: sha256(JSON.stringify(directionJsonSchema())), prompt_sha256: d.sha256, prompt_chars: d.chars });
  for (const page of o.pages ?? []) {
    const r = buildPageAssetRequests({ method: page.method, page: { path: page.path, html: page.html }, facts: c.facts });
    if (!r.ok) return r;
    for (const q of r.requests) {
      pins.push({ id: `${page.method}.asset.${q.asset_id}`, method: page.method, purpose: "asset", kind: "page_image", route: "claude_page", answer_schema: "png", answer_schema_sha256: null, prompt_sha256: q.prompt_sha256, prompt_chars: q.prompt_chars, page: { path: q.page.path, html_sha256: q.page.html_sha256, asset_id: q.asset_id, essential: q.essential, measured: q.placement !== null } });
    }
  }
  return { ok: true, pins };
}
