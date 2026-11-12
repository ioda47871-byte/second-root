/**
 * DEV-199a: synthetic shops for the copy quality audit tests. Every shop is fictional (架空…, `fictional-…` ids) except
 * the real-shop-lane sample, whose name and address are made up too. Each page is built from its copy record, so
 * every visible text is a record item or label and the existing checkCopyRecord passes unless a test breaks it.
 *
 * Nothing here is read from the network or a model. 輪's facts pack is read from the committed research file
 * (read-only, never written).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CopyQualityFiles } from "@/lib/design-agent/quality-pipeline/copy-quality-review";

export const REPO = resolve(__dirname, "../../../..");
export const RIN_DIR = "design-library/research/quality-pipeline/poc/bicycle";
export const rinFile = (p: string) => readFileSync(resolve(REPO, RIN_DIR, p));

type Claim = "fact" | "creative_expression" | "proposal_pending_review";
export type Item = { id: string; text: string; claim_type: Claim; source_fact_ids: string[]; owner_review_needed: boolean; label?: string };
export const fact = (id: string, text: string, sources: string[], label?: string): Item => ({ id, text, claim_type: "fact", source_fact_ids: sources, owner_review_needed: false, ...(label ? { label } : {}) });
export const creative = (id: string, text: string, sources: string[] = []): Item => ({ id, text, claim_type: "creative_expression", source_fact_ids: sources, owner_review_needed: true });
export const proposal = (id: string, text: string): Item => ({ id, text, claim_type: "proposal_pending_review", source_fact_ids: [], owner_review_needed: true });

/** A block of the page: its tag and the item it shows (`label` shows the item's label instead of its text). */
export type Block = [tag: "h1" | "h2" | "h3" | "p" | "dt" | "dd", itemId: string, show?: "label"];
export type Section = { id: string; blocks: Block[] };

export function factsPack(shopId: string, facts: Array<[key: string, value: string]>): string {
  return `${JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: shopId, facts: facts.map(([key, value], i) => ({ id: `F${i + 1}`, key, value, source_id: "S1" })) }, null, 2)}\n`;
}

/** The id the pack gives the fact with this key. */
export function idOf(facts: string, key: string): string {
  const f = (JSON.parse(facts) as { facts: Array<{ id: string; key: string }> }).facts.find((x) => x.key === key);
  if (!f) throw new Error(`fixture: no fact ${key}`);
  return f.id;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function pageHtml(items: readonly Item[], sections: readonly Section[], title?: string): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const block = ([tag, id, show]: Block) => {
    const i = byId.get(id);
    if (!i) throw new Error(`fixture: no item ${id}`);
    return `<${tag}>${esc(show === "label" ? i.label! : i.text)}</${tag}>`;
  };
  const body = sections.map((s) => `<section data-comp-section="${s.id}">\n${s.blocks.map(block).join("\n")}\n</section>`).join("\n");
  return `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n${title ? `<title>${esc(title)}</title>\n` : ""}<link rel="stylesheet" href="style.css">\n</head>\n<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`;
}

export const CSS = "body{margin:0}\n";

export function shopFiles(o: { facts: string; items: Item[]; sections: Section[]; lane?: "quality_research_fictional" | "real_shop_proposal"; css?: string }): CopyQualityFiles & { record: Record<string, unknown> } {
  const pack = JSON.parse(o.facts) as { shop_id: string };
  const record = { schema: "comp_copy_v1", shop_id: pack.shop_id, facts_sha256: createHash("sha256").update(o.facts).digest("hex"), lane: o.lane ?? "quality_research_fictional", items: o.items };
  return { factsPack: o.facts, copyRecord: `${JSON.stringify(record, null, 2)}\n`, pageHtml: pageHtml(o.items, o.sections), pageCss: o.css ?? CSS, record };
}

