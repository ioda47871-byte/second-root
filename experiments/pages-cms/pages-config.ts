/**
 * DEV-303 §6.1 row 11, first experiment: the Pages CMS configuration (`.pages.yml` at the shop repository's root),
 * generated from the content model (content-model.ts). Only the information the customer may update is editable
 * (menu items with prices and photos, categories, weekly hours and special closures, announcements); the shop's
 * name / address / phone are shown read-only, and nothing reaches the page code, the CSS or the build settings.
 *
 * Written against the Pages CMS configuration docs as read on 2026-11-26 (https://pagescms.org/docs/configuration/:
 * top-level `media` / `content`; content entries `name`, `label`, `type` collection | file, `path`, `format`, `fields`,
 * `filename`, `view`, `operations`; field types string, text, number, boolean, image, date, select, object, reference,
 * uuid; field keys `required`, `readonly`, `hidden`, `description`, `default`, `list`, `options`). Checked offline by
 * PAGES_CONFIG_SCHEMA below (the documented keys only); not yet opened in the real Pages CMS (needs an account and the
 * GitHub App: owner approval).
 */
import { z } from "zod";

type Field = {
  name: string;
  label: string;
  type: "string" | "text" | "number" | "boolean" | "image" | "date" | "select" | "object" | "reference" | "uuid";
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  description?: string;
  default?: string | number | boolean;
  pattern?: string | { regex: string; message: string };
  list?: boolean | { min?: number; max?: number; collapsible?: boolean | { collapsed?: boolean; summary?: string } };
  options?: Record<string, unknown>;
  fields?: Field[];
};

const DAYS = [
  { name: "mon", label: "月" },
  { name: "tue", label: "火" },
  { name: "wed", label: "水" },
  { name: "thu", label: "木" },
  { name: "fri", label: "金" },
  { name: "sat", label: "土" },
  { name: "sun", label: "日" },
];
const HHMM = { regex: "^(([01][0-9]|2[0-3]):[0-5][0-9])?$", message: "08:30 のように 24 時間で書きます（空なら表示しません）" };
const ID: Field = { name: "id", label: "ID（自動）", type: "uuid", readonly: true, hidden: true };

