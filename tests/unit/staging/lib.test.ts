import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertRef, expectedTables, listMigrations, managementQuery, migrationRequest, parseArgs, planMigrations } from "../../../scripts/staging/lib.mjs";

// Staging setup through the Supabase Management API (DEV-016): the plan,
// the requests and token handling. No network: fetch is mocked.

const local = listMigrations(join(process.cwd(), "supabase", "migrations"));
const TOKEN = ["sbp", "test", "token", "0123456789abcdef"].join("_");

describe("migration plan", () => {
  it("reads every migration in apply order", () => {
    expect(local.length).toBeGreaterThanOrEqual(14);
    expect(local.map((m: { version: string }) => m.version)).toEqual([...local.map((m: { version: string }) => m.version)].sort());
    expect(local[0]).toMatchObject({ version: "20260927000000", name: "sales_agent_core" });
  });

  it("applies everything on an empty project and nothing once all are recorded", () => {
    expect(planMigrations(local, []).pending).toHaveLength(local.length);
    const all = local.map((m: { version: string; name: string }) => ({ version: m.version, name: m.name }));
    expect(planMigrations(local, all)).toEqual({ pending: [], drift: [] });
    expect(planMigrations(local, all.slice(0, 3)).pending.map((m: { file: string }) => m.file)).toEqual(local.slice(3).map((m: { file: string }) => m.file));
  });

  it("[fail-closed] refuses drift: unknown remote versions, renamed versions, out-of-order pending ones", () => {
    const all = local.map((m: { version: string; name: string }) => ({ version: m.version, name: m.name }));
    expect(planMigrations(local, [...all, { version: "20990101000000", name: "someone_elses" }]).drift).toHaveLength(1);
    expect(planMigrations(local, [{ version: local[0].version, name: "renamed" }]).drift).toHaveLength(1);
    expect(planMigrations(local, [all[0], all[2]]).drift.join()).toMatch(/older than the newest applied/);
  });

  it("records each migration in the same request (one transaction) as the CLI would", () => {
    const sql = migrationRequest(local[0]);
    expect(sql.startsWith(local[0].sql)).toBe(true);
    expect(sql.trimEnd().endsWith(`insert into supabase_migrations.schema_migrations (version, name) values ('${local[0].version}', '${local[0].name}');`)).toBe(true);
  });

  it("knows every sales_* table the migrations create", () => {
    expect(expectedTables(local)).toEqual(expect.arrayContaining(["sales_admins", "sales_agent_runs", "sales_prospects", "sales_outreaches", "sales_ig_threads", "sales_ig_messages", "sales_ig_drafts", "sales_ig_sends", "sales_ig_webhook_events"]));
  });
});

describe("Management API client", () => {
  it("posts SQL to the project's query endpoint with the token only in the header", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ ok: 1 }]), { status: 201 }));
    const query = managementQuery("znbqgvawublgyjwfpmei", TOKEN, fetchImpl);
    expect(await query("select 1 as ok")).toEqual([{ ok: 1 }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.supabase.com/v1/projects/znbqgvawublgyjwfpmei/database/query");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ query: "select 1 as ok" });
    expect(url).not.toContain(TOKEN);
  });

  it("[fail-closed] never shows the token in an error, even if the API echoes it", async () => {
    const fetchImpl = vi.fn(async () => new Response(`bad token ${TOKEN}`, { status: 401 }));
    const query = managementQuery("znbqgvawublgyjwfpmei", TOKEN, fetchImpl);
    const err = await query("select 1").catch((e: Error) => e);
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("refuses a malformed project ref or a missing token before any request", () => {
    expect(() => assertRef("../../v1/projects")).toThrow();
    expect(() => managementQuery("znbqgvawublgyjwfpmei", "", vi.fn())).toThrow(/SUPABASE_ACCESS_TOKEN/);
  });

  it("parses flags", () => {
    expect(parseArgs(["--project-ref", "abc", "--apply"])).toEqual({ "project-ref": "abc", apply: true });
  });
});
