/**
 * Issue #293 P3 (PREPARATION, offline): the deterministic prompts of ONE IMAGE_FIRST generation — one chosen direction,
 * PC 1440 and SP 390 as pre-declared section sequences, one prompt per section picture — and the run plan the Phase 2
 * builder reads (`run-plan.json`, model_full_page_comp_v0 without the computed fields).
 *
 * Inputs (read through an injected reader, by repository-relative path; nothing else is opened):
 *   - the facts pack (bytes pinned by SHA-256: a changed pack refuses);
 *   - the direction set, from which ONLY the chosen direction object is taken (by id) and re-serialised canonically
 *     (`JSON.stringify(obj, null, 2)` + "\n"; that is direction.json and its SHA-256). No other direction's text reaches
 *     a prompt: the prompt reads the chosen object's concept, sections, plans, protect list and imagery only;
 *   - the success-principle record (bytes pinned by SHA-256), from which the source case ids of the principles used are
 *     taken. The principle texts in the prompts are written here, generically (never a case's layout, words or photos).
 *
 * Split (why PC 2 + SP 4 = 6 pictures, one Codex batch, image-once.ts MAX_BATCH_IMAGES): the image tool cannot be asked
 * for a size and has returned at most about 1.5 aspect. A portrait 2:3 picture covers 1440 x 2160 CSS px of the PC page
 * (2.4 screens) but only 390 x 585 of the SP page (less than one 844 px screen). So the SP needs more pictures: PC holds
 * three sections per picture, SP gives the first two sections a picture each (the first screen is the hero alone) and
 * two sections to each of the last two. Every seam is a section_break (no section is cut, so no colour join is required
 * of a tool that cannot be steered to the pixel); the continuity of lines and colours is asked for in the prompt and
 * judged by the owner.
 *
 * Text: a picture may show only exact fact values (and the facts schema's own labels as navigation); a lone number,
 * a price, an award, a history or a person is forbidden in every prompt (the picture's text is never a fact source).
 *
 * Pure apart from the injected reader: no process, no network, no write.
 */
import { createHash } from "node:crypto";
import { LABELS_BY_KEY } from "../quality-pipeline/copy-record";
import { FactsPack } from "../quality-pipeline/facts-pack";
import { MAX_PARTS_PER_VIEWPORT, VIEWPORT_WIDTHS, type ImageFirstViewport } from "./record";

export const PROMPT_PLAN_SCHEMA = "image_first_prompt_plan_v0";
export const PROMPT_VERSION = "if-p3-v0";

const BAKERY = "design-library/research/quality-pipeline/poc/bakery";
/** The only paths the builder reads (repository-relative), with the pinned bytes where they are pinned. */
export const PROMPT_INPUTS = {
  factsPack: { path: `${BAKERY}/facts-pack.json`, sha256: "d46adc81bee7b7096e47f57091d88df348ac37cf389d7cce071a76f634fcf715" },
  directionSet: { path: `${BAKERY}/direction-set.json` },
  principles: { path: "design-library/research/quality-pipeline/principles-v1.json", sha256: "a7c9a3f467f46787520885edf67df692a23e4c37ac05934fcfabb67ea9c4bf6d" },
} as const;

/**
 * The directions this preparation covers, the file each is read from, and the canonical direction.json SHA-256 of each
 * (a changed object refuses). d4 (Issue #302 P5: the owner's revise of d3) lives in its own file so d1/d3's approved plan
 * pins, which include the SHA-256 of direction-set.json, do not move.
 */
export const DIRECTIONS = {
  d1: { id: "d1-kiln-clock", sha256: "3c2a50de5ddd42d5f98e120553ebf82cc400b4319e1195b9d37d15b866e4c48b", set: PROMPT_INPUTS.directionSet.path },
  d3: { id: "d3-flour-crust", sha256: "91b4dcfca9a7df561bc2cbebb4c8720aa453f11ddfa030c60fd7a5737237bd23", set: PROMPT_INPUTS.directionSet.path },
  d4: { id: "d4-flour-crust-shelf", sha256: "ae61cfcc4e605bc096a74134ca14a8374dea85802be05e08fc8f78acb1f84008", set: `${BAKERY}/direction-d4.json` },
} as const;
export type DirectionKey = keyof typeof DIRECTIONS;

