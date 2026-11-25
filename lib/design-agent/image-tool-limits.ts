/**
 * Issue #335 / docs/design/image-first-production-flow.md §3.5, §6.1 row 1: the image tool takes at most this many
 * reference pictures per call (rust-v0.159.0 ext/image-generation/src/tool.rs MAX_EDIT_IMAGES: "`referenced_image_paths`
 * must contain at most 5 paths", refused before the call starts and leaving no record).
 *
 * One constant, no imports, outside both the image PoC's module and the IMAGE_FIRST contract so that each may read it
 * without importing the other: the request check (PHOTO_INPUTS_OVER_TOOL_LIMIT) and the one-run batch call's own guard
 * on its input images share this value and cannot drift apart.
 */
export const IMAGE_TOOL_MAX_REFS = 5;

/**
 * DEV-303 §6.1 row 3 (docs/design/image-first-production-flow.md §3.5): the image tool's `referenced_image_paths` takes
 * ABSOLUTE paths only, and the reference pictures are staged into the run's temporary work dir only when the run starts
 * (image-once.ts), long after the request's prompt was built and pinned. The pinned prompt therefore names each staged
 * reference as `<REFERENCE_DIR_TOKEN>/ref-N.<ext>`; image-once.ts replaces the token with the absolute staged inputs
 * directory right before the one `codex exec` (and nowhere else: the pinned prompt, its SHA-256 and the run's records
 * keep the token, never a path). A plain ASCII marker that no facts value, direction text or label can contain.
 */
export const REFERENCE_DIR_TOKEN = "@@SR_REFERENCE_DIR@@";
/** The staged name of the n-th reference picture (ref-<n>.<png|jpg|webp>, n = 1..IMAGE_TOOL_MAX_REFS), by content type. */
export const isReferenceName = (name: string): boolean => {
  const m = /^ref-([1-9][0-9]*)\.(?:png|jpg|webp)$/.exec(name);
  return !!m && Number(m[1]) <= IMAGE_TOOL_MAX_REFS;
};
