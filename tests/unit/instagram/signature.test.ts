import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex, verifySignature, verifyToken } from "@/lib/instagram/signature";

// Built at runtime so no secret-looking literal sits in the repository.
const SECRET = ["test", "app", "secret", "value", "0123"].join("-");
const sign = (body: Uint8Array | string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifySignature", () => {
  const body = new TextEncoder().encode('{"object":"instagram","entry":[]}');

  it("accepts the HMAC-SHA256 of the raw body", () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it.each([
    ["missing header", null],
    ["empty header", ""],
    ["other secret", sign(body, "another-secret-value-000")],
    ["sha1 prefix", sign(body).replace("sha256=", "sha1=")],
    ["uppercase hex", sign(body).toUpperCase()],
    ["truncated", sign(body).slice(0, -2)],
    ["extra bytes", `${sign(body)}00`],
  ])("rejects %s", (_label, header) => {
    expect(verifySignature(body, header, SECRET)).toBe(false);
  });

  it("checks the raw bytes, not re-serialized JSON", () => {
    // Meta signs its own escaped form; parsing and re-stringifying changes the bytes.
    const escaped = new TextEncoder().encode('{"text":"\\u3053\\u3093\\u306b\\u3061\\u306f"}');
    const header = sign(escaped);
    expect(verifySignature(escaped, header, SECRET)).toBe(true);
    const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(escaped))));
    expect(verifySignature(reserialized, header, SECRET)).toBe(false);
  });

  it("detects any change to the body", () => {
    const header = sign(body);
    const tampered = new TextEncoder().encode('{"object":"instagram","entry":[{}]}');
    expect(verifySignature(tampered, header, SECRET)).toBe(false);
  });
});

describe("verifyToken / sha256Hex", () => {
  it("compares the verify token exactly", () => {
    expect(verifyToken("verify-token-abcdef", "verify-token-abcdef")).toBe(true);
    expect(verifyToken("verify-token-abcdeg", "verify-token-abcdef")).toBe(false);
    expect(verifyToken(null, "verify-token-abcdef")).toBe(false);
  });

  it("hashes the raw body as lowercase hex", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
