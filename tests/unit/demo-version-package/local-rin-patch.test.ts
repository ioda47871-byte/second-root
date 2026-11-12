import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migrationImageWriteFunction, patchedImageWriteFunction, RIN_PATCH_FUNCTION_EDITS, RIN_PATCH_MIGRATION, RIN_PATCH_SQL, RIN_REGISTRY_NAME } from "@/lib/demo-version-package/local-rin-patch";
import { RIN_PROSPECT_ID, RIN_REGISTRY_ADDRESS, rinDemoContent, type FactsPack } from "@/lib/demo-version-package/seed-rin";

// DEV-196s (owner decision 2026-11-12): the LOCAL-ONLY database patch for the fictional 輪's AI demo photos. Not a
// migration: it must stay outside supabase/migrations, change only the one check and the one function (the latter
// rebuilt here from the migration with the reviewed edits), and its command must refuse anything but a local stack.

vi.setConfig({ testTimeout: 60_000 });
const REPO = join(__dirname, "../../..");
const sql = readFileSync(join(REPO, RIN_PATCH_SQL), "utf8");
const migration = readFileSync(join(REPO, RIN_PATCH_MIGRATION), "utf8");
const pack = JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/bicycle/facts-pack.json"), "utf8")) as FactsPack;

describe("the local 輪 patch is not a migration and changes only what the owner allowed", () => {
  it("lives outside supabase/migrations, and no migration mentions it", () => {
    expect(RIN_PATCH_SQL.startsWith("supabase/")).toBe(false);
    for (const f of readdirSync(join(REPO, "supabase/migrations"))) expect(readFileSync(join(REPO, "supabase/migrations", f), "utf8"), f).not.toMatch(/local-rin|c4d31f24-8c91-4495-8ba1-db4706f438f8/);
  });

  it("its function is the migration's with exactly the reviewed edits (share exclusion, immutability and revoke unchanged)", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.sales_check_demo_image_write()"));
    expect(fn.trimEnd()).toBe(patchedImageWriteFunction(migration));
    // the untouched parts: everything after the insert branch is byte-identical
    const tail = (s: string) => s.slice(s.indexOf("  if row(new.id, new.prospect_id"));
    expect(tail(fn.trimEnd())).toBe(tail(migrationImageWriteFunction(migration)));
    expect(RIN_PATCH_FUNCTION_EDITS).toHaveLength(3);
  });

  it("holds exactly three statements: drop and re-add the same-named check (row-local, the 輪 id), and the function", () => {
    const code = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    const head = code.slice(0, code.indexOf("create or replace function")).trim();
    expect(head).toBe(
      [
        "alter table public.sales_demo_images drop constraint if exists sales_demo_images_real_shop_no_ai_demo;",
        "alter table public.sales_demo_images add constraint sales_demo_images_real_shop_no_ai_demo",
        `  check ((source_kind <> 'ai_generated_demo' and rights_status <> 'ai_demo_internal') or prospect_id = '${RIN_PROSPECT_ID}'::uuid);`,
      ].join("\n"),
    );
    expect(code).not.toMatch(/create table|grant |revoke |drop function|drop trigger|create trigger|alter function/i);
  });

  it("its markers are the seed's (the id, the facts pack's name, the placeholder address)", () => {
    expect(rinDemoContent(pack).name).toBe(RIN_REGISTRY_NAME);
    expect(sql).toContain(`'${RIN_PROSPECT_ID}'::uuid`);
    expect(sql).toContain(`p.normalized_name = '${RIN_REGISTRY_NAME}'`);
    expect(sql).toContain(`p.normalized_address = '${RIN_REGISTRY_ADDRESS}'`);
  });
});

describe("apply-local-rin-patch.ts refuses anything but a local stack (before connecting)", () => {
  const run = (args: string[], env: Record<string, string | undefined>) => {
    const e: Record<string, string | undefined> = { ...process.env, PGHOST: undefined, PGHOSTADDR: undefined, PGSERVICE: undefined, PGSERVICEFILE: undefined, ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/sales/demo-version/apply-local-rin-patch.ts"), ...args], { cwd: REPO, encoding: "utf8", env: e as NodeJS.ProcessEnv, timeout: 60_000 });
  };
  it.each([
    ["a hosted database", { SUPABASE_DB_URL: "postgresql://postgres@db.example.com:5432/postgres" }],
    ["a ?host= redirect", { SUPABASE_DB_URL: "postgresql://postgres:secret-value@127.0.0.1:54322/postgres?host=db.example.com" }],
    ["PGHOST set", { SUPABASE_DB_URL: "postgresql://postgres:secret-value@127.0.0.1:54322/postgres", PGHOST: "db.example.com" }],
    ["no URL", { SUPABASE_DB_URL: undefined }],
  ])("%s: FAIL with a DB_URL code, and nothing secret printed", (_, env) => {
    const r = run([], env);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "FAIL" });
    expect(JSON.parse(r.stdout).code).toMatch(/^DB_URL_/);
    expect(r.stdout + r.stderr).not.toContain("secret-value");
    expect(r.stdout + r.stderr).not.toContain("example.com");
  });
  it("takes no arguments (exit 2)", () => {
    expect(run(["--force"], { SUPABASE_DB_URL: "postgresql://postgres:x@127.0.0.1:54322/postgres" }).status).toBe(2);
  });
});

describe("import-local.ts --seed-rin --seed-only (the seed before the patch)", () => {
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/sales/demo-version/import-local.ts"), ...args], { cwd: REPO, encoding: "utf8", timeout: 60_000 });
  it("needs --seed-rin and takes no package or prospect (exit 2)", () => {
    for (const args of [["--seed-only"], ["--seed-rin", "--seed-only", "--package", "/tmp/x"], ["--seed-only", "--prospect", RIN_PROSPECT_ID]]) expect(run(args).status, args.join(" ")).toBe(2);
  });
});
