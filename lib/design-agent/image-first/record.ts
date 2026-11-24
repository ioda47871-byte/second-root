/**
 * Issue #293 P1 (IMAGE_FIRST, offline): the hand-off record of a MODEL-GENERATED full-page website comp
 * (`model_full_page_comp_v0`, output kind MODEL_GENERATED_FULL_PAGE_COMP) and the side records that are checked with it.
 *
 * What the route is: Codex's image tool draws the page (PC 1440 and SP 390, two INDEPENDENT full-page designs), the
 * owner judges the pictures, and only then Claude implements them faithfully in HTML/CSS. It is NOT #180's
 * VISUAL_FIRST (an HTML prototype screenshotted), NOT the DEV-139 "visual-first" photo route (Claude's HTML comp + Codex
 * photos) and NOT a photo.
 *
 * Why a section sequence: the image tool cannot be asked for a size (Codex CLI `image_gen.imagegen`, `gpt-image-2`,
 * `size: auto`; observed outputs ≤ about 1.5 aspect, docs/operations/imagegen-timeout-investigation.md §2). So each
 * viewport is a PRE-DEFINED sequence of section pictures (one image call each), declared before generation: which
 * direction sections each part holds, where each section sits inside its part (fractions), and how two parts meet.
 *
 * State never comes from this record: the owner's evaluation, Claude's located read of the pictures and the Identity
 * Lock audits are separate files, and every SHA in the record is recomputed from the bytes (validate.ts).
 *
 * Pure: zod only (and the image outcome vocabulary of capability.ts). No file access.
 */
import { z } from "zod";
import { IMAGE_OUTCOMES } from "../design-image/capability";

export const RECORD_SCHEMA = "model_full_page_comp_v0";
export const OUTPUT_KIND = "MODEL_GENERATED_FULL_PAGE_COMP";
export const ROUTE = "IMAGE_FIRST";
export const VIEWPORT_WIDTHS = { desktop_1440: 1440, mobile_390: 390 } as const;
export type ImageFirstViewport = keyof typeof VIEWPORT_WIDTHS;
export const VIEWPORTS = ["desktop_1440", "mobile_390"] as const satisfies readonly ImageFirstViewport[];
/** At most this many section pictures per viewport (one Codex batch holds at most 6 pictures: image-once.ts MAX_BATCH_IMAGES). */
export const MAX_PARTS_PER_VIEWPORT = 6;

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/);
const Line = (max: number) => z.string().trim().min(1).max(max);
const Iso = z.string().datetime({ offset: true });
/** A fraction of the part's width / height. */
const Frac = z.number().min(0).max(1);

export const PartSection = z.strictObject({
  id: Id,
  /** The section's box inside its part, as fractions of the part (declared by the designer before generation). */
  box: z.strictObject({ x: Frac, y: Frac, w: Frac, h: Frac }),
});

export const Part = z.strictObject({
  index: z.number().int().min(1).max(MAX_PARTS_PER_VIEWPORT),
  /** Where the picture is in the private run directory. */
  file: z.string().regex(/^parts\/[a-z0-9][a-z0-9_-]{0,40}\.png$/),
  png_sha256: Sha,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  /** Checked, not trusted: anything but `image_tool` (e.g. html_prototype_screenshot) is refused. */
  rendered_from: z.string().min(1).max(60),
  /** The full prompt text of this call is kept privately (prompt_file); only its SHA and length are here. */
  prompt_file: z.string().regex(/^prompts\/[a-z0-9][a-z0-9_-]{0,40}\.txt$/),
  prompt_sha256: Sha,
  prompt_chars: z.number().int().positive(),
  /** The image call: the Codex thread and the call's own id (capability.ts `image_call_ids`), under which approval. */
  call: z.strictObject({ thread_id: z.string().nullable(), item_id: z.string().nullable(), approval_id: z.string().nullable() }),
  sections: z.array(PartSection).min(1).max(12),
});
export type Part = z.infer<typeof Part>;

export const Seam = z.strictObject({
  after_part: z.number().int().min(1).max(MAX_PARTS_PER_VIEWPORT - 1),
  /**
   * section_break: the cut falls between two sections (no section continues across it);
   * continuous: one section continues across the cut (it ends part k and starts part k+1), and the two edges must meet.
   */
  kind: z.enum(["section_break", "continuous"]),
});