/** The configuration as data (what `.pages.yml` holds). */
export function pagesConfig() {
  const menuFields: Field[] = [
    ID,
    { name: "name", label: "商品名", type: "string", required: true, options: { maxlength: 80 } },
    { name: "category", label: "分類", type: "reference", required: true, options: { collection: "categories", value: "{fields.id}", label: "{name}" } },
    { name: "priceDisplay", label: "価格の表示", type: "string", description: "頁にそのまま出ます（例: 480円（税込）、時価）", options: { maxlength: 40 } },
    { name: "description", label: "説明", type: "text", options: { maxlength: 400 } },
    { name: "image", label: "写真", type: "image", options: { extensions: ["jpg", "jpeg", "png", "webp"] } },
    { name: "imageAlt", label: "写真の説明（読み上げ用）", type: "string", options: { maxlength: 120 } },
    { name: "soldOut", label: "売り切れ", type: "boolean", default: false },
    { name: "visible", label: "公開する", type: "boolean", default: true },
    { name: "displayOrder", label: "並び順（小さいほど上）", type: "number", default: 0, options: { min: 0, max: 9999 } },
  ];
  return {
    media: { input: "media", output: "/media", extensions: ["jpg", "jpeg", "png", "webp"], rename: "safe" },
    content: [
      {
        name: "menu",
        label: "メニュー",
        type: "collection",
        path: "content/menu",
        format: "json",
        filename: "{id}.json",
        view: { fields: ["name", "priceDisplay", "soldOut", "visible"], primary: "name", sort: ["displayOrder", "name"], default: { sort: "displayOrder", order: "asc" } },
        fields: menuFields,
      },
      {
        name: "categories",
        label: "分類",
        type: "collection",
        path: "content/categories",
        format: "json",
        filename: "{id}.json",
        view: { fields: ["name", "visible"], primary: "name", sort: ["displayOrder", "name"], default: { sort: "displayOrder", order: "asc" } },
        fields: [
          ID,
          { name: "name", label: "分類名", type: "string", required: true, options: { maxlength: 40 } },
          { name: "displayOrder", label: "並び順", type: "number", default: 0, options: { min: 0, max: 9999 } },
          { name: "visible", label: "公開する", type: "boolean", default: true },
        ],
      },
      {
        name: "shop",
        label: "営業時間・臨時休業",
        type: "file",
        path: "content/shop.json",
        format: "json",
        operations: { delete: false },
        fields: [
          { name: "name", label: "店名", type: "string", readonly: true },
          { name: "address", label: "住所", type: "string", readonly: true },
          { name: "phone", label: "電話", type: "string", readonly: true },
          {
            name: "hours",
            label: "営業時間（曜日ごと）",
            type: "object",
            list: { max: 7, collapsible: { collapsed: true, summary: "{day} {open}–{close}" } },
            fields: [
              { name: "day", label: "曜日", type: "select", required: true, options: { values: DAYS } },
              { name: "closed", label: "定休日", type: "boolean", default: false },
              { name: "open", label: "開店", type: "string", pattern: HHMM },
              { name: "close", label: "閉店", type: "string", pattern: HHMM },
            ],
          },
          { name: "hoursNote", label: "営業時間の補足", type: "string", options: { maxlength: 120 } },
          {
            name: "specialClosures",
            label: "臨時休業",
            type: "object",
            list: { max: 60, collapsible: { collapsed: true, summary: "{date} {note}" } },
            fields: [
              { name: "date", label: "日付", type: "date", required: true, options: { format: "yyyy-MM-dd" } },
              { name: "note", label: "理由など", type: "string", options: { maxlength: 80 } },
            ],
          },
        ],
      },
      {
        name: "news",
        label: "お知らせ",
        type: "collection",
        path: "content/news",
        format: "json",
        filename: "{id}.json",
        view: { fields: ["title", "publishedAt", "visible"], primary: "title", sort: ["publishedAt"], default: { sort: "publishedAt", order: "desc" } },
        fields: [
          ID,
          { name: "title", label: "見出し", type: "string", required: true, options: { maxlength: 80 } },
          { name: "body", label: "本文", type: "text", options: { maxlength: 1000 } },
          { name: "publishedAt", label: "日付", type: "date", required: true, options: { format: "yyyy-MM-dd" } },
          { name: "visible", label: "公開する", type: "boolean", default: true },
        ],
      },
    ],
  };
}

// ---- the documented schema (offline check) ------------------------------------------------------------------------

const FIELD_OPTIONS: Record<Field["type"], string[]> = {
  string: ["minlength", "maxlength"],
  text: ["minlength", "maxlength"],
  number: ["min", "max"],
  boolean: [],
  image: ["media", "path", "multiple", "extensions", "categories", "unique", "rename"],
  date: ["time", "format", "min", "max", "step"],
  select: ["values", "multiple", "min", "max", "placeholder"],
  object: [],
  reference: ["collection", "multiple", "min", "max", "search", "value", "label"],
  uuid: [],
};
const FieldSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .strictObject({
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      label: z.union([z.string(), z.literal(false)]).optional(),
      type: z.enum(Object.keys(FIELD_OPTIONS) as [Field["type"], ...Field["type"][]]),
      required: z.boolean().optional(),
      readonly: z.boolean().optional(),
      hidden: z.boolean().optional(),
      description: z.string().optional(),
      default: z.union([z.string(), z.number(), z.boolean()]).optional(),
      pattern: z.union([z.string(), z.strictObject({ regex: z.string(), message: z.string() })]).optional(),
      list: z
        .union([z.boolean(), z.strictObject({ min: z.number().optional(), max: z.number().optional(), collapsible: z.union([z.boolean(), z.strictObject({ collapsed: z.boolean().optional(), summary: z.string().optional() })]).optional() })])
        .optional(),
      options: z.record(z.string(), z.unknown()).optional(),
      fields: z.array(FieldSchema).optional(),
    })
    .superRefine((f, ctx) => {
      for (const k of Object.keys(f.options ?? {})) if (!FIELD_OPTIONS[f.type].includes(k)) ctx.addIssue({ code: "custom", message: `option ${k} is not documented for ${f.type}` });
      if ((f.type === "object") !== (f.fields !== undefined)) ctx.addIssue({ code: "custom", message: "only object fields have fields" });
      if (f.pattern !== undefined && f.type !== "string" && f.type !== "text") ctx.addIssue({ code: "custom", message: "pattern is documented for string and text only" });
      if (f.type === "select" && !Array.isArray(f.options?.values)) ctx.addIssue({ code: "custom", message: "select needs options.values" });
      if (f.type === "reference" && typeof f.options?.collection !== "string") ctx.addIssue({ code: "custom", message: "reference needs options.collection" });
    }),
);
const View = z.strictObject({
  fields: z.array(z.string()).optional(),
  primary: z.string().optional(),
  sort: z.array(z.string()).optional(),
  search: z.array(z.string()).optional(),
  default: z.strictObject({ search: z.string().optional(), sort: z.string().optional(), order: z.enum(["asc", "desc"]).optional() }).optional(),
  layout: z.enum(["list", "tree"]).optional(),
});
const Entry = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    label: z.string().optional(),
    type: z.enum(["collection", "file"]),
    path: z.string().regex(/^[a-z0-9_./-]+$/),
    format: z.enum(["yaml-frontmatter", "json-frontmatter", "toml-frontmatter", "yaml", "json", "toml", "datagrid", "code", "raw"]).optional(),
    filename: z.union([z.string(), z.strictObject({ template: z.string(), field: z.union([z.boolean(), z.literal("create")]) })]).optional(),
    exclude: z.array(z.string()).optional(),
    subfolders: z.boolean().optional(),
    list: z.boolean().optional(),
    view: View.optional(),
    operations: z.strictObject({ create: z.boolean().optional(), rename: z.boolean().optional(), delete: z.boolean().optional() }).optional(),
    fields: z.array(FieldSchema).min(1),
  })
  .superRefine((e, ctx) => {
    if (e.type === "file" && (e.filename !== undefined || e.view !== undefined)) ctx.addIssue({ code: "custom", message: "filename and view apply to collections only" });
  });
