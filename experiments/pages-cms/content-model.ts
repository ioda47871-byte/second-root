/**
 * DEV-303 §6.1 rows 10–14, first experiment (docs/design/pages-cms-implementation-plan.md): the shared content model of
 * a shop site whose customer edits it with Pages CMS. FICTIONAL and LOCAL only: nothing here talks to GitHub,
 * Cloudflare or Pages CMS.
 *
 * The content lives as plain JSON files in the shop's own repository (what Pages CMS edits, file by file):
 *
 *   content/menu/<id>.json        menu_item     one file per item (collection)
 *   content/categories/<id>.json  category      one file per category (collection)
 *   content/news/<id>.json        announcement  one file per announcement (collection)
 *   content/shop.json             shop_info     one file (file), incl. weekly hours and special closures
 *   media/                        the pictures the customer uploads (image fields write "/media/<name>")
 *
 * Only data is shared between shops. Each shop's page code (its layout, CSS, wording of labels) is its own and reads
 * this model at build time; nothing in the content can change the CSS or the composition.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** One plain line (no control characters). The page escapes every text anyway. */
const Line = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "control_character");
const Para = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s), "control_character");
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** A picture path as the image field writes it (media.output + file name); empty when there is none. */
/** review #365 L3: upper-case extensions (a phone's IMG_0001.JPG) are accepted as they are. */
const MediaPath = z.union([z.literal(""), z.string().regex(/^\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpe?g|webp)$/i)]);
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Day = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
/** A real calendar date (2026-02-30 is refused). */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "date_invalid");
/** Text the customer types that the page shows: no markup and no link (the page escapes anyway; links are not content). */
const NO_LINK_OR_MARKUP = /[<>]|https?:|www\.|:\/\//i;

/** The longest phone text, as typed and after normalising (the CMS maxlength and the build agree on it). */
export const PHONE_MAX = 24;
/**
 * A Japanese phone number as shops write it: digits with optional hyphens, spaces or parentheses, 10 or 11 digits
 * starting with 0 (or +81 and 9–10 digits). Owner decision 2026-11-26: editable, with input validation.
 */
export function phoneOk(input: string): boolean {
  const s = normalizePhone(input);
  if (s === "") return true;
  // only digits and the separators; + only as "+81" at the start; starts and ends with a digit (or "(" first)
  if (!/^(\+81|[0-9(])[0-9()\- ]*[0-9]$/.test(s) || s.length > PHONE_MAX) return false;
  if (s.indexOf("+", 1) >= 0) return false;
  // brackets: balanced, not nested, not empty
  let open = false;
  for (const c of s) {
    if (c === "(") {
      if (open) return false;
      open = true;
    } else if (c === ")") {
      if (!open) return false;
      open = false;
    }
  }
  if (open || /\(\)/.test(s)) return false;
  // no two separators in a row (a bracket next to a space or hyphen is fine)
  if (/[\- ]{2,}/.test(s)) return false;
  // "+81 (0)3-..." : the trunk 0 in brackets after the country code is dropped
  const body = s.startsWith("+81") ? s.slice(3).replace(/^[ -]?\(0\)/, "") : s;
  const digits = body.replace(/[^0-9]/g, "");
  if (/^0+$/.test(digits)) return false;
  return s.startsWith("+81") ? /^[1-9]\d{8,9}$/.test(digits) : /^0\d{9,10}$/.test(digits);
}
/**
 * Full-width digits and separators as Japanese keyboards type them become their ASCII forms (the shop is not asked
 * to retype them); surrounding spaces (incl. the full-width space) are trimmed.
 */
export function normalizePhone(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－‐‑–—−]/g, "-")
    .replace(/＋/g, "+")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/　/g, " ")
    .trim();
}
/** An address line: at most 120 characters, not only spaces, no link or markup. */
export const addressOk = (s: string) => s === "" || (s.trim().length > 0 && s === s.trim() && !NO_LINK_OR_MARKUP.test(s));

/**
 * Trade-specific data (owner decision 2026-11-26: optional extensions, not part of the minimal shared model). A shop
 * turns on only what its trade needs; a field of an extension the shop has not turned on is refused at build.
 */
