// Staging / Production Supabase setup helpers (DEV-016, docs/STAGING.md).
//
// The Supabase CLI's `db push` needs a direct Postgres connection. Where
// only HTTPS is available (Claude Code cloud sessions), the same migrations
// are applied through the official Supabase Management API
// (`POST /v1/projects/{ref}/database/query`), one migration per request
// (a multi-statement request runs as a single transaction), and recorded
// in `supabase_migrations.schema_migrations` exactly like the CLI does, so
// `supabase migration list` / `db push` from a terminal agree afterwards.
//
// Secrets are read from environment variables only and are never printed,
// logged or written anywhere.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MANAGEMENT_API = "https://api.supabase.com";
const REF = /^[a-z]{20}$/;
const FILE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

export function assertRef(ref) {
  if (!REF.test(ref ?? "")) throw new Error("--project-ref must be a Supabase project ref (20 lowercase letters)");
  return ref;
}

/** Migrations in apply order: [{ version, name, file, sql }]. */
export function listMigrations(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  return files.map((file) => {
    const m = FILE.exec(file);
    if (!m) throw new Error(`unexpected migration file name: ${file}`);
    return { version: m[1], name: m[2], file, sql: readFileSync(join(dir, file), "utf8") };
  });
}

/**
 * Compares the repository's migrations with the ones recorded remotely.
 * Anything recorded remotely that the repository does not have, or a
 * different name for the same version, is drift: nothing is applied then.
 */
export function planMigrations(local, applied) {
  const byVersion = new Map(applied.map((r) => [r.version, r.name ?? null]));
  const localVersions = new Set(local.map((m) => m.version));
  const drift = [];
  for (const [version, name] of byVersion) {
    if (!localVersions.has(version)) drift.push(`remote has ${version}${name ? `_${name}` : ""}, the repository does not`);
  }
  for (const m of local) {
    if (byVersion.has(m.version) && byVersion.get(m.version) !== null && byVersion.get(m.version) !== m.name) {
      drift.push(`version ${m.version} is "${byVersion.get(m.version)}" remotely but "${m.name}" in the repository`);
    }
  }
  // Applying an older migration after a newer one would change the order.
  const newestApplied = [...byVersion.keys()].sort().at(-1);
  const pending = local.filter((m) => !byVersion.has(m.version));
  if (newestApplied && pending.some((m) => m.version < newestApplied)) {
    drift.push(`pending migrations are older than the newest applied one (${newestApplied})`);
  }
  return { pending, drift };
}