/**
 * Paths the builder must never read (an earlier solution for the same shop, sealed study material, or a mapping).
 * Checked on every read, before the reader is called. The shop-name fragment is assembled so this file does not name it.
 */
const SHOP_FRAGMENT = ["hoshi", "gama"].join("");
export const EXCLUDED_READS: readonly RegExp[] = [
  new RegExp(`^${BAKERY}/(fidelity|comps)(/|$)`),
  new RegExp(`^${BAKERY}/photo-slot(s|-edges)-`),
  /^design-library\/research\/three-methods\/pilot-1(\/|$)/,
  /s0-generation-selection\.json$/,
  /mapping/i,
  new RegExp(SHOP_FRAGMENT, "i"),
];

/**
 * Words of the earlier same-shop design that no prompt may carry (assembled from parts so this file does not name them).
 * buildPromptPlan refuses a plan whose any prompt contains one (PROMPT_LINEAGE_TOKEN).
 */
export const LINEAGE_TOKENS: readonly string[] = [["hea", "rth"], ["d", "2"], ["ph-", "mouth"], ["ph-", "loaf"], ["窯", "口"], ["窯の", "床"]].map((p) => p.join(""));
/**
 * The earlier design's own wording for the kiln's mouth (kiln + の + mouth, alongside the short form above). d1's own
 * direction text draws the STONE kiln's mouth (石 + that word): that motif overlap is left to the owner's judgement in the
 * approval packet (§8), so only the word not preceded by 石 refuses (PROMPT_LINEAGE_TOKEN).
 */
export const LINEAGE_PATTERNS: readonly RegExp[] = [new RegExp(`(?<!石)${["窯の", "口"].join("")}`)];

export type Reader = (repoRelativePath: string) => Promise<Buffer>;

export class PromptStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PromptStop";
  }
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Generic design principles (in the prompt) and the success-principle ids they come from (the case ids are computed). */
export const PRINCIPLES: readonly { from: string; text: string }[] = [
  { from: "P2", text: "中心の考え1つが、最初の画面から最後の区画まで、区画の順序と区切り方を決める。" },
  { from: "P3", text: "下の区画も最初の画面と同じ世界の続きとして描き、各区画はその考えの別の面を見せる。最後の区画は来店の情報という終点にする。" },
  { from: "P4", text: "区画ごとに地の色・文字の大きさ・余白・密度のうち少なくとも1つをはっきり変える。同じ帯や同じカードを並べない。各区画の主役は1つに絞り、余白で目立たせる。" },
  { from: "P5", text: "文字・線・小さな印は飾りではなく、読む順番をつくる道具として使う。大きな文字や細い線は区画の境をまたいでよい。" },
  { from: "P6", text: "スマートフォン版は PC 版の縮小ではなく、狭い縦長の画面のために並びと大きさを組み直した別の設計にする。" },
];

/** Which facts each section of each direction may show (declared here, reviewed with the packet; never guessed). */
export const SECTION_TEXT_KEYS: Readonly<Record<DirectionKey, Readonly<Record<string, readonly string[]>>>> = {
  d1: {
    hero: ["name"],
    fire: ["statement_1"],
    open: ["description"],
    names: ["service_1", "service_2", "service_3", "service_4", "service_5"],
    sellout: ["hours"],
    visit: ["closed_days", "address", "access", "phone"],
  },
  d3: {
    name: ["name"],
    "spread-flour": ["statement_2", "description"],
    "spread-fire": ["statement_1"],
    "spread-names": ["service_1", "service_2", "service_3", "service_4", "service_5"],
    hours: ["hours"],
    visit: ["closed_days", "address", "access", "phone"],
  },
  d4: {
    name: ["name"],
    "spread-flour": ["statement_2", "description"],
    "spread-fire": ["statement_1"],
    shelf: ["statement_3", "service_1", "service_2", "service_3", "service_4", "service_5"],
    info: ["hours", "closed_days", "address", "access", "phone"],
  },
};
/**
 * Sections whose values may carry the facts schema's own label as a small heading (d4: the owner asked for a labelled
 * shop-information block, revise 2026-11-21). Directions without an entry are unchanged (no label line in their prompts).
 */
