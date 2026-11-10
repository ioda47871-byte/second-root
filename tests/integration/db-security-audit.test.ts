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
        -- RLS would still block rows, but no write grant should exist at all.
        and has_table_privilege('authenticated', c.oid, p.privilege_type)`);
    expect(rows).toEqual([]);
  });

  it("fixes search_path on every function in the public schema", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'sales\\_%' or p.proname = 'is_sales_admin')
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(rows).toEqual([]);
  });

  it("leaves no sales function executable by PUBLIC (every migration must revoke it)", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'sales\\_%' or p.proname = 'is_sales_admin')
        and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)`);
    expect(rows).toEqual([]);
  });

  it("gives the signed-in role EXECUTE only on SECURITY DEFINER admin functions (and is_sales_admin)", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'sales\\_%' and not p.prosecdef
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')`);
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

  it("DEV-054: the rejection memory and the screening functions exist, are service-role only, and are covered above", async () => {
    const { rows: tables } = await db.query(
      "select c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'sales_rejected_candidates'",
    );
    expect(tables).toEqual([{ rls: true }]);
    const { rows } = await db.query(`
      select p.proname, p.prosecdef,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('sales_discovery_known_keys', 'sales_remember_rejections', 'sales_run_state')
      order by p.proname`);
    expect(rows).toEqual([
      { proname: "sales_discovery_known_keys", prosecdef: false, service: true, authed: false, anon: false },
      { proname: "sales_remember_rejections", prosecdef: false, service: true, authed: false, anon: false },
      { proname: "sales_run_state", prosecdef: false, service: true, authed: false, anon: false },
    ]);
  });

  it("DEV-195: the approval, draft-edit and note tables are admin-read only; the send functions are admin RPCs and the guards server-only", async () => {
    const { rows: tables } = await db.query(`
      select c.relname, c.relrowsecurity as rls,
             has_table_privilege('authenticated', c.oid, 'SELECT') as authed_read,
             has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE')
               or has_table_privilege('authenticated', c.oid, 'DELETE') as authed_write,
             has_table_privilege('anon', c.oid, 'SELECT') as anon_read,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.cmd = 'SELECT') as read_policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('sales_outreach_approvals', 'sales_outreach_draft_edits', 'sales_prospect_insights')
      order by c.relname`);
    expect(tables).toEqual(
      ["sales_outreach_approvals", "sales_outreach_draft_edits", "sales_prospect_insights"].map((relname) => ({
        relname, rls: true, authed_read: true, authed_write: false, anon_read: false, policies: 1, read_policies: 1,
      })),
    );
    const { rows } = await db.query(`
      select p.proname, p.prosecdef,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (
        'sales_update_outreach_draft', 'sales_approve_outreach', 'sales_mark_send_opened', 'sales_withdraw_approval',
        'sales_mark_sent', 'sales_set_prospect_insight',
        'sales_send_guards', 'sales_prospect_excluded', 'sales_demo_version', 'sales_outreach_recipient',
        'sales_approval_is_current', 'sales_bump_draft_version', 'sales_check_approval_write')
      order by p.proname`);
    const rpcs = ["sales_approve_outreach", "sales_mark_send_opened", "sales_mark_sent", "sales_set_prospect_insight", "sales_update_outreach_draft", "sales_withdraw_approval"];
    expect(rows).toEqual(
      rows.map((r) => r.proname).sort().map((proname) =>
        rpcs.includes(proname) ? { proname, prosecdef: true, authed: true, anon: false } : { proname, prosecdef: false, authed: false, anon: false },
      ),
    );
    expect(rows).toHaveLength(13);
    // The one-argument 送信済み (no approval) is gone.
    const { rows: markSent } = await db.query(
      "select pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'sales_mark_sent'",
    );
    expect(markSent).toEqual([{ args: "p_outreach_id uuid, p_approval_id uuid, p_design_enabled boolean" }]);
  });

  it("DEV-196c: the demo version tables are admin-read only; review / revoke are admin RPCs, the worker insert and every helper are server-only", async () => {
    const versionTables = ["sales_demo_images", "sales_demo_quality_reviews", "sales_demo_version_files", "sales_demo_versions"];
    const { rows: tables } = await db.query(`
      select c.relname, c.relrowsecurity as rls,
             has_table_privilege('authenticated', c.oid, 'SELECT') as authed_read,
             has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE')
               or has_table_privilege('authenticated', c.oid, 'DELETE') as authed_write,
             has_table_privilege('anon', c.oid, 'SELECT') as anon_read,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.cmd = 'SELECT'
                and p.roles = array['authenticated']::name[] and p.qual like '%is_sales_admin()%') as admin_read_policies,
             (select count(*)::int from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as write_triggers
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1::text[])
      order by c.relname`, [versionTables]);
    expect(tables).toEqual(
      versionTables.map((relname) => ({ relname, rls: true, authed_read: true, authed_write: false, anon_read: false, policies: 1, admin_read_policies: 1, write_triggers: 1 })),
    );
    const { rows } = await db.query(`
      select p.proname, p.prosecdef,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'sales\\_demo\\_%' or p.proname in (
        'sales_check_demo_image_write', 'sales_check_demo_version_write', 'sales_check_demo_version_file_write',
        'sales_check_quality_review_write', 'sales_check_demo_approved_version', 'sales_ingest_demo_version',
        'sales_review_demo_version', 'sales_withdraw_demo_quality_review', 'sales_revoke_demo_version',
        'sales_revoke_demo_image', 'sales_resolve_demo_share'))
      order by p.proname`);
    const rpcs = ["sales_review_demo_version", "sales_revoke_demo_image", "sales_revoke_demo_version", "sales_withdraw_demo_quality_review"];
    expect(rows).toEqual(
      rows.map((r) => r.proname).map((proname) =>
        rpcs.includes(proname)
          ? { proname, prosecdef: true, authed: true, anon: false, service: true }
          : { proname, prosecdef: false, authed: false, anon: false, service: true },
      ),
    );
    // 4 RPCs + the worker insert + the share resolver + 5 triggers + 16 sales_demo_* helpers (sales_demo_version included).
    expect(rows).toHaveLength(27);
    // The generation worker's only function is not SECURITY DEFINER and cannot run as the signed-in role.
    expect(rows.find((r) => r.proname === "sales_ingest_demo_version")).toEqual({ proname: "sales_ingest_demo_version", prosecdef: false, authed: false, anon: false, service: true });
    // Duplicate prevention lives in unique / partial unique indexes.
    const { rows: idx } = await db.query(`
      select indexname from pg_indexes where schemaname = 'public' and indexdef ilike 'create unique index%'
        and indexname in ('sales_demo_versions_one_uploading', 'sales_demo_versions_bundle_key', 'sales_demo_versions_one_approved',
                          'sales_demo_quality_reviews_one_active_approval', 'sales_demo_versions_no', 'sales_demo_versions_generation_job_id_key',
                          'sales_demo_images_sha256_key', 'sales_demo_version_files_pkey')
      order by indexname`);
    expect(idx.map((r) => r.indexname)).toEqual([
      "sales_demo_images_sha256_key", "sales_demo_quality_reviews_one_active_approval", "sales_demo_version_files_pkey",
      "sales_demo_versions_bundle_key", "sales_demo_versions_generation_job_id_key", "sales_demo_versions_no",
      "sales_demo_versions_one_approved", "sales_demo_versions_one_uploading",
    ]);
  });

  it("checks the admin first in every SECURITY DEFINER function the signed-in role can call", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'sales\\_%' and p.prosecdef
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        -- The first statement after BEGIN must be the admin check.
        and regexp_replace(p.prosrc, '--[^\\n]*', '', 'g')
            !~* '^\\s*(declare\\s.*?)?begin\\s+(perform\\s+public\\.sales_assert_admin\\(\\)|if\\s+not\\s+public\\.is_sales_admin\\(\\))'`);
    expect(rows).toEqual([]);
  });
});