export const PAGES_CONFIG_SCHEMA = z.strictObject({
  media: z.union([
    z.string(),
    z.strictObject({
      input: z.string(),
      output: z.string(),
      extensions: z.array(z.string()).optional(),
      categories: z.array(z.enum(["image", "document", "video", "audio", "compressed", "code", "font", "spreadsheet"])).optional(),
      rename: z.union([z.boolean(), z.enum(["safe", "random"])]).optional(),
    }),
  ]),
  content: z.array(Entry).min(1),
});

/** Names of the documented-schema problems (empty when the configuration matches the documented keys). */
export function checkPagesConfig(config: unknown): string[] {
  const r = PAGES_CONFIG_SCHEMA.safeParse(config);
  if (r.success) {
    const names = (config as ReturnType<typeof pagesConfig>).content.map((c) => c.name);
    const problems: string[] = [];
    if (new Set(names).size !== names.length) problems.push("content names are not unique");
    for (const c of (config as ReturnType<typeof pagesConfig>).content)
      for (const f of c.fields as Field[]) if (f.type === "reference" && !names.includes(String(f.options?.collection))) problems.push(`reference to unknown collection ${String(f.options?.collection)}`);
    return problems;
  }
  return r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

// ---- YAML -----------------------------------------------------------------------------------------------------------

/**
 * A small block-YAML writer for this configuration's shape: maps with identifier keys, lists, and scalars written as
 * JSON (strings double-quoted, numbers, booleans) — JSON scalars are valid YAML 1.2 scalars.
 */
export function toYaml(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  const scalar = (v: unknown) => JSON.stringify(v);
  const isScalar = (v: unknown) => v === null || typeof v !== "object";
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${scalar(item)}\n`;
        const inner = toYaml(item, indent + 2);
        return `${pad}- ${inner.slice(indent + 2)}`;
      })
      .join("");
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) throw new Error(`key ${k} needs quoting`);
        if (isScalar(v)) return `${pad}${k}: ${scalar(v)}\n`;
        if (Array.isArray(v) && v.every(isScalar)) return `${pad}${k}: [${v.map(scalar).join(", ")}]\n`;
        return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
      })
      .join("");
  }
  return `${pad}${scalar(value)}\n`;
}

export const pagesYaml = () => `# Generated from the content model (experiments/pages-cms). Edit the model, not this file.\n${toYaml(pagesConfig())}`;