/** The shared info block: hours, closed days, address and access with their labels. */
const infoItems = (ids: { hours: string; closed: string; address: string; access: string }, v: { hours: string; closed: string; address: string; access: string }) => [
  fact("hours", v.hours, [ids.hours], "営業時間"),
  fact("closed", v.closed, [ids.closed], "定休日"),
  fact("address", v.address, [ids.address], "住所"),
  fact("access", v.access, [ids.access], "アクセス"),
];
const infoSection: Section = {
  id: "info",
  blocks: [
    ["h2", "access", "label"],
    ["dt", "hours", "label"],
    ["dd", "hours"],
    ["dt", "closed", "label"],
    ["dd", "closed"],
    ["dt", "address", "label"],
    ["dd", "address"],
    ["dt", "access", "label"],
    ["dd", "access"],
  ],
};

// ---- bakery ------------------------------------------------------------------------------------------------------

const BAKERY_INFO = { hours: "7:00〜17:00", closed: "月曜", address: "架空市架空区架空町一丁目2-3", access: "架空線架空駅 東口から徒歩5分" };
export const bakeryFacts = (o: { withInfo?: boolean; withCroissantSentence?: boolean } = {}) =>
  factsPack("fictional-bakery-komugi", [
    ["name", "架空パン店 こむぎ"],
    ["category", "bakery"],
    ["product_1", "クロワッサン"],
    ["product_2", "食パン"],
    ["statement_2", "食パンは前日の夜に生地を仕込みます。"],
    ...((o.withInfo ?? true)
      ? ([
          ["hours", BAKERY_INFO.hours],
          ["closed_days", BAKERY_INFO.closed],
          ["address", BAKERY_INFO.address],
          ["access", BAKERY_INFO.access],
        ] as Array<[string, string]>)
      : []),
    ...((o.withCroissantSentence ?? true) ? ([["statement_1", "クロワッサンは毎朝焼きます。"]] as Array<[string, string]>) : []),
  ]);
const bakeryInfoItems = (facts = bakeryFacts()) => infoItems({ hours: idOf(facts, "hours"), closed: idOf(facts, "closed_days"), address: idOf(facts, "address"), access: idOf(facts, "access") }, BAKERY_INFO);

export function bakeryGood(): ReturnType<typeof shopFiles> {
  const F = bakeryFacts();
  const items = [
    fact("name", "こむぎ", ["F1"]),
    fact("name-full", "架空パン店 こむぎ", ["F1"]),
    creative("tagline", "朝の棚に、焼きたてを。"),
    fact("croissant", "クロワッサン", ["F3"]),
    fact("croissant-how", "クロワッサンは毎朝焼きます。", [idOf(F, "statement_1")]),
    fact("bread", "食パン", ["F4"]),
    fact("bread-how", "食パンは前日の夜に生地を仕込みます。", ["F5"]),
    ...bakeryInfoItems(),
  ];
  return shopFiles({
    facts: bakeryFacts(),
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "name-full"], ["p", "tagline"]] },
      { id: "croissant", blocks: [["h2", "croissant"], ["p", "croissant-how"]] },
      { id: "bread", blocks: [["h2", "bread"], ["p", "bread-how"]] },
      infoSection,
    ],
  });
}

export function bakeryCliche(): ReturnType<typeof shopFiles> {
  const F = bakeryFacts();
  const items = [
    fact("name", "こむぎ", ["F1"]),
    creative("tagline", "こだわりの朝を、あなたに。"),
    creative("h-about", "心を込めて、ひとつずつ。"),
    fact("bread-how", "食パンは前日の夜に生地を仕込みます。", ["F5"]),
    creative("h-products", "こだわりの一品を。"),
    fact("croissant", "クロワッサン", ["F3"]),
    fact("croissant-how", "クロワッサンは毎朝焼きます。", [idOf(F, "statement_1")]),
    creative("h-mood", "至福の時間を、毎日に。"),
    creative("mood", "上質なくつろぎを、どうぞ。"),
    creative("h-info", "特別な朝へ。"),
    ...bakeryInfoItems(),
  ];
  return shopFiles({
    facts: bakeryFacts(),
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "tagline"]] },
      { id: "about", blocks: [["h2", "h-about"], ["p", "bread-how"]] },
      { id: "products", blocks: [["h2", "h-products"], ["p", "croissant"], ["p", "croissant-how"]] },
      { id: "mood", blocks: [["h2", "h-mood"], ["p", "mood"]] },
      { id: "info", blocks: [["h2", "h-info"], ...infoSection.blocks.slice(1)] },
    ],
  });
}

