import type { VerifiedCandidateInput } from "./ingest-schema";
import { isNagoyaAddress, normalizeAddress, normalizeName } from "./normalize";
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
 * were checked against their sources. Everything else is transient or about
 * the submission (daily_cap, errors, missing sources, website not rechecked,
 * unknown website, invalid URLs, unsafe content), or is already answered
 * elsewhere (excluded / do_not_contact / duplicate), and is not remembered.
 */
export const DURABLE_REJECTIONS = ["site_without_email", "no_eligible_channel"] as const satisfies readonly RejectionReason[];
export type DurableRejection = (typeof DURABLE_REJECTIONS)[number];

/** How long a durable rejection is remembered (also in the migration). */
export const REJECTION_MEMORY_DAYS = 90;

export type MemoryKey = { type: "instagram_handle" | "website_domain" | "name_address"; value: string };
export type RejectionMemoryEntry = { key: string; reason: DurableRejection; keys: MemoryKey[] };

// Normalisation strips dots, so an address-like name is caught on the raw text.
const HAS_AT_SIGN = /[@＠]/;

export function isDurableRejection(reason: string): reason is DurableRejection {
  return (DURABLE_REJECTIONS as readonly string[]).includes(reason);
}

/** What to remember about a candidate prepare rejected, or null when the reason is not durable. */
export function rejectionMemoryEntry(input: VerifiedCandidateInput, reason: RejectionReason): RejectionMemoryEntry | null {
  if (!isDurableRejection(reason)) return null;
  const keys: MemoryKey[] = [];
  const handle = input.instagramUrl ? parseInstagramProfile(input.instagramUrl)?.handle : null;
  if (handle) keys.push({ type: "instagram_handle", value: handle });
  const domain = input.website.status === "present" && input.website.url ? websiteKey(input.website.url) : null;
  if (domain) keys.push({ type: "website_domain", value: domain });
  const name = normalizeName(input.name);
  const address = normalizeAddress(input.address);
  if (
    name.length > 0 &&
    !name.includes("|") &&
    isNagoyaAddress(input.address) &&
    !HAS_AT_SIGN.test(input.name + input.address + name + address) &&
    !/\s/.test(name + address)
  ) {
    keys.push({ type: "name_address", value: `${name}|${address}` });
  }
  return keys.length > 0 ? { key: input.key, reason, keys } : null;
}
