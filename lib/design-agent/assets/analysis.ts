import { z } from "zod";
import { withoutMeta } from "../profile";
import { ASSET_ID } from "./types";

// Photo analysis (DEV-029): what Codex sees in one photo, as enums and
// numbers only. There is no free text, so nothing written in a photo (a price
// on a board, an item name) can travel from the analysis to the page.

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const unit = z.number().min(0).max(1);
const score = z.number().int().min(1).max(5);

export const SUBJECTS = ["product_closeup", "product_group", "interior", "exterior", "texture", "people", "other"] as const;
export const ORIENTATIONS = ["portrait", "landscape", "square"] as const;
export const QUALITIES = ["ok", "soft", "dark", "low_res"] as const;
export const BUSYNESS = ["quiet", "moderate", "busy"] as const;

export const FocalSchema = z.strictObject({ x: unit, y: unit });

export const PhotoAnalysisSchema = z.strictObject({
  assetId: z.string().regex(ASSET_ID),
  subject: z.enum(SUBJECTS),
  /** Any person or face, however small. MVP: such a photo is never used. */
  people: z.boolean(),
  /** Signs, menus, labels: the page never repeats them as text. */
  containsText: z.boolean(),
  orientation: z.enum(ORIENTATIONS),
  quality: z.enum(QUALITIES),
  busy: z.enum(BUSYNESS),
  dominantColors: z.array(hex).length(3),
  focal: FocalSchema,
  suitability: z.strictObject({ hero: score, feature: score }),
  brandFit: score,
  /** Another photo of the same job that shows nearly the same thing. */
  nearDuplicateOf: z.union([z.string().regex(ASSET_ID), z.null()]),
});

export const PhotoAnalysesSchema = z.strictObject({ photos: z.array(PhotoAnalysisSchema).max(3) });

export type PhotoAnalysis = z.infer<typeof PhotoAnalysisSchema>;
export type PhotoAnalyses = z.infer<typeof PhotoAnalysesSchema>;

export function photoAnalysesJsonSchema(): object {
  return withoutMeta(z.toJSONSchema(PhotoAnalysesSchema));
}

/** A photo the MVP never shows, whatever the direction says. */
export function analysisForbids(a: PhotoAnalysis): boolean {
  return a.people || a.subject === "people";
}