/** The facts pack has no hours, closed days, address or access: the page cannot show them and must not invent them. */
export function bakeryMissing(): ReturnType<typeof shopFiles> {
  const F = bakeryFacts({ withInfo: false });
  const items = (bakeryGood().record.items as Item[])
    .filter((i) => !["hours", "closed", "address", "access"].includes(i.id))
    .map((i) => (i.id === "croissant-how" ? { ...i, source_fact_ids: [idOf(F, "statement_1")] } : i));
  return shopFiles({
    facts: F,
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "name-full"], ["p", "tagline"]] },
      { id: "croissant", blocks: [["h2", "croissant"], ["p", "croissant-how"]] },
      { id: "bread", blocks: [["h2", "bread"], ["p", "bread-how"]] },
    ],
  });
}

// ---- beauty salon ------------------------------------------------------------------------------------------------

const SALON_INFO = { hours: "10:00〜19:00", closed: "火曜", address: "架空市架空区架空町二丁目5-8", access: "架空線架空駅 西口から徒歩2分" };
export const salonFacts = (o: { withServices?: boolean } = {}) =>
  factsPack("fictional-salon-soyogi", [
    ["name", "架空美容室 そよぎ"],
    ["category", "beauty_salon"],
    ["hours", SALON_INFO.hours],
    ["closed_days", SALON_INFO.closed],
    ["address", SALON_INFO.address],
    ["access", SALON_INFO.access],
    ...((o.withServices ?? true)
      ? ([
          ["service_1", "カット"],
          ["service_2", "カラー"],
          ["service_3", "ヘッドスパ"],
          ["statement_1", "カットの前に、髪の悩みを聞いてから長さを決めます。"],
        ] as Array<[string, string]>)
      : []),
  ]);
const salonInfoItems = () => infoItems({ hours: "F3", closed: "F4", address: "F5", access: "F6" }, SALON_INFO);

export function salonGood(): ReturnType<typeof shopFiles> {
  const items = [
    fact("name", "そよぎ", ["F1"]),
    fact("name-full", "架空美容室 そよぎ", ["F1"]),
    fact("cut", "カット", ["F7"]),
    fact("cut-how", "カットの前に、髪の悩みを聞いてから長さを決めます。", ["F10"]),
    fact("color", "カラー", ["F8"]),
    fact("spa", "ヘッドスパ", ["F9"]),
    ...salonInfoItems(),
  ];
  return shopFiles({
    facts: salonFacts(),
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "name-full"]] },
      { id: "cut", blocks: [["h2", "cut"], ["p", "cut-how"]] },
      { id: "menu", blocks: [["h2", "color"], ["h2", "spa"]] },
      infoSection,
    ],
  });
}

const salonClicheItems = (withServices: boolean) => [
  fact("name", "そよぎ", ["F1"]),
  creative("tagline", "こだわりの技術で、特別なひとときを。"),
  creative("h-services", "癒しの空間へ。"),
  ...(withServices ? [fact("cut", "カット", ["F7"]), fact("color", "カラー", ["F8"])] : []),
  creative("h-care", "あなただけの、上質な時間。"),
  creative("care", "心を込めたおもてなしで、笑顔に。"),
  creative("h-info", "素敵な毎日へ。"),
  ...salonInfoItems(),
];
export function salonCliche(o: { withServices?: boolean } = {}): ReturnType<typeof shopFiles> {
  const withServices = o.withServices ?? true;
  return shopFiles({
    facts: salonFacts({ withServices }),
    items: salonClicheItems(withServices),
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "tagline"]] },
      { id: "services", blocks: [["h2", "h-services"], ...(withServices ? ([["p", "cut"], ["p", "color"]] as Block[]) : [])] },
      { id: "care", blocks: [["h2", "h-care"], ["p", "care"]] },
      { id: "info", blocks: [["h2", "h-info"], ...infoSection.blocks.slice(1)] },
    ],
  });
}

