/**
 * DEV-196d (spec §4.6・§6.6・§7.2・§8.1・§9.2–§9.5, owner decisions 2026-11-10): every word the admin's demo version
 * screens show, keyed by a fixed code. Nothing here repeats free text from the database, the worker or a page: a code
 * the screen does not know gets a generic line (or is shown as the bare fixed code, which only ever holds
 * `[A-Za-z0-9_]`).
 *
 * Pure.
 */
import type { QualityChecklistItem, QualityDecision, QualityDecisionCode, TemplateWarning } from "./quality";
import type { RightsStatus } from "./rights";
import type { StructureAdvice } from "./structure-findings";
import type { VersionStatus } from "./version-state";
import type { DemoVersionBadgeState } from "./badge";
import type { LifecycleRefusal } from "./lifecycle-input";
import type { ReviewRefusal } from "./review-input";
import type { ApproveBlocker, SendBlockCode } from "./view-model";
import { COPY_SEND_LABEL } from "@/lib/sales/copy-review/labels";

/** The leading code of a database error message (`invalid_version_transition:draft->approved` → its first part). */
export function errorCodeOf(message: string | null | undefined): string {
  return String(message ?? "").split(":")[0]!.trim();
}

const RELOAD = "画面を再読み込みしてください。";

/** §9.5: the shop has a send screen open (the owner may already have sent from their own app). */
/**
 * DEV-196g (PR #267 M1): a send that would pin a demo version while the server's share flag is off. The share URL
 * could not show that version (it would be 404), so the app refuses the approval and the opening of the send screen.
 */
export const VERSIONED_SEND_SHARE_OFF =
  "デモの版の共有がこのサーバーで有効になっていないため（SALES_DEMO_SHARE_ENABLED）、版のデモでは送信できません。共有 URL が版を表示できないためです。";

export const APPROVAL_OPEN_MESSAGE =
  "この店舗には「送信画面を開いた」送信承認があります。版を変える操作は、その送信を先に決着させてからにしてください。実際に送った場合は今日の画面で「手動で送信済みにする」、送らなかった場合は「送らなかった」を押してください。ここからは決着させません。";

/**
 * DEV-196c Low (a): the note is checked like sales_demo_note_valid — no URL, no domain-like word, no email address.
 * A file name such as "style.css" or a version label such as "v1.de" looks like a domain to that rule, so the message
 * says so plainly.
 */
export const INVALID_NOTE_MESSAGE =
  "メモに入れられない文字列があります。URL・メールアドレス、または「style.css」「example.com」のように「.」の後に英字が続く語（ファイル名やドメイン名に見えるもの）は書けません。「スタイルシート」のように言い換えるか、「.」を外してください（500 字まで）。";

