import { isNagoyaAddress } from "./normalize";
import { CATEGORIES, type Category } from "./types";

// Target eligibility (MVP_SPEC §2): Nagoya city and the three categories only.

export type TargetRejection = "outside_nagoya" | "unsupported_category";

export function checkTarget(input: { address: string; category: string }): { ok: true; category: Category } | { ok: false; reason: TargetRejection } {
  if (!(CATEGORIES as readonly string[]).includes(input.category)) return { ok: false, reason: "unsupported_category" };
  if (!isNagoyaAddress(input.address)) return { ok: false, reason: "outside_nagoya" };
  return { ok: true, category: input.category as Category };
}

/**
 * Whether a new initial outreach may be prepared for a shop: never for DNC,
 * and never if the shop already has an initial outreach on any channel (one
 * channel per shop; a reply or decline on one channel ends outreach there).
 */
export function canPrepareInitialOutreach(shop: { doNotContact: boolean; hasInitialOutreach: boolean }): boolean {
  return !shop.doNotContact && !shop.hasInitialOutreach;
}
