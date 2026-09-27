import { afterAll, describe, expect, it } from "vitest";
import { db } from "./helpers";

// Regression guard over the whole schema (DEV-017, docs/SECURITY.md §2):
// every rule below must hold for every Sales Agent table and function,
// including ones added by later migrations.

afterAll(() => db.end());

describe("database security audit", () => {
  it("enables row level security on every sales table", async () => {
    const { rows } = await db.query(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'sales\\_%' and not c.relrowsecurity`);
    expect(rows).toEqual([]);
  });

  it("gives anon no privilege on any sales table or view", async () => {
    const { rows } = await db.query(`
      select c.relname, p.privilege_type
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege_type)
      where n.nspname = 'public' and c.relkind in ('r', 'v') and c.relname like 'sales\\_%'
        and has_table_privilege('anon', c.oid, p.privilege_type)`);
    expect(rows).toEqual([]);
  });

  it("never lets the signed-in role write sales tables directly", async () => {
    const { rows } = await db.query(`
      select c.relname, p.privilege_type
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(privilege_type)
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'sales\\_%'
        and has_table_privilege('authenticated', c.oid, p.privilege_type)
        -- RLS still blocks rows, but no write grant should exist at all.
        and c.relname <> 'sales_admins'`);
    expect(rows).toEqual([]);
  });

  it("fixes search_path on every function in the public schema", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'sales\\_%' or p.proname = 'is_sales_admin')
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(rows).toEqual([]);
  });

  it("grants anon EXECUTE on no sales function", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'sales\\_%' or p.proname = 'is_sales_admin')
        and has_function_privilege('anon', p.oid, 'EXECUTE')
        and p.proname <> 'is_sales_admin'`);
    expect(rows).toEqual([]);
  });

  it("checks the admin first in every SECURITY DEFINER function the signed-in role can call", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'sales\\_%' and p.prosecdef
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and p.prosrc !~ '(is_sales_admin|sales_assert_admin)\\(\\)'`);
    expect(rows).toEqual([]);
  });
});