/** The owner's words for each refusal of the demo version RPCs and actions. Unknown codes get the fallback. */
export const DEMO_VERSION_ERROR_LABEL: Readonly<Record<string, string>> = {
  forbidden: "この操作はできません。ログインし直してください。",
  admin_identity_required: "この操作はできません。ログインし直してください。",
  feature_disabled: "この機能は無効です。",
  not_found: `対象が見つかりません。${RELOAD}`,
  invalid_input: `入力を確認できませんでした。${RELOAD}`,
  invalid_decision: `判定を確認できませんでした。${RELOAD}`,
  invalid_note: INVALID_NOTE_MESSAGE,
  invalid_checklist: "7 項目すべてに「問題なし」か「問題あり」を選んでください。",
  invalid_renders: `表示した描画画像を確認できませんでした。${RELOAD}`,
  stale_version: `この版の内容が画面を開いた後に変わりました。${RELOAD}`,
  render_missing: "PC1440 と SP390 の描画画像がそろっていない版は品質承認できません。",
  render_not_viewed: "PC1440 と SP390 の描画画像を、それぞれ一番下まで見てから確認してください。",
  checklist_has_ng: "「問題あり」の項目がある版は品質承認できません。「修正を依頼」か「却下」を選んでください。",
  version_not_reviewable: "この版は今は判定できません（取り消し済み・期限切れ・承認済み・判定できない状態のどれかです）。",
  demo_unavailable: "デモが無効のため判定できません。",
  demo_facts_changed: "この版を作った後に店舗の事実が変わりました。この版は品質承認できません。新しい版を作り直してください。",
  validator_not_ok: "サーバーの検査を通っていない版は品質承認できません。",
  rights_not_previewable: "権利を確認できない画像を含むため、この版は使えません。",
  approval_open: APPROVAL_OPEN_MESSAGE,
  not_an_approval: "品質承認ではない判定は取り下げられません。",
  review_not_active: `この品質承認はすでに取り下げ済みか無効です。${RELOAD}`,
  invalid_code: `取り消しの理由を選んでください。`,
  version_not_revocable: "この版は取り消せない状態です（アップロード中・不採用・期限切れ）。",
  demo_version_final: "取り消した版は元に戻せません。",
  quality_review_final: `この品質承認は変更できません。${RELOAD}`,
  impersonation_not_confirmed: "AI 生成の概念画像ごとに「事実の偽装なし」を確認してください。",
  token_expired: "表示期限が切れました。",
  signing_key_missing: "閲覧の署名鍵が設定されていないため、描画画像と頁を表示できません。",
};

export function demoVersionErrorMessage(message: string | null | undefined, fallback = `記録できませんでした。${RELOAD}`): string {
  const code = errorCodeOf(message);
  return Object.hasOwn(DEMO_VERSION_ERROR_LABEL, code) ? DEMO_VERSION_ERROR_LABEL[code]! : fallback;
}

/** §4.6: a version's status. */
export const VERSION_STATUS_LABEL: Readonly<Record<VersionStatus, string>> = {
  uploading: "アップロード中",
  rejected: "不採用（サーバーの検査で不合格）",
  draft: "下書き（品質承認前）",
  approved: "品質承認済み",
  superseded: "以前の承認版",
  revoked: "取り消し済み",
  expired: "期限切れ",
};

export const QUALITY_DECISION_LABEL: Readonly<Record<QualityDecision, string>> = {
  approved: "品質承認",
  changes_requested: "修正を依頼",
  rejected: "却下",
};

export const REVIEW_STATE_LABEL: Readonly<Record<"active" | "withdrawn" | "invalidated", string>> = {
  active: "有効",
  withdrawn: "取り下げ済み",
  invalidated: "無効",
};

export const INVALIDATED_REASON_LABEL: Readonly<Record<string, string>> = {
  rights_changed: "画像の権利が変わったため",
  facts_changed: "店舗の事実が変わったため",
  version_revoked: "版を取り消したため",
  superseded_by_newer_approval: "別の版を品質承認したため",
};

/**
 * §7.2: the 7 items in their order, with the question the owner answers. Items 3, 4 and 5 are weighed most and carry
 * a hint saying when to answer ng.
 */
export const CHECKLIST_TEXT: Readonly<Record<QualityChecklistItem, { label: string; hint: string | null }>> = {
  identity_lock: { label: "店名・業種が正しい（別の店名・別業種が混ざっていない）", hint: null },
  facts_confirmed: { label: "表示された事実がすべて確認済み（未確認のことを作っていない）", hint: "創作の見出しは事実ではありません。事実として読めてしまうなら「問題あり」。" },
  shop_specific_structure: { label: "その店舗でなければ成立しない構成である", hint: "店名を別の店に入れ替えても成り立つなら「問題あり」。" },
  no_generic_lp_regression: { label: "凡庸な LP に戻っていない", hint: "帯やカードを積み重ねただけの頁なら「問題あり」。下の警告は参考です。" },
  full_page_information: { label: "全ページで情報が伝わる（PC1440 と SP390 を上から下まで）", hint: "SP が PC の縮小にすぎない・横にはみ出す・文字が読めない・PC が間延びしているなら「問題あり」。" },
  photos_truthful: { label: "写真が店の事実を偽らない", hint: "AI 生成の画像は、実在の商品・店内・人・設備に見えるなら「問題あり」。" },
  not_a_copy: { label: "成功例の写しではない", hint: null },
};