/** The facts pack names no service at all: the offering cannot be shown and must not be invented. */
export function salonMissing(): ReturnType<typeof shopFiles> {
  const items = [fact("name", "そよぎ", ["F1"]), fact("name-full", "架空美容室 そよぎ", ["F1"]), ...salonInfoItems()];
  return shopFiles({ facts: salonFacts({ withServices: false }), items, sections: [{ id: "hero", blocks: [["h1", "name"], ["p", "name-full"]] }, infoSection] });
}

// ---- cafe --------------------------------------------------------------------------------------------------------

const CAFE_INFO = { hours: "8:00〜18:00", closed: "水曜", address: "架空市架空区架空町三丁目1-4", access: "架空線架空駅 北口から徒歩4分" };
export const cafeFacts = (o: { withInfo?: boolean } = {}) =>
  factsPack("fictional-cafe-hotori", [
    ["name", "架空喫茶 ほとり"],
    ["category", "cafe"],
    ["menu_1", "ブレンドコーヒー"],
    ["menu_2", "チーズケーキ"],
    ["statement_1", "コーヒー豆は店で週に二回焙煎します。"],
    ...((o.withInfo ?? true)
      ? ([
          ["hours", CAFE_INFO.hours],
          ["closed_days", CAFE_INFO.closed],
          ["address", CAFE_INFO.address],
          ["access", CAFE_INFO.access],
        ] as Array<[string, string]>)
      : []),
  ]);
const cafeInfoItems = () => infoItems({ hours: "F6", closed: "F7", address: "F8", access: "F9" }, CAFE_INFO);

export function cafeGood(o: { withInfo?: boolean } = {}): ReturnType<typeof shopFiles> {
  const withInfo = o.withInfo ?? true;
  const items = [
    fact("name", "ほとり", ["F1"]),
    fact("name-full", "架空喫茶 ほとり", ["F1"]),
    creative("tagline", "焙煎したての一杯を。"),
    fact("coffee", "ブレンドコーヒー", ["F3"]),
    fact("roast", "コーヒー豆は店で週に二回焙煎します。", ["F5"]),
    fact("cake", "チーズケーキ", ["F4"]),
    ...(withInfo ? cafeInfoItems() : []),
  ];
  return shopFiles({
    facts: cafeFacts({ withInfo }),
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "name-full"], ["p", "tagline"]] },
      { id: "coffee", blocks: [["h2", "coffee"], ["p", "roast"]] },
      { id: "cake", blocks: [["h2", "cake"]] },
      ...(withInfo ? [infoSection] : []),
    ],
  });
}

export function cafeCliche(): ReturnType<typeof shopFiles> {
  const items = [
    fact("name", "ほとり", ["F1"]),
    creative("tagline", "こだわりの一杯で、特別なひとときを。"),
    creative("h-space", "くつろぎの空間へ。"),
    fact("coffee", "ブレンドコーヒー", ["F3"]),
    creative("h-time", "至福の時間を、あなたに。"),
    fact("cake", "チーズケーキ", ["F4"]),
    creative("h-info", "心地よい毎日を。"),
    ...cafeInfoItems(),
  ];
  return shopFiles({
    facts: cafeFacts(),
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "tagline"]] },
      { id: "space", blocks: [["h2", "h-space"], ["p", "coffee"]] },
      { id: "time", blocks: [["h2", "h-time"], ["p", "cake"]] },
      { id: "info", blocks: [["h2", "h-info"], ...infoSection.blocks.slice(1)] },
    ],
  });
}

export const cafeMissing = () => cafeGood({ withInfo: false });

// ---- seitai (generic copy only) -----------------------------------------------------------------------------------

