import { normalizeEmail } from "./normalize";
import { FIRST_PARTY_SOURCE_TYPES, type Channel, type SourceType, type WebsiteStatus } from "./types";
import { isOfficialSiteCandidate, isSafeHttpUrl, parseInstagramProfile } from "./url";

// Channel eligibility (MVP_SPEC §3.2, §3.6). Anything that cannot be
// confirmed fails closed: no channel, no outreach.

export type ChannelInput = {
  websiteStatus: WebsiteStatus;
  /** Number of independent searches that found no official site (not_found needs ≥ 2). */
  websiteChecks: number;
  instagramUrl: string | null;
  publicEmail: string | null;
  /** Page where the email was published, and what kind of page it is. */
  emailSourceUrl: string | null;
  emailSourceType: SourceType | null;
};

export type ChannelRejection =
  | "website_not_rechecked"
  | "website_unknown_without_email"
  | "site_without_email"
  | "no_eligible_channel";

export type ChannelDecision = { ok: true; channel: Channel } | { ok: false; reason: ChannelRejection };

/** A valid address published by the shop itself, with a safe source URL (MVP_SPEC §3.4). */
export function hasFirstPartyEmail(
  input: Pick<ChannelInput, "publicEmail" | "emailSourceUrl" | "emailSourceType">,
): boolean {
  return (
    input.publicEmail !== null &&
    normalizeEmail(input.publicEmail) !== null &&
    isSafeHttpUrl(input.emailSourceUrl) &&
    input.emailSourceType !== null &&
    FIRST_PARTY_SOURCE_TYPES.includes(input.emailSourceType) &&
    // A page on a portal / social host cannot be the shop's own site or contact page.
    (input.emailSourceType === "official_profile" || isOfficialSiteCandidate(input.emailSourceUrl as string))
  );
}

export function decideChannel(input: ChannelInput): ChannelDecision {
  // A first-party business email is the preferred channel whatever the site status.
  if (hasFirstPartyEmail(input)) return { ok: true, channel: "email" };

  switch (input.websiteStatus) {
    case "present":
      // Site present + Instagram only is out of MVP scope (§3.2).
      return { ok: false, reason: "site_without_email" };
    case "unknown":
      // A failed search is never treated as "no site" (§3.3).
      return { ok: false, reason: "website_unknown_without_email" };
    case "not_found":
      if (input.websiteChecks < 2) return { ok: false, reason: "website_not_rechecked" };
      if (parseInstagramProfile(input.instagramUrl)) return { ok: true, channel: "instagram" };
      return { ok: false, reason: "no_eligible_channel" };
  }
}
