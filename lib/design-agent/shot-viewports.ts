// The viewports of the review screenshots (DEV-039): one source for the
// screenshots themselves (preview-server.ts) and for what the review prompts
// say about them, so the reviewer judges sizes in CSS px, not image pixels.

export const SHOT_VIEWPORTS = {
  desktop: { width: 1440, height: 900, scale: 1 },
  mobile: { width: 390, height: 844, scale: 2 },
} as const;

/** How the review screenshots map to CSS px, for the review prompts. */
export function screenshotScaleLine(o: { crops?: boolean } = {}): string {
  const d = SHOT_VIEWPORTS.desktop;
  const m = SHOT_VIEWPORTS.mobile;
  const view = (v: { width: number; scale: number }, name: string) =>
    v.scale === 1
      ? `the ${name} image shows a ${v.width} CSS px wide viewport at 1× (the image is ${v.width} px wide)`
      : `the ${name} image shows a ${v.width} CSS px wide viewport at deviceScaleFactor ${v.scale}, so the image is ${v.width * v.scale} px wide and 1 CSS px = ${v.scale} image px`;
  return [
    `Screenshot scale: ${view(d, "desktop")}; ${view(m, "mobile")}.${o.crops ? " Photo-section crops use the same scale as their page." : ""}`,
    `Judge type sizes and spacing in CSS px (divide mobile image pixels by ${m.scale}), never in raw image pixels.`,
  ].join("\n");
}

/** When a renderer change may be asked for (both review prompts). */
export const RENDERER_CHANGE_RULE = [
  "needs_renderer_change = true only when the correction cannot be reached with the profile vocabulary above and the renderer's current behaviour.",
  "Do not derive a CSS target from raw image-pixel sizes, and do not ask for a renderer change to reach a size or spacing the page already has: estimate it in CSS px first.",
].join(" ");
