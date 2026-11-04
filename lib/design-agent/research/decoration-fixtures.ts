/**
 * DEV-165 — RESEARCH ONLY, NOT ENABLED. The SVG strings the N1 research draws: the three shops' decorative shapes (as
 * standalone files that pass checkDecorationSvg) and the hostile set (files the checker refuses, drawn anyway to see
 * what a browser's image mode does with them). Plain strings, no imports. Used by
 * tests/unit/design-agent/research/decoration-svg.test.ts and the research probe scripts/design-artifact/n1-browser-probe.ts.
 * Every URL in the hostile set is on `.invalid` (RFC 6761: never resolves); the probe aborts every request anyway.
 */

const NS = `xmlns="http://www.w3.org/2000/svg"`;
const svg = (inner: string, attrs: string) => `<svg ${NS} ${attrs}>${inner}</svg>`;

/** つぐ手 (tsugute d1-v3): the gold seam through the bowl, one path. */
export const SEAM = svg(`<path d="M70 0 L 70 70 C 70 84, 60 90, 60 100" fill="none" stroke="#b8923a" stroke-width="2" vector-effect="non-scaling-stroke"/>`, `width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"`);

const spokes = Array.from({ length: 12 }, (_, k) => {
  const a = (k * Math.PI) / 6;
  return `<line x1="1010" y1="640" x2="${(1010 + 560 * Math.cos(a)).toFixed(1)}" y2="${(640 + 560 * Math.sin(a)).toFixed(1)}"/>`;
}).join("");
/** 輪 (bicycle d1-v2): tyre, rim and twelve spokes. */
export const WHEEL = svg(
  `<g fill="none" stroke="#1d1d1b"><circle cx="1010" cy="640" r="620" stroke-width="28"/><circle cx="1010" cy="640" r="570" stroke-width="6"/><g stroke-width="3">${spokes}</g><circle cx="1010" cy="640" r="40" fill="#1d1d1b"/></g>`,
  `width="1440" height="1400" viewBox="-110 0 1440 1400"`,
);

/** ゆげ湯 (sento d1-v2): two mountains, one with a same-file gradient. The polygons reach past the viewBox (x = -60, 780). */
export const MOUNTAIN = svg(
  `<defs><linearGradient id="mt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f5d7c"/><stop offset="1" stop-color="#2f5d7c" stop-opacity="0.4"/></linearGradient></defs><polygon points="-60,600 273,180 580,600" fill="url(#mt)"/><polygon points="260,600 510,300 780,600" fill="#24475f" opacity="0.8"/>`,
  `width="660" height="600" viewBox="0 0 660 600" preserveAspectRatio="none"`,
);

/** The three shapes with the box the probe draws each in (css px). */
export const SHOP_SHAPES: readonly { name: string; svg: string; box: { width: number; height: number } }[] = [
  { name: "seam", svg: SEAM, box: { width: 100, height: 300 } },
  { name: "wheel", svg: WHEEL, box: { width: 360, height: 350 } },
  { name: "mountain", svg: MOUNTAIN, box: { width: 330, height: 300 } },
];

const HOSTILE_ROOT = `${NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100" viewBox="0 0 100 100"`;
const hostile = (inner: string, extra = "") => `<svg ${HOSTILE_ROOT}${extra}>${inner}<rect width="100" height="100"/></svg>`;

/**
 * The hostile set: one vector per file, so a request can be traced to its vector. checkDecorationSvg refuses every one.
 * `all-in-one` is DEV-162's combined probe.
 */
export const HOSTILE_SVGS: readonly { name: string; svg: string }[] = [
  { name: "onload", svg: hostile("", ` onload="document.title='x'"`) },
  { name: "script-fetch", svg: hostile(`<script>fetch("http://n1-probe-hostile.invalid/script")</script>`) },
  { name: "style-import-rule", svg: hostile(`<style>@import url(http://n1-probe-hostile.invalid/import.css);</style>`) },
  { name: "style-url-fill", svg: hostile(`<style>rect { fill: url(http://n1-probe-hostile.invalid/paint.svg#p); }</style>`) },
  { name: "image-href", svg: hostile(`<image href="http://n1-probe-hostile.invalid/image.png" width="10" height="10"/>`) },
  { name: "image-xlink-href", svg: hostile(`<image xlink:href="https://n1-probe-hostile.invalid/xlink.png" width="10" height="10"/>`) },
  { name: "use-external", svg: hostile(`<use href="http://n1-probe-hostile.invalid/use.svg#u"/>`) },
  { name: "foreign-object-img", svg: hostile(`<foreignObject width="100" height="100"><img xmlns="http://www.w3.org/1999/xhtml" src="http://n1-probe-hostile.invalid/foreign.png"/></foreignObject>`) },
  { name: "fill-url-external", svg: hostile(`<rect width="50" height="50" fill="url(http://n1-probe-hostile.invalid/fill.svg#g)"/>`) },
  { name: "feimage-filter", svg: hostile(`<filter id="f"><feImage href="http://n1-probe-hostile.invalid/feimage.png"/></filter><rect width="50" height="50" filter="url(#f)"/>`) },
  { name: "xml-stylesheet", svg: `<?xml-stylesheet type="text/css" href="http://n1-probe-hostile.invalid/pi.css"?>${hostile("")}` },
  { name: "overflow-visible", svg: hostile(`<rect x="-400" y="-400" width="900" height="900" fill="#d00"/>`, ` overflow="visible" style="overflow:visible"`) },
  {
    name: "all-in-one",
    svg: `<svg ${HOSTILE_ROOT} onload="document.title='x'">
<style>@import url(http://n1-probe-hostile.invalid/a.css); rect { fill: url(http://n1-probe-hostile.invalid/p.svg#p); }</style>
<image href="http://n1-probe-hostile.invalid/i.png" width="10" height="10"/><image xlink:href="https://n1-probe-hostile.invalid/j.png" width="10" height="10"/>
<use href="http://n1-probe-hostile.invalid/u.svg#u"/><script>fetch("http://n1-probe-hostile.invalid/s")</script>
<foreignObject width="100" height="100"><img xmlns="http://www.w3.org/1999/xhtml" src="http://n1-probe-hostile.invalid/f.png"/></foreignObject>
<rect width="100" height="100"/></svg>`,
  },
];
