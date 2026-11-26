import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BAKERY_PROFILE, renderBakery } from "@/experiments/pages-cms/bakery-site";
import { BuildError, buildSite, writePagesYaml } from "@/experiments/pages-cms/build";
import { addressOk, ContentError, loadContent, PHONE_MAX, phoneOk, viewOf } from "@/experiments/pages-cms/content-model";
import { PHOTO_VARIETY, Q1_TODAY, q1Fixtures, solidPng, writeFixture } from "@/experiments/pages-cms/fixtures";
import { imageMeta } from "@/experiments/pages-cms/image-meta";
import { checkPagesConfig, PHOTO_HINT, pagesConfig, pagesYaml, toYaml } from "@/experiments/pages-cms/pages-config";
import { checkPhoto, GENERATED_RECORD, PHOTO_LIMITS } from "@/experiments/pages-cms/photos";
import { classifyPrice, priceAmounts, priceDisplayReport } from "@/experiments/pages-cms/price-display";
import { safeOutDir } from "@/experiments/pages-cms/q1-check";
import { BAKERY_SITE, CAFE_SITE, SHOP_SITES } from "@/experiments/pages-cms/shop-site";
import { FACTS_MAX, factsOf, q1Summary } from "@/experiments/pages-cms/q1-render";

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
      expect(r.html.includes("「イメージ」の写真は生成した画像素材で")).toBe(r.html.includes("<figcaption class=\"cap\">イメージ</figcaption>"));
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
    expect(await code(buildSite({ repo: await edit({ image: "/media/absent.png" }), outDir: join(tmp(), "dist"), today: Q1_TODAY }))).toBe("CONTENT_PHOTO_MISSING");
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
    expect(shop.fields.filter((f) => "readonly" in f && f.readonly).map((f) => f.name)).toEqual(["name"]);
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

