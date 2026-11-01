/**
 * DEV-134: the phone (SP 390) quality checks of a Phase 2f prototype, REPORT-ONLY.
 *
 * The render already stops on a page wider than the phone (PROTOTYPE_HORIZONTAL_OVERFLOW), a blank page and a page
 * too tall. Those say the page is not broken; they do not say it can be read and used on a phone. This adds, on the
 * same SP 390 page the runner already opened (JS off, closed origin, after its screenshot was taken):
 *
 * - the text checks of the shop-CSS render check (DEV-072), reused unchanged: every text node of the page is measured
 *   by its MEASURE_SCRIPT (clipped by an ancestor, off the page sideways, covered by another element, out of its own
 *   box, smaller than 12 px, faded, squeezed) and text printed over other text (`overprinted`). The page body is the
 *   measured scope; a text that is a fact value is a fact, any other a label
 * - tap targets: links, buttons and summaries smaller than 44 × 44 CSS px (24 × 24 is the floor the page must keep);
 *   a link inside running text is exempt (it is the text's own line)
 * - the shop name in the first screen (390 × 844), when the facts give a name
 *
 * Nothing here stops a run or changes an artifact's state. The findings are recorded (observed.checks.mobile) and
 * shown as an intake warning; the thresholds are those of the existing checks, not new ones. A check that cannot run
 * is recorded as SP_CHECK_FAILED, never as a pass.
 */
import type { Page } from "playwright";
import { overprinted, MIN_FONT_PX, MIN_OPACITY } from "../shop-css/render-check";
import { FREEZE_MOTION_CSS, HIT_TEST_CSS, MEASURE_SCRIPT, MeasureSchema } from "../shop-css/page-scripts";

/** Recommended and minimum tap-target size in CSS px (WCAG 2.5.5 / 2.5.8). */
export const TAP_TARGET = { recommended: 44, minimum: 24 } as const;
/** The phone's first screen. */
export const FIRST_SCREEN = { width: 390, height: 844 } as const;

export type MobileFindings = {
  viewport: "mobile_390";
  /** Sorted, distinct codes; empty when nothing was found (which is not a pass). */
  findings: string[];
  counts: { text_nodes: number; text_nodes_with_problems: number; tap_targets: number; tap_targets_below_recommended: number; tap_targets_below_minimum: number };
  advisory: true;
  /** Up to 10 examples (code, the first 40 characters of the text) for a person reading the run; not recorded in the artifact. */
  examples?: { code: string; text: string }[];
};

const TEXT_CODES = {
  clipped: "SP_TEXT_CLIPPED",
  offscreen: "SP_TEXT_OFFSCREEN",
  covered: "SP_TEXT_COVERED",
  overflow: "SP_TEXT_OUT_OF_BOX",
  small: "SP_TEXT_TOO_SMALL",
  faded: "SP_TEXT_FADED",
  squeezed: "SP_TEXT_SQUEEZED",
  overlap: "SP_TEXT_OVERLAP",
  factHidden: "SP_FACT_HIDDEN",
} as const;

/** Interactive elements and their boxes; a link that sits inside running text is marked inline (exempt). */
const TAP_SCRIPT = String.raw`() => {
  const out = [];
  for (const el of document.querySelectorAll("a[href], button, summary, [role=button]")) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || s.display === "none") continue;
    // wholly off the left or above the page: the skip-link convention, hidden on purpose. Off the RIGHT side is
    // a phone breakage (a menu pushed out under overflow-x: hidden) and stays counted.
    if (r.right <= 0 || r.bottom + scrollY <= 0) continue;
    const parent = el.parentElement;
    const own = (el.textContent || "").replace(/\s+/g, "");
    const around = parent ? (parent.textContent || "").replace(/\s+/g, "") : "";
    const inline = s.display === "inline" && around.length > own.length;
    out.push({ w: r.width, h: r.height, inline });
  }
  return out;
}`;

/**
 * The shop-CSS measure counts any text set directly in a grid or flex container as out of its box (its own pages
 * never do that), and allows 1 px. A prototype may do both freely, so a node it marks out of its box is measured again
 * here against the element that holds it, allowing the element's letter spacing (trailing space is part of the glyph's
 * box) and 1 px. Returns, per owner index, whether a character really lies outside that element's box.
 */
const OUT_OF_BOX_SCRIPT = String.raw`(owners) => {
  const out = {};
  for (const o of owners) {
    const el = document.querySelector('[data-sr-i="' + o.owner + '"]');
    if (!el) { out[o.owner] = true; continue; }
    let box = el;
    while (box.parentElement && ["inline", "contents"].includes(getComputedStyle(box).display)) box = box.parentElement;
    const b = box.getBoundingClientRect();
    const ls = parseFloat(getComputedStyle(el).letterSpacing);
    const tol = 1 + (Number.isFinite(ls) && ls > 0 ? ls : 0);
    const top = b.top + scrollY;
    out[o.owner] = o.chars.some((c) => c.left < b.left - tol || c.left + c.width > b.right + tol || c.top < top - tol || c.top + c.height > top + b.height + tol);
  }
  return out;
}`;

