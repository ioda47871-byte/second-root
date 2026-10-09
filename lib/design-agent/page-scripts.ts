import { z } from "zod";

// Code that runs inside the preview page, kept as plain JavaScript source text.
//
// A function passed to page.evaluate() is compiled with this module and then
// sent to the browser as its source. Under tsx (esbuild, keepNames: run.sh and
// the worker) every named function or arrow bound to a name gets wrapped in a
// __name() helper that exists in Node but not in the page, so the callback
// throws `ReferenceError: __name is not defined` there, while Vitest (no
// keepNames) passes. A string is never transformed: page.evaluate(source)
// runs it exactly as written, whatever compiles this file. Plain ES2020, no
// TypeScript syntax, no imports, no closures over Node values.

/**
 * The preview page's layout facts for capturePage (DEV-029): the document
 * height and horizontal overflow, the page box of every photo section, and for
 * every figure with a photo its asset, role, visibility, the イメージ画像
 * label and whether any page text lies under it.
 */
export const PAGE_INFO_SCRIPT = String.raw`(() => {
  const box = (e) => {
    const r = e.getBoundingClientRect();
    return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right };
  };
  const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const sections = Array.from(document.querySelectorAll("[data-photo-section]")).map(box);
  const textBoxes = [];
  for (const e of Array.from(document.querySelectorAll("h1, h2, h3, p, dt, dd, li, a, [role=note]"))) {
    if (e.closest("figure")) continue;
    for (const r of Array.from(e.getClientRects())) textBoxes.push({ top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right });
  }
  const placed = Array.from(document.querySelectorAll("figure[data-asset]")).map((f) => {
    const img = f.querySelector("img");
    const b = box(f);
    const label = f.querySelector("[data-image-label]");
    const ls = label ? getComputedStyle(label) : null;
    return {
      assetId: f.getAttribute("data-asset") || "",
      role: f.getAttribute("data-role") || "",
      visible: Boolean(img && img.complete && img.naturalWidth > 0 && b.right - b.left > 0 && b.bottom - b.top > 0 && getComputedStyle(f).visibility === "visible"),
      labelled: Boolean(label && ls && ls.display !== "none" && ls.visibility === "visible" && Number(ls.opacity) > 0.99 && label.textContent === "イメージ画像"),
      overlapsText: textBoxes.some((t) => hit(b, t)),
    };
  });
  return {
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
    sections,
    placed,
  };
})()`;

const Box = z.strictObject({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() });

/** What PAGE_INFO_SCRIPT returns; checked, since the page's answer is not typed. */
export const PageInfoSchema = z.strictObject({
  overflow: z.number(),
  height: z.number().nonnegative(),
  sections: z.array(Box).max(50),
  placed: z
    .array(z.strictObject({ assetId: z.string().max(80), role: z.string().max(20), visible: z.boolean(), labelled: z.boolean(), overlapsText: z.boolean() }))
    .max(50),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;