export const TRADE_EXTENSIONS = ["sizes", "allergens", "shelfLife"] as const;
/** DEV-364 PR 2a: the provenance classes A / B / C (provenance.ts). */
export const IMAGE_KINDS = ["generated", "shop_provided", "customer_cms"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
export type TradeExtension = (typeof TRADE_EXTENSIONS)[number];

export const MenuItem = z.strictObject({
  id: Id,
  name: Line(80).refine((s) => s.trim().length > 0, "empty"),
  category: Id,
  description: Para(400).default(""),
  /** What the page shows, exactly as the customer wrote it ("480円（税込）", "時価", "380〜520円"). Never computed. */
  priceDisplay: Line(40).default(""),
  image: MediaPath.default(""),
  imageAlt: Line(120).default(""),
  /**
   * DEV-364 PR 2a (quality-proof-plan §3.2): the picture's provenance class. `generated` (A): AI-generated proposal
   * material — shown with <figcaption>イメージ</figcaption>. `shop_provided` (B): a real photo the shop provided, with a
   * rights record kept outside the repository. `customer_cms` (C): a photo the customer uploaded or chose in Pages CMS
   * after the contract. B and C show no イメージ label. Absent means `generated` (the safe, labelled side); C is only
   * ever chosen explicitly. Backward compatible: the earlier two-way value `shop` (the customer's own photo, chosen in
   * the CMS after handover) is read as `customer_cms`.
   */
  imageKind: z.preprocess((v) => (v === "shop" ? "customer_cms" : v), z.enum(IMAGE_KINDS).default("generated")),
  visible: z.boolean().default(true),
  soldOut: z.boolean().default(false),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  // ---- optional trade extensions (absent unless the shop turns them on) ----
  /** sizes: e.g. a cafe's S / M / L, each with its own price text (free text, never computed). */
  sizes: z
    .array(z.strictObject({ label: Line(20).refine((s) => s.trim().length > 0, "empty"), priceDisplay: Line(40).default("") }))
    .max(6)
    .optional(),
  /** allergens: the words the shop confirmed (free text, up to 10). */
  allergens: z
    .array(Line(20).refine((s) => s.trim().length > 0, "empty"))
    .max(10)
    .optional(),
  /** shelfLife: e.g. a bakery's 「当日中」 (free text). */
  shelfLife: Line(40).optional(),
});
export type MenuItem = z.infer<typeof MenuItem>;

export const Category = z.strictObject({
  id: Id,
  name: Line(40).refine((s) => s.trim().length > 0, "empty"),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  visible: z.boolean().default(true),
});
export type Category = z.infer<typeof Category>;

export const Announcement = z.strictObject({
  id: Id,
  title: Line(80).refine((s) => s.trim().length > 0, "empty"),
  body: Para(1000).default(""),
  publishedAt: IsoDate,
  visible: z.boolean().default(true),
});
export type Announcement = z.infer<typeof Announcement>;

const Hours = z
  .strictObject({ day: Day, closed: z.boolean().default(false), open: z.union([z.literal(""), Hhmm]).default(""), close: z.union([z.literal(""), Hhmm]).default("") })
  // an open day has both times, opening before closing (a shop open past midnight writes it in hoursNote)
  .refine((h) => h.closed || (h.open === "" && h.close === "") || (h.open !== "" && h.close !== "" && h.open < h.close), "hours_invalid");

export const ShopInfo = z.strictObject({
  /** Owner decision 2026-11-26: the shop name (and the brand expression, which is the page code) stays fixed. */
  name: Line(60),
  /** Owner decision 2026-11-26: editable, with input validation. */
  // review M2 / L1: normalised at load (surrounding spaces, incl. the full-width one, trimmed; the phone's
  // full-width digits and separators made ASCII), then checked
  address: Line(120)
    .transform((v) => v.trim())
    .refine(addressOk, "address_invalid")
    .default(""),
  phone: Line(PHONE_MAX)
    .transform(normalizePhone)
    .refine(phoneOk, "phone_invalid")
    .default(""),
  hours: z
    .array(Hours)
    .max(7)
    .refine((list) => new Set(list.map((h) => h.day)).size === list.length, "hours_day_twice")
    .default([]),
  hoursNote: Line(120).default(""),
  // review L5: each date once (a closed day's leftover open / close times are allowed and ignored by the page)
  specialClosures: z
    .array(z.strictObject({ date: IsoDate, note: Line(80).default("") }))
    .max(60)
    .refine((list) => new Set(list.map((c) => c.date)).size === list.length, "closure_date_twice")
    .default([]),
});
export type ShopInfo = z.infer<typeof ShopInfo>;

/**
 * Issue #380 (owner 2026-11-27): 施工実績 (works) — a shop's finished jobs, each with its 車種, its 施工種別, a short
 * description and the photos of the job. Its own collection (content/works/<id>.json), NOT a menu item: a job is not
 * something for sale, and the owner asked not to hide the difference behind a generic model. A shop turns it on in its
 * profile (ShopProfile.collections).
 *
 * PROVISIONAL (PoC, to be confirmed with the customer): at most WORK_PHOTO_MAX photos per job, and the 施工前 / 施工後
 * pairing as an optional role on a photo (at most one of each per job).
 *
 * A job's photos are the shop's real work: B (`shop_provided`, Second Root placed it with a rights record) or C
 * (`customer_cms`, the customer uploaded it in Pages CMS — the default, as the CMS shows no choice for it). A generated
 * picture (A) is refused here (CONTENT_INVALID): an image material shown as a finished job would present a made-up job
 * as a fact (Identity Lock). Every shown photo goes through the same checks as a menu picture (photos.ts: format, bytes,
 * pixel size, ratio, the handover record of generated materials, the provenance classes).
 */
export const WORK_PHOTO_MAX = 4;
export const WORK_PHOTO_ROLES = ["other", "before", "after"] as const;
export const WorkPhoto = z.strictObject({
  image: MediaPath.refine((s) => s !== "", "empty"),
  imageAlt: Line(120).default(""),
  /** 施工前 / 施工後 (provisional); `other` shows no label. */
  role: z.enum(WORK_PHOTO_ROLES).default("other"),
  imageKind: z.preprocess((v) => (v === "shop" ? "customer_cms" : v), z.enum(["shop_provided", "customer_cms"]).default("customer_cms")),
});
export type WorkPhoto = z.infer<typeof WorkPhoto>;
export const Work = z.strictObject({
  id: Id,
  /** 車種 (free text, e.g. 「架空車 ワゴン 2019年式」). */
  vehicle: Line(60).refine((s) => s.trim().length > 0, "empty"),
  /** 施工種別 (free text, e.g. 「ガラスコーティング」). */
  service: Line(40).refine((s) => s.trim().length > 0, "empty"),
  description: Para(300).default(""),
  photos: z
    .array(WorkPhoto)
    .min(1)
    .max(WORK_PHOTO_MAX)
    .refine((list) => list.filter((p) => p.role === "before").length <= 1 && list.filter((p) => p.role === "after").length <= 1, "before_after_twice"),
  visible: z.boolean().default(true),
  displayOrder: z.number().int().min(0).max(9999).default(0),
});
export type Work = z.infer<typeof Work>;

/** works: absent unless the shop's profile turns the collection on (the bakery and the café never carry it). */
export type ShopContent = { shop: ShopInfo; categories: Category[]; menu: MenuItem[]; news: Announcement[]; works?: Work[] };

export class ContentError extends Error {
  constructor(
    readonly code:
      | "CONTENT_INVALID"
      | "CONTENT_DUPLICATE_ID"
      | "CONTENT_UNKNOWN_CATEGORY"
      | "CONTENT_TOO_MANY"
      | "CONTENT_FIXED_CHANGED"
      | "CONTENT_EXTENSION_OFF"
      // PR (4) photos (photos.ts)
      | "CONTENT_PHOTO_MISSING"
      | "CONTENT_PHOTO_TYPE"
      | "CONTENT_PHOTO_TOO_LARGE"
      | "CONTENT_PHOTO_DIMENSIONS"
      | "CONTENT_PHOTO_TOO_SMALL"
      | "CONTENT_PHOTO_RATIO"
      | "CONTENT_GENERATED_AS_SHOP"
      | "CONTENT_GENERATED_RECORD_MISSING"
      | "CONTENT_PHOTO_RIGHTS_MISSING"
      | "CONTENT_PHOTO_CLASS_MIXED"
      | "CONTENT_DELIVERY_CUSTOMER_PHOTO"
      | "CONTENT_PROVENANCE_IN_REPO"
      | "CONTENT_DELIVERY_RIGHTS_DIR_MISSING"
      | "CONTENT_SLOTS_INVALID"
      | "CONTENT_SLOTS_NOT_APPROVED"
      | "CONTENT_SLOTS_MATERIAL_UNKNOWN"
      | "CONTENT_SLOTS_ROLE_MISMATCH"
      | "CONTENT_SLOTS_BOX_MISMATCH"
      | "CONTENT_SLOTS_SUBJECT_CROPPED"
      | "CONTENT_SLOTS_MATERIAL_NOT_HANDED_OVER"
      | "CONTENT_DELIVERY_SLOT_CONTEXT_MISSING",
    readonly file: string,
  ) {
    super(`${code} ${file}`);
    this.name = "ContentError";
  }
}

/** Limits of one shop's content (a small shop: the owner's 45-item PoC fits with room). */
export const CONTENT_LIMITS = { menu: 200, categories: 30, news: 100, works: 100, fileBytes: 64 * 1024 } as const;

async function readJsonDir<T>(dir: string, schema: z.ZodType<T>, max: number): Promise<T[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  if (names.length > max) throw new ContentError("CONTENT_TOO_MANY", dir);
  const out: T[] = [];
  for (const n of names) out.push(await readJson(join(dir, n), schema));
  return out;
}
async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const bytes = await readFile(file);
  if (bytes.length > CONTENT_LIMITS.fileBytes) throw new ContentError("CONTENT_INVALID", file);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ContentError("CONTENT_INVALID", file);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ContentError("CONTENT_INVALID", file);
  return r.data;
}

