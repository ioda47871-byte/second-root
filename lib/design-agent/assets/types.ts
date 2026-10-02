// Two kinds of image path that must never cross (DEV-029).
//
// - PublicAssetId: a photo a person put into the asset store on purpose
//   (approved_real or generated_concept). Only these may ever be drawn on a
//   demo page, and only through the store, by id.
// - ReferenceImagePath: a screenshot of the shop's Instagram or website,
//   taken by the worker or the capture helper for Codex to look at. It lives
//   in the worker's temp directory or the capture spool, is deleted after the
//   run, and has no way into the asset store.
//
// Both are branded strings: one cannot be passed where the other is expected,
// and neither is made from a plain string except by the checks below.

declare const publicAssetBrand: unique symbol;
declare const referenceImageBrand: unique symbol;

export type PublicAssetId = string & { readonly [publicAssetBrand]: true };
export type ReferenceImagePath = string & { readonly [referenceImageBrand]: true };

/** Random, never derived from a shop name or a file name. */
export const ASSET_ID = /^asset-[a-f0-9]{24}$/;

export function toPublicAssetId(value: string): PublicAssetId | null {
  return ASSET_ID.test(value) ? (value as PublicAssetId) : null;
}

/** For the reference side only (worker temp, capture results). */
export function toReferenceImagePath(path: string): ReferenceImagePath {
  return path as ReferenceImagePath;
}
