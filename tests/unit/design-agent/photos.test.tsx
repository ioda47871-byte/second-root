import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { monogram, nameLines, WARD_ROMAJI } from "@/components/demo/profile/text";
import type { ImageDirection } from "@/lib/design-agent/assets/direction";
import { resolvePhotos, type RenderPhotos } from "@/lib/design-agent/assets/resolve";
import { previewAssetUrl, readPreviewAsset } from "@/lib/design-agent/assets/serve";
import { loadPreviewRun } from "@/lib/design-agent/preview";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, MINIMAL_SHOP, SHOP } from "./fixtures";
import { fakeAnalysis, fakeManifest, fakePng, writeStore, type FakeAsset } from "./photo-fixtures";

// DEV-029 stage 2: what the profile renderer draws with photos, when it draws
// none, and the only way a photo file reaches the local preview.

const A = "asset-aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "asset-bbbbbbbbbbbbbbbbbbbbbbbb";
const C = "asset-cccccccccccccccccccccccc";
const ASSETS: FakeAsset[] = [
  { id: A, png: fakePng(360, 450, { seed: 1 }), sourceKind: "generated_concept" },
  { id: B, png: fakePng(480, 320, { seed: 2, busy: true }), sourceKind: "approved_real" },
  { id: C, png: fakePng(400, 400, { seed: 3 }), sourceKind: "generated_concept" },
];
const MANIFEST = fakeManifest("job-001", ASSETS);
const ANALYSES = { photos: [fakeAnalysis(A), fakeAnalysis(B, { orientation: "landscape", busy: "busy" }), fakeAnalysis(C, { orientation: "square" })] };

const place = (assetId: string, over: Record<string, unknown> = {}) => ({
  assetId,
  fit: "cover" as const,
  focal: { x: 0.4, y: 0.3 },
  mobileFocal: { x: 0.6, y: 0.5 },
  aspect: { desktop: "4:5" as const, mobile: "1:1" as const },
  treatment: "natural" as const,
  ...over,
});
const direction = (over: Partial<ImageDirection> = {}): ImageDirection => ({
  version: 1,
  layout: "split_hero",
  hero: place(A),
  features: [{ ...place(B), slot: "visit", side: "right" }],
  rejected: [{ assetId: C, reason: "not_needed" }],
  paletteFit: 4,
  ...over,
});
const resolve = (demo: DemoView, d: unknown, manifest = MANIFEST, analyses: unknown = ANALYSES) => resolvePhotos({ demo, manifest, analyses, direction: d, src: (id) => `/x/${id}` });
const render = (demo: DemoView, photos: RenderPhotos | null) => renderToStaticMarkup(<ProfileRenderer demo={demo} profile={AMERICAN_EDITORIAL} photos={photos} />);

describe("photo resolution: every doubt means no photos", () => {
  it("resolves a valid direction into the photos the page draws", () => {
    const { photos, problems } = resolve(SHOP, direction());
    expect(problems).toEqual([]);
    expect(photos?.layout).toBe("split_hero");
    expect(photos?.hero).toMatchObject({ assetId: A, src: `/x/${A}`, sourceKind: "generated_concept", width: 360, height: 450 });
    expect(photos?.features).toMatchObject([{ assetId: B, slot: "visit", sourceKind: "approved_real" }]);
  });

  it("draws nothing without a direction, a manifest or analyses, or with layout none", () => {
    expect(resolve(SHOP, undefined).photos).toBeNull();
    expect(resolve(SHOP, null).photos).toBeNull();
    expect(resolvePhotos({ demo: SHOP, manifest: null, analyses: ANALYSES, direction: direction(), src: String }).problems).toEqual(["NO_MANIFEST"]);
    expect(resolvePhotos({ demo: SHOP, manifest: MANIFEST, analyses: undefined, direction: direction(), src: String }).problems).toEqual(["NO_ANALYSES"]);
    expect(resolve(SHOP, direction(), MANIFEST, { photos: "x" }).problems).toEqual(["NO_ANALYSES"]);
    const none = direction({ layout: "none", hero: null, features: [], rejected: [A, B, C].map((assetId) => ({ assetId, reason: "not_needed" as const })) });
    expect(resolve(SHOP, none)).toEqual({ photos: null, problems: [] });
  });

  it("draws nothing for a bad asset id, an asset outside the manifest, no consent or people", () => {
    expect(resolve(SHOP, direction({ hero: place("../../etc/passwd") })).photos).toBeNull();
    expect(resolve(SHOP, direction({ hero: place("asset-dddddddddddddddddddddddd") })).photos).toBeNull();
    const publicOnly = fakeManifest("job-001", [ASSETS[0], { ...ASSETS[1], scopes: ["public_demo"] }, ASSETS[2]]);
    expect(resolve(SHOP, direction(), publicOnly).problems).toContain(`${B} is not allowed in local_preview`);
    const people = { photos: [fakeAnalysis(A, { people: true }), ...ANALYSES.photos.slice(1)] };
    expect(resolve(SHOP, direction(), MANIFEST, people).problems).toContain(`${A} shows people`);
  });

  it("never counts a photo as used when its section is not on the page", () => {
    const about = direction({ layout: "type_hero_feature_band", hero: null, features: [{ ...place(A), slot: "about", side: "left" }], rejected: [B, C].map((assetId) => ({ assetId, reason: "not_needed" as const })) });
    expect(resolve(SHOP, about).photos).not.toBeNull();
    expect(resolve({ ...SHOP, description: null }, about)).toEqual({ photos: null, problems: ["slot about has no section"] });
    expect(resolve(MINIMAL_SHOP, direction()).problems).toEqual(["slot visit has no section"]);
  });
});