/**
 * DEV-140: the part of the page a clipped text can still paint in: the intersection of the boxes of its ancestors that
 * clip (overflow other than visible, or a clip-path), in page coordinates, per owner index; null when nothing clips.
 */
const CLIP_BOX_SCRIPT = String.raw`(owners) => {
  const out = {};
  for (const owner of owners) {
    const el = document.querySelector('[data-sr-i="' + owner + '"]');
    if (!el) { out[owner] = null; continue; }
    let box = null;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.overflowX === "visible" && as.overflowY === "visible" && as.clipPath === "none") continue;
      const b = a.getBoundingClientRect();
      const r = { left: b.left, top: b.top + scrollY, right: b.right, bottom: b.bottom + scrollY };
      box = box ? { left: Math.max(box.left, r.left), top: Math.max(box.top, r.top), right: Math.min(box.right, r.right), bottom: Math.min(box.bottom, r.bottom) } : r;
    }
    out[owner] = box;
  }
  return out;
}`;

const clean = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
/**
 * A line box wholly off the left of the page or above it: the skip-link convention (a label hidden on purpose).
 * Wholly off the RIGHT side is not exempt: that is a menu or text pushed out of the phone, a breakage.
 */
const outside = (r: { left: number; top: number; width: number; height: number }) => r.left + r.width <= 0 || r.top + r.height <= 0;

/** The longest the phone checks may take; past it they are recorded as SP_CHECK_FAILED (never a stop). */
export const CHECK_BUDGET_MS = 20_000;

