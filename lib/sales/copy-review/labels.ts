/**
 * DEV-199e: the copy send gate's refusal codes and the owner's words for them. No imports (the send screen's labels in
 * lib/sales/approval.ts use these, and that module reaches client components).
 *
 * The codes are the database's (sales_copy_send_block, supabase/migrations/20261113000000_sales_demo_copy_send_guard.sql)
 * plus `demo_copy_review_unverifiable`, which only the server says (it could not read the store).
 */
export const COPY_SEND_CODES = [
  "demo_copy_review_unverifiable",
  "demo_copy_review_missing",
  "demo_copy_facts_not_from_facts_path",
  "demo_copy_review_stale",
  "demo_copy_review_not_passed",
  "demo_copy_send_blocked",
  "demo_copy_owner_confirmation_missing",
  "demo_copy_owner_confirmation_mismatch",
] as const;
export type CopySendCode = (typeof COPY_SEND_CODES)[number];

/** The owner's words for each refusal (the send screen shows them; the database decides). */
export const COPY_SEND_LABEL: Readonly<Record<CopySendCode, string>> = {
  demo_copy_review_unverifiable: "デモの文章の確認状態を読み取れないため送れません。画面を再読み込みしてください。",
  demo_copy_review_missing: "承認した版のデモの文章が、文章の品質監査を受けていないため送れません。",
  demo_copy_facts_not_from_facts_path: "デモの文章の監査が、店舗の事実の保存先と照合されていないため送れません。",
  demo_copy_review_stale: "デモの文章の監査が今の版の内容と一致しないため送れません。もう一度監査してください。",
  demo_copy_review_not_passed: "デモの文章が品質監査に合格していないため送れません。",
  demo_copy_send_blocked: "デモの文章の品質監査に止める理由が残っているため送れません。",
  demo_copy_owner_confirmation_missing: "デモの文章をオーナーが確認（承認）していないため送れません。",
  demo_copy_owner_confirmation_mismatch: "オーナーが確認した文章と今の文章が一致しないため送れません。",
};