describe("DEV-303 Pages CMS content model (owner decisions 2026-11-26): fixed name, validated address / phone, hours, trade extensions, 総額表示 report", () => {
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ContentError || e instanceof BuildError ? e.code : String(e)));
  const editShop = async (patch: Record<string, unknown>) => {
    const repo = await fixtureRepo("items-3");
    const file = join(repo, "content", "shop.json");
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), ...patch }));
    return repo;
  };

  it("address and phone are validated (editable); the name stays the shop's fixed name", async () => {
    for (const ok of ["", "03-1234-5678", "0312345678", "090-1234-5678", "(03) 1234-5678", "+81-3-1234-5678", "0120-123-456", "+81 (0)3-1234-5678", "０３－１２３４－５６７８", "（03）1234-5678", " 03-1234-5678　"])
      expect(phoneOk(ok), ok).toBe(true);
    for (const bad of ["1234", "03-1234-567", "03--1234-5678", "tel:0312345678", "03-1234-5678 内線2", "+1-555-123-4567", "090-1234-56789", "03+1234-5678", "-03-1234-5678", "03-1234-5678-", "(03 1234-5678", "03) 1234-5678", "((03)) 1234-5678", "000-0000-0000", "+81-0-0000-0000"])
      expect(phoneOk(bad), bad).toBe(false);
    for (const ok of ["", "架空県架空市1-2-3 架空ビル2階"]) expect(addressOk(ok), ok).toBe(true);
    for (const bad of [" ", "架空市 ", "https://example.invalid", "<b>架空市</b>", "www.example.invalid"]) expect(addressOk(bad), bad).toBe(false);
    // review M2 / L1: the stored values are normalised at load (trimmed; the phone in ASCII)
    const normal = await loadContent(await editShop({ address: "架空県架空市1-2-3　", phone: "０３－１２３４－５６７８" }), BAKERY_PROFILE);
    expect([normal.shop.address, normal.shop.phone]).toEqual(["架空県架空市1-2-3", "03-1234-5678"]);
    expect(await code(loadContent(await editShop({ phone: "03-1234-567" }), BAKERY_PROFILE))).toBe("CONTENT_INVALID");
    expect(await code(loadContent(await editShop({ address: "www.example.invalid" }), BAKERY_PROFILE))).toBe("CONTENT_INVALID");
    expect(await code(loadContent(await editShop({ address: "架空県架空市9-9", phone: "03-9999-0000" }), BAKERY_PROFILE))).toBe("ok");
    expect(await code(buildSite({ repo: await editShop({ name: "別の店" }), outDir: join(tmp(), "dist"), today: Q1_TODAY }))).toBe("CONTENT_FIXED_CHANGED");
  });

  it("hours: both times on an open day, opening before closing, each day once; closures on real dates", async () => {
    const hours = (h: unknown[]) => editShop({ hours: h });
    expect(await code(loadContent(await hours([{ day: "mon", closed: false, open: "18:00", close: "08:00" }])))).toBe("CONTENT_INVALID");
    expect(await code(loadContent(await hours([{ day: "mon", closed: false, open: "08:00", close: "" }])))).toBe("CONTENT_INVALID");
    expect(await code(loadContent(await hours([{ day: "mon", open: "08:00", close: "18:00" }, { day: "mon", closed: true }])))).toBe("CONTENT_INVALID");
    expect(await code(loadContent(await hours([{ day: "tue", closed: true }, { day: "wed", open: "", close: "" }])))).toBe("ok");
    expect(await code(loadContent(await editShop({ specialClosures: [{ date: "2026-02-30" }] })))).toBe("CONTENT_INVALID");
    expect(await code(loadContent(await editShop({ specialClosures: [{ date: "2028-02-29", note: "" }] })))).toBe("ok");
    // review L5: each closure date once
    expect(await code(loadContent(await editShop({ specialClosures: [{ date: "2026-12-29" }, { date: "2026-12-29", note: "重複" }] })))).toBe("CONTENT_INVALID");
  });

  it("trade extensions are optional and per shop: the bakery shows allergens and shelf life; sizes (a cafe's) are refused here", async () => {
    const repo = await fixtureRepo("trade-extensions");
    const r = await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY });
    expect(r.html).toContain("<dt>アレルゲン</dt><dd>小麦・乳・卵</dd>");
    expect(r.html).toContain("<dt>日持ち</dt><dd>当日中</dd>");
    // review L6: the extension texts are escaped like every other text
    const evil = await fixtureRepo("trade-extensions");
    const evilFile = join(evil, "content", "menu", "item-1.json");
    writeFileSync(evilFile, JSON.stringify({ ...(JSON.parse(readFileSync(evilFile, "utf8")) as object), allergens: ["<script>", '"><img src=x>'], shelfLife: "<b>当日</b>" }));
    const escaped = (await buildSite({ repo: evil, outDir: join(tmp(), "dist"), today: Q1_TODAY })).html;
    expect(escaped).not.toMatch(/<script>|<img src=x>|<b>当日/);
    expect(escaped).toContain("<dd>&lt;script&gt;・&quot;&gt;&lt;img src=x&gt;</dd>");
    expect(escaped).toContain("<dd>&lt;b&gt;当日&lt;/b&gt;</dd>");
    const file = join(repo, "content", "menu", "item-1.json");
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), sizes: [{ label: "大", priceDisplay: "500円（税込）" }] }));
    expect(await code(buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY }))).toBe("CONTENT_EXTENSION_OFF");
    expect(await code(loadContent(repo, { ...BAKERY_PROFILE, extensions: [...BAKERY_PROFILE.extensions, "sizes"] }))).toBe("ok");
    // the CMS shows exactly the turned-on extensions
    const menuFields = (ext: Parameters<typeof pagesConfig>[0]) => pagesConfig(ext).content.find((c) => c.name === "menu")!.fields.map((f) => f.name);
    expect(menuFields({}).filter((n) => ["sizes", "allergens", "shelfLife"].includes(n))).toEqual([]);
    expect(menuFields({ extensions: BAKERY_PROFILE.extensions }).slice(-2)).toEqual(["allergens", "shelfLife"]);
    expect(checkPagesConfig(pagesConfig({ extensions: ["sizes", "allergens", "shelfLife"] }))).toEqual([]);
  });

  it("the committed bakery.pages.yml is exactly what the generator writes for the bakery (regenerate it when the model changes)", () => {
    expect(readFileSync(join(__dirname, "../../../experiments/pages-cms/bakery.pages.yml"), "utf8")).toBe(pagesYaml({ extensions: BAKERY_PROFILE.extensions }));
  });

  it("the .pages.yml: name read-only; address and phone editable with a pattern that never accepts what the build refuses on these samples", () => {
    const shop = pagesConfig().content.find((c) => c.name === "shop")!.fields as { name: string; readonly?: boolean; pattern?: { regex: string } }[];
    const field = (n: string) => shop.find((f) => f.name === n)!;
    expect([field("name").readonly, field("address").readonly, field("phone").readonly]).toEqual([true, undefined, undefined]);
    const phone = new RegExp(field("phone").pattern!.regex);
    const address = new RegExp(field("address").pattern!.regex);
    for (const s of ["", "03-1234-5678", "(03) 1234-5678", "+81-3-1234-5678"]) expect(phone.test(s) && phoneOk(s), s).toBe(true);
    for (const s of ["tel:0312345678", "03-1234-5678 内線2"]) expect(phone.test(s) || phoneOk(s), s).toBe(false);
    // full-width input the build normalises is accepted by the hint too
    expect(phone.test("０３－１２３４－５６７８") && phoneOk("０３－１２３４－５６７８")).toBe(true);
    expect(address.test("架空県架空市1-2-3") && !address.test("<b>x</b>")).toBe(true);
    // review M2: links are refused by both; surrounding spaces (incl. U+3000) are trimmed at load, so both accept them
    for (const s of ["www.example.invalid", "架空市 https://example.invalid", "WWW.EXAMPLE.INVALID", "架空市 ftp://x"]) expect([address.test(s), addressOk(s.trim())], s).toEqual([false, false]);
    for (const s of ["架空県架空市1-2-3　", " 架空県架空市1-2-3"]) expect([address.test(s), addressOk(s.trim())], s).toEqual([true, true]);
  });

  it("the 総額表示 report classifies price texts and never changes them; it never stops the build", async () => {
    expect(["324円（税込）", "本体1,000円（税込1,080円）", "1,080円(税込み)", "総額 550円", "300円（税別）", "300円+税", "¥1,280", "280円", "時価", "店頭にて", ""].map(classifyPrice)).toEqual([
      "tax_included",
      "tax_included",
      "tax_included",
      "tax_included",
      "tax_excluded_only",
      "tax_excluded_only",
      "no_tax_wording",
      "no_tax_wording",
      "no_amount",
      "no_amount",
      "empty",
    ]);
    const repo = await fixtureRepo("trade-extensions");
    const r = await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY });
    expect(r.price_report).toMatchObject({ status: "owner_check", counts: { tax_included: 2, tax_excluded_only: 1, no_tax_wording: 1, no_amount: 1, empty: 1 } });
    expect(r.price_report.findings.map((f) => [f.item, f.class, f.text])).toEqual([
      ["item-2", "tax_excluded_only", "300円（税別）"],
      ["item-3", "no_tax_wording", "¥1,280"],
    ]);
    // the page shows the texts exactly as written
    expect(r.html).toContain("300円（税別）");
    // hidden items are not shown, so not reported; sizes are reported per size
    const loaded = await loadContent(repo);
    const menu = loaded.menu.map((m, k) => (k === 1 ? { ...m, visible: false } : k === 2 ? { ...m, priceDisplay: "500円（税込）", sizes: [{ label: "大", priceDisplay: "700円" }] } : m));
    expect(priceDisplayReport({ categories: loaded.categories, menu }).findings.map((f) => [f.item, f.field])).toEqual([["item-3", "sizes.0.priceDisplay"]]);
    // review L3: an item in a hidden category is not on the page, so not reported (as viewOf)
    const hiddenCat = loaded.categories.map((c) => (c.id === menu[2]!.category ? { ...c, visible: false } : c));
    expect(priceDisplayReport({ categories: hiddenCat, menu }).findings).toEqual([]);
  });

  it("review M1 / L2: 込み alone and an unattached 総額 / 税込 do not count; tax-exclusive texts stay tax_excluded_only; kanji, full-width and ranges", () => {
    const cases: [string, string][] = [
      ["1,000円（税別・送料込み）", "tax_excluded_only"],
      ["3,000円（要申込み）", "no_tax_wording"],
      ["総額表示は店頭で 500円（税別）", "tax_excluded_only"],
      ["800円（税抜）税込価格は店頭で", "tax_excluded_only"],
      ["1,200円（サービス料込み）", "no_tax_wording"],
      ["送料込み 2,000円", "no_tax_wording"],
      ["800円（税抜）／880円（税込）", "tax_included"],
      ["税込880円", "tax_included"],
      ["880円税込", "tax_included"],
      ["500円（込）", "tax_included"],
      ["千円（税別）", "tax_excluded_only"],
      ["千円（税込）", "tax_included"],
      ["千円", "no_tax_wording"],
      ["¥480+tax", "tax_excluded_only"],
      ["３２４円（税込）", "tax_included"],
      ["￥１，２８０", "no_tax_wording"],
      ["380〜520円（税込）", "tax_included"],
      ["380〜520円", "no_tax_wording"],
      ["価格は店頭で（税込）", "no_amount"],
    ];
    expect(cases.map(([t]) => [t, classifyPrice(t)])).toEqual(cases);
  });

  it("owner request 2026-11-26: every amount in one text is checked on its own; the report names the amounts not shown tax-inclusive", async () => {
    const cases: [string, string][] = [
      ["S 400円（税込）/ M 500円（税別）", "tax_excluded_only"],
      ["S 400円（税込）/ M 500円", "no_tax_wording"],
      ["S 400円（税込）/ M 500円（税込）", "tax_included"],
      ["本体1,000円（税込1,080円）", "tax_included"],
      ["380円〜520円（税込）", "tax_included"],
      ["税込価格 1,080円", "tax_included"],
      ["1,080円（税込価格）", "tax_included"],
      ["1,080円（税・サ込）", "tax_included"],
      ["総額 3点で1,000円（税別）", "tax_excluded_only"],
      ["480", "no_tax_wording"],
      // review #360 M1: amounts without 円 / ¥ next to a tax word, or a text of numbers only
      ["1,000（税別）", "tax_excluded_only"],
      ["S 400 / M 500（税別）", "tax_excluded_only"],
      ["400 / 500", "no_tax_wording"],
      ["1,080（税込）", "tax_included"],
      ["10個入り 1,000円（税込）", "tax_included"],
      ["2026年限定 500円", "no_tax_wording"],
      // review #360 M2: compliant forms with the base price shown too, either order
      ["1,000円+税（税込1,100円）", "tax_included"],
      ["480円+tax / 528円（税込）", "tax_included"],
      ["1,080円（税抜1,000円）", "tax_included"],
      ["税込1,080円（本体1,000円）", "tax_included"],
      ["1,080円（税込）本体1,000円", "tax_included"],
      // two sizes are not a base price and its total
      ["400円（税込）/ 500円（税別）", "tax_excluded_only"],
      // review L1
      ["500円 税込価格は店頭で", "no_tax_wording"],
      // PR (3): 税込 among other words in the bracket; lists sharing the last 円 and tax words; 本体価格 … 税込 …
      ["1,000円（10%税込）", "tax_included"],
      ["1,100円（税込・10%）", "tax_included"],
      ["864円（税込8%）", "tax_included"],
      ["1,000円（2名分・税込）", "tax_included"],
      ["S400/M500/L600円（税込）", "tax_included"],
      ["S 400 M 500 L 600（税込）", "tax_included"],
      ["1,000〜1,500円+税", "tax_excluded_only"],
      ["本体価格1,000円 税込1,100円", "tax_included"],
      ["380〜520円（税込）", "tax_included"],
      // review #363 M1: a tax rate after 税別 / 税抜 is not a base price
      ["1,000円（税別10%）", "tax_excluded_only"],
      ["1,000円（税抜8%）", "tax_excluded_only"],
      ["1,000円（税別・10%）", "tax_excluded_only"],
      ["1,080円（税抜1000）", "tax_included"],
      // review #363 L2: a time is not an amount
      ["10:00〜 500円（税込）", "tax_included"],
      ["11:30〜14:00 ランチ 900円（税込）", "tax_included"],
      // review #363 L3: unclear forms stay on the safe side (the owner checks them)
      ["1,000円 ドリンク付き（税込）", "no_tax_wording"],
      ["1,000円（税込、2個で1,800円）", "no_tax_wording"],
      ["ランチ1,000円/ディナー1,500円（税込）", "no_tax_wording"],
    ];
    expect(cases.map(([t]) => [t, classifyPrice(t)])).toEqual(cases);
    expect(priceAmounts("S 400円（税込）/ M 500円（税別）").map((a) => [a.text, a.class])).toEqual([
      ["400円", "included"],
      ["500円", "excluded"],
    ]);
    const loaded = await loadContent(await fixtureRepo("trade-extensions"));
    const menu = loaded.menu.map((m, k) => (k === 0 ? { ...m, priceDisplay: "S 400円（税込）/ M 500円（税別）/ L 600円" } : m));
    const finding = priceDisplayReport({ categories: loaded.categories, menu }).findings.find((f) => f.item === "item-1")!;
    expect([finding.class, finding.amounts]).toEqual(["tax_excluded_only", ["500円", "600円"]]);
    // PR (3): a list's members without 円 are named too, with the class of the member that carries the 円 and tax words
    expect(priceAmounts("1,000〜1,500円+税").map((a) => [a.text, a.class])).toEqual([
      ["1,000", "excluded"],
      ["1,500円", "excluded"],
    ]);
    expect(priceAmounts("S400/M500/L600円（税込）").map((a) => a.class)).toEqual(["included", "included", "included"]);
    expect(priceAmounts("本体価格1,000円 税込1,100円").map((a) => [a.text, a.class])).toEqual([
      ["1,000円", "paired"],
      ["1,100円", "included"],
    ]);
  });

  it("review #360 L3: the Q1 output folder is resolved itself; a link into the repository (or anywhere) is refused", async () => {
    const base = tmp();
    const link = join(base, "out-link");
    symlinkSync(join(__dirname, "../../.."), link);
    await expect(safeOutDir(link)).rejects.toThrow(/Q1_OUT_IN_REPO_OR_LINKED/);
    const elsewhere = join(base, "real");
    mkdirSync(elsewhere);
    const link2 = join(base, "out-link-2");
    symlinkSync(elsewhere, link2);
    await expect(safeOutDir(link2)).rejects.toThrow(/Q1_OUT_IN_REPO_OR_LINKED/);
    await expect(safeOutDir(join(__dirname, "q1-out-should-not-exist"))).rejects.toThrow(/Q1_OUT_IN_REPO/);
    expect(existsSync(join(__dirname, "q1-out-should-not-exist"))).toBe(false);
    expect(await safeOutDir(join(base, "fresh"))).toBe(join(base, "fresh"));
  });

  it("the phone length: the CMS maxlength, its pattern and the build agree (PHONE_MAX)", () => {
    const phone = pagesConfig().content.find((c) => c.name === "shop")!.fields.find((f) => f.name === "phone") as { options: { maxlength: number }; pattern: { regex: string } };
    expect(phone.options.maxlength).toBe(PHONE_MAX);
    expect(phone.pattern.regex).toContain(`{10,${PHONE_MAX}}`);
    const longest = "+81 (0)3 1234 5678"; // 18 characters: well inside
    expect([longest.length <= PHONE_MAX, phoneOk(longest)]).toEqual([true, true]);
    expect(phoneOk("0".repeat(3) + "1".repeat(PHONE_MAX))).toBe(false);
  });
});