export const HISTORY_DDL = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);`;

/** One migration plus its history row, as one request (one transaction). */
export function migrationRequest(m) {
  if (!/^\d{14}$/.test(m.version) || !/^[a-z0-9_]+$/.test(m.name)) throw new Error(`invalid migration ${m.file}`);
  return `${m.sql}\n;\ninsert into supabase_migrations.schema_migrations (version, name) values ('${m.version}', '${m.name}');`;
}

/** A query function for the Management API. Errors never include the token. */
export function managementQuery(ref, token, fetchImpl = fetch) {
  assertRef(ref);
  if (!token || token.length < 20) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  return async (sql) => {
    const res = await fetchImpl(`${MANAGEMENT_API}/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
      redirect: "error",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Management API ${res.status}: ${redact(text, token).slice(0, 500)}`);
    return text ? JSON.parse(text) : [];
  };
}

/** GET / PATCH other Management API endpoints (auth config, API keys). */
export function managementRequest(ref, token, fetchImpl = fetch) {
  assertRef(ref);
  if (!token || token.length < 20) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  return async (method, path, body) => {
    const res = await fetchImpl(`${MANAGEMENT_API}/v1/projects/${ref}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Management API ${method} ${path} ${res.status}: ${redact(text, token).slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

export function redact(text, ...secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

/**
 * Security checks (docs/SECURITY.md §2, same rules as
 * tests/integration/db-security-audit.test.ts). Each query returns the
 * violations; a check passes when it returns no rows.
 */
export const SECURITY_CHECKS = [
  {
    id: "rls_enabled",
    title: "RLS is enabled on every sales_* table",
    sql: `select c.relname as item from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'sales\\_%' and not c.relrowsecurity`,
  },
  {
    id: "anon_no_table_access",
    title: "anon has no privilege on any sales_* table or view",
    sql: `select c.relname || ':' || p.privilege_type as item
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          cross join lateral (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege_type)
          where n.nspname = 'public' and c.relkind in ('r', 'v') and c.relname like 'sales\\_%'
            and has_table_privilege('anon', c.oid, p.privilege_type)`,
  },
  {
    id: "authenticated_no_direct_write",
    title: "signed-in users cannot write sales_* tables directly",
    sql: `select c.relname || ':' || p.privilege_type as item
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          cross join lateral (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(privilege_type)
          where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'sales\\_%'
            and has_table_privilege('authenticated', c.oid, p.privilege_type)`,
  },
  {
    id: "search_path_fixed",
    title: "every sales function fixes search_path",
    sql: `select p.proname as item from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and (p.proname like 'sales\\_%' or p.proname = 'is_sales_admin')
            and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
  },
  {
    id: "no_public_execute",
    title: "no sales function is executable by PUBLIC",
    sql: `select p.proname as item from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and (p.proname like 'sales\\_%' or p.proname = 'is_sales_admin')
            and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)`,
  },
  {
    id: "authenticated_execute_definer_only",
    title: "signed-in users execute only SECURITY DEFINER admin functions",
    sql: `select p.proname as item from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'sales\\_%' and not p.prosecdef
            and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
  },
  {
    id: "anon_no_execute",
    title: "anon executes no sales function",
    sql: `select p.proname as item from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and (p.proname like 'sales\\_%' or p.proname = 'is_sales_admin')
            and has_function_privilege('anon', p.oid, 'EXECUTE') and p.proname <> 'is_sales_admin'`,
  },
  {
    id: "admin_check_first",
    title: "every SECURITY DEFINER function callable by signed-in users checks the admin first",
    sql: `select p.proname as item from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'sales\\_%' and p.prosecdef
            and has_function_privilege('authenticated', p.oid, 'EXECUTE')
            and regexp_replace(p.prosrc, '--[^\\n]*', '', 'g')
                !~* '^\\s*(declare\\s.*?)?begin\\s+(perform\\s+public\\.sales_assert_admin\\(\\)|if\\s+not\\s+public\\.is_sales_admin\\(\\))'`,
  },
];

/** Tables the migrations create (checked for existence remotely). */
export function expectedTables(local) {
  const names = new Set();
  for (const m of local) for (const [, t] of m.sql.matchAll(/create table (?:if not exists )?public\.(sales_[a-z0-9_]+)/g)) names.add(t);
  return [...names].sort();
}

/** Runs every check; returns { ok, results: [{ id, title, ok, items }] }. */
export async function runChecks(query, local) {
  const results = [];
  const applied = await query("select version, name from supabase_migrations.schema_migrations order by version");
  const plan = planMigrations(local, applied);
  results.push({
    id: "migrations_match",
    title: "recorded migrations match supabase/migrations/",
    ok: plan.pending.length === 0 && plan.drift.length === 0 && applied.length === local.length,
    items: [...plan.pending.map((m) => `not applied: ${m.file}`), ...plan.drift],
  });
  const tables = expectedTables(local);
  const present = await query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'sales\\_%'`);
  const have = new Set(present.map((r) => r.relname));
  results.push({ id: "tables_exist", title: `all ${tables.length} sales_* tables exist`, ok: tables.every((t) => have.has(t)), items: tables.filter((t) => !have.has(t)) });
  for (const c of SECURITY_CHECKS) {
    const rows = await query(c.sql);
    results.push({ id: c.id, title: c.title, ok: rows.length === 0, items: rows.map((r) => r.item) });
  }
  return { ok: results.every((r) => r.ok), results };
}

export function formatResults(results) {
  return results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.title}${r.items.length ? `\n      ${r.items.join("\n      ")}` : ""}`).join("\n");
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else args[key] = true;
  }
  return args;
}