export const SECTION_LABEL_KEYS: Readonly<Partial<Record<DirectionKey, Readonly<Record<string, readonly string[]>>>>> = {
  d4: { info: ["hours", "closed_days", "address", "access", "phone"] },
};
/** Facts the footer of the last picture may repeat (d4: the shop name and the fictional-shop note). Others: none. */
export const FOOTER_TEXT_KEYS: Readonly<Partial<Record<DirectionKey, readonly string[]>>> = { d4: ["name", "description"] };
/**
 * A narrower navigation for one viewport (d4 SP: the owner asked for three items at most, revise 2026-11-21). The keys are
 * a subset of NAV_LABELS' keys, in NAV_LABELS' order. Directions/viewports without an entry use all of NAV_LABELS.
 */
export const NAV_KEYS_BY_VIEWPORT: Readonly<Partial<Record<DirectionKey, Partial<Record<ImageFirstViewport, readonly string[]>>>>> = {
  d4: { mobile_390: ["hours", "address", "phone"] },
};
/** Navigation words a header may show: labels of the facts schema's own label table (copy-record LABELS_BY_KEY; checked). */
export const NAV_LABELS: readonly (readonly [key: string, label: string])[] = [
  ["hours", "営業時間"],
  ["closed_days", "定休日"],
  ["address", "所在地"],
  ["access", "道順"],
  ["phone", "電話"],
];

const LAYOUT_WORDS: Readonly<Record<string, string>> = {
  diagram: "図で見せる",
  vertical_text: "縦組みの文字で見せる",
  overlap_collage: "文字と面を重ねて見せる",
  single_column_text: "1段の文章で見せる",
  split_copy_media: "左右に分けた文字と色の面で見せる",
};
const IMAGERY_WORDS: Readonly<Record<string, string>> = {
  drawn: "写真は使わず、線画・図形・色の面・文字だけで組む。",
  none: "写真も絵も使わず、文字と色の面だけで組む。",
};

type Section = { id: string; motif_facet: string; ground: string; layout: string };
/** What the prompt reads of the chosen direction (everything else in the object is never put into a prompt). */
type DirectionUse = {
  id: string;
  concept: string;
  sections: Section[];
  ending: string;
  pc_plan: string;
  sp_plan: { first_screen: string; reorder: string; overlaps: string };
  protect: string[];
  imagery: string;
};

export type PromptInputs = {
  key: DirectionKey;
  factsBytes: Buffer;
  directionBytes: Buffer;
  directionSetSha256: string;
  principlesSha256: string;
  facts: FactsPack;
  direction: DirectionUse;
  principleCases: Record<string, string[]>;
};

/** Reads through the reader, refusing an excluded path before the reader is called. */
export async function readChecked(reader: Reader, path: string): Promise<Buffer> {
  if (EXCLUDED_READS.some((re) => re.test(path))) throw new PromptStop("READ_EXCLUDED_PATH");
  return reader(path);
}

/** A direction text as the prompt shows it: the facts pack's internal ids ("(F10)", "(F13–F17)", "F11 …") are taken out. */
const str = (v: unknown, max = 600): string => {
  if (typeof v !== "string" || v.trim() === "" || v.length > max || /<<<|>>>/.test(v)) throw new PromptStop("DIRECTION_INVALID");
  return v
    .replace(/\s*\(F\d{1,3}(?:[–-]F\d{1,3})?\) ?/g, "")
    .replace(/\bF\d{1,3}(?:[–-]F\d{1,3})?\s*/g, "")
    .trim();
};