describe("DEV-303 Pages CMS (3): the shop-site interface and a second, non-bakery fictional shop (the café)", () => {
  const sha = (html: string, css: string) => createHash("sha256").update(html).update("\0").update(css).digest("hex");
  const buildOf = async (site: (typeof SHOP_SITES)[number], name: string) => {
    const repo = join(tmp(), "repo");
    await writeFixture(repo, site.fixtures()[name]!);
    return { repo, r: await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site }) };
  };

  it("the bakery's output through the interface is byte-identical to before the interface (html + css per fixture), apart from PR (4)'s イメージ figure", async () => {
    // recorded with the bakery-only build at 12d30f4c (#360 head), before the interface existed. PR (4) changed exactly
    // the picture frame (a <figure> with <figcaption>イメージ</figcaption> for generated materials), its two CSS rules
    // and the footer note; undoing those three gives the recorded bytes again, so nothing else moved.
    const undoPr4 = (html: string, css: string) => ({
      html: html
        .replace(/<figure class="frame">/g, '<div class="frame">')
        .replace(/<figcaption class="cap">イメージ<\/figcaption><\/figure>/g, "</div>")
        .replace(/<\/figure>/g, "</div>")
        .replace(/(?:<p class="note">「イメージ」の写真は生成した画像素材で、店の写真ではありません。<\/p>)?<\/footer>/, '<p class="note">写真はイメージです。</p></footer>'),
      // (the sold-out fade moved from the frame to its picture, so the イメージ label stays readable: q1-render's
      // SP_TEXT_FADED found it)
      css: css.replace(".frame{position:relative;margin:0;aspect-ratio:4/3;", ".frame{aspect-ratio:4/3;").replace(/\n\.cap\{[^\n]*\}/, "").replace(".soldout .frame img{opacity:.55}", ".soldout .frame{opacity:.55}"),
    });
    const before: Record<string, string> = {
      "items-0": "c8ee9d4930bf06d447350509c96b50d03423aab2c37471934a898f41688c3bff",
      "items-3": "8a8b4513599d1fbf69517cabb16643764a1d4085ed2ffb306b505c403df1e183",
      "items-10": "d3f074366d9b0295f659bd3583e7bb52833dd1f4410be6aabbe2f9d68222aa74",
      "items-50": "b40f23ec01e71a445c70b2b057640c904c1fab7690914f3278b510a1fdd687a8",
      "long-text": "23618d63ef9548055a7429586a9bcaa8c5437455fa048f357920a4c00ec9de5f",
      "hidden-soldout-reorder": "10346a9fc2cae88092050d40c592b568f337b1aa3739aad96089c80a297fa959",
      "hours-closures": "79b4555895a9aa939069ab7f6ca9f72cc588d13e1a8944157cd13093ae3ac803",
      "news-1": "e30fe4a291d1f0667d660a68c43b080ae0882fe3751f235595577ea6a89d47c6",
      "news-many": "4722d2deba5d7904912ed32ddf57ff254a5f32513e542513612d513c78c2f988",
      "trade-extensions": "d1bb7d41d12b9da905fe0ede54d759d6399211d3e8f899d76b6b1c6f347a3b34",
    };
    // review #365 M2: the real bytes of today's bakery output, for every fixture, so later PRs compare real output
    const current: Record<string, string> = {
      "items-0": "7357b187ef5c5d8f78bd3f69efecca65185476716e7dbfc99c930c01f6c79223",
      "items-3": "72bdd93beadfa6466c085a74e0248785054b514c36a61ecf6523950f0e927281",
      "items-10": "b6cb1f0af06886779e4439d8c1ba2c355ce8471b593df5006c2261732428427b",
      "items-50": "00f3caafcf62f1e1cbccc4930cc270c93df534e3eb2caf4fdb496bdeb7578201",
      "long-text": "3c4b7ceb710d8ae66f06ee7968938b5da44d1a606c0fc416e74ea9c4a519335d",
      "hidden-soldout-reorder": "d652873d6b6a7227fe5953dc520f3cf770141ca88a074d340c3ec5e66cec4db7",
      "hours-closures": "218786431e50f2e12d4208d362b307c2a43f8732f3f8a8fcb83938f2ae4748ae",
      "news-1": "faf429dd59e142f0bcf2b9eb30197f99b0c2439176457f6da18ceebbb50ff790",
      "news-many": "dbcdf9013678c63e6aa1837c32b84a162bec8fbe49b70dacceef1a1f99277f4a",
      "trade-extensions": "79cc4ac88befdd9b676a093382944607e1fe465d541d506058b77bc1fdc8557b",
      "photos-large-odd": "28a89648c90f583e9df359794538b0b5bedabac2af3a908773a6da73e23e1396",
    };
    const now: Record<string, string> = {};
    const nowCurrent: Record<string, string> = {};
    for (const name of Object.keys(current)) {
      const built = await buildOf(BAKERY_SITE, name);
      const viaInterface = built.r;
      const viaDefault = await buildSite({ repo: (await buildOf(BAKERY_SITE, name)).repo, outDir: join(tmp(), "dist"), today: Q1_TODAY });
      expect(viaDefault.html).toBe(viaInterface.html);
      nowCurrent[name] = sha(viaInterface.html, viaInterface.css);
      // review #365 M2: before undoing, the PR (4) parts must be exactly where they belong — one figure per shown item
      // with a picture, one caption per shown generated picture, the footer note once iff a generated picture is shown
      const shown = viewOf(await loadContent(built.repo)).sections.flatMap((s) => s.items);
      const html = viaInterface.html;
      const count = (re: RegExp) => (html.match(re) ?? []).length;
      const generatedShown = shown.filter((m) => m.image && m.imageKind === "generated").length;
      expect([count(/<figure class="frame">/g), count(/<figcaption class="cap">イメージ<\/figcaption>/g), count(/「イメージ」の写真は生成した画像素材で、店の写真ではありません。/g)], name).toEqual([
        shown.length,
        generatedShown,
        generatedShown > 0 ? 1 : 0,
      ]);
      expect(count(/<img /g), name).toBe(shown.filter((m) => m.image).length);
      if (name in before) {
        const old = undoPr4(viaInterface.html, viaInterface.css);
        now[name] = sha(old.html, old.css);
      }
    }
    expect(now).toEqual(before);
    expect(nowCurrent).toEqual(current);
  });

  it("the café builds every one of its fixtures with its own composition, its sizes, its fixed name and no bakery extension", async () => {
    for (const name of Object.keys(CAFE_SITE.fixtures())) {
      const { r } = await buildOf(CAFE_SITE, name);
      expect(r.html).not.toMatch(/<script|javascript:|https?:\/\//i);
      expect(r.html).toContain("架空のカフェ 木洩れ日珈琲");
      expect(r.html).toContain("提案用デモ（架空の店）");
      expect(r.html.includes("「イメージ」の写真は生成した画像素材で")).toBe(r.html.includes("<figcaption class=\"cap\">イメージ</figcaption>"));
    }
    const { r } = await buildOf(CAFE_SITE, "items-3");
    // a different composition from the bakery (a price list and a side column, not a card grid and a dark hero)
    expect(r.html).toContain('<ul class="list">');
    expect(r.html).toContain('<aside class="side">');
    expect(r.html).not.toMatch(/class="grid"|class="hero"/);
    expect(r.html).toContain('<li><span class="size">S</span><span class="yen">450円（税込）</span></li>');
    expect(r.css).not.toBe(BAKERY_SITE.render(await loadContent((await buildOf(BAKERY_SITE, "items-3")).repo), Q1_TODAY).css);
    // the café turns on sizes only: an allergen list is refused, and its fixed name is held
    const { repo } = await buildOf(CAFE_SITE, "items-3");
    const file = join(repo, "content", "menu", "cafe-1.json");
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), allergens: ["乳"] }));
    await expect(buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site: CAFE_SITE })).rejects.toMatchObject({ code: "CONTENT_EXTENSION_OFF" });
    const bakeryRepo = (await buildOf(BAKERY_SITE, "items-3")).repo;
    await expect(buildSite({ repo: bakeryRepo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site: CAFE_SITE })).rejects.toMatchObject({ code: "CONTENT_FIXED_CHANGED" });
  });

  it("the café's 総額表示 report checks each size's price text; its committed cafe.pages.yml shows sizes and not the bakery's fields", async () => {
    const { r } = await buildOf(CAFE_SITE, "sizes-prices");
    expect(r.price_report.findings.map((f) => [f.item, f.field, f.class, f.amounts])).toEqual([
      ["cafe-1", "sizes.1.priceDisplay", "tax_excluded_only", ["500円"]],
      ["cafe-2", "sizes.0.priceDisplay", "no_tax_wording", ["¥900"]],
    ]);
    const yml = readFileSync(join(__dirname, "../../../experiments/pages-cms/cafe.pages.yml"), "utf8");
    expect(yml).toBe(pagesYaml({ extensions: CAFE_SITE.profile.extensions }));
    expect(yml).toContain('name: "sizes"');
    expect(yml).not.toMatch(/name: "allergens"|name: "shelfLife"/);
    expect(SHOP_SITES.map((s) => s.id)).toEqual(["bakery", "cafe"]);
    // the phone checks' facts: distinct, the shop's details first, within the measure's limit of 200
    const content = await loadContent((await buildOf(CAFE_SITE, "items-50")).repo, CAFE_SITE.profile);
    const { facts, truncated } = factsOf(content);
    expect([facts.length <= FACTS_MAX, new Set(facts).size === facts.length, facts[0], truncated]).toEqual([true, true, "架空のカフェ 木洩れ日珈琲", 0]);
  });

  it("review #363 L1: the facts come from what the page shows, in page order; what is still cut is counted", async () => {
    const content = await loadContent((await buildOf(CAFE_SITE, "items-3")).repo, CAFE_SITE.profile);
    const item = (k: number, visible: boolean) => ({ ...content.menu[2]!, id: `big-${k}`, name: `大きな一覧の品 ${k}`, priceDisplay: `${100 + k}円（税込）`, sizes: undefined, visible, displayOrder: k });
    // 200 items: the first 150 hidden, the last 50 shown — every shown one is covered
    const hiddenFirst = factsOf({ ...content, menu: Array.from({ length: 200 }, (_, k) => item(k, k >= 150)) });
    expect(hiddenFirst.facts).toContain("大きな一覧の品 199");
    expect(hiddenFirst.facts).not.toContain("大きな一覧の品 0");
    expect(hiddenFirst.truncated).toBe(0);
    // 200 items all shown: 3 shop details + 400 distinct texts; the cut is reported, never silent
    const allShown = factsOf({ ...content, menu: Array.from({ length: 200 }, (_, k) => item(k, true)) });
    expect([allShown.facts.length, allShown.truncated]).toEqual([FACTS_MAX, 3 + 400 - FACTS_MAX]);
    // items in a hidden category do not use the budget either
    const hiddenCategory = factsOf({ ...content, categories: content.categories.map((c) => ({ ...c, visible: c.id !== content.menu[2]!.category })), menu: Array.from({ length: 200 }, (_, k) => item(k, true)) });
    expect(hiddenCategory.facts.some((f) => f.startsWith("大きな一覧の品"))).toBe(false);
  });

  it("#363 re-review Low: a run whose phone checks dropped facts is `incomplete`, never clean", () => {
    const row = (facts_truncated: number, render: string[] = []) => ({ fixture: "cafe-x", viewport: "sp" as const, render, direct: [], facts_truncated });
    expect(q1Summary([row(0)])).toEqual({ status: "clean", findings: 0, facts_truncated: [] });
    expect(q1Summary([row(0), row(12)])).toEqual({ status: "incomplete", findings: 0, facts_truncated: [{ fixture: "cafe-x", count: 12 }] });
    expect(q1Summary([row(12, ["SP_TEXT_CLIPPED"])]).status).toBe("findings");
  });
});

