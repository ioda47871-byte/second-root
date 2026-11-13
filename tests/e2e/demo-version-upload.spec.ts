import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { SENDABLE_FACTS_PATH, SENDABLE_PAGE_DIR, SENDABLE_PROSPECT_ID } from "@/lib/demo-version-package/seed-sendable";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { startFlagOnServer, type FlagOnServer } from "./support/flag-on-server";
import { DEMO_VERSIONS_BUCKET, storageStatus } from "../support/seed-demo-version";

// DEV-263i (Issue #263): 版を取り込む on the real admin screen, against the LOCAL Supabase stack only. The fictional,
// photo-less 環: seeded (import-local.ts --seed-sendable --seed-only), its v2 package built outside the repository
// (package-local.ts --copy), the owner registers its facts on the admin screen, then picks the package directory in
// 「版を取り込む」 — the browser sends begin / put / finalize to the route, and the version appears as a draft whose copy
// review came from the facts path and waits for the owner. A tampered package is refused with nothing written; the
// same package again is the same version. A second `next start` with the versions and quality-review flags ON; the
// suite's own server keeps them off (and the route answers 404 there). Needs the local storage API.

const PORT = Number(process.env.E2E_PORT ?? 3100) + 29;
const APP = `http://127.0.0.1:${PORT}`;
const USERS_KEY = "version-upload";
const REPO = process.cwd();

let on: FlagOnServer | null = null;
let db: pg.Pool;
let svc: SupabaseClient;
let storageUp = false;
let skipReason = "";
let work = "";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "one flag-on server: the desktop project runs this file");

function tsx(script: string, args: string[]) {
  const r = spawnSync("npx", ["tsx", join(REPO, script), ...args], { cwd: REPO, encoding: "utf8", env: process.env, timeout: 240_000 });
  return { status: r.status, out: `${(r.stdout ?? "").slice(0, 2000)}${(r.stderr ?? "").slice(0, 2000)}` };
}