/** The chosen direction's fields the prompt uses (refuses anything else in shape). */
function directionUse(obj: unknown, key: DirectionKey): DirectionUse {
  const o = obj as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.id !== DIRECTIONS[key].id) throw new PromptStop("DIRECTION_INVALID");
  const sections = Array.isArray(o.sections) ? o.sections : [];
  if (sections.length < 4 || sections.length > 8) throw new PromptStop("DIRECTION_SECTIONS_UNSUPPORTED");
  const sp = (o.sp_plan ?? {}) as Record<string, unknown>;
  const imagery = ((o.descriptor as Record<string, unknown> | undefined)?.imagery as Record<string, unknown> | undefined)?.value;
  if (typeof imagery !== "string" || !Object.hasOwn(IMAGERY_WORDS, imagery)) throw new PromptStop("DIRECTION_INVALID");
  const use: DirectionUse = {
    id: DIRECTIONS[key].id,
    concept: str(o.concept, 1200),
    sections: sections.map((s) => {
      const x = s as Record<string, unknown>;
      const layout = str(x.layout, 40);
      if (!Object.hasOwn(LAYOUT_WORDS, layout)) throw new PromptStop("DIRECTION_INVALID");
      return { id: str(x.id, 40), motif_facet: str(x.motif_facet), ground: str(x.ground, 80), layout };
    }),
    ending: str(o.ending),
    pc_plan: str(o.pc_plan),
    sp_plan: { first_screen: str(sp.first_screen), reorder: str(sp.reorder), overlaps: str(sp.overlaps) },
    protect: (Array.isArray(o.protect) ? o.protect : []).map((p) => str(p, 200)),
    imagery,
  };
  if (use.protect.length === 0) throw new PromptStop("DIRECTION_INVALID");
  const mapped = Object.keys(SECTION_TEXT_KEYS[key]);
  if (use.sections.map((s) => s.id).join("\n") !== mapped.join("\n")) throw new PromptStop("DIRECTION_SECTIONS_UNMAPPED");
  return use;
}

/**
 * The canonical direction.json SHA-256 of `key`'s object as it is in its file now (pin not checked): the value
 * DIRECTIONS[key].sha256 must hold. Reads only that direction's file (image-first-prompt.ts --print-direction-sha).
 */
export async function currentDirectionSha256(reader: Reader, key: DirectionKey): Promise<string> {
  if (!Object.hasOwn(DIRECTIONS, key)) throw new PromptStop("DIRECTION_UNKNOWN");
  const set = JSON.parse((await readChecked(reader, DIRECTIONS[key].set)).toString("utf8")) as { directions?: { id?: unknown }[] };
  const chosen = (Array.isArray(set.directions) ? set.directions : []).filter((d) => d && d.id === DIRECTIONS[key].id);
  if (chosen.length !== 1) throw new PromptStop("DIRECTION_INVALID");
  return sha256(`${JSON.stringify(chosen[0], null, 2)}\n`);
}

/**
 * Reads the three inputs (and nothing else) and checks their pins: the facts pack's bytes, the principle record's
 * bytes and the chosen direction object's canonical bytes.
 */
