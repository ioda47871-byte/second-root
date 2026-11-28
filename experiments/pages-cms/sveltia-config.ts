/**
 * Issue #380 (2026-11-28): the Sveltia CMS configuration (admin/config.yml), generated from the SAME schema source as
 * .pages.yml (pages-config.ts pagesConfig) — a PoC option alongside Pages CMS, because hosted Pages CMS refuses phone
 * photos over about 3.3 MB (its upload passes a 4.5 MB request limit as base64; docs/design/cms-upload-limit-options.md).
 * Sveltia transforms images IN THE BROWSER before it commits them to GitHub: any raster image (HEIC included) becomes
 * WebP within 2560 px at quality 85, and its Exif is stripped.
 *
 * Written against the Sveltia CMS docs as read on 2026-11-28 (v5): media https://sveltiacms.app/docs/media
 * (media_libraries.all.transformations.raster_image {format: webp, quality, width, height} — "the maximum width and
 * height"; raster_image "applies to … heic"; "Exif metadata is stripped from raster images"; slugify_filename),
 * data output https://sveltiacms.app/docs/data-output (output.omit_empty_optional_fields; keys "in the order they are
 * defined"; data "not covered by the configuration" is preserved), fields https://sveltiacms.app/docs/fields
 * (required defaults to TRUE; pattern [regex, message]; no `hidden` option — uuid fields are read-only by default),
 * uuid https://sveltiacms.app/docs/fields/uuid (36-character lower case, generated for a new entry), datetime
 * https://sveltiacms.app/docs/fields/datetime (type: date, format, input_timezone), list
 * https://sveltiacms.app/docs/fields/list, slugs https://sveltiacms.app/docs/collections/entries/slugs ({{uuid}}).
 * Not verified in a real Sveltia session: everything beyond booting and parsing this file (see the PoC report).
 *
 * Mapping (Pages CMS → Sveltia): string / text → string / text, maxlength as a pattern (Sveltia has no maxlength);
 * number → number (int); boolean → boolean; select → select (value = the option's name); image → image; date →
 * datetime (date only, YYYY-MM-DD, UTC); uuid → uuid (shown read-only: Sveltia cannot hide it); object list → list
 * with fields; string list → list with field; reference → relation. Every field Pages CMS has optional gets
 * `required: false` (the defaults are opposite).
 */
import { pagesConfig, toYaml, type PagesOptions } from "./pages-config";

type PField = {
  name: string;
  label?: string;
  type: string;
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  description?: string;
  default?: unknown;
  pattern?: string | { regex: string; message: string };
  list?: boolean | { min?: number; max?: number; collapsible?: boolean | { collapsed?: boolean; summary?: string } };
  options?: Record<string, unknown>;
  fields?: PField[];
};

/**
 * Where the admin page commits: the repository and branch (site.config.json `sveltia`). With Sveltia CMS Additions
 * (sign-in with a username and password on the customer's Cloudflare Worker): auth_type "additions" and base_url = the
 * Worker URL ("`base_url` is required with `auth_type: additions`", https://sveltiacms.app/docs/additions/setup).
 * Without them the login screen offers GitHub sign-in and "Sign In with Token" (a fine-grained token with Contents:
 * Read and write on this repository, https://sveltiacms.app/docs/backends/github).
 */
export type SveltiaBackend = { repo: string; branch?: string; auth_type?: "additions"; base_url?: string };
export const SVELTIA_PLACEHOLDER_BACKEND: SveltiaBackend = { repo: "OWNER/sr-cms-trial-autocare", branch: "main" };
/** Pinned Sveltia CMS build the admin page loads (admin/index.html; kept equal by a test). */
export const SVELTIA_VERSION = "5.0.3";
/** The in-browser image transformation (owner 2026-11-28: the customer picks the iPhone photo as it is). */
export const SVELTIA_TRANSFORM = { format: "webp", quality: 85, width: 2560, height: 2560 } as const;

export const SVELTIA_PHOTO_HINT = `スマートフォンの写真をそのまま選べます（iPhone の HEIC も可）。アップロードの前にこの画面の中で WebP に変え、長い辺 ${SVELTIA_TRANSFORM.width}px までに縮め、位置情報などの Exif を消します`;

const braces = (s: string) => s.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "{{$1}}");

function patternOf(f: PField): [string, string] | undefined {
  if (f.pattern) return typeof f.pattern === "string" ? [f.pattern, "形式が正しくありません"] : [f.pattern.regex, f.pattern.message];
  const max = f.options?.maxlength;
  if (typeof max === "number") return [`^[\\s\\S]{${f.required ? 1 : 0},${max}}$`, `${max} 字まで`];
  return undefined;
}

