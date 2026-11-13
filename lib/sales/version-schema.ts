/**
 * DEV-263e (PR #268 Fresh Review H1): a read failed because the database has no demo-version schema at all — the
 * DEV-196c migration (20261111000000_sales_demo_versions.sql) was not applied, so no version can exist and every demo
 * is the React demo. Only these errors count, and only when they name a version column or relationship:
 *
 *   - 42703 (Postgres: undefined column), e.g. `column sales_demos_1.approved_version_id does not exist`;
 *   - PGRST200 (PostgREST: no relationship found in the schema cache);
 *   - PGRST204 (PostgREST: column not found in the schema cache).
 *
 * Anything else (a network error, permissions, another missing column) is not this, and callers fail closed. Pure.
 */
const VERSION_SCHEMA_NAMES = ["approved_version_id", "demo_version_id", "sales_demo_versions"] as const;

export function versionSchemaMissing(error: { code?: string; message?: string; details?: string; hint?: string } | null | undefined): boolean {
  if (!error || !["42703", "PGRST200", "PGRST204"].includes(error.code ?? "")) return false;
  const text = [error.message, error.details, error.hint].filter((s): s is string => typeof s === "string").join(" ");
  return VERSION_SCHEMA_NAMES.some((n) => text.includes(n));
}