/** What one shop's page code declares about its content: its fixed name, and the trade extensions it turns on. */
/** generatedDelivered (#365 re-review): generated materials were handed over, so the handover record must exist. */
/**
 * Issue #380: collections (which of the optional collections the site shows): `menu` (menu items and their categories;
 * the default when absent) and `works` (施工実績). Content of a collection the site does not show is refused
 * (CONTENT_EXTENSION_OFF), so an edit cannot sit unseen in the repository.
 */
export const SHOP_COLLECTIONS = ["menu", "works"] as const;
export type ShopCollection = (typeof SHOP_COLLECTIONS)[number];
export type ShopProfile = { fixedName: string; extensions: readonly TradeExtension[]; generatedDelivered?: boolean; collections?: readonly ShopCollection[] };
export const collectionsOf = (p?: ShopProfile): readonly ShopCollection[] => p?.collections ?? ["menu"];

/**
 * Reads and checks the content folder of a shop repository (content/ next to media/). With a profile: the shop name
 * must be the shop's fixed name (CONTENT_FIXED_CHANGED; the CMS shows it read-only, and this also catches an edit
 * made outside the CMS), and no item may carry an extension the shop has not turned on (CONTENT_EXTENSION_OFF).
 * Issue #380: content/works/ is read when there is any; with a profile it must turn `works` on, and a profile without
 * `menu` refuses menu items and categories (both CONTENT_EXTENSION_OFF). `works` is in the result only when the profile
 * turns it on or (without a profile) when there are works, so a menu-only shop's content is exactly as before.
 */
