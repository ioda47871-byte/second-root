/**
 * DEV-303 (owner direction 2026-11-23, docs/operations/first-client-pipeline.md §2 B): IMAGE_FIRST "request mode" — the
 * request file root hands the worker (`sr_imagefirst_request_v1`) and the deterministic PC 1440 + SP 390 prompts built
 * from it and an owner-verified facts pack. Pure: bytes in, values out (no file, no process, no network, no write).
 *
 * The request (authored by Claude per shop, validated by root only as an envelope, strictly here):
 *   { schema, id, shop_id, kind: real_shop | fictional, created_at (UTC),
 *     direction: { name, concept, palette, typography, layout_pc, layout_sp, avoid }   plain text, no URL, no HTML, no fact
 *     facts_ref: { root: second-root-shops | local-shops, shop_id },  facts_sha256,  max_images: 6,  codex_runs: 1,
 *     case_study?: { path, sha256 } }   required for a real_shop design request (Issue #336; CaseStudyRef below)
 * Nothing else is accepted (strict). The request bytes are bound by the SHA-256 root passes (`--request-sha256`).
 *
 * The prompts: the same split as the pinned fictional prompts (prompt.ts splitSections / boxesFor: PC 2 + SP 4 = 6
 * pictures in ONE Codex batch). Every text a picture may carry is an exact facts-pack value (the direction never supplies
 * text); navigation and small headings use only the facts schema's own labels (prompt.ts NAV_LABELS, checked against
 * copy-record LABELS_BY_KEY). Identity Lock: no photo or photo-like picture, no product, dish, interior, building or
 * person drawn (a picture is a design reference only, never a fact source); no price, award, history, person, review,
 * menu detail, reservation or limited offer is made up. The pinned d1 / d3 / d4 prompts (prompt.ts) are not touched.
 *
 * DEV-303 (owner decision 2026-11-24, MVP_SPEC §7.1 limited amendment): two stages. `stage: "photo_materials"` carries a
 * `photo_brief` instead of a direction and makes 1..6 photographic image MATERIALS for a sales proposal demo (buildPhotoPlan;
 * no text, logo, face, storefront, interior, building, product shown as the shop's, price or menu). The design stage
 * (`stage: "design"` or none) may name a photo_materials run's pictures (`photo_inputs`): they are attached to its one
 * Codex run, every photo frame is labelled 「イメージ」, the page shows 「提案用デモ」, and the page text is still only facts
 * values and the fixed labels. Without photo_inputs a design request's prompts and plan are byte-identical to before.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { LABELS_BY_KEY } from "../quality-pipeline/copy-record";
import { FactsPack } from "../quality-pipeline/facts-pack";
import { boxesFor, NAV_LABELS, PRINCIPLES, PromptStop, splitSections, type PlannedPart, type PlannedViewport } from "./prompt";
import { MAX_PARTS_PER_VIEWPORT, VIEWPORT_WIDTHS, type ImageFirstViewport } from "./record";

export const REQUEST_SCHEMA = "sr_imagefirst_request_v1";
export const REQUEST_PLAN_SCHEMA = "image_first_request_plan_v0";
export const REQUEST_PROMPT_VERSION = "if-req-v0";
/** The request id (= the request file's name without .json; root's envelope rule): always "req-" + 3..59 characters. */
export const REQUEST_ID_RE = /^req-[a-z0-9][a-z0-9-]{2,58}$/;
export const REQUEST_SHOP_ID_RE = /^[a-z0-9_-]{2,41}$/;
/** Root's envelope cap; the worker refuses anything larger before parsing. */
export const REQUEST_MAX_BYTES = 16 * 1024;
/** The facts pack a request may name (it is read outside git; the cap is far above a real pack, a few KiB). */
export const FACTS_MAX_BYTES = 256 * 1024;
/** One request = one Codex run of exactly this many pictures (PC 2 + SP 4). */
export const REQUEST_IMAGES = { pc: 2, sp: 4, total: 6 } as const;
export const FACTS_ROOTS = ["second-root-shops", "local-shops"] as const;
export type FactsRoot = (typeof FACTS_ROOTS)[number];

/**
 * Ids a request may never use: the fixed IMAGE_FIRST approval ids and the review PoC's dummy all contain "imagefirst"
 * (run-directions.ts), so a request id can never name, claim or deliver as one of them; and the names of the directories
 * that sit next to bundles (the review inbox's previews / audits / runs, ~/sr-runs' bundles / requests / review-inbox, the
 * worker state's deliveries / claims, the ledger's approvals / plans).
 */
export const RESERVED_REQUEST_IDS: readonly string[] = ["previews", "audits", "runs", "bundles", "requests", "review-inbox", "deliveries", "claims", "approvals", "plans"];
export const isReservedRequestId = (id: string) => /imagefirst/.test(id) || RESERVED_REQUEST_IDS.includes(id);
export const isRequestId = (id: string) => REQUEST_ID_RE.test(id) && !isReservedRequestId(id);

