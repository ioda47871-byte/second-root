// Shared domain types for the Sales Agent (docs/MVP_SPEC.md, docs/ARCHITECTURE.md).

export const CATEGORIES = ["bakery", "baked_goods", "cafe"] as const;
export type Category = (typeof CATEGORIES)[number];

export const WEBSITE_STATUSES = ["present", "not_found", "unknown"] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

export const CHANNELS = ["instagram", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export const SOURCE_TYPES = [
  "official_site",
  "official_contact",
  "official_profile",
  "instagram_profile",
  "map_listing",
  "other",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Sources that count as the shop's own (first-party) publication. */
export const FIRST_PARTY_SOURCE_TYPES: readonly SourceType[] = ["official_site", "official_contact", "official_profile"];

export const SOURCE_FIELDS = [
  "name",
  "address",
  "category",
  "website_url",
  "instagram_url",
  "email",
  "hours",
  "closed_days",
  "access",
  "phone",
  "description",
  "menu_item",
] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];

export const TEMPLATE_BY_CATEGORY: Record<Category, "bakery_v1" | "baked_goods_v1" | "cafe_v1"> = {
  bakery: "bakery_v1",
  baked_goods: "baked_goods_v1",
  cafe: "cafe_v1",
};

export const OUTREACH_STATUSES = ["drafted", "sent", "replied", "meeting", "won", "lost"] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const REPLY_TYPES = ["interested", "question", "meeting_request", "decline", "other"] as const;
export type ReplyType = (typeof REPLY_TYPES)[number];

/** Hard limits (MVP_SPEC §3.1). Enforced again by the database. */
export const LIMITS = {
  dailyNewActionable: 5,
  workQueue: 5,
  discoveredPerRun: 20,
  verifiedPerRun: 10,
  followUpAfterDays: 5,
  demoDaysAfterSent: 30,
  runExpiryHours: 24,
  maxPersistAttempts: 3,
  checkpointBytes: 65_536,
} as const;
