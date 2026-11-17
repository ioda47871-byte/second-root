/**
 * DEV-139 P0: read-only join from one ingested sales prospect to the owner's
 * CURRENT registered facts pack. This is a *preflight*, never a DB approval:
 * no guess from ingest summaries is silently promoted to a verified fact.
 *
 * The caller supplies an existing signed-in admin Supabase client (call it only from a server path that has
 * already confirmed the sales admin; a service-role client would bypass RLS). RLS and
 * database authorization stay intact. No flags, service-role creation, DB
 * writes, timers, Codex calls, imports, uploads, or sends.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { assertDemoContentFromFacts, factsPackSha256 } from "@/lib/demo-version-package/facts-content";
import { LocalInputError } from "@/lib/demo-version-package/local-input-error";
import { exclusionRowsFor } from "@/lib/admin/today";
import { emailDigest } from "@/lib/sales/email-digest";
import { matchExclusions, storedEmails, type ExclusionKeys, type SourceRow } from "@/lib/sales/evidence";
import { FactsStoreError, factsPackBytes, loadCurrentFactsPack } from "@/lib/sales/facts-store";

export class GenerationFactsStop extends Error {
  constructor(public readonly code: string) { super(code); this.name = "GenerationFactsStop"; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VerifiedGenerationFacts = {
  prospectId: string;
  demoId: string;
  factsPackId: string;
  shopId: string;
  factsSha256: string;
  /** Private bytes: pass directly into the existing design/copy QA; never write to the public repository. */
  factsBytes: Uint8Array;
};

/**
 * Fails CLOSED until:
 * - the prospect exists, is not DNC, and is not on the admin's exclusion list (the same four keys the send gate
 *   sales_prospect_excluded compares; an unreadable list stops too);
 * - the demo exists and uses the exact facts store bytes;
 * - the store's current SHA and shop ID agree with those bytes and its demo ID;
 * - the registry identity and the owner's facts identify the same shop exactly.
 *
 * The identity rule is intentionally stricter than the interactive onboarding
 * UI. If an owner has approved a name/address discrepancy, it still needs
 * explicit human handling before unattended generation.
 */
export async function loadVerifiedGenerationFacts(client: SupabaseClient, prospectId: string, now: Date = new Date()): Promise<VerifiedGenerationFacts> {
  if (!UUID.test(prospectId)) throw new GenerationFactsStop("PROSPECT_ID_INVALID");
  const p = await client.from("sales_prospects")
    .select("id, name, address, do_not_contact, instagram_handle, website_domain, public_email, normalized_name, normalized_address, sources:sales_sources(field, value)")
    .eq("id", prospectId).maybeSingle();
  if (p.error || !p.data) throw new GenerationFactsStop("PROSPECT_NOT_AVAILABLE");
  const prospect = p.data as {
    id: string; name: unknown; address: unknown; do_not_contact: unknown;
    instagram_handle: string | null; website_domain: string | null; public_email: string | null;
    normalized_name: string | null; normalized_address: string | null; sources: SourceRow[] | null;
  };
  if (prospect.id !== prospectId) throw new GenerationFactsStop("PROSPECT_NOT_AVAILABLE");
  if (prospect.do_not_contact !== false) throw new GenerationFactsStop("PROSPECT_DNC_OR_UNKNOWN");
  // PR #280 review M1: an excluded shop (existing customer / partner) is never prepared for sales.
  const keys: ExclusionKeys = {
    instagramHandle: prospect.instagram_handle ?? null,
    websiteDomain: prospect.website_domain ?? null,
    emailDigests: storedEmails(prospect.public_email ?? null, Array.isArray(prospect.sources) ? prospect.sources : null).map(emailDigest),
    normalizedName: prospect.normalized_name ?? null,
    normalizedAddress: prospect.normalized_address ?? null,
  };
  if (matchExclusions(keys, await exclusionRowsFor(client, keys)).state !== "clear")
    throw new GenerationFactsStop("PROSPECT_EXCLUDED_OR_UNKNOWN");

  const d = await client.from("sales_demos").select("id, prospect_id, content, disabled_at, expires_at").eq("prospect_id", prospectId).maybeSingle();
  if (d.error || !d.data) throw new GenerationFactsStop("DEMO_NOT_AVAILABLE");
  const demo = d.data as { id: string; prospect_id: string; content: unknown; disabled_at: string | null; expires_at: string | null };
  // PR #280 review L4: an expired demo is not eligible either.
  const expired = demo.expires_at !== null && !(Date.parse(demo.expires_at) > now.getTime());
  if (demo.prospect_id !== prospectId || !UUID.test(demo.id) || demo.disabled_at !== null || expired)
    throw new GenerationFactsStop("DEMO_NOT_ELIGIBLE");

  let stored;
  try { stored = await loadCurrentFactsPack(client, prospectId); }
  catch (e) {
    if (e instanceof FactsStoreError) throw new GenerationFactsStop(e.code);
    throw new GenerationFactsStop("FACTS_STORE_READ_FAILED");
  }
  if (!stored) throw new GenerationFactsStop("OWNER_FACTS_MISSING");
  const factsBytes = factsPackBytes(stored.facts_pack_text);
  const hash = factsPackSha256(factsBytes);
  if (stored.facts_sha256 !== hash || stored.demo_id !== demo.id) throw new GenerationFactsStop("OWNER_FACTS_LINEAGE_MISMATCH");
  let raw: unknown;
  try { raw = JSON.parse(stored.facts_pack_text); }
  catch { throw new GenerationFactsStop("OWNER_FACTS_INVALID"); }
  const facts = FactsPack.safeParse(raw);
  if (!facts.success || facts.data.shop_id !== stored.shop_id) throw new GenerationFactsStop("OWNER_FACTS_INVALID");
  const byKey = new Map(facts.data.facts.map((f) => [f.key, f.value]));
  if (typeof prospect.name !== "string" || typeof prospect.address !== "string" ||
      prospect.name.trim() !== byKey.get("name") || prospect.address.trim() !== byKey.get("address"))
    throw new GenerationFactsStop("PROSPECT_FACTS_IDENTITY_HOLD");
  try { assertDemoContentFromFacts(demo.content, factsBytes); }
  catch (e) {
    if (e instanceof LocalInputError) throw new GenerationFactsStop(e.code);
    throw new GenerationFactsStop("DEMO_FACTS_CONTENT_MISMATCH");
  }
  return {
    prospectId, demoId: demo.id, factsPackId: stored.id, shopId: facts.data.shop_id,
    factsSha256: hash, factsBytes,
  };
}
