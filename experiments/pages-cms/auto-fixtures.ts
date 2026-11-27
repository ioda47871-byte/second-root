/**
 * Issue #380: FICTIONAL Q1 test content for the third shop (the car-care shop, auto-site.ts): its 施工実績 as the
 * customer could leave them after edits in Pages CMS — 0 / 3 / 10 / 50 jobs, long 車種 names (and an unbroken one),
 * photos of every allowed shape (the photo limits' edges), 1 to WORK_PHOTO_MAX photos per job with and without a
 * 施工前 / 施工後 pair, hidden and reordered jobs, changed hours and closures, 0 / 1 / many announcements. No real car,
 * shop or customer; every picture is a synthetic solid-colour PNG. The jobs' photos are the customer's (C), a few the
 * shop's provided ones (B, with fictional rights records); never generated (the model refuses that for a job).
 */
import type { Announcement, ShopInfo, Work, WorkPhoto } from "./content-model";
import { WORK_PHOTO_MAX } from "./content-model";
import { fictionalRights, solidPng, uniqueColour, type Fixture } from "./fixtures";

const SHOP: ShopInfo = {
  name: "架空のカーケア工房 そらいろ",
  address: "架空県架空市7-8-9（試験用）",
  phone: "03-0000-0002",
  hours: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => (day === "thu" ? { day, closed: true, open: "", close: "" } : { day, closed: false, open: "09:00", close: "18:00" })),
  hoursNote: "",
  specialClosures: [],
};
const SERVICES = ["ガラスコーティング", "車内清掃", "手洗い洗車", "ヘッドライト磨き", "ホイール洗浄"];
const SHAPES: [number, number][] = [
  [640, 480],
  [480, 640],
  [800, 450],
  [500, 500],
];
const COLOURS: [number, number, number][] = [
  [70, 96, 128],
  [150, 156, 160],
  [196, 60, 52],
];

type Built = { works: Work[]; media: Record<string, Buffer>; rights: ReturnType<typeof fictionalRights>[] };

/** n fictional jobs: 1 to WORK_PHOTO_MAX photos each, a 施工前 / 施工後 pair on every third job with two or more photos. */
function jobs(n: number, prefix = "job"): Built {
  const media: Record<string, Buffer> = {};
  const rights: Built["rights"] = [];
  const works = Array.from({ length: n }, (_, k) => {
    const count = 1 + (k % WORK_PHOTO_MAX);
    const pair = k % 3 === 0 && count >= 2;
    const photos: WorkPhoto[] = Array.from({ length: count }, (_, j) => {
      const shape = SHAPES[(k + j) % SHAPES.length]!;
      const file = `${prefix}-${k + 1}-${j + 1}.png`;
      media[file] = solidPng(shape[0], shape[1], uniqueColour(COLOURS[j % 3]!, k * WORK_PHOTO_MAX + j));
      const kind = k % 7 === 6 && j === 0 ? "shop_provided" : "customer_cms";
      if (kind === "shop_provided") rights.push(fictionalRights(media[file]!));
      return { image: `/media/${file}`, imageAlt: `試験の施工写真 ${k + 1}-${j + 1}`, role: pair && j < 2 ? (j === 0 ? "before" : "after") : "other", imageKind: kind };
    });
    return {
      id: `${prefix}-${k + 1}`,
      vehicle: `架空車 タイプ${k + 1}`,
      service: SERVICES[k % SERVICES.length]!,
      description: k % 2 ? "架空の施工の説明です。" : "",
      photos,
      visible: true,
      displayOrder: k,
    };
  });
  return { works, media, rights };
}

const LONG_VEHICLE = "架空自動車 グランドツーリングワゴン ハイブリッド 特別仕様車 二〇一九年式（試験用）";
const LONG_WORD = "Fictional-Motor-Grand-Touring-Wagon-Hybrid-Edition-X2019";

