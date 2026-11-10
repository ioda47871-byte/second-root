import { describe, expect, it } from "vitest";
import { signViewToken, verifyViewToken, VIEW_TOKEN_SHAPE, VIEW_TOKEN_TTL_SECONDS } from "@/lib/sales/demo-artifact/view-token";
import { DEMO_ID, KEY, OTHER_KEY, VERSION_ID } from "./fixtures";

const NOW = new Date("2026-11-10T03:00:00Z");
const at = (sec: number) => new Date(NOW.getTime() + sec * 1000);
const sign = (scope: "a" | "p", key = KEY) => signViewToken({ scope, versionId: VERSION_ID, demoId: DEMO_ID, now: NOW, key });
const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("view token (§6.2・T7・T19)", () => {
  it("round-trips with the scope's lifetime: admin 15 min, share 30 min", () => {
    expect(VIEW_TOKEN_TTL_SECONDS).toEqual({ a: 900, p: 1800 });
    for (const scope of ["a", "p"] as const) {
      const t = sign(scope);
      expect(t).toMatch(VIEW_TOKEN_SHAPE);
      const r = verifyViewToken({ token: t, pathScope: scope, now: NOW, key: KEY });
      expect(r).toEqual({ ok: true, payload: { v: 1, scope, version_id: VERSION_ID, demo_id: DEMO_ID, exp: NOW.getTime() / 1000 + VIEW_TOKEN_TTL_SECONDS[scope] } });
    }
  });

  it("expires exactly at exp", () => {
    const t = sign("a");
    expect(verifyViewToken({ token: t, pathScope: "a", now: at(899), key: KEY }).ok).toBe(true);
    expect(verifyViewToken({ token: t, pathScope: "a", now: at(900), key: KEY })).toEqual({ ok: false, reason: "TOKEN_EXPIRED" });
    expect(verifyViewToken({ token: sign("p"), pathScope: "p", now: at(1800), key: KEY })).toEqual({ ok: false, reason: "TOKEN_EXPIRED" });
  });

  it("binds the scope to the path: a on /p/ and p on /a/ fail", () => {
    expect(verifyViewToken({ token: sign("a"), pathScope: "p", now: NOW, key: KEY })).toEqual({ ok: false, reason: "TOKEN_SCOPE_MISMATCH" });
    expect(verifyViewToken({ token: sign("p"), pathScope: "a", now: NOW, key: KEY })).toEqual({ ok: false, reason: "TOKEN_SCOPE_MISMATCH" });
  });

  it("is invalidated by key rotation", () => {
    expect(verifyViewToken({ token: sign("p"), pathScope: "p", now: NOW, key: OTHER_KEY })).toEqual({ ok: false, reason: "TOKEN_BAD_SIGNATURE" });
  });

  it("refuses a tampered payload or signature", () => {
    const [p, s] = sign("a").split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    const forged = b64(JSON.stringify({ ...payload, version_id: "99999999-2222-4333-8444-555555555555" }));
    expect(verifyViewToken({ token: `${forged}.${s}`, pathScope: "a", now: NOW, key: KEY })).toEqual({ ok: false, reason: "TOKEN_BAD_SIGNATURE" });
    const flipped = s.slice(0, -2) + (s.at(-2) === "A" ? "B" : "A") + s.at(-1);
    expect(verifyViewToken({ token: `${p}.${flipped}`, pathScope: "a", now: NOW, key: KEY }).ok).toBe(false);
  });

  it("refuses a validly signed token that lives longer than its scope allows", () => {
    // forge with the same key to prove the lifetime cap holds even for the key holder
    const t = signViewToken({ scope: "a", versionId: VERSION_ID, demoId: DEMO_ID, now: at(3600), key: KEY });
    expect(verifyViewToken({ token: t, pathScope: "a", now: NOW, key: KEY })).toEqual({ ok: false, reason: "TOKEN_LIFETIME_TOO_LONG" });
  });

  it.each(["", "abc", "a.b", `${"A".repeat(500)}.x`, "x".repeat(20) + "." + "y".repeat(43), "..", "a b.c"])("refuses malformed %j", (t) => {
    expect(verifyViewToken({ token: t, pathScope: "a", now: NOW, key: KEY }).ok).toBe(false);
  });

  it("refuses a short key and bad ids at signing", () => {
    expect(() => signViewToken({ scope: "a", versionId: VERSION_ID, demoId: DEMO_ID, now: NOW, key: new Uint8Array(31) })).toThrow();
    expect(() => verifyViewToken({ token: sign("a"), pathScope: "a", now: NOW, key: new Uint8Array(16) })).toThrow();
    expect(() => signViewToken({ scope: "a", versionId: "not-a-uuid", demoId: DEMO_ID, now: NOW, key: KEY })).toThrow();
    expect(() => signViewToken({ scope: "x" as "a", versionId: VERSION_ID, demoId: DEMO_ID, now: NOW, key: KEY })).toThrow();
  });
});
