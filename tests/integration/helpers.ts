import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

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
  "sales_ig_messages",
  "sales_ig_threads",
  "sales_ig_webhook_events",
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