// ---------------------------------------------------------------- renderer markup

function visibleText(html: string): string[] {
  return html
    .replace(/<(svg)[\s\S]*?<\/\1>/g, " ")
    .replace(/<span[^>]*data-keep=""[^>]*>([^<]*)<\/span>/g, "$1")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((t) => t.replace(/&amp;/g, "&").trim())
    .filter(Boolean);
}

describe("profile renderer with photos", () => {
  it("draws exactly what it drew before when there are no photos", () => {
    for (const demo of [SHOP, MINIMAL_SHOP]) {
      const before = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={AMERICAN_EDITORIAL} />);
      expect(render(demo, null)).toBe(before);
      expect(before).not.toContain("<figure");
      expect(before).not.toContain("<img");
    }
  });

  it("labels every generated image and no approved one, with fixed text only", () => {
    const three = direction({ layout: "framed_hero", features: [{ ...place(B), slot: "visit", side: "right" }, { ...place(C), slot: "about", side: "left" }], rejected: [] });
    const html = render(SHOP, resolve(SHOP, three).photos);
    const figures = [...html.matchAll(/<figure[^>]*data-source="([a-z_]+)"[^>]*>([\s\S]*?)<\/figure>/g)];
    expect(figures.map((f) => f[1]).sort()).toEqual(["approved_real", "generated_concept", "generated_concept"]);
    for (const [, source, inner] of figures) expect(inner.includes(">イメージ画像</span>"), source).toBe(source === "generated_concept");
    expect([...html.matchAll(/<img [^>]*>/g)].every((m) => /alt=""/.test(m[0]))).toBe(true);
  });

  it("shows only verified facts, fixed copy and the image label (fact-only holds with photos)", () => {
    const html = render(SHOP, resolve(SHOP, direction({ layout: "framed_hero", features: [{ ...place(B), slot: "visit", side: "right" }, { ...place(C), slot: "about", side: "left" }], rejected: [] })).photos);
    const facts = [SHOP.name, SHOP.ward, SHOP.address, SHOP.hours, SHOP.closedDays, SHOP.access, SHOP.phone, SHOP.description, ...SHOP.menuItems].filter((v): v is string => Boolean(v));
    const fixed = ["これは", "Second Root", "が作成した", "ご提案用のデモページ", "です。", "様の公式サイトではありません。", "このページは、", "様に向けて Second Root が公開情報をもとに作成したデモです。", "掲載内容は確認できた公開情報のみで、公式サイト・公式情報ではありません。", "Second Root（セカンドルート）｜名古屋の小さなお店のホームページ制作", "営業時間", "定休日", "住所", "アクセス", "電話", "メニュー", "店舗のご案内", "名古屋市の", "名古屋の", "焼菓子店", "名古屋市", "イメージ画像"];
    const whole = ["Baked Goods", "About", "Menu", "Visit", "Hours", "Closed", "Address", "Access", "Tel", "NAGOYA", ...Object.values(WARD_ROMAJI), "01", "02", monogram(SHOP.name), ...nameLines(SHOP.name)];
    const strip = (s: string, phrases: string[]) => [...phrases].sort((a, b) => b.length - a.length).reduce((acc, p) => acc.split(p).join(""), s);
    const rest = strip(strip(visibleText(html).filter((n) => !whole.includes(n)).join("\n"), facts), fixed).replace(/\s+/g, "");
    expect(rest).toBe("");
    expect(html).not.toMatch(/undefined|null|NaN/);
  });

  it("never puts a photo in the menu", () => {
    const html = render(SHOP, resolve(SHOP, direction({ layout: "framed_hero", features: [{ ...place(B), slot: "visit", side: "right" }, { ...place(C), slot: "about", side: "left" }], rejected: [] })).photos);
    const menu = html.slice(html.indexOf('aria-labelledby="pr-menu"'), html.indexOf('aria-labelledby="pr-visit"'));
    expect(menu).not.toContain("<figure");
  });
});

// ---------------------------------------------------------------- local preview and asset serving

