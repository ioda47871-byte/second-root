import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDesignOutcomes, loadFunnel, loadMetrics } from "@/lib/admin/history";
import { periodSince, sumDesign, sumFunnel } from "@/lib/sales/funnel";
import { anonClient, candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, signedInClient, verifiedRun } from "./helpers";

// DEV-057: sales_funnel_daily / sales_design_daily — the funnel by JST
// preparation day, admin-only, consistent with sales_metrics.

let admin: Awaited<ReturnType<typeof signedInClient>>;
let outsider: Awaited<ReturnType<typeof signedInClient>>;
// Every fixture is pinned to a time relative to one fixed anchor (the start of
// the 30-day window computed once here) and every query passes that same
// `since`, so nothing depends on the clock while the file runs: crossing
// 00:00 JST mid-run changes neither the fixtures nor the expectations.
const since = periodSince("30d", new Date())!;
const windowStart = new Date(`${since}T00:00:00+09:00`);
const at = (ms: number) => new Date(windowStart.getTime() + ms).toISOString();
const DAY = 24 * 3600 * 1000;
/** Inside the window: noon JST, 10 days after its first day. */
const INSIDE = at(10 * DAY + 3 * 3600 * 1000);

/**
 * A shop prepared through the real persist path, then moved to `when` at once.
 * Nothing stays on today's date, so persist's 5-per-JST-day cap is never hit.
 */
async function prepared(c: Record<string, unknown>, when: string) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const { prospect_id } = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  await rpc("sales_run_finalize", { p_run_id: runId });
  const id = (await db.query("select id from public.sales_outreaches where prospect_id = $1", [prospect_id])).rows[0].id as string;
  await preparedAt(id, when);
  return { id, prospectId: prospect_id };
}

async function sent(c: Record<string, unknown>, when: string) {
  const o = await prepared(c, when);
  const { error } = await admin.rpc("sales_mark_sent", { p_outreach_id: o.id });
  if (error) throw error;
  return o;
}

async function ok(p: PromiseLike<{ error: unknown }>) {
  const { error } = await p;
  if (error) throw error;
}