export const CHECKLIST_ANSWER_LABEL = { ok: "問題なし", ng: "問題あり" } as const;

export const QUALITY_CODE_LABEL: Readonly<Record<QualityDecisionCode, string>> = {
  CHECKLIST_INVALID: "7 項目すべてに答えてください。",
  CHECKLIST_HAS_NG: "「問題あり」の項目があります。",
  RENDER_MISSING: "PC1440 か SP390 の描画画像がありません。",
  RENDER_NOT_VIEWED: "描画画像を一番下まで見ていません。",
  DECISION_INVALID: "判定を選んでください。",
};

/** Why the screen offers no decision (or no approval) for a version: the view model's blockers, in the owner's words. */
export const APPROVE_BLOCKER_LABEL: Readonly<Record<ApproveBlocker, string>> = {
  VERSION_NOT_REVIEWABLE: DEMO_VERSION_ERROR_LABEL.version_not_reviewable!,
  DEMO_DISABLED: DEMO_VERSION_ERROR_LABEL.demo_unavailable!,
  FACTS_CHANGED: DEMO_VERSION_ERROR_LABEL.demo_facts_changed!,
  FACTS_UNKNOWN: "店舗の事実が今どうなっているかを確認できませんでした。確認できるまで品質承認はできません（修正の依頼と却下はできます）。画面を再読み込みしてください。",
  VALIDATOR_NOT_OK: DEMO_VERSION_ERROR_LABEL.validator_not_ok!,
  RIGHTS_NOT_PREVIEWABLE: DEMO_VERSION_ERROR_LABEL.rights_not_previewable!,
  RENDER_MISSING: DEMO_VERSION_ERROR_LABEL.render_missing!,
  RENDER_UNVIEWABLE: "この版には画面で表示できない描画画像があります。すべての描画画像を見られない版は品質承認できません。",
  APPROVAL_OPEN: APPROVAL_OPEN_MESSAGE,
};

/** §7.5: advisory only (never blocks). */
export function templateWarningText(w: TemplateWarning): string {
  switch (w.code) {
    case "GENERIC_SKELETON":
      return "汎用 LP の骨格の印があります（参考）。";
    case "SAME_SKELETON_AS_OTHER_SHOP":
      return `ほかの店舗の承認済みの版と骨格が近い（${Math.round(w.similarity * 100)}%、参考）。`;
    case "TOO_CLOSE_TO_REFERENCE":
      return `成功例と骨格が近い（${Math.round(w.similarity * 100)}%、参考）。`;
    case "ASPECTS_UNKNOWN":
      return "構造の一部を計測できませんでした（参考）。";
  }
}

/** DEV-196q: what the quality form shows beside items 3 and 4 (plain strings, built on the server). Never blocks. */
export type StructureAdviceText = { kind: "not_stored" | "unreadable" | "stored"; lines: string[]; note: string };

export function structureAdviceText(a: StructureAdvice): StructureAdviceText {
  if (a.kind === "not_stored") return { kind: a.kind, lines: [], note: "この版の構造の比較の結果は保存されていません。項目 3・4 は描画画像を見て判断してください。" };
  if (a.kind === "unreadable") return { kind: a.kind, lines: [], note: "構造の比較の結果を読めませんでした（警告が無いという意味ではありません）。項目 3・4 は描画画像を見て判断してください。" };
  const unique = [...new Set(a.warnings.map(templateWarningText))];
  return {
    kind: a.kind,
    lines: unique,
    note:
      unique.length === 0
        ? `構造の比較では、汎用 LP の骨格・ほかの店舗（${a.siblingsCompared} 件と比較）や成功例との近さの印は見つかりませんでした（参考。良い構成という意味ではありません）。`
        : `構造の比較の結果です（ほかの店舗の承認済みの版 ${a.siblingsCompared} 件と比較）。参考の警告で、品質承認を止めません。`,
  };
}