export const Composition = z.strictObject({
  target_css_width: z.union([z.literal(1440), z.literal(390)]),
  mode: z.enum(["single", "section_sequence"]),
  /** The page's section order at this width (PC: the direction's order; SP: may reorder, never drop). */
  section_order: z.array(Id).min(1).max(12),
  parts: z.array(Part).min(1).max(MAX_PARTS_PER_VIEWPORT),
  seams: z.array(Seam).max(MAX_PARTS_PER_VIEWPORT - 1),
});
export type Composition = z.infer<typeof Composition>;

/** The comp record. Values that must be checked (not just shaped) are loose here, so the validator can name the failure. */
export const ModelFullPageComp = z.strictObject({
  schema: z.literal(RECORD_SCHEMA),
  output_kind: z.string().min(1).max(60),
  route: z.string().min(1).max(40),
  run_id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  shop: z.strictObject({ shop_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/), display_name: Line(80), category_code: Line(40) }),
  facts_pack_sha256: Sha.nullable(),
  direction: z.strictObject({ direction_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,40}$/), direction_sha256: Sha.nullable(), set_sha256: Sha.nullable() }),
  /** Both are required; nullable here so a missing one is named (COMP_PC_MISSING / COMP_SP_MISSING). */
  viewports: z.strictObject({ desktop_1440: Composition.nullable(), mobile_390: Composition.nullable() }),
  generation: z.strictObject({
    tool: z.string().min(1).max(40),
    cli_version: z.string().regex(/^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/).nullable(),
    /** The session model Codex reported (turn_context.model); null = unknown (a warning, owner decision DEV-114). */
    session_model: z.string().regex(/^[0-9A-Za-z._-]{1,60}$/).nullable(),
    image_tool: z.string().min(1).max(60),
    /** Known from the CLI source only (rust-v0.159.0: gpt-image-2); null = unknown (a warning). */
    image_model: z.string().regex(/^[0-9A-Za-z._-]{1,60}$/).nullable(),
    repo_commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    plan_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/).nullable(),
    /** One-use approval ids (the real-call ledger's kind); every part's call names one of them. */
    approval_ids: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/)).max(12),
    /** The SHA-256 of the per-run approval packet the owner approved (P2). Nothing runs without it. */
    approval_packet_sha256: Sha.nullable(),
    started_at: Iso.nullable(),
    finished_at: Iso.nullable(),
    image_calls: z.number().int().min(0),
    image_completed: z.number().int().min(0),
    image_failed: z.number().int().min(0),
    outcome: z.enum([...IMAGE_OUTCOMES, "not_applicable"]),
    stop_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/).nullable(),
  }),
  rights: z.strictObject({
    use: z.string().min(1).max(40),
    page_asset: z.boolean(),
    public_web: z.boolean(),
    ai_generated: z.boolean(),
    crop_as_asset: z.boolean(),
    text_is_fact_source: z.boolean(),
  }),
  storage: z.strictObject({ location_kind: z.string().min(1).max(40), path_in_record: z.boolean() }),
  generated_at: Iso.nullable(),
});
export type ModelFullPageComp = z.infer<typeof ModelFullPageComp>;

/** The rights a model comp must carry: design reference only, never a page asset, never public, never a fact source. */
export const REQUIRED_RIGHTS = { use: "design_reference_only", page_asset: false, public_web: false, ai_generated: true, crop_as_asset: false, text_is_fact_source: false } as const;
export const REQUIRED_STORAGE = { location_kind: "private_outside_repo", path_in_record: false } as const;
export const REQUIRED_GENERATION = { tool: "codex_cli", image_tool: "image_gen.imagegen" } as const;

/**
 * Claude's (or a person's) located read of each picture, bound to its SHA: what the picture shows, never a fact source.
 * Reuses the identity/visual-read idea (the observations were taken while viewing exactly these bytes).
 */
