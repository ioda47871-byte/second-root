/**
 * DEV-303 §3.7 Q1, first experiment: FICTIONAL test content for the CMS-update check (no real shop, no real
 * pictures). Each fixture is a shop repository (content/ + media/) as the customer could leave it after edits in
 * Pages CMS: 0 / 3 / 10 / 50 items, long names and descriptions, price formats, pictures of every shape (and none),
 * hidden / sold-out / reordered items, changed hours and special closures, 0 / 1 / many announcements.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { Announcement, Category, ImageKind, MenuItem, ShopInfo } from "./content-model";
import { PROVENANCE_INDEX, PROVENANCE_SCHEMA, rightsFiles, type ProvenanceB } from "./provenance";
import { GENERATED_RECORD, generatedRecord } from "./photos";
import { PHOTO_SLOTS_FILE, PHOTO_SLOTS_SCHEMA, SLOT_FRAME_RATIOS, type ApprovedDesign, type PhotoSlots, type SlotView } from "./photo-slots";

/** A solid-colour PNG (synthetic). */
/**
 * review #371 M1: each fixture item gets its own bytes (a colour one step apart per item), so two items never share a
 * picture by accident — the provenance class belongs to the bytes, and A / B / C may not share them.
 */
export const uniqueColour = (rgb: readonly [number, number, number], k: number): [number, number, number] => [rgb[0], rgb[1], (rgb[2] + k) % 256];

export function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * generated: the media file names handed over as generated materials (written to the handover record). rights
 * (DEV-364 PR 2a): the B pictures' rights records — the private records go OUTSIDE the repository, next to it
 * (provenanceDirOf), and the index into it.
 */
export type Fixture = {
  shop: ShopInfo;
  categories: Category[];
  menu: MenuItem[];
  news: Announcement[];
  media: Record<string, Buffer>;
  generated?: string[];
  rights?: ProvenanceB[];
  /** DEV-364 PR 2b: the material id of each handed-over generated file (written into the handover record), and the photo-slot spec. */
  materials?: Record<string, string>;
  slots?: PhotoSlots;
};

/** Where a fixture's private B records go: a folder next to the fixture's repository, never inside it. */
export const provenanceDirOf = (repo: string) => join(repo, "..", "provenance");

const SHOP: ShopInfo = {
  name: "架空のパン屋 こむぎ舎",
  address: "架空県架空市1-2-3（試験用）",
  phone: "03-0000-0000",
  hours: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => (day === "wed" ? { day, closed: true, open: "", close: "" } : { day, closed: false, open: "08:00", close: "18:00" })),
  hoursNote: "",
  specialClosures: [],
};
const CATEGORIES: Category[] = [
  { id: "bread", name: "食事パン", displayOrder: 1, visible: true },
  { id: "sweet", name: "菓子パン", displayOrder: 2, visible: true },
  { id: "bake", name: "焼き菓子", displayOrder: 3, visible: true },
];
const SHAPES: [number, number][] = [
  [600, 400],
  [500, 500],
  [400, 600],
];
const COLOURS: [number, number, number][] = [
  [196, 160, 112],
  [150, 98, 60],
  [222, 200, 160],
];
const PRICES = ["280円", "320円（税込）", "¥1,280", "時価", "380〜520円", ""];

function items(n: number): { menu: MenuItem[]; media: Record<string, Buffer> } {
  const media: Record<string, Buffer> = {};
  const menu = Array.from({ length: n }, (_, k) => {
    const shape = k % 4 === 3 ? null : SHAPES[k % 3]!;
    const file = shape ? `item-${k + 1}.png` : "";
    if (shape) media[file] = solidPng(shape[0], shape[1], uniqueColour(COLOURS[k % 3]!, k));
    return {
      id: `item-${k + 1}`,
      name: `試験の商品 ${k + 1}`,
      category: CATEGORIES[k % 3]!.id,
      description: k % 2 ? "架空の説明です。" : "",
      priceDisplay: PRICES[k % PRICES.length]!,
      image: file ? `/media/${file}` : "",
      imageAlt: file ? `試験の画像 ${k + 1}` : "",
      imageKind: k % 5 === 4 ? ("customer_cms" as const) : ("generated" as const),
      visible: true,
      soldOut: false,
      displayOrder: k,
    };
  });
  return { menu, media };
}

const LONG_NAME = "北の大地の全粒粉と天然酵母でじっくり二日かけて発酵させた、香ばしい皮ともっちりした中身の大きなカンパーニュ（季節の木の実入り）";
const LONG_WORD = "Pain-au-levain-traditionnel-de-campagne-aux-noix-et-raisins-secs";

