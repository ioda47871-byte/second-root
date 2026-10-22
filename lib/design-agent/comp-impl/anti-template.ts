/**
 * The anti-template guard (DEV-082): a comp implementation must be a page of
 * its own, not an existing demo template or the profile renderer's markup with
 * a few changes. Three tripwires, each cheap and each easy to explain:
 *
 * 1. markers: the page carries none of the renderer's hooks (#shop-css,
 *    data-shop-css, data-kind, data-variant, data-ground, data-first-view …)
 *    and no class name of the demo templates' CSS modules;
 * 2. CSS reuse: the share of the page's rule bodies that also occur in the
 *    templates' CSS modules (components/demo/**.module.css, read as text);
 * 3. structure: the distance between the page's structural fingerprint
 *    (page-scripts.ts FINGERPRINT_SCRIPT: tag-path features and top-level
 *    block trees) and every reference fingerprint (template-fingerprints.json:
 *    the three demo templates and the profile renderer under every direction,
 *    regenerated and compared by a test).
 *
 * Limits (also in docs/operations/comp-to-site.md): a determined copier can
 * rename classes, rewrite declarations and wrap elements to move every number,
 * so passing these is evidence, not proof; failing them is a strong signal.
 * The real guard is the process: the page is written from the comp and its
 * spec, and a person looks at the result next to the comp.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Fingerprint } from "./page-scripts";

/** Below this structural distance to any reference the page counts as a template variant. */
export const ANTI_TEMPLATE_MIN_DISTANCE = 0.35;
/** Above this share of rule bodies found in the templates' CSS the page counts as reusing it. */
export const CSS_REUSE_MAX_SHARE = 0.2;
/** Rule bodies shorter than this many declarations are too generic to count (e.g. `margin: 0`). */
const MIN_DECLARATIONS = 3;

export const RENDERER_MARKERS = /\bid\s*=\s*["']?shop-css\b|data-shop-css|data-kind\s*=|data-variant\s*=|data-ground\s*=|data-first-view\s*=|data-scale\s*=|data-headings\s*=|data-fv\s*=|data-key\s*=|data-sr-/;

export type ReferenceFingerprint = { id: string; fingerprint: Fingerprint };

function editDistance(a: readonly string[], b: readonly string[]): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** 0 = the same structure, 1 = nothing in common: half the weighted Jaccard distance of the features, half the block sequence's edit distance. */
export function fingerprintDistance(a: Fingerprint, b: Fingerprint): number {
  const keys = new Set([...Object.keys(a.features), ...Object.keys(b.features)]);
  let min = 0;
  let max = 0;
  for (const k of keys) {
    const x = a.features[k] ?? 0;
    const y = b.features[k] ?? 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  const jaccard = max === 0 ? 0 : 1 - min / max;
  const longest = Math.max(a.blocks.length, b.blocks.length);
  const blocks = longest === 0 ? 0 : editDistance(a.blocks, b.blocks) / longest;
  return Math.round(((jaccard + blocks) / 2) * 1000) / 1000;
}

export function nearestReference(page: Fingerprint, refs: readonly ReferenceFingerprint[]): { id: string; distance: number } {
  let best = { id: "none", distance: 1 };
  for (const r of refs) {
    const d = fingerprintDistance(page, r.fingerprint);
    if (d < best.distance) best = { id: r.id, distance: d };
  }
  return best;
}

/** The normalized declaration blocks of a stylesheet (innermost { … } blocks; declarations trimmed, lower-cased, sorted), with at least MIN_DECLARATIONS each. */
export function ruleBodies(css: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\{([^{}]*)\}/g)) {
    const decls = m[1]!
      .split(";")
      .map((d) => d.replace(/\s+/g, " ").trim().toLowerCase())
      .filter((d) => d.includes(":"));
    if (decls.length >= MIN_DECLARATIONS) out.push(decls.sort().join(";"));
  }
  return out;
}

/** The demo templates' CSS modules (read as text; nothing is imported). */
export async function templateCss(repoDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of ["components/demo", "components/demo/profile"]) {
    for (const name of (await readdir(join(repoDir, dir))).sort()) if (name.endsWith(".module.css")) out.push(await readFile(join(repoDir, dir, name), "utf8"));
  }
  return out;
}

/** The templates' CSS module class names (any of them in the page's HTML or CSS is reuse). */
export function templateClassNames(cssList: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const css of cssList) for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(m[1]!);
  return names;
}

export type AntiTemplateResult = {
  ok: boolean;
  codes: string[];
  nearest: string;
  min_distance: number;
  threshold: number;
  css_reuse_share: number;
  css_reuse_max: number;
};

/**
 * The verdict of the three tripwires. Generic words are not counted as
 * template class names (a page may well have a class "hero"): only names of
 * at least 6 characters that also appear in the page are reported.
 */
export function antiTemplateCheck(input: { html: string; css: string; fingerprint: Fingerprint; references: readonly ReferenceFingerprint[]; templateCss: readonly string[] }): AntiTemplateResult {
  const codes: string[] = [];
  if (RENDERER_MARKERS.test(input.html) || /#shop-css\b|\[data-(kind|variant|ground|first-view|scale|headings|fv|key)\b/.test(input.css)) codes.push("TEMPLATE_RENDERER_MARKER");
  const classes = templateClassNames(input.templateCss);
  const pageClasses = new Set([...input.html.matchAll(/class\s*=\s*["']([^"']*)["']/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean));
  if ([...pageClasses].some((c) => c.length >= 6 && classes.has(c))) codes.push("TEMPLATE_CLASS_NAME");
  const reference = new Set(input.templateCss.flatMap(ruleBodies));
  const bodies = ruleBodies(input.css);
  const reused = bodies.filter((b) => reference.has(b)).length;
  const share = bodies.length === 0 ? 0 : Math.round((reused / bodies.length) * 1000) / 1000;
  if (share > CSS_REUSE_MAX_SHARE) codes.push("TEMPLATE_CSS_REUSE");
  const nearest = nearestReference(input.fingerprint, input.references);
  if (input.references.length === 0) codes.push("TEMPLATE_NO_REFERENCES");
  else if (nearest.distance < ANTI_TEMPLATE_MIN_DISTANCE) codes.push("TEMPLATE_STRUCTURE_TOO_CLOSE");
  return { ok: codes.length === 0, codes: codes.sort(), nearest: nearest.id, min_distance: nearest.distance, threshold: ANTI_TEMPLATE_MIN_DISTANCE, css_reuse_share: share, css_reuse_max: CSS_REUSE_MAX_SHARE };
}
