import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  artifactOrigin,
  ARTIFACT_ORIGIN_ENV,
  DEMO_VERSIONS_ENABLED_ENV,
  demoVersionsConfig,
  demoVersionsEnabled,
  readViewSigningKey,
  VIEW_SIGNING_KEY_ENV,
  viewSigningKey,
} from "@/lib/sales/demo-version/flags";

const key32 = Buffer.alloc(32, 7);

describe("DEV-196d flags: SALES_DEMO_VERSIONS_ENABLED", () => {
  it("is on only for the exact string true", () => {
    expect(demoVersionsEnabled({ [DEMO_VERSIONS_ENABLED_ENV]: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "True", "1", "yes", " true", "true ", "on"]) expect(demoVersionsEnabled({ [DEMO_VERSIONS_ENABLED_ENV]: v })).toBe(false);
    expect(demoVersionsEnabled({})).toBe(false);
  });

  it("uses the documented names", () => {
    expect([DEMO_VERSIONS_ENABLED_ENV, VIEW_SIGNING_KEY_ENV, ARTIFACT_ORIGIN_ENV]).toEqual(["SALES_DEMO_VERSIONS_ENABLED", "SALES_DEMO_VIEW_SIGNING_KEY", "SALES_DEMO_ARTIFACT_ORIGIN"]);
  });

  it("off: reads no other setting at all", () => {
    const read: string[] = [];
    const env = new Proxy({} as Record<string, string | undefined>, {
      get(_t, k) {
        read.push(String(k));
        return k === DEMO_VERSIONS_ENABLED_ENV ? "false" : "x";
      },
    });
    expect(demoVersionsConfig(env)).toEqual({ enabled: false });
    expect(read).toEqual([DEMO_VERSIONS_ENABLED_ENV]);
  });
});

describe("DEV-196d flags: SALES_DEMO_VIEW_SIGNING_KEY", () => {
  it("accepts base64 and base64url of ≥ 32 bytes, padded or not", () => {
    for (const v of [key32.toString("base64"), key32.toString("base64").replace(/=+$/, ""), Buffer.alloc(48, 250).toString("base64url"), Buffer.alloc(33, 251).toString("base64")]) {
      expect(readViewSigningKey({ [VIEW_SIGNING_KEY_ENV]: v }).ok, v).toBe(true);
    }
    expect(Buffer.from(viewSigningKey({ [VIEW_SIGNING_KEY_ENV]: key32.toString("base64") })!)).toEqual(key32);
    expect(Buffer.from(viewSigningKey({ [VIEW_SIGNING_KEY_ENV]: Buffer.alloc(32, 251).toString("base64url") })!)).toEqual(Buffer.alloc(32, 251));
  });

  it("missing is missing; short, malformed, spaced, mixed-alphabet or non-canonical is invalid", () => {
    expect(readViewSigningKey({})).toEqual({ ok: false, reason: "missing" });
    expect(readViewSigningKey({ [VIEW_SIGNING_KEY_ENV]: "" })).toEqual({ ok: false, reason: "missing" });
    const std = Buffer.alloc(32, 251).toString("base64"); // contains + and /
    const bad = [
      Buffer.alloc(31, 1).toString("base64"),
      ` ${key32.toString("base64")}`,
      `${key32.toString("base64")}\n`,
      "not a key at all, just words!!",
      "a".repeat(600),
      `${std.slice(0, 4)}-_${std.slice(6)}`,
      // trailing bits set: decodes to the same bytes as the canonical spelling
      key32.toString("base64").replace(/=+$/, "").slice(0, -1) + "x",
      // 32 characters of text decode to only 24 bytes
      "0123456789abcdef0123456789abcdef",
    ];
    for (const v of bad) expect(readViewSigningKey({ [VIEW_SIGNING_KEY_ENV]: v }), JSON.stringify(v)).toEqual({ ok: false, reason: "invalid" });
    expect(viewSigningKey({ [VIEW_SIGNING_KEY_ENV]: "short" })).toBeNull();
  });
});

describe("DEV-196d flags: SALES_DEMO_ARTIFACT_ORIGIN", () => {
  it("unset, a valid origin, or invalid (empty included) — never silently unset", () => {
    expect(artifactOrigin({})).toEqual({ kind: "unset" });
    expect(artifactOrigin({ [ARTIFACT_ORIGIN_ENV]: "https://artifacts.example.com" })).toEqual({ kind: "set", origin: "https://artifacts.example.com" });
    expect(artifactOrigin({ [ARTIFACT_ORIGIN_ENV]: "https://artifacts.example.com/" })).toEqual({ kind: "set", origin: "https://artifacts.example.com" });
    for (const v of ["", "http://artifacts.example.com", "https://artifacts.example.com/x", "javascript:alert(1)", "https://u:p@example.com"]) {
      expect(artifactOrigin({ [ARTIFACT_ORIGIN_ENV]: v }), v).toEqual({ kind: "invalid" });
    }
  });

  it("on: the config carries the key problem and the origin setting", () => {
    expect(demoVersionsConfig({ [DEMO_VERSIONS_ENABLED_ENV]: "true" })).toEqual({ enabled: true, key: null, keyProblem: "missing", artifactOrigin: { kind: "unset" } });
    const c = demoVersionsConfig({ [DEMO_VERSIONS_ENABLED_ENV]: "true", [VIEW_SIGNING_KEY_ENV]: key32.toString("base64url"), [ARTIFACT_ORIGIN_ENV]: "" });
    expect(c.enabled && c.keyProblem).toBeNull();
    expect(c.enabled && c.artifactOrigin).toEqual({ kind: "invalid" });
  });
});

describe("DEV-196d flags: names only, no values", () => {
  it("the committed env example sets none of the new names to a value", () => {
    expect(readFileSync(".env.local.example", "utf8")).not.toMatch(/SALES_DEMO_(VERSIONS_ENABLED|VIEW_SIGNING_KEY|ARTIFACT_ORIGIN)\s*=\s*\S/);
  });

  it("the flags module is server-only", () => {
    expect(readFileSync("lib/sales/demo-version/flags.ts", "utf8").startsWith('import "server-only";')).toBe(true);
  });
});
