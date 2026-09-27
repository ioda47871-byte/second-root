import { describe, expect, it } from "vitest";
import { checkpointBytes, checkpointProblem } from "@/lib/sales/checkpoint";
import {
  buildMailto,
  composeDm,
  composeEmailBody,
  composeFollowUpBody,
  DEMO_DISCLAIMER,
  EMAIL_OPT_OUT,
  followUpSubject,
  instagramOpenUrl,
} from "@/lib/sales/messages";

const demoUrl = "https://secondroot.jp/demo/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

describe("email mailto", () => {
  const body = composeEmailBody({ shopName: "テスト焼菓子店", message: "はじめまして。\nご提案です。", demoUrl });

  it("includes demo URL, disclaimer, opt-out line and signature", () => {
    expect(body).toContain(demoUrl);
    expect(body).toContain(DEMO_DISCLAIMER);
    expect(body).toContain(EMAIL_OPT_OUT);
    expect(body).toContain("Second Root");
  });

  it("pre-fills recipient, subject and body", () => {
    const url = buildMailto({ to: "Info@Shop.Example.com", subject: "ご提案", body });
    expect(url.startsWith("mailto:info@shop.example.com?subject=")).toBe(true);
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(params.get("subject")).toBe("ご提案");
    expect(params.get("body")).toBe(body.replace(/\n/g, "\r\n"));
  });

  it("cannot be used to inject extra recipients or headers", () => {
    expect(() => buildMailto({ to: "a@example.com?bcc=x@example.com", subject: "s", body: "b" })).toThrow();
    expect(() => buildMailto({ to: "a@example.com,b@example.com", subject: "s", body: "b" })).toThrow();
    const url = buildMailto({ to: "a@example.com", subject: "s\r\nBcc: x@example.com", body: "b&cc=x@example.com" });
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect([...params.keys()]).toEqual(["subject", "body"]);
    expect(params.get("subject")).not.toMatch(/[\r\n]/);
  });

  it("rejects an unsafe demo URL", () => {
    expect(() => composeEmailBody({ shopName: "x", message: "y", demoUrl: "javascript:alert(1)" })).toThrow();
  });

  it("builds a single follow-up with Re: subject", () => {
    expect(followUpSubject("ご提案")).toBe("Re: ご提案");
    expect(followUpSubject("Re: ご提案")).toBe("Re: ご提案");
    const f = composeFollowUpBody({ shopName: "テスト店", demoUrl });
    expect(f).toContain(demoUrl);
    expect(f).toContain(EMAIL_OPT_OUT);
  });
});

describe("Instagram DM", () => {
  it("contains the message, demo URL and opt-out line", () => {
    const dm = composeDm({ message: "はじめまして", demoUrl });
    expect(dm).toContain("はじめまして");
    expect(dm).toContain(demoUrl);
    expect(dm).toContain("以後ご連絡いたしません");
  });
  it("only opens a validated Instagram profile", () => {
    expect(instagramOpenUrl("https://instagram.com/Pan_Ya")).toBe("https://www.instagram.com/pan_ya/");
    expect(() => instagramOpenUrl("https://evil.example.com/pan")).toThrow();
  });
});

describe("checkpoint content", () => {
  const verifiedCandidate = (i: number) => ({
    name: `テストベーカリー${i}`,
    normalized_name: `てすとべーかりー${i}`,
    address: `愛知県名古屋市中区栄${i}丁目1番1号`,
    normalized_address: `愛知県名古屋市中区栄${i}-1-1`,
    ward: "中区",
    category: "bakery",
    website_status: "present",
    website_url: `https://shop${i}.example.com/`,
    website_domain: `shop${i}.example.com`,
    instagram_url: null,
    instagram_handle: null,
    public_email: `info@shop${i}.example.com`,
    channel: "email",
    sources: Array.from({ length: 8 }, (_, j) => ({
      field: "description",
      value: "焼きたてのパンを毎朝お届けしています。".repeat(4),
      source_url: `https://shop${i}.example.com/page${j}`,
      source_type: "official_site",
      verified_at: "2026-10-01T00:00:00Z",
    })),
    demo: { template: "bakery_v1", content: { name: `テストベーカリー${i}`, hours: "8:00-18:00", description: "x".repeat(300) } },
    outreach: { subject: "ホームページのご提案", body: "ご提案の本文です。".repeat(60) },
  });

  it("10 realistic verified candidates fit in 64KB", () => {
    const checkpoint = { verified: { order: [], candidates: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, verifiedCandidate(i)])) } };
    expect(checkpointBytes(checkpoint)).toBeLessThan(65_536);
    expect(checkpointProblem(checkpoint)).toBeNull();
  });

  it.each([
    [{ page: "<html><body>raw</body></html>" }, "raw_html"],
    [{ image: "data:image/png;base64,iVBORw0KGgo=" }, "embedded_data"],
    [{ note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }, "secret"],
    [{ big: "x".repeat(70_000) }, "too_large"],
  ])("rejects %j", (value, problem) => {
    expect(checkpointProblem(value)).toBe(problem);
  });
});
