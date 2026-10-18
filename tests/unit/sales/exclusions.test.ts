import { describe, expect, it } from "vitest";
import { parseExclusion } from "@/lib/sales/exclusions";
import { normalizeAddress, normalizeName } from "@/lib/sales/normalize";

// DEV-049: admin input → the same keys ingest stores (lib/sales/prepare.ts).

const base = { label: "既存のお客様", reason: "existing_customer" };

describe("parseExclusion", () => {
  it.each([
    ["https://www.instagram.com/Mugi_No_Mi/", "mugi_no_mi"],
    ["https://instagram.com/mugi_no_mi", "mugi_no_mi"],
    ["@mugi_no_mi", "mugi_no_mi"],
    ["mugi_no_mi", "mugi_no_mi"],
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
        publicEmail: "info@example.jp",
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
        publicEmail: null,
        normalizedName: null,
        normalizedAddress: null,
      },
    });
  });
});
