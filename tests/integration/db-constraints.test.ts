import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { candidate, db, emailCandidate, resetSalesData, rpc, verifiedRun } from "./helpers";

// Hard rules enforced by the database itself (docs/MVP_SPEC.md §3, §5).

async function persisted(c: Record<string, unknown>) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ stage: string; prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  expect(r.stage).toBe("outreach_ready");
  return r.prospect_id;
}

async function insertProspect(fields: Record<string, unknown>) {
  const base = {
    name: "店",
    normalized_name: `店${randomUUID()}`,
    address: "愛知県名古屋市中区1-1",
    normalized_address: "愛知県名古屋市中区1-1",
    category: "cafe",
    website_status: "unknown",
    ...fields,
  };
  const cols = Object.keys(base);
  return db.query(
    `insert into public.sales_prospects (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
    Object.values(base),
  );
}

beforeEach(resetSalesData);
afterAll(resetSalesData);

describe("prospect constraints", () => {
  it("accepts Nagoya only, checking the raw address too", async () => {
    await expect(insertProspect({ normalized_address: "愛知県豊田市1-1", address: "愛知県豊田市1-1" })).rejects.toThrow(/nagoya/);
    await expect(insertProspect({ address: "東京都港区1-1", normalized_address: "愛知県名古屋市中区1-1" })).rejects.toThrow(/nagoya/);
  });

  it("derives dedupe keys from the stored URLs", async () => {
    await expect(
      insertProspect({ website_status: "present", website_url: "https://www.shop.example.com/", website_domain: "other.example.com" }),
    ).rejects.toThrow(/website_domain/);
    await expect(
      insertProspect({ instagram_url: "https://www.instagram.com/aaa/", instagram_handle: "bbb" }),
    ).rejects.toThrow(/instagram_pair/);
    await insertProspect({ website_status: "present", website_url: "https://www.shop.example.com/about", website_domain: "shop.example.com" });
  });

  it.each([
    ["domain", { website_status: "present", website_url: "https://same.example.com/", website_domain: "same.example.com" }],
    ["instagram handle", { instagram_url: "https://www.instagram.com/same_handle/", instagram_handle: "same_handle" }],
  ])("keeps one prospect per %s", async (_label, fields) => {
    await insertProspect(fields);
    await expect(insertProspect(fields)).rejects.toThrow(/duplicate key/);
  });

  it("rejects categories outside bakery / baked_goods / cafe", async () => {
    await expect(insertProspect({ category: "salon" })).rejects.toThrow();
  });

  it("never allows Instagram for an unknown website status", async () => {
    await expect(
      insertProspect({
        website_status: "unknown",
        instagram_url: "https://www.instagram.com/x/",
        instagram_handle: "x",
        recommended_channel: "instagram",
      }),
    ).rejects.toThrow(/channel_instagram/);
  });

  it("never allows Instagram when an official site exists", async () => {
    await expect(
      insertProspect({
        website_status: "present",
        website_url: "https://shop.example.com/",
        website_domain: "shop.example.com",
        instagram_url: "https://www.instagram.com/y/",
        instagram_handle: "y",
        recommended_channel: "instagram",
      }),
    ).rejects.toThrow(/channel_instagram/);
  });

  it("requires first-party provenance for a public email", async () => {
    await expect(insertProspect({ public_email: "info@shop.example.com" })).rejects.toThrow(/email_provenance_missing/);
  });

  it("rejects unsafe URL schemes", async () => {
    await expect(
      insertProspect({ website_status: "present", website_url: "javascript:alert(1)", website_domain: "x" }),
    ).rejects.toThrow();
  });

  it("keeps one prospect per normalized name + address, domain, handle and email", async () => {
    await insertProspect({ normalized_name: "同じ店", normalized_address: "愛知県名古屋市西区1" });
    await expect(insertProspect({ normalized_name: "同じ店", normalized_address: "愛知県名古屋市西区1" })).rejects.toThrow(/duplicate key/);
  });
});

describe("outreach constraints and state machine", () => {
  it("allows one initial outreach per prospect", async () => {
    const id = await persisted(candidate());
    await expect(
      db.query("insert into public.sales_outreaches (prospect_id, kind, channel, body) values ($1,'initial','instagram','x')", [id]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("refuses outreach for a DNC shop, including marking it sent", async () => {
    const id = await persisted(emailCandidate());
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [id]);
    await expect(
      db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where prospect_id = $1", [id]),
    ).rejects.toThrow(/do_not_contact/);
  });

  it("follows drafted → sent → replied → meeting → won and rejects skips", async () => {
    const id = await persisted(emailCandidate());
    const set = (sql: string) => db.query(`update public.sales_outreaches set ${sql} where prospect_id = $1`, [id]);
    await expect(set("status = 'meeting', sent_at = now()")).rejects.toThrow(/invalid_transition/);
    await set("status = 'sent', sent_at = now()");
    await set("status = 'replied', reply_type = 'interested', replied_at = now()");
    await set("status = 'meeting', meeting_at = now()");
    await expect(set("status = 'won', closed_at = now()")).rejects.toThrow(/won_amount/);
    await set("status = 'won', closed_at = now(), won_amount_jpy = 150000");
    await expect(set("status = 'lost'")).rejects.toThrow(/invalid_transition/);
  });

  it("lets an unsent draft be closed as lost without a sent_at", async () => {
    const id = await persisted(candidate());
    await db.query("update public.sales_outreaches set status = 'lost', closed_at = now() where prospect_id = $1", [id]);
  });

  it("requires a reply type for replied", async () => {
    const id = await persisted(emailCandidate());
    await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where prospect_id = $1", [id]);
    await expect(db.query("update public.sales_outreaches set status = 'replied' where prospect_id = $1", [id])).rejects.toThrow(/reply/);
  });

  it("re-checks channel eligibility when marking sent", async () => {
    const id = await persisted(emailCandidate());
    await db.query("delete from public.sales_sources where prospect_id = $1 and field = 'email'", [id]);
    await expect(
      db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where prospect_id = $1", [id]),
    ).rejects.toThrow(/email_not_eligible/);
  });

  it("rejects a won amount on anything but won", async () => {
    const id = await persisted(emailCandidate());
    await expect(db.query("update public.sales_outreaches set won_amount_jpy = 1 where prospect_id = $1", [id])).rejects.toThrow(/won_amount/);
  });

  it("only allows email follow-ups", async () => {
    const id = await persisted(candidate());
    await expect(
      db.query("insert into public.sales_outreaches (prospect_id, kind, channel, body) values ($1,'follow_up','instagram','x')", [id]),
    ).rejects.toThrow();
  });
});

describe("demos and runs", () => {
  it("creates one unsent demo per prospect with a 256-bit token and no expiry", async () => {
    const id = await persisted(candidate());
    const { rows } = await db.query("select public_token, expires_at from public.sales_demos where prospect_id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].public_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows[0].expires_at).toBeNull();
  });

  it("rejects a checkpoint larger than 64KB", async () => {
    const runId = randomUUID();
    await rpc("sales_run_start", { p_run_id: runId });
    await expect(
      db.query("update public.sales_agent_runs set checkpoint = jsonb_build_object('x', repeat(md5(random()::text), 4000)) where run_id = $1", [runId]),
    ).rejects.toThrow(/checkpoint_check/);
  });

  it("keeps status and phase consistent", async () => {
    const runId = randomUUID();
    await rpc("sales_run_start", { p_run_id: runId });
    await expect(db.query("update public.sales_agent_runs set status = 'completed', finished_at = now() where run_id = $1", [runId])).rejects.toThrow(/completed_phase/);
  });
});