/** §8.1: each rights status, in the owner's words. */
export const RIGHTS_STATUS_LABEL: Readonly<Record<RightsStatus, string>> = {
  unknown: "権利不明",
  ai_demo_internal: "AI 生成のデモ画像（架空の店・共有不可）",
  ai_concept_internal: "AI 生成の概念画像（管理者だけ・共有不可）",
  owner_provided_internal: "オーナー提供の写真（共有不可）",
  shop_provided_internal: "店舗提供の写真（共有不可）",
  licensed_terms_pinned_internal: "規約を固定した素材（共有不可）",
  share_cleared: "共有の条件を満たす写真（写真の共有は今は無効）",
  ai_share_approved: "（予約・使われない）",
  expired: "権利の期限切れ",
  revoked: "権利の取り消し済み",
};

/** §8.1 fail closed: shown instead of an image whose rights do not allow the admin preview. */
export const RIGHTS_BLOCKED_LABEL = "権利不明のため使用不可";

/** The red badge beside every real-shop AI concept image (the trusted admin frame shows it, never the artifact). */
export const AI_CONCEPT_BADGE = "AI生成・管理者だけ・共有不可";

/**
 * DEV-196c Low (c), §8.3 condition 1: the fixed statement the admin confirms per AI concept image, bound to that
 * image's sha256. Fixed text: the admin does not type it.
 */
export const NO_IMPERSONATION_STATEMENT =
  "この画像は、実在の商品・店内・人・設備を事実として見せていません（質感・光・抽象的な形などの雰囲気だけです）。";

export const SOURCE_KIND_LABEL: Readonly<Record<string, string>> = {
  owner_provided: "オーナー提供",
  shop_provided: "店舗提供",
  licensed_stock_with_terms: "規約つき素材",
  ai_generated_demo: "AI 生成（架空の店のデモ）",
  ai_concept_internal: "AI 生成の概念画像",
};

export const VERSION_ORIGIN_LABEL: Readonly<Record<string, string>> = {
  worker_autogen: "自動生成",
  design_bridge: "デザインの橋渡し",
  manual_import: "手動の取り込み",
};

/**
 * §6.6: the fixed reasons an admin may revoke a version for (revoke_code, `^[A-Z][A-Z0-9_]{2,47}$`). The screen
 * offers only these; no free text.
 */
export const REVOKE_REASONS = ["FACT_ERROR", "RIGHTS_COMPLAINT", "QUALITY_PROBLEM", "OWNER_DECISION", "SAFETY_CONCERN"] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];
export const REVOKE_REASON_LABEL: Readonly<Record<RevokeReason, string>> = {
  FACT_ERROR: "事実の誤り",
  RIGHTS_COMPLAINT: "権利の苦情・誤り",
  QUALITY_PROBLEM: "品質の問題",
  OWNER_DECISION: "オーナーの判断",
  SAFETY_CONCERN: "安全上の懸念",
};

/** §4.6・§9.4: what withdrawing a quality approval does (shown before the admin confirms). */
/**
 * review of #251 L1: no send approval can pin a version while versioned sharing is off, so nothing here is "redone";
 * what changes for sending is said by WITHDRAW_SEND_EFFECT_TEXT.
 */
export const WITHDRAW_CONFIRM_TEXT = "品質承認を取り下げると、この版は下書きに戻り、この店舗には品質承認済みの版が無くなります。";