/** Moves an outreach's preparation time (created_at is immutable for the API roles). */
async function preparedAt(outreachId: string, when: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update public.sales_outreaches set created_at = $2 where id = $1", [outreachId, when]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

async function design(prospectId: string, status: string, code: string | null) {
  await db.query("update public.sales_demos set design_status = $2, design_error_code = $3, design_updated_at = now() where prospect_id = $1", [
    prospectId,
    status,
    code,
  ]);
}

beforeAll(async () => {
  await resetSalesData();
  await makeAdmin(await createUser("funnel-admin@test.example.com"));
  await createUser("funnel-outsider@test.example.com");
  admin = await signedInClient("funnel-admin@test.example.com");
  outsider = await signedInClient("funnel-outsider@test.example.com");

  // Outside the window (全期間 only):
  await prepared(candidate(), at(-1000)); // lastOut: one second before 00:00 JST of the first day
  const old = await sent(candidate(), at(-10 * DAY)); // well before the window
  await ok(admin.rpc("sales_record_reply", { p_outreach_id: old.id, p_reply_type: "question", p_future_contact_refused: false }));

  // Inside the window:
  await prepared(candidate(), at(0)); // firstDay: exactly 00:00 JST of the first day
  const won = await sent(candidate(), INSIDE); // meeting_request → meeting → won 150000
  await ok(admin.rpc("sales_record_reply", { p_outreach_id: won.id, p_reply_type: "meeting_request", p_future_contact_refused: false }));
  await ok(admin.rpc("sales_mark_meeting", { p_outreach_id: won.id }));
  await ok(admin.rpc("sales_mark_won", { p_outreach_id: won.id, p_amount_jpy: 150000 }));
  const refused = await sent(emailCandidate(), INSIDE); // decline + DNC (closed as lost, but it was sent)
  await ok(admin.rpc("sales_record_reply", { p_outreach_id: refused.id, p_reply_type: "decline", p_future_contact_refused: true }));
  const interested = await sent(candidate(), INSIDE);
  await ok(admin.rpc("sales_record_reply", { p_outreach_id: interested.id, p_reply_type: "interested", p_future_contact_refused: false }));
  const skipped = await prepared(candidate(), INSIDE); // 見送り: lost without sending
  await ok(admin.rpc("sales_mark_lost", { p_outreach_id: skipped.id, p_reason: "今日は送らない" }));
  const unsent = await prepared(candidate(), INSIDE); // still a draft

  await design(won.prospectId, "failed", "WORKER_FAILED");
  await design(interested.prospectId, "blocked", "QUALITY_NOT_ACCEPTED");
  await design(skipped.prospectId, "blocked", "QUALITY_NOT_ACCEPTED");
  await design(unsent.prospectId, "pending", null);
  await design(old.prospectId, "blocked", "NO_VISUAL_SOURCE");
  // refused / firstDay / lastOut keep legacy demos (design_status null): not counted.
});
afterAll(resetSalesData);

describe("sales_funnel_daily", () => {
  it("全期間: every stage from the state machine columns, equal to sales_metrics' total", async () => {
    const t = sumFunnel(await loadFunnel(admin, null), null);
    expect(t).toMatchObject({ prepared: 8, skipped: 1, unsent: 3, sent: 4, replied: 4, meetings: 1, won: 1, wonAmountJpy: 150000, dnc: 1 });
    expect(t.replies).toEqual({ interested: 1, question: 1, meeting_request: 1, decline: 1, other: 0 });
    const total = (await loadMetrics(admin)).find((r) => r.dimension === "total");
    expect(total).toMatchObject({ sent: t.sent, replied: t.replied, meetings: t.meetings, won: t.won, wonAmountJpy: t.wonAmountJpy });
  });

  it("直近 30 日 (JST): includes 00:00 JST of the first day, excludes the second before", async () => {
    const days = await loadFunnel(admin, since);
    expect(days.every((d) => d.preparedOn >= since)).toBe(true);
    expect(days.map((d) => d.preparedOn)).toContain(since);
    const t = sumFunnel(days, since);
    expect(t).toMatchObject({ prepared: 6, skipped: 1, unsent: 2, sent: 3, replied: 3, meetings: 1, won: 1, wonAmountJpy: 150000, dnc: 1 });
    expect(t.replies.question).toBe(0);
  });

  it("groups by the Asia/Tokyo date of preparation", async () => {
    const { rows } = await db.query(
      `select prepared_on::text as d, prepared from public.sales_funnel_daily
       where prepared_on = $1::date or prepared_on = $1::date - 1 order by 1`,
      [since],
    );
    expect(rows).toEqual([
      { d: new Date(new Date(`${since}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10), prepared: 1 },
      { d: since, prepared: 1 },
    ]);
  });
});

describe("sales_design_daily", () => {
  it("counts the AI design results of the same cohort, by period", async () => {
    const all = sumDesign(await loadDesignOutcomes(admin, null), null);
    expect(all.total).toBe(5);
    expect(all.byStatus).toEqual({ pending: 1, processing: 0, ready: 0, blocked: 3, failed: 1 });
    expect(all.topErrors[0]).toEqual({ code: "QUALITY_NOT_ACCEPTED", count: 2 });
    const recent = sumDesign(await loadDesignOutcomes(admin, since), since);
    expect(recent.total).toBe(4);
    expect(recent.topErrors.map((e) => e.code)).toEqual(["QUALITY_NOT_ACCEPTED", "WORKER_FAILED"]);
  });
});

describe("funnel views: access", () => {
  it("are security_invoker views granted SELECT only", async () => {
    for (const view of ["sales_funnel_daily", "sales_design_daily"]) {
      const { rows } = await db.query(
        `select c.relkind, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`,
        [view],
      );
      expect(rows).toEqual([{ relkind: "v", reloptions: ["security_invoker=true"] }]);
      const grants = await db.query(
        `select grantee, privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
         order by grantee, privilege_type`,
        [view],
      );
      expect(grants.rows).toEqual([
        { grantee: "authenticated", privilege_type: "SELECT" },
        { grantee: "service_role", privilege_type: "SELECT" },
      ]);
    }
  });

  it("show nothing to a signed-in non-admin and are closed to anon", async () => {
    expect(await loadFunnel(outsider, null)).toEqual([]);
    expect(await loadDesignOutcomes(outsider, null)).toEqual([]);
    for (const view of ["sales_funnel_daily", "sales_design_daily"]) {
      const { error } = await anonClient().from(view).select("*");
      expect(error?.code).toBe("42501");
    }
  });
});
