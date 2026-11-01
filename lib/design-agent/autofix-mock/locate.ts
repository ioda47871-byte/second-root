/**
 * DEV-146 (Issue #177 D, MOCK ONLY): where an in-scope SP finding sits, so a patch can name a selector. A page script
 * (a string): the caller evaluates it on an SP 390 page of the same HTML and CSS. It only reads the page.
 *
 * It is not a check: the SP checks (DEV-134) decide whether a cause is present, and a patch is kept only when they no
 * longer name it. The locator only says where, and it leaves out on purpose what may be intended:
 * - text cut off is located only when it is in the normal flow of a box whose content is taller than the box (a fixed
 *   height). Text placed with position absolute / fixed (a decorative word bleeding out of a cropped hero, DEV-140
 *   `deco_type_not_marked`) is never located, nor is aria-hidden text, nor sideways clipping
 * - a page wider than the phone is located at the outermost in-flow element (static / relative, no transform) that
 *   reaches past the right edge; a drawer parked off the edge with a transform or position fixed is never located
 * - tap targets follow the SP check's own rule (a link inside running text is exempt)
 * Each target is { code, selector }; the selector is a class selector when every element it matches has the problem,
 * else a path of :nth-of-type steps from the body.
 */
export const LOCATE_SCRIPT = String.raw`(() => {
  const W = innerWidth;
  const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  const unique = (id) => IDENT.test(id) && document.querySelectorAll("#" + id).length === 1;
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (e.id && unique(e.id)) { parts.unshift("#" + e.id); return parts.join(" > "); }
      const same = [...e.parentElement.children].filter((c) => c.localName === e.localName);
      parts.unshift(e.localName + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(e) + 1) + ")" : ""));
    }
    parts.unshift("body");
    return parts.join(" > ");
  };
  const selectorFor = (el, all) => {
    const cls = [...el.classList].filter((c) => IDENT.test(c));
    if (cls.length) {
      const s = el.localName + "." + cls.join(".");
      if ([...document.querySelectorAll(s)].every((m) => all.includes(m))) return s;
    }
    return path(el);
  };
  const found = [];
  const add = (code, els) => { for (const el of els) found.push({ code, selector: selectorFor(el, els) }); };
  const shown = (el) => { const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden"; };

  // tap targets: the SP check's rule (DEV-134 TAP_SCRIPT)
  const below44 = [], below24 = [];
  for (const el of document.querySelectorAll("a[href], button, summary, [role=button]")) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || !shown(el)) continue;
    if (r.right <= 0 || r.bottom + scrollY <= 0) continue;
    const own = (el.textContent || "").replace(/\s+/g, "");
    const around = el.parentElement ? (el.parentElement.textContent || "").replace(/\s+/g, "") : "";
    if (s.display === "inline" && around.length > own.length) continue;
    if (r.width < 24 || r.height < 24) below24.push(el);
    else if (r.width < 44 || r.height < 44) below44.push(el);
  }
  add("SP_TAP_TARGET_TOO_SMALL", below24);
  add("SP_TAP_TARGET_BELOW_44", below44);

  // text: the element that holds each visible text node
  const holders = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || !t.textContent.trim() || el.closest('[aria-hidden="true"], style, script, [hidden]')) continue;
    if (!shown(el)) continue;
    holders.add(el);
  }
  const small = [...holders].filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12);
  add("SP_TEXT_TOO_SMALL", small);

  // text cut off at the bottom by a box with a fixed height, in the normal flow
  const boxes = new Set();
  for (const el of holders) {
    let inFlow = true;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.position === "absolute" || s.position === "fixed") { inFlow = false; break; }
      if (a === el) continue;
      if (s.overflowY === "visible") continue;
      if (inFlow && a.scrollHeight > a.clientHeight + 1 && el.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom + 1) boxes.add(a);
      break;
    }
  }
  add("SP_TEXT_CLIPPED", [...boxes]);

  // a page wider than the phone: the outermost in-flow element past the right edge
  const wide = [];
  if (document.documentElement.scrollWidth > W) {
    const walk = (el) => {
      for (const c of el.children) {
        const s = getComputedStyle(c);
        if (!shown(c)) continue;
        const flow = (s.position === "static" || s.position === "relative") && s.transform === "none";
        if (flow && c.getBoundingClientRect().right > W + 1) wide.push(c);
        else if (flow) walk(c);
      }
    };
    walk(document.body);
  }
  add("PAGE_HORIZONTAL_OVERFLOW", wide);
  return found;
})()`;
