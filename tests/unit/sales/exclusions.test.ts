import { describe, expect, it } from "vitest";
import { parseExclusion } from "@/lib/sales/exclusions";
import { normalizeAddress, normalizeName } from "@/lib/sales/normalize";
import { EMAIL_DIGEST_PATTERN, EMAIL_DIGEST_PREFIX, emailDigest } from "@/lib/sales/email-digest";
import { prepareCandidate } from "@/lib/sales/prepare";
import { createHash } from "node:crypto";
import { verifiedEmailInput, verifiedInput } from "./ingest-fixtures";

// DEV-049: admin input → the same keys ingest stores (lib/sales/prepare.ts).

const base = { label: "既存のお客様", reason: "existing_customer" };

describe("parseExclusion", () => {
  it.each([
    ["https://www.instagram.com/Mugi_No_Mi/", "mugi_no_mi"],
    ["https://instagram.com/mugi_no_mi", "mugi_no_mi"],
    ["@mugi_no_mi", "mugi_no_mi"],
    ["mugi_no_mi", "mugi_no_mi"],
    ["instagram.com/mugi_no_mi", "mugi_no_mi"],
    ["http://instagram.com/mugi_no_mi/?igsh=abc", "mugi_no_mi"],
    ["https://m.instagram.com/mugi_no_mi/", "mugi_no_mi"],
  ])("normalises the Instagram account %s", (instagram, handle) => {
    const r = parseExclusion({ ...base, instagram });
    expect(r).toMatchObject({ ok: true, value: { instagramHandle: handle } });
  });

  it("uses the ingest website key (host without www, scheme optional)", () => {
    expect(parseExclusion({ ...base, website: "https://www.Example-Bakery.jp/menu" })).toMatchObject({ ok: true, value: { websiteDomain: "example-bakery.jp" } });
    expect(parseExclusion({ ...base, website: "example-bakery.jp" })).toMatchObject({ ok: true, value: { websiteDomain: "example-bakery.jp" } });
  });

  it("normalises email and name + address like ingest", () => {
    const r = parseExclusion({ ...base, email: " Info@Example.JP ", name: "パン屋　ムギノミ", address: "名古屋市中区栄三丁目4番5号 2F" });
    expect(r).toMatchObject({
      ok: true,
      value: {
        normalizedEmail: "info@example.jp",
        normalizedName: normalizeName("パン屋　ムギノミ"),
        normalizedAddress: normalizeAddress("名古屋市中区栄三丁目4番5号 2F"),
      },
    });
  });

  it.each([
    [{ label: "" }, "表示名"],
    [{ reason: "friend" }, "理由"],
    [{ instagram: "https://www.instagram.com/p/abc/" }, "Instagram"],
    [{ website: "https://www.instagram.com/shop/" }, "公式サイト"],
    [{ email: "not-an-email" }, "メールアドレス"],
    [{ name: "ムギノミ" }, "店名と住所"],
    [{ address: "名古屋市中区栄3-4-5" }, "店名と住所"],
    [{}, "1つ以上"],
    [{ instagram: "mugi_no_mi", note: "x".repeat(501) }, "メモ"],
    [{ instagram: "mugi_no_mi", label: "店 owner@customer.example.jp" }, "メールアドレスを書かないで"],
    [{ instagram: "mugi_no_mi", note: "連絡: owner@customer.example.jp" }, "メールアドレスを書かないで"],
    [{ name: "owner@customer.example.jp", address: "名古屋市中区栄3-4-5" }, "店名と住所にはメールアドレス"],
    [{ name: "ムギノミ", address: "owner@customer.example.jp 名古屋市中区栄3-4-5" }, "店名と住所にはメールアドレス"],
  ])("refuses %o", (patch, message) => {
    const r = parseExclusion({ ...base, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  it("keeps only the keys given and trims the note", () => {
    expect(parseExclusion({ ...base, instagram: "mugi_no_mi", note: "  2025年から  " })).toEqual({
      ok: true,
      value: {
        label: "既存のお客様",
        reason: "existing_customer",
        note: "2025年から",
        instagramHandle: "mugi_no_mi",
        websiteDomain: null,
        normalizedEmail: null,
        normalizedName: null,
        normalizedAddress: null,
      },
    });
  });
});

describe("parity with ingest (the keys persist compares)", () => {
  it("an Instagram shop gives the same handle and name + address", () => {
    const raw = verifiedInput();
    const p = prepareCandidate(raw);
    if (p.stage !== "pending") throw new Error("fixture not prepared");
    const x = parseExclusion({ ...base, instagram: raw.instagramUrl!, name: raw.name, address: raw.address });
    if (!x.ok) throw new Error(x.error);
    expect(x.value.instagramHandle).toBe(p.candidate.instagram_handle);
    expect(x.value.normalizedName).toBe(p.candidate.normalized_name);
    expect(x.value.normalizedAddress).toBe(p.candidate.normalized_address);
  });

  it("an email shop gives the same domain, email and email digest", () => {
    const raw = verifiedEmailInput();
    const p = prepareCandidate(raw);
    if (p.stage !== "pending") throw new Error("fixture not prepared");
    const x = parseExclusion({ ...base, website: raw.website.url!, email: raw.email!.address.toUpperCase() });
    if (!x.ok) throw new Error(x.error);
    expect(x.value.websiteDomain).toBe(p.candidate.website_domain);
    expect(x.value.normalizedEmail).toBe(p.candidate.public_email);
    expect(emailDigest(x.value.normalizedEmail!)).toBe(p.candidate.email_digest);
  });

  it("keeps a digest (not the email) for an email that is not first-party", () => {
    const raw = verifiedInput({ email: { address: "Owner@Gmail.example.com", sourceUrl: "https://lit.link/someone", sourceType: "other" } as never });
    const p = prepareCandidate(raw);
    if (p.stage !== "pending") throw new Error("fixture not prepared");
    expect(p.candidate.public_email).toBeNull();
    expect(p.candidate.email_digest).toBe(emailDigest("owner@gmail.example.com"));
    expect(JSON.stringify(p.candidate)).not.toContain("gmail.example.com");
  });
});

describe("DEV-050: email digest", () => {
  it("is a 64-hex SHA-256 over the versioned prefix + the normalised email", () => {
    const d = emailDigest("info@example.jp");
    expect(d).toMatch(EMAIL_DIGEST_PATTERN);
    expect(d).toBe(createHash("sha256").update(`${EMAIL_DIGEST_PREFIX}info@example.jp`, "utf8").digest("hex"));
    // Domain separation: not the plain sha256(email) found in generic tables.
    expect(d).not.toBe(createHash("sha256").update("info@example.jp", "utf8").digest("hex"));
    expect(EMAIL_DIGEST_PREFIX).toBe("second-root/exclusion-email/v1\n");
  });

  it("is the same for differently written forms of one address (normalised first)", () => {
    const a = parseExclusion({ ...base, email: " Info@Example.JP " });
    const b = parseExclusion({ ...base, email: "info@example.jp" });
    if (!a.ok || !b.ok) throw new Error("parse failed");
    expect(emailDigest(a.value.normalizedEmail!)).toBe(emailDigest(b.value.normalizedEmail!));
  });
});
