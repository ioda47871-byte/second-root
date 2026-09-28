import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listMigrations, migrationRequest, runChecks } from "../../scripts/staging/lib.mjs";
import { db } from "./helpers";

// The Staging verification (scripts/staging/verify.mjs) run against the
// local stack, which the Supabase CLI built from the same migrations: it
// must pass here, and must catch a broken rule (checked inside a
// transaction that is rolled back).

afterAll(() => db.end());

const local = listMigrations(join(process.cwd(), "supabase", "migrations"));
const last = local[local.length - 1]!;

async function withRollback<T>(fn: (query: (sql: string) => Promise<unknown[]>) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    return await fn(async (sql) => (await client.query(sql)).rows);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

describe("staging verification", () => {
  it("passes on a database built from supabase/migrations/", async () => {
    const { ok, results } = await runChecks(async (sql: string) => (await db.query(sql)).rows, local);
    expect(results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("[fail-closed] catches a table without RLS and a write grant for signed-in users", async () => {
    const { results } = await withRollback(async (query) => {
      await query("alter table public.sales_prospects disable row level security");
      await query("grant insert on public.sales_outreaches to authenticated");
      return runChecks(query, local);
    });
    const failed = Object.fromEntries(results.filter((r: { ok: boolean }) => !r.ok).map((r: { id: string; items: string[] }) => [r.id, r.items]));
    expect(failed).toEqual({ rls_enabled: ["sales_prospects"], authenticated_no_direct_write: ["sales_outreaches:INSERT"] });
  });

  it("[fail-closed] catches a migration missing from the history", async () => {
    const { results } = await withRollback(async (query) => {
      await query(`delete from supabase_migrations.schema_migrations where version = '${last.version}'`);
      return runChecks(query, local);
    });
    expect(results.find((r: { id: string }) => r.id === "migrations_match")).toMatchObject({ ok: false, items: [`not applied: ${last.file}`] });
  });

  it("applies a migration and its history row together, or neither", async () => {
    const fake = { version: "20991231000000", name: "staging_probe", file: "20991231000000_staging_probe.sql", sql: "create table public.staging_probe (id int);" };
    await withRollback(async (query) => {
      await query(migrationRequest(fake));
      expect(await query("select name from supabase_migrations.schema_migrations where version = '20991231000000'")).toEqual([{ name: "staging_probe" }]);
    });
    const broken = { ...fake, sql: "create table public.staging_probe (id int); select 1/0;" };
    await expect(db.query(migrationRequest(broken))).rejects.toThrow(/division by zero/);
    expect((await db.query("select to_regclass('public.staging_probe') as t")).rows[0].t).toBeNull();
    expect((await db.query("select count(*)::int as n from supabase_migrations.schema_migrations where version = '20991231000000'")).rows[0].n).toBe(0);
  });
});
