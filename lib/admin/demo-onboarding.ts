import "server-only";
/**
 * DEV-263h (Issue #263, runbook B-2): the owner creates (or replaces) a prospect's demo content from the shop's confirmed
 * facts pack on the admin screen, and registers the same bytes in the facts store — one database transaction.
 *
 *   previewDemoFromFacts — the pasted JSON checked on the server (FactsPack, strict mapping, values as written) against
 *     the prospect and its current demo (planFactsOnboarding): what would happen (create / replace a legacy demo's
 *     content / replace older facts of the same shop / unchanged) and the facts. Writes nothing.
 *   submitDemoFromFacts — the same checks again on the same bytes (their sha256 must be the one the preview showed); a
 *     replacement needs the owner's explicit confirmation; then sales_create_demo_from_facts under the admin's OWN
 *     session (the database checks the admin, DNC / the exclusion list, the shop, the demo's state and derives the
 *     content itself).
 *
 * Both: the quality-review write flag first (SALES_DEMO_QUALITY_REVIEW_ENABLED with the preview flag; off → refused,
 * nothing read or written) — the action has already checked the admin (requireAdmin). Values holding an email address
 * are never shown.
 */
import { z } from "zod";
import { FACTS_PACK_MAX_CHARS, FACTS_PACK_REFUSAL_LABEL } from "@/lib/admin/demo-facts-pack";
import { containsEmail, DEMO_VERSION_ERROR_LABEL, HIDDEN_EMAIL_LABEL, QUALITY_REVIEW_DISABLED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import { demoQualityReviewEnabled, type Env } from "@/lib/sales/demo-version/flags";
import { createDemoFromFactsAsAdmin, FactsOnboardingError, planFactsOnboarding, type OnboardingAction, type OnboardingDemoState, type OnboardingIdentity } from "@/lib/sales/facts-onboarding";
import type { createAuthClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createAuthClient>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DemoFromFactsInput = z.strictObject({ prospectId: z.string().regex(UUID), factsPack: z.string().min(2).max(FACTS_PACK_MAX_CHARS) });
export const DemoFromFactsConfirm = DemoFromFactsInput.extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/), replaceContent: z.boolean(), identityConfirmed: z.boolean() });

/** Why the demo is not created from these facts, in the owner's words. */
export const DEMO_FROM_FACTS_REFUSAL_LABEL: Readonly<Record<string, string>> = {
  ...FACTS_PACK_REFUSAL_LABEL,
  TRUSTED_FACTS_VALUE_UNTRIMMED: "前後に空白のある値があります。空白を取り除いた facts pack を貼ってください。",
  invalid_facts_pack: "facts pack の形が正しくありません（shop_facts_pack_v1、対応する key だけ）。",
  facts_pack_value_untrimmed: "前後に空白のある値があります。",
  facts_pack_duplicate_key: FACTS_PACK_REFUSAL_LABEL.TRUSTED_FACTS_DUPLICATE_KEY!,
  facts_pack_unmapped_key: FACTS_PACK_REFUSAL_LABEL.TRUSTED_FACTS_UNMAPPED_KEY!,
  facts_pack_incomplete: FACTS_PACK_REFUSAL_LABEL.TRUSTED_FACTS_INCOMPLETE!,
  facts_pack_unsafe_text: "値に使えない文字（制御文字・<<<・>>>・タグ）があります。",
  facts_onboarding_identity_unconfirmed: "facts pack の店名・住所が候補の登録と違います。同じ店であることを確かめ、確認の印を付けてください。",
  facts_onboarding_do_not_contact: "この候補は連絡しない（DNC）に設定されています。デモを作れません。",
  facts_onboarding_excluded: "この候補は除外リストに該当します。デモを作れません。",
  facts_onboarding_rin: "輪（SR-001）のデモには使えません。",
  facts_onboarding_shop_other_prospect: "同じ shop_id の店が別の候補に登録されています（重複）。",
  facts_onboarding_shop_changed: "このデモは別の shop_id の事実から作られています。別の店の事実では置き換えられません。",
  facts_onboarding_demo_in_use: "このデモは送信の承認済み・送信済み、または共有中です。内容を置き換えられません。",
  facts_onboarding_replace_unconfirmed: "今のデモの内容を置き換えることを確認してください。",
  facts_cli_registration_disabled: "CLI からの登録は無効です。",
  demo_unavailable: "このデモは無効化されています。",
  design_pending: "デザインの処理中です。終わってからやり直してください。",
};

