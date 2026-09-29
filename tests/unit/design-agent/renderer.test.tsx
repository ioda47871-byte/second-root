import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { locationLabels, monogram, nameLines, WARD_ROMAJI } from "@/components/demo/profile/text";
import { CATEGORY_DEFAULT_PROFILES } from "@/lib/design-agent/defaults";
import { loadPreviewRun, previewRoot } from "@/lib/design-agent/preview";
import { DIVIDERS, HERO_LAYOUTS, INFO_STYLES, MOTIFS, type DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { ADDRESS_ONLY_SHOP, AMERICAN_EDITORIAL, MINIMAL_SHOP, SHOP } from "./fixtures";

// The profile renderer may show verified facts and fixed template copy only.
// A profile changes how the page looks; nothing in it can become page text.

function visibleText(html: string): string[] {
  return html
    .replace(/<(svg)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((t) => t.replace(/&amp;/g, "&").trim())
    .filter(Boolean);
}

const FIXED_COPY = [
  "これは", "Second Root", "が作成した", "ご提案用のデモページ", "です。", "様の公式サイトではありません。",
  "このページは、", "様に向けて Second Root が公開情報をもとに作成したデモです。",
  "掲載内容は確認できた公開情報のみで、公式サイト・公式情報ではありません。",
  "Second Root（セカンドルート）｜名古屋の小さなお店のホームページ制作",
  "営業時間", "定休日", "住所", "アクセス", "電話", "メニュー", "店舗のご案内",
  "名古屋市の", "名古屋の", "パン屋", "焼菓子店", "カフェ", "名古屋市",
];
const WHOLE_NODES = ["Bakery", "Baked Goods", "Cafe", "About", "Menu", "Visit", "Hours", "Closed", "Address", "Access", "Tel", "NAGOYA",
  ...Object.values(WARD_ROMAJI), ...Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"))];

function leftover(demo: DemoView, profile: DesignProfile): string {
  const facts = [demo.name, demo.ward, demo.address, demo.hours, demo.closedDays, demo.access, demo.phone, demo.description, ...demo.menuItems].filter((v): v is string => Boolean(v));
  const whole = [...WHOLE_NODES, monogram(demo.name), ...nameLines(demo.name)];
  const text = visibleText(renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />)).filter((n) => !whole.includes(n)).join("\n");
  const strip = (s: string, phrases: string[]) => [...phrases].sort((a, b) => b.length - a.length).reduce((acc, p) => acc.split(p).join(""), s);
  return strip(strip(text, facts), FIXED_COPY).replace(/\s+/g, "");
}

const SENTINEL = "SENTINEL_FROM_PROFILE";
const PROFILES: DesignProfile[] = [
  { ...AMERICAN_EDITORIAL, rationale: [SENTINEL] },
  ...Object.values(CATEGORY_DEFAULT_PROFILES),
  ...HERO_LAYOUTS.flatMap((layout) =>
    INFO_STYLES.map((infoStyle, i) => ({
      ...AMERICAN_EDITORIAL,
      heroLayout: { ...AMERICAN_EDITORIAL.heroLayout, layout },
      composition: { ...AMERICAN_EDITORIAL.composition, infoStyle, divider: DIVIDERS[i] },
      motifs: MOTIFS.slice(i, i + 4),
    })),
  ),
];
const SHOPS: DemoView[] = [SHOP, MINIMAL_SHOP, ADDRESS_ONLY_SHOP, { ...SHOP, name: "焼菓子テスト", ward: "千種区" }];

describe("ProfileRenderer", () => {
  it("shows only verified facts and fixed template copy, for every layout, style and motif", () => {
    for (const profile of PROFILES) for (const demo of SHOPS) expect(leftover(demo, profile), `${profile.direction}/${profile.heroLayout.layout}/${demo.name}`).toBe("");
  });

  it("never renders profile text (rationale) and prints no empty placeholders", () => {
    for (const demo of SHOPS) {
      const html = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={PROFILES[0]} />);
      expect(html).not.toContain(SENTINEL);
      expect(html).not.toMatch(/undefined|null|NaN/);
    }
    const minimal = renderToStaticMarkup(<ProfileRenderer demo={MINIMAL_SHOP} profile={AMERICAN_EDITORIAL} />);
    for (const label of ["About", "Menu", "Visit", "営業時間", "メニュー"]) expect(minimal).not.toContain(`>${label}<`);
    expect(minimal).toContain("公式サイトではありません");
  });

  it("keeps the notice, one h1 with the full name, and no text inside SVG or attributes", () => {
    const html = renderToStaticMarkup(<ProfileRenderer demo={SHOP} profile={AMERICAN_EDITORIAL} />);
    expect(html).toContain('role="note"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>.*EXAMPLE.*BAKE|<h1[^>]*>.*EXAMPLE.* .*TEST/);
    expect(html).not.toMatch(/<(text|title|desc|img|image)\b/);
    expect([...html.matchAll(/\s(alt|title|aria-label|placeholder)="/g)]).toEqual([]);
  });

  it("escapes shop text", () => {
    const html = renderToStaticMarkup(<ProfileRenderer demo={{ ...SHOP, name: "<script>x</script>" }} profile={AMERICAN_EDITORIAL} />);
    expect(html).not.toContain("<script>x</script>");
  });

  it("derives labels mechanically from facts", () => {
    expect(locationLabels({ ward: "北区" })).toEqual(["KITA-KU", "NAGOYA"]);
    expect(locationLabels({ ward: null })).toEqual(["NAGOYA"]);
    expect(locationLabels({ ward: "不明区" })).toEqual(["NAGOYA"]);
    expect(Object.keys(WARD_ROMAJI)).toHaveLength(16);
    expect(monogram("EXAMPLE BAKE")).toBe("CB");
    expect(nameLines("EXAMPLE BAKE")).toEqual(["EXAMPLE", "BAKE"]);
    expect(nameLines("焼菓子テスト")).toEqual(["焼菓子テスト"]);
  });
});

describe("profile CSS", () => {
  const css = () => readFile(join(process.cwd(), "components/demo/profile/profile.module.css"), "utf8");

  it("adds no text or images and animates only once, only without reduced motion", async () => {
    const text = await css();
    const contents = [...text.matchAll(/(?<![-\w])content\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(contents.filter((v) => v !== '""')).toEqual([]);
    expect(text).not.toMatch(/url\(/);
    expect(text).not.toMatch(/infinite|animation-iteration-count/);
    const [outside, ...blocks] = text.split("@media (prefers-reduced-motion: no-preference)");
    expect(blocks).toHaveLength(1);
    expect(outside).not.toMatch(/(?<![-\w])animation(-name)?\s*:/);
    expect(blocks[0].slice(blocks[0].indexOf("@keyframes"))).not.toMatch(/(?<![-\w])animation(-name)?\s*:/);
  });
});

describe("local preview", () => {
  it("exists only with an absolute SR_DESIGN_PREVIEW_ROOT", () => {
    expect(previewRoot({})).toBeNull();
    expect(previewRoot({ SR_DESIGN_PREVIEW_ROOT: "relative/dir" })).toBeNull();
    expect(previewRoot({ SR_DESIGN_PREVIEW_ROOT: "/home/sr-designgen/.local/share/second-root-design" })).toBe("/home/sr-designgen/.local/share/second-root-design");
  });

  it("reads only validated run ids and candidate names, and falls back on a bad profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "preview-test-"));
    await mkdir(join(root, "run-abc123"));
    await writeFile(join(root, "run-abc123", "facts.json"), JSON.stringify({ name: "EXAMPLE TEST", category: "baked_goods", ward: "北区", email: "x@example.com" }));
    await writeFile(join(root, "run-abc123", "candidate-0.json"), JSON.stringify(AMERICAN_EDITORIAL));
    await writeFile(join(root, "run-abc123", "candidate-1.json"), JSON.stringify({ ...AMERICAN_EDITORIAL, css: "x" }));
    expect(await loadPreviewRun(root, "../etc", "none")).toBeNull();
    expect(await loadPreviewRun(root, "run-abc123", "../../facts")).toBeNull();
    expect(await loadPreviewRun(root, "run-missing", "none")).toBeNull();
    expect((await loadPreviewRun(root, "run-abc123", "none"))?.profile).toBeNull();
    expect((await loadPreviewRun(root, "run-abc123", "candidate-0"))?.profile).toEqual(AMERICAN_EDITORIAL);
    expect((await loadPreviewRun(root, "run-abc123", "candidate-1"))?.profile).toBeNull();
    expect(JSON.stringify(await loadPreviewRun(root, "run-abc123", "none"))).not.toContain("example.com");
    expect(await readdir(root)).toEqual(["run-abc123"]);
  });
});
