import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { renderDemo, renderDesignedDemo } from "@/components/demo/renderDemo";
import { factsToDemoView, loadPreviewRun } from "@/lib/design-agent/preview";
import { guardShopCss, SHOP_CSS_SCOPE_ID, type GuardedShopCss } from "@/lib/design-agent/shop-css/guard";
import { shopCssFromRecord, shopCssRecord } from "@/lib/design-agent/shop-css/record";
import { AMERICAN_EDITORIAL, SHOP } from "../fixtures";

// DEV-072: only the local design preview can load a per-shop stylesheet, and
// only a guarded one, scoped to the canvas. Public /demo and the admin
// preview cannot (no prop, no code path), checked on the markup and the source.

const CSS = (() => {
  const r = guardShopCss("#shop-css h1 { color: var(--p-primary); letter-spacing: 0.02em; }");
  if (!r.ok) throw new Error("fixture");
  return r.css;
})();

describe("renderer: the shop stylesheet's scope", () => {
  it("without a stylesheet the markup is unchanged (no scope, no style)", () => {
    const html = renderToStaticMarkup(<ProfileRenderer demo={SHOP} profile={AMERICAN_EDITORIAL} />);
    expect(html).toBe(renderToStaticMarkup(<ProfileRenderer demo={SHOP} profile={AMERICAN_EDITORIAL} shopCss={null} />));
    expect(html).not.toContain("data-shop-css");
    expect(html).not.toContain(`id="${SHOP_CSS_SCOPE_ID}"`);
    expect(html).not.toContain("<style");
  });

  it("a guarded stylesheet: a <style> outside the canvas, the canvas is the scope root with its own stacking context", () => {
    const html = renderToStaticMarkup(<ProfileRenderer demo={SHOP} profile={AMERICAN_EDITORIAL} shopCss={CSS} />);
    expect(html).toContain(`<style data-shop-css-style="">${CSS}</style><div id="shop-css" data-shop-css="" style="isolation:isolate;overflow:clip" class=`);
    expect(html.match(/<style/g)).toHaveLength(1);
    // the notice comes before the style, the footer after the canvas: neither is inside the scope
    expect(html.indexOf('role="note"')).toBeLessThan(html.indexOf("<style"));
  });

  it("an unguarded string is never rendered (the renderer guards again)", () => {
    for (const raw of ["p { color: red }", "#shop-css { background-image: url(x) }", `${CSS}\n#shop-css p { color: #000 }`, "</style><script>alert(1)</script>"]) {
      const html = renderToStaticMarkup(<ProfileRenderer demo={SHOP} profile={AMERICAN_EDITORIAL} shopCss={raw as GuardedShopCss} />);
      expect(html, raw).not.toContain("<style");
      expect(html).not.toContain("data-shop-css");
      expect(html).not.toContain("<script");
    }
  });
});

describe("public /demo and the admin preview cannot load a shop stylesheet", () => {
  it("renderDesignedDemo and renderDemo take no stylesheet and draw no scope", () => {
    expect(renderDesignedDemo.length).toBe(2);
    expect(renderDemo.length).toBe(1);
    for (const html of [renderToStaticMarkup(renderDesignedDemo(SHOP, AMERICAN_EDITORIAL)), renderToStaticMarkup(renderDesignedDemo(SHOP, null)), renderToStaticMarkup(renderDemo(SHOP))]) {
      expect(html).not.toContain("data-shop-css");
      expect(html).not.toContain("<style");
    }
  });

  it("no source outside the local design preview mentions the shop stylesheet", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(join(process.cwd(), "app"));
    walk(join(process.cwd(), "components"));
    walk(join(process.cwd(), "lib"));
    const allowed = new Set(["app/design-preview/[runId]/page.tsx", "components/demo/profile/ProfileRenderer.tsx", "lib/design-agent/preview.ts"]);
    const users = files.map((f) => f.slice(process.cwd().length + 1)).filter((f) => !f.startsWith("lib/design-agent/shop-css/") && /shopCss|shop-css|ShopCss/.test(readFileSync(join(process.cwd(), f), "utf8")));
    expect(users.filter((f) => !allowed.has(f))).toEqual([]);
    // the public and admin pages render through renderDesignedDemo only
    for (const page of ["app/demo/[publicToken]/page.tsx", "app/admin/preview/[prospectId]/page.tsx"]) expect(readFileSync(join(process.cwd(), page), "utf8")).not.toMatch(/shopCss|shop-css/);
  });
});

