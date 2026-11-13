/**
 * DEV-263f (Issue #263, runbook B-2): the shop's facts store (sales_demo_facts_packs, append-only) — the hosted facts
 * path. Reads and registrations with whatever Supabase client the caller has; no environment is read here.
 *
 *   - loadCurrentFactsPack: the newest stored facts pack of a prospect (its CURRENT facts), or null.
 *   - registerFactsPackAsAdmin: sales_register_facts_pack under the signed-in admin's own session (the admin screen).
 *   - registerFactsPackAsOperator: sales_register_facts_pack_as (service role only) with an explicit admin identity
 *     (the registration / import CLI). Never called by the generator or the package importer.
 *   - checkFactsPackForDemo: before a registration, the pack must parse as a FactsPack, map to the demo content and be
 *     exactly what the demo's sales_demos.content was derived from (assertDemoContentFromFacts). The database checks the
 *     sha256 and the shop again; it cannot re-run the derivation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { assertDemoContentFromFacts, factsPackSha256 } from "@/lib/demo-version-package/facts-content";
import { LocalInputError } from "@/lib/demo-version-package/local-input-error";

export class FactsStoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoredFactsPack = { id: string; seq: number; demo_id: string; shop_id: string; facts_sha256: string; facts_pack_text: string; recorded_at: string; recorded_via: string };
export const FACTS_PACK_COLUMNS = "id, seq, demo_id, shop_id, facts_sha256, facts_pack_text, recorded_at, recorded_via";

/** The prospect's current stored facts pack (the newest row), or null. Throws FactsStoreError on a read failure. */
export async function loadCurrentFactsPack(client: SupabaseClient, prospectId: string): Promise<StoredFactsPack | null> {
  if (!UUID.test(prospectId)) throw new FactsStoreError("FACTS_STORE_PROSPECT_INVALID");
  const { data, error } = await client.from("sales_demo_facts_packs").select(FACTS_PACK_COLUMNS).eq("prospect_id", prospectId).order("seq", { ascending: false }).limit(1);
  if (error || !Array.isArray(data)) throw new FactsStoreError("FACTS_STORE_READ_FAILED");
  const row = data[0] as StoredFactsPack | undefined;
  return row ? { ...row, seq: Number(row.seq) } : null;
}

export type RegisteredFactsPack = { facts_pack_id: string; facts_sha256: string; shop_id: string; replayed: boolean };

const registered = (data: unknown, error: { message?: string } | null): RegisteredFactsPack => {
  if (error || !data) throw new FactsStoreError(`FACTS_REGISTER_REFUSED:${(error?.message ?? "no_result").split(":")[0]}`);
  return data as RegisteredFactsPack;
};

/** 店舗の事実を登録する as the signed-in sales admin (the database checks the admin first). */
export async function registerFactsPackAsAdmin(client: SupabaseClient, a: { demoId: string; factsPack: string }): Promise<RegisteredFactsPack> {
  const { data, error } = await client.rpc("sales_register_facts_pack", { p_demo_id: a.demoId, p_facts_pack: a.factsPack });
  return registered(data, error);
}

/** The registration CLI (service role), naming the admin who registers: that admin must be in sales_admins. */
export async function registerFactsPackAsOperator(client: SupabaseClient, a: { demoId: string; factsPack: string; adminId: string }): Promise<RegisteredFactsPack> {
  if (!UUID.test(a.adminId)) throw new FactsStoreError("FACTS_ADMIN_INVALID");
  const { data, error } = await client.rpc("sales_register_facts_pack_as", { p_demo_id: a.demoId, p_facts_pack: a.factsPack, p_admin_id: a.adminId });
  return registered(data, error);
}

export type FactsPackCheck =
  | { ok: true; sha256: string; shopId: string; facts: { id: string; key: string; value: string }[] }
  | { ok: false; code: string; sha256: string | null; shopId: string | null; facts: { id: string; key: string; value: string }[] };

/** The text as UTF-8 bytes, exactly (what the database hashes). */
export const factsPackBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * May these facts pack bytes be registered for this demo? The FactsPack schema, then the demo's content must be
 * derived from exactly these bytes (content.facts_pack_sha256 and the derived content). Pure.
 */
export function checkFactsPackForDemo(text: string, demoContent: unknown): FactsPackCheck {
  const bytes = factsPackBytes(text);
  let pack: FactsPack | null = null;
  try {
    pack = FactsPack.parse(JSON.parse(text));
  } catch {
    return { ok: false, code: "TRUSTED_FACTS_INVALID", sha256: null, shopId: null, facts: [] };
  }
  const sha256 = factsPackSha256(bytes);
  const facts = pack.facts.map((f) => ({ id: f.id, key: f.key, value: f.value }));
  try {
    assertDemoContentFromFacts(demoContent, bytes);
  } catch (e) {
    return { ok: false, code: e instanceof LocalInputError ? e.code : "TRUSTED_FACTS_CONTENT_MISMATCH", sha256, shopId: pack.shop_id, facts };
  }
  return { ok: true, sha256, shopId: pack.shop_id, facts };
}
