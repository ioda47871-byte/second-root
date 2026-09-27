import { afterEach, describe, expect, it, vi } from "vitest";
import { composeFollowUp } from "@/lib/admin/followup";
import { buildMailto } from "@/lib/sales/messages";

describe("composeFollowUp", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds the one follow-up: Re: subject, demo URL, once-only and opt-out lines", () => {
    vi.stubEnv("SALES_DEMO_BASE_URL", "https://example.test/");
    const draft = composeFollowUp({ shopName: "テスト菓子店", publicEmail: "info@shop.example.com", initialSubject: "ご提案", demoToken: "tok_123" });
    expect(draft.to).toBe("info@shop.example.com");
    expect(draft.subject).toBe("Re: ご提案");
    expect(draft.body).toContain("テスト菓子店 ご担当者様");
    expect(draft.body).toContain("https://example.test/demo/tok_123");
    expect(draft.body).toContain("この1回限り");
    expect(draft.body).toContain("以後ご連絡いたしません");
    expect(buildMailto(draft).startsWith("mailto:info@shop.example.com?subject=Re%3A%20")).toBe(true);
  });

  it("keeps the subject within 200 characters, counting characters not UTF-16 units", () => {
    const draft = composeFollowUp({ shopName: "店", publicEmail: "a@b.example.com", initialSubject: "件".repeat(200), demoToken: "t" });
    expect([...draft.subject].length).toBe(200);
    expect(draft.subject.startsWith("Re: 件")).toBe(true);
    const emoji = composeFollowUp({ shopName: "店", publicEmail: "a@b.example.com", initialSubject: "🍞".repeat(200), demoToken: "t" });
    expect([...emoji.subject].length).toBe(200);
    expect(emoji.subject.endsWith("🍞")).toBe(true);
  });

  it("falls back to the default subject", () => {
    const draft = composeFollowUp({ shopName: "店", publicEmail: "a@b.example.com", initialSubject: null, demoToken: "t" });
    expect(draft.subject).toBe("Re: ホームページのご提案（Second Root）");
  });
});