export async function loadContent(root: string, profile?: ShopProfile): Promise<ShopContent> {
  const shop = await readJson(join(root, "content", "shop.json"), ShopInfo);
  const categories = await readJsonDir(join(root, "content", "categories"), Category, CONTENT_LIMITS.categories);
  const menu = await readJsonDir(join(root, "content", "menu"), MenuItem, CONTENT_LIMITS.menu);
  const news = await readJsonDir(join(root, "content", "news"), Announcement, CONTENT_LIMITS.news);
  const works = await readJsonDir(join(root, "content", "works"), Work, CONTENT_LIMITS.works);
  for (const [list, what] of [
    [categories, "categories"],
    [menu, "menu"],
    [news, "news"],
    [works, "works"],
  ] as const) {
    if (new Set(list.map((x) => x.id)).size !== list.length) throw new ContentError("CONTENT_DUPLICATE_ID", what);
  }
  const known = new Set(categories.map((c) => c.id));
  for (const m of menu) if (!known.has(m.category)) throw new ContentError("CONTENT_UNKNOWN_CATEGORY", `menu/${m.id}`);
  if (profile) {
    if (shop.name !== profile.fixedName) throw new ContentError("CONTENT_FIXED_CHANGED", "shop.json name");
    for (const m of menu) for (const x of TRADE_EXTENSIONS) if (m[x] !== undefined && !profile.extensions.includes(x)) throw new ContentError("CONTENT_EXTENSION_OFF", `menu/${m.id} ${x}`);
    const on = collectionsOf(profile);
    if (!on.includes("menu") && (menu.length > 0 || categories.length > 0)) throw new ContentError("CONTENT_EXTENSION_OFF", "menu");
    if (!on.includes("works") && works.length > 0) throw new ContentError("CONTENT_EXTENSION_OFF", "works");
  }
  const withWorks = profile ? collectionsOf(profile).includes("works") : works.length > 0;
  return withWorks ? { shop, categories, menu, news, works } : { shop, categories, menu, news };
}

