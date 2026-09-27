import { describe, expect, it } from "vitest";
import { allowedTransitions, replySetsDoNotContact, validateTransition } from "@/lib/sales/outreach";

const ok = { doNotContact: false };

describe("outreach state machine", () => {
  it("follows drafted → sent → replied → meeting → won", () => {
    expect(validateTransition("drafted", { to: "sent" }, ok)).toEqual({ ok: true });
    expect(validateTransition("sent", { to: "replied", replyType: "interested", futureContactRefused: false }, ok)).toEqual({ ok: true });
    expect(validateTransition("replied", { to: "meeting" }, ok)).toEqual({ ok: true });
    expect(validateTransition("meeting", { to: "won", amountJpy: 180000 }, ok)).toEqual({ ok: true });
  });

  it("allows lost from any open state and nothing after won/lost", () => {
    for (const s of ["drafted", "sent", "replied", "meeting"] as const) {
      expect(validateTransition(s, { to: "lost" }, ok)).toEqual({ ok: true });
    }
    expect(allowedTransitions("won")).toEqual([]);
    expect(allowedTransitions("lost")).toEqual([]);
  });

  it("rejects skips and backwards moves", () => {
    expect(validateTransition("drafted", { to: "meeting" }, ok)).toEqual({ ok: false, error: "invalid_transition" });
    expect(validateTransition("sent", { to: "won", amountJpy: 1 }, ok)).toEqual({ ok: false, error: "invalid_transition" });
    expect(validateTransition("meeting", { to: "sent" }, ok)).toEqual({ ok: false, error: "invalid_transition" });
  });

  it("requires a positive integer amount for won", () => {
    for (const amountJpy of [0, -1, 1.5, Number.NaN]) {
      expect(validateTransition("meeting", { to: "won", amountJpy }, ok)).toEqual({ ok: false, error: "won_amount_required" });
    }
  });

  it("never marks a DNC shop as sent", () => {
    expect(validateTransition("drafted", { to: "sent" }, { doNotContact: true })).toEqual({ ok: false, error: "do_not_contact" });
  });
});

describe("decline vs DNC (MVP_SPEC §5, §6)", () => {
  it("a plain decline does not set DNC", () => {
    expect(replySetsDoNotContact("decline", false)).toBe(false);
  });
  it("only an explicit refusal of future contact sets DNC", () => {
    expect(replySetsDoNotContact("decline", true)).toBe(true);
  });
  it.each(["interested", "question", "meeting_request", "other"] as const)("%s never sets DNC", (t) => {
    expect(replySetsDoNotContact(t, false)).toBe(false);
  });
  it("an explicit refusal must be recorded as a decline", () => {
    expect(validateTransition("sent", { to: "replied", replyType: "question", futureContactRefused: true }, ok)).toEqual({
      ok: false,
      error: "refusal_requires_decline",
    });
  });
});
