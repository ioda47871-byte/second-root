// The viewports of the review screenshots (DEV-039): one source for the
// screenshots themselves (preview-server.ts) and for what the review prompts
// say about them, so the reviewer judges sizes in CSS px, not image pixels.

export const SHOT_VIEWPORTS = {
  desktop: { width: 1440, height: 900, scale: 1 },
  mobile: { width: 390, height: 844, scale: 2 },
} as const;

/**
 * How the review screenshots map to CSS px, for the review prompts. Put as a
 * fraction of each image's full width, which holds even when the images are
 * scaled before the reviewer sees them.
 */
export function screenshotScaleLine(o: { crops?: boolean } = {}): string {
  const d = SHOT_VIEWPORTS.desktop;
  const m = SHOT_VIEWPORTS.mobile;
  return [
    `Screenshot scale: the full width of the desktop image is ${d.width} CSS px (stored at 1×); the full width of the mobile image is ${m.width} CSS px (stored at deviceScaleFactor ${m.scale}, a ${m.width * m.scale} px file).` +
      (o.crops ? " Each photo-section crop spans the full width of its page, at that page's scale." : ""),
    "Images may be scaled before you see them: judge type sizes and spacing in CSS px, as a fraction of the image's full width, never from raw pixel counts.",
  ].join("\n");
}

/**
 * The photo-section crops of a render, by page: desktop first, then mobile (their
 * file names say which; see capturePage's `sectionPrefix`). The review prompt counts
 * them in this order, so the reviewer knows each crop's page without guessing from its shape.
 */
export function cropsByPage(paths: readonly string[]): { desktop: string[]; mobile: string[] } {
  const desktop = paths.filter((p) => p.includes("-desktop-section-"));
  const mobile = paths.filter((p) => !p.includes("-desktop-section-"));
  return { desktop, mobile };
}

/** When a renderer change may be asked for (both review prompts; `photos` adds the image direction). */
export function rendererChangeRule(o: { photos?: boolean } = {}): string {
  return [
    `In particular: needs_renderer_change = true only when the correction cannot be reached with the profile vocabulary above${o.photos ? ", a new image direction" : ""} and the renderer's current behaviour.`,
    "Do not derive a CSS target from raw image-pixel sizes, and do not ask for a renderer change to reach a size or spacing the page already has: estimate it in CSS px first.",
  ].join(" ");
}