/** Removes 環 and everything under it (database owner, triggers off) and its stored files (version prefixes only). */
async function purge() {
  const { rows } = await db.query("select v.storage_prefix from public.sales_demo_versions v join public.sales_demos d on d.id = v.demo_id where d.prospect_id = $1", [SENDABLE_PROSPECT_ID]);
  for (const r of rows) {
    const names: string[] = [];
    for (const dir of ["page", "renders"]) {
      const l = await svc.storage.from(DEMO_VERSIONS_BUCKET).list(`${r.storage_prefix}${dir}`, { limit: 1000 });
      for (const f of l.data ?? []) if (f.id) names.push(`${r.storage_prefix}${dir}/${f.name}`);
    }
    if (names.length) await svc.storage.from(DEMO_VERSIONS_BUCKET).remove(names);
  }
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    const D = "(select id from public.sales_demos where prospect_id = $1)";
    for (const sql of [
      "delete from public.sales_demo_copy_facts_checks where review_id in (select id from public.sales_demo_copy_reviews where prospect_id = $1)",
      "delete from public.sales_demo_facts_packs where prospect_id = $1",
      `delete from public.sales_demo_copy_owner_decisions where demo_id in ${D}`,
      `delete from public.sales_demo_version_copy_links where demo_id in ${D}`,
      `delete from public.sales_demo_structure_findings where demo_id in ${D}`,
      `delete from public.sales_demo_quality_reviews where demo_id in ${D}`,
      `delete from public.sales_demo_version_files where version_id in (select id from public.sales_demo_versions where demo_id in ${D})`,
      "delete from public.sales_demo_copy_reviews where prospect_id = $1",
      `delete from public.sales_demo_versions where demo_id in ${D}`,
      "delete from public.sales_demos where prospect_id = $1",
      "delete from public.sales_prospect_insights where prospect_id = $1",
      "delete from public.sales_sources where prospect_id = $1",
      "delete from public.sales_prospects where id = $1",
    ])
      await c.query(sql, [SENDABLE_PROSPECT_ID]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function login(page: Page) {
  const { admin } = usersFor(USERS_KEY);
  await page.goto(`${APP}/admin/login`);
  await page.getByLabel("メールアドレス").fill(admin.email);
  await page.getByLabel("パスワード").fill(admin.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

const versionCount = async () => (await db.query("select count(*)::int as n from public.sales_demo_versions v join public.sales_demos d on d.id = v.demo_id where d.prospect_id = $1", [SENDABLE_PROSPECT_ID])).rows[0].n as number;

test.beforeAll(async () => {
  test.setTimeout(600_000);
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 3 });
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const storage = await storageStatus();
  storageUp = storage.available;
  skipReason = storage.available ? "" : `${storage.reason} — the import stages and stores files in the private bucket; runs locally with Storage`;
  if (!storageUp) return;
  await purge();
  await ensureUsers(USERS_KEY);
  work = mkdtempSync(join(tmpdir(), "sr-263i-"));
  const p = tsx("scripts/sales/demo-version/package-local.ts", ["--out", join(work, "pkg"), "--copy", SENDABLE_PAGE_DIR, "--facts", SENDABLE_FACTS_PATH]);
  expect(p.status, p.out).toBe(0);
  on = await startFlagOnServer(PORT, randomBytes(32), { review: true });
});

test.afterAll(async () => {
  on?.stop();
  if (db && storageUp) await purge();
  if (work) rmSync(work, { recursive: true, force: true });
  if (storageUp) await removeUsers(USERS_KEY);
  await db?.end();
});

test("版を取り込む: the owner's facts first, then the package directory → a draft version waiting for the owner; a tampered package writes nothing; a replay is the same version", async ({ page, request }) => {
  test.skip(!storageUp, skipReason);
  test.setTimeout(300_000);
  const seed = tsx("scripts/sales/demo-version/import-local.ts", ["--seed-sendable", "--seed-only"]);
  expect(seed.status, seed.out).toBe(0);

  // the suite's own server keeps the flags off: the route is a 404 there
  expect((await request.post(`/admin/sales/demos/${SENDABLE_PROSPECT_ID}/import?step=begin`, { data: "{}" })).status()).toBe(404);
  // a cross-site request to the flag-on server is refused before anything (no Origin of this app)
  expect((await request.post(`${APP}/admin/sales/demos/${SENDABLE_PROSPECT_ID}/import?step=begin`, { data: "{}", headers: { origin: "https://evil.example.net" } })).status()).toBe(403);

  await login(page);
  await page.goto(`${APP}/admin/sales/demos/${SENDABLE_PROSPECT_ID}`);
  // no registered facts: the import panel is not offered
  await expect(page.locator("[data-version-import]")).toHaveCount(0);
  const facts = page.locator("[data-facts-registration]");
  await facts.locator("[data-facts-input]").fill(readFileSync(resolve(REPO, SENDABLE_FACTS_PATH), "utf8"));
  await facts.getByRole("button", { name: "内容を確認" }).click();
  await expect(facts.locator("[data-facts-preview]")).toHaveAttribute("data-facts-preview", "ok");
  await facts.getByRole("button", { name: "この事実を登録する" }).click();
  await expect(facts.locator("[data-facts-current]")).toHaveAttribute("data-facts-current", "ok");

  // a tampered copy (one byte of the copy record changed): refused by the server's check, nothing written
  const panel = page.locator("[data-version-import]");
  await expect(panel).toBeVisible();
  const bad = join(work, "bad");
  spawnSync("cp", ["-R", join(work, "pkg"), bad]);
  const rec = join(bad, "copy", "copy.json");
  writeFileSync(rec, readFileSync(rec, "utf8").replace(/\n$/, " \n"));
  await panel.locator("[data-version-import-input]").setInputFiles(bad);
  await panel.getByRole("button", { name: "版を取り込む" }).click();
  await expect(panel.locator("[data-version-import-result]")).toHaveAttribute("data-version-import-result", "error");
  await expect(panel.locator("[data-version-import-result]")).toContainText("COPY_INVALID");
  expect(await versionCount()).toBe(0);

  // the package as built: begin → put → finalize; a draft v1 whose copy came from the facts path, waiting for the owner
  await panel.locator("[data-version-import-input]").setInputFiles(join(work, "pkg"));
  await panel.getByRole("button", { name: "版を取り込む" }).click();
  await expect(panel.locator("[data-version-import-result]")).toHaveAttribute("data-version-import-result", "done");
  await expect(panel.locator("[data-version-import-result]")).toContainText("版 v1 を取り込みました");
  await expect(page.locator("[data-selected-version]")).toHaveAttribute("data-selected-version", "1");
  const copyPanel = page.locator('[data-copy-review="present"]');
  await expect(copyPanel.locator("[data-facts-from-facts-path]")).toHaveAttribute("data-facts-from-facts-path", "true");
  await expect(copyPanel.locator("[data-copy-owner-decision]")).toHaveAttribute("data-copy-owner-decision", "none");
  const v = (await db.query("select v.id, v.origin, v.status, d.approved_version_id from public.sales_demo_versions v join public.sales_demos d on d.id = v.demo_id where d.prospect_id = $1", [SENDABLE_PROSPECT_ID])).rows;
  expect(v).toEqual([{ id: expect.any(String), origin: "manual_import", status: "draft", approved_version_id: null }]);
  expect((await db.query("select public.sales_copy_send_block($1) as c", [v[0].id])).rows[0].c).toBe("demo_copy_owner_confirmation_missing");

  // the same package again: the same version (replay), nothing new
  await panel.locator("[data-version-import-input]").setInputFiles(join(work, "pkg"));
  await panel.getByRole("button", { name: "版を取り込む" }).click();
  await expect(panel.locator("[data-version-import-result]")).toContainText("すでに版 v1");
  expect(await versionCount()).toBe(1);
});