const SEITAI_INFO = { hours: "9:00〜20:00", closed: "日曜", address: "架空市架空区架空町五丁目3-2", access: "架空線架空駅 南口から徒歩6分" };
export function seitaiCliche(): ReturnType<typeof shopFiles> {
  const facts = factsPack("fictional-seitai-yururi", [
    ["name", "架空整体院 ゆるり"],
    ["category", "seitai"],
    ["hours", SEITAI_INFO.hours],
    ["closed_days", SEITAI_INFO.closed],
    ["address", SEITAI_INFO.address],
    ["access", SEITAI_INFO.access],
    ["service_1", "肩と背中の整体"],
  ]);
  const items = [
    fact("name", "ゆるり", ["F1"]),
    creative("tagline", "こだわりの手技で、特別なひとときを。"),
    creative("h-service", "癒しの時間へ。"),
    fact("service", "肩と背中の整体", ["F7"]),
    creative("h-care", "心を込めて、あなただけに。"),
    creative("h-info", "安らぎの毎日を。"),
    ...infoItems({ hours: "F3", closed: "F4", address: "F5", access: "F6" }, SEITAI_INFO),
  ];
  return shopFiles({
    facts,
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "tagline"]] },
      { id: "service", blocks: [["h2", "h-service"], ["p", "service"]] },
      { id: "care", blocks: [["h2", "h-care"], ["p", "hours"]] },
      { id: "info", blocks: [["h2", "h-info"], ...infoSection.blocks.slice(1)] },
    ],
  });
}

// ---- bicycle repair (輪's committed facts pack, synthetic copy and pages) -----------------------------------------

/** 輪's facts: F4 address, F5 hours, F6 closed, F7 access, F8 phone, F9 description, F10–F11 statements, F12–F15 services, F16 workshop. */
const rinInfoItems = () => [
  fact("phone", "000-0000-0236", ["F8"], "電話"),
  fact("address", "架空市架空区架空町四丁目8-1", ["F4"], "所在地"),
  fact("access", "架空線架空駅 南口から徒歩3分", ["F7"], "アクセス"),
  fact("hours", "9:00〜18:00", ["F5"], "営業時間"),
  fact("closed", "火曜", ["F6"], "定休日"),
];
const rinInfoSection: Section = {
  id: "visit",
  blocks: [
    ["h2", "access", "label"],
    ["dt", "phone", "label"],
    ["dd", "phone"],
    ["dt", "address", "label"],
    ["dd", "address"],
    ["dt", "access", "label"],
    ["dd", "access"],
    ["dt", "hours", "label"],
    ["dd", "hours"],
    ["dt", "closed", "label"],
    ["dd", "closed"],
    ["p", "fictional"],
  ],
};

/** The hero keeps 輪's one strong line; every other section is plain and informative. */
export function bicycleGood(): ReturnType<typeof shopFiles> {
  const items = [
    fact("name", "輪", ["F1"]),
    fact("name-full", "架空自転車修理 輪", ["F1"]),
    creative("tagline", "まがった車輪も、まっすぐに。", ["F10"]),
    fact("how", "パンク修理から車輪の振れ取りまで、店先の作業台で直します。", ["F9"]),
    fact("s4", "車輪の振れ取り", ["F15"]),
    fact("truing", "振れ取りでは、スポークを一本ずつ締めて車輪をまっすぐにします", ["F10"]),
    fact("s1", "パンク修理", ["F12"]),
    fact("s2", "ブレーキ調整", ["F13"]),
    fact("s3", "チェーン交換", ["F14"]),
    fact("check", "修理の前に、どこを直すかを一緒に確かめます", ["F11"]),
    fact("lesson", "月に一回、空気の入れ方の講座を開いています", ["F16"]),
    fact("fictional", "比較研究用の架空の自転車修理店です。実在の店ではありません。", ["F9"]),
    ...rinInfoItems(),
  ];
  return shopFiles({
    facts: rinFile("facts-pack.json").toString("utf8"),
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "name-full"], ["p", "tagline"], ["p", "how"]] },
      { id: "truing", blocks: [["h2", "s4"], ["p", "truing"]] },
      { id: "services", blocks: [["h2", "s1"], ["h2", "s2"], ["h2", "s3"], ["p", "check"]] },
      { id: "lesson", blocks: [["p", "lesson"]] },
      rinInfoSection,
    ],
  });
}