/** §6.6・§9.4 (owner decision 2026-11-10): what revoking a version does (two-step confirmation). */
export const REVOKE_CONFIRM_TEXT =
  "版を取り消すと元に戻せません。管理者のプレビューも、送信済みの相手の共有 URL も表示されなくなります（404）。ほかの版や React のデモへは自動で切り替わりません。";

/**
 * DEV-196c Low (d): while versioned sharing is disabled (DEV-196g), a quality-approved version stops that shop's send
 * approvals with demo_not_shareable. Shown before the admin approves and after.
 */
export const APPROVAL_STOPS_SENDING_BEFORE =
  "注意: この版を品質承認すると、この店舗の送信承認は止まります（「デモを共有できない」）。版での共有がまだ無効のためです。品質承認を取り下げるまで、React のデモでも送れません。";
export const APPROVAL_STOPS_SENDING_AFTER =
  "この店舗は品質承認済みの版があるため、今は送信承認ができません（「デモを共有できない」）。版での共有はまだ無効です。送るには品質承認を取り下げてください（React のデモで送ることになります）。";

/** Why the approved version cannot be shared, in the owner's words (more than one may apply). */
export const UNSHAREABLE_REASON_LABEL: Readonly<Record<"versioned_sharing_disabled" | "ai_images" | "photos_not_shareable", string>> = {
  versioned_sharing_disabled: "版での共有がまだ無効です",
  ai_images: "AI 生成の画像を含みます（共有不可）",
  photos_not_shareable: "写真の共有は今は無効です",
};

/**
 * Low (d): why this shop's send approvals are refused because of its approved version (sales_demo_version_send_block),
 * in the owner's words. demo_not_shareable is followed by the UNSHAREABLE_REASON_LABEL lines.
 */
export const SEND_BLOCK_LABEL: Readonly<Record<SendBlockCode, string>> = {
  demo_version_unavailable:
    "品質承認した版が使えなくなりました（取り消し済み・期限切れ・見つからない）。この店舗の送信承認は止まっています。ほかの版や React のデモへは自動で切り替わりません。",
  demo_quality_not_approved: "品質承認した版に有効な品質承認がありません。この店舗の送信承認は止まっています。",
  demo_facts_changed: "品質承認した版を作った後に店舗の事実が変わりました。この店舗の送信承認は止まっています。新しい版を作り直してください。",
  demo_not_shareable: "品質承認した版を共有できないため（「デモを共有できない」）、この店舗の送信承認は止まっています。送るには品質承認を取り下げてください（React のデモで送ることになります）。",
  // DEV-199e: the copy send guard (after demo_not_shareable)
  ...COPY_SEND_LABEL,
};

/** Shown beside the send stop when the current facts could not be read (the facts may also have changed). */
export const SEND_BLOCK_FACTS_UNKNOWN_TEXT = "店舗の事実が今どうなっているかを確認できませんでした。事実が変わっている可能性もあります。";

/**
 * MVP_SPEC §7: an email address is never shown on the admin demo screens. A fact or a page line that holds one is
 * replaced by this label (it exists; it is just not shown — not the same as 未確認).
 */
export const HIDDEN_EMAIL_LABEL = "非表示（メールアドレスを含む）";
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
export function containsEmail(text: string): boolean {
  return EMAIL_LIKE.test(text);
}