/** Measures the SP page in place. Call after the page's screenshot was taken: it adds a style and marks elements. */
export async function measureMobileQuality(page: Page, o: { facts: readonly string[]; shopName: string | null }, budgetMs = CHECK_BUDGET_MS): Promise<MobileFindings> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MobileFindings>((done) => {
    timer = setTimeout(() => done({ viewport: "mobile_390", findings: ["SP_CHECK_FAILED"], counts: { text_nodes: 0, text_nodes_with_problems: 0, tap_targets: 0, tap_targets_below_recommended: 0, tap_targets_below_minimum: 0 }, advisory: true }), budgetMs);
  });
  try {
    // the caller closes the page's context afterwards, which ends an evaluate still running
    return await Promise.race([measure(page, o), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function measure(page: Page, o: { facts: readonly string[]; shopName: string | null }): Promise<MobileFindings> {
  const empty = { text_nodes: 0, text_nodes_with_problems: 0, tap_targets: 0, tap_targets_below_recommended: 0, tap_targets_below_minimum: 0 };
  const failed = (): MobileFindings => ({ viewport: "mobile_390", findings: ["SP_CHECK_FAILED"], counts: empty, advisory: true });
  try {
    // the shop-CSS measure reads the element with id shop-css as its scope: the body here. A page that already uses
    // that id would be measured on the wrong element, so it is not measured.
    // the body must be the real body (not a clobbered name) and must have no id of its own: replacing an id would
    // drop the page's own #id rules, and the page measured would no longer be the page in the picture
    const scoped = (await page.evaluate(`(() => {
      const body = Document.prototype.querySelector.call(document, "body");
      if (!(body instanceof HTMLBodyElement) || body.id !== "" || Document.prototype.getElementById.call(document, "shop-css")) return false;
      body.id = "shop-css";
      return true;
    })()`)) as boolean;
    if (!scoped) return { viewport: "mobile_390", findings: ["SP_CHECK_SCOPE_CONFLICT"], counts: empty, advisory: true };
    // inserted directly: page.addStyleTag waits for a load event that a page with JavaScript off never fires
    const style = JSON.stringify(`${HIT_TEST_CSS}\n${FREEZE_MOTION_CSS}`);
    await page.evaluate(`((css) => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); })(${style})`);
    const m = MeasureSchema.parse(await page.evaluate(`(${MEASURE_SCRIPT})(${JSON.stringify({ facts: [...o.facts] })})`));
    const taps = (await page.evaluate(`(${TAP_SCRIPT})()`)) as { w: number; h: number; inline: boolean }[];

    const codes = new Set<string>();
    const nodes = m.nodes.filter((n) => n.kind === "fact" || n.kind === "label");
    // DEV-140: a clipped text's cut-off characters are not painted. Only they are left out of the overlap (they would
    // otherwise "overlap" the text after the box); its characters inside the clip still count, so text printed over the
    // visible part is still named (review M1)
    const clippedOwners = [...new Set(nodes.filter((n) => n.clipped && !n.hidden).map((n) => n.owner))];
    const clips = clippedOwners.length ? ((await page.evaluate(`(${CLIP_BOX_SCRIPT})(${JSON.stringify(clippedOwners)})`)) as Record<string, { left: number; top: number; right: number; bottom: number } | null>) : {};
    const visibleChars = (n: (typeof nodes)[number]) => {
      const box = n.clipped ? clips[String(n.owner)] : null;
      if (!box) return n.chars;
      return n.chars.filter((c) => {
        const x = c.left + c.width / 2;
        const y = c.top + c.height / 2;
        return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      });
    };
    const over = overprinted({ ...m, nodes: nodes.map((n) => (n.clipped ? { ...n, chars: visibleChars(n) } : n)) });
    const flagged = nodes.filter((n) => n.overflow && !n.hidden);
    const reallyOut = flagged.length ? ((await page.evaluate(`(${OUT_OF_BOX_SCRIPT})(${JSON.stringify(flagged.map((n) => ({ owner: n.owner, chars: n.chars })))})`)) as Record<string, boolean>) : {};
    const visibleText = clean(nodes.filter((n) => !n.hidden && !n.rects.every(outside)).map((n) => n.text).join(""));
    let bad = 0;
    const examples: { code: string; text: string }[] = [];
    const note = (code: string, text: string) => {
      if (examples.length < 10) examples.push({ code, text: text.replace(/\s+/g, " ").trim().slice(0, 40) });
    };
    nodes.forEach((n, i) => {
      // a label wholly off the left or above is hidden on purpose (a skip link); a fact never is
      if (n.kind === "label" && !n.hidden && n.rects.length > 0 && n.rects.every(outside)) return;
      if (n.hidden) {
        // a fact hidden here is a finding only when the page shows it nowhere else (a repeated name hidden once is fine)
        if (n.kind === "fact" && clean(n.text).length >= 2 && !visibleText.includes(clean(n.text))) {
          codes.add(TEXT_CODES.factHidden);
          note(TEXT_CODES.factHidden, n.text);
        }
        return;
      }
      const checks: [boolean, string][] = [
        [n.clipped, TEXT_CODES.clipped],
        [n.offscreen, TEXT_CODES.offscreen],
        // a clipped text is not also named covered: its hidden part meets what lies after the box (a known limit: a
        // real cover of its visible part is then named only as clipped; docs/design/phase2f-mobile-quality.md)
        [n.covered && !n.clipped, TEXT_CODES.covered],
        [n.overflow && reallyOut[String(n.owner)] === true, TEXT_CODES.overflow],
        [n.fontSize < MIN_FONT_PX, TEXT_CODES.small],
        [n.opacity < MIN_OPACITY, TEXT_CODES.faded],
        [n.squeezed, TEXT_CODES.squeezed],
        [over[i] === true, TEXT_CODES.overlap],
      ];
      const found = checks.filter(([hit]) => hit).map(([, code]) => code);
      if (found.length) bad += 1;
      for (const c of found) {
        codes.add(c);
        note(c, n.text);
      }
    });

    // a page with facts whose text could not be found was not measured (a clobbered document): never a clean report
    if (nodes.length === 0 && o.facts.length > 0) return failed();
    const counted = taps.filter((t) => !t.inline);
    const belowRecommended = counted.filter((t) => t.w < TAP_TARGET.recommended || t.h < TAP_TARGET.recommended).length;
    const belowMinimum = counted.filter((t) => t.w < TAP_TARGET.minimum || t.h < TAP_TARGET.minimum).length;
    if (belowMinimum) codes.add("SP_TAP_TARGET_TOO_SMALL");
    else if (belowRecommended) codes.add("SP_TAP_TARGET_BELOW_44");

    if (o.shopName) {
      const name = clean(o.shopName);
      // the name shows in the first screen when a visible text node holding it has a line box there
      // the text shown in the first screen, in page order, joined: a name set in two parts (ひびや｜継工房) still counts
      const first = clean(nodes.filter((n) => !n.hidden && n.rects.some((r) => r.top < FIRST_SCREEN.height && r.top + r.height > 0 && r.left < FIRST_SCREEN.width && r.left + r.width > 0)).map((n) => n.text).join(""));
      const shown = first.includes(name);
      if (!shown) codes.add("SP_SHOP_NAME_NOT_IN_FIRST_SCREEN");
    }
    return {
      viewport: "mobile_390",
      findings: [...codes].sort(),
      counts: { text_nodes: nodes.length, text_nodes_with_problems: bad, tap_targets: counted.length, tap_targets_below_recommended: belowRecommended, tap_targets_below_minimum: belowMinimum },
      advisory: true,
      examples,
    };
  } catch {
    return failed();
  }
}
