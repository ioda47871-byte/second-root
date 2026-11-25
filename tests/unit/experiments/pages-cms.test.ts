import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderBakery } from "@/experiments/pages-cms/bakery-site";
import { BuildError, buildSite, writePagesYaml } from "@/experiments/pages-cms/build";
import { ContentError, loadContent, viewOf } from "@/experiments/pages-cms/content-model";
import { Q1_TODAY, q1Fixtures, writeFixture } from "@/experiments/pages-cms/fixtures";
import { checkPagesConfig, pagesConfig, pagesYaml, toYaml } from "@/experiments/pages-cms/pages-config";

// DEV-303 §6.1 rows 10–12 and §3.7 Q1, first experiment (docs/design/pages-cms-implementation-plan.md): the shared
// content model, the generated Pages CMS configuration and the static build of ONE fictional bakery. FICTIONAL and
// LOCAL only (no GitHub, Cloudflare or Pages CMS). No browser here: the PC/SP look is experiments/pages-cms/q1-check.ts.

const temps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sr-pcms-")));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const fixtureRepo = async (name: string) => {
  const repo = join(tmp(), "repo");
  await writeFixture(repo, q1Fixtures()[name]!);
  return repo;
};

/** A reader for exactly the block YAML toYaml writes (maps, lists, JSON scalars, flow lists of scalars). */
function readYaml(text: string): unknown {
  const lines = text.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  let i = 0;
  const ind = (l: string) => l.length - l.trimStart().length;
  const value = (v: string): unknown => JSON.parse(v);
  function block(level: number): unknown {
    if (lines[i]!.trimStart().startsWith("- ")) {
      const arr: unknown[] = [];
      while (i < lines.length && ind(lines[i]!) === level && lines[i]!.trimStart().startsWith("- ")) {
        const rest = lines[i]!.slice(level + 2);
        if (!/^[A-Za-z_][A-Za-z0-9_-]*:/.test(rest)) {
          arr.push(value(rest));
          i++;
          continue;
        }
        lines[i] = `${" ".repeat(level + 2)}${rest}`;
        arr.push(block(level + 2));
      }
      return arr;
    }
    const obj: Record<string, unknown> = {};
    while (i < lines.length && ind(lines[i]!) === level && !lines[i]!.trimStart().startsWith("- ")) {
      const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/.exec(lines[i]!.trim())!;
      i++;
      if (m[2] !== undefined) obj[m[1]!] = value(m[2]);
      else obj[m[1]!] = block(ind(lines[i]!));
    }
    return obj;
  }
  return block(0);
}

describe("DEV-303 Pages CMS experiment: the content model and the fictional bakery's build", () => {
  it("builds every Q1 fixture; hidden items and categories out, display order kept, sold-out marked, past closures dropped, no script", async () => {
    for (const name of Object.keys(q1Fixtures())) {
      const repo = await fixtureRepo(name);
      const r = await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY });
      expect(r.html).not.toMatch(/<script|javascript:|https?:\/\//i);
      expect(r.html).toContain("提案用デモ（架空の店）");
      expect(r.html).toContain("写真はイメージです。");
    }
    const states = viewOf(await loadContent(await fixtureRepo("hidden-soldout-reorder")));
    const shown = states.sections.flatMap((s) => s.items);
    expect(shown.every((m) => m.visible)).toBe(true);
    expect(shown.length).toBe(8);
    for (const s of states.sections) expect(s.items.map((m) => m.displayOrder)).toEqual([...s.items.map((m) => m.displayOrder)].sort((a, b) => a - b));
    const html = renderBakery(await loadContent(await fixtureRepo("hidden-soldout-reorder")), Q1_TODAY).html;
    expect(html.match(/>売り切れ</g)?.length).toBe(shown.filter((m) => m.soldOut).length);
    const hours = renderBakery(await loadContent(await fixtureRepo("hours-closures")), Q1_TODAY).html;
    expect(hours).not.toContain("過ぎた休業");
    expect(hours).toContain("2026-12-29");
    expect(hours).toContain("07:30–15:00");
    expect(renderBakery(await loadContent(await fixtureRepo("items-0")), Q1_TODAY).html).toContain("ただいまメニューを準備しています。");
    const news = viewOf(await loadContent(await fixtureRepo("news-many"))).news;
    expect([news.length, news[0]!.publishedAt]).toEqual([11, "2026-11-12"]);
    expect(renderBakery(await loadContent(await fixtureRepo("items-3")), Q1_TODAY).html).not.toContain('id="news"');
  });

  it("escapes every text from the content; the content cannot add markup, styles or scripts", async () => {
    const repo = await fixtureRepo("items-3");
    const file = join(repo, "content", "menu", "item-1.json");
    const item = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...item, name: '<img src=x onerror=alert(1)>"', description: "<style>body{display:none}</style>&" }));
    const { html, css } = renderBakery(await loadContent(repo), Q1_TODAY);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<style>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;");
    expect(css).not.toContain("display:none}");
  });

  it("refuses content it cannot trust: unknown keys, an unknown category, duplicate ids, a picture path outside media/, a missing picture", async () => {
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ContentError || e instanceof BuildError ? e.code : String(e)));
    const edit = async (patch: Record<string, unknown>, name = "item-1.json") => {
      const repo = await fixtureRepo("items-3");
      const file = join(repo, "content", "menu", name);
      writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), ...patch }));
      return repo;
    };
    expect(await code(loadContent(await edit({ css: "body{}" })))).toBe("CONTENT_INVALID");
    expect(await code(loadContent(await edit({ category: "drinks" })))).toBe("CONTENT_UNKNOWN_CATEGORY");
    expect(await code(loadContent(await edit({ id: "item-2" })))).toBe("CONTENT_DUPLICATE_ID");
    expect(await code(loadContent(await edit({ image: "https://example.invalid/a.png" })))).toBe("CONTENT_INVALID");
    expect(await code(loadContent(await edit({ image: "/media/../secret.png" })))).toBe("CONTENT_INVALID");
    expect(await code(buildSite({ repo: await edit({ image: "/media/absent.png" }), outDir: join(tmp(), "dist"), today: Q1_TODAY }))).toBe("BUILD_MEDIA_MISSING");
  });
});

