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
  "demo_copy_facts_stale",
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
  demo_copy_facts_stale: "店舗の事実の保存先との照合が、この版の元になった事実で行われていないため送れません。",
  demo_copy_review_stale: "デモの文章の監査が今の版の内容と一致しないため送れません。もう一度監査してください。",
  demo_copy_review_not_passed: "デモの文章が品質監査に合格していないため送れません。",
  demo_copy_send_blocked: "デモの文章の品質監査に止める理由が残っているため送れません。",
  demo_copy_owner_confirmation_missing: "デモの文章をオーナーが確認（承認）していないため送れません。",
  demo_copy_owner_confirmation_mismatch: "オーナーが確認した文章と今の文章が一致しないため送れません。",
};

// ---- DEV-199b: the admin screen's copy review panel and the owner's copy decision -----------------------------

/** Why the owner's copy decision is not taken now (lib/sales/copy-review/gate.ts copyDecisionRefusals and the action). */
export const COPY_DECISION_REFUSAL_LABEL: Readonly<Record<string, string>> = {
  COPY_REVIEW_MISSING: "この版の文章は品質監査を受けていません。",
  COPY_REVIEW_NOT_THIS_PAGE: "文章の監査がこの版の頁と一致しません。",
  COPY_FICTIONAL_LANE: "架空の研究用の文章は確認・送信の対象になりません。",
  COPY_FACTS_NOT_FROM_FACTS_PATH: "文章の監査が店舗の事実の保存先と照合されていないため、確認できません。",
  COPY_FACTS_STALE: "店舗の事実の保存先との照合が、この版の元になった事実で行われていないため、承認できません。",
  COPY_NOT_AT_OWNER_REVIEW: "文章の監査がオーナーの確認の段にありません（改稿・保留・不合格のどれかです）。",
  COPY_REVISION_CAP: "改稿は最大 2 回までです。これ以上の改稿は依頼できません。",
  COPY_REVIEW_SUPERSEDED: "この監査の後に新しい改稿の監査があります。",
  COPY_DECISION_EXISTS: "この監査にはすでに確認の記録があります（記録は変更できません）。",
  COPY_SEND_BLOCKERS_REMAIN: "文章の品質監査に、オーナーの承認のほかに止める理由が残っているため、承認できません。",
  COPY_STALE_INPUT: "画面を開いた後に文章の監査が変わりました。画面を再読み込みしてください。",
  COPY_REVIEW_UNREADABLE: "文章の監査を読み込めませんでした。画面を再読み込みしてください。",
};

/** The database's refusals of sales_decide_copy_review (the error message's first word). */
export const COPY_DECISION_DB_ERROR_LABEL: Readonly<Record<string, string>> = {
  stale_copy_review: COPY_DECISION_REFUSAL_LABEL.COPY_STALE_INPUT!,
  copy_decision_exists: COPY_DECISION_REFUSAL_LABEL.COPY_DECISION_EXISTS!,
  copy_review_not_linked_to_version: COPY_DECISION_REFUSAL_LABEL.COPY_REVIEW_NOT_THIS_PAGE!,
  copy_decision_fictional_lane: COPY_DECISION_REFUSAL_LABEL.COPY_FICTIONAL_LANE!,
  copy_facts_not_from_facts_path: COPY_DECISION_REFUSAL_LABEL.COPY_FACTS_NOT_FROM_FACTS_PATH!,
  copy_review_not_at_owner_review: COPY_DECISION_REFUSAL_LABEL.COPY_NOT_AT_OWNER_REVIEW!,
  copy_revision_cap: COPY_DECISION_REFUSAL_LABEL.COPY_REVISION_CAP!,
  copy_review_superseded: COPY_DECISION_REFUSAL_LABEL.COPY_REVIEW_SUPERSEDED!,
  invalid_note: "メモの形が正しくありません。",
  invalid_decision: "判断の値が正しくありません。",
  not_found: "版または文章の監査が見つかりません。",
};

/** The audit's finding codes in the owner's words (the audit's own reason is shown beside them). */
export const COPY_FINDING_LABEL: Readonly<Record<string, string>> = {
  COPY_FACT_UNSUPPORTED: "事実の裏付けがない記述、または既存の事実・文言の検査の失敗",
  COPY_RHETORICAL_OVERUSE: "決め台詞の見出しが積み重なっている",
  COPY_REPETITIVE_CADENCE: "同じ文の型が区画をまたいで繰り返されている",
  COPY_GENERIC_FOR_SHOP: "どの店にも当てはまる汎用的な文",
  COPY_INFORMATION_MISSING: "必要な情報（提供内容・営業時間・場所）が欠けている",
  COPY_VOICE_UNNATURAL: "文体が不自然",
  COPY_APPROVAL_MISSING: "オーナーの確認が要る（実店舗の文章）",
  COPY_REVISION_INVALID: "改稿が無効（事実の書き換え・言い換えなど）",
  COPY_REVISION_NEEDS_REVIEW: "改稿で事実が消えた・頁が文言以外も変わったため、確認が要る",
};

/** The audit's next step in the owner's words. */
export const COPY_STEP_LABEL: Readonly<Record<string, string>> = {
  owner_review: "オーナーの確認待ち",
  revise: "改稿が必要",
  stop_hold: "保留（事実の不足または改稿の上限）",
  stop_fail: "不合格（終端）",
};
