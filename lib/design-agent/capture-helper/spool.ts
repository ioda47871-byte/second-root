/**
 * The capture helper's spool (DEV-028 Phase 3): the ONLY interface between
 * the worker / Claude / Codex user (sr-designgen) and the Linux user that
 * holds the signed-in Instagram browser profile (sr-igcapture).
 *
 *   /srv/sr-capture/                 root, 0755
 *     requests/   sr-igcapture:sr-capture  3730  (group: create only; cannot
 *                 list, read or delete anything; sticky + setgid)
 *     results/    sr-igcapture:sr-capture  2750  (group: read only)
 *       <request_id>/  0750: status.json + at most 3 privacy-processed PNGs (0640)
 *
 * Both users are members of sr-capture: the requester writes requests 0640
 * (requester:sr-capture, setgid), the helper reads them through the group.
 * Requests are not secret (an id and a public URL); results are read-only
 * for the group.
 *
 * A request is a tiny JSON file naming ONE public Instagram profile URL and a
 * request id. That is all a requester can say: no path, no command, no
 * option, no output location. The helper answers with fixed codes, fixed file
 * names and PNGs that were privacy-processed before they ever touched a disk.
 * It never returns the profile, a cookie, a session value, page text or a URL.
 */
import { z } from "zod";

export const SPOOL_ROOT = "/srv/sr-capture";
export const REQUEST_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const REQUEST_FILE = /^([a-z0-9][a-z0-9-]{2,62})\.json$/;
export const MAX_REQUEST_BYTES = 4096;
/** The only file names a result may hold. */
export const RESULT_FILES = ["profile.png", "grid-top.png", "grid-lower.png"] as const;
export const MAX_RESULT_PNG_BYTES = 20 * 1024 * 1024;
export const MAX_STATUS_BYTES = 16 * 1024;

export const RequestSchema = z.strictObject({
  version: z.literal(1),
  request_id: z.string().regex(REQUEST_ID),
  kind: z.literal("instagram_profile"),
  url: z.string().max(200),
});
export type CaptureRequest = z.infer<typeof RequestSchema>;

export const STATUS_CODES = [
  "CAPTURED",
  "LOGIN_REQUIRED",
  "INSTAGRAM_CHALLENGE",
  "INSTAGRAM_CAPTCHA",
  "PUBLIC_SOURCE_UNAVAILABLE",
  "CAPTURE_FAILED",
  "BROWSER_BUSY",
  "RATE_CAPPED",
  "REQUEST_INVALID",
  "HELPER_ERROR",
] as const;
export type StatusCode = (typeof STATUS_CODES)[number];

export const StatusSchema = z.strictObject({
  version: z.literal(1),
  request_id: z.string().regex(REQUEST_ID),
  code: z.enum(STATUS_CODES),
  /** A fixed code (e.g. PRIVATE_OR_MISSING / HTTP_404 / NO_PROFILE), never text. */
  reason: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .optional(),
  files: z.array(z.enum(RESULT_FILES)).max(3),
  softened: z.number().int().min(0).max(10_000),
  finished_at: z.string().max(40),
});
export type CaptureStatus = z.infer<typeof StatusSchema>;

export const spoolDirs = (root: string) => ({ root, requests: `${root}/requests`, results: `${root}/results` });
