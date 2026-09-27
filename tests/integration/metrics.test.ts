import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMetrics } from "@/lib/admin/history";
import { anonClient, candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, signedInClient, verifiedRun } from "./helpers";

// sales_metrics view: funnel counts by condition, admin-only.

let admin: Awaited<ReturnType<typeof signedInClient>>;
let outsider: Awaited<ReturnType<typeof signedInClient>>;

async function sent(c: Record<string, unknown>) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const { prospect_id } = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  const id = (await db.query("select id from public.sales_outreaches where prospect_id = $1", [prospect_id])).rows[0].id as string;
  await admin.rpc("sales_mark_sent", { p_outreach_id: id });
  return id;
}

beforeAll(async () => {
  await resetSalesData();
  await makeAdmin(await createUser("metrics-admin@test.example.com"));
  await createUser("metrics-outsider@test.example.com");
  admin = await signedInClient("metrics-admin@test.example.com");
  outsider = await signedInClient("metrics-outsider@test.example.com");
  // 2 Instagram (1 won 150000), 1 email (replied, lost); 1 unsent draft (not counted).
  const a = await sent(candidate());
  await admin.rpc("sales_record_reply", { p_outreach_id: a, p_reply_type: "meeting_request", p_future_contact_refused: false });
  await admin.rpc("sales_mark_meeting", { p_outreach_id: a });
  await admin.rpc("sales_mark_won", { p_outreach_id: a, p_amount_jpy: 150000 });
  await sent(candidate());
  const c = await sent(emailCandidate());
  await admin.rpc("sales_record_reply", { p_outreach_id: c, p_reply_type: "decline", p_future_contact_refused: false });
  const runId = randomUUID();
  await verifiedRun(runId, { c01: candidate() });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  await rpc("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
});
afterAll(resetSalesData);

describe("sales_metrics", () => {
  it("counts the funnel per condition for sent outreaches only", async () => {
    const rows = await loadMetrics(admin);
    const find = (d: string, v: string) => rows.find((r) => r.dimension === d && r.value === v);
    expect(find("total", "all")).toMatchObject({ sent: 3, replied: 2, meetings: 1, won: 1, wonAmountJpy: 150000 });
    expect(find("channel", "instagram")).toMatchObject({ sent: 2, replied: 1, won: 1, wonAmountJpy: 150000 });
    expect(find("channel", "email")).toMatchObject({ sent: 1, replied: 1, won: 0 });
    expect(find("website_status", "not_found")).toMatchObject({ sent: 2 });
    expect(find("website_status", "present")).toMatchObject({ sent: 1 });
    expect(find("follow_up", "no")).toMatchObject({ sent: 3 });
    expect(find("category", "bakery")).toMatchObject({ sent: 3 });
  });

  it("splits by follow-up and by demo, and meetings per condition", async () => {
    const followed = await sent(emailCandidate());
    await db.query(
      `insert into public.sales_outreaches (prospect_id, kind, channel, subject, body)
       select prospect_id, 'follow_up', 'email', 'Re: x', 'x' from public.sales_outreaches where id = $1`,
      [followed],
    );
    await db.query(
      `update public.sales_outreaches set status = 'sent', sent_at = now()
       where kind = 'follow_up' and prospect_id = (select prospect_id from public.sales_outreaches where id = $1)`,
      [followed],
    );
    const rows = await loadMetrics(admin);
    const find = (d: string, v: string) => rows.find((r) => r.dimension === d && r.value === v);
    expect(find("follow_up", "yes")).toMatchObject({ sent: 1, replied: 0 });
    expect(find("follow_up", "no")).toMatchObject({ sent: 3, meetings: 1 });
    // The follow-up is not a second send.
    expect(find("total", "all")).toMatchObject({ sent: 4 });
    expect(find("demo", "with_demo")).toMatchObject({ sent: 4 });
    expect(find("channel", "instagram")).toMatchObject({ meetings: 1 });
    expect(find("channel", "email")).toMatchObject({ meetings: 0 });
  });

  it("grants the admin read access only", async () => {
    const { rows } = await db.query(
      `select privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'sales_metrics' and grantee = 'authenticated'`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["SELECT"]);
  });

  it("shows nothing to non-admins and is closed to anon", async () => {
    const rows = await loadMetrics(outsider);
    expect(rows.find((r) => r.dimension === "total")?.sent ?? 0).toBe(0);
    const { error } = await anonClient().from("sales_metrics").select("*");
    expect(error?.code).toBe("42501");
  });
});
