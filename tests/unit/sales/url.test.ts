import { describe, expect, it } from "vitest";
import { isOfficialSiteCandidate, isSafeHttpUrl, parseInstagramProfile, websiteKey } from "@/lib/sales/url";

describe("URL validation", () => {
  it.each(["https://shop.example.com/", "http://shop.example.com/menu?x=1"])("accepts %s", (u) => {
    expect(isSafeHttpUrl(u)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox",
    "ftp://example.com/",
    "https://user:pass@example.com/",
    "https://localhost/",
    "//example.com/",
    "",
    " ",
    42,
    null,
    `https://example.com/${"a".repeat(2100)}`,
  ])("rejects %s", (u) => {
    expect(isSafeHttpUrl(u)).toBe(false);
  });

  it("derives a lower-case site key without www", () => {
    expect(websiteKey("https://WWW.Shop.Example.com/about")).toBe("shop.example.com");
    expect(websiteKey("javascript:alert(1)")).toBeNull();
  });

  it("keeps shops on shared hosts apart", () => {
    expect(websiteKey("https://sites.google.com/view/pan-a/home")).toBe("sites.google.com/view/pan-a");
    expect(websiteKey("https://sites.google.com/view/pan-b")).toBe("sites.google.com/view/pan-b");
    expect(websiteKey("https://ameblo.jp/shop-a/entry-1.html")).toBe("ameblo.jp/shop-a");
    expect(websiteKey("https://ameblo.jp/shop-b/")).toBe("ameblo.jp/shop-b");
    expect(websiteKey("https://sites.google.com/")).toBeNull();
    expect(websiteKey("https://hp.peraichi.com/pan-a")).toBe("hp.peraichi.com/pan-a");
    expect(websiteKey("https://blog.livedoor.jp/pan-b/")).toBe("blog.livedoor.jp/pan-b");
  });

  it.each([
    "https://www.instagram.com/pan/",
    "https://tabelog.com/aichi/A2301/A230102/123/",
    "https://maps.app.goo.gl/abc",
    "https://www.google.com/maps/place/x",
    "https://m.facebook.com/pan",
    "https://www.hotpepper.jp/strJ000/",
    "https://bit.ly/abc",
    "https://g.page/pan",
    "https://instagr.am/pan",
    "https://www.ubereats.com/jp/store/x",
    "https://www.ekiten.jp/shop_1/",
  ])("never treats %s as an official site", (u) => {
    expect(isOfficialSiteCandidate(u)).toBe(false);
    expect(websiteKey(u)).toBeNull();
  });
});

describe("Instagram profile URL", () => {
  it("canonicalises a profile URL", () => {
    expect(parseInstagramProfile("https://instagram.com/Pan.Ya_1?igsh=abc")).toEqual({
      url: "https://www.instagram.com/pan.ya_1/",
      handle: "pan.ya_1",
    });
  });

  it.each([
    "https://evil.example.com/instagram.com/pan",
    "https://instagram.com.evil.example/pan",
    "http://www.instagram.com/pan/",
    "https://www.instagram.com/p/Cabc123/",
    "https://www.instagram.com/explore/",
    "https://www.instagram.com/",
    "https://www.instagram.com/a/b/",
    "https://www.instagram.com/bad-handle!/",
    "javascript://www.instagram.com/%0aalert(1)",
  ])("rejects %s", (u) => {
    expect(parseInstagramProfile(u)).toBeNull();
  });
});