describe("DEV-303 Pages CMS (4): photos — header-only size limits, generated vs shop pictures, the イメージ figure", () => {
  // synthetic headers (no real photo is needed to read a size): JPEG SOF0, WebP VP8 / VP8L / VP8X
  const jpegHeader = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
  const riff = (chunk: string, body: Buffer) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from(chunk, "latin1"), Buffer.alloc(4), body]);
  const vp8 = (w: number, h: number) => {
    const b = Buffer.alloc(10);
    b.set([0x9d, 0x01, 0x2a], 3);
    b.writeUInt16LE(w, 6);
    b.writeUInt16LE(h, 8);
    return riff("VP8 ", b);
  };
  const vp8l = (w: number, h: number) => {
    const b = Buffer.alloc(10);
    b[0] = 0x2f;
    b.writeUInt32LE((w - 1) | ((h - 1) << 14), 1);
    return riff("VP8L", b);
  };
  const vp8x = (w: number, h: number) => {
    const b = Buffer.alloc(10);
    b.writeUIntLE(w - 1, 4, 3);
    b.writeUIntLE(h - 1, 7, 3);
    return riff("VP8X", b);
  };

  it("reads PNG / JPEG / WebP sizes from the header only; anything else is no picture", () => {
    expect(imageMeta(solidPng(640, 480, [1, 2, 3]))).toEqual({ format: "png", width: 640, height: 480 });
    expect(imageMeta(jpegHeader(1200, 800))).toEqual({ format: "jpeg", width: 1200, height: 800 });
    expect(imageMeta(vp8(1000, 750))).toEqual({ format: "webp", width: 1000, height: 750 });
    expect(imageMeta(vp8l(800, 600))).toEqual({ format: "webp", width: 800, height: 600 });
    expect(imageMeta(vp8x(4000, 3000))).toEqual({ format: "webp", width: 4000, height: 3000 });
    for (const bad of [Buffer.from("<svg></svg>"), Buffer.from("GIF89a......"), Buffer.alloc(0), solidPng(64, 64, [0, 0, 0]).subarray(0, 20)]) expect(imageMeta(bad)).toBe(null);
  });

  it("checks each picture against the limits with a named code (bytes, type, sides, pixels, ratio)", () => {
    const code = (file: string, bytes: Buffer) => {
      try {
        checkPhoto(file, bytes);
        return "ok";
      } catch (e) {
        return e instanceof ContentError ? e.code : String(e);
      }
    };
    expect(code("a.png", solidPng(1200, 800, [1, 2, 3]))).toBe("ok");
    expect(code("a.jpg", jpegHeader(4000, 3000))).toBe("ok");
    expect(code("a.webp", vp8(1000, 1000))).toBe("ok");
    // the bytes decide the type, and they must agree with the extension
    expect(code("a.jpg", solidPng(800, 600, [1, 2, 3]))).toBe("CONTENT_PHOTO_TYPE");
    expect(code("a.png", Buffer.from("not a picture"))).toBe("CONTENT_PHOTO_TYPE");
    expect(code("a.png", Buffer.concat([solidPng(800, 600, [1, 2, 3]), Buffer.alloc(PHOTO_LIMITS.bytes)]))).toBe("CONTENT_PHOTO_TOO_LARGE");
    expect(code("a.jpg", jpegHeader(5000, 3000))).toBe("CONTENT_PHOTO_DIMENSIONS");
    expect(code("a.webp", vp8x(4096, 4096))).toBe("CONTENT_PHOTO_DIMENSIONS"); // 16.8 MP > 16 MP
    expect(code("a.jpg", jpegHeader(300, 300))).toBe("CONTENT_PHOTO_TOO_SMALL");
    expect(code("a.jpg", jpegHeader(1300, 400))).toBe("CONTENT_PHOTO_RATIO");
    expect(code("a.jpg", jpegHeader(1200, 400))).toBe("ok"); // exactly 3:1
  });

  it("the build stops on an oversize, wrong-type or missing picture the page shows; a hidden item's picture is not checked", async () => {
    const withMedia = async (name: string, bytes: Buffer, visible = true) => {
      const repo = join(tmp(), "repo");
      await writeFixture(repo, BAKERY_SITE.fixtures()["items-3"]!);
      writeFileSync(join(repo, "media", name), bytes);
      const file = join(repo, "content", "menu", "item-1.json");
      writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), image: `/media/${name}`, visible }));
      return buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY }).then(() => "ok", (e: unknown) => (e instanceof ContentError ? e.code : String(e)));
    };
    expect(await withMedia("big.png", Buffer.concat([solidPng(800, 600, [1, 2, 3]), Buffer.alloc(PHOTO_LIMITS.bytes)]))).toBe("CONTENT_PHOTO_TOO_LARGE");
    expect(await withMedia("fake.jpg", solidPng(800, 600, [1, 2, 3]))).toBe("CONTENT_PHOTO_TYPE");
    expect(await withMedia("strip.png", solidPng(1500, 400, [1, 2, 3]))).toBe("CONTENT_PHOTO_RATIO");
    expect(await withMedia("strip.png", solidPng(1500, 400, [1, 2, 3]), false)).toBe("ok");
  });

  it("a generated material is shown in a <figure> with <figcaption>イメージ</figcaption>; a shop photo is not labelled — both shops", async () => {
    for (const site of SHOP_SITES) {
      const siteRepo = join(tmp(), "repo");
      await writeFixture(siteRepo, site.fixtures()["photos-large-odd"]!);
      const r = await buildSite({ repo: siteRepo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site });
      const figures = [...r.html.matchAll(/<figure class="(?:frame|thumb)">(<img [^>]*>)(<figcaption class="cap">イメージ<\/figcaption>)?<\/figure>/g)];
      // the page groups items by category, so match each figure to its item by the picture's alt text (試験の画像 <n>)
      const labelled = figures.map((m) => [Number(/試験の画像 (\d+)/.exec(m[1]!)![1]), Boolean(m[2])] as const).sort((a, b) => a[0] - b[0]);
      expect(labelled.map(([, l]) => l)).toEqual(PHOTO_VARIETY.map((p) => p.kind === "generated"));
      // the label is not hidden (materials-impl-check refuses a hidden figcaption)
      expect(r.html).not.toMatch(/<figcaption[^>]*(hidden|aria-hidden)/);
      expect(r.photos.map((p) => [p.width, p.height])).toEqual(PHOTO_VARIETY.map((p) => [p.w, p.h]));
      expect(r.html).toContain("「イメージ」の写真は生成した画像素材で、店の写真ではありません。");
    }
    // only shop photos: no イメージ label and no footer note
    const repo = join(tmp(), "repo");
    const fx = BAKERY_SITE.fixtures()["items-3"]!;
    await writeFixture(repo, { ...fx, menu: fx.menu.map((m) => ({ ...m, imageKind: "shop" as const })) });
    const shopOnly = await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY });
    expect(shopOnly.html).not.toMatch(/イメージ/);
  });

  it("review #365 M1: a delivered generated material cannot be relabelled 店の写真; the handover record is not in the CMS", async () => {
    const relabel = async (record: boolean) => {
      const repo = join(tmp(), "repo");
      const fx = BAKERY_SITE.fixtures()["photos-large-odd"]!;
      await writeFixture(repo, record ? fx : { ...fx, generated: undefined });
      // the customer marks a generated picture (item-1) as the shop's own photo
      const file = join(repo, "content", "menu", "item-1.json");
      writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), imageKind: "shop" }));
      return buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY }).then(
        (r) => (r.html.match(/イメージ<\/figcaption>/g) ?? []).length,
        (e: unknown) => (e instanceof ContentError ? e.code : String(e)),
      );
    };
    expect(await relabel(true)).toBe("CONTENT_GENERATED_AS_SHOP");
    // without the record the build cannot know (so the handover must write it)
    expect(await relabel(false)).toBe(PHOTO_VARIETY.filter((p) => p.kind === "generated").length - 1);
    // a shop's own photo (another SHA-256) is free to be marked 店の写真, also with the record present
    const repo = join(tmp(), "repo");
    await writeFixture(repo, BAKERY_SITE.fixtures()["photos-large-odd"]!);
    writeFileSync(join(repo, "media", "item-photo-1.png"), solidPng(1200, 800, [9, 9, 9]));
    const file = join(repo, "content", "menu", "item-1.json");
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), imageKind: "shop" }));
    await expect(buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY })).resolves.toBeTruthy();
    // a broken record stops the build; the record is nowhere in the CMS configuration
    writeFileSync(join(repo, GENERATED_RECORD), "{}");
    await expect(buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY })).rejects.toMatchObject({ code: "CONTENT_INVALID" });
    for (const site of SHOP_SITES) expect(pagesYaml({ extensions: site.profile.extensions })).not.toMatch(/generated-materials/);
  });

  it("review #365 L3: an upper-case extension (a phone's IMG_0001.JPG) is accepted, its bytes still decide the type", async () => {
    const repo = join(tmp(), "repo");
    await writeFixture(repo, BAKERY_SITE.fixtures()["items-3"]!);
    writeFileSync(join(repo, "media", "IMG_0001.PNG"), solidPng(800, 600, [1, 2, 3]));
    writeFileSync(join(repo, "media", "IMG_0002.JPG"), solidPng(800, 600, [1, 2, 3]));
    const file = join(repo, "content", "menu", "item-1.json");
    const item = JSON.parse(readFileSync(file, "utf8")) as object;
    writeFileSync(file, JSON.stringify({ ...item, image: "/media/IMG_0001.PNG" }));
    const r = await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY });
    expect(r.media).toContain("IMG_0001.PNG");
    writeFileSync(file, JSON.stringify({ ...item, image: "/media/IMG_0002.JPG" }));
    await expect(buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY })).rejects.toMatchObject({ code: "CONTENT_PHOTO_TYPE" });
  });

  it("the CMS shows the same limits as a hint and offers the generated / shop choice; the committed .pages.yml files follow", () => {
    const menu = pagesConfig().content.find((c) => c.name === "menu")!.fields as { name: string; description?: string; options?: { values?: { name: string }[] } }[];
    const image = menu.find((f) => f.name === "image")!;
    expect(image.description).toBe(PHOTO_HINT);
    for (const v of [`${PHOTO_LIMITS.bytes / 1024 / 1024}MB`, `${PHOTO_LIMITS.maxSide}px`, `${PHOTO_LIMITS.minSide}px`, `${PHOTO_LIMITS.maxRatio}:1`, `${PHOTO_LIMITS.maxPixels / 10_000} 万画素`]) expect(PHOTO_HINT).toContain(v);
    expect(menu.find((f) => f.name === "imageKind")!.options!.values!.map((v) => v.name)).toEqual(["generated", "shop"]);
    expect(checkPagesConfig(pagesConfig())).toEqual([]);
  });
});