function field(f: PField, inList = false): Record<string, unknown> {
  const common: Record<string, unknown> = { name: f.name, label: f.label ?? f.name };
  if (f.description) common.hint = f.description;
  if (f.readonly && f.type !== "uuid") common.readonly = true;
  const listOpts = typeof f.list === "object" ? f.list : {};
  // a list of objects / strings
  if (f.list) {
    const min = listOpts.min;
    const out: Record<string, unknown> = { ...common, widget: "list", required: typeof min === "number" && min > 0 };
    if (typeof min === "number" && min > 0) out.min = min;
    if (typeof listOpts.max === "number") out.max = listOpts.max;
    const coll = typeof listOpts.collapsible === "object" ? listOpts.collapsible : null;
    if (coll?.collapsed !== undefined) out.collapsed = coll.collapsed;
    if (coll?.summary) out.summary = braces(coll.summary);
    if (f.type === "object") out.fields = (f.fields ?? []).map((x) => field(x, true));
    else out.field = field({ ...f, list: false, name: f.name, required: true }, true);
    return out;
  }
  const required = f.required === true;
  const req = required ? {} : { required: false };
  switch (f.type) {
    case "uuid":
      return { ...common, widget: "uuid" };
    case "string":
    case "text": {
      const p = patternOf(f);
      return { ...common, widget: f.type, ...req, ...(p ? { pattern: p } : {}), ...(f.default !== undefined ? { default: f.default } : {}) };
    }
    case "number":
      return { ...common, widget: "number", value_type: "int", ...req, ...(f.options?.min !== undefined ? { min: f.options.min } : {}), ...(f.options?.max !== undefined ? { max: f.options.max } : {}), ...(f.default !== undefined ? { default: f.default } : {}) };
    case "boolean":
      return { ...common, widget: "boolean", required: false, ...(f.default !== undefined ? { default: f.default } : {}) };
    case "select": {
      const values = (Array.isArray(f.options?.values) ? (f.options!.values as { name: string; label?: string }[]) : []).map((v) => ({ label: v.label ?? v.name, value: v.name }));
      // a select with a default is required: Sveltia offers "(None)" on an optional select, a value the content model refuses
      return { ...common, widget: "select", ...(f.default !== undefined ? {} : req), options: values, ...(f.default !== undefined ? { default: f.default } : {}) };
    }
    case "image": {
      const exts = Array.isArray(f.options?.extensions) ? (f.options!.extensions as string[]) : [];
      // HEIC is accepted too: the transformation converts it to WebP before upload
      const accept = [...new Set([...exts.map((x) => `.${x.toLowerCase()}`), ".heic", ".heif"])].join(",");
      // (the Pages CMS hint asks for small photos; here the browser converts them, so the hint says so)
      return { ...common, hint: SVELTIA_PHOTO_HINT, widget: "image", ...(inList || required ? {} : req), accept, choose_url: false };
    }
    case "date":
      return { ...common, widget: "datetime", type: "date", format: "YYYY-MM-DD", input_timezone: "utc", ...req };
    case "reference":
      return { ...common, widget: "relation", ...req, collection: f.options?.collection, value_field: "id", search_fields: ["name"], display_fields: ["name"] };
    case "object":
      return { ...common, widget: "object", ...req, fields: (f.fields ?? []).map((x) => field(x)) };
    default:
      return { ...common, widget: "string", ...req };
  }
}

/** The Sveltia configuration as data (what admin/config.yml holds). */
export function sveltiaConfig(o: PagesOptions = {}, backend: SveltiaBackend = SVELTIA_PLACEHOLDER_BACKEND) {
  const pages = pagesConfig(o);
  const collections = pages.content.map((c) => {
    const fields = (c.fields as PField[]).map((x) => field(x));
    if (c.type === "file") return { name: c.name, label: c.label, files: [{ name: c.name, label: c.label, file: c.path, fields }] };
    const view = (c as { view?: { primary?: string; sort?: string[] } }).view;
    return { name: c.name, label: c.label, folder: c.path, format: "json", create: true, slug: "{{uuid}}", ...(view?.primary ? { identifier_field: view.primary } : {}), ...(view?.sort ? { sortable_fields: view.sort } : {}), fields };
  });
  return {
    backend: { name: "github", repo: backend.repo, branch: backend.branch ?? "main", ...(backend.auth_type ? { auth_type: backend.auth_type } : {}), ...(backend.base_url ? { base_url: backend.base_url } : {}) },
    media_folder: "/media",
    public_folder: "/media",
    media_libraries: { all: { slugify_filename: true, transformations: { raster_image: { ...SVELTIA_TRANSFORM } } } },
    output: { omit_empty_optional_fields: true, json: { indent_style: "space", indent_size: 2 } },
    collections,
  };
}

export const sveltiaYaml = (o: PagesOptions = {}, backend: SveltiaBackend = SVELTIA_PLACEHOLDER_BACKEND) =>
  `# Generated from the content model (experiments/pages-cms), the same source as .pages.yml. Edit the model, not this file.\n${toYaml(sveltiaConfig(o, backend))}`;
