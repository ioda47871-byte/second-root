import { describe, expect, it } from "vitest";
import { artifactResponseHeaders, buildArtifactHtmlCsp, fetchDestAllowed, normaliseOrigin, outerFrameSrc, servingOrigin } from "@/lib/sales/demo-version/csp";
import { signViewToken } from "@/lib/sales/demo-version/view-token";
import { DEMO_ID, KEY, VERSION_ID } from "./fixtures";

const APP = "https://app.example.com";
const ART = "https://artifacts.example.net";
const token = signViewToken({ scope: "p", versionId: VERSION_ID, demoId: DEMO_ID, now: new Date("2026-11-10T00:00:00Z"), key: KEY });

describe("HTML CSP (§6.7 golden)", () => {
  it("is exactly the spec's policy, with sandbox and token-path style/img sources", () => {
    expect(buildArtifactHtmlCsp({ scope: "p", servingOrigin: ART, appOrigin: APP, token })).toBe(
      "default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; " +
        "connect-src 'none'; media-src 'none'; manifest-src 'none'; font-src 'none'; prefetch-src 'none'; " +
        `style-src ${ART}/demo-frame/p/${token}/style.css; img-src ${ART}/demo-frame/p/${token}/photos/; ` +
        `form-action 'none'; base-uri 'none'; frame-ancestors ${APP}; sandbox`,
    );
  });

  it("never contains unsafe-inline, 'self' or a wildcard", () => {
    for (const scope of ["a", "p"] as const) {
      const csp = buildArtifactHtmlCsp({ scope, servingOrigin: APP, appOrigin: APP, token });
      expect(csp).not.toMatch(/unsafe|'self'|\*/);
      expect(csp.split("; ").at(-1)).toBe("sandbox");
    }
  });

  it("refuses a token or origin that could inject into the header", () => {
    expect(() => buildArtifactHtmlCsp({ scope: "a", servingOrigin: APP, appOrigin: APP, token: "x; script-src *" })).toThrow();
    expect(() => buildArtifactHtmlCsp({ scope: "a", servingOrigin: "https://a.example; script-src *", appOrigin: APP, token })).toThrow();
    expect(() => buildArtifactHtmlCsp({ scope: "a", servingOrigin: "http://evil.example", appOrigin: APP, token })).toThrow();
  });
});

