import { describe, expect, it } from "vitest";
import { isNagoyaAddress, kanjiToNumber, nagoyaWard, normalizeAddress, normalizeEmail, normalizeName } from "@/lib/sales/normalize";

describe("dedupe normalisation", () => {
  it("treats width, case, katakana/hiragana, spaces and punctuation as the same name", () => {
    expect(normalizeName("ＢＡＫＥＲＹ　パン・ヤ")).toBe(normalizeName("bakery ぱんや"));
    expect(normalizeName("株式会社 焼き菓子 ことり")).toBe(normalizeName("焼き菓子ことり"));
  });

  it("normalises the same address written differently", () => {
    const a = normalizeAddress("名古屋市中区栄三丁目4番5号 テストビル2F");
    const b = normalizeAddress("愛知県名古屋市中区栄３−４−５");
    expect(a).toBe("愛知県名古屋市中区栄3-4-5");
    expect(b).toBe(a);
    expect(normalizeAddress("〒460-0008 愛知県名古屋市中区栄3-4-5")).toBe(a);
  });

  it("does not merge different blocks, floors or rooms", () => {
    expect(normalizeAddress("名古屋市中区栄三丁目四番五号")).toBe("愛知県名古屋市中区栄3-4-5");
    expect(normalizeAddress("名古屋市中区栄三丁目十番二号")).toBe("愛知県名古屋市中区栄3-10-2");
    expect(normalizeAddress("名古屋市中区栄3-4-5 1F")).toBe("愛知県名古屋市中区栄3-4-5");
    expect(normalizeAddress("名古屋市中区栄3-4-5 101号室")).toBe("愛知県名古屋市中区栄3-4-5");
    expect(normalizeAddress("名古屋市中村区名駅4-5-6 2F")).toBe("愛知県名古屋市中村区名駅4-5-6");
    expect(normalizeAddress("名古屋市中区栄3-4-51")).not.toBe(normalizeAddress("名古屋市中区栄3-4-5 1F"));
    expect(normalizeAddress("名古屋市中区栄二十三番地")).toBe("愛知県名古屋市中区栄23");
  });

  it("converts kanji numerals", () => {
    expect(kanjiToNumber("三")).toBe(3);
    expect(kanjiToNumber("十")).toBe(10);
    expect(kanjiToNumber("二十三")).toBe(23);
    expect(kanjiToNumber("百五")).toBe(105);
    expect(kanjiToNumber("一〇一")).toBe(101);
    expect(kanjiToNumber("x")).toBeNull();
  });

  it("does not prefix non-Nagoya addresses with 愛知県", () => {
    expect(normalizeAddress("東京都新宿区1-1")).toBe("東京都新宿区1-1");
  });

  it("keeps names that differ only by ー, & or + apart and never returns an empty key", () => {
    expect(normalizeName("ルーチェ")).not.toBe(normalizeName("ルチェ"));
    expect(normalizeName("A&B")).not.toBe(normalizeName("AB"));
    expect(normalizeName("株式会社")).not.toBe("");
  });

  it("recognises Nagoya and its wards only", () => {
    expect(isNagoyaAddress("名古屋市千種区今池1-2-3")).toBe(true);
    expect(nagoyaWard("名古屋市千種区今池1-2-3")).toBe("千種区");
    expect(nagoyaWard("愛知県名古屋市中村区名駅1-1")).toBe("中村区");
    expect(isNagoyaAddress("愛知県豊田市1-1")).toBe(false);
    expect(isNagoyaAddress("岐阜県岐阜市1-1")).toBe(false);
    expect(nagoyaWard("愛知県豊田市1-1")).toBeNull();
  });

  it("normalises emails and rejects invalid ones", () => {
    expect(normalizeEmail(" Info@Shop.Example.COM ")).toBe("info@shop.example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a b@example.com")).toBeNull();
    expect(normalizeEmail("a@..jp")).toBeNull();
    expect(normalizeEmail("<a@b.jp>")).toBeNull();
    expect(normalizeEmail("a..b@example.com")).toBeNull();
  });
});
