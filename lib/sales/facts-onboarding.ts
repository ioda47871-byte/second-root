/**
 * DEV-263h (Issue #263, runbook B-2): a real shop's demo content from its confirmed facts pack — the owner's onboarding
 * step. For an EXISTING prospect (created by the existing ingest with every prospect rule unchanged), one database
 * transaction (sales_create_demo_from_facts / sales_onboard_facts_demo) derives the demo content from the pack bytes,
 * creates the demo or replaces its content (the owner's explicit confirmation), and registers the same bytes in the
 * facts store (append-only). No environment is read here.
 *
 *   - planFactsOnboarding: pure. What the step would do for this pack and the prospect's current demo — the same
 *     refusals the database makes, where the caller can see them (the exclusion list is checked by the database only). Used by the admin preview and the local CLI before any write.
 *   - createDemoFromFactsAsAdmin: sales_create_demo_from_facts under the signed-in admin's own session.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalJson, factsPackSha256, onboardingDemoContent } from "@/lib/demo-version-package/facts-content";
import { LocalInputError } from "@/lib/demo-version-package/local-input-error";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";

export class FactsOnboardingError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export type OnboardingDemoState = {
  /** the prospect's do-not-contact flag */
  doNotContact: boolean;
  /** an approval in approved / send_opened / sent for this prospect */
  approvalInFlight: boolean;
  /** another prospect's demo or stored facts already carries this shop id (null: not known to the caller) */
  shopOnOtherProspect: boolean | null;
  demo: null | { content: unknown; expiresAt: string | null; disabledAt: string | null; designStatus: string | null };
};

export type OnboardingAction = "create" | "replace_legacy" | "replace_facts" | "unchanged";

export type OnboardingPlan =
  | { ok: true; action: OnboardingAction; needsConfirm: boolean; sha256: string; shopId: string; facts: { id: string; key: string; value: string }[]; content: Record<string, unknown> }
  | { ok: false; code: string; sha256: string | null; shopId: string | null; facts: { id: string; key: string; value: string }[] };

const RIN = "fictional-bicycle-repair-wa";
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** What the onboarding step would do (pure; the database decides again). */
export function planFactsOnboarding(text: string, s: OnboardingDemoState): OnboardingPlan {
  const bytes = new TextEncoder().encode(text);
  let facts: { id: string; key: string; value: string }[] = [];
  let shopId: string | null = null;
  try {
    const pack = FactsPack.parse(JSON.parse(text));
    facts = pack.facts.map((f) => ({ id: f.id, key: f.key, value: f.value }));
    shopId = pack.shop_id;
  } catch {
    return { ok: false, code: "TRUSTED_FACTS_INVALID", sha256: null, shopId: null, facts: [] };
  }
  const sha256 = factsPackSha256(bytes);
  const refuse = (code: string): OnboardingPlan => ({ ok: false, code, sha256, shopId, facts });
  let content: Record<string, unknown>;
  try {
    content = onboardingDemoContent(bytes);
  } catch (e) {
    return refuse(e instanceof LocalInputError ? e.code : "TRUSTED_FACTS_INVALID");
  }
  if (s.doNotContact) return refuse("facts_onboarding_do_not_contact");
  if (s.shopOnOtherProspect) return refuse("facts_onboarding_shop_other_prospect");
  const ok = (action: OnboardingAction): OnboardingPlan => ({ ok: true, action, needsConfirm: action === "replace_legacy" || action === "replace_facts", sha256, shopId: shopId!, facts, content });
  if (!s.demo) return ok("create");
  const cur = obj(s.demo.content);
  if (cur && canonicalJson(cur) === canonicalJson(content)) return ok("unchanged");
  if (cur?.facts_pack === RIN) return refuse("facts_onboarding_rin");
  if (cur && "facts_pack" in cur && cur.facts_pack !== shopId) return refuse("facts_onboarding_shop_changed");
  if (s.demo.disabledAt !== null) return refuse("demo_unavailable");
  if (s.demo.expiresAt !== null || s.approvalInFlight) return refuse("facts_onboarding_demo_in_use");
  if (s.demo.designStatus === "pending" || s.demo.designStatus === "processing") return refuse("design_pending");
  return ok(typeof cur?.facts_pack_sha256 === "string" ? "replace_facts" : "replace_legacy");
}

export type OnboardedDemo = {
  prospect_id: string;
  demo_id: string;
  demo_created: boolean;
  content_changed: boolean;
  facts_pack_id: string;
  facts_sha256: string;
  shop_id: string;
  replayed: boolean;
};

/** デモの事実を facts pack から作る as the signed-in sales admin (the database checks the admin first). */
export async function createDemoFromFactsAsAdmin(client: SupabaseClient, a: { prospectId: string; factsPack: string; replaceContent: boolean }): Promise<OnboardedDemo> {
  const { data, error } = await client.rpc("sales_create_demo_from_facts", { p_prospect_id: a.prospectId, p_facts_pack: a.factsPack, p_replace_content: a.replaceContent });
  if (error || !data) throw new FactsOnboardingError((error?.message ?? "no_result").split(":")[0]!.trim());
  return data as OnboardedDemo;
}