export type DemoFromFactsFact = { id: string; key: string; value: string };
export type DemoFromFactsPreview =
  | { ok: true; action: OnboardingAction; needsConfirm: boolean; identity: OnboardingIdentity; sha256: string; shopId: string; facts: DemoFromFactsFact[] }
  | { ok: false; error: string; code?: string; facts?: DemoFromFactsFact[] };
export type DemoFromFactsResult = { ok: true; demoCreated: boolean; contentChanged: boolean; replayed: boolean; sha256: string } | { ok: false; error: string; code?: string };

const shown = (facts: DemoFromFactsFact[]): DemoFromFactsFact[] => facts.map((f) => (containsEmail(f.value) ? { ...f, value: HIDDEN_EMAIL_LABEL } : f));
/** PR #271 L4: only known codes reach the owner; anything else (a raw database error) is one generic message. */
const UNEXPECTED = "作れませんでした（予期しない誤り）。画面を再読み込みしてから、もう一度試してください。";
const known = (code: string) => (Object.hasOwn(DEMO_FROM_FACTS_REFUSAL_LABEL, code) ? code : "unexpected");
const refusal = (code: string) => (Object.hasOwn(DEMO_FROM_FACTS_REFUSAL_LABEL, code) ? DEMO_FROM_FACTS_REFUSAL_LABEL[code]! : UNEXPECTED);
const LOAD_ERROR = "候補またはデモを読み込めませんでした。画面を再読み込みしてください。";

/** The prospect and its demo as the admin's session reads them (RLS: admins only), or not_found / error. */
async function stateOf(client: Client, prospectId: string, shopId: string | null): Promise<{ kind: "ok"; state: OnboardingDemoState } | { kind: "not_found" } | { kind: "error" }> {
  const p = await client.from("sales_prospects").select("id, name, address, do_not_contact").eq("id", prospectId).maybeSingle();
  if (p.error) return { kind: "error" };
  const prospect = p.data as { id?: unknown; name?: unknown; address?: unknown; do_not_contact?: unknown } | null;
  if (typeof prospect?.id !== "string") return { kind: "not_found" };
  const d = await client.from("sales_demos").select("id, content, expires_at, disabled_at, design_status").eq("prospect_id", prospectId).maybeSingle();
  if (d.error) return { kind: "error" };
  const a = await client.from("sales_outreach_approvals").select("id").eq("prospect_id", prospectId).in("state", ["approved", "send_opened", "sent"]).limit(1);
  if (a.error) return { kind: "error" };
  // the duplicate check: another prospect already carries this shop id (unknown on a read failure; the database decides)
  let other: boolean | null = null;
  if (shopId) {
    const od = await client.from("sales_demos").select("id").eq("content->>facts_pack", shopId).neq("prospect_id", prospectId).limit(1);
    const of = await client.from("sales_demo_facts_packs").select("id").eq("shop_id", shopId).neq("prospect_id", prospectId).limit(1);
    other = od.error || of.error ? null : (od.data?.length ?? 0) + (of.data?.length ?? 0) > 0;
  }
  const demo = d.data as { content: unknown; expires_at: string | null; disabled_at: string | null; design_status: string | null } | null;
  return {
    kind: "ok",
    state: {
      doNotContact: prospect.do_not_contact === true,
      prospect: { name: typeof prospect.name === "string" ? prospect.name : "", address: typeof prospect.address === "string" ? prospect.address : "" },
      approvalInFlight: (a.data?.length ?? 0) > 0,
      shopOnOtherProspect: other,
      demo: demo ? { content: demo.content, expiresAt: demo.expires_at, disabledAt: demo.disabled_at, designStatus: demo.design_status } : null,
    },
  };
}

const shopIdOf = (text: string): string | null => {
  try {
    const v = (JSON.parse(text) as { shop_id?: unknown }).shop_id;
    return typeof v === "string" && /^[a-z0-9][a-z0-9_-]{1,40}$/.test(v) ? v : null;
  } catch {
    return null;
  }
};

