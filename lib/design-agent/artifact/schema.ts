/**
 * DEV-114 Phase 2d-min: the common Design Artifact that carries a design from
 * the Codex lane to the Claude Code lane (docs/design/design-artifact-v1.md).
 *
 * Two kinds of data, kept apart by type and by field, never by searching text:
 * - `declared` — the design Codex produced (CodexDesign): Design DNA, the
 *   structure spec and, for routes B/C, the prototype HTML/CSS. Its schema has
 *   no state, approval or verification field at all, so Codex cannot declare
 *   one. Nothing in it is trusted: every reference is resolved by intake.
 * - `observed` — what the runner (a deterministic program, never Codex) saw:
 *   the files it wrote with their SHA-256, the generation facts, stop codes and
 *   missing items. Intake re-computes every file fact it can (SHA-256, size,
 *   PNG dimensions); generation facts it cannot re-compute are relayed as the
 *   runner's report, never as approval.
 *
 * There is no verification state and no approval in an artifact. Intake
 * (intake.ts) derives a verification state each time it runs; a person's
 * approval (G2, G3, G5, Identity Lock) is a separate mechanism that does not
 * exist yet, and nothing here can produce one.
 *
 * Pure: imports zod only.
 */
import { z } from "zod";

// ---- limits -------------------------------------------------------------------------------------

/** Viewports of a browser render (CSS px). Rendered at deviceScaleFactor 1 so CSS px = PNG px (Phase 2f). */
export const VIEWPORTS = { desktop_1440: 1440, mobile_390: 390 } as const;
export type ViewportKey = keyof typeof VIEWPORTS;
/** Same as comp-impl's MAX_PAGE_HEIGHT (render.ts); kept equal by a test, never imported (comp-impl stays untouched). */
export const MAX_RENDER_HEIGHT = 16000;

export type FileLimits = { maxBytes: number; minSide: number; maxSide: number; maxPixels: number };
const MiB = 1024 * 1024;
/**
 * PNG limits. Pixels bound the memory a later decode needs (RGBA: 4 bytes a pixel, so at most
 * 1440 × 16000 × 4 ≈ 92 MB for a desktop render); intake itself never decodes pixels.
 */
export const PNG_LIMITS = {
  viewport_render_desktop_1440: { maxBytes: 24 * MiB, minSide: 1, maxSide: MAX_RENDER_HEIGHT, maxPixels: 1440 * MAX_RENDER_HEIGHT },
  viewport_render_mobile_390: { maxBytes: 12 * MiB, minSide: 1, maxSide: MAX_RENDER_HEIGHT, maxPixels: 390 * MAX_RENDER_HEIGHT },
  /** The image tool's outputs (about 1024–1536 a side); same numbers as design-image's MOCKUP_PNG_LIMITS. */
  concept_image: { maxBytes: 24 * MiB, minSide: 512, maxSide: 8192, maxPixels: 40_000_000 },
  asset: { maxBytes: 16 * MiB, minSide: 16, maxSide: 8192, maxPixels: 40_000_000 },
} as const satisfies Record<string, FileLimits>;

/** Prototype text limits. Codex returns HTML/CSS in its answer, which codex.ts caps at 1 MiB (kept equal by a test). */
export const CODEX_ANSWER_MAX_BYTES = 1024 * 1024;
export const PROTOTYPE_LIMITS = { html: 384 * 1024, css: 256 * 1024 } as const;
export const PACKAGE_LIMITS = { artifactJsonBytes: MiB, factsJsonBytes: MiB, maxFiles: 32, maxEntries: 64, totalBytes: 96 * MiB, maxDepth: 3 } as const;

// ---- shared vocabularies -------------------------------------------------------------------------

/** Stop classes of the design-image PoC (run.ts PocStopClass), kept equal by a test. */
export const STOP_CLASSES = ["approval", "input", "environment", "capability", "transient", "inconclusive", "request", "output", "interrupted"] as const;
/** Image tool outcomes (capability.ts IMAGE_OUTCOMES), kept equal by a test; `not_applicable` for a run without the image tool. */
export const IMAGE_OUTCOMES = [
  "IMAGE_SAVED",
  "NO_SESSION_LOG",
  "TOOL_NOT_CALLED",
  "TOOL_NOT_SEEN_CODE_MODE",
  "TOOL_FAILED_USAGE_LIMIT",
  "TOOL_FAILED_POLICY",
  "TOOL_FAILED_UNSUPPORTED",
  "TOOL_FAILED",
  "TOOL_FAILED_TRANSIENT",
  "TOOL_CALLED_NO_FILE",
  "not_applicable",
] as const;
export const DNA_PARTS = ["hero", "typography", "palette", "product_visual", "section_rhythm", "navigation", "mobile", "implementation"] as const;
export const SECTION_ROLES = ["header", "hero", "products", "story", "info", "cta", "footer", "other"] as const;