/** What the page shows: visible categories and items in their display order (then by name), visible news newest first. */
export function viewOf(c: ShopContent): { shop: ShopInfo; sections: { category: Category; items: MenuItem[] }[]; news: Announcement[] } {
  const byOrder = <T extends { displayOrder: number }>(a: T, b: T, ka: string, kb: string) => a.displayOrder - b.displayOrder || (ka < kb ? -1 : ka > kb ? 1 : 0);
  const sections = c.categories
    .filter((x) => x.visible)
    .sort((a, b) => byOrder(a, b, a.name, b.name))
    .map((category) => ({ category, items: c.menu.filter((m) => m.visible && m.category === category.id).sort((a, b) => byOrder(a, b, a.name, b.name)) }))
    .filter((s) => s.items.length > 0);
  const news = c.news.filter((n) => n.visible).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
  return { shop: c.shop, sections, news };
}

/** Issue #380: the works the page shows — visible ones in their display order (then by 車種, then id). */
export function worksOf(c: ShopContent): Work[] {
  const key = (w: Work) => `${w.vehicle}\u0000${w.id}`;
  return (c.works ?? []).filter((w) => w.visible).sort((a, b) => a.displayOrder - b.displayOrder || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * Issue #380: every picture the page shows, with where it comes from (`menu/<id>` or `works/<id>`) — the menu items'
 * pictures first, in page order (exactly the list the photo checks used before works existed), then the shown works'
 * photos. The photo checks and the provenance (photos.ts) walk this list.
 */
export function shownPictures(c: ShopContent): { ref: string; image: string; imageKind: ImageKind }[] {
  const menu = viewOf(c)
    .sections.flatMap((s) => s.items)
    .filter((m) => m.image)
    .map((m) => ({ ref: `menu/${m.id}`, image: m.image, imageKind: m.imageKind }));
  const works = worksOf(c).flatMap((w) => w.photos.map((p) => ({ ref: `works/${w.id}`, image: p.image, imageKind: p.imageKind as ImageKind })));
  return [...menu, ...works];
}

/** PR (4): whether the page shows any generated image material (each shop's footer then explains the イメージ label). */
export const shownGenerated = (v: ReturnType<typeof viewOf>) => v.sections.some((s) => s.items.some((m) => m.image !== "" && m.imageKind === "generated"));