/** DEV-196d-5: why the server refused a quality decision before calling the database (its own re-check). */
export const REVIEW_REFUSAL_LABEL: Readonly<Record<ReviewRefusal, string>> = {
  VERSION_NOT_FOUND: `この版が見つかりません。${RELOAD}`,
  STALE: DEMO_VERSION_ERROR_LABEL.stale_version!,
  BLOCKED: "この版は今は判定できません（画面の「品質承認できません」の理由を確かめてください）。",
  CHECKLIST_INVALID: DEMO_VERSION_ERROR_LABEL.invalid_checklist!,
  CHECKLIST_HAS_NG: DEMO_VERSION_ERROR_LABEL.checklist_has_ng!,
  DECISION_NEEDS_NG: "「修正を依頼」と「却下」は、「問題あり」の項目があるときだけ選べます。",
  RENDER_MISSING: DEMO_VERSION_ERROR_LABEL.render_missing!,
  RENDER_NOT_VIEWED: DEMO_VERSION_ERROR_LABEL.render_not_viewed!,
  IMPERSONATION_NOT_CONFIRMED: DEMO_VERSION_ERROR_LABEL.impersonation_not_confirmed!,
  IMPERSONATION_UNKNOWN_IMAGE: `確認した画像がこの版の画像と一致しません。${RELOAD}`,
  SEND_STOP_NOT_ACKNOWLEDGED: "品質承認すると送信承認が止まることを確認してください。",
  INVALID_NOTE: INVALID_NOTE_MESSAGE,
};

/** The admin's explicit acknowledgement before approving (Low d): the checkbox's words. */
export const SEND_STOP_ACKNOWLEDGEMENT = "品質承認すると、この店舗の送信承認が止まることを理解しました（「デモを共有できない」）。";

/**
 * DEV-196d-6: what withdrawing / revoking does to this shop's SENDING, exactly as the database does it
 * (sales_withdraw_demo_quality_review / sales_revoke_demo_version clear sales_demos.approved_version_id, and
 * sales_demo_version_send_block refuses nothing without an approved version). Nothing is approved automatically.
 */
/**
 * review of #251 L1 — what the database does when the approved version goes away (DEV-196c): approved_version_id
 * becomes null, so sales_demo_version(d) is the legacy hash again and sales_approval_is_current matches
 * demo_version_id = null again. A send approval made with the React demo before the quality approval, not yet sent,
 * whose draft, recipient and demo are unchanged, becomes current — sendable — again WITHOUT being approved again.
 * (tests/integration/demo-lifecycle.test.ts pins this.)
 */
export const APPROVED_VERSION_REMOVED_SEND_EFFECT =
  "品質承認の前に承認していた未送信の送信承認（React のデモ）は、文面・宛先・デモが変わっていなければ、再承認なしで再び有効になり、送れるようになります。新しい送信も React のデモで承認できます。ほかの版を自動で品質承認することはありません。";
export const WITHDRAW_SEND_EFFECT_TEXT = `取り下げると、送信承認の「デモを共有できない」の停止は外れます。${APPROVED_VERSION_REMOVED_SEND_EFFECT}`;

/** How many such unsent React-demo send approvals the shop has (an upper bound: unchanged ones only become current). */
export function unsentLegacyApprovalsText(n: number): string | null {
  return n > 0 ? `この店舗には、品質承認の前に承認した未送信の送信承認（React のデモ）が ${n} 件あります（変わっていないものだけが再び有効になります）。` : null;
}

/**
 * What revoking this version does (review of #251 L2: each line only when it applies).
 * - hasActiveApproval: the version has an active quality approval (it is invalidated)
 * - isApprovedVersion: the version is the shop's approved version (it is removed; see above)
 */
export function revokeEffects(o: { hasActiveApproval: boolean; isApprovedVersion: boolean }): string[] {
  return [
    "この版の描画画像と頁は、管理者のプレビューでも次の読み込みから表示されなくなります（404）。",
    o.hasActiveApproval ? "この版の品質承認は無効になります。取り消しは元に戻せません。" : "取り消しは元に戻せません。",
    o.isApprovedVersion
      ? `この版は送信に使う品質承認版なので、承認版は外れ、送信承認の「デモを共有できない」の停止は外れます。${APPROVED_VERSION_REMOVED_SEND_EFFECT}`
      : "ほかの版を自動で品質承認することはありません。",
    "版での共有はまだ無効なので、相手に送った共有 URL でこの版が表示されていることはありません（共有が有効になった後も、取り消した版は 404 で、ほかの版や React のデモへは切り替わりません）。",
  ];
}
/** The urgent revoke says what it is for and that it is the same, immediate, irreversible revoke. */
export const URGENT_REVOKE_TEXT =
  "急ぎの取り消し: 事実の誤り・権利の苦情・安全上の懸念で、今すぐこの版を止めるときに使います。取り消しの効果は通常と同じで、すぐに効き、元に戻せません。";