const unsafeText = /[\u0000-\u0009\u000b-\u001f\u007f]|<<<|>>>|<\s*\/?\s*[a-z!]/i;
export const Text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !unsafeText.test(s), "unsafe_text");
const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const FactId = z.string().regex(/^F\d{1,3}$/);
const SectionId = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const AssetId = z.string().regex(/^A\d{1,2}$/);
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/);
const Px = z.number().int().nonnegative().max(MAX_RENDER_HEIGHT);
/** A package-relative path: plain segments only, no `.`/`..`, no absolute path, no backslash, at most 3 deep. */
export const RelPath = z
  .string()
  .max(160)
  // a segment starts with a letter, digit or underscore: never "-" (option injection when a later tool gets the path)
  .regex(/^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}\/){0,2}[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/)
  .refine((p) => p.split("/").every((s) => s !== "." && s !== ".." && !s.endsWith(".")), "path_segment");

// ---- facts pack (input; its SHA-256 is pinned in the artifact) ---------------------------------

export const FactsPack = z.strictObject({
  schema: z.literal("shop_facts_pack_v1"),
  shop_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/),
  facts: z
    .array(z.strictObject({ id: FactId, key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), value: Text(400), source_id: z.string().regex(/^S\d{1,3}$/) }))
    .min(1)
    .max(200),
});
export type FactsPack = z.infer<typeof FactsPack>;

// ---- what Codex declares (the only shape Codex's answer may have) -------------------------------

/** A section's box at one viewport. w = 0 or h = 0 means the section is not shown at that viewport (a legitimate design choice). */
const Box = z.strictObject({ x: Px, y: Px, w: Px, h: Px });
const LiveText = z.union([z.strictObject({ fact_ref: FactId }), z.strictObject({ ui_label: Text(40) })]);

export const StructureSpec = z.strictObject({
  page_height: z.strictObject({ desktop_1440: Px.refine((n) => n > 0), mobile_390: Px.refine((n) => n > 0) }),
  sections: z
    .array(
      z.strictObject({
        id: SectionId,
        role: z.enum(SECTION_ROLES),
        boxes: z.strictObject({ desktop_1440: Box, mobile_390: Box }),
        live_text: z.array(LiveText).max(40),
        asset_refs: z.array(AssetId).max(8),
      }),
    )
    .min(1)
    .max(30),
  order: z.strictObject({ desktop_1440: z.array(SectionId).min(1).max(30), mobile_390: z.array(SectionId).min(1).max(30) }),
  reading_path: z.strictObject({ desktop_1440: z.array(SectionId).min(1).max(30), mobile_390: z.array(SectionId).min(1).max(30) }),
});
export type StructureSpec = z.infer<typeof StructureSpec>;

/**
 * The design Codex returns (its whole answer for routes A/B/C). No state, approval, verification or file field:
 * Codex cannot claim a file, a SHA, a check or an approval because the shape has nowhere to put one.
 */
export const CodexDesign = z.strictObject({
  schema: z.literal("codex_design_v1"),
  design_dna: z.strictObject(Object.fromEntries(DNA_PARTS.map((p) => [p, z.strictObject({ choice: Text(400), fact_refs: z.array(FactId).min(1).max(10) })])) as Record<
    (typeof DNA_PARTS)[number],
    z.ZodObject<{ choice: z.ZodString; fact_refs: z.ZodArray<z.ZodString> }>
  >),
  structure_spec: StructureSpec,
  /** Interactions are not part of 2d-min: only an empty list is accepted. */
  interaction_spec: z.array(z.never()).max(0),
  /** Routes B/C: the prototype as text. The runner writes it to quarantine/; it is never handed to the implementation lane. */
  prototype: z.strictObject({ html: z.string().min(1).max(PROTOTYPE_LIMITS.html), css: z.string().max(PROTOTYPE_LIMITS.css) }).nullable(),
});
export type CodexDesign = z.infer<typeof CodexDesign>;

/** The design as stored in an artifact: the prototype text is replaced by the runner's file record (observed). */
export const DeclaredDesign = CodexDesign.omit({ prototype: true });

// ---- what the runner observed -------------------------------------------------------------------

const ROLES = ["original", "asset", "prototype"] as const;
export const ObservedFile = z.strictObject({ path: RelPath, role: z.enum(ROLES), sha256: Sha, bytes: z.number().int().positive() });

const Original = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("present"),
    path: RelPath,
    /** viewport_render: a browser render at exactly the viewport width; concept_image: an image tool picture, not a render. */
    kind: z.enum(["viewport_render", "concept_image"]),
    rendered_from: z.enum(["html_prototype_screenshot", "image_tool", "owner_upload"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.strictObject({ state: z.enum(["missing", "generation_failed"]) }),
]);

const RenderConditions = z.strictObject({
  device_scale_factor: z.literal(1),
  javascript: z.literal("disabled"),
  network: z.literal("blocked"),
  full_page: z.literal(true),
});

const Stop = z.strictObject({ code: Code, class: z.enum(STOP_CLASSES), stage: z.enum(["preflight", "generation", "render", "write", "intake"]) });