let cached: Record<string, Fixture> | undefined;
/** The car-care shop's Q1 fixtures by name (fictional; made once per process; callers must not change them). */
export function autoFixtures(): Record<string, Fixture> {
  return (cached ??= make());
}
function make(): Record<string, Fixture> {
  const base = (n: number, prefix?: string): Fixture => {
    const b = jobs(n, prefix);
    return { shop: SHOP, categories: [], menu: [], news: [] as Announcement[], works: b.works, media: b.media, ...(b.rights.length ? { rights: b.rights } : {}) };
  };
  const f: Record<string, Fixture> = { "works-0": base(0), "works-3": base(3), "works-10": base(10), "works-50": base(50) };
  const long = base(4);
  long.works = long.works!.map((w, k) =>
    k === 0
      ? { ...w, vehicle: LONG_VEHICLE, service: "ガラスコーティング（三層・撥水タイプ・試験用の長い表記です）", description: `${LONG_VEHICLE}の施工記録です。`.repeat(4).slice(0, 300) }
      : k === 1
        ? { ...w, vehicle: LONG_WORD }
        : w,
  );
  f["long-vehicle"] = long;
  // the photo limits' edges (photos.ts: the largest allowed, 3:1 and 1:3, the smallest side, a square), mixed in one job
  // and alone, with and without a 施工前 / 施工後 pair; every job's photos are its own bytes
  const ratios = base(0);
  const edge: [number, number][] = [
    [3600, 2400],
    [1200, 400],
    [400, 1200],
    [320, 320],
    [2000, 2000],
    [960, 340],
    [340, 960],
    [1600, 900],
  ];
  const media: Record<string, Buffer> = {};
  const photo = (k: number, role: WorkPhoto["role"] = "other"): WorkPhoto => {
    const [w, h] = edge[k]!;
    const file = `ratio-${k + 1}.png`;
    media[file] = solidPng(w, h, uniqueColour(COLOURS[k % 3]!, 200 + k));
    return { image: `/media/${file}`, imageAlt: `試験の比率 ${w}×${h}`, role, imageKind: "customer_cms" };
  };
  const job = (k: number, photos: WorkPhoto[]): Work => ({ id: `ratio-job-${k + 1}`, vehicle: `架空車 比率${k + 1}`, service: SERVICES[k % SERVICES.length]!, description: "", photos, visible: true, displayOrder: k });
  ratios.works = [job(0, [photo(0, "before"), photo(1, "after"), photo(2), photo(3)]), job(1, [photo(4)]), job(2, [photo(5), photo(6)]), job(3, [photo(7, "after")])];
  ratios.media = media;
  f["photo-ratios"] = ratios;
  const states = base(10);
  states.works = states.works!.map((w, k) => ({ ...w, visible: k % 4 !== 0, displayOrder: 100 - k }));
  f["hidden-reorder"] = states;
  const hours = base(3);
  hours.shop = {
    ...SHOP,
    hours: SHOP.hours.map((h) => (h.day === "sun" ? { ...h, open: "10:00", close: "16:00" } : h.day === "wed" ? { ...h, closed: true, open: "", close: "" } : h)),
    hoursNote: "作業の受付は閉店の1時間前までです。",
    specialClosures: [
      { date: "2026-11-24", note: "過ぎた休業（表示しない）" },
      { date: "2026-12-30", note: "年末" },
      { date: "2027-01-02", note: "" },
    ],
  };
  f["hours-closures"] = hours;
  const one = base(3);
  one.news = [{ id: "news-1", title: "冬の下回り洗浄を始めました", body: "試験用のお知らせです。", publishedAt: "2026-11-30", visible: true }];
  f["news-1"] = one;
  const many = base(3);
  many.news = Array.from({ length: 12 }, (_, k) => ({ id: `news-${k + 1}`, title: k === 0 ? `${LONG_VEHICLE}のお知らせ` : `お知らせ ${k + 1}`, body: k % 2 ? "" : "試験用の本文です。".repeat(k + 1), publishedAt: `2026-11-${String(k + 1).padStart(2, "0")}`, visible: k !== 3 }));
  f["news-many"] = many;
  return f;
}
