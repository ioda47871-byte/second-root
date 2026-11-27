/**
 * Issue #380 live trial (owner 2026-11-27): a LOCAL, READ-ONLY measurement tool for the Pages CMS + GitHub +
 * Cloudflare Pages trial with the fictional car-care shop. It never signs in, never sends credentials, never writes to
 * the site or the repository; it only GETs the public URL it is given, or reads a local checkout.
 *
 *   npx tsx experiments/pages-cms/live-trial-measure.ts wait --url <https page> --marker <text> --timeout <s> [--interval <s ≥ 2>]
 *       poll the page (cache-busting, no-cache) until the text appears; prints the time it took
 *   npx tsx experiments/pages-cms/live-trial-measure.ts images --url <https page> [--min-images <n>]
 *       every <img> of the page (same origin only): HTTP status, bytes, format, pixel size, EXIF / GPS / orientation
 *   npx tsx experiments/pages-cms/live-trial-measure.ts originals --repo <local checkout of the trial repository>
 *       every file in media/: bytes, format, pixel size, EXIF / GPS — the ORIGINALS as uploaded (the build publishes
 *       fitted copies without metadata; the originals stay in the repository as the customer's phone sent them)
 *
 * Output: one JSON document on stdout. Exit 0 = measured and complete (wait: found); 1 = wait timed out, or `images`
 * could not measure everything (kit review M1: a picture that is not HTTP 200, not a JPEG / PNG / WebP, or whose
 * metadata cannot be read is listed under `failures`, never counted as "no GPS"; no picture at all, or fewer than
 * --min-images, is a failure too); 2 = refused / failed.
 * URL rule: https only (http only for 127.0.0.1 / localhost, which the tests use); redirects are followed by hand
 * (at most 5) and only to the same origin (kit review L1). Bounded while reading: page ≤ 5 MB, image ≤ 40 MB,
 * ≤ 200 images, 30 s per request.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hasGps, scanMeta } from "./exif-scan";
import { imageMeta } from "./image-meta";

export const LIMITS = { pageBytes: 5 * 1024 * 1024, imageBytes: 40 * 1024 * 1024, images: 200, requestMs: 30_000, redirects: 5, minIntervalS: 2 } as const;

export class MeasureError extends Error {
  constructor(
    readonly code: "MEASURE_URL_REFUSED" | "MEASURE_FETCH_FAILED" | "MEASURE_TOO_LARGE" | "MEASURE_REDIRECT_REFUSED" | "MEASURE_REPO_INVALID" | "MEASURE_ARGS_INVALID",
    detail: string,
  ) {
    super(`${code} ${detail}`);
    this.name = "MeasureError";
  }
}

/** https, or http on the local machine (tests); no credentials in the URL. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new MeasureError("MEASURE_URL_REFUSED", "not a URL");
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && local))) throw new MeasureError("MEASURE_URL_REFUSED", u.origin);
  return u;
}

type Fetch = typeof fetch;

/** Reads a response body, stopping as soon as it passes `max` bytes. */
async function readCapped(r: Response, max: number, what: string): Promise<Buffer> {
  const declared = Number(r.headers.get("content-length") ?? "0");
  if (declared > max) throw new MeasureError("MEASURE_TOO_LARGE", what);
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new MeasureError("MEASURE_TOO_LARGE", what);
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

/** GET with redirects followed by hand, each target checked (same origin as `origin`, the URL rule). */
async function get(url: URL, max: number, origin: string, f: Fetch = fetch): Promise<{ status: number; body: Buffer; type: string; finalUrl: string }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIMITS.requestMs);
    try {
      let r: Response;
      try {
        r = await f(current, { method: "GET", headers: { "cache-control": "no-cache", pragma: "no-cache" }, redirect: "manual", signal: ctrl.signal, credentials: "omit" });
      } catch {
        throw new MeasureError("MEASURE_FETCH_FAILED", current.pathname);
      }
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        await r.body?.cancel().catch(() => undefined);
        if (hop >= LIMITS.redirects) throw new MeasureError("MEASURE_REDIRECT_REFUSED", "too many redirects");
        let next: URL;
        try {
          next = checkUrl(new URL(r.headers.get("location")!, current).href);
        } catch {
          throw new MeasureError("MEASURE_REDIRECT_REFUSED", "to a refused URL");
        }
        if (next.origin !== origin) throw new MeasureError("MEASURE_REDIRECT_REFUSED", next.origin);
        current = next;
        continue;
      }
      const body = await readCapped(r, max, current.pathname).catch((error: unknown) => {
        if (error instanceof MeasureError) throw error;
        throw new MeasureError("MEASURE_FETCH_FAILED", current.pathname);
      });
      return { status: r.status, body, type: r.headers.get("content-type") ?? "", finalUrl: current.href };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The page with a cache-busting query (each poll sees the current deployment, not a cached copy). */