export const bicycleClicheSections: Section[] = [
  { id: "hero", blocks: [["h1", "name"], ["p", "tagline"]] },
  { id: "services", blocks: [["h2", "h-services"], ["p", "s1"], ["p", "s2"]] },
  { id: "care", blocks: [["h2", "h-care"], ["p", "check"]] },
  { ...rinInfoSection, blocks: [["h2", "h-visit"], ...rinInfoSection.blocks.slice(1)] },
];

export function bicycleCliche(): ReturnType<typeof shopFiles> {
  const items = [
    fact("name", "輪", ["F1"]),
    creative("tagline", "こだわりの修理で、特別なひとときを。"),
    creative("h-services", "心を込めて、あなたに。"),
    fact("s1", "パンク修理", ["F12"]),
    fact("s2", "ブレーキ調整", ["F13"]),
    creative("h-care", "上質な毎日へ。"),
    fact("check", "修理の前に、どこを直すかを一緒に確かめます", ["F11"]),
    creative("h-visit", "素敵な時間を、ここで。"),
    fact("fictional", "比較研究用の架空の自転車修理店です。実在の店ではありません。", ["F9"]),
    ...rinInfoItems(),
  ];
  return shopFiles({ facts: rinFile("facts-pack.json").toString("utf8"), items, sections: bicycleClicheSections });
}

/** 輪's facts without address, hours, closed days and access (a synthetic copy; the committed pack is not touched). */
export function bicycleMissing(): ReturnType<typeof shopFiles> {
  const pack = JSON.parse(rinFile("facts-pack.json").toString("utf8")) as { shop_id: string; facts: Array<{ id: string; key: string; value: string }> };
  const facts = `${JSON.stringify({ ...pack, facts: pack.facts.filter((f) => !["address", "hours", "closed_days", "access"].includes(f.key)) }, null, 2)}\n`;
  const good = bicycleGood();
  const items = (good.record.items as Item[]).filter((i) => !["address", "access", "hours", "closed"].includes(i.id));
  return shopFiles({
    facts,
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "name-full"], ["p", "tagline"], ["p", "how"]] },
      { id: "truing", blocks: [["h2", "s4"], ["p", "truing"]] },
      { id: "services", blocks: [["h2", "s1"], ["h2", "s2"], ["h2", "s3"], ["p", "check"]] },
      { id: "visit", blocks: [["dt", "phone", "label"], ["dd", "phone"], ["p", "fictional"]] },
    ],
  });
}

// ---- the real-shop lane (made-up shop) ---------------------------------------------------------------------------

export function realShop(o: { prose?: string[] } = {}): ReturnType<typeof shopFiles> {
  const facts = factsPack("sample-bakery-mihon", [
    ["name", "パン店 見本"],
    ["category", "bakery"],
    ["product_1", "クロワッサン"],
    ["statement_1", "クロワッサンは毎朝焼きます。"],
    ["hours", "7:00〜17:00"],
    ["closed_days", "月曜"],
    ["address", "見本市見本区見本町一丁目2-3"],
    ["access", "見本駅 東口から徒歩5分"],
  ]);
  const prose = (o.prose ?? []).map((t, i) => proposal(`p${i + 1}`, t));
  const items = [
    fact("name", "見本", ["F1"]),
    ...prose,
    fact("croissant", "クロワッサン", ["F3"]),
    fact("croissant-how", "クロワッサンは毎朝焼きます。", ["F4"]),
    ...infoItems({ hours: "F5", closed: "F6", address: "F7", access: "F8" }, { hours: "7:00〜17:00", closed: "月曜", address: "見本市見本区見本町一丁目2-3", access: "見本駅 東口から徒歩5分" }),
  ];
  const proseSections: Section[] = prose.map((p, i) => ({ id: `extra-${i + 1}`, blocks: [["h2", p.id]] }));
  return shopFiles({
    facts,
    items,
    lane: "real_shop_proposal",
    sections: [{ id: "hero", blocks: [["h1", "name"]] }, { id: "croissant", blocks: [["h2", "croissant"], ["p", "croissant-how"]] }, ...proseSections, infoSection],
  });
}