/**
 * Plain direction text: one line, no control character, no markup or prompt fence, no link, no e-mail, and none of the
 * plain signs of a fact (a run of 3+ digits: a phone number, a year, a price; a currency sign). A tripwire, not a fact
 * checker: buildRequestPlan also refuses a direction that quotes any facts-pack value.
 */
const UNSAFE_DIRECTION = /[\u0000-\u001f\u007f\u2028\u2029]|[<>`{}]|["'「」『』“”‘’„‟‹›«»〝〞〟＂＇｢｣]|https?:|ftp:|:\/\/|www\.|@|\.(?:com|jp|net|org|io|co|info|biz|app|dev|shop)\b|[0-9０-９]{3,}|[円¥￥$€]/i;
const DirText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0 && s === s.trim() && !UNSAFE_DIRECTION.test(s), "direction_text_unsafe");

export const RequestDirection = z.strictObject({
  name: DirText(40),
  concept: DirText(600),
  palette: DirText(200),
  typography: DirText(200),
  layout_pc: DirText(800),
  layout_sp: DirText(800),
  avoid: DirText(400),
});
export type RequestDirection = z.infer<typeof RequestDirection>;

/**
 * DEV-303 (owner decision 2026-11-24): the photo-materials stage's brief. Plain text under the same tripwire as the
 * direction (no URL, HTML, quote, digit run, currency sign; buildPhotoPlan also refuses a facts-pack value). One picture
 * per subject (1..6). Subjects are materials for a sales proposal (textures, tools, hands without faces, light), never a
 * record of the shop.
 */
export const PhotoBrief = z.strictObject({
  subjects: z.array(DirText(200)).min(1).max(REQUEST_IMAGES.total),
  mood: DirText(300),
  avoid: DirText(300),
});
export type PhotoBrief = z.infer<typeof PhotoBrief>;

/** The only names a photo material has in its run's parts/ (photo-1.png .. photo-6.png). */
export const PHOTO_FILE_RE = /^photo-[1-6]\.png$/;
/**
 * DEV-303 (owner decision 2026-11-24): the design stage's optional photo inputs: a photo_materials request's id and 1..6
 * of its files by name and SHA-256. The worker resolves them only inside that request's own run under ~/sr-runs.
 */
export const PhotoInputs = z
  .strictObject({
    request_id: z.string().regex(REQUEST_ID_RE).refine((id) => !isReservedRequestId(id), "photo_inputs_reserved"),
    files: z
      .array(z.strictObject({ name: z.string().regex(PHOTO_FILE_RE), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
      .min(1)
      .max(REQUEST_IMAGES.total),
  })
  .refine((p) => new Set(p.files.map((f) => f.name)).size === p.files.length, "photo_inputs_duplicate");
export type PhotoInputs = z.infer<typeof PhotoInputs>;
/**
 * Issue #335 / docs/design/image-first-production-flow.md §3.5, §6.1 row 1: the image tool takes at most this many
 * reference pictures per call (rust-v0.159.0 ext/image-generation/src/tool.rs MAX_EDIT_IMAGES: "`referenced_image_paths`
 * must contain at most 5 paths", refused before the call starts and leaving no record). A request that would hand one run
 * more is refused at request validation (`--validate-request` and the worker alike) with PHOTO_INPUTS_OVER_TOOL_LIMIT.
 */
export const PHOTO_TOOL_MAX_REFS = 5;
const photoInputsWithinToolLimit = (p: PhotoInputs | undefined) => p === undefined || p.files.length <= PHOTO_TOOL_MAX_REFS;

/**
 * Issue #336 / docs/design/image-first-production-flow.md §1 stage 1, §6.1 row 2: the design stage's success-case
 * analysis record (case-study.ts `sr_case_study_v1`). `path` is a file name inside the shop's own private directory next
 * to its facts pack (facts_ref: ~/second-root-shops/<shop_id>/ or, fictional only, <clone>/.local-shops/<shop_id>/);
 * `sha256` binds its bytes. A real_shop design request must carry it (CASE_STUDY_REQUIRED); the worker and
 * --validate-request run the gate check on it (≥ 3 originals viewed, owner-confirmed). It is never given to Codex.
 */
export const CASE_STUDY_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.json$/;
export const CaseStudyRef = z.strictObject({
  path: z.string().regex(CASE_STUDY_NAME_RE).refine((p) => p !== "facts-pack.json", "case_study_is_facts"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CaseStudyRef = z.infer<typeof CaseStudyRef>;

/** Exactly YYYY-MM-DDTHH:MM:SSZ (root's rule: no fraction, no offset). */
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ENVELOPE = {
  schema: z.literal(REQUEST_SCHEMA),
  id: z.string().regex(REQUEST_ID_RE),
  shop_id: z.string().regex(REQUEST_SHOP_ID_RE),
  kind: z.enum(["real_shop", "fictional"]),
  created_at: z.string().regex(UTC).refine((s) => Number.isFinite(Date.parse(s)), "created_at_invalid"),
  facts_ref: z.strictObject({ root: z.enum(FACTS_ROOTS), shop_id: z.string().regex(REQUEST_SHOP_ID_RE) }),
  facts_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  codex_runs: z.literal(1),
};
type EnvelopeShape = { shop_id: string; kind: "real_shop" | "fictional"; facts_ref: { root: FactsRoot; shop_id: string } };
const factsRefOk = (r: EnvelopeShape) => r.facts_ref.shop_id === r.shop_id;
// a real shop's facts live only in ~/second-root-shops (never inside the clone, where Codex is not kept out)
const realShopRootOk = (r: EnvelopeShape) => r.kind !== "real_shop" || r.facts_ref.root === "second-root-shops";

/** The design stage (the original request; `stage` may be left out). PC 2 + SP 4 = 6 pictures. */
export const DesignRequest = z
  .strictObject({
    ...ENVELOPE,
    stage: z.literal("design").optional(),
    direction: RequestDirection,
    photo_inputs: PhotoInputs.optional(),
    case_study: CaseStudyRef.optional(),
    max_images: z.literal(REQUEST_IMAGES.total),
  })
  .refine(factsRefOk, "facts_ref_shop_mismatch")
  .refine(realShopRootOk, "real_shop_facts_root")
  .refine((r) => r.photo_inputs === undefined || r.photo_inputs.request_id !== r.id, "photo_inputs_self");
export type DesignRequest = z.infer<typeof DesignRequest>;

/** DEV-303 (owner decision 2026-11-24): the photo-materials stage. One picture per subject; max_images = that count. */
export const PhotoMaterialsRequest = z
  .strictObject({
    ...ENVELOPE,
    stage: z.literal("photo_materials"),
    photo_brief: PhotoBrief,
    max_images: z.number().int().min(1).max(REQUEST_IMAGES.total),
  })
  .refine(factsRefOk, "facts_ref_shop_mismatch")
  .refine(realShopRootOk, "real_shop_facts_root")
  .refine((r) => r.max_images === r.photo_brief.subjects.length, "photo_count_mismatch");
export type PhotoMaterialsRequest = z.infer<typeof PhotoMaterialsRequest>;

export type ImagefirstRequest = DesignRequest | PhotoMaterialsRequest;
export const isPhotoRequest = (r: ImagefirstRequest): r is PhotoMaterialsRequest => r.stage === "photo_materials";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/**
 * The request as root handed it: at most REQUEST_MAX_BYTES, its SHA-256 = the one root passed, strict JSON of the shape
 * above, its id = the id root passed (and not a reserved one). Throws PromptStop with a fixed code.
 */
export function parseRequest(bytes: Buffer, expectedSha256: string, expectedId: string): { request: ImagefirstRequest; sha256: string } {
  if (!isRequestId(expectedId)) throw new PromptStop(REQUEST_ID_RE.test(expectedId) ? "REQUEST_ID_RESERVED" : "REQUEST_ID_INVALID");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new PromptStop("REQUEST_SHA_INVALID");
  if (bytes.length > REQUEST_MAX_BYTES) throw new PromptStop("REQUEST_TOO_LARGE");
  const got = sha256(bytes);
  if (got !== expectedSha256) throw new PromptStop("REQUEST_SHA_MISMATCH");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PromptStop("REQUEST_INVALID");
  }
  // the stage picks the schema (no stage: the design stage); each schema is strict
  const photo = !!json && typeof json === "object" && (json as { stage?: unknown }).stage === "photo_materials";
  const r = (photo ? PhotoMaterialsRequest : DesignRequest).safeParse(json);
  if (!r.success) throw new PromptStop(r.error.issues.some((i) => i.message === "direction_text_unsafe") ? (photo ? "REQUEST_PHOTO_BRIEF_UNSAFE" : "REQUEST_DIRECTION_UNSAFE") : "REQUEST_INVALID");
  if (r.data.id !== expectedId) throw new PromptStop("REQUEST_ID_MISMATCH");
  if (!isPhotoRequest(r.data) && !photoInputsWithinToolLimit(r.data.photo_inputs)) throw new PromptStop("PHOTO_INPUTS_OVER_TOOL_LIMIT");
  // Issue #336: a real shop's design starts only from an owner-confirmed success-case analysis (§1 stage 1)
  if (!isPhotoRequest(r.data) && r.data.kind === "real_shop" && !r.data.case_study) throw new PromptStop("CASE_STUDY_REQUIRED");
  return { request: r.data, sha256: got };
}

/** The facts pack bytes a request names: within the cap, its SHA-256 = the request's facts_sha256, a valid pack. */
export function parseRequestFacts(bytes: Buffer, request: ImagefirstRequest): FactsPack {
  if (bytes.length > FACTS_MAX_BYTES) throw new PromptStop("FACTS_TOO_LARGE");
  if (sha256(bytes) !== request.facts_sha256) throw new PromptStop("FACTS_SHA_MISMATCH");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PromptStop("FACTS_INVALID");
  }
  const f = FactsPack.safeParse(json);
  if (!f.success) throw new PromptStop("FACTS_INVALID");
  return f.data;
}

/** What each request-mode section is for (generic; the shop's look comes from the direction, its words from the facts). */
const ROLE: Readonly<Record<string, string>> = {
  hero: "最初の画面。店名を主役にし、方向性の考えをいちばん強く見せる",
  intro: "店の紹介文を、ゆとりをもって読ませる",
  words: "店の言葉を、1つずつ間を取って見せる",
  menu: "品目・サービスの名前を一覧として見せる（値段・説明・写真は付けない）",
  info: "来店の情報を、小さな見出しと値の組で読みやすくまとめる。ページの終点",
  visit: "所在地と道順を、小さな見出しと値の組で見せる",
  hours: "営業時間・定休日・電話を、小さな見出しと値の組で見せる。ページの終点",
};
const INFO_KEYS = ["hours", "closed_days", "address", "access", "phone"] as const;
/** Sections whose values carry the facts schema's own label as a small heading. */
const LABELLED = new Set(["info", "visit", "hours"]);
/** SP navigation: three items at most (the owner's d4 revise rule), in NAV_LABELS' order. */
const SP_NAV_KEYS = ["hours", "address", "phone"];
const MAX_STATEMENTS = 3;
const MAX_SERVICES = 8;

export type RequestSection = { id: string; keys: string[] };

const numbered = (facts: FactsPack, prefix: string, max: number) =>
  facts.facts
    .filter((f) => new RegExp(`^${prefix}_\\d{1,3}$`).test(f.key))
    .sort((a, b) => Number(a.key.slice(prefix.length + 1)) - Number(b.key.slice(prefix.length + 1)))
    .slice(0, max)
    .map((f) => f.key);

/**
 * The page's sections, declared from the facts present (never guessed): hero (name), intro (description), words
 * (statement_*), menu (service_*), info (hours, closed_days, address, access, phone). With fewer than 4 sections the
 * info block is split into visit (address, access) and hours (hours, closed_days, phone). Still fewer than 4 (the SP
 * split needs 4): REQUEST_FACTS_TOO_FEW.
 */
export function requestSections(facts: FactsPack): RequestSection[] {
  const has = (k: string) => facts.facts.some((f) => f.key === k);
  if (!has("name") || !has("description")) throw new PromptStop("FACT_MISSING");
  if (new Set(facts.facts.map((f) => f.key)).size !== facts.facts.length) throw new PromptStop("FACTS_DUPLICATE_KEY");
  const out: RequestSection[] = [
    { id: "hero", keys: ["name"] },
    { id: "intro", keys: ["description"] },
  ];
  const words = numbered(facts, "statement", MAX_STATEMENTS);
  if (words.length) out.push({ id: "words", keys: words });
  const menu = numbered(facts, "service", MAX_SERVICES);
  if (menu.length) out.push({ id: "menu", keys: menu });
  const info = INFO_KEYS.filter(has);
  if (info.length === 0) throw new PromptStop("REQUEST_FACTS_TOO_FEW");
  const visit = ["address", "access"].filter(has);
  const hours = ["hours", "closed_days", "phone"].filter(has);
  if (out.length + 1 < 4 && visit.length && hours.length) out.push({ id: "visit", keys: visit }, { id: "hours", keys: hours });
  else out.push({ id: "info", keys: [...info] });
  if (out.length < 4) throw new PromptStop("REQUEST_FACTS_TOO_FEW");
  return out;
}

export type RequestPlan = {
  schema: typeof REQUEST_PLAN_SCHEMA;
  prompt_version: typeof REQUEST_PROMPT_VERSION;
  request_id: string;
  kind: ImagefirstRequest["kind"];
  direction_key: "request";
  direction_id: string;
  /** SHA-256 of direction.json (the request's direction object, canonical JSON). */
  direction_sha256: string;
  /** The request bytes' SHA-256 (the place a pinned plan keeps its direction set's). */
  direction_set_sha256: string;
  request_sha256: string;
  facts_sha256: string;
  shop: { shop_id: string; display_name: string; category_code: string };
  viewports: Record<ImageFirstViewport, PlannedViewport>;
  batch: { prompt: string; sha256: string; chars: number; images: number };
  /** DEV-303 (owner decision 2026-11-24): only when the request names photo inputs (bound into plan_sha256). */
  photo_inputs?: PhotoInputs;
  plan_sha256: string;
};

/** The fixed words a design with photo inputs may add: the label on every photo, and the proposal-demo marker. */
export const PHOTO_LABEL = "イメージ";
export const DEMO_MARKER = "提案用デモ";

export type RequestInputs = { request: DesignRequest; requestSha256: string; factsBytes: Buffer; facts: FactsPack };

/** direction.json for a request: the direction object as canonical JSON (written into the private run directory). */
export const requestDirectionBytes = (request: DesignRequest) => Buffer.from(`${JSON.stringify(request.direction, null, 2)}\n`, "utf8");

const pct = (n: number) => `${Math.round(n * 100)}%`;
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

function labelOf(key: string): string {
  const label = NAV_LABELS.find(([k]) => k === key)?.[1];
  if (!label || !LABELS_BY_KEY[key]?.includes(label)) throw new PromptStop("NAV_LABEL_INVALID");
  return label;
}

function partPrompt(o: { inputs: RequestInputs; sections: RequestSection[]; viewport: ImageFirstViewport; groups: string[][]; k: number; boxes: { id: string; box: { y: number; h: number } }[] }): string {
  const { inputs, viewport, groups, k } = o;
  const { request, facts } = inputs;
  const d = request.direction;
  const value = (key: string) => {
    const f = facts.facts.find((x) => x.key === key);
    if (!f) throw new PromptStop("FACT_MISSING");
    return f.value;
  };
  const byId = new Map(o.sections.map((s) => [s.id, s]));
  const name = value("name");
  const n = groups.length;
  const pc = viewport === "desktop_1440";
  const first = k === 1;
  const last = k === n;
  const texts = [...new Set([...o.boxes.flatMap((b) => byId.get(b.id)!.keys), ...(last ? ["name"] : [])])].map(value);
  const present = new Set(facts.facts.map((f) => f.key));
  const nav = NAV_LABELS.filter(([key]) => present.has(key) && (pc || SP_NAV_KEYS.includes(key))).map(([key]) => labelOf(key));
  const category = facts.facts.find((f) => f.key === "category")?.value;
  const lines: string[] = [];
  lines.push("これは Web サイトのデザインカンプ（完成イメージ）の画像1枚です。写真でも、ポスターでも、パソコンやスマートフォンの写った見本画像でもありません。ブラウザの枠・スクロールバー・端末の縁・机・手は描かず、ページの画面そのものだけを、平らな画像として正面から描いてください。");
  lines.push("");
  lines.push(
    request.kind === "fictional"
      ? `店: ${name}（比較研究用の架空の店。実在の店舗ではない）`
      : `店: ${name}（実在の店。この画像は社内のデザインの参考だけに使い、店の事実の根拠にも、店や第三者に見せる素材にもならない）`,
  );
  if (category) lines.push(`業種の分類: ${category}（参考。画像には書かない）`);
  lines.push(pc ? `表示: PC 版（幅 ${VIEWPORT_WIDTHS[viewport]}px のデスクトップの画面）。` : `表示: スマートフォン版（幅 ${VIEWPORT_WIDTHS[viewport]}px の縦長の画面）。PC 版を縮めたものではなく、この幅のための別の設計。`);
  lines.push(`この画像の役割: この表示の全ページを上から ${n} 枚の画像に分けたうちの ${k} 枚目。縦長の枠（縦:横 = 3:2）に、ページの横幅いっぱいの一続きの部分を描く。`);
  lines.push("");
  lines.push("この画像に入る区画（上から順に。割合は枠の高さに対する位置）:");
  for (const b of o.boxes) lines.push(`- 区画「${b.id}」（上から ${pct(b.box.y)}〜${pct(b.box.y + b.box.h)}）: ${ROLE[b.id]}。`);
  lines.push("");
  lines.push(first ? "上端: ページの最初。いちばん上にヘッダー（店名と短いナビゲーション）を置く。" : `上端: 1つ前の画像は区画「${groups[k - 2]!.at(-1)!}」で終わっている。この画像は区画の境から始める。`);
  lines.push(last ? "下端: ページの最後。いちばん下に小さなフッター（店名だけ）を置く。" : `下端: 次の画像は区画「${groups[k]![0]!}」から始まる。この画像は区画の境で終える。`);
  lines.push("継ぎ目: 区画を途中で切らない。上下の画像と並べたとき1つのページとしてつながるよう、軸や線の左右の位置・余白の幅・文字の大きさの体系をそろえる。");
  lines.push("");
  lines.push(`方向性の名前（画像には書かない）: ${d.name}`);
  lines.push(`デザインの考え: ${d.concept}`);
  lines.push(`色: ${d.palette}`);
  lines.push(`文字の組み方: ${d.typography}`);
  lines.push(pc ? `PC 版の組み方: ${d.layout_pc}` : `スマートフォン版の組み方: ${d.layout_sp}`);
  lines.push(`避けること: ${d.avoid}`);
  const photos = request.photo_inputs;
  if (photos) {
    lines.push(`写真: 添付した ${photos.files.length} 枚の写真（入力画像）だけを、このページに置く写真として使う。それ以外の写真や写真風の絵を作らない。添付の写真は提案用の画像素材で、店の実物の写真ではない。`);
    lines.push("写真の枠: 写真は単純な長方形か角丸の長方形の枠にそのまま収め、後で店の本物の写真と差し替えられるようにする。写真の上に文字を重ねない。");
    lines.push(`写真の表示: 写真を置いたすべての枠の隅に、小さく「${PHOTO_LABEL}」と書く。`);
    lines.push("写真と店の事実（店名・紹介文・品目・来店の情報）は別の枠や区画に分け、写真が店の事実を写しているように見せない。商品・料理・店内・建物・人物の姿を新しく描かない。");
    if (first || last) lines.push(`提案用デモの印: ${first ? "ヘッダーの隅" : "フッターの隅"}に、小さく「${DEMO_MARKER}」と書く（店の公式サイトではないことの印）。`);
  } else lines.push("写真や写真風の絵は使わず、線画・図形・色の面・文字だけで組む。商品・料理・店内・建物・人物の姿は描かない（描いたものが店の実物と取り違えられないように）。");
  lines.push("");
  lines.push("デザインの原則（特定の既存サイトや作品を真似しない）:");
  for (const p of PRINCIPLES) lines.push(`- ${p.text}`);
  lines.push("");
  lines.push("画像に書いてよい文字（次の文字列だけを、一字一句そのまま。言い換え・要約・翻訳・分割をしない）:");
  for (const t of texts) lines.push(`- 「${t}」`);
  if (photos) lines.push(`- 「${PHOTO_LABEL}」（写真の枠の隅だけ）${first || last ? `\n- 「${DEMO_MARKER}」（${first ? "ヘッダー" : "フッター"}の隅だけ）` : ""}`);
  if (first) lines.push(`ナビゲーションの項目に使ってよい語: ${nav.map((x) => `「${x}」`).join(" ")}`);
  for (const b of o.boxes) if (LABELLED.has(b.id)) lines.push(`区画「${b.id}」の値の上に小さな見出しとして使ってよい語: ${byId.get(b.id)!.keys.map((key) => `「${labelOf(key)}」`).join(" ")}`);
  lines.push("それ以外の文字・英字・見出し・キャッチコピー・ロゴは描かない。数字だけの目盛りや時刻のラベルを単独で書かない（数字が現れるのは上の文字列の中だけ）。文字の代わりに読めない模様の文字を描かない。");
  lines.push(`画像の文字は店の事実の根拠にならない。価格・受賞・歴史や創業の年・人物（店主・職人など）・評判・お客様の声・メニューの説明・予約・限定の表示を作らない。${photos ? "添付の写真のほかに、人の顔や手を描かない。" : "人の顔や手を描かない。"}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The request's plan: per viewport the declared sections and one prompt per picture, the ONE batch prompt the Codex run
 * reads, and the plan SHA (the same canonical form as prompt.ts buildPromptPlan). Pure. Refuses a direction that quotes a
 * facts-pack value (REQUEST_DIRECTION_HAS_FACT) and a request whose facts pack is another shop's (FACTS_SHOP_MISMATCH is
 * the caller's check: real_shop needs the pack's shop_id = the request's; fictional is checked against the repository).
 */
export function buildRequestPlan(inputs: RequestInputs): RequestPlan {
  const { request, facts } = inputs;
  // Issue #335: never a plan whose one run would need more reference pictures than the image tool takes
  if (!photoInputsWithinToolLimit(request.photo_inputs)) throw new PromptStop("PHOTO_INPUTS_OVER_TOOL_LIMIT");
  // the direction carries no fact: no facts-pack value (but the category code, a generic word) appears in its text
  const dirText = Object.values(request.direction).join("\n").normalize("NFKC").toLowerCase();
  for (const f of facts.facts) if (f.key !== "category" && f.value.length >= 2 && dirText.includes(f.value.normalize("NFKC").toLowerCase())) throw new PromptStop("REQUEST_DIRECTION_HAS_FACT");
  const sections = requestSections(facts);
  const ids = sections.map((s) => s.id);
  const viewports = {} as Record<ImageFirstViewport, PlannedViewport>;
  for (const viewport of ["desktop_1440", "mobile_390"] as const) {
    const groups = splitSections(ids, viewport);
    if (groups.length > MAX_PARTS_PER_VIEWPORT || groups.some((g) => g.length === 0)) throw new PromptStop("SPLIT_INVALID");
    const tag = viewport === "desktop_1440" ? "pc" : "sp";
    const parts = groups.map((g, i): PlannedPart => {
      const boxes = boxesFor(g, ids[0]!);
      const prompt = partPrompt({ inputs, sections, viewport, groups, k: i + 1, boxes });
      return { index: i + 1, name: `${tag}-${i + 1}`, file: `parts/${tag}-${i + 1}.png`, prompt_file: `prompts/${tag}-${i + 1}.txt`, frame: "portrait_2x3", sections: boxes, prompt, prompt_sha256: sha256(prompt), prompt_chars: prompt.length };
    });
    viewports[viewport] = { target_css_width: VIEWPORT_WIDTHS[viewport], mode: "section_sequence", section_order: [...ids], parts, seams: parts.slice(1).map((_, i) => ({ after_part: i + 1, kind: "section_break" as const })) };
  }
  const all = [...viewports.desktop_1440.parts.map((p) => ({ vp: "PC 1440", p })), ...viewports.mobile_390.parts.map((p) => ({ vp: "SP 390", p }))];
  if (all.length !== REQUEST_IMAGES.total || viewports.desktop_1440.parts.length !== REQUEST_IMAGES.pc || viewports.mobile_390.parts.length !== REQUEST_IMAGES.sp) throw new PromptStop("SPLIT_INVALID");
  const about = request.kind === "fictional" ? "The shop is fictional." : "This is an internal design reference only: never depict products, dishes, interiors, buildings or people.";
  const photos = request.photo_inputs;
  const photoRule = photos
    ? `- ${photos.files.length} photographs are attached as input images. They are AI-generated image materials for a proposal demo, not photographs of the shop. Use only them as the photographs inside the designs, each in a plain rectangular or rounded-rectangle frame; never create any other photograph or photo-like picture.\n`
    : "";
  const batchPrompt = `Make the ${all.length} section images of ONE website design comp (a flat website screen design, not a photo, not a poster, not a device mockup) with the image generation tool. ${about}

Rules for this run:
- Call the image generation tool exactly ${all.length} times, once per image below, in the order given (Image 1 first, Image ${all.length} last). Never more than ${all.length} calls in all.
- For each call, the image prompt is that image's text between <<< and >>>, exactly as written: do not shorten, translate, reorder or add to it.
- Each image is a portrait frame (taller than wide).
${photoRule}- If any call fails or is refused, stop at once: do not retry it, do not change the prompt, do not make any further call.
- Do not run shell commands, do not read or write files, do not browse.
- When you have finished, reply with one line only: DONE followed by the number of images saved.

${all.map(({ vp, p }, i) => `Image ${i + 1} of ${all.length} — ${vp} — ${p.name}:\n<<<\n${p.prompt}>>>`).join("\n\n")}
`;
  const value = (key: string) => facts.facts.find((f) => f.key === key)?.value ?? "";
  const batch = { prompt: batchPrompt, sha256: sha256(batchPrompt), chars: batchPrompt.length, images: all.length };
  const body = {
    schema: REQUEST_PLAN_SCHEMA,
    prompt_version: REQUEST_PROMPT_VERSION,
    request_id: request.id,
    kind: request.kind,
    direction_key: "request",
    direction_id: `request-${request.id}`.slice(0, 41),
    direction_sha256: sha256(requestDirectionBytes(request)),
    direction_set_sha256: inputs.requestSha256,
    request_sha256: inputs.requestSha256,
    facts_sha256: sha256(inputs.factsBytes),
    shop: { shop_id: facts.shop_id, display_name: value("name"), category_code: value("category") || "unknown" },
    viewports,
    batch,
    ...(photos ? { photo_inputs: photos } : {}),
  } as const;
  const stripped = { ...body, batch: { sha256: batch.sha256, chars: batch.chars, images: batch.images }, viewports: Object.fromEntries(Object.entries(viewports).map(([k, v]) => [k, { ...v, parts: v.parts.map((p) => ({ ...p, prompt: undefined })) }])) };
  return { ...body, plan_sha256: sha256(canonical(stripped)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// DEV-303 (owner decision 2026-11-24): stage 1, photo materials. Up to 6 standalone photographic image MATERIALS for a
// sales proposal demo (never a record of the shop): no text, logo, face, storefront, interior, building, product
// presented as the shop's own, price or menu display. No facts-pack value enters a photo prompt (the facts pack only
// binds the request to its shop and is checked against the brief). One Codex run, one picture per subject.
// ---------------------------------------------------------------------------------------------------------------------

export const PHOTO_PLAN_SCHEMA = "image_first_photo_plan_v0";
export const PHOTO_PROMPT_VERSION = "if-photo-v0";
/**
 * Web-friendly frames the image tool already makes (its 1536x1024, 1024x1024 and 1024x1536 sizes), by position:
 * subjects 1-2 a wide 3:2 (a hero or band), 3-4 a square, 5-6 a tall 2:3 (a side or SP slot).
 */
export const PHOTO_ASPECTS = [
  { key: "landscape_3x2", size: "1536x1024", words: "横長（横:縦 = 3:2）", en: "landscape 3:2 (1536x1024)" },
  { key: "square_1x1", size: "1024x1024", words: "正方形（1:1）", en: "square 1:1 (1024x1024)" },
  { key: "portrait_2x3", size: "1024x1536", words: "縦長（横:縦 = 2:3）", en: "portrait 2:3 (1024x1536)" },
] as const;
export const photoAspectOf = (index: number) => PHOTO_ASPECTS[Math.min(2, Math.floor((index - 1) / 2))]!;

export type PlannedPhoto = { index: number; name: string; file: string; prompt_file: string; aspect: (typeof PHOTO_ASPECTS)[number]["key"]; prompt: string; prompt_sha256: string; prompt_chars: number };
export type PhotoPlan = {
  schema: typeof PHOTO_PLAN_SCHEMA;
  prompt_version: typeof PHOTO_PROMPT_VERSION;
  stage: "photo_materials";
  request_id: string;
  kind: ImagefirstRequest["kind"];
  direction_key: "request";
  direction_id: string;
  /** SHA-256 of photo-brief.json (the brief, canonical JSON; written into the private run directory). */
  direction_sha256: string;
  direction_set_sha256: string;
  request_sha256: string;
  facts_sha256: string;
  shop: { shop_id: string; display_name: string; category_code: string };
  photos: PlannedPhoto[];
  batch: { prompt: string; sha256: string; chars: number; images: number };
  plan_sha256: string;
};
export type PhotoInputsOfPlan = { request: PhotoMaterialsRequest; requestSha256: string; factsBytes: Buffer; facts: FactsPack };

/** photo-brief.json for a photo-materials request (the brief as canonical JSON). */
export const photoBriefBytes = (request: PhotoMaterialsRequest) => Buffer.from(`${JSON.stringify(request.photo_brief, null, 2)}\n`, "utf8");

function photoPrompt(brief: PhotoBrief, index: number, total: number): string {
  const aspect = photoAspectOf(index);
  const lines = [
    "これは営業提案用のデモページに置く画像素材（イメージ写真）1枚です。特定の店の記録写真ではなく、どの店の実物でもありません。",
    `この画像の役割: ${total} 枚の画像素材のうちの ${index} 枚目。`,
    `被写体: ${brief.subjects[index - 1]}`,
    `雰囲気: ${brief.mood}`,
    `避けること: ${brief.avoid}`,
    `枠: ${aspect.words}の写真。Web ページの枠にそのまま置ける、自然な光の落ち着いた写真の質感。`,
    "",
    "必ず守ること:",
    "- 文字・数字・記号・看板・ロゴ・透かし・ラベルを一切入れない。",
    "- 人の顔や頭を写さない（手元だけはよい）。",
    "- 店の外観・店内・建物・看板・商品の陳列棚・値札・メニュー表を写さない。",
    "- ある店の実物（店内、建物、売り物）に見えるように描かない。素材・道具・手元・光・質感だけを主題にする。",
    "- 実在の人物・作品・ブランドを真似しない。",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The photo-materials plan: one prompt per subject (no facts value, no shop name), the ONE batch prompt and the plan
 * SHA (the same canonical form as buildRequestPlan). Pure. Refuses a brief that quotes a facts-pack value
 * (REQUEST_PHOTO_BRIEF_HAS_FACT).
 */
export function buildPhotoPlan(inputs: PhotoInputsOfPlan): PhotoPlan {
  const { request, facts } = inputs;
  const brief = request.photo_brief;
  const text = [...brief.subjects, brief.mood, brief.avoid].join("\n").normalize("NFKC").toLowerCase();
  for (const f of facts.facts) if (f.key !== "category" && f.value.length >= 2 && text.includes(f.value.normalize("NFKC").toLowerCase())) throw new PromptStop("REQUEST_PHOTO_BRIEF_HAS_FACT");
  const total = brief.subjects.length;
  if (total < 1 || total > REQUEST_IMAGES.total || request.max_images !== total) throw new PromptStop("REQUEST_IMAGES_MISMATCH");
  const photos = brief.subjects.map((_, i): PlannedPhoto => {
    const prompt = photoPrompt(brief, i + 1, total);
    return { index: i + 1, name: `photo-${i + 1}`, file: `parts/photo-${i + 1}.png`, prompt_file: `prompts/photo-${i + 1}.txt`, aspect: photoAspectOf(i + 1).key, prompt, prompt_sha256: sha256(prompt), prompt_chars: prompt.length };
  });
  const batchPrompt = `Make ${total} standalone photographic image materials for a sales proposal demo with the image generation tool. They are not photographs of any real shop and must never show text, logos, faces, storefronts, interiors, buildings, products on display, prices or menus.

Rules for this run:
- Call the image generation tool exactly ${total} times, once per image below, in the order given (Image 1 first, Image ${total} last). Never more than ${total} calls in all.
- For each call, the image prompt is that image's text between <<< and >>>, exactly as written: do not shorten, translate, reorder or add to it.
- Make each image in the size given for it.
- If any call fails or is refused, stop at once: do not retry it, do not change the prompt, do not make any further call.
- Do not run shell commands, do not read or write files, do not browse.
- When you have finished, reply with one line only: DONE followed by the number of images saved.

${photos.map((p) => `Image ${p.index} of ${total} — ${photoAspectOf(p.index).en} — ${p.name}:\n<<<\n${p.prompt}>>>`).join("\n\n")}
`;
  const value = (key: string) => facts.facts.find((f) => f.key === key)?.value ?? "";
  const batch = { prompt: batchPrompt, sha256: sha256(batchPrompt), chars: batchPrompt.length, images: total };
  const body = {
    schema: PHOTO_PLAN_SCHEMA,
    prompt_version: PHOTO_PROMPT_VERSION,
    stage: "photo_materials",
    request_id: request.id,
    kind: request.kind,
    direction_key: "request",
    direction_id: `photo-${request.id}`.slice(0, 41),
    direction_sha256: sha256(photoBriefBytes(request)),
    direction_set_sha256: inputs.requestSha256,
    request_sha256: inputs.requestSha256,
    facts_sha256: sha256(inputs.factsBytes),
    shop: { shop_id: facts.shop_id, display_name: value("name"), category_code: value("category") || "unknown" },
    photos,
    batch,
  } as const;
  const stripped = { ...body, batch: { sha256: batch.sha256, chars: batch.chars, images: batch.images }, photos: photos.map((p) => ({ ...p, prompt: undefined })) };
  return { ...body, photos, plan_sha256: sha256(canonical(stripped)) };
}
