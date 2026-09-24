import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

// Regression coverage for the pre-existing Second Root site. The Resend
// client is mocked so no test can ever send a real email.
const send = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn(function Resend() {
    return { emails: { send } };
  }),
}));

const { POST } = await import("@/app/api/contact/route");

function contactRequest(body: unknown) {
  return new NextRequest("http://localhost/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = {
  name: "テスト 太郎",
  shop: "テスト店",
  email: "owner@example.com",
  category: "パン屋",
  message: "相談内容",
};

describe("robots / sitemap", () => {
  it("allows crawling of the public site and points at the sitemap", () => {
    const r = robots();
    expect(r.rules).toMatchObject({ userAgent: "*", allow: "/" });
    expect(r.sitemap).toBe("https://secondroot.jp/sitemap.xml");
  });

  it("lists the home and legal pages", () => {
    expect(sitemap().map((e) => e.url)).toEqual([
      "https://secondroot.jp",
      "https://secondroot.jp/privacy",
      "https://secondroot.jp/terms",
    ]);
  });
});

describe("POST /api/contact", () => {
  beforeEach(() => {
    send.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("RESEND_API_KEY", "re_test_dummy");
    vi.stubEnv("CONTACT_TO_EMAIL", "inbox@example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(contactRequest("{not json"));
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("requires name, shop, email, category and message", async () => {
    const res = await POST(contactRequest({ ...validBody, message: "  " }));
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an invalid email address", async () => {
    const res = await POST(contactRequest({ ...validBody, email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when Resend is not configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const res = await POST(contactRequest(validBody));
    expect(res.status).toBe(500);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends one inquiry to the configured inbox with the visitor as reply-to", async () => {
    send.mockResolvedValue({ error: null });
    const res = await POST(contactRequest(validBody));
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: "inbox@example.com", replyTo: "owner@example.com" });
  });

  it("reports a Resend error as 502", async () => {
    send.mockResolvedValue({ error: { message: "boom" } });
    const res = await POST(contactRequest(validBody));
    expect(res.status).toBe(502);
  });
});
