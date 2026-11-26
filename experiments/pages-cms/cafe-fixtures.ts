/**
 * PR (3): FICTIONAL Q1 test content for the second shop (the café, cafe-site.ts): the same kinds of edits as the
 * bakery's fixtures (0 / 3 / 10 / 50 items, long text, hidden / sold-out / reordered, hours and closures, 0 / 1 / many
 * announcements, pictures of every shape and none) plus the café's `sizes` extension with its price texts.
 */
import type { Announcement, Category, MenuItem, ShopInfo } from "./content-model";
import { photoVariety, solidPng, uniqueColour, type Fixture } from "./fixtures";

const SHOP: ShopInfo = {
  name: "架空のカフェ 木洩れ日珈琲",
  address: "架空県架空市4-5-6（試験用）",
  phone: "03-0000-0001",
  hours: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => (day === "tue" ? { day, closed: true, open: "", close: "" } : { day, closed: false, open: "10:00", close: "19:00" })),
  hoursNote: "",
  specialClosures: [],
};
const CATEGORIES: Category[] = [
  { id: "coffee", name: "コーヒー", displayOrder: 1, visible: true },
  { id: "tea", name: "ティー", displayOrder: 2, visible: true },
  { id: "sweets", name: "焼き菓子", displayOrder: 3, visible: true },
];
const SHAPES: ([number, number] | null)[] = [[500, 500], [600, 400], null, [400, 600]];
const COLOURS: [number, number, number][] = [
  [120, 84, 60],
  [176, 150, 96],
  [214, 196, 160],
];
const SIZE_SETS = [
  [
    { label: "S", priceDisplay: "450円（税込）" },
    { label: "M", priceDisplay: "520円（税込）" },
    { label: "L", priceDisplay: "590円（税込）" },
  ],
  [
    { label: "ホット", priceDisplay: "500円（税込）" },
    { label: "アイス", priceDisplay: "550円（税込）" },
  ],
];

function items(n: number): { menu: MenuItem[]; media: Record<string, Buffer> } {
  const media: Record<string, Buffer> = {};
  const menu = Array.from({ length: n }, (_, k) => {
    const shape = SHAPES[k % SHAPES.length]!;
    const file = shape ? `cafe-${k + 1}.png` : "";
    if (shape) media[file] = solidPng(shape[0], shape[1], uniqueColour(COLOURS[k % 3]!, k));
    const category = CATEGORIES[k % 3]!.id;
    const drink = category !== "sweets";
    return {
      id: `cafe-${k + 1}`,
      name: `試験の品 ${k + 1}`,
      category,
      description: k % 2 ? "架空の説明です。" : "",
      priceDisplay: drink ? "" : "380円（税込）",
      image: file ? `/media/${file}` : "",
      imageAlt: file ? `試験の画像 ${k + 1}` : "",
      imageKind: k % 5 === 4 ? ("customer_cms" as const) : ("generated" as const),
      visible: true,
      soldOut: false,
      displayOrder: k,
      ...(drink ? { sizes: SIZE_SETS[k % 2]! } : {}),
    };
  });
  return { menu, media };
}

const LONG_NAME = "季節の果実と焙煎の深い豆を合わせた、香りのよいカフェ・オ・レ（ミルクは三種類から選べます・数量限定）";

let cached: Record<string, Fixture> | undefined;
/** The café's Q1 fixtures by name (fictional; made once per process; callers must not change them). */
export function cafeFixtures(): Record<string, Fixture> {
  return (cached ??= make());
}
function make(): Record<string, Fixture> {
  const base = (n: number) => ({ shop: SHOP, categories: CATEGORIES, news: [] as Announcement[], ...items(n) });
  const f: Record<string, Fixture> = { "items-0": base(0), "items-3": base(3), "items-10": base(10), "items-50": base(50) };
  const long = base(6);
  long.menu[0] = { ...long.menu[0]!, name: LONG_NAME, description: `${LONG_NAME}。`.repeat(3), sizes: [{ label: "レギュラーサイズ", priceDisplay: "1,280円（税込・テイクアウトは1,256円（税込））" }, { label: "ラージ", priceDisplay: "1,480円（税込）" }] };
  f["long-text"] = long;
  const states = base(10);
  states.menu = states.menu.map((m, k) => ({ ...m, visible: k % 5 !== 0, soldOut: k % 3 === 0, displayOrder: 100 - k }));
  f["hidden-soldout-reorder"] = states;
  const hours = base(3);
  hours.shop = {
    ...SHOP,
    hours: SHOP.hours.map((h) => (h.day === "sun" ? { ...h, open: "09:00", close: "17:00" } : h)),
    hoursNote: "ラストオーダーは閉店の30分前です。",
    specialClosures: [
      { date: "2026-11-25", note: "過ぎた休業（表示しない）" },
      { date: "2026-12-31", note: "年末" },
      { date: "2027-01-01", note: "" },
    ],
  };
  f["hours-closures"] = hours;
  const one = base(3);
  one.news = [{ id: "news-1", title: "冬のブレンドを始めました", body: "試験用のお知らせです。", publishedAt: "2026-11-30", visible: true }];
  f["news-1"] = one;
  const many = base(3);
  many.news = Array.from({ length: 12 }, (_, k) => ({ id: `news-${k + 1}`, title: k === 0 ? `${LONG_NAME}のお知らせ` : `お知らせ ${k + 1}`, body: k % 2 ? "" : "試験用の本文です。".repeat(k + 1), publishedAt: `2026-11-${String(k + 1).padStart(2, "0")}`, visible: k !== 3 }));
  f["news-many"] = many;
  // the sizes extension with each price-text class of the 総額表示 report
  const sizes = base(4);
  sizes.menu = sizes.menu.map((m, k) =>
    k === 0
      ? { ...m, category: "coffee", priceDisplay: "", sizes: [{ label: "S", priceDisplay: "450円（税込）" }, { label: "M", priceDisplay: "500円（税別）" }] }
      : k === 1
        ? { ...m, category: "tea", priceDisplay: "", sizes: [{ label: "ポット", priceDisplay: "¥900" }] }
        : k === 2
          ? { ...m, category: "sweets", priceDisplay: "S400/M500/L600円（税込）", sizes: undefined }
          : { ...m, category: "coffee", priceDisplay: "", sizes: [{ label: "S", priceDisplay: "" }, { label: "M", priceDisplay: "本体500円（税込550円）" }] },
  );
  f["sizes-prices"] = sizes;
  f["photos-large-odd"] = photoVariety(base(6), "cafe");
  return f;
}
