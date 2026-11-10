import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { composeInitialSend, type InitialSend } from "@/lib/admin/initial-send";

// Shared helpers for integration tests against the local Supabase stack.
// Everything here uses fictional shops and example.com addresses only.

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run via npm run test:integration`);
  return value;
}

if (process.env.SUPABASE_TEST !== "1") {
  throw new Error("Integration tests must run against the local Supabase stack (npm run test:integration)");
}

export const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
export const anonKey = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
export const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

export const db = new pg.Pool({ connectionString: env("SUPABASE_DB_URL"), max: 4 });

export function serviceClient(): SupabaseClient {
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
}

export function anonClient(): SupabaseClient {
  return createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
}

const SALES_TABLES = [
  "sales_demo_quality_reviews",
  "sales_demo_version_files",
  "sales_demo_versions",
  "sales_demo_images",
  "sales_outreach_approvals",
  "sales_outreach_draft_edits",
  "sales_prospect_insights",
  "sales_ig_sends",
  "sales_ig_drafts",
  "sales_ig_messages",
  "sales_ig_threads",
  "sales_ig_webhook_events",
  "sales_exclusions",
  "sales_rejected_candidates",
  "sales_outreaches",
  "sales_demos",
  "sales_sources",
  "sales_prospects",
  "sales_agent_runs",
  "sales_admins",
];

export async function resetSalesData(): Promise<void> {
  await db.query(`truncate ${SALES_TABLES.map((t) => `public.${t}`).join(", ")} cascade`);
  await db.query(`delete from auth.users where email like '%@test.example.com'`);
}

export async function createUser(email: string, password = "correct-horse-battery-staple"): Promise<string> {
  const { data, error } = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return data.user.id;
}

export async function signedInClient(email: string, password = "correct-horse-battery-staple"): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

export async function makeAdmin(userId: string): Promise<void> {
  await db.query("insert into public.sales_admins (user_id) values ($1)", [userId]);
}

let seq = 0;

/** A fully prepared verified candidate (snake_case, as stored in the checkpoint). */
export function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  const n = `${Date.now()}-${seq}`;
  return {
    name: `テストベーカリー${n}`,
    normalized_name: `てすとべーかりー${n}`,
    address: `愛知県名古屋市中区テスト町${seq}-1`,
    normalized_address: `愛知県名古屋市中区てすと町${seq}-1`,
    ward: "中区",
    category: "bakery",
    website_status: "not_found",
    website_url: null,
    website_domain: null,
    instagram_url: `https://www.instagram.com/test_bakery_${seq}/`,
    instagram_handle: `test_bakery_${seq}`,
    public_email: null,
    channel: "instagram",
    sources: [
      {
        field: "name",
        value: `テストベーカリー${n}`,
        source_url: `https://www.instagram.com/test_bakery_${seq}/`,
        source_type: "instagram_profile",
        verified_at: new Date().toISOString(),
      },
    ],
    demo: { template: "bakery_v1", content: { name: `テストベーカリー${n}`, category: "bakery" } },
    outreach: { subject: null, body: "テスト用の営業文です。" },
    ...overrides,
  };
}

/** Email-channel candidate with first-party provenance. */
export function emailCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = candidate();
  const handle = String(base.instagram_handle);
  const domain = `${handle.replace(/_/g, "-")}.example.com`;
  const email = `info@${domain}`;
  return {
    ...base,
    website_status: "present",
    website_url: `https://${domain}/`,
    website_domain: domain,
    instagram_url: null,
    instagram_handle: null,
    public_email: email,
    channel: "email",
    sources: [
      ...(base.sources as unknown[]),
      {
        field: "email",
        value: email,
        source_url: `https://${domain}/contact`,
        source_type: "official_contact",
        verified_at: new Date().toISOString(),
      },
    ],
    outreach: { subject: "ホームページのご提案", body: "テスト用の営業文です。" },
    ...overrides,
  };
}

export async function rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await serviceClient().rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

/** Drives a run to the verified checkpoint with the given candidates. */
export async function verifiedRun(runId: string, candidates: Record<string, Record<string, unknown>>) {
  await rpc("sales_run_start", { p_run_id: runId });
  await rpc("sales_run_checkpoint", {
    p_run_id: runId,
    p_phase: "discovered",
    p_payload: {
      candidates: Object.entries(candidates).map(([key, c]) => ({ key, name: c.name, category: c.category })),
    },
  });
  return rpc("sales_run_checkpoint", {
    p_run_id: runId,
    p_phase: "verified",
    p_payload: { order: Object.keys(candidates), candidates },
  });
}

/**
 * DEV-195: the initial message of an outreach composed exactly as the today
 * card composes it (lib/admin/initial-send.ts), from what the database holds now.
 */
export async function composedSnapshot(outreachId: string): Promise<InitialSend & { draftVersion: number }> {
  const { rows } = await db.query(
    `select o.channel, o.subject, o.body, o.draft_version, p.name, p.public_email, p.instagram_url, p.instagram_handle,
            d.public_token, d.disabled_at
       from public.sales_outreaches o join public.sales_prospects p on p.id = o.prospect_id
       left join public.sales_demos d on d.prospect_id = p.id
      where o.id = $1`,
    [outreachId],
  );
  const r = rows[0];
  const composed = composeInitialSend({
    channel: r.channel,
    shopName: r.name,
    subject: r.subject,
    body: r.body,
    publicEmail: r.public_email,
    instagramUrl: r.instagram_url,
    instagramHandle: r.instagram_handle,
    demoToken: r.disabled_at ? null : r.public_token,
  });
  if (!composed) throw new Error("cannot compose the initial message");
  return { ...composed, draftVersion: r.draft_version as number };
}

/** sales_approve_outreach with the composed snapshot (the today card's 「この内容で送信を承認」). */
export async function approve(client: SupabaseClient, outreachId: string, design = false) {
  const snap = await composedSnapshot(outreachId);
  return client.rpc("sales_approve_outreach", {
    p_outreach_id: outreachId,
    p_draft_version: snap.draftVersion,
    p_subject: snap.subject,
    p_body: snap.body,
    p_design_enabled: design,
  });
}

/**
 * The whole manual send as the admin does it: approve → open the send screen
 * → 手動で送信済み. Returns the result of sales_mark_sent.
 */
export async function approveAndMarkSent(client: SupabaseClient, outreachId: string) {
  const approved = await approve(client, outreachId);
  if (approved.error) return approved;
  const approvalId = (approved.data as { approval_id: string }).approval_id;
  const channel = (await db.query("select channel from public.sales_outreaches where id = $1", [outreachId])).rows[0].channel;
  const opened = await client.rpc("sales_mark_send_opened", {
    p_approval_id: approvalId,
    p_via: channel === "email" ? "mailto" : "instagram_profile",
    p_design_enabled: false,
  });
  if (opened.error) return opened;
  return client.rpc("sales_mark_sent", { p_outreach_id: outreachId, p_approval_id: approvalId, p_design_enabled: false });
}
