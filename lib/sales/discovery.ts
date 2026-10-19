import type { VerifiedCandidateInput } from "./ingest-schema";
import type { RejectionReason } from "./prepare";
import { parseInstagramProfile, websiteKey } from "./url";

// DEV-054: discovery-stage screening and the memory of rejected candidates
// (docs/ARCHITECTURE.md §7.2, migration 20261019120000).
//
// A discovered stub carries only key / name / category / ward / websiteUrl /
// instagramUrl. It is screened on the two keys that identify one shop on
// their own: the Instagram handle and the website key. Name + ward is not
// used (a stub has no address, and two shops of the same name in one ward
// would be merged: a wrongly "known" shop is silently never contacted, which
// MVP_SPEC §3.5 rates worse than a missed duplicate). A missed match only
// costs a verification; persist still dedupes on every key.

export type DiscoveryKeys = { key: string; instagram_handle: string | null; website_domain: string | null };

/** The keys a stub is screened on, with the same normalisation as ingest. */
export function discoveryKeys(stub: { key: string; websiteUrl?: string | null; instagramUrl?: string | null }): DiscoveryKeys {
  return {
    key: stub.key,
    instagram_handle: stub.instagramUrl ? (parseInstagramProfile(stub.instagramUrl)?.handle ?? null) : null,
    website_domain: stub.websiteUrl ? websiteKey(stub.websiteUrl) : null,
  };
}

/** Stubs that have at least one key worth asking the database about. */
export function screenableStubs(keys: DiscoveryKeys[]): DiscoveryKeys[] {
  return keys.filter((k) => k.instagram_handle !== null || k.website_domain !== null);
}

/**
 * Rejections caused by the shop itself, decided after its name and address
 * were checked against their sources. Only one is remembered:
 * site_without_email (the shop has its own website and no first-party
 * email; out of MVP scope, MVP_SPEC §3.2), keyed by the Instagram handle and
 * the website key — the two keys discovery screening matches on.
 * Everything else is transient or about the submission (daily_cap, errors,
 * missing sources, website not rechecked, unknown website, invalid URLs,
 * unsafe content), is already answered elsewhere (excluded / do_not_contact /
 * duplicate), or would only yield keys screening never uses
 * (no_eligible_channel: no website, no Instagram — name + address only), and
 * is not remembered.
 */
export const DURABLE_REJECTIONS = ["site_without_email"] as const satisfies readonly RejectionReason[];
export type DurableRejection = (typeof DURABLE_REJECTIONS)[number];

/** How long a durable rejection is remembered (also in the migration). */
export const REJECTION_MEMORY_DAYS = 90;

export type MemoryKey = { type: "instagram_handle" | "website_domain"; value: string };
export type RejectionMemoryEntry = { key: string; reason: DurableRejection; keys: MemoryKey[] };

export function isDurableRejection(reason: string): reason is DurableRejection {
  return (DURABLE_REJECTIONS as readonly string[]).includes(reason);
}

// The same rules as the sales_rejected_candidates check constraints
// (migration 20261019120000), so one bad key is dropped here instead of being
// sent (the SQL function also skips a key the table refuses).
const HANDLE_SHAPE = /^[a-z0-9._]{1,30}$/;
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Whether the table would accept this key (shape, length, no whitespace, no email). */
export function isValidMemoryKey(k: { type: string; value: unknown }): k is MemoryKey {
  const v = k.value;
  if (typeof v !== "string" || v.length < 1 || v.length > 520 || /\s/.test(v) || EMAIL_SHAPE.test(v)) return false;
  if (k.type === "instagram_handle") return HANDLE_SHAPE.test(v);
  if (k.type === "website_domain") return v === v.toLowerCase() && v.length >= 3 && v.length <= 512;
  return false;
}

/**
 * What to remember about a candidate prepare rejected, or null when there is
 * nothing to remember. site_without_email is remembered only when the
 * candidate submitted no email at all: a submitted email that prepare did not
 * accept (wrong sourceType, a typo, another subdomain) is a submission
 * problem, and must not hide the shop for 90 days.
 */
export function rejectionMemoryEntry(input: VerifiedCandidateInput, reason: RejectionReason): RejectionMemoryEntry | null {
  if (!isDurableRejection(reason)) return null;
  if (input.email != null) return null;
  const keys: MemoryKey[] = [];
  const handle = input.instagramUrl ? parseInstagramProfile(input.instagramUrl)?.handle : null;
  if (handle) keys.push({ type: "instagram_handle", value: handle });
  const domain = input.website.status === "present" && input.website.url ? websiteKey(input.website.url) : null;
  if (domain) keys.push({ type: "website_domain", value: domain });
  const valid = keys.filter(isValidMemoryKey);
  return valid.length > 0 ? { key: input.key, reason, keys: valid } : null;
}

/**
 * The entries worth sending to sales_remember_rejections: a durable reason,
 * a key, at most 10 entries (the function's limit), and only keys the table
 * accepts. An entry left with no key is dropped.
 */
export function validMemoryEntries(entries: RejectionMemoryEntry[]): RejectionMemoryEntry[] {
  return entries
    .filter((e) => typeof e.key === "string" && e.key.length > 0 && isDurableRejection(e.reason))
    .map((e) => ({ ...e, keys: e.keys.filter(isValidMemoryKey) }))
    .filter((e) => e.keys.length > 0)
    .slice(0, 10);
}
