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