export async function previewDemoFromFacts(raw: unknown, o: { env: Env; client: Client }): Promise<DemoFromFactsPreview> {
  if (!demoQualityReviewEnabled(o.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  const parsed = DemoFromFactsInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.invalid_input! };
  const st = await stateOf(o.client, parsed.data.prospectId, shopIdOf(parsed.data.factsPack));
  if (st.kind === "error") return { ok: false, error: LOAD_ERROR };
  if (st.kind === "not_found") return { ok: false, error: DEMO_VERSION_ERROR_LABEL.not_found! };
  const plan = planFactsOnboarding(parsed.data.factsPack, st.state);
  if (!plan.ok) return { ok: false, error: refusal(plan.code), code: known(plan.code), facts: shown(plan.facts) };
  const identity = { ...plan.identity, packName: containsEmail(plan.identity.packName) ? HIDDEN_EMAIL_LABEL : plan.identity.packName, packAddress: containsEmail(plan.identity.packAddress) ? HIDDEN_EMAIL_LABEL : plan.identity.packAddress };
  return { ok: true, action: plan.action, needsConfirm: plan.needsConfirm, identity, sha256: plan.sha256, shopId: plan.shopId, facts: shown(plan.facts) };
}

export async function submitDemoFromFacts(raw: unknown, o: { env: Env; client: Client }): Promise<DemoFromFactsResult> {
  if (!demoQualityReviewEnabled(o.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  const parsed = DemoFromFactsConfirm.safeParse(raw);
  if (!parsed.success) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.invalid_input! };
  const st = await stateOf(o.client, parsed.data.prospectId, shopIdOf(parsed.data.factsPack));
  if (st.kind === "error") return { ok: false, error: LOAD_ERROR };
  if (st.kind === "not_found") return { ok: false, error: DEMO_VERSION_ERROR_LABEL.not_found! };
  const plan = planFactsOnboarding(parsed.data.factsPack, st.state);
  if (!plan.ok) return { ok: false, error: refusal(plan.code), code: known(plan.code) };
  if (plan.sha256 !== parsed.data.sha256) return { ok: false, error: refusal("FACTS_PACK_STALE"), code: "FACTS_PACK_STALE" };
  // PR #271 L3: the pack's name / address differ from the prospect row: only with the owner's explicit confirmation
  if (plan.identity.mismatch && !parsed.data.identityConfirmed)
    return { ok: false, error: refusal("facts_onboarding_identity_unconfirmed"), code: "facts_onboarding_identity_unconfirmed" };
  if (plan.needsConfirm && !parsed.data.replaceContent) return { ok: false, error: refusal("facts_onboarding_replace_unconfirmed"), code: "facts_onboarding_replace_unconfirmed" };
  try {
    const r = await createDemoFromFactsAsAdmin(o.client as never, { prospectId: parsed.data.prospectId, factsPack: parsed.data.factsPack, replaceContent: plan.needsConfirm && parsed.data.replaceContent });
    return { ok: true, demoCreated: r.demo_created, contentChanged: r.content_changed, replayed: r.replayed, sha256: r.facts_sha256 };
  } catch (e) {
    const code = known(e instanceof FactsOnboardingError ? e.code : "unexpected");
    return { ok: false, error: refusal(code), code };
  }
}

/**
 * The demo page for a prospect that has NO demo yet (loadDemoVersionsPage says not_found): the prospect as the admin's
 * session reads it, so the page can offer only デモの事実を facts pack から作る. null when the prospect does not exist
 * or already has a demo (or on a read failure).
 */
export async function loadNoDemoProspect(client: Client, prospectId: string): Promise<{ prospectId: string; shopName: string | null } | null> {
  if (!UUID.test(prospectId)) return null;
  const p = await client.from("sales_prospects").select("id, name").eq("id", prospectId).maybeSingle();
  const row = p.data as { id?: unknown; name?: unknown } | null;
  if (p.error || typeof row?.id !== "string") return null;
  const d = await client.from("sales_demos").select("id").eq("prospect_id", prospectId).maybeSingle();
  if (d.error || d.data) return null;
  return { prospectId: row.id, shopName: typeof row.name === "string" ? row.name : null };
}

/** Which onboarding panel a demo's content calls for: derived from a facts pack (content.facts_pack_sha256) or legacy. */
export const onboardingTargetOf = (content: unknown): "legacy" | "facts" =>
  content && typeof content === "object" && !Array.isArray(content) && typeof (content as Record<string, unknown>).facts_pack_sha256 === "string" ? "facts" : "legacy";
