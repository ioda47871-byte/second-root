/**
 * Issue #380 live trial (2026-11-28): a reproduction of what Pages CMS checks when the customer presses Save, for the
 * field types our .pages.yml uses — so a pre-registered entry that the CMS would refuse is caught here, before delivery.
 * Second Root only (not part of the delivery repository).
 *
 * Read from pages-cms/pages-cms (main, 2026-11-28):
 *   - components/entry/entry-form.tsx: the form schema is generateZodSchema(fields) — no ignoreHidden — and a hidden
 *     field is not rendered (`if (!field || field.hidden) return null;`), so its error appears only as the toast
 *     "Please fix the errors before saving.".
 *   - lib/schema.ts: hidden fields are skipped only with ignoreHidden; `readonly` is not looked at; a non-required field
 *     is .optional(); lists get .min / .max when they are positive numbers, and a required list at least one item;
 *     initializeState puts a field's default in place of a missing value, and in place of null for a non-object,
 *     non-list field.
 *   - fields/core/uuid: z.string().uuid("Invalid UUID format") (optional + nullable when not required); its default is
 *     crypto.randomUUID() (so a MISSING id becomes a new UUID — only a present, non-UUID id fails).
 *   - fields/core/string, text: z.string(); required → min(1); pattern; minlength / maxlength.
 *   - fields/core/number: "" when not required, else z.coerce.number(); options min / max.
 *   - fields/core/boolean: z.coerce.boolean() (anything passes).
 *   - fields/core/select: the value must be one of options.values (value ?? name); "" passes when not required.
 *   - fields/core/image: a string; required → non-empty; the extension must be allowed (options.extensions, else the
 *     media extensions). The media-folder prefix check is left out here (our paths come from the CMS itself).
 *   - fields/core/date: "" passes when not required; else it must parse as yyyy-MM-dd.
 * Not reproduced: reference look-ups (the referenced entry must exist — the build checks that), rich text, blocks.
 */
import { isUuid } from "./uuid";

type Field = {
  name: string;
  type: string;
  required?: boolean;
  hidden?: boolean;
  default?: unknown;
  pattern?: string | { regex: string; message?: string };
  list?: boolean | { min?: number; max?: number };
  options?: Record<string, unknown>;
  fields?: Field[];
};
export type CmsIssue = { path: string; message: string; hidden: boolean };

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";
const TYPE_DEFAULT: Record<string, unknown> = { string: "", text: "", number: "", boolean: false, select: "", image: "", date: "", reference: "" };

function initialValue(f: Field, v: unknown): unknown {
  if (f.type === "uuid" && (v === undefined || v === null)) return "00000000-0000-4000-8000-000000000000"; // a fresh randomUUID()
  if (v === undefined) {
    if (f.default !== undefined) return f.default;
    if (f.list) return [];
    if (f.type === "object") return {};
    return TYPE_DEFAULT[f.type] ?? "";
  }
  if (v === null && f.type !== "object" && !f.list) return f.default ?? TYPE_DEFAULT[f.type] ?? "";
  return v;
}

function checkOne(f: Field, v: unknown, path: string, hidden: boolean, mediaExtensions: readonly string[], out: CmsIssue[]): void {
  const add = (message: string): void => {
    out.push({ path, message, hidden });
  };
  switch (f.type) {
    case "uuid":
      if (!isUuid(v)) add("Invalid UUID format");
      return;
    case "string":
    case "text": {
      if (typeof v !== "string") return add("Expected string");
      if (f.required && v.length < 1) add("This field is required");
      const max = f.options?.maxlength;
      const min = f.options?.minlength;
      if (typeof max === "number" && max && v.length > max) add(`String must contain at most ${max} character(s)`);
      if (typeof min === "number" && min && v.length < min) add(`String must contain at least ${min} character(s)`);
      if (f.pattern) {
        const re = new RegExp(typeof f.pattern === "string" ? f.pattern : f.pattern.regex);
        if (!re.test(v)) add(typeof f.pattern === "string" ? "Invalid format" : (f.pattern.message ?? "Invalid pattern format"));
      }
      return;
    }
    case "number": {
      if (v === "" && !f.required) return;
      const n = Number(v);
      if (!Number.isFinite(n)) return add("Expected number");
      const { min, max } = (f.options ?? {}) as { min?: number; max?: number };
      if (typeof min === "number" && n < min) add(`Number must be greater than or equal to ${min}`);
      if (typeof max === "number" && n > max) add(`Number must be less than or equal to ${max}`);
      return;
    }
    case "boolean":
      return;
    case "select": {
      const values = Array.isArray(f.options?.values) ? (f.options!.values as unknown[]).map((x) => (x && typeof x === "object" ? String((x as { value?: unknown; name?: unknown }).value ?? (x as { name?: unknown }).name ?? "") : String(x))) : [];
      if (v === "" && !f.required) return;
      if (!values.includes(String(v))) add("Invalid option");
      return;
    }
    case "image": {
      if (f.required && isEmpty(v)) return add("This field is required");
      if (isEmpty(v)) return;
      if (typeof v !== "string") return add("Expected string");
      const allowed = (Array.isArray(f.options?.extensions) ? (f.options!.extensions as string[]) : mediaExtensions).map((x) => x.toLowerCase());
      const ext = v.split(".").pop()!.toLowerCase();
      if (allowed.length && !allowed.includes(ext)) add("Invalid file extension");
      return;
    }
    case "date": {
      if (!v) {
        if (f.required) add("Invalid date");
        return;
      }
      const ok = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
      if (!ok) add("Invalid date");
      return;
    }
    case "object":
      return checkFields(f.fields ?? [], (v ?? {}) as Record<string, unknown>, path, hidden, mediaExtensions, out);
    default:
      return;
  }
}

function checkFields(fields: Field[], value: Record<string, unknown>, base: string, parentHidden: boolean, mediaExtensions: readonly string[], out: CmsIssue[]): void {
  for (const f of fields) {
    const path = base ? `${base}.${f.name}` : f.name;
    const hidden = parentHidden || f.hidden === true;
    const v = initialValue(f, value?.[f.name]);
    if (f.list) {
      if (!Array.isArray(v)) {
        out.push({ path, message: "Expected array", hidden });
        continue;
      }
      const lim = typeof f.list === "object" ? f.list : {};
      if (typeof lim.min === "number" && lim.min > 0 && v.length < lim.min) out.push({ path, message: `Array must contain at least ${lim.min} element(s)`, hidden });
      if (typeof lim.max === "number" && lim.max > 0 && v.length > lim.max) out.push({ path, message: `Array must contain at most ${lim.max} element(s)`, hidden });
      if (f.required && v.length < 1) out.push({ path, message: "Field requires at least one item.", hidden });
      v.forEach((item, k) => checkOne(f, initialValue({ ...f, list: false }, item), `${path}.${k}`, hidden, mediaExtensions, out));
      continue;
    }
    checkOne(f, v, path, hidden, mediaExtensions, out);
  }
}

/** What Pages CMS would refuse when the customer saves this entry unchanged (empty: it saves). */
export function cmsSaveIssues(fields: readonly unknown[], entry: Record<string, unknown>, mediaExtensions: readonly string[] = []): CmsIssue[] {
  const out: CmsIssue[] = [];
  checkFields(fields as Field[], entry, "", false, mediaExtensions, out);
  return out;
}
