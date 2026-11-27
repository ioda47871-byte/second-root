/**
 * Issue #380 live trial (2026-11-28): the entry ids Pages CMS's `uuid` field accepts. Its schema is
 * `z.string().uuid("Invalid UUID format")` (fields/core/uuid/index.tsx), and the entry form validates hidden fields too
 * (components/entry/entry-form.tsx calls generateZodSchema(fields) without ignoreHidden; lib/schema.ts skips hidden
 * fields only with ignoreHidden), so a pre-registered entry whose id is not a UUID (`job-1`) cannot be saved — and the
 * error, on a hidden field, is shown nowhere but the toast "Please fix the errors before saving.".
 *
 * uuidV5: a deterministic RFC 4122 version-5 UUID (SHA-1 of a fixed namespace and a name) — the same name always gives
 * the same id, so the fixtures and the migration of delivered repositories (migrate-ids.ts) agree.
 */
import { createHash } from "node:crypto";

/** Second Root's namespace for Pages CMS entry ids (a fixed random UUID). */
export const SR_ENTRY_NAMESPACE = "8f0d6c1e-4b2a-4e57-9a3d-6c1f2e7b90a4";

/** A UUID as zod's .uuid() accepts it in both v3 and v4: 8-4-4-4-12 hex, version 1–8, variant 8/9/a/b (lower or upper case). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

/** The version-5 UUID of `name` in `namespace` (RFC 4122 §4.3). */
export function uuidV5(name: string, namespace: string = SR_ENTRY_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