export async function loadPromptInputs(reader: Reader, key: DirectionKey): Promise<PromptInputs> {
  if (!Object.hasOwn(DIRECTIONS, key)) throw new PromptStop("DIRECTION_UNKNOWN");
  const factsBytes = await readChecked(reader, PROMPT_INPUTS.factsPack.path);
  if (sha256(factsBytes) !== PROMPT_INPUTS.factsPack.sha256) throw new PromptStop("FACTS_PIN_MISMATCH");
  const facts = FactsPack.safeParse(JSON.parse(factsBytes.toString("utf8")));
  if (!facts.success) throw new PromptStop("FACTS_INVALID");
  const principlesBytes = await readChecked(reader, PROMPT_INPUTS.principles.path);
  if (sha256(principlesBytes) !== PROMPT_INPUTS.principles.sha256) throw new PromptStop("PRINCIPLES_PIN_MISMATCH");
  const cases = (JSON.parse(principlesBytes.toString("utf8")) as { cases?: { id?: unknown; principles?: unknown }[] }).cases ?? [];
  const principleCases: Record<string, string[]> = {};
  for (const p of PRINCIPLES)
    principleCases[p.from] = cases
      .filter((c) => typeof c.id === "string" && Array.isArray(c.principles) && c.principles.includes(p.from))
      .map((c) => c.id as string)
      .sort();
  if (Object.values(principleCases).some((ids) => ids.length === 0)) throw new PromptStop("PRINCIPLES_INVALID");
  const setBytes = await readChecked(reader, DIRECTIONS[key].set);
  const set = JSON.parse(setBytes.toString("utf8")) as { shop_id?: unknown; facts_sha256?: unknown; directions?: unknown };
  if (set.shop_id !== facts.data.shop_id || set.facts_sha256 !== PROMPT_INPUTS.factsPack.sha256 || !Array.isArray(set.directions)) throw new PromptStop("DIRECTION_SET_INVALID");
  // only the chosen object is kept; the set itself is held only for its SHA-256 (provenance)
  const chosen = (set.directions as { id?: unknown }[]).filter((d) => d && d.id === DIRECTIONS[key].id);
  if (chosen.length !== 1) throw new PromptStop("DIRECTION_INVALID");
  const directionBytes = Buffer.from(`${JSON.stringify(chosen[0], null, 2)}\n`, "utf8");
  if (sha256(directionBytes) !== DIRECTIONS[key].sha256) throw new PromptStop("DIRECTION_PIN_MISMATCH");
  return { key, factsBytes, directionBytes, directionSetSha256: sha256(setBytes), principlesSha256: sha256(principlesBytes), facts: facts.data, direction: directionUse(chosen[0], key), principleCases };
}

export type PlannedSection = { id: string; box: { x: number; y: number; w: number; h: number } };
export type PlannedPart = {
  index: number;
  name: string;
  file: string;
  prompt_file: string;
  frame: "portrait_2x3";
  sections: PlannedSection[];
  prompt: string;
  prompt_sha256: string;
  prompt_chars: number;
};
export type PlannedViewport = {
  target_css_width: 1440 | 390;
  mode: "section_sequence";
  section_order: string[];
  parts: PlannedPart[];
  seams: { after_part: number; kind: "section_break" }[];
};
export type PromptPlan = {
  schema: typeof PROMPT_PLAN_SCHEMA;
  prompt_version: typeof PROMPT_VERSION;
  direction_key: DirectionKey;
  direction_id: string;
  direction_sha256: string;
  direction_set_sha256: string;
  facts_sha256: string;
  principles_sha256: string;
  principles: { from: string; case_ids: string[] }[];
  shop: { shop_id: string; display_name: string; category_code: string };
  viewports: Record<ImageFirstViewport, PlannedViewport>;
  /** The ONE prompt the Codex run reads (asks for every picture in order); its SHA-256 and length are the ledger pin. */
  batch: { prompt: string; sha256: string; chars: number; images: number };
  /** SHA-256 of the canonical plan (everything above but the prompt texts, which are bound by their SHAs). */
  plan_sha256: string;
};

/** PC: two pictures (sections split in half); SP: the first two sections one picture each, the rest in two halves. */
export function splitSections(ids: readonly string[], viewport: ImageFirstViewport): string[][] {
  if (viewport === "desktop_1440") {
    const h = Math.ceil(ids.length / 2);
    return [ids.slice(0, h), ids.slice(h)];
  }
  const rest = ids.slice(2);
  const h = Math.ceil(rest.length / 2);
  return [[ids[0]!], [ids[1]!], rest.slice(0, h), rest.slice(h)];
}