export const VisibleText = z.strictObject({ text: Line(200), kind: z.enum(["shop_name", "fact", "creative", "ui_label"]) });
export const VisualRead = z.strictObject({
  schema: z.literal("image_first_visual_read_v0"),
  run_id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  method: z.enum(["assistant_visual", "human_visual"]),
  parts: z
    .array(
      z.strictObject({
        inspected_sha256: Sha,
        observed_section_ids: z.array(Id).max(12),
        header_visible: z.boolean(),
        footer_visible: z.boolean(),
        web_structure: z.strictObject({ nav: z.boolean(), text_blocks: z.boolean(), info_block: z.boolean() }),
        /** The picture is a photo / poster with no page around it. */
        photo_only: z.boolean(),
        /** The picture looks like a browser screenshot of an HTML page (scrollbar, browser chrome, pixel-exact system UI). */
        looks_like_browser_screenshot: z.boolean(),
        visible_texts: z.array(VisibleText).max(80),
        note: Line(600),
      }),
    )
    .min(1)
    .max(MAX_PARTS_PER_VIEWPORT * 2),
  /** The SP pictures are their own design (order, CTA, text, spacing), not the PC shrunk. */
  sp_independent: z.strictObject({ judged: z.boolean(), note: Line(600) }),
});
export type VisualRead = z.infer<typeof VisualRead>;

/** One Identity Lock audit per part (identity-lock.ts auditIdentity input, unchanged), under one file. */
export const IdentityFile = z.strictObject({ schema: z.literal("image_first_identity_v0"), run_id: z.string(), audits: z.array(z.unknown()).min(1).max(MAX_PARTS_PER_VIEWPORT * 2) });

/** The image-first hard fails the owner answers in addition to the design-image rubric's own (EvaluationSchema.hard_fails). */
export const IMAGE_FIRST_HARD_FAILS = ["not_a_website", "hero_only", "sp_not_independent", "other_shop", "fabricated_text"] as const;

/** The minimal view of the chosen direction this route reads (its full checks are checkDirectionSet's, run before). */
export const DirectionView = z.looseObject({ id: z.string().min(1).max(60), sections: z.array(z.looseObject({ id: Id })).min(3).max(12) });

/** Fixed reject codes (sorted in the verdict). */
export const REJECT_CODES = [
  "COMP_RECORD_INVALID",
  "COMP_PC_MISSING",
  "COMP_SP_MISSING",
  "COMP_SP_IS_PC_SCALED",
  "COMP_HERO_ONLY",
  "COMP_SECTION_SEQUENCE_INVALID",
  "COMP_SEAM_BROKEN",
  "COMP_COMPOSITE_OUT_OF_RANGE",
  "COMP_PART_UNDECODABLE",
  "COMP_NOT_MODEL_GENERATED",
  "COMP_NOT_A_WEBSITE",
  "COMP_IDENTITY_REJECT",
  "COMP_IDENTITY_HOLD",
  "COMP_PROVENANCE_MISSING",
  "COMP_SHA_MISMATCH",
  "COMP_TEXT_FABRICATED",
  "COMP_RIGHTS_MISSING",
  "COMP_GENERATION_UNAPPROVED",
  "COMP_VISUAL_READ_MISSING",
  "COMP_NOT_OWNER_APPROVED",
  "COMP_CROP_AS_ASSET",
  "ASSET_RIGHTS_MISSING",
  "CODEX_OUTCOME_INCONCLUSIVE",
  "CODEX_STOP_UNKNOWN",
] as const;

/**
 * The image call's fail-closed stop codes (image-once.ts; tests keep this list in step with that file). A record that
 * carries one is refused with that very code: no picture of a stopped run is ever a comp.
 */
export const CODEX_STOP_CODES = [
  "CODEX_NO_IMAGE",
  "CODEX_IMAGE_INVALID",
  "CODEX_IMAGE_UNSUPPORTED_FORMAT",
  "CODEX_QUOTA",
  "CODEX_IMAGE_TOOL_FAILED",
  "CODEX_TIMEOUT",
  "CODEX_EXEC_FAILED",
  "CODEX_NO_THREAD",
  "CODEX_NOT_SIGNED_IN",
  "CODEX_DOTENV_PRESENT",
  "CODEX_RESULT_DISCARDED_DOTENV",
  "CODEX_IMAGE_CALLS_EXCEEDED",
  "CODEX_IMAGE_COUNT_MISMATCH",
  "CODEX_SESSION_LOG_UNVERIFIED",
  // Issue #335: the image tool refused the call's arguments before it started (TOOL_REFUSED_ARGS)
  "CODEX_IMAGE_ARGS_REFUSED",
] as const;
export type RejectCode = (typeof REJECT_CODES)[number] | (typeof CODEX_STOP_CODES)[number];

/** Report-only warnings (never a reason to refuse). */
export const WARNING_CODES = ["IMAGE_MODEL_UNKNOWN", "SESSION_MODEL_UNKNOWN", "PART_UPSCALED_OVER_2X"] as const;
export type WarningCode = (typeof WARNING_CODES)[number];