describe("local preview photos and the asset route", () => {
  let base: string;
  let env: Record<string, string>;
  let previewRoot: string;
  let store: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "photos-test-"));
    previewRoot = join(base, "preview");
    store = join(base, "store");
    env = { HOME: join(base, "home"), TMPDIR: join(base, "tmp"), SR_DESIGN_PREVIEW_ROOT: previewRoot, SR_DESIGN_ASSETS_ROOT: store };
    await mkdir(env.TMPDIR, { recursive: true });
    await writeStore(store, "job-001", ASSETS);
    const run = join(previewRoot, "run-photos-1");
    await mkdir(run, { recursive: true });
    await writeFile(join(run, "facts.json"), JSON.stringify({ name: "EXAMPLE TEST", category: "baked_goods", ward: "北区", address: "名古屋市北区テスト町1-2-3", description: "テスト用の架空の紹介文です。" }));
    await writeFile(join(run, "candidate-0.json"), JSON.stringify(AMERICAN_EDITORIAL));
    await writeFile(join(run, "candidate-0.images.json"), JSON.stringify(direction()));
    await writeFile(join(run, "candidate-1.json"), JSON.stringify(AMERICAN_EDITORIAL));
    await writeFile(join(run, "candidate-1.images.json"), JSON.stringify(direction({ hero: place("asset-dddddddddddddddddddddddd") })));
    await writeFile(join(run, "photo-analyses.json"), JSON.stringify(ANALYSES));
    await writeFile(join(run, "assets.json"), JSON.stringify({ jobId: "job-001" }));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const serve = (assetId: string, over: Partial<{ runId: string; env: Record<string, string> }> = {}) =>
    readPreviewAsset({ previewRoot, runId: over.runId ?? "run-photos-1", assetId, env: over.env ?? env, repoDir: process.cwd() });

  it("loads a candidate's photos with asset-route URLs, and none for a bad direction or the before template", async () => {
    const run = await loadPreviewRun(previewRoot, "run-photos-1", "candidate-0", { env, repoDir: process.cwd() });
    expect(run?.photos?.hero?.src).toBe(previewAssetUrl("run-photos-1", A as never));
    expect(run?.photos?.features[0]?.src).toBe(`/design-preview/run-photos-1/asset/${B}`);
    expect((await loadPreviewRun(previewRoot, "run-photos-1", "candidate-1", { env, repoDir: process.cwd() }))?.photos).toBeNull();
    expect((await loadPreviewRun(previewRoot, "run-photos-1", "none", { env, repoDir: process.cwd() }))?.photos).toBeNull();
    expect((await loadPreviewRun(previewRoot, "run-photos-1", "candidate-0", { env: { ...env, SR_DESIGN_ASSETS_ROOT: join(process.cwd(), "assets") }, repoDir: process.cwd() }))?.photos).toBeNull();
  });

  it("serves a listed, allowed photo as the exact PNG of the manifest", async () => {
    const png = await serve(A);
    expect(png?.equals(ASSETS[0].png)).toBe(true);
  });

  it("serves nothing for a malformed id, a path, an unlisted id or an unknown run", async () => {
    for (const id of ["../manifest.json", "asset-aaaa", `${A}.png`, "%2e%2e%2fmanifest", "asset-dddddddddddddddddddddddd", A.toUpperCase()]) expect(await serve(id), id).toBeNull();
    expect(await serve(A, { runId: "../preview" })).toBeNull();
    expect(await serve(A, { runId: "run-missing-1" })).toBeNull();
  });

  it("serves nothing without local preview consent, from a store in an unsafe place, through a link or with a changed file", async () => {
    await writeStore(store, "job-public", ASSETS, fakeManifest("job-public", [ASSETS[0], { ...ASSETS[1], scopes: ["public_demo"] }, ASSETS[2]]));
    const run2 = join(previewRoot, "run-photos-2");
    await mkdir(run2, { recursive: true });
    await writeFile(join(run2, "assets.json"), JSON.stringify({ jobId: "job-public" }));
    expect(await serve(B, { runId: "run-photos-2" })).toBeNull();
    expect((await serve(A, { runId: "run-photos-2" }))?.length).toBeGreaterThan(0);

    expect(await serve(A, { env: { ...env, SR_DESIGN_ASSETS_ROOT: join(env.TMPDIR, "store") } })).toBeNull();
    expect(await serve(A, { env: { ...env, SR_DESIGN_ASSETS_ROOT: previewRoot } })).toBeNull();

    const file = join(store, "job-001", `${C}.png`);
    await unlink(file);
    await symlink(join(store, "job-001", `${A}.png`), file);
    expect(await serve(C)).toBeNull();
    await unlink(file);
    await writeFile(file, fakePng(400, 400, { seed: 9 }), { mode: 0o600 });
    expect(await serve(C)).toBeNull();
    await writeFile(file, ASSETS[2].png, { mode: 0o600 });
    expect((await serve(C))?.equals(ASSETS[2].png)).toBe(true);
  });

  it("never serves a run's other files, and there is no route for reference screenshots", async () => {
    await writeFile(join(previewRoot, "run-photos-1", "reference-0.png"), fakePng(320, 320));
    expect(await serve("reference-0")).toBeNull();
    const route = await readFile(join(process.cwd(), "app/design-preview/[runId]/asset/[assetId]/route.ts"), "utf8");
    expect(route).toContain("readPreviewAsset");
    expect(route).not.toMatch(/readFile|createReadStream|join\(/);
  });
});