/** Section boxes inside one picture: full width, stacked; the page's first section is given 1.4 shares, the others 1. */
export function boxesFor(ids: readonly string[], firstOfPage: string): PlannedSection[] {
  const weights = ids.map((id) => (id === firstOfPage && ids.length > 1 ? 1.4 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const edges = [0];
  let acc = 0;
  for (const w of weights) edges.push(Math.round(((acc += w) / total) * 1000) / 1000);
  edges[edges.length - 1] = 1;
  return ids.map((id, i) => ({ id, box: { x: 0, y: edges[i]!, w: 1, h: Math.round((edges[i + 1]! - edges[i]!) * 1000) / 1000 } }));
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const factValue = (facts: FactsPack, key: string): string => {
  const f = facts.facts.find((x) => x.key === key);
  if (!f) throw new PromptStop("FACT_MISSING");
  return f.value;
};

function partPrompt(o: { inputs: PromptInputs; viewport: ImageFirstViewport; groups: string[][]; k: number; sections: PlannedSection[] }): string {
  const { inputs, viewport, groups, k } = o;
  const d = inputs.direction;
  const name = factValue(inputs.facts, "name");
  const byId = new Map(d.sections.map((s) => [s.id, s]));
  const n = groups.length;
  const pc = viewport === "desktop_1440";
  const first = k === 1;
  const last = k === n;
  const footerKeys = last ? (FOOTER_TEXT_KEYS[inputs.key] ?? []) : [];
  const texts = [...new Set([...o.sections.flatMap((s) => SECTION_TEXT_KEYS[inputs.key][s.id] ?? []), ...footerKeys])].map((key) => factValue(inputs.facts, key));
  const labelOf = (key: string) => {
    const label = NAV_LABELS.find(([k]) => k === key)?.[1];
    if (!label || !LABELS_BY_KEY[key]?.includes(label)) throw new PromptStop("NAV_LABEL_INVALID");
    return label;
  };
  const sectionLabels = o.sections.flatMap((s) => (SECTION_LABEL_KEYS[inputs.key]?.[s.id] ?? []).length ? [{ id: s.id, labels: SECTION_LABEL_KEYS[inputs.key]![s.id]!.map(labelOf) }] : []);
  const navKeys = NAV_KEYS_BY_VIEWPORT[inputs.key]?.[viewport];
  const nav = NAV_LABELS.filter(([key]) => !navKeys || navKeys.includes(key)).map(([key, label]) => {
    if (!LABELS_BY_KEY[key]?.includes(label)) throw new PromptStop("NAV_LABEL_INVALID");
    return label;
  });
  if (navKeys && nav.length !== navKeys.length) throw new PromptStop("NAV_LABEL_INVALID");
  const lines: string[] = [];
  lines.push("これは Web サイトのデザインカンプ（完成イメージ）の画像1枚です。写真でも、ポスターでも、パソコンやスマートフォンの写った見本画像でもありません。ブラウザの枠・スクロールバー・端末の縁・机・手は描かず、ページの画面そのものだけを、平らな画像として正面から描いてください。");
  lines.push("");
  lines.push(`店: ${name}（比較研究用の架空のパン屋。実在の店舗ではない）`);
  lines.push(pc ? `表示: PC 版（幅 ${VIEWPORT_WIDTHS[viewport]}px のデスクトップの画面）。` : `表示: スマートフォン版（幅 ${VIEWPORT_WIDTHS[viewport]}px の縦長の画面）。PC 版を縮めたものではなく、この幅のための別の設計。`);
  lines.push(`この画像の役割: この表示の全ページを上から ${n} 枚の画像に分けたうちの ${k} 枚目。縦長の枠（縦:横 = 3:2）に、ページの横幅いっぱいの一続きの部分を描く。`);
  lines.push("");
  lines.push("この画像に入る区画（上から順に。割合は枠の高さに対する位置）:");
  for (const s of o.sections) {
    const sec = byId.get(s.id)!;
    lines.push(`- 区画「${s.id}」（上から ${pct(s.box.y)}〜${pct(s.box.y + s.box.h)}）: ${sec.motif_facet}。地の色: ${sec.ground}。${LAYOUT_WORDS[sec.layout]}。`);
  }
  lines.push("");
  lines.push(first ? `上端: ページの最初。いちばん上にヘッダー（店名「${name}」と短いナビゲーション）を置く。` : `上端: 1つ前の画像は区画「${groups[k - 2]!.at(-1)!}」（${byId.get(groups[k - 2]!.at(-1)!)!.motif_facet}）で終わっている。この画像は区画の境から始める。`);
  lines.push(last ? `下端: ページの最後。いちばん下に小さなフッターを置く。終わり方: ${d.ending}` : `下端: 次の画像は区画「${groups[k]![0]!}」（${byId.get(groups[k]![0]!)!.motif_facet}）から始まる。この画像は区画の境で終える。`);
  lines.push("継ぎ目: 区画を途中で切らない。上下の画像と並べたとき1つのページとしてつながるよう、軸や線の左右の位置・余白の幅・文字の大きさの体系をそろえる。");
  lines.push("");
  lines.push(`デザインの考え: ${d.concept}`);
  if (pc) lines.push(`PC 版の組み方: ${d.pc_plan}`);
  else {
    lines.push(`スマートフォン版の1画面目: ${d.sp_plan.first_screen}`);
    lines.push(`スマートフォン版の並べ方: ${d.sp_plan.reorder}`);
    lines.push(`スマートフォン版の重なり: ${d.sp_plan.overlaps}`);
  }
  lines.push(`守る核: ${d.protect.join(" / ")}`);
  lines.push(IMAGERY_WORDS[d.imagery]!);
  lines.push("");
  lines.push("デザインの原則（特定の既存サイトや作品を真似しない）:");
  for (const p of PRINCIPLES) lines.push(`- ${p.text}`);
  lines.push("");
  lines.push("画像に書いてよい文字（次の文字列だけを、一字一句そのまま。言い換え・要約・翻訳・分割をしない）:");
  for (const t of texts) lines.push(`- 「${t}」`);
  if (first) lines.push(`ナビゲーションの項目に使ってよい語: ${nav.map((x) => `「${x}」`).join(" ")}`);
  for (const l of sectionLabels) lines.push(`区画「${l.id}」の値の上に小さな見出しとして使ってよい語: ${l.labels.map((x) => `「${x}」`).join(" ")}`);
  if (footerKeys.length) lines.push(`フッターに書いてよい文字: 上の一覧のうち ${footerKeys.map((k) => `「${factValue(inputs.facts, k)}」`).join(" ")}`);
  lines.push("それ以外の文字・英字・見出し・キャッチコピー・ロゴは描かない。数字だけの目盛りや時刻のラベルを単独で書かない（数字が現れるのは上の文字列の中だけ）。文字の代わりに読めない模様の文字を描かない。");
  lines.push("画像の文字は店の事実の根拠にならない。価格・受賞・歴史や創業の年・人物（店主・職人など）・評判・お客様の声・メニュー・予約・限定の表示を作らない。人の顔や手を描かない。");
  return `${lines.join("\n")}\n`;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** The plan: per viewport the declared sequence and one prompt per picture; the batch prompt; the plan SHA. Pure. */
export function buildPromptPlan(inputs: PromptInputs): PromptPlan {
  const d = inputs.direction;
  const ids = d.sections.map((s) => s.id);
  const viewports = {} as Record<ImageFirstViewport, PlannedViewport>;
  for (const viewport of ["desktop_1440", "mobile_390"] as const) {
    const groups = splitSections(ids, viewport);
    if (groups.length > MAX_PARTS_PER_VIEWPORT || groups.some((g) => g.length === 0)) throw new PromptStop("SPLIT_INVALID");
    const tag = viewport === "desktop_1440" ? "pc" : "sp";
    const parts = groups.map((g, i): PlannedPart => {
      const sections = boxesFor(g, ids[0]!);
      const prompt = partPrompt({ inputs, viewport, groups, k: i + 1, sections });
      return { index: i + 1, name: `${tag}-${i + 1}`, file: `parts/${tag}-${i + 1}.png`, prompt_file: `prompts/${tag}-${i + 1}.txt`, frame: "portrait_2x3", sections, prompt, prompt_sha256: sha256(prompt), prompt_chars: prompt.length };
    });
    viewports[viewport] = { target_css_width: VIEWPORT_WIDTHS[viewport], mode: "section_sequence", section_order: [...ids], parts, seams: parts.slice(1).map((_, i) => ({ after_part: i + 1, kind: "section_break" as const })) };
  }
  const all = [...viewports.desktop_1440.parts.map((p) => ({ vp: "PC 1440", p })), ...viewports.mobile_390.parts.map((p) => ({ vp: "SP 390", p }))];
  const batchPrompt = `Make the ${all.length} section images of ONE website design comp (a flat website screen design, not a photo, not a poster, not a device mockup) with the image generation tool. The shop is fictional.

Rules for this run:
- Call the image generation tool exactly ${all.length} times, once per image below, in the order given (Image 1 first, Image ${all.length} last). Never more than ${all.length} calls in all.
- For each call, the image prompt is that image's text between <<< and >>>, exactly as written: do not shorten, translate, reorder or add to it.
- Each image is a portrait frame (taller than wide).
- If any call fails or is refused, stop at once: do not retry it, do not change the prompt, do not make any further call.
- Do not run shell commands, do not read or write files, do not browse.
- When you have finished, reply with one line only: DONE followed by the number of images saved.

${all.map(({ vp, p }, i) => `Image ${i + 1} of ${all.length} — ${vp} — ${p.name}:\n<<<\n${p.prompt}>>>`).join("\n\n")}
`;
  for (const t of [batchPrompt, ...all.map((x) => x.p.prompt)]) if (LINEAGE_TOKENS.some((tok) => t.toLowerCase().includes(tok.toLowerCase())) || LINEAGE_PATTERNS.some((re) => re.test(t))) throw new PromptStop("PROMPT_LINEAGE_TOKEN");
  const shop = { shop_id: inputs.facts.shop_id, display_name: factValue(inputs.facts, "name"), category_code: factValue(inputs.facts, "category") };
  const principles = PRINCIPLES.map((p) => ({ from: p.from, case_ids: inputs.principleCases[p.from]! }));
  const batch = { prompt: batchPrompt, sha256: sha256(batchPrompt), chars: batchPrompt.length, images: all.length };
  const body = {
    schema: PROMPT_PLAN_SCHEMA,
    prompt_version: PROMPT_VERSION,
    direction_key: inputs.key,
    direction_id: d.id,
    direction_sha256: sha256(inputs.directionBytes),
    direction_set_sha256: inputs.directionSetSha256,
    facts_sha256: sha256(inputs.factsBytes),
    principles_sha256: inputs.principlesSha256,
    principles,
    shop,
    viewports,
    batch,
  } as const;
  const stripped = { ...body, batch: { sha256: batch.sha256, chars: batch.chars, images: batch.images }, viewports: Object.fromEntries(Object.entries(viewports).map(([k, v]) => [k, { ...v, parts: v.parts.map((p) => ({ ...p, prompt: undefined })) }])) };
  return { ...body, plan_sha256: sha256(canonical(stripped)) };
}

/** What --print-pin shows (no prompt text is left out: the owner reads every prompt). */
export function pinOf(plan: PromptPlan) {
  const parts = (["desktop_1440", "mobile_390"] as const).flatMap((v) => plan.viewports[v].parts.map((p) => ({ viewport: v, name: p.name, sections: p.sections, prompt_sha256: p.prompt_sha256, prompt_chars: p.prompt_chars, prompt: p.prompt })));
  return {
    mode: "print_pin",
    direction_key: plan.direction_key,
    direction_id: plan.direction_id,
    direction_sha256: plan.direction_sha256,
    direction_set_sha256: plan.direction_set_sha256,
    facts_sha256: plan.facts_sha256,
    principles_sha256: plan.principles_sha256,
    principles: plan.principles,
    section_order: { desktop_1440: plan.viewports.desktop_1440.section_order, mobile_390: plan.viewports.mobile_390.section_order },
    seams: { desktop_1440: plan.viewports.desktop_1440.seams, mobile_390: plan.viewports.mobile_390.seams },
    parts,
    batch: plan.batch,
    plan_sha256: plan.plan_sha256,
  };
}
