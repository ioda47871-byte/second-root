/**
 * DEV-159 (Issue #193): check and render a B-route comp (index.html + style.css) for one direction, offline.
 *
 *   npx tsx scripts/design-artifact/comp-lane.ts --dir <comp dir> --facts <facts-pack.json> --out <png dir>
 *
 * 1. the copy record (<dir>/copy.json): every word's claim type and source (checkCopyRecord)
 * 2. the B-route safety check (checkPrototype: no script, no outside URL, no web font)
 * 3. every text the page can show is a text or label of the copy record: text nodes (SVG text included; a line
 *    broken with <br> is read as one line) and the alt / title / placeholder / aria-label / value / label / start
 *    attributes. CSS may not put words on the page: written and computed content, quotes, list markers, emphasis
 *    marks, hyphenation characters and counters are refused, as are templates and shadow roots, a visible <style>,
 *    and controls the browser captions by itself (see docs/design/comp-lane.md; a denylist, not a proof)
 * 4. render PC 1440 and SP 390 with JavaScript off and the network shut (renderPrototype); write desktop.png and
 *    mobile.png to --out (outside the repository, refused otherwise) and print their SHA-256, size, section boxes,
 *    overflow, and whether <dir>/review.json is of these renders (it is when rendered where the review was made;
 *    fonts make the bytes machine-dependent, so a mismatch elsewhere is reported, not failed)
 *
 *   npx tsx scripts/design-artifact/comp-lane.ts --check-review <comp dir>
 *
 * checks <dir>/review.json (Claude's own review of the renders, comp_review_v1) without a browser: it is of this
 * comp's files, its references are VISUAL_VERIFIED reads and quote their `learn` lines, the crops cover the renders.
 * The render bytes depend on the machine's fonts, so they are compared only where the comp is rendered.
 *
 * Exit 0 when all hold, 1 when a check fails, 2 for a usage or input error. The PNGs are for Claude and the owner to
 * look at; a passing run is not a quality verdict.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import {
  checkPrototype,
  PrototypeUnsafe,
} from "../../lib/design-agent/phase2f/prototype-safety";
import { RenderError, renderPrototype } from "../../lib/design-agent/phase2f/render-prototype";
import { FactsPack } from "../../lib/design-agent/artifact/schema";
import { checkCompReview } from "../../lib/design-agent/quality-pipeline/comp-review";
import {
  checkCopyRecord,
  CopyRecord,
  textsNotInRecord,
} from "../../lib/design-agent/quality-pipeline/copy-record";
import { checkAllReads } from "./visual-read";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");

const REPO = resolve(__dirname, "../..");

/** Whether a path is in the repository, after following links of its nearest existing ancestor. */
export function insideRepo(p: string): boolean {
  let probe = resolve(p);
  const rest: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) {
    rest.unshift(basename(probe));
    probe = dirname(probe);
  }
  const real = join(realpathSync(probe), ...rest);
  const rel = relative(realpathSync(REPO), real);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** The review of a comp against its files, Claude's VISUAL_VERIFIED reads and the known failure codes. */
export function checkReviewFile(
  dir: string,
  renders: Parameters<typeof checkCompReview>[1]["renders"] = null,
) {
  const reads = checkAllReads().filter(
    (r) => r.check.ok && r.bytes === "in_repo",
  );
  const verifiedReads = Object.fromEntries(
    reads.map((r) => [
      r.file,
      (
        JSON.parse(readFileSync(join(REPO, r.file), "utf8")) as {
          observation: { learn: string[] };
        }
      ).observation.learn,
    ]),
  );
  const principles = JSON.parse(
    readFileSync(
      join(REPO, "design-library/research/quality-pipeline/principles-v1.json"),
      "utf8",
    ),
  ) as { failure_codes: Array<{ code: string }> };
  return checkCompReview(
    JSON.parse(readFileSync(join(dir, "review.json"), "utf8")),
    {
      renders,
      verifiedReads,
      failureCodes: principles.failure_codes.map((f) => f.code),
      comp: {
        html_sha256: sha(readFileSync(join(dir, "index.html"))),
        css_sha256: sha(readFileSync(join(dir, "style.css"))),
        copy_sha256: sha(readFileSync(join(dir, "copy.json"))),
      },
    },
  );
}