/** The Q1 fixtures by name (fictional). `today` for the closures is 2026-12-01. */
let cached: Record<string, Fixture> | undefined;
/** The fixtures (made once per process; callers must not change them). */
export function q1Fixtures(): Record<string, Fixture> {
  return (cached ??= makeFixtures());
}
function makeFixtures(): Record<string, Fixture> {
  const base = (n: number) => ({ shop: SHOP, categories: CATEGORIES, news: [] as Announcement[], ...items(n) });
  const f: Record<string, Fixture> = {
    "items-0": base(0),
    "items-3": base(3),
    "items-10": base(10),
    "items-50": base(50),
  };
  const long = base(6);
  long.menu[0] = { ...long.menu[0]!, name: LONG_NAME, description: `${LONG_NAME}。`.repeat(3) };
  long.menu[1] = { ...long.menu[1]!, name: LONG_WORD, priceDisplay: "1,280円（税込・1本）〜2,480円（税込・特大）" };
  f["long-text"] = long;
  const states = base(10);
  states.menu = states.menu.map((m, k) => ({ ...m, visible: k % 5 !== 0, soldOut: k % 3 === 0, displayOrder: 100 - k }));
  f["hidden-soldout-reorder"] = states;
  const hours = base(3);
  hours.shop = {
    ...SHOP,
    hours: SHOP.hours.map((h) => (h.day === "sat" ? { ...h, open: "07:30", close: "15:00" } : h.day === "mon" ? { ...h, closed: true, open: "", close: "" } : h)),
    hoursNote: "売り切れ次第閉店します。祝日は営業時間が変わることがあります。",
    specialClosures: [
      { date: "2026-11-20", note: "過ぎた休業（表示しない）" },
      { date: "2026-12-29", note: "年末年始" },
      { date: "2026-12-30", note: "" },
      { date: "2027-01-05", note: "設備の点検のため臨時休業します" },
    ],
  };
  f["hours-closures"] = hours;
  const one = base(3);
  one.news = [{ id: "news-1", title: "冬の限定パンを始めました", body: "試験用のお知らせです。", publishedAt: "2026-11-30", visible: true }];
  f["news-1"] = one;
  const many = base(3);
  many.news = Array.from({ length: 12 }, (_, k) => ({
    id: `news-${k + 1}`,
    title: k === 0 ? `${LONG_NAME}のお知らせ` : `お知らせ ${k + 1}`,
    body: k % 2 ? "" : "試験用の本文です。".repeat(k + 1),
    publishedAt: `2026-11-${String(k + 1).padStart(2, "0")}`,
    visible: k !== 3,
  }));
  f["news-many"] = many;
  // the bakery's optional extensions (allergens, shelf life) and every price-text class of the 総額表示 report
  const trade = base(6);
  const prices = ["324円（税込）", "300円（税別）", "¥1,280", "時価", "", "本体1,000円（税込1,080円）"];
  trade.menu = trade.menu.map((m, k) => ({ ...m, priceDisplay: prices[k]!, ...(k % 2 === 0 ? { allergens: ["小麦", "乳", "卵"], shelfLife: k === 0 ? "当日中" : "翌日まで" } : {}) }));
  f["trade-extensions"] = trade;
  f["photos-large-odd"] = photoVariety(base(6), "item");
  // DEV-364 PR 2b: the generated pictures (3:2, 3:1, 1:1, 2.8:1) in the bakery's 4:3 cards, each with its slot
  f["photo-slots"] = withPhotoSlots(photoVariety(base(6), "slot"), "4:3", [
    { material: "loaf-crumb", position: "50% 30%", subject: "top" },
    { material: "bake-board", position: "75% 50%", subject: "right-third" },
    { material: "flour-dust", position: "50% 50%", subject: "center" },
    { material: "tray-row", position: "25% 50%", subject: "left-third" },
  ]);
  return f;
}

/**
 * PR (4): pictures at the edges of the photo limits (photos.ts), every one allowed: a large one, the widest and the
 * tallest ratio (3:1, 1:3), the smallest side, a square; generated materials and shop photos mixed.
 */
