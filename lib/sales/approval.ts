import { formatJstDateTime } from "./evidence";
import type { Channel } from "./types";

// DEV-195: the manual send of an initial message, as the owner sees it.
//
//   (draft) ──承認──▶ approved ──送信画面を開く──▶ send_opened ──手動で送信済みにする──▶ sent
//                        │                           │
//                        └──────── superseded ◀──────┘  (文面の編集 / 再承認 / 送らなかった)
//
// The database (supabase/migrations/20261107000000_sales_send_approval.sql)
// is the source of truth and re-checks every guard at each step. Nothing is
// ever sent by the system: 「手動で送信済み」 is the owner's own confirmation.

export const APPROVAL_STATES = ["approved", "send_opened", "sent", "superseded"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const OPENED_VIA = ["mailto", "instagram_profile", "copy"] as const;
export type OpenedVia = (typeof OPENED_VIA)[number];

/** What the owner is told about each state (never 「自動送信済み」: nothing is sent automatically). */
export const APPROVAL_STATE_LABEL: Record<ApprovalState, string> = {
  approved: "送信を承認済み（未送信）",
  send_opened: "送信画面を開いた（送信の確認待ち）",
  sent: "手動で送信済み",
  superseded: "取り消し済み",
};

export const OPENED_VIA_LABEL: Record<OpenedVia, string> = {
  mailto: "メールアプリを開いた",
  instagram_profile: "Instagram を開いた",
  copy: "文面をコピーした",
};

/** One approval row as the admin reads it (RLS: admin only). */
export type ApprovalRow = {
  id: string;
  state: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  draft_version: number;
  demo_token: string;
  approved_at: string;
  opened_at: string | null;
  opened_via: string | null;
};

export type ApprovalView = {
  id: string;
  state: "approved" | "send_opened";
  channel: Channel;
  recipient: string;
  subject: string | null;
  body: string;
  approvedAt: string;
  approvedLabel: string;
  openedLabel: string | null;
  /** Reasons the approval no longer matches the draft (the database refuses to use it then). */
  staleReasons: string[];
};

export type ApprovalContext = {
  channel: Channel;
  draftVersion: number;
  recipient: string | null;
  demoToken: string | null;
};

const isState = (v: string): v is ApprovalState => (APPROVAL_STATES as readonly string[]).includes(v);
const isVia = (v: string | null): v is OpenedVia => v !== null && (OPENED_VIA as readonly string[]).includes(v);

/**
 * The live approval (approved / send_opened) of an outreach, if any. The
 * database keeps at most one; rows of unknown shape are ignored. Staleness is
 * what the card can see (revision, recipient, demo link); the database also
 * compares the demo's content and design (sales_demo_version).
 */
export function liveApproval(rows: ApprovalRow[] | null | undefined, ctx: ApprovalContext): ApprovalView | null {
  const row = (rows ?? []).find((r) => r && isState(r.state) && (r.state === "approved" || r.state === "send_opened"));
  if (!row || (row.channel !== "email" && row.channel !== "instagram")) return null;
  const staleReasons: string[] = [];
  if (row.channel !== ctx.channel) staleReasons.push("チャネルが変わりました");
  if (row.draft_version !== ctx.draftVersion) staleReasons.push("承認の後に文面が編集されました");
  if (row.recipient !== ctx.recipient) staleReasons.push("承認の後に宛先が変わりました");
  if (row.demo_token !== ctx.demoToken) staleReasons.push("承認の後にデモが変わったか無効になりました");
  return {
    id: row.id,
    state: row.state as "approved" | "send_opened",
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    approvedAt: row.approved_at,
    approvedLabel: formatJstDateTime(row.approved_at),
    openedLabel: row.opened_at ? `${formatJstDateTime(row.opened_at)}${isVia(row.opened_via) ? `・${OPENED_VIA_LABEL[row.opened_via]}` : ""}` : null,
    staleReasons,
  };
}

/** The code of a database error ("stale_snapshot", "invalid_transition:drafted->sent" → "invalid_transition"). */
export function errorCode(message: string | undefined): string {
  return (message ?? "").split(":")[0].trim();
}

/** The owner's words for every refusal of the send steps. Unknown codes get the generic line. */
export const SEND_ERROR_LABEL: Readonly<Record<string, string>> = {
  forbidden: "この操作はできません。ログインし直してください。",
  not_found: "対象が見つかりません。画面を再読み込みしてください。",
  do_not_contact: "この店舗は営業不要（DNC）のため送れません。",
  excluded: "除外リストに一致するため送れません。見送るか営業不要（DNC）にしてください。",
  instagram_not_eligible: "Instagram で送る条件（公式サイトなし・Instagram あり・公開メールなし）を満たしていません。",
  email_not_eligible: "店舗自身が公開したメールの出典が確認できないため送れません。",
  channel_mismatch: "下書きのチャネルが推奨チャネルと違うため送れません。",
  recipient_missing: "宛先が登録されていません。",
  duplicate_recipient: "同じ宛先にほかの店舗の営業がすでに承認または送信されています。重複を確認してください。",
  demo_unavailable: "デモが無いか無効のため送れません。",
  design_pending: "AIデザインの完成前のため送れません。",
  stale_snapshot: "承認した後に文面・宛先・デモのどれかが変わりました。内容を確認して、もう一度承認してください。",
  invalid_snapshot: "送る文面を確認できませんでした。画面を再読み込みしてください。",
  stale_draft: "ほかの画面で文面が変更されています。画面を再読み込みしてください。",
  approval_open: "送信画面を開いた承認があります。送った場合は「手動で送信済みにする」、送らなかった場合は「送らなかった」を押してください。",
  not_opened: "先に送信画面（メールアプリ / Instagram）を開いてください。",
  approval_required: "送信の承認がありません。内容を確認して承認してください。",
  invalid_transition: "この下書きはすでに送信済みか見送り済みです。画面を再読み込みしてください。",
  not_editable: "送信済みか見送り済みの下書きは編集できません。",
  invalid_draft: "文面に入れられない内容があります。",
  already_sent: "すでに手動で送信済みとして記録されています。",
};

export function sendErrorMessage(message: string | undefined, fallback = "記録できませんでした。画面を再読み込みしてください。"): string {
  const code = errorCode(message);
  return Object.hasOwn(SEND_ERROR_LABEL, code) ? SEND_ERROR_LABEL[code]! : fallback;
}
