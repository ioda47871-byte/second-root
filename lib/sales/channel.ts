import { FIRST_PARTY_SOURCE_TYPES, type Channel, type SourceType, type WebsiteStatus } from "./types";

// Channel eligibility (MVP_SPEC §3.2, §3.6). Anything that cannot be
// confirmed fails closed: no channel, no outreach.

export type ChannelInput = {
  websiteStatus: WebsiteStatus;
  /** Number of independent searches that found no official site (not_found needs ≥ 2). */
  websiteChecks: number;
  instagramHandle: string | null;
  publicEmail: string | null;
  /** Source type of the page where the email was published. */
  emailSourceType: SourceType | null;
};

export type ChannelRejection =
  | "website_not_rechecked"
  | "website_unknown_without_email"
  | "site_without_email"
  | "no_eligible_channel";

export type ChannelDecision = { ok: true; channel: Channel } | { ok: false; reason: ChannelRejection };

export function hasFirstPartyEmail(input: Pick<ChannelInput, "publicEmail" | "emailSourceType">): boolean {
  return (
    input.publicEmail !== null &&
    input.emailSourceType !== null &&
    FIRST_PARTY_SOURCE_TYPES.includes(input.emailSourceType)
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
      if (input.instagramHandle) return { ok: true, channel: "instagram" };
      return { ok: false, reason: "no_eligible_channel" };
  }
}
