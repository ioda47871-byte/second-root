import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HOSHIGAMA_PATCH_CHECK,
  HOSHIGAMA_PATCH_FLAG,
  HOSHIGAMA_PATCH_FUNCTION_EDITS,
  HOSHIGAMA_PATCH_SQL,
  hoshigamaPatchedImageWriteFunction,
  migrationImageWriteFunction,
  S0_MARKER_CONDITIONS,
  S0_MARKERS,
} from "@/lib/demo-version-package/local-hoshigama-patch";
import { RIN_PATCH_FUNCTION_EDITS, RIN_PATCH_MIGRATION, RIN_PATCH_SQL } from "@/lib/demo-version-package/local-rin-patch";
import { RIN_PROSPECT_ID } from "@/lib/demo-version-package/seed-rin";
import { S0_DOMAIN, S0_EMAIL, S0_FACTS_PATH, S0_PROSPECT_ID, S0_SITE, s0RegistryRow, s0SeedPlan } from "@/lib/demo-version-package/seed-s0";

// DEV-139 (owner approval 2026-11-18: localhost only, the fictional test shop only, no Staging / Production): the
// LOCAL-ONLY database patch for the fictional ほし窯's AI demo photos, modelled on 輪's. Not a migration: it must stay
// outside supabase/migrations, change only the one check and the one function (the latter rebuilt here from the
// migration with the reviewed edits), name only the S0 prospect, and its command must refuse anything but a local stack
// and refuse without the owner's explicit flag. The database behaviour is proven by tests/integration/hoshigama-local-patch.test.ts.

vi.setConfig({ testTimeout: 60_000 });
const REPO = join(__dirname, "../../..");
const sql = readFileSync(join(REPO, HOSHIGAMA_PATCH_SQL), "utf8");
const migration = readFileSync(join(REPO, RIN_PATCH_MIGRATION), "utf8");
const facts = new Uint8Array(readFileSync(join(REPO, S0_FACTS_PATH)));

describe("the local ほし窯 patch is not a migration and changes only what the owner allowed", () => {
  it("lives outside supabase/migrations, beside 輪's, and no migration mentions it", () => {
    expect(HOSHIGAMA_PATCH_SQL.startsWith("supabase/")).toBe(false);
    expect(HOSHIGAMA_PATCH_SQL.split("/").slice(0, -1).join("/")).toBe(RIN_PATCH_SQL.split("/").slice(0, -1).join("/"));
    for (const f of readdirSync(join(REPO, "supabase/migrations"))) expect(readFileSync(join(REPO, "supabase/migrations", f), "utf8"), f).not.toMatch(/local-hoshigama|13900000-5e00-4d00-8a00-000000000001/);
  });

  it("its function is the migration's with exactly the reviewed edits (share exclusion, immutability and revoke unchanged)", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.sales_check_demo_image_write()"));
    expect(fn.trimEnd()).toBe(hoshigamaPatchedImageWriteFunction(migration));
    const tail = (s: string) => s.slice(s.indexOf("  if row(new.id, new.prospect_id"));
    expect(tail(fn.trimEnd())).toBe(tail(migrationImageWriteFunction(migration)));
    expect(HOSHIGAMA_PATCH_FUNCTION_EDITS).toHaveLength(3);
    // the same `create or replace` edit as 輪's; the same ai_demo_internal derivation (only the comment names DEV-139)
    expect(HOSHIGAMA_PATCH_FUNCTION_EDITS[0]).toBe(RIN_PATCH_FUNCTION_EDITS[0]);
    const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code(HOSHIGAMA_PATCH_FUNCTION_EDITS[2]!.new)).toBe(code(RIN_PATCH_FUNCTION_EDITS[2]!.new));
  });

  it("holds exactly three statements before the function: drop and re-add the same-named check, row-local to the S0 id only", () => {
    const code = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    const head = code.slice(0, code.indexOf("create or replace function")).trim();
    expect(head).toBe(HOSHIGAMA_PATCH_CHECK);
    expect(head).toBe(
      [
        "alter table public.sales_demo_images drop constraint if exists sales_demo_images_real_shop_no_ai_demo;",
        "alter table public.sales_demo_images add constraint sales_demo_images_real_shop_no_ai_demo",
        `  check ((source_kind <> 'ai_generated_demo' and rights_status <> 'ai_demo_internal') or prospect_id = '${S0_PROSPECT_ID}'::uuid);`,
      ].join("\n"),
    );
    expect(code).not.toMatch(/create table|grant |revoke |drop function|drop trigger|create trigger|alter function/i);
    // S0 only: 輪's id is not in it (this patch replaces 輪's local one; the apply command refuses while 輪 rows exist)
    expect(sql).not.toContain(RIN_PROSPECT_ID);
  });

  it("its markers are exactly the S0 seed's: the facts pack's name and address, no Instagram, contacts only on the example domain", () => {
    const row = s0RegistryRow(facts);
    expect(S0_MARKERS).toEqual({ name: row.name, normalized_name: row.normalized_name, address: row.address, normalized_address: row.normalized_address, email: row.public_email, site: row.website_url, domain: row.website_domain });
    expect([S0_MARKERS.email, S0_MARKERS.site, S0_MARKERS.domain]).toEqual([S0_EMAIL, S0_SITE, S0_DOMAIN]);
    expect(S0_DOMAIN.endsWith(".example.com")).toBe(true);
    // the seed's one source passes the source condition (email, the example address, a URL on the example site)
    const plan = s0SeedPlan(facts);
    expect([plan.source.field, plan.source.value, plan.source.source_url.startsWith(S0_SITE)]).toEqual(["email", S0_EMAIL, true]);
    expect(sql).toContain(`new.prospect_id is distinct from '${S0_PROSPECT_ID}'::uuid`);
    expect(sql).toContain(S0_MARKER_CONDITIONS);
    for (const term of [
      `p.name = '${row.name}'`,
      `p.normalized_name = '${row.normalized_name}'`,
      `p.address = '${row.address}'`,
      `p.normalized_address = '${row.normalized_address}'`,
      "p.instagram_url is null and p.instagram_handle is null",
      `(p.public_email is null or p.public_email = '${S0_EMAIL}')`,
      `(p.website_url is null or p.website_url = '${S0_SITE}')`,
      `(p.website_domain is null or p.website_domain = '${S0_DOMAIN}')`,
      "(p.recommended_channel is null or p.recommended_channel = 'email')",
      `not coalesce(s.field = 'email' and s.value = '${S0_EMAIL}' and starts_with(s.source_url, '${S0_SITE}'), false)`,
    ])
      expect(S0_MARKER_CONDITIONS).toContain(term);
  });
});