/**
 * Phase 2d (DEV-127, research-isolated): the results of the checks the runner made on the design, recorded as data.
 * Optional, so every v1 record stays valid. None of them is an approval: the structure check is advisory (provisional
 * vocabulary, Phase 2b) and the identity check only says whether the page is this shop (Phase 2c). Intake never lets
 * them raise a state; an identity result other than PASS_IDENTITY_ONLY makes the artifact incomplete.
 */
const CodeList = z.array(Code).max(20);
export const RecordedChecks = z.strictObject({
  structure: z
    .strictObject({
      vocabulary: z.literal("structure_descriptor_v0"),
      findings: CodeList,
      /** The highest similarity to a reference or sibling compared, if any (0..1). */
      max_similarity: z.number().min(0).max(1).nullable(),
      advisory: z.literal(true),
    })
    .nullable(),
  identity: z
    .strictObject({
      status: z.enum(["REJECT", "HOLD", "PASS_IDENTITY_ONLY"]),
      errors: CodeList,
      pending: CodeList,
      counts_as_owner_success: z.literal(false),
    })
    // the status must be the one its codes give (REJECT with errors, HOLD with only pending codes, PASS with none)
    .refine((i) => i.status === (i.errors.length ? "REJECT" : i.pending.length ? "HOLD" : "PASS_IDENTITY_ONLY"), "identity_status_inconsistent")
    .nullable(),
  /**
   * DEV-134: the phone (SP 390) checks of the rendered prototype (phase2f mobile-quality, report-only). Optional, so
   * every earlier record stays valid; intake shows its findings as a warning and never lets them change the state.
   */
  mobile: z
    .strictObject({
      viewport: z.literal("mobile_390"),
      findings: CodeList,
      counts: z.strictObject({
        text_nodes: z.number().int().nonnegative(),
        text_nodes_with_problems: z.number().int().nonnegative(),
        tap_targets: z.number().int().nonnegative(),
        tap_targets_below_recommended: z.number().int().nonnegative(),
        tap_targets_below_minimum: z.number().int().nonnegative(),
      }),
      advisory: z.literal(true),
    })
    .nullable()
    .optional(),
});

export const Generation = z.strictObject({
  /** The runner's report of how the run ended; `unknown` and null fields are never a success. */
  status: z.enum(["succeeded", "stopped", "unknown"]),
  tool: z.literal("codex_cli").nullable(),
  tool_version: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/).nullable(),
  model_reported: z.string().regex(/^[0-9A-Za-z._-]{1,60}$/).nullable(),
  /** The one-use approval ID the run was started under (format only: intake never treats it as an approval). */
  approval_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{3,95}$/).nullable(),
  prompt_sha256: Sha.nullable(),
  worker_commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  run_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/).nullable(),
  started_at: z.iso.datetime().nullable(),
  finished_at: z.iso.datetime().nullable(),
  image_outcome: z.enum(IMAGE_OUTCOMES),
});

export const DesignArtifact = z.strictObject({
  schema: z.literal("design_artifact_v1"),
  artifact_id: z.string().regex(/^DA-\d{8}-[a-z0-9]{6}$/),
  route: z.enum(["A_image", "B_html_prototype", "C_hybrid"]),
  source_kind: z.enum(["codex_generated", "chatgpt_owner_upload_compat"]),
  shop: z.strictObject({ shop_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/), display_name: Text(120) }),
  facts_pack_sha256: Sha,
  declared: DeclaredDesign,
  observed: z.strictObject({
    files: z.array(ObservedFile).max(PACKAGE_LIMITS.maxFiles),
    originals: z.strictObject({ desktop_1440: Original, mobile_390: Original }),
    render: RenderConditions.nullable(),
    assets: z
      .array(
        z.strictObject({
          id: AssetId,
          path: RelPath,
          kind: z.enum(["ai_concept", "placeholder"]),
          /** Each generated asset (route C) is its own approved run. */
          approval_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{3,95}$/).nullable(),
          use: z.literal("design_only"),
        }),
      )
      .max(8),
    prototype: z.strictObject({ html_path: RelPath, css_path: RelPath }).nullable(),
    /**
     * Set by the runner when a route C run's image generation failed and it explicitly delivered the route B
     * artifact instead. The failed attempt is kept, never turned into a success. Allowed only when the image was
     * not essential to the design (the runner decides; an essential image means re-generate or ask the owner).
     */
    fallback: z
      .strictObject({
        from_route: z.literal("C_hybrid"),
        // a policy refusal is a safety stop, never a reason to switch routes: it goes to the owner, not to a fallback
        image_outcome: z.enum(IMAGE_OUTCOMES.filter((o) => o !== "IMAGE_SAVED" && o !== "not_applicable" && o !== "TOOL_FAILED_POLICY") as [string, ...string[]]),
        image_stop_code: Code.nullable(),
        image_approval_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{3,95}$/).nullable(),
        image_essential: z.literal(false),
        decided_by: z.literal("runner"),
      })
      .nullable()
      .optional(),
    generation: Generation,
    checks: RecordedChecks.optional(),
    stops: z.array(Stop).max(20),
    missing: z.array(z.strictObject({ item: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/), reason: Text(200) })).max(40),
  }),
});
export type DesignArtifact = z.infer<typeof DesignArtifact>;
