import { afterEach, describe, expect, it, vi } from "vitest";
import { storageStatus } from "../../support/seed-demo-version";

// DEV-196d-2 (review of #247): the Storage-dependent integration / e2e tests skip ONLY when the storage service is
// not running (CI: `-x storage-api`). Every other answer must throw, so a broken setup never becomes a silent skip.

const answer = (status: number, body: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
const status = () => storageStatus("http://127.0.0.1:1", "test-key");

afterEach(() => vi.unstubAllGlobals());

describe("storageStatus", () => {
  it("running: the private bucket answers", async () => {
    answer(200, JSON.stringify({ id: "sales-demo-versions", public: false }));
    expect(await status()).toEqual({ available: true });
  });

  it("not running: a network error, or the gateway's own error with a gateway / no-route status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await status()).toMatchObject({ available: false, reason: expect.stringContaining("unreachable") });
    for (const code of [404, 500, 502, 503, 504]) {
      answer(code, JSON.stringify({ message: code === 404 ? "no Route matched with those values" : "An unexpected error occurred" }));
      expect(await status(), String(code)).toMatchObject({ available: false, reason: expect.stringContaining(`HTTP ${code}`) });
    }
  });

  it("anything else throws: missing bucket, public bucket, auth error, storage-api errors, odd bodies", async () => {
    const cases: Array<[number, string]> = [
      [400, JSON.stringify({ statusCode: "404", error: "Bucket not found", message: "Bucket not found" })],
      [200, JSON.stringify({ id: "sales-demo-versions", public: true })],
      [200, JSON.stringify({ id: "other", public: false })],
      [401, JSON.stringify({ message: "Invalid authentication credentials" })],
      [403, JSON.stringify({ message: "forbidden" })],
      [500, JSON.stringify({ statusCode: "500", error: "internal", message: "boom" })],
      [502, "<html>bad gateway</html>"],
    ];
    for (const [code, body] of cases) {
      answer(code, body);
      await expect(status(), `${code} ${body}`).rejects.toThrow(/storageStatus/);
    }
  });

  it("throws when the local stack's URL or key is missing (never a skip)", async () => {
    await expect(storageStatus("", "k")).rejects.toThrow(/not set/);
    await expect(storageStatus("http://x", "")).rejects.toThrow(/not set/);
  });
});
