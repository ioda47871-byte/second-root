import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setLocalTestRecipients } from "../support/local-test-recipients";
import { approve, candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, serviceClient, signedInClient, verifiedRun } from "./helpers";

// DEV-263g (Issue #263, runbook B-2): the database's own test-recipient guard (sales_test_recipient_block in
// sales_send_guards) and the database owner's local switch, on the LOCAL stack. Fictional shops and example.com only;
// nothing is sent.

const MIGRATION = "supabase/migrations/20261115000100_sales_test_recipient_guard.sql";
let admin: SupabaseClient;

async function shop(c: Record<string, unknown>) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  await rpc("sales_run_finalize", { p_run_id: runId });
  if (!r.prospect_id) throw new Error(`persist: ${JSON.stringify(r)}`);
  const { rows } = await db.query("select d.id as demo_id, o.id as outreach_id from public.sales_demos d join public.sales_outreaches o on o.prospect_id = d.prospect_id and o.kind = 'initial' where d.prospect_id = $1", [r.prospect_id]);
  return { prospectId: r.prospect_id, demoId: rows[0].demo_id as string, outreachId: rows[0].outreach_id as string };
}
const fictional = (demoId: string) => db.query("update public.sales_demos set content = content || '{\"facts_pack\": \"fictional-test-shop\"}'::jsonb where id = $1", [demoId]);

beforeAll(async () => {
  await resetSalesData();
  const id = await createUser("recipient-guard-admin@test.example.com");
  await makeAdmin(id);
  admin = await signedInClient("recipient-guard-admin@test.example.com");
});
beforeEach(async () => {
  await setLocalTestRecipients(false);
  // the daily cap counts the shops persisted today: a clean slate per test
  await db.query(
    "truncate public.sales_outreach_approvals, public.sales_outreach_draft_edits, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade",
  );
});
afterEach(async () => {
  await setLocalTestRecipients(true);
});
afterAll(resetSalesData);

describe("the database refuses test recipients while the owner's switch is off", () => {
  it("a reserved email domain (example.com) is refused at approval; with the switch on it is approved", async () => {
    const s = await shop(emailCandidate());
    expect((await approve(admin, s.outreachId)).error?.message).toContain("test_recipient_reserved_domain");
    expect((await db.query("select count(*)::int as n from public.sales_outreach_approvals where outreach_id = $1", [s.outreachId])).rows[0].n).toBe(0);
    await setLocalTestRecipients(true);
    const ok = await approve(admin, s.outreachId);
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("a fictional shop is refused on every channel; a non-fictional Instagram shop is approved", async () => {
    const ig = await shop(candidate());
    const igOk = await approve(admin, ig.outreachId);
    expect(igOk.error, igOk.error?.message).toBeNull();
    const fig = await shop(candidate());
    await fictional(fig.demoId);
    expect((await approve(admin, fig.outreachId)).error?.message).toContain("test_recipient_fictional_shop");
    const fem = await shop(emailCandidate());
    await fictional(fem.demoId);
    expect((await approve(admin, fem.outreachId)).error?.message).toContain("test_recipient_fictional_shop");
  });

  it("opening the send screen is refused too (an approval made while the switch was on)", async () => {
    const s = await shop(emailCandidate());
    await setLocalTestRecipients(true);
    const a = await approve(admin, s.outreachId);
    expect(a.error, a.error?.message).toBeNull();
    await setLocalTestRecipients(false);
    const opened = await admin.rpc("sales_mark_send_opened", { p_approval_id: (a.data as { approval_id: string }).approval_id, p_via: "mailto", p_design_enabled: false });
    expect(opened.error?.message).toContain("test_recipient_reserved_domain");
  });

  it("the domain is normalised like the server's gate (NFKC, full stops, case, trailing dots; hidden characters fail closed)", async () => {
    const cases: [string | null, boolean][] = [
      ["info@shop.example.com", true],
      ["info@SHOP.EXAMPLE.ORG.", true],
      ["info@ｅｘａｍｐｌｅ．ｎｅｔ", true],
      ["info@example。com", true],
      ["info@ex‍ample.com", true],
      ["info@x.test", true],
      ["info@x.invalid", true],
      ["info@localhost", true],
      ["info@x.example", true],
      ["info@shop.co.jp", false],
      ["info@mytest.com", false],
      ["info@example.co", false],
      ["no-at-sign", false],
      [null, false],
    ];
    for (const [email, reserved] of cases) {
      expect((await db.query("select public.sales_test_email_reserved($1) as r", [email])).rows[0].r, String(email)).toBe(reserved);
    }
  });
});

describe("the owner's switch", () => {
  it("is one row, off by default; no API role reads or changes it; the helpers are the service role's only", async () => {
    const def = (await db.query("select column_default from information_schema.columns where table_name = 'sales_local_test_settings' and column_name = 'local_test_recipients_enabled'")).rows[0].column_default;
    expect(def).toBe("false");
    const svc = serviceClient();
    expect((await svc.from("sales_local_test_settings").update({ local_test_recipients_enabled: true }).eq("id", true)).error?.message).toContain("local_test_switch_owner_only");
    expect((await svc.from("sales_local_test_settings").insert({ id: true })).error).not.toBeNull();
    expect((await admin.from("sales_local_test_settings").select("*")).data ?? []).toEqual([]);
    await expect(db.query("delete from public.sales_local_test_settings")).rejects.toThrow("local_test_switch_single_row");
    for (const fn of ["sales_test_recipient_block(uuid, text)", "sales_test_email_reserved(text)", "sales_reserved_test_domain(text)"]) {
      for (const role of ["anon", "authenticated"]) expect((await db.query(`select has_function_privilege($1, 'public.${fn}', 'execute') as ok`, [role])).rows[0].ok, `${role} ${fn}`).toBe(false);
      expect((await db.query(`select has_function_privilege('service_role', 'public.${fn}', 'execute') as ok`)).rows[0].ok).toBe(true);
    }
  });
});

/** The rollback SQL of the review record, without its own begin / commit (the test owns the transaction). */
function rollbackSql(): string {
  const md = readFileSync(".ai/reviews/DEV-263g.md", "utf8");
  const block = md.slice(md.indexOf("<!-- rollback-sql:start -->"), md.indexOf("<!-- rollback-sql:end -->"));
  const sql = block.slice(block.indexOf("```sql") + "```sql".length, block.lastIndexOf("```"));
  return sql.replace(/^\s*(begin|commit);\s*$/gm, "");
}

describe("the migration's rollback", () => {
  it("rolled back and applied again inside a rolled-back transaction", async () => {
    const s = await shop(emailCandidate());
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query(rollbackSql());
      expect((await c.query("select to_regclass('public.sales_local_test_settings') as t")).rows[0].t).toBeNull();
      expect((await c.query("select count(*)::int as n from pg_proc where proname in ('sales_test_recipient_block', 'sales_test_email_reserved', 'sales_reserved_test_domain')")).rows[0].n).toBe(0);
      expect((await c.query("select prosrc from pg_proc where proname = 'sales_send_guards'")).rows[0].prosrc).not.toContain("test_recipient");
      await c.query(readFileSync(MIGRATION, "utf8"));
      expect((await c.query("select public.sales_test_recipient_block($1, 'email') as b", [s.prospectId])).rows[0].b).toBe("test_recipient_reserved_domain");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
