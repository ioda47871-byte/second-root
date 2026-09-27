import { describe, expect, it } from "vitest";
import { isSafeHttpUrl, parseInstagramProfile, websiteDomain } from "@/lib/sales/url";

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

  it("derives a lower-case domain without www", () => {
    expect(websiteDomain("https://WWW.Shop.Example.com/about")).toBe("shop.example.com");
    expect(websiteDomain("javascript:alert(1)")).toBeNull();
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