const busted = (u: URL, n: number) => {
  const c = new URL(u);
  c.searchParams.set("sr_trial", String(n));
  return c;
};

/** Kit review L2: a finite interval of at least 2 s and a finite timeout (both in ms here). */
function checkTiming(intervalMs: number, timeoutMs: number) {
  if (!Number.isFinite(intervalMs) || intervalMs < LIMITS.minIntervalS * 1000) throw new MeasureError("MEASURE_ARGS_INVALID", `--interval (at least ${LIMITS.minIntervalS} s)`);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new MeasureError("MEASURE_ARGS_INVALID", "--timeout");
}

/** Polls until the marker text is in the page; elapsed from the call. */
export async function waitForMarker(o: { url: string; marker: string; intervalMs: number; timeoutMs: number; fetchImpl?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
  const url = checkUrl(o.url);
  if (!o.marker) throw new MeasureError("MEASURE_ARGS_INVALID", "marker");
  checkTiming(o.intervalMs, o.timeoutMs);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let attempts = 0;
  const errors: string[] = [];
  for (;;) {
    attempts++;
    try {
      const r = await get(busted(url, attempts), LIMITS.pageBytes, url.origin, o.fetchImpl);
      if (r.status === 200 && r.body.toString("utf8").includes(o.marker)) {
        return { status: "found" as const, url: url.href, marker: o.marker, elapsed_ms: now() - start, attempts, started_at: new Date(start).toISOString(), found_at: new Date(now()).toISOString(), errors };
      }
      if (r.status !== 200) errors.push(`HTTP ${r.status}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "error");
    }
    if (now() - start + o.intervalMs > o.timeoutMs) return { status: "timeout" as const, url: url.href, marker: o.marker, elapsed_ms: now() - start, attempts, started_at: new Date(start).toISOString(), errors };
    await sleep(o.intervalMs);
  }
}

export type ImageReport = { src: string; status: number; bytes: number; format: string | null; width: number | null; height: number | null; exif: boolean; gps: boolean; orientation: number | null; unknown: string[] };

function describe(src: string, status: number, b: Buffer): ImageReport {
  const meta = imageMeta(b);
  const m = scanMeta(b);
  return { src, status, bytes: b.length, format: meta?.format ?? null, width: meta?.width ?? null, height: meta?.height ?? null, exif: m.exif || m.xmp, gps: hasGps(m), orientation: m.orientation, unknown: m.unknown };
}

/** Why a picture could not be measured (kit review M1), or null when it was. */
function problemOf(i: ImageReport): string | null {
  if (i.status !== 200) return `HTTP ${i.status}`;
  if (i.format === null) return "not a JPEG / PNG / WebP";
  if (i.unknown.length) return `metadata not readable: ${i.unknown.join(", ")}`;
  return null;
}

/** The page's <img> sources, resolved, same origin only (others are listed as skipped). */
export function imageSources(html: string, base: URL): { same: URL[]; skipped: string[] } {
  const same: URL[] = [];
  const skipped: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const raw = (m[2] ?? m[3] ?? "").replace(/&amp;/g, "&");
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      skipped.push(raw);
      continue;
    }
    if (u.origin !== base.origin) skipped.push(raw);
    else if (!same.some((x) => x.href === u.href)) same.push(u);
  }
  return { same, skipped };
}

/** Every published picture of the page: size and metadata; what could not be measured is a failure. */
export async function scanPublished(o: { url: string; minImages?: number; fetchImpl?: Fetch }) {
  const url = checkUrl(o.url);
  const page = await get(busted(url, 0), LIMITS.pageBytes, url.origin, o.fetchImpl);
  const failures: { src: string; problem: string }[] = [];
  if (page.status !== 200) failures.push({ src: url.pathname, problem: `page HTTP ${page.status}` });
  const { same, skipped } = imageSources(page.status === 200 ? page.body.toString("utf8") : "", url);
  if (same.length > LIMITS.images) throw new MeasureError("MEASURE_TOO_LARGE", "images");
  const images: ImageReport[] = [];
  for (const u of same) {
    try {
      const r = await get(u, LIMITS.imageBytes, url.origin, o.fetchImpl);
      const d = describe(u.pathname, r.status, r.body);
      images.push(d);
      const p = problemOf(d);
      if (p) failures.push({ src: d.src, problem: p });
    } catch (error) {
      failures.push({ src: u.pathname, problem: error instanceof Error ? error.message : "fetch failed" });
    }
  }
  const measured = images.filter((i) => problemOf(i) === null);
  if (measured.length === 0) failures.push({ src: url.pathname, problem: "no picture measured" });
  if (o.minImages !== undefined && measured.length < o.minImages) failures.push({ src: url.pathname, problem: `${measured.length} pictures measured, fewer than ${o.minImages}` });
  return {
    status: failures.length ? ("incomplete" as const) : ("measured" as const),
    url: url.href,
    page_status: page.status,
    count: { found: same.length, measured: measured.length, failed: failures.length },
    images,
    failures,
    skipped,
    with_gps: measured.filter((i) => i.gps).map((i) => i.src),
    with_metadata: measured.filter((i) => i.exif).map((i) => i.src),
  };
}

/** Every original in a local checkout's media/ (read only), and whether the content references it. */
export async function scanOriginals(o: { repo: string }) {
  const media = join(o.repo, "media");
  const st = await lstat(media).catch(() => null);
  if (!st || !st.isDirectory()) throw new MeasureError("MEASURE_REPO_INVALID", "media/");
  const referenced = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".json")) for (const m of (await readFile(p, "utf8")).matchAll(/"\/media\/([^"\\/]+)"/g)) referenced.add(m[1]!);
    }
  };
  await walk(join(o.repo, "content"), 0);
  const files: (Omit<ImageReport, "src" | "status"> & { file: string; referenced: boolean })[] = [];
  for (const e of (await readdir(media, { withFileTypes: true })).filter((x) => x.isFile()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const b = await readFile(join(media, e.name));
    const d = describe(e.name, 0, b);
    files.push({ file: e.name, referenced: referenced.has(e.name), bytes: d.bytes, format: d.format, width: d.width, height: d.height, exif: d.exif, gps: d.gps, orientation: d.orientation, unknown: d.unknown });
  }
  return {
    status: "measured" as const,
    repo: o.repo,
    files,
    with_gps: files.filter((f) => f.gps).map((f) => f.file),
    with_metadata: files.filter((f) => f.exif).map((f) => f.file),
    // kit review L3: files whose metadata this tool cannot read (HEIC, other formats, unreadable chunks) — check by hand
    unscannable: files.filter((f) => f.unknown.length).map((f) => ({ file: f.file, why: f.unknown })),
  };
}

const seconds = (v: string | undefined) => (v === undefined || v.trim() === "" ? Number.NaN : Number(v));

/** The command line (exported for the tests). */
export async function main(argv: string[], fetchImpl?: Fetch): Promise<{ code: number; out: unknown }> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const cmd = argv[0];
    if (cmd === "wait") {
      const url = arg("--url");
      const marker = arg("--marker");
      if (!url || !marker) throw new MeasureError("MEASURE_ARGS_INVALID", "--url --marker");
      const intervalS = arg("--interval") === undefined ? 10 : seconds(arg("--interval"));
      const timeoutS = seconds(arg("--timeout"));
      const r = await waitForMarker({ url, marker, intervalMs: intervalS * 1000, timeoutMs: timeoutS * 1000, ...(fetchImpl ? { fetchImpl } : {}) });
      return { code: r.status === "found" ? 0 : 1, out: r };
    }
    if (cmd === "images") {
      const url = arg("--url");
      if (!url) throw new MeasureError("MEASURE_ARGS_INVALID", "--url");
      const minRaw = arg("--min-images");
      const min = minRaw === undefined ? undefined : Number(minRaw);
      if (min !== undefined && !(Number.isInteger(min) && min >= 0)) throw new MeasureError("MEASURE_ARGS_INVALID", "--min-images");
      const r = await scanPublished({ url, ...(min !== undefined ? { minImages: min } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
      return { code: r.status === "measured" ? 0 : 1, out: r };
    }
    if (cmd === "originals") {
      const repo = arg("--repo");
      if (!repo) throw new MeasureError("MEASURE_ARGS_INVALID", "--repo");
      return { code: 0, out: await scanOriginals({ repo }) };
    }
    throw new MeasureError("MEASURE_ARGS_INVALID", String(cmd));
  } catch (error) {
    return { code: 2, out: { status: "refused", code: error instanceof MeasureError ? error.code : "MEASURE_FAILED", detail: error instanceof Error ? error.message : "" } };
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(({ code, out }) => {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(code);
  });
}
