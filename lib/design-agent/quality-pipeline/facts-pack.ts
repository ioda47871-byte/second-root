/**
 * The shop facts pack (`shop_facts_pack_v1`) as the quality-research CLIs read it (DEV-157, Issue #193).
 *
 * The same shape as `FactsPack` in the Design Artifact schema, written here so that these CLIs do not import
 * that module: that module's isolation test allows only owner-approved exact paths, and this lane is
 * not one of them. tests/unit/design-agent/quality-pipeline/facts-pack.test.ts keeps the two in step (same accepted
 * and refused packs). Pure: no file access.
 */
import { z } from "zod";

const unsafeText = /[\u0000-\u0009\u000b-\u001f\u007f]|<<<|>>>|<\s*\/?\s*[a-z!]/i;
const Text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !unsafeText.test(s), "unsafe_text");

export const FactsPack = z.strictObject({
  schema: z.literal("shop_facts_pack_v1"),
  shop_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/),
  facts: z
    .array(z.strictObject({ id: z.string().regex(/^F\d{1,3}$/), key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), value: Text(400), source_id: z.string().regex(/^S\d{1,3}$/) }))
    .min(1)
    .max(200),
});
export type FactsPack = z.infer<typeof FactsPack>;
