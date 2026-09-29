import { describe, expect, it } from "vitest";
import { isInstagramUrl, parseInstagramProfileUrl } from "@/lib/design-agent/worker/source-url";

describe("design worker source URL (production allowlist)", () => {
  it("accepts only a public profile page and canonicalises it", () => {
    expect(parseInstagramProfileUrl("https://www.instagram.com/example_shop/")).toEqual({ url: "https://www.instagram.com/example_shop/", username: "example_shop" });
    expect(parseInstagramProfileUrl("https://instagram.com/example.shop")).toEqual({ url: "https://www.instagram.com/example.shop/", username: "example.shop" });
    // query and fragment are dropped
    expect(parseInstagramProfileUrl("https://www.instagram.com/example_shop/?igsh=abc#top")?.url).toBe("https://www.instagram.com/example_shop/");
  });

  it.each([
    ["http (not https)", "http://www.instagram.com/example_shop/"],
    ["credentials", "https://user:pass@www.instagram.com/example_shop/"],
    ["user only", "https://user@www.instagram.com/example_shop/"],
    ["port", "https://www.instagram.com:8443/example_shop/"],
    ["another host", "https://example.com/example_shop/"],
    ["look-alike host", "https://www.instagram.com.example.com/example_shop/"],
    ["sub-domain", "https://help.instagram.com/example_shop/"],
    ["localhost", "https://localhost/example_shop/"],
    ["loopback IP", "https://127.0.0.1/example_shop/"],
    ["IPv6", "https://[::1]/example_shop/"],
    ["post page", "https://www.instagram.com/p/ABCDEF/"],
    ["reel page", "https://www.instagram.com/reel/ABCDEF/"],
    ["login page", "https://www.instagram.com/accounts/login/"],
    ["explore", "https://www.instagram.com/explore/"],
    ["nested path", "https://www.instagram.com/example_shop/tagged/"],
    ["root", "https://www.instagram.com/"],
    ["bad username", "https://www.instagram.com/exa mple/"],
    ["dot rules", "https://www.instagram.com/.example/"],
    ["encoded slash", "https://www.instagram.com/example%2Fshop/"],
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["not a string", 42],
    ["too long", `https://www.instagram.com/${"a".repeat(300)}/`],
  ])("refuses %s", (_label, raw) => {
    expect(parseInstagramProfileUrl(raw)).toBeNull();
  });

  it("checks where the browser ended up", () => {
    expect(isInstagramUrl("https://www.instagram.com/accounts/login/?next=x")).toBe(true);
    expect(isInstagramUrl("https://instagram.com/x/")).toBe(true);
    expect(isInstagramUrl("https://example.com/")).toBe(false);
    expect(isInstagramUrl("http://www.instagram.com/x/")).toBe(false);
    expect(isInstagramUrl("https://www.instagram.com.evil.test/")).toBe(false);
    expect(isInstagramUrl("not a url")).toBe(false);
  });
});
