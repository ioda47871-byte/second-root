import "server-only";
/**
 * DEV-263f (Issue #263, runbook B-2): the owner registers / confirms a shop's facts pack in the facts store
 * (sales_demo_facts_packs) on the admin screen.
 *
 *   previewFactsPack — the pasted JSON checked on the server: the FactsPack schema, and the demo's content must be
 *     derived from exactly these bytes (checkFactsPackForDemo). Shows the facts; writes nothing.
 *   submitFactsPack  — the same checks again on the same bytes (their sha256 must be the one the preview showed), then
 *     sales_register_facts_pack under the admin's OWN session (the database checks the admin, the sha256, the shop and
 *     the demo's content again; append-only).
 *
 * Both: the quality-review write flag first (SALES_DEMO_QUALITY_REVIEW_ENABLED with the preview flag; off → refused,
 * nothing read or written) — the action has already checked the admin (requireAdmin). Values holding an email address
 * are never shown (FactsPanel's rule).
 */
import { z } from "zod";
import { checkFactsPackForDemo, registerFactsPackAsAdmin } from "@/lib/sales/facts-store";
import { containsEmail, DEMO_VERSION_ERROR_LABEL, errorCodeOf, HIDDEN_EMAIL_LABEL, QUALITY_REVIEW_DISABLED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import { demoQualityReviewEnabled, type Env } from "@/lib/sales/demo-version/flags";
import type { createAuthClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createAuthClient>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A facts pack is small (FactsPack: at most a few hundred facts of 400 characters). */
export const FACTS_PACK_MAX_CHARS = 200_000;

export const FactsPackInput = z.strictObject({ prospectId: z.string().regex(UUID), factsPack: z.string().min(2).max(FACTS_PACK_MAX_CHARS) });
export const FactsPackConfirm = FactsPackInput.extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });

/** Why a facts pack is not registered, in the owner's words. */
export const FACTS_PACK_REFUSAL_LABEL: Readonly<Record<string, string>> = {
  TRUSTED_FACTS_INVALID: "facts pack の形が正しくありません（shop_facts_pack_v1 の JSON を貼ってください）。",
  TRUSTED_FACTS_UNMAPPED_KEY: "デモの事実に写せない項目があります（未対応の key）。",
  TRUSTED_FACTS_DUPLICATE_KEY: "同じ key の事実が 2 つあります。",
  TRUSTED_FACTS_INCOMPLETE: "デモの事実に必要な項目が足りません。",
  TRUSTED_FACTS_RIN_DEMO: "輪（SR-001）のデモには登録できません。",
  TRUSTED_FACTS_SHA_MISMATCH: "このデモの事実は、この facts pack のバイトから作られていません（sha256 が違います）。",
  TRUSTED_FACTS_CONTENT_MISMATCH: "このデモの事実の内容が、この facts pack から導いた内容と一致しません。",
  FACTS_PACK_STALE: "確認した内容と送られた内容が違います。もう一度「内容を確認」してください。",
  facts_pack_not_demo_content: "このデモの事実は、この facts pack から作られていません。",
  invalid_facts_pack: "facts pack の形が正しくありません。",
  forbidden: "登録できるのは営業の管理者だけです。",
  not_found: DEMO_VERSION_ERROR_LABEL.not_found!,
};

export type FactsPackFact = { id: string; key: string; value: string };
export type FactsPackPreview =
  | { ok: true; sha256: string; shopId: string; facts: FactsPackFact[]; alreadyCurrent: boolean }
  | { ok: false; error: string; code?: string; sha256?: string | null; facts?: FactsPackFact[] };
export type FactsPackSubmitResult = { ok: true; replayed: boolean; sha256: string } | { ok: false; error: string; code?: string };

const shown = (facts: FactsPackFact[]): FactsPackFact[] => facts.map((f) => (containsEmail(f.value) ? { ...f, value: HIDDEN_EMAIL_LABEL } : f));
const refusal = (code: string) => FACTS_PACK_REFUSAL_LABEL[code] ?? `登録できません（${code}）。`;

async function demoOf(client: Client, prospectId: string): Promise<{ kind: "ok"; id: string; content: unknown } | { kind: "not_found" } | { kind: "error" }> {
  const d = await client.from("sales_demos").select("id, content").eq("prospect_id", prospectId).maybeSingle();
  if (d.error) return { kind: "error" };
  const row = d.data as { id?: unknown; content?: unknown } | null;
  return typeof row?.id === "string" ? { kind: "ok", id: row.id, content: row.content } : { kind: "not_found" };
}

export async function previewFactsPack(raw: unknown, o: { env: Env; client: Client }): Promise<FactsPackPreview> {
  if (!demoQualityReviewEnabled(o.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  const parsed = FactsPackInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.invalid_input! };
  const demo = await demoOf(o.client, parsed.data.prospectId);
  if (demo.kind === "error") return { ok: false, error: "デモを読み込めませんでした。画面を再読み込みしてください。" };
  if (demo.kind === "not_found") return { ok: false, error: DEMO_VERSION_ERROR_LABEL.not_found! };
  const c = checkFactsPackForDemo(parsed.data.factsPack, demo.content);
  if (!c.ok) return { ok: false, error: refusal(c.code), code: c.code, sha256: c.sha256, facts: shown(c.facts) };
  const cur = await o.client.from("sales_demo_facts_packs").select("facts_sha256, demo_id").eq("prospect_id", parsed.data.prospectId).order("seq", { ascending: false }).limit(1);
  const top = Array.isArray(cur.data) ? (cur.data[0] as { facts_sha256?: string; demo_id?: string } | undefined) : undefined;
  return { ok: true, sha256: c.sha256, shopId: c.shopId, facts: shown(c.facts), alreadyCurrent: !cur.error && top?.facts_sha256 === c.sha256 && top?.demo_id === demo.id };
}

export async function submitFactsPack(raw: unknown, o: { env: Env; client: Client }): Promise<FactsPackSubmitResult> {
  if (!demoQualityReviewEnabled(o.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  const parsed = FactsPackConfirm.safeParse(raw);
  if (!parsed.success) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.invalid_input! };
  const demo = await demoOf(o.client, parsed.data.prospectId);
  if (demo.kind === "error") return { ok: false, error: "デモを読み込めませんでした。画面を再読み込みしてください。" };
  if (demo.kind === "not_found") return { ok: false, error: DEMO_VERSION_ERROR_LABEL.not_found! };
  const c = checkFactsPackForDemo(parsed.data.factsPack, demo.content);
  if (!c.ok) return { ok: false, error: refusal(c.code), code: c.code };
  if (c.sha256 !== parsed.data.sha256) return { ok: false, error: refusal("FACTS_PACK_STALE"), code: "FACTS_PACK_STALE" };
  try {
    const r = await registerFactsPackAsAdmin(o.client as never, { demoId: demo.id, factsPack: parsed.data.factsPack });
    return { ok: true, replayed: r.replayed, sha256: r.facts_sha256 };
  } catch (e) {
    const code = errorCodeOf(e instanceof Error ? e.message.replace(/^FACTS_REGISTER_REFUSED:/, "") : "");
    return { ok: false, error: refusal(code), code };
  }
}
