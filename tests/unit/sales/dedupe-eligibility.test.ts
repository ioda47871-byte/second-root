import { describe, expect, it } from "vitest";
import { dedupeKeys, findDuplicate } from "@/lib/sales/dedupe";
import { canPrepareInitialOutreach, checkTarget } from "@/lib/sales/eligibility";

describe("target eligibility", () => {
  it("accepts the three categories in Nagoya", () => {
    expect(checkTarget({ address: "名古屋市中区栄3-4-5", category: "baked_goods" })).toEqual({ ok: true, category: "baked_goods" });
  });
  it("rejects other areas and categories", () => {
    expect(checkTarget({ address: "愛知県豊田市1-1", category: "cafe" })).toEqual({ ok: false, reason: "outside_nagoya" });
    expect(checkTarget({ address: "名古屋市中区栄3-4-5", category: "salon" })).toEqual({ ok: false, reason: "unsupported_category" });
  });
});

describe("one channel per shop and DNC", () => {
  it("never prepares a second initial outreach or one for DNC", () => {
    expect(canPrepareInitialOutreach({ doNotContact: false, hasInitialOutreach: false })).toBe(true);
    expect(canPrepareInitialOutreach({ doNotContact: false, hasInitialOutreach: true })).toBe(false);
    expect(canPrepareInitialOutreach({ doNotContact: true, hasInitialOutreach: false })).toBe(false);
  });
});

describe("dedupe", () => {
  const existing = [
    { id: "a", keys: dedupeKeys({ name: "パン屋A", address: "名古屋市中区栄3-4-5", websiteUrl: "https://pan-a.example.com/" }) },
    { id: "b", keys: dedupeKeys({ name: "焼菓子B", address: "名古屋市東区1-1", instagramUrl: "https://www.instagram.com/yakigashi_b/" }) },
    { id: "c", keys: dedupeKeys({ name: "カフェC", address: "名古屋市西区2-2", publicEmail: "info@cafe-c.example.com" }) },
    { id: "g", keys: dedupeKeys({ name: "パン屋G", address: "名古屋市北区3-3", websiteUrl: "https://sites.google.com/view/pan-g" }) },
  ];
  const find = (shop: Parameters<typeof dedupeKeys>[0]) => findDuplicate(dedupeKeys(shop), existing)?.id ?? null;

  it("matches on name + address written differently", () => {
    expect(find({ name: "パン屋 Ａ", address: "愛知県名古屋市中区栄三丁目4番5号 2F" })).toBe("a");
  });
  it("matches on website, Instagram or email", () => {
    expect(find({ name: "x", address: "名古屋市南区9-9", websiteUrl: "https://www.pan-a.example.com/menu" })).toBe("a");
    expect(find({ name: "y", address: "名古屋市南区9-9", instagramUrl: "https://instagram.com/Yakigashi_B" })).toBe("b");
    expect(find({ name: "z", address: "名古屋市南区9-9", publicEmail: "INFO@cafe-c.example.com" })).toBe("c");
  });
  it("does not merge different shops on a shared host or the same street", () => {
    expect(find({ name: "パン屋H", address: "名古屋市北区3-4", websiteUrl: "https://sites.google.com/view/pan-h" })).toBeNull();
    expect(find({ name: "パン屋A", address: "名古屋市中区栄3-4-51" })).toBeNull();
  });
});