describe("response headers (§6.7・T10・T12・T13)", () => {
  const base = { scope: "p" as const, servingOrigin: ART, appOrigin: APP, token };
  it("HTML", () => {
    const h = artifactResponseHeaders({ ...base, role: "html", contentType: "text/html" });
    expect(h).toMatchObject({
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    expect(h["Permissions-Policy"]).toMatch(/camera=\(\).*geolocation=\(\).*microphone=\(\).*payment=\(\).*usb=\(\)/);
    expect(h["Content-Security-Policy"]).toContain("sandbox");
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(["x-frame-options"]));
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("cross-origin-resource-policy");
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("set-cookie");
  });
  it("CSS and images get default-src 'none'", () => {
    expect(artifactResponseHeaders({ ...base, role: "css", contentType: "text/css" })).toEqual({
      "Content-Type": "text/css; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Content-Security-Policy": "default-src 'none'",
    });
    expect(artifactResponseHeaders({ ...base, role: "photo", contentType: "image/jpeg" })["Content-Type"]).toBe("image/jpeg");
  });
  it("refuses a content type that does not match the role, and renders outside scope a", () => {
    expect(() => artifactResponseHeaders({ ...base, role: "html", contentType: "text/css" })).toThrow();
    expect(() => artifactResponseHeaders({ ...base, role: "photo", contentType: "text/html" })).toThrow();
    expect(() => artifactResponseHeaders({ ...base, role: "render", contentType: "image/webp" })).toThrow();
    expect(artifactResponseHeaders({ ...base, scope: "a", role: "render", contentType: "image/webp" })["Content-Type"]).toBe("image/webp");
  });
});

describe("origins (§6.8・T23)", () => {
  it("normalises only https origins and local http", () => {
    expect(normaliseOrigin("https://app.example.com/")).toBe(APP);
    expect(normaliseOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of ["http://app.example.com", "https://app.example.com/x", "https://u:p@app.example.com", "javascript:alert(1)", "", null, "https://app.example.com?x"]) expect(normaliseOrigin(bad)).toBeNull();
  });

  it("serves share scope p only from a configured, separate artifact origin", () => {
    expect(servingOrigin({ scope: "p", requestOrigin: APP, appOrigin: APP, artifactOrigin: null })).toBeNull();
    expect(servingOrigin({ scope: "p", requestOrigin: ART, appOrigin: APP, artifactOrigin: ART })).toBe(ART);
    expect(servingOrigin({ scope: "p", requestOrigin: APP, appOrigin: APP, artifactOrigin: ART })).toBeNull();
    expect(servingOrigin({ scope: "p", requestOrigin: APP, appOrigin: APP, artifactOrigin: APP })).toBeNull();
    expect(servingOrigin({ scope: "p", requestOrigin: ART, appOrigin: APP, artifactOrigin: "http://bad.example" })).toBeNull();
  });

  it("serves admin scope a from the app origin until an artifact origin exists, then only from it", () => {
    expect(servingOrigin({ scope: "a", requestOrigin: APP, appOrigin: APP, artifactOrigin: null })).toBe(APP);
    expect(servingOrigin({ scope: "a", requestOrigin: APP, appOrigin: APP, artifactOrigin: ART })).toBeNull();
    expect(servingOrigin({ scope: "a", requestOrigin: ART, appOrigin: APP, artifactOrigin: ART })).toBe(ART);
    expect(servingOrigin({ scope: "a", requestOrigin: "https://other.example", appOrigin: APP, artifactOrigin: null })).toBeNull();
  });

  it("gives the admin outer frame frame-src 'self' only without an artifact origin; the share frame never 'self'", () => {
    expect(outerFrameSrc({ page: "admin_preview", appOrigin: APP, artifactOrigin: null })).toBe("frame-src 'self'");
    expect(outerFrameSrc({ page: "admin_preview", appOrigin: APP, artifactOrigin: ART })).toBe(`frame-src ${ART}`);
    expect(outerFrameSrc({ page: "share", appOrigin: APP, artifactOrigin: null })).toBeNull();
    expect(outerFrameSrc({ page: "share", appOrigin: APP, artifactOrigin: ART })).toBe(`frame-src ${ART}`);
    expect(outerFrameSrc({ page: "admin_preview", appOrigin: APP, artifactOrigin: APP })).toBeNull();
    expect(outerFrameSrc({ page: "share", appOrigin: APP, artifactOrigin: "http://bad.example" })).toBeNull();
  });
});

describe("Sec-Fetch-Dest (§6.4 step 6)", () => {
  it("matches the role; share HTML only inside an iframe", () => {
    expect(fetchDestAllowed({ role: "css", scope: "p", secFetchDest: "style" })).toBe(true);
    expect(fetchDestAllowed({ role: "css", scope: "p", secFetchDest: null })).toBe(false);
    expect(fetchDestAllowed({ role: "photo", scope: "p", secFetchDest: "image" })).toBe(true);
    expect(fetchDestAllowed({ role: "photo", scope: "p", secFetchDest: "document" })).toBe(false);
    expect(fetchDestAllowed({ role: "html", scope: "p", secFetchDest: "iframe" })).toBe(true);
    expect(fetchDestAllowed({ role: "html", scope: "p", secFetchDest: "document" })).toBe(false);
    expect(fetchDestAllowed({ role: "html", scope: "p", secFetchDest: null })).toBe(false);
    expect(fetchDestAllowed({ role: "html", scope: "a", secFetchDest: null })).toBe(true);
    expect(fetchDestAllowed({ role: "html", scope: "a", secFetchDest: "document" })).toBe(false);
  });
});
