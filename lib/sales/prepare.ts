import { decideChannel, hasFirstPartyEmail } from "./channel";
import { checkpointProblem } from "./checkpoint";
import { checkTarget } from "./eligibility";
import type { VerifiedCandidateInput } from "./ingest-schema";
import { nagoyaWard, normalizeAddress, normalizeEmail, normalizeName } from "./normalize";
import { TEMPLATE_BY_CATEGORY, type Channel, type SourceField, type SourceType } from "./types";
import { isOfficialSiteCandidate, parseInstagramProfile, websiteKey } from "./url";

// Turns a verified candidate submitted by Operational Claude into the fully
// prepared, snake_case candidate stored in the run checkpoint and persisted
// by sales_persist_candidate (supabase/migrations). Everything that cannot
// be confirmed is rejected here (fail closed); the database re-checks the
// hard rules when persisting.

export type PreparedSource = {
  field: SourceField;
  value: string;
  source_url: string;
  source_type: SourceType;
  verified_at: string;
};

export type PreparedCandidate = {
  name: string;
  normalized_name: string;
  address: string;
  normalized_address: string;
  ward: string | null;
  category: string;
  website_status: "present" | "not_found" | "unknown";
  website_url: string | null;
  website_domain: string | null;
  instagram_url: string | null;
  instagram_handle: string | null;
  public_email: string | null;
  channel: Channel;
  sources: PreparedSource[];
  demo: { template: string; content: DemoContent };
  outreach: { subject: string | null; body: string };
};

/** Only verified, public facts. Never email, notes, scores or outcomes (MVP_SPEC §7). */
export type DemoContent = {
  name: string;
  category: string;
  ward: string | null;
  address: string;
  hours?: string;
  closed_days?: string;
  access?: string;
  phone?: string;
  description?: string;
  menu_items?: string[];
};

export type RejectionReason =
  | "outside_nagoya"
  | "unsupported_category"
  | "missing_source"
  | "invalid_website"
  | "invalid_instagram"
  | "website_not_rechecked"
  | "website_unknown_without_email"
  | "site_without_email"
  | "no_eligible_channel"
  | "message_contains_url"
  | "unsafe_content";

export type Preparation =
  | { stage: "pending"; candidate: PreparedCandidate }
  | { stage: "rejected"; reason: RejectionReason };

const DEFAULT_EMAIL_SUBJECT = "ホームページのご提案（Second Root）";

const reject = (reason: RejectionReason): Preparation => ({ stage: "rejected", reason });

export function prepareCandidate(input: VerifiedCandidateInput): Preparation {
  const target = checkTarget({ address: input.address, category: input.category });
  if (!target.ok) return reject(target.reason);

  const nameFact = input.facts.find((f) => f.field === "name");
  const addressFact = input.facts.find((f) => f.field === "address");
  if (!nameFact || !addressFact) return reject("missing_source");

  // Website: a URL only for "present", and it must be the shop's own site.
  let websiteUrl: string | null = null;
  let websiteDomain: string | null = null;
  if (input.website.status === "present") {
    const url = input.website.url ?? null;
    const key = url ? websiteKey(url) : null;
    if (!url || !key || !isOfficialSiteCandidate(url)) return reject("invalid_website");
    websiteUrl = url;
    websiteDomain = key;
  } else if (input.website.url) {
    return reject("invalid_website");
  }

  let instagram: { url: string; handle: string } | null = null;
  if (input.instagramUrl) {
    instagram = parseInstagramProfile(input.instagramUrl);
    if (!instagram) return reject("invalid_instagram");
  }

  // Only a first-party email is kept; anything else is dropped, never guessed.
  const emailInput = input.email ?? null;
  const email = emailInput ? normalizeEmail(emailInput.address) : null;
  const firstPartyEmail =
    emailInput !== null &&
    email !== null &&
    hasFirstPartyEmail({ publicEmail: email, emailSourceUrl: emailInput.sourceUrl, emailSourceType: emailInput.sourceType });

  const decision = decideChannel({
    websiteStatus: input.website.status,
    websiteChecks: input.website.checks,
    instagramUrl: instagram?.url ?? null,
    publicEmail: firstPartyEmail ? email : null,
    emailSourceUrl: firstPartyEmail ? emailInput!.sourceUrl : null,
    emailSourceType: firstPartyEmail ? emailInput!.sourceType : null,
  });
  if (!decision.ok) return reject(decision.reason);

  // The demo URL, signature and opt-out line are added at send time.
  if (/https?:\/\/|www\./i.test(input.message.body) || /https?:\/\//i.test(input.message.subject ?? "")) {
    return reject("message_contains_url");
  }

  const sources: PreparedSource[] = input.facts.map((f) => ({
    field: f.field,
    value: f.value,
    source_url: f.sourceUrl,
    source_type: f.sourceType,
    verified_at: f.verifiedAt,
  }));
  const now = new Date().toISOString();
  if (websiteUrl) {
    sources.push({ field: "website_url", value: websiteUrl, source_url: websiteUrl, source_type: "official_site", verified_at: now });
  }
  if (instagram) {
    sources.push({ field: "instagram_url", value: instagram.url, source_url: instagram.url, source_type: "instagram_profile", verified_at: now });
  }
  if (firstPartyEmail) {
    sources.push({ field: "email", value: email!, source_url: emailInput!.sourceUrl, source_type: emailInput!.sourceType, verified_at: now });
  }

  const factValue = (field: SourceField) => input.facts.find((f) => f.field === field)?.value;
  const ward = nagoyaWard(input.address);
  const content: DemoContent = {
    name: input.name,
    category: target.category,
    ward,
    address: input.address,
  };
  for (const field of ["hours", "closed_days", "access", "phone", "description"] as const) {
    const value = factValue(field);
    if (value) content[field] = value;
  }
  const menu = input.facts.filter((f) => f.field === "menu_item").map((f) => f.value);
  if (menu.length > 0) content.menu_items = menu;

  const candidate: PreparedCandidate = {
    name: input.name,
    normalized_name: normalizeName(input.name),
    address: input.address,
    normalized_address: normalizeAddress(input.address),
    ward,
    category: target.category,
    website_status: input.website.status,
    website_url: websiteUrl,
    website_domain: websiteDomain,
    instagram_url: instagram?.url ?? null,
    instagram_handle: instagram?.handle ?? null,
    public_email: firstPartyEmail ? email : null,
    channel: decision.channel,
    sources,
    demo: { template: TEMPLATE_BY_CATEGORY[target.category], content },
    outreach: {
      subject: decision.channel === "email" ? input.message.subject || DEFAULT_EMAIL_SUBJECT : null,
      body: input.message.body,
    },
  };

  if (checkpointProblem(candidate) !== null) return reject("unsafe_content");
  return { stage: "pending", candidate };
}
