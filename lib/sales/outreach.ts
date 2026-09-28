import type { OutreachStatus, ReplyType } from "./types";

// Initial-outreach state machine (MVP_SPEC §5). The database enforces the
// same transitions; this module lets the UI and API reject early and explain.

const TRANSITIONS: Record<OutreachStatus, readonly OutreachStatus[]> = {
  drafted: ["sent", "lost"],
  sent: ["replied", "lost"],
  replied: ["meeting", "lost"],
  meeting: ["won", "lost"],
  won: [],
  lost: [],
};

export function allowedTransitions(from: OutreachStatus): readonly OutreachStatus[] {
  return TRANSITIONS[from];
}

export type TransitionInput =
  | { to: "sent" }
  | { to: "replied"; replyType: ReplyType; futureContactRefused: boolean }
  | { to: "meeting" }
  | { to: "won"; amountJpy: number }
  | { to: "lost"; reason?: string };

export type TransitionError =
  | "invalid_transition"
  | "do_not_contact"
  | "won_amount_required"
  | "refusal_requires_decline";

export function validateTransition(
  from: OutreachStatus,
  input: TransitionInput,
  context: { doNotContact: boolean },
): { ok: true } | { ok: false; error: TransitionError } {
  if (!TRANSITIONS[from].includes(input.to)) return { ok: false, error: "invalid_transition" };
  if (input.to === "sent" && context.doNotContact) return { ok: false, error: "do_not_contact" };
  if (input.to === "won" && !(Number.isInteger(input.amountJpy) && input.amountJpy > 0)) {
    return { ok: false, error: "won_amount_required" };
  }
  if (input.to === "replied" && input.futureContactRefused && input.replyType !== "decline") {
    return { ok: false, error: "refusal_requires_decline" };
  }
  return { ok: true };
}

/**
 * Whether recording this reply sets do_not_contact. A plain decline does not;
 * only an explicit refusal of future contact chosen by the admin does (§5, §6).
 */
export function replySetsDoNotContact(replyType: ReplyType, futureContactRefused: boolean): boolean {
  return replyType === "decline" && futureContactRefused;
}
