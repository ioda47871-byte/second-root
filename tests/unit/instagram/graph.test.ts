import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkConnection, sendText } from "@/lib/instagram/graph";

// Official Graph API calls (mocked): the read-only connection check and how
// Send API results are classified (never "sent" without proof).

const TOKEN = ["ig", "access", "token", "for", "tests", "0123456"].join("-");
const OURS = "17841400000000001";
let calls: Array<{ url: string; init?: RequestInit }> = [];

function reply(status: number, body: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(body, { status });
  });
}

beforeEach(() => {
  calls = [];
  vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", TOKEN);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("checkConnection", () => {
  it("confirms the token belongs to our account, read-only", async () => {
    reply(200, { user_id: OURS, username: "second_root" });
    expect(await checkConnection(OURS)).toEqual({ ok: true, username: "second_root" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.instagram.com/v26.0/me?fields=user_id,username");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url).not.toContain(TOKEN);
  });

  it.each([
    [400, { error: { code: 190 } }, "token_invalid"],
    [200, { user_id: "17841400000000999", username: "someone" }, "account_mismatch"],
    [500, {}, "unreachable"],
  ])("reports %s %j as %s", async (status, body, problem) => {
    reply(status, body);
    expect(await checkConnection(OURS)).toEqual({ ok: false, problem });
  });

  it("does not call Meta without a token or with a malformed account id", async () => {
    reply(200, {});
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
    expect(await checkConnection(OURS)).toEqual({ ok: false, problem: "not_configured" });
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", TOKEN);
    expect(await checkConnection("../me")).toEqual({ ok: false, problem: "not_configured" });
    expect(calls).toHaveLength(0);
  });
});

describe("sendText", () => {
  it.each([
    [200, { recipient_id: "1", message_id: "m_1" }, { outcome: "sent", messageId: "m_1" }],
    [400, { error: { code: 10, error_subcode: 2534022 } }, { outcome: "failed", errorCode: "meta_10_2534022" }],
    [400, { error: { code: 190 } }, { outcome: "failed", errorCode: "meta_190" }],
    [400, { error: { code: 100, error_subcode: 1357046 } }, { outcome: "unknown", errorCode: "meta_1357046" }],
    [400, { error: { code: 2 } }, { outcome: "unknown", errorCode: "meta_2" }],
    [400, { error: { code: 4, is_transient: true } }, { outcome: "unknown", errorCode: "meta_4" }],
    [503, {}, { outcome: "unknown", errorCode: "http_503" }],
    [200, {}, { outcome: "unknown", errorCode: "http_200" }],
  ])("classifies %s %j", async (status, body, expected) => {
    reply(status, body);
    expect(await sendText(OURS, "900000000000001", "こんにちは")).toEqual(expected);
  });

  it("is 'failed(not_configured)' without a token and never calls Meta", async () => {
    reply(200, {});
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
    expect(await sendText(OURS, "900000000000001", "x")).toEqual({ outcome: "failed", errorCode: "not_configured" });
    expect(calls).toHaveLength(0);
  });
});
