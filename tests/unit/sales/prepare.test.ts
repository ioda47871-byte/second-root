import { describe, expect, it } from "vitest";
import { ingestRequest } from "@/lib/sales/ingest-schema";
import { prepareCandidate } from "@/lib/sales/prepare";
import { verifiedEmailInput, verifiedInput } from "./ingest-fixtures";

describe("ingest request schema", () => {
  const runId = "8b4a5f5e-3c1d-4a9b-9a51-2d0f6c1e7a10";

  it("accepts each action", () => {
    for (const body of [
      { action: "start", runId },
      { action: "status" },
      { action: "checkpoint", runId, phase: "discovered", candidates: [{ key: "c1", name: "店", category: "cafe" }] },
      { action: "checkpoint", runId, phase: "verified", candidates: [verifiedInput()] },
      { action: "persist", runId },
      { action: "abort", runId, errorCode: "search_unavailable", errorSummary: "web search failed" },
    ]) {
      expect(ingestRequest.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it.each([
    ["unknown action", { action: "send_dm", runId }],
    ["unknown field", { action: "start", runId, doNotContact: false }],
    ["bad run id", { action: "start", runId: "123" }],
    ["21 discovered", { action: "checkpoint", runId, phase: "discovered", candidates: Array.from({ length: 21 }, (_, i) => ({ key: `c${i}`, name: "店", category: "cafe" })) }],
    ["11 verified", { action: "checkpoint", runId, phase: "verified", candidates: Array.from({ length: 11 }, () => verifiedInput()) }],
    ["duplicate keys", { action: "checkpoint", runId, phase: "verified", candidates: [verifiedInput({ key: "a" }), verifiedInput({ key: "a" })] }],
    ["javascript: URL", { action: "checkpoint", runId, phase: "discovered", candidates: [{ key: "c1", name: "店", category: "cafe", websiteUrl: "javascript:alert(1)" }] }],
    ["data: source URL", { action: "checkpoint", runId, phase: "verified", candidates: [verifiedInput({ facts: [{ field: "name", value: "x", sourceUrl: "data:text/html,x", sourceType: "official_site", verifiedAt: "2026-09-27T00:00:00Z" }] })] }],
    ["DNC field smuggled into a candidate", { action: "checkpoint", runId, phase: "verified", candidates: [{ ...verifiedInput(), doNotContact: false }] }],
  ])("rejects %s", (_label, body) => {
    expect(ingestRequest.safeParse(body).success).toBe(false);
  });
});

describe("prepareCandidate", () => {
  it("prepares an Instagram candidate for a shop without a site", () => {
    const result = prepareCandidate(verifiedInput());
    expect(result.stage).toBe("pending");
    if (result.stage !== "pending") return;
    const c = result.candidate;
    expect(c).toMatchObject({ channel: "instagram", website_status: "not_found", website_url: null, public_email: null, ward: "中区" });
    expect(c.instagram_url).toMatch(/^https:\/\/www\.instagram\.com\/test_pan_\d+\/$/);
    expect(c.normalized_address).toMatch(/^愛知県名古屋市中区栄\d+-1-1$/);
    expect(c.demo.template).toBe("bakery_v1");
    expect(c.demo.content).toMatchObject({ hours: "8:00〜17:00" });
    expect(c.outreach.subject).toBeNull();
  });

  it("prepares an Email candidate with first-party provenance and keeps email out of the demo", () => {
    const result = prepareCandidate(verifiedEmailInput());
    expect(result.stage).toBe("pending");
    if (result.stage !== "pending") return;
    expect(result.candidate).toMatchObject({ channel: "email", website_status: "present" });
    expect(result.candidate.sources.some((s) => s.field === "email" && s.source_type === "official_contact")).toBe(true);
    expect(JSON.stringify(result.candidate.demo)).not.toContain("@");
    expect(result.candidate.outreach.subject).toBe("ホームページのご提案");
  });

  it.each([
    ["outside Nagoya", verifiedInput({ address: "愛知県豊田市1-1" }), "outside_nagoya"],
    ["other category", verifiedInput({ category: "salon" }), "unsupported_category"],
    ["unknown website without email (never Instagram)", verifiedInput({ website: { status: "unknown", url: null, checks: 0 } }), "website_unknown_without_email"],
    ["not_found without re-check", verifiedInput({ website: { status: "not_found", url: null, checks: 1 } }), "website_not_rechecked"],
    ["site + Instagram + no email", verifiedInput({ website: { status: "present", url: "https://pan.example.com/", checks: 1 } }), "site_without_email"],
    ["site is a portal page", verifiedInput({ website: { status: "present", url: "https://tabelog.com/aichi/x/", checks: 1 } }), "invalid_website"],
    ["not_found with a URL", verifiedInput({ website: { status: "not_found", url: "https://pan.example.com/", checks: 2 } }), "invalid_website"],
    ["invalid Instagram", verifiedInput({ instagramUrl: "https://www.instagram.com/p/abc/" }), "invalid_instagram"],
    ["missing name source", verifiedInput({ facts: [] }), "missing_source"],
    ["link in the message", verifiedInput({ message: { subject: null, body: "こちら https://evil.example.com をご覧ください" } }), "message_contains_url"],
    ["raw HTML in a fact", verifiedInput({ facts: [...verifiedInput().facts, { field: "description", value: "<img src=x onerror=alert(1)>", sourceUrl: "https://pan.example.com/", sourceType: "official_site", verifiedAt: "2026-09-27T00:00:00Z" }] }), "unsafe_content"],
  ])("rejects %s", (_label, input, reason) => {
    expect(prepareCandidate(input)).toEqual({ stage: "rejected", reason });
  });

  it("never guesses or keeps a third-party email", () => {
    const input = verifiedEmailInput({ email: { address: "info@pan.example.com", sourceUrl: "https://tabelog.com/x", sourceType: "map_listing" } });
    expect(prepareCandidate(input)).toEqual({ stage: "rejected", reason: "site_without_email" });
    const noSite = verifiedInput({ email: { address: "someone@example.com", sourceUrl: "https://blog.example.com/", sourceType: "other" } });
    const result = prepareCandidate(noSite);
    expect(result.stage).toBe("pending");
    if (result.stage === "pending") {
      expect(result.candidate.public_email).toBeNull();
      expect(result.candidate.channel).toBe("instagram");
    }
  });
});
