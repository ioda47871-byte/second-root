import { normalizeAddress, normalizeEmail, normalizeName } from "./normalize";
import { parseInstagramProfile, websiteKey } from "./url";

// Dedupe keys and matching (MVP_SPEC §3.5). The database applies the same
// keys with unique constraints; this mirrors it for early, explainable
// results.

export type DedupeKeys = {
  nameAddress: string;
  website: string | null;
  instagram: string | null;
  email: string | null;
};

export function dedupeKeys(shop: {
  name: string;
  address: string;
  websiteUrl?: string | null;
  instagramUrl?: string | null;
  publicEmail?: string | null;
}): DedupeKeys {
  return {
    nameAddress: `${normalizeName(shop.name)}|${normalizeAddress(shop.address)}`,
    website: shop.websiteUrl ? websiteKey(shop.websiteUrl) : null,
    instagram: shop.instagramUrl ? (parseInstagramProfile(shop.instagramUrl)?.handle ?? null) : null,
    email: shop.publicEmail ? normalizeEmail(shop.publicEmail) : null,
  };
}

/** The first existing shop sharing any key, or null. */
export function findDuplicate<T extends { keys: DedupeKeys }>(keys: DedupeKeys, existing: T[]): T | null {
  return (
    existing.find(
      (e) =>
        e.keys.nameAddress === keys.nameAddress ||
        (keys.website !== null && e.keys.website === keys.website) ||
        (keys.instagram !== null && e.keys.instagram === keys.instagram) ||
        (keys.email !== null && e.keys.email === keys.email),
    ) ?? null
  );
}
