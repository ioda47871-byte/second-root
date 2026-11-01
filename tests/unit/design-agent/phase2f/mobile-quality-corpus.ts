// DEV-140 (Issue #177 B): a labelled corpus of fictional phone pages for the SP checks (DEV-134). Each case says which
// findings a person reading the page at 390 px would expect (`expected`): the real problems, and nothing for what is
// intentional (text over a picture, large decorative type, vertical text, a drawer, a skip link).
export const NAME = "架空珈琲 灯";
export const FACTS = [NAME, "8:00〜19:00", "架空市本町3-4"];
export const BASE = "body{margin:0;font:16px/1.7 sans-serif;color:#222;background:#fbf7f0} section{padding:24px}";
const name = `<h1>${NAME}</h1>`;
const facts = `<p>8:00〜19:00</p><p>架空市本町3-4</p>`;
export type CorpusCase = { id: string; intent: string; body: string; css: string; expected: string[] };

export const CORPUS: CorpusCase[] = [
  // ---- intentional designs: nothing expected ----
  { id: "plain", intent: "plain stacked page", body: `<section>${name}${facts}<a href="#m" style="display:inline-block;padding:14px 20px">メニュー</a></section>`, css: BASE, expected: [] },
  {
    id: "text_over_picture",
    intent: "hero copy laid over a full-bleed picture (intentional overlap of text on an image)",
    body: `<section class="hero"><div class="pic"></div><div class="copy">${name}<p>朝の一杯を、灯のそばで</p></div></section><section>${facts}</section>`,
    css: `${BASE} .hero{position:relative;height:520px;padding:0} .pic{position:absolute;inset:0;background:linear-gradient(#5a3a22,#2a1a0a)} .copy{position:relative;color:#fff;padding:120px 24px}`,
    expected: [],
  },
  {
    id: "big_decorative_type",
    intent: "an oversized decorative word behind the name, marked aria-hidden (intentional overlap of type)",
    body: `<section class="hero"><span class="deco" aria-hidden="true">COFFEE</span>${name}</section><section>${facts}</section>`,
    css: `${BASE} .hero{position:relative;overflow:hidden;height:360px} .deco{position:absolute;top:40px;left:-20px;font-size:120px;color:#ead8c0;z-index:0;line-height:1} h1{position:relative;z-index:1;margin-top:120px}`,
    expected: [],
  },
  {
    id: "vertical_name",
    intent: "the name set vertically (tategaki) beside the copy",
    body: `<section class="hero"><h1 class="v">${NAME}</h1><p class="lead">朝の一杯を、灯のそばで</p></section><section>${facts}</section>`,
    css: `${BASE} .hero{display:flex;gap:16px;height:420px} .v{writing-mode:vertical-rl;font-size:34px;margin:0} .lead{writing-mode:vertical-rl;margin:0}`,
    expected: [],
  },
  {
    id: "skip_link",
    intent: "a skip link parked off the top-left until focused",
    body: `<a class="skip" href="#main">本文へ</a><section id="main">${name}${facts}</section>`,
    css: `${BASE} .skip{position:absolute;left:-9999px;top:0}`,
    expected: [],
  },
  {
    id: "drawer_hidden",
    intent: "a closed drawer menu hidden with the hidden attribute (JS off: stays closed)",
    body: `<section>${name}${facts}</section><nav hidden><a href="#a">メニュー</a><a href="#b">アクセス</a></nav>`,
    css: BASE,
    expected: [],
  },
  {
    id: "name_split",
    intent: "the name split in two spans for typesetting",
    body: `<section><h1><span>架空珈琲</span> <span>灯</span></h1>${facts}</section>`,
    css: BASE,
    expected: [],
  },
  {
    id: "inline_link",
    intent: "a small link inside running text (exempt from the tap-target size)",
    body: `<section>${name}<p>詳しくは<a href="#x">こちら</a>をご覧ください。</p>${facts}</section>`,
    css: BASE,
    expected: [],
  },
  {
    id: "deco_type_not_marked",
    intent: "the same oversized decorative word, but not marked aria-hidden (intentional, yet it is text)",
    body: `<section class="hero"><span class="deco">COFFEE</span>${name}</section><section>${facts}</section>`,
    css: `${BASE} .hero{position:relative;overflow:hidden;height:360px} .deco{position:absolute;top:40px;left:-20px;font-size:120px;color:#ead8c0;z-index:0;line-height:1} h1{position:relative;z-index:1;margin-top:120px}`,
    expected: [],
  },
  {
    id: "fixed_header",
    intent: "a fixed header bar over a long page (the page scrolls under it)",
    body: `<header class="bar">${NAME}</header><section style="padding-top:80px">${name}${facts}<p style="height:1200px">季節の豆のこと。</p><p>架空市本町3-4</p></section>`,
    css: `${BASE} .bar{position:fixed;top:0;left:0;right:0;height:56px;background:#2a1a0a;color:#fff;padding:14px 20px;box-sizing:border-box}`,
    expected: [],
  },
  {
    id: "drawer_translated",
    intent: "a drawer menu parked off the right edge with a transform (no hidden attribute; JS off keeps it closed)",
    body: `<section>${name}${facts}</section><nav class="drawer"><a href="#a">メニュー</a><a href="#b">アクセス</a></nav>`,
    css: `${BASE} body{overflow-x:hidden} .drawer{position:fixed;top:0;right:0;width:280px;height:100%;transform:translateX(100%);background:#fff} .drawer a{display:block;padding:14px 20px}`,
    expected: [],
  },
  // ---- real phone problems: the code expected ----
  { id: "tiny_text", intent: "body text at 10 px", body: `<section>${name}${facts}</section>`, css: `${BASE} p{font-size:10px}`, expected: ["SP_TEXT_TOO_SMALL"] },
  {
    id: "clipped_copy",
    intent: "copy cut off by a fixed-height box",
    body: `<section>${name}<div class="box"><p>朝の一杯を、灯のそばで。季節の豆を、ひとつずつ手で選んでいます。</p><p>焙煎は毎朝、店の奥で。</p></div>${facts}</section>`,
    css: `${BASE} .box{height:30px;overflow:hidden}`,
    expected: ["SP_TEXT_CLIPPED"],
  },
  {
    id: "pushed_right",
    intent: "a fixed-width row pushed off the right edge under overflow-x hidden",
    body: `<section>${name}<div class="row"><p>ブレンド</p><p>シングル</p><p>カフェオレ</p></div>${facts}</section>`,
    css: `${BASE} body{overflow-x:hidden} .row{display:flex;width:900px;gap:40px} .row p{width:260px}`,
    expected: ["SP_TEXT_OFFSCREEN"],
  },
  {
    id: "text_on_text",
    intent: "a heading printed over another heading (positioned on top of it)",
    body: `<section>${name}<div style="position:relative"><h2>季節の豆</h2><h2 class="up">焙煎所のこと</h2></div>${facts}</section>`,
    css: `${BASE} .up{position:absolute;top:6px;left:12px;margin:0} h2{margin:0}`,
    expected: ["SP_TEXT_OVERLAP"],
  },
  {
    id: "clipped_with_overprint",
    intent: "copy and the hours printed over it, both cut at the bottom by their 24 px card (by 5-8 px)",
    body: `<section>${name}<div class="card"><p class="copy">朝の一杯を、灯のそばで</p><p class="hours">8:00〜19:00</p></div><p>架空市本町3-4</p></section>`,
    css: `${BASE} .card{position:relative;height:24px;overflow:hidden} .copy{margin:0;font-size:24px;line-height:32px} .hours{position:absolute;top:4px;left:30px;margin:0;font-size:20px}`,
    expected: ["SP_TEXT_CLIPPED", "SP_TEXT_OVERLAP"],
  },
  {
    id: "covered_by_shape",
    intent: "a decorative block painted over the hours",
    body: `<section style="position:relative">${name}${facts}<div class="blob"></div></section>`,
    css: `${BASE} .blob{position:absolute;left:0;right:0;top:90px;height:120px;background:#c98b4a}`,
    expected: ["SP_TEXT_COVERED"],
  },
  {
    id: "faded_facts",
    intent: "the facts at 50% opacity",
    body: `<section>${name}<div class="f">${facts}</div></section>`,
    css: `${BASE} .f{opacity:.5}`,
    expected: ["SP_TEXT_FADED"],
  },
  {
    id: "fact_hidden_on_sp",
    intent: "the address hidden at 390 px and shown nowhere else",
    body: `<section>${name}<p>8:00〜19:00</p><p class="pc">架空市本町3-4</p></section>`,
    css: `${BASE} @media (max-width:600px){.pc{display:none}}`,
    expected: ["SP_FACT_HIDDEN"],
  },
  {
    id: "small_buttons",
    intent: "menu buttons 30 × 30",
    body: `<section>${name}${facts}<nav><a class="b" href="#a">A</a><a class="b" href="#b">B</a></nav></section>`,
    css: `${BASE} .b{display:inline-block;width:30px;height:30px}`,
    expected: ["SP_TAP_TARGET_BELOW_44"],
  },
  {
    id: "tiny_buttons",
    intent: "icon links 16 × 16",
    body: `<section>${name}${facts}<nav><a class="b" href="#a">A</a><a class="b" href="#b">B</a></nav></section>`,
    css: `${BASE} .b{display:inline-block;width:16px;height:16px;font-size:12px;overflow:hidden}`,
    // only the stronger of the two tap-target codes is recorded (DEV-134)
    expected: ["SP_TAP_TARGET_TOO_SMALL"],
  },
  {
    id: "name_below_fold",
    intent: "a 1000 px picture first, the name after it",
    body: `<section style="height:1000px;background:#3a2a1a"></section><section>${name}${facts}</section>`,
    css: BASE,
    expected: ["SP_SHOP_NAME_NOT_IN_FIRST_SCREEN"],
  },
];