describe("DEV-303 Pages CMS experiment: the generated .pages.yml", () => {
  it("matches the documented configuration keys; only the customer's information is editable", async () => {
    const config = pagesConfig();
    expect(checkPagesConfig(config)).toEqual([]);
    expect(config.content.map((c) => [c.name, c.type, c.path])).toEqual([
      ["menu", "collection", "content/menu"],
      ["categories", "collection", "content/categories"],
      ["shop", "file", "content/shop.json"],
      ["news", "collection", "content/news"],
    ]);
    // nothing editable points at the page code, the CSS, the build or the configuration itself
    expect(JSON.stringify(config)).not.toMatch(/style\.css|index\.html|\.pages\.yml|build|dist|package\.json/);
    const shop = config.content.find((c) => c.name === "shop")!;
    expect(shop.fields.filter((f) => "readonly" in f && f.readonly).map((f) => f.name)).toEqual(["name", "address", "phone"]);
    // review M2: the category reference stores the category's id and shows its name field ({name} would be the entry's file name)
    const category = config.content.find((c) => c.name === "menu")!.fields.find((f) => f.name === "category")!;
    expect(category.options).toEqual({ collection: "categories", value: "{fields.id}", label: "{fields.name}" });
    // the documented-schema check is not vacuous
    expect(checkPagesConfig({ ...config, content: [{ ...config.content[0]!, fields: [{ name: "x", type: "colour" }] }] }).length).toBeGreaterThan(0);
    expect(checkPagesConfig({ ...config, content: [{ ...config.content[0]!, fields: [{ name: "x", type: "string", options: { values: [] } }] }] })).toEqual(["content.0.fields.0: option values is not documented for string"]);
    expect(checkPagesConfig({ ...config, extra: true }).length).toBeGreaterThan(0);
  });

  it("the YAML holds exactly the configuration (read back), and is written at the repository root", async () => {
    expect(readYaml(pagesYaml())).toEqual(JSON.parse(JSON.stringify(pagesConfig())));
    expect(readYaml(toYaml({ a: [1, "x"], b: { c: [{ d: true, e: [] }] } }))).toEqual({ a: [1, "x"], b: { c: [{ d: true, e: [] }] } });
    const repo = await fixtureRepo("items-3");
    const text = await writePagesYaml(repo);
    expect(readFileSync(join(repo, ".pages.yml"), "utf8")).toBe(text);
    // every content path of the configuration exists in a built shop repository
    for (const c of pagesConfig().content) expect(existsSync(join(repo, c.path))).toBe(true);
    expect(existsSync(join(repo, pagesConfig().media.input))).toBe(true);
  });
});
