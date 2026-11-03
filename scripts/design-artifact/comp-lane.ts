/**
 * DEV-159 (Issue #193): check and render a B-route comp (index.html + style.css) for one direction, offline.
 *
 *   npx tsx scripts/design-artifact/comp-lane.ts --dir <comp dir> --facts <facts-pack.json> --out <png dir>
 *
 * 1. the copy record (<dir>/copy.json): every word's claim type and source (checkCopyRecord)
 * 2. the B-route safety check (checkPrototype: no script, no outside URL, no web font)
 * 3. every text the page can show is a text or label of the copy record: text nodes (SVG text included) and the
 *    alt / title / placeholder / aria-label / value attributes; CSS may not put words on the page (`content: "..."`)
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { chromium } from "playwright";
import {
  checkPrototype,
  PrototypeUnsafe,
} from "../../lib/design-agent/phase2f/prototype-safety";
import { renderPrototype } from "../../lib/design-agent/phase2f/render-prototype";
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
  if (!relative(REPO, resolve(out)).startsWith("..")) {
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
    facts = JSON.parse(factsRaw.toString("utf8")) as typeof facts;
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
      if (e instanceof PrototypeUnsafe)
        findings.push({ code: "PROTOTYPE_UNSAFE", detail: e.message });
      else throw e;
    }
    // the page's visible texts, parsed by Chromium on a blank page (no request leaves it)
    const ctx = await browser.newContext({ javaScriptEnabled: true });
    await ctx.route("**/*", (r) => r.abort());
    const page = await ctx.newPage();
    // a plain string, so the TypeScript build cannot inject helpers into code that runs in the page
    const EXTRACT = `(src) => {
      const d = new DOMParser().parseFromString(src, "text/html");
      const out = [];
      const stack = [d.documentElement];
      while (stack.length) {
        const n = stack.pop();
        if (n.nodeType === 3) out.push(n.textContent || "");
        else if (n.nodeType === 1 && n.tagName !== "STYLE" && n.tagName !== "SCRIPT") {
          for (const a of ["alt", "title", "placeholder", "aria-label", "value"]) if (n.hasAttribute(a)) out.push(n.getAttribute(a) || "");
          for (const c of n.childNodes) stack.push(c);
        }
      }
      return { texts: out.map((t) => t.trim()).filter(Boolean), sections: [...d.querySelectorAll("[data-section]")].map((e) => e.getAttribute("data-section") || "") };
    }`;
    const { texts, sections } = (await page.evaluate(
      `(${EXTRACT})(${JSON.stringify(html)})`,
    )) as { texts: string[]; sections: string[] };
    await ctx.close();
    // CSS may not write words: any non-empty content string (in the stylesheet, a <style> or a style attribute)
    for (const src of [css, html]) {
      const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of noComments.matchAll(/content\s*:\s*[^;}"']*(["'])((?:\\.|(?!\1).)*)\1/g)) if (m[2]!.trim()) findings.push({ code: "COMP_CSS_CONTENT_TEXT", detail: m[2]!.slice(0, 40) });
    }
    const parsed = CopyRecord.safeParse(copyRaw);
    if (parsed.success)
      for (const t of textsNotInRecord(texts, parsed.data))
        findings.push({
          code: "COMP_TEXT_NOT_IN_COPY",
          detail: t.slice(0, 60),
        });
    const shots = await renderPrototype(
      browser,
      { html, css },
      new Map(),
      sections,
    );
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
