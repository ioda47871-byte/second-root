import { describe, expect, it } from "vitest";
import { decideChannel, type ChannelInput } from "@/lib/sales/channel";

const base: ChannelInput = {
  websiteStatus: "not_found",
  websiteChecks: 2,
  instagramUrl: "https://www.instagram.com/pan/",
  publicEmail: null,
  emailSourceUrl: null,
  emailSourceType: null,
};
const email = (type: ChannelInput["emailSourceType"] = "official_contact") => ({
  publicEmail: "info@shop.example.com",
  emailSourceUrl: "https://shop.example.com/contact",
  emailSourceType: type,
});

describe("channel eligibility (MVP_SPEC §3.2)", () => {
  it("no site (rechecked) + Instagram → Instagram", () => {
    expect(decideChannel(base)).toEqual({ ok: true, channel: "instagram" });
  });

  it("site + first-party email → Email", () => {
    expect(
      decideChannel({ ...base, websiteStatus: "present", ...email() }),
    ).toEqual({ ok: true, channel: "email" });
  });

  it("no site + first-party email → Email (one channel only)", () => {
    expect(decideChannel({ ...base, ...email("official_profile") })).toEqual({
      ok: true,
      channel: "email",
    });
  });

  it("site + Instagram + no email is out of scope", () => {
    expect(decideChannel({ ...base, websiteStatus: "present" })).toEqual({ ok: false, reason: "site_without_email" });
  });

  it("unknown website never goes to Instagram", () => {
    expect(decideChannel({ ...base, websiteStatus: "unknown" })).toEqual({
      ok: false,
      reason: "website_unknown_without_email",
    });
  });

  it("unknown website with first-party email may use Email", () => {
    expect(
      decideChannel({ ...base, websiteStatus: "unknown", ...email("official_site") }),
    ).toEqual({ ok: true, channel: "email" });
  });

  it("not_found requires a re-check", () => {
    expect(decideChannel({ ...base, websiteChecks: 1 })).toEqual({ ok: false, reason: "website_not_rechecked" });
  });

  it.each(["instagram_profile", "map_listing", "other", null] as const)(
    "an email from %s is not first-party and is not used",
    (sourceType) => {
      expect(decideChannel({ ...base, websiteStatus: "present", ...email(sourceType) })).toEqual({
        ok: false,
        reason: "site_without_email",
      });
    },
  );

  it("nothing usable → no channel", () => {
    expect(decideChannel({ ...base, instagramUrl: null })).toEqual({ ok: false, reason: "no_eligible_channel" });
  });

  it("an invalid Instagram URL is not a channel", () => {
    expect(decideChannel({ ...base, instagramUrl: "https://evil.com" })).toEqual({ ok: false, reason: "no_eligible_channel" });
  });

  it.each([
    ["blank email", { publicEmail: "   " }],
    ["malformed email", { publicEmail: "a@..jp" }],
    ["no source URL", { emailSourceUrl: null }],
    ["unsafe source URL", { emailSourceUrl: "javascript:alert(1)" }],
  ])("%s is not first-party email", (_label, patch) => {
    expect(decideChannel({ ...base, websiteStatus: "present", ...email(), ...patch })).toEqual({ ok: false, reason: "site_without_email" });
  });
});