async function main(): Promise<number> {
  const reviewDir = arg("--check-review");
  if (reviewDir) {
    try {
      const r = checkReviewFile(resolve(reviewDir));
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return r.ok ? 0 : 1;
    } catch (e) {
      process.stderr.write(`INPUT_ERROR: ${(e as Error).message}\n`);
      return 2;
    }
  }
  const [dir, factsPath, out] = [arg("--dir"), arg("--facts"), arg("--out")];
  if (!dir || !factsPath || !out) {
    process.stderr.write(
      "USAGE: --dir <comp dir> --facts <facts-pack.json> --out <png dir>\n",
    );
    return 2;
  }
  if (insideRepo(out)) {
    process.stderr.write("INPUT_ERROR: --out must be outside the repository (renders are not committed)\n");
    return 2;
  }
  let html: string, css: string, copyRaw: unknown, factsRaw: Buffer;
  let facts: { shop_id: string; facts: Array<{ id: string; value: string }> };
  try {
    html = readFileSync(join(dir, "index.html"), "utf8");
    css = readFileSync(join(dir, "style.css"), "utf8");
    copyRaw = JSON.parse(readFileSync(join(dir, "copy.json"), "utf8"));
    factsRaw = readFileSync(factsPath);
    facts = FactsPack.parse(JSON.parse(factsRaw.toString("utf8")));
  } catch (e) {
    process.stderr.write(`INPUT_ERROR: ${(e as Error).message}\n`);
    return 2;
  }
  const findings: Array<{ code: string; detail?: string }> = [];
  const copy = checkCopyRecord(copyRaw, {
    shopId: facts.shop_id,
    factsSha256: sha(factsRaw),
    facts: facts.facts,
  });
  findings.push(
    ...copy.findings.map((f) => ({
      code: f.code,
      detail: [f.item, f.detail].filter(Boolean).join(":"),
    })),
  );
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  try {
    try {
      await checkPrototype(browser, { html, css }, []);
    } catch (e) {
      if (!(e instanceof PrototypeUnsafe)) throw e;
      // an unsafe comp is neither opened again nor rendered
      findings.push({ code: "PROTOTYPE_UNSAFE", detail: e.message });
      process.stdout.write(`${JSON.stringify({ status: "FAIL", findings }, null, 2)}\n`);
      return 1;
    }
    // the page's texts and its styles, as Chromium parses them, with JavaScript off and every request refused. The
    // stylesheet is parsed on its own (not through the page's link), so no spelling of the link can hide it.
    const ctx = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    await ctx.route("**/*", (r) => r.abort());
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    // a plain string, so the TypeScript build cannot inject helpers into code that runs in the page
    const EXTRACT = `() => {
      const out = [];
      const css = [];
      const bad = [];
      // the comp's style.css, parsed on its own
      const own = new CSSStyleSheet();
      own.replaceSync(__COMP_CSS__);
      const links = [...document.querySelectorAll("link")];
      if (links.length !== 1 || links[0].getAttribute("href") !== "style.css" || (links[0].getAttribute("rel") || "").toLowerCase() !== "stylesheet") bad.push("link: exactly one <link rel=\\"stylesheet\\" href=\\"style.css\\"> is allowed");
      // templates are refused wherever they are, open or closed, before the parser can attach them as shadow roots
      const raw = new DOMParser().parseFromString(__COMP_HTML__, "text/html");
      if (raw.querySelector("template")) bad.push("shadow root or <template>: template");
      const stack = [document.documentElement];
      while (stack.length) {
        const n = stack.pop();
        if (n.nodeType === 3) { if (!n.__joined) out.push(n.textContent || ""); }
        else if (n.nodeType === 1 && n.localName !== "style" && n.localName !== "script") {
          // text in a shadow tree or a template is outside this walk: refused
          if (n.shadowRoot || n.tagName === "TEMPLATE") bad.push("shadow root or <template>: " + n.tagName.toLowerCase());
          for (const a of ["alt", "title", "placeholder", "aria-label", "value", "label", "start"]) if (n.hasAttribute(a)) out.push(n.getAttribute(a) || "");
          // words the browser writes by itself (button captions, file pickers, a details without summary)
          if (n.localName === "input" && ["submit", "reset", "button", "file", "image", "date", "datetime-local", "time", "month", "week"].includes((n.getAttribute("type") || "").toLowerCase())) bad.push("input type=" + n.getAttribute("type"));
          if (n.localName === "details" && !n.querySelector(":scope > summary")) bad.push("details without summary");
          if (n.style && n.style.length) css.push(["inline", n.style]);
          // a line broken with a direct <br> or <wbr> is one line of the record: read the element's own text joined
          if ([...n.children].some((c) => c.localName === "br" || c.localName === "wbr")) {
            const own = [...n.childNodes].filter((c) => c.nodeType === 3);
            out.push(own.map((c) => c.textContent || "").join(""));
            for (const c of own) c.__joined = true;
          }
          for (const c of n.childNodes) stack.push(c);
        }
      }
      // every style rule, in every sheet and every nested group (@media, @supports, @layer, @container)
      const rules = [];
      const walk = (list) => { for (const r of list) { if (r.style) rules.push(r); if (r.cssRules) walk(r.cssRules); if (r.constructor && r.constructor.name === "CSSCounterStyleRule") rules.push({ counterStyle: true }); } };
      for (const s of document.styleSheets) walk(s.cssRules);
      walk(own.cssRules);
      for (const r of rules) {
        if (r.counterStyle) { bad.push("@counter-style"); continue; }
        css.push(["rule", r.style]);
      }
      const words = /attr\\(|counters?\\(|var\\(|env\\(|["']/i;
      for (const [, st] of css) {
        const content = st.getPropertyValue("content").trim();
        if (content && !["none", "normal", '""', "''"].includes(content)) bad.push("content: " + content);
        const quotes = st.getPropertyValue("quotes").trim();
        if (quotes && !["none", "auto"].includes(quotes)) bad.push("quotes: " + quotes);
        for (const p of ["list-style-type", "list-style", "text-emphasis", "text-emphasis-style", "-webkit-text-emphasis", "-webkit-text-emphasis-style"]) { const v = st.getPropertyValue(p).trim(); if (v && words.test(v)) bad.push(p + ": " + v); }
        for (const p of ["hyphenate-character", "-webkit-hyphenate-character"]) { const v = st.getPropertyValue(p).trim(); if (v && v !== "auto") bad.push(p + ": " + v); }
        for (const p of ["counter-set", "counter-reset", "counter-increment"]) { const v = st.getPropertyValue(p).trim(); if (v && v !== "none") bad.push(p + ": " + v); }
      }
      // and the values as computed (var() resolved), with style.css applied to the document: no element or pseudo
      // element may get its words from CSS
      document.adoptedStyleSheets = [own];
      const textual = (v) => /["']|attr\\(|counters?\\(/.test(v);
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        // a <style> (or <script>) made visible by CSS shows its source as text
        // (every namespace but SVG, whose <style> never draws its text: an HTML or MathML <style> shown by CSS does)
        if ((el.localName === "style" || el.localName === "script") && el.namespaceURI !== "http://www.w3.org/2000/svg" && cs.display !== "none") bad.push("visible <" + el.localName + ">");
        for (const p of ["list-style-type", "text-emphasis-style", "-webkit-text-emphasis-style"]) { const v = cs.getPropertyValue(p); if (v && textual(v)) bad.push("computed " + p + ": " + v); }
        for (const pseudo of ["::before", "::after", "::marker"]) {
          // an empty string is a decorative pseudo element (a line, a rule): allowed, as in the written check
          const v = getComputedStyle(el, pseudo).getPropertyValue("content").replace(/""|''/g, "").trim();
          if (v && v !== "none" && v !== "normal" && textual(v)) bad.push("computed " + pseudo + " content: " + v);
        }
      }
      // a soft hyphen is invisible in the text but can show any hyphenation character
      if (out.some((x) => x.includes("\\u00ad"))) bad.push("soft hyphen (U+00AD) in the page");
      return { texts: out.map((x) => x.trim()).filter(Boolean), sections: [...document.querySelectorAll("[data-section]")].map((x) => x.getAttribute("data-section") || ""), bad };
    }`;
    const { texts, sections, bad } = (await page.evaluate(`(${EXTRACT.replace(/__COMP_(CSS|HTML)__/g, (_m, k: string) => JSON.stringify(k === "CSS" ? css : html))})()`)) as { texts: string[]; sections: string[]; bad: string[] };
    await ctx.close();
    // CSS may not write words: content, quotes, list markers, counters and @counter-style are refused, as parsed
    for (const b of bad) findings.push({ code: "COMP_CSS_CONTENT_TEXT", detail: b.slice(0, 60) });
    const parsed = CopyRecord.safeParse(copyRaw);
    if (parsed.success)
      for (const t of textsNotInRecord(texts, parsed.data))
        findings.push({
          code: "COMP_TEXT_NOT_IN_COPY",
          detail: t.slice(0, 60),
        });
    let shots: Awaited<ReturnType<typeof renderPrototype>>;
    try {
      shots = await renderPrototype(
      browser,
      { html, css },
      new Map(),
      sections,
    );
    } catch (e) {
      if (!(e instanceof RenderError)) throw e;
      findings.push({ code: "COMP_RENDER_FAILED", detail: `${e.message}` });
      process.stdout.write(`${JSON.stringify({ status: "FAIL", findings }, null, 2)}\n`);
      return 1;
    }
    mkdirSync(out, { recursive: true });
    const renders: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(shots)) {
      const name = key.startsWith("desktop") ? "desktop.png" : "mobile.png";
      writeFileSync(join(out, name), v.png);
      if (v.blocked)
        findings.push({ code: "COMP_NETWORK_ATTEMPT", detail: key });
      if (v.scrollWidth > (key.startsWith("desktop") ? 1440 : 390))
        findings.push({
          code: "COMP_HORIZONTAL_OVERFLOW",
          detail: `${key}:${v.scrollWidth}`,
        });
      for (const [id, box] of Object.entries(v.sections))
        if (!box || box.h === 0)
          findings.push({
            code: "COMP_SECTION_NOT_SHOWN",
            detail: `${key}:${id}`,
          });
      renders[key] = {
        file: resolve(out, name),
        sha256: sha(v.png),
        width: v.scrollWidth,
        height: v.scrollHeight,
        sections: v.sections,
      };
    }
    // the review, if there is one, against these renders
    let review: unknown = "none";
    if (existsSync(join(dir, "review.json"))) {
      const now = (k: "desktop_1440" | "mobile_390") => ({ sha256: sha(shots[k].png), width: shots[k].scrollWidth, height: shots[k].scrollHeight });
      const withRenders = checkReviewFile(dir, { desktop: now("desktop_1440"), mobile: now("mobile_390") });
      const structural = withRenders.codes.filter((c) => !c.startsWith("RENDER_MISMATCH_"));
      for (const c of structural) findings.push({ code: `REVIEW_${c}` });
      review = { structural_ok: structural.length === 0, renders_match_here: withRenders.codes.every((c) => !c.startsWith("RENDER_MISMATCH_")) };
    }
    process.stdout.write(
      `${JSON.stringify({ status: findings.length ? "FAIL" : "OK", findings, html_sha256: sha(html), css_sha256: sha(css), copy_sha256: sha(readFileSync(join(dir, "copy.json"))), renders, review }, null, 2)}\n`,
    );
    return findings.length ? 1 : 0;
  } finally {
    await browser.close();
  }
}

if (require.main === module)
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`BUG: ${(e as Error).stack ?? String(e)}\n`);
      process.exit(3);
    },
  );
