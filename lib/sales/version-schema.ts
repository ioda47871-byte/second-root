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
 *
 * DEV-263g (PR #268 review Low): only the error's `message` is read (never details / hint, which can quote other
 * names), and a PGRST200 counts only when it names one of the two version columns.
 */
const VERSION_COLUMNS = ["approved_version_id", "demo_version_id"] as const;
const VERSION_SCHEMA_NAMES = [...VERSION_COLUMNS, "sales_demo_versions"] as const;

export function versionSchemaMissing(error: { code?: string; message?: string; details?: string; hint?: string } | null | undefined): boolean {
  if (!error || typeof error.message !== "string") return false;
  const names: readonly string[] = error.code === "PGRST200" ? VERSION_COLUMNS : ["42703", "PGRST204"].includes(error.code ?? "") ? VERSION_SCHEMA_NAMES : [];
  return names.some((n) => error.message!.includes(n));
}
