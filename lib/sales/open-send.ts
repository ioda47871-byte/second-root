import type { OpenedVia } from "./approval";

// PR #239 M1: the send screen opens only after the server has recorded
// 「送信画面を開いた」 — which re-runs every guard (DNC, exclusion list,
// eligibility, duplicate, demo, design, current snapshot). If the server
// refuses, no mail app, Instagram profile or clipboard text is handed out.
// Pure orchestration; the browser specifics come in as dependencies, so the
// order is unit-tested (tests/unit/sales/send-approval.test.tsx).

export type OpenResult = { ok: true } | { ok: false; error: string };

/** A window opened synchronously inside the tap (so popup blockers allow it), still blank. */
export type PendingWindow = { navigate(url: string): void; close(): void };

export type OpenDeps = {
  /** markSendOpened: the server re-checks every guard before anything opens. */
  record(via: OpenedVia): Promise<OpenResult>;
  /** Hands a mailto: URL to the device (only after record succeeded). */
  openExternal(url: string): void;
  copy(text: string): Promise<void>;
};

export type OpenOutcome =
  | { kind: "opened"; copied?: boolean }
  | { kind: "refused"; error: string };

async function safeRecord(deps: OpenDeps, via: OpenedVia): Promise<OpenResult> {
  try {
    return await deps.record(via);
  } catch {
    return { ok: false, error: "記録できませんでした。画面を再読み込みしてください。" };
  }
}

/** メールを作成: record, then open the mail app with the approved text. */
export async function openMail(link: string, deps: OpenDeps): Promise<OpenOutcome> {
  const recorded = await safeRecord(deps, "mailto");
  if (!recorded.ok) return { kind: "refused", error: recorded.error };
  deps.openExternal(link);
  return { kind: "opened" };
}

/**
 * DMを送る: `pending` was opened blank inside the tap. Record, then copy the
 * approved text and send the window to the profile; on a refusal the blank
 * window is closed and nothing is copied.
 */
export async function openInstagram(link: string, body: string, pending: PendingWindow | null, deps: OpenDeps): Promise<OpenOutcome> {
  const recorded = await safeRecord(deps, "instagram_profile");
  if (!recorded.ok) {
    pending?.close();
    return { kind: "refused", error: recorded.error };
  }
  const copied = await deps.copy(body).then(
    () => true,
    () => false,
  );
  if (pending) pending.navigate(link);
  else deps.openExternal(link);
  return { kind: "opened", copied };
}

/** 文面をコピー: record, then copy. */
export async function copyText(body: string, deps: OpenDeps): Promise<OpenOutcome> {
  const recorded = await safeRecord(deps, "copy");
  if (!recorded.ok) return { kind: "refused", error: recorded.error };
  const copied = await deps.copy(body).then(
    () => true,
    () => false,
  );
  return { kind: "opened", copied };
}