export const PHOTO_VARIETY: { w: number; h: number; kind: ImageKind }[] = [
  { w: 3600, h: 2400, kind: "generated" },
  { w: 1200, h: 400, kind: "generated" },
  { w: 400, h: 1200, kind: "shop_provided" },
  { w: 320, h: 320, kind: "generated" },
  { w: 2000, h: 2000, kind: "customer_cms" },
  { w: 960, h: 340, kind: "generated" },
];
export function photoVariety(fx: Fixture, prefix: string): Fixture {
  const media: Record<string, Buffer> = {};
  const menu = fx.menu.map((m, k) => {
    const p = PHOTO_VARIETY[k % PHOTO_VARIETY.length]!;
    const file = `${prefix}-photo-${k + 1}.png`;
    media[file] = solidPng(p.w, p.h, COLOURS[k % 3]!);
    return { ...m, image: `/media/${file}`, imageAlt: `試験の画像 ${k + 1}`, imageKind: p.kind };
  });
  // the generated ones (A) were handed over with the record (review #365 M1); the shop-provided ones (B) with their
  // rights records (DEV-364 PR 2a, fictional); the customer's own (C) need none
  const fileOf = (m: MenuItem) => m.image.replace(/^\/media\//, "");
  const rights = menu.filter((m) => m.imageKind === "shop_provided").map((m) => fictionalRights(media[fileOf(m)]!));
  return { ...fx, menu, media, generated: menu.filter((m) => m.imageKind === "generated").map(fileOf), rights };
}

/** A fictional B rights record for a picture (a role, a source, a permission; no person, no real shop). */
export function fictionalRights(bytes: Buffer): ProvenanceB {
  return {
    schema: PROVENANCE_SCHEMA,
    class: "B",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    provided_by: "店主",
    source: "店が撮影した写真（架空の試験用）",
    permission: { scope: "提案用デモと納品後の店舗サイトでの掲載（架空）", confirmed_at: "2026-11-26", confirmed_by: "Second Root 担当" },
    facts_check: { shown_as_fact: false, confirmed: false },
  };
}

/** Writes one fixture as a shop repository (content/ + media/) under `dir`. */
export async function writeFixture(dir: string, fx: Fixture): Promise<void> {
  for (const d of ["content/menu", "content/categories", "content/news", "media"]) await mkdir(join(dir, d), { recursive: true });
  const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
  await writeFile(join(dir, "content", "shop.json"), json(fx.shop));
  for (const c of fx.categories) await writeFile(join(dir, "content", "categories", `${c.id}.json`), json(c));
  for (const m of fx.menu) await writeFile(join(dir, "content", "menu", `${m.id}.json`), json(m));
  for (const n of fx.news) await writeFile(join(dir, "content", "news", `${n.id}.json`), json(n));
  for (const [name, bytes] of Object.entries(fx.media)) await writeFile(join(dir, "media", name), bytes);
  if (fx.generated) {
    const record = generatedRecord(Object.fromEntries(fx.generated.map((n) => [n, fx.media[n]!])));
    record.files = record.files.map((f) => (fx.materials?.[f.file] ? { ...f, material_id: fx.materials[f.file] } : f));
    await writeFile(join(dir, GENERATED_RECORD), json(record));
  }
  if (fx.slots) await writeFile(join(dir, PHOTO_SLOTS_FILE), json(fx.slots));
  if (fx.rights?.length) {
    const files = rightsFiles(fx.rights);
    await writeFile(join(dir, PROVENANCE_INDEX), json(files.index));
    await mkdir(provenanceDirOf(dir), { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries(files.private)) await writeFile(join(provenanceDirOf(dir), name), text);
  }
}

export const Q1_TODAY = "2026-12-01";

/**
 * DEV-364 PR 2b: a fictional first approval (no real design run) and its approved image sizes, for the photo-slot
 * fixtures and tests.
 */
export const FICTIONAL_APPROVAL: ApprovedDesign = {
  bundle_id: "req-fictional-design-01",
  bundle_sha256: "a".repeat(64),
  review_file: "review-fictional-01.json",
  approval_file: "approval-fictional-01.json",
  approval_sha256: "b".repeat(64),
};
export const FICTIONAL_APPROVED_IMAGE = { pc: { width: 1440, height: 3000 }, sp: { width: 390, height: 2400 } } as const;

/** A box of the given aspect in the approved image (0..1), `width` of the image wide, at (x, y). */
export function boxFor(view: "pc" | "sp", aspect: keyof typeof SLOT_FRAME_RATIOS, width: number, x = 0.05, y = 0.3): SlotView["box"] {
  const img = FICTIONAL_APPROVED_IMAGE[view];
  return { x, y, w: width, h: (width * img.width) / SLOT_FRAME_RATIOS[aspect] / img.height };
}

/**
 * The photo-slot fixture: the photo variety (pictures of every ratio) with its generated pictures handed over as named
 * materials and one slot per material — the same object-position and subject at PC and SP, the frame's aspect being
 * the site's own (4:3 cards for the bakery, 1:1 thumbnails for the café).
 */
export function withPhotoSlots(fx: Fixture, aspect: keyof typeof SLOT_FRAME_RATIOS, plan: { material: string; position: string; subject: SlotView["subject"] }[]): Fixture {
  const generated = fx.generated ?? [];
  const materials = Object.fromEntries(generated.map((file, k) => [file, plan[k % plan.length]!.material]));
  const view = (v: "pc" | "sp", p: (typeof plan)[number]): SlotView => ({ box: boxFor(v, aspect, v === "pc" ? 0.2 : 0.42), aspect, shape: "rect", object_position: p.position, subject: p.subject, text_gap: "adjacent" });
  const used = plan.slice(0, generated.length);
  return {
    ...fx,
    materials,
    slots: { schema: PHOTO_SLOTS_SCHEMA, approved_design: FICTIONAL_APPROVAL, slots: used.map((p) => ({ id: `slot-${p.material}`, role: "product", material_ids: [p.material], pc: view("pc", p), sp: view("sp", p) })) },
  };
}