describe("apply-local-hoshigama-patch.ts refuses anything but a local stack and the owner's flag (before connecting)", () => {
  const run = (args: string[], env: Record<string, string | undefined>) => {
    const e: Record<string, string | undefined> = { ...process.env, PGHOST: undefined, PGHOSTADDR: undefined, PGSERVICE: undefined, PGSERVICEFILE: undefined, ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/sales/demo-version/apply-local-hoshigama-patch.ts"), ...args], { cwd: REPO, encoding: "utf8", env: e as NodeJS.ProcessEnv, timeout: 60_000 });
  };
  it.each([
    ["a hosted database", { SUPABASE_DB_URL: "postgresql://postgres@db.example.com:5432/postgres" }],
    ["a ?host= redirect", { SUPABASE_DB_URL: "postgresql://postgres:secret-value@127.0.0.1:54322/postgres?host=db.example.com" }],
    ["PGHOST set", { SUPABASE_DB_URL: "postgresql://postgres:secret-value@127.0.0.1:54322/postgres", PGHOST: "db.example.com" }],
    ["no URL", { SUPABASE_DB_URL: undefined }],
  ])("%s: FAIL with a DB_URL code, and nothing secret printed", (_, env) => {
    const r = run([HOSHIGAMA_PATCH_FLAG], env);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "FAIL" });
    expect(JSON.parse(r.stdout).code).toMatch(/^DB_URL_/);
    expect(r.stdout + r.stderr).not.toContain("secret-value");
    expect(r.stdout + r.stderr).not.toContain("example.com");
  });
  it("without the owner's flag: FAIL HOSHIGAMA_PATCH_FLAG_MISSING (even with a local URL)", () => {
    const r = run([], { SUPABASE_DB_URL: "postgresql://postgres:x@127.0.0.1:54322/postgres" });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ status: "FAIL", code: "HOSHIGAMA_PATCH_FLAG_MISSING" });
  });
  it("takes no other argument (exit 2)", () => {
    expect(run(["--force"], { SUPABASE_DB_URL: "postgresql://postgres:x@127.0.0.1:54322/postgres" }).status).toBe(2);
    expect(run([HOSHIGAMA_PATCH_FLAG, HOSHIGAMA_PATCH_FLAG], { SUPABASE_DB_URL: "postgresql://postgres:x@127.0.0.1:54322/postgres" }).status).toBe(2);
  });
});
