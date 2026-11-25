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
const MediaPath = z.union([z.literal(""), z.string().regex(/^\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpe?g|webp)$/)]);
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Day = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const MenuItem = z.strictObject({
  id: Id,
  name: Line(80).refine((s) => s.trim().length > 0, "empty"),
  category: Id,
  description: Para(400).default(""),
  /** What the page shows, exactly as the customer wrote it ("480円（税込）", "時価", "380〜520円"). Never computed. */
  priceDisplay: Line(40).default(""),
  image: MediaPath.default(""),
  imageAlt: Line(120).default(""),
  visible: z.boolean().default(true),
  soldOut: z.boolean().default(false),
  displayOrder: z.number().int().min(0).max(9999).default(0),
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

export const ShopInfo = z.strictObject({
  /** Set at delivery from the facts the customer confirmed; shown read-only in the CMS (open question for the owner). */
  name: Line(60),
  address: Line(120).default(""),
  phone: Line(30).default(""),
  hours: z
    .array(z.strictObject({ day: Day, closed: z.boolean().default(false), open: z.union([z.literal(""), Hhmm]).default(""), close: z.union([z.literal(""), Hhmm]).default("") }))
    .max(7)
    .default([]),
  hoursNote: Line(120).default(""),
  specialClosures: z.array(z.strictObject({ date: IsoDate, note: Line(80).default("") })).max(60).default([]),
});
export type ShopInfo = z.infer<typeof ShopInfo>;

export type ShopContent = { shop: ShopInfo; categories: Category[]; menu: MenuItem[]; news: Announcement[] };

export class ContentError extends Error {
  constructor(
    readonly code: "CONTENT_INVALID" | "CONTENT_DUPLICATE_ID" | "CONTENT_UNKNOWN_CATEGORY" | "CONTENT_TOO_MANY",
    readonly file: string,
  ) {
    super(`${code} ${file}`);
    this.name = "ContentError";
  }
}

/** Limits of one shop's content (a small shop: the owner's 45-item PoC fits with room). */
export const CONTENT_LIMITS = { menu: 200, categories: 30, news: 100, fileBytes: 64 * 1024 } as const;

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

/** Reads and checks the content folder of a shop repository (content/ next to media/). */
export async function loadContent(root: string): Promise<ShopContent> {
  const shop = await readJson(join(root, "content", "shop.json"), ShopInfo);
  const categories = await readJsonDir(join(root, "content", "categories"), Category, CONTENT_LIMITS.categories);
  const menu = await readJsonDir(join(root, "content", "menu"), MenuItem, CONTENT_LIMITS.menu);
  const news = await readJsonDir(join(root, "content", "news"), Announcement, CONTENT_LIMITS.news);
  for (const [list, what] of [
    [categories, "categories"],
    [menu, "menu"],
    [news, "news"],
  ] as const) {
    if (new Set(list.map((x) => x.id)).size !== list.length) throw new ContentError("CONTENT_DUPLICATE_ID", what);
  }
  const known = new Set(categories.map((c) => c.id));
  for (const m of menu) if (!known.has(m.category)) throw new ContentError("CONTENT_UNKNOWN_CATEGORY", `menu/${m.id}`);
  return { shop, categories, menu, news };
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