describe("design preview: an accepted stylesheet's record", () => {
  let root: string;
  const runId = "run-shopcss-1";
  const FACTS = { name: "EXAMPLE TEST", category: "baked_goods", ward: "北区", address: "名古屋市北区テスト町1-2-3", description: "テスト用の架空の紹介文です。" };
  const DEMO = factsToDemoView(FACTS)!;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "shop-css-test-"));
    const run = join(root, runId);
    await mkdir(run);
    await writeFile(join(run, "facts.json"), JSON.stringify(FACTS));
    for (const c of ["candidate-0", "candidate-1", "candidate-2", "candidate-3", "candidate-4"]) await writeFile(join(run, `${c}.json`), JSON.stringify(AMERICAN_EDITORIAL));
    await writeFile(join(run, "candidate-0.shop-css.json"), JSON.stringify(shopCssRecord(runId, "candidate-0", AMERICAN_EDITORIAL, DEMO, CSS)));
    // a record for another candidate, for another profile, and one whose CSS was edited after the check
    await writeFile(join(run, "candidate-1.shop-css.json"), JSON.stringify(shopCssRecord(runId, "candidate-0", AMERICAN_EDITORIAL, DEMO, CSS)));
    await writeFile(join(run, "candidate-2.shop-css.json"), JSON.stringify(shopCssRecord(runId, "candidate-2", { ...AMERICAN_EDITORIAL, confidence: 0.5 }, DEMO, CSS)));
    const edited = { ...shopCssRecord(runId, "candidate-3", AMERICAN_EDITORIAL, DEMO, CSS), css: `${CSS}\n#shop-css p {\n  color: #fff;\n}` };
    await writeFile(join(run, "candidate-3.shop-css.json"), JSON.stringify(edited));
    // checked with other facts (the run's facts.json was replaced since)
    await writeFile(join(run, "candidate-4.shop-css.json"), JSON.stringify(shopCssRecord(runId, "candidate-4", AMERICAN_EDITORIAL, { ...DEMO, phone: "052-111-1111" }, CSS)));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads only a matching, still-guarded record", async () => {
    expect((await loadPreviewRun(root, runId, "candidate-0"))?.shopCss).toBe(CSS);
    expect((await loadPreviewRun(root, runId, "candidate-1"))?.shopCss).toBeNull();
    expect((await loadPreviewRun(root, runId, "candidate-2"))?.shopCss).toBeNull();
    expect((await loadPreviewRun(root, runId, "candidate-3"))?.shopCss).toBeNull();
    expect((await loadPreviewRun(root, runId, "candidate-4"))?.shopCss).toBeNull();
    expect((await loadPreviewRun(root, runId, "none"))?.shopCss).toBeUndefined();
  });

  it("rejects a record whose CSS fails the guard even with a matching hash", () => {
    const bad = "#shop-css { background-image: url(x) }";
    const record = { ...shopCssRecord(runId, "candidate-0", AMERICAN_EDITORIAL, DEMO, CSS), css: bad, cssSha256: createHash("sha256").update(bad).digest("hex") };
    expect(shopCssFromRecord(record, runId, "candidate-0", AMERICAN_EDITORIAL, DEMO)).toBeNull();
    expect(shopCssFromRecord({ ...shopCssRecord(runId, "candidate-0", AMERICAN_EDITORIAL, DEMO, CSS), report: { accepted: false, guard: [], render: [] } }, runId, "candidate-0", AMERICAN_EDITORIAL, DEMO)).toBeNull();
    expect(shopCssFromRecord(shopCssRecord(runId, "candidate-0", AMERICAN_EDITORIAL, DEMO, CSS), runId, "candidate-0", AMERICAN_EDITORIAL, DEMO)).toBe(CSS);
  });
});