/** DEV-196d-6: why the server refused a withdrawal or a revoke before calling the database. */
export const LIFECYCLE_REFUSAL_LABEL: Readonly<Record<LifecycleRefusal, string>> = {
  VERSION_NOT_FOUND: `この版が見つかりません。${RELOAD}`,
  STALE: DEMO_VERSION_ERROR_LABEL.stale_version!,
  NOT_AN_ACTIVE_APPROVAL: DEMO_VERSION_ERROR_LABEL.review_not_active!,
  NOT_REVOCABLE: DEMO_VERSION_ERROR_LABEL.version_not_revocable!,
  APPROVAL_OPEN: APPROVAL_OPEN_MESSAGE,
  URGENT_CODE: "急ぎの取り消しの理由は「事実の誤り」「権利の苦情・誤り」「安全上の懸念」から選んでください。",
};

/** DEV-196d-7: the Today card's demo version badge, in the owner's words. */
export const DEMO_VERSION_BADGE_LABEL: Readonly<Record<DemoVersionBadgeState, string>> = {
  none: "版なし",
  awaiting_review: "品質確認待ち",
  changes_requested: "修正依頼中",
  rejected_by_admin: "却下",
  approved: "品質承認済み",
  revoked: "取り消し済み",
  uploading: "アップロード中",
  validator_rejected: "不採用",
  expired: "期限切れ",
  unknown: "版の状態を取得できません",
};
/** The badge when the version state could not be read (the card itself is unaffected). */
export const DEMO_VERSION_BADGE_UNKNOWN = "版の状態を取得できません";
/**
 * review of #252 L1: the shop has an approved version, but its row could not be read here — say that sending may be
 * stopped, never a specific reason that might be false.
 */
export const TODAY_SEND_STOP_UNKNOWN = "この店舗には品質承認した版がありますが、その状態をここでは確かめられません。送信承認は止まっている可能性があります（版の頁で確認できます）。";
/** Today: why the send action of this shop is stopped by its approved version (display only; the database decides). */
export const TODAY_SEND_STOP_TITLE = "この店舗の送信承認は、デモの版のため止まっています。";
/** Today does not read the shop's current facts: the facts check is left to the version page. */
export const TODAY_FACTS_NOT_CHECKED = "店舗の事実が変わったかどうかは、ここでは確かめていません（版の頁で確認できます）。";

/** DEV-196k: the quality-review writes are off (preview only). Shown instead of the forms, and as the refusal. */
export const QUALITY_REVIEW_DISABLED_TEXT =
  "品質の判定・取り下げ・取り消しは、今は無効です（表示だけ）。有効にするには設定が要ります。";

/**
 * DEV-196r: a render stored smaller than its viewport (the server's 4096 px limit: a tall full page is downscaled).
 * The 1:1 check is the live page tab.
 */
export function scaledRenderNote(width: number, viewportWidth: number): string | null {
  // only a downscaled render gets the note (a wider one is not something the package makes: say nothing)
  if (!(width > 0 && viewportWidth > 0) || width >= viewportWidth) return null;
  return `縮小表示（実寸の約${Math.round((width / viewportWidth) * 100)}%）。実寸は「生の頁」タブで確認できます。`;
}

export const NO_VERSIONS_TEXT = "デモの版はまだありません。";
export const DRAFT_NOT_USED_TEXT = "下書きの版は送信に使われません。";
export const TOKEN_EXPIRED_TEXT = "表示期限が切れました";
export const RENDERS_ARE_THE_BASIS_TEXT = "判断の基準は描画画像です。生の頁は端末の書体で表示が変わることがあります。";
