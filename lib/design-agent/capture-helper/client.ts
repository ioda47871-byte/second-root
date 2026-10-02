/**
 * The requester side of the capture helper (DEV-028 Phase 3). Runs as the
 * worker / Claude user, which cannot read the Instagram browser profile at
 * all. It can only:
 *   - drop a request (an id and one public Instagram profile URL) into
 *     the spool's requests/ (create-only for it);
 *   - wait for results/<id>/status.json;
 *   - copy the privacy-processed PNGs named there (fixed names only) into a
 *     directory of its own choosing.
 * Everything read from the spool is opened without following links, size
 * capped, checked against a strict schema (status) or the PNG signature.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseInstagramProfileUrl } from "../worker/source-url";
import { MAX_RESULT_PNG_BYTES, MAX_STATUS_BYTES, REQUEST_ID, SPOOL_ROOT, spoolDirs, StatusSchema, type CaptureStatus, type StatusCode } from "./spool";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ClientCode = StatusCode | "CAPTURE_HELPER_UNAVAILABLE" | "CAPTURE_HELPER_TIMEOUT" | "CAPTURE_REQUEST_INVALID" | "CAPTURE_RESULT_INVALID";

export type ClientResult = { code: ClientCode; reason?: string; files: string[]; softened: number };

export interface RequestOptions {
  requestId: string;
  url: string;
  /** Where the PNGs are copied (created 0700 if missing). */
  destDir: string;
  spoolRoot?: string;
  timeoutMs?: number;
  pollMs?: number;
}

/** A small regular file, not a link, owned by `owner` (the helper, who owns results/). */
async function readSmall(path: string, max: number, owner: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max || info.uid !== owner) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Reads a result's status, or null while it is not there (or not readable yet). */
export async function readStatus(spoolRoot: string, requestId: string): Promise<CaptureStatus | null | "invalid"> {
  const results = await lstat(spoolDirs(spoolRoot).results).catch(() => null);
  if (!results || results.isSymbolicLink() || !results.isDirectory()) return null;
  const dir = join(spoolDirs(spoolRoot).results, requestId);
  const info = await lstat(dir).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o022) !== 0 || info.uid !== results.uid) return "invalid";
  const data = await readSmall(join(dir, "status.json"), MAX_STATUS_BYTES, results.uid).catch(() => null);
  if (!data) return null;
  try {
    const parsed = StatusSchema.safeParse(JSON.parse(data.toString("utf8")));
    return parsed.success && parsed.data.request_id === requestId ? parsed.data : "invalid";
  } catch {
    return "invalid";
  }
}

/** Puts a request in the spool and waits for the helper's answer. */
export async function requestCapture(options: RequestOptions): Promise<ClientResult> {
  const spoolRoot = options.spoolRoot ?? SPOOL_ROOT;
  const none = (code: ClientCode, reason?: string): ClientResult => ({ code, ...(reason ? { reason } : {}), files: [], softened: 0 });
  if (!REQUEST_ID.test(options.requestId)) return none("CAPTURE_REQUEST_INVALID");
  const source = parseInstagramProfileUrl(options.url);
  if (!source) return none("CAPTURE_REQUEST_INVALID");
  const dirs = spoolDirs(spoolRoot);
  const req = await lstat(dirs.requests).catch(() => null);
  if (!req || req.isSymbolicLink() || !req.isDirectory()) return none("CAPTURE_HELPER_UNAVAILABLE");

  // An answer for this id may exist already (a retry): use it. Otherwise ask.
  let status = await readStatus(spoolRoot, options.requestId);
  if (status === null) {
    const temp = join(dirs.requests, `.tmp-${options.requestId}-${process.pid}`);
    try {
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, request_id: options.requestId, kind: "instagram_profile", url: source.url }));
        // readable by the helper through the spool's group (the caller's umask would hide it)
        await handle.chmod(0o640);
      } finally {
        await handle.close();
      }
      await rename(temp, join(dirs.requests, `${options.requestId}.json`));
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
      return none("CAPTURE_HELPER_UNAVAILABLE");
    }
    const until = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    while (status === null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, options.pollMs ?? 2_000));
      status = await readStatus(spoolRoot, options.requestId);
    }
  }
  if (status === null) return none("CAPTURE_HELPER_TIMEOUT");
  if (status === "invalid") return none("CAPTURE_RESULT_INVALID");
  if (status.code !== "CAPTURED") return none(status.code, status.reason);

  await mkdir(options.destDir, { recursive: true, mode: 0o700 });
  const helperUid = (await lstat(dirs.results)).uid;
  const files: string[] = [];
  for (const name of status.files) {
    const data = await readSmall(join(dirs.results, options.requestId, name), MAX_RESULT_PNG_BYTES, helperUid).catch(() => null);
    if (!data || !data.subarray(0, PNG.length).equals(PNG)) return none("CAPTURE_RESULT_INVALID");
    const target = join(options.destDir, name);
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    files.push(target);
  }
  if (files.length === 0) return none("CAPTURE_RESULT_INVALID");
  return { code: "CAPTURED", files, softened: status.softened };
}
