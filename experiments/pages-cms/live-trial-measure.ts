/**
 * Issue #380 live trial (owner 2026-11-27): a LOCAL, READ-ONLY measurement tool for the Pages CMS + GitHub +
 * Cloudflare Pages trial with the fictional car-care shop. It never signs in, never sends credentials, never writes to
 * the site or the repository; it only GETs the public URL it is given, or reads a local checkout.
 *
 *   npx tsx experiments/pages-cms/live-trial-measure.ts wait --url <https page> --marker <text> [--interval 10] [--timeout 900]
 *       poll the page (cache-busting query, no-cache) until the text appears; prints the time it took
 *   npx tsx experiments/pages-cms/live-trial-measure.ts images --url <https page>
 *       every <img> of the page (same origin only): bytes, format, pixel size, EXIF / GPS / orientation
 *   npx tsx experiments/pages-cms/live-trial-measure.ts originals --repo <local checkout of the trial repository>
 *       every file in media/: bytes, format, pixel size, EXIF / GPS — the ORIGINALS as uploaded (the build publishes
 *       fitted copies without metadata; the originals stay in the repository as the customer's phone sent them)
 *
 * Output: one JSON document on stdout. Exit 0 = measured (wait: found), 1 = wait timed out, 2 = refused / failed.
 * URL rule: https only (http only for 127.0.0.1 / localhost, which the tests use). Bounded: page ≤ 5 MB, image ≤ 40 MB,
 * ≤ 200 images, 30 s per request.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hasGps, scanMeta } from "./exif-scan";
import { imageMeta } from "./image-meta";

export const LIMITS = { pageBytes: 5 * 1024 * 1024, imageBytes: 40 * 1024 * 1024, images: 200, requestMs: 30_000 } as const;

export class MeasureError extends Error {
  constructor(
    readonly code: "MEASURE_URL_REFUSED" | "MEASURE_FETCH_FAILED" | "MEASURE_TOO_LARGE" | "MEASURE_REPO_INVALID" | "MEASURE_ARGS_INVALID",
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
async function get(url: URL, max: number, f: Fetch = fetch): Promise<{ status: number; body: Buffer }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMITS.requestMs);
  try {
    const r = await f(url, { method: "GET", headers: { "cache-control": "no-cache", pragma: "no-cache" }, redirect: "follow", signal: ctrl.signal, credentials: "omit" });
    const declared = Number(r.headers.get("content-length") ?? "0");
    if (declared > max) throw new MeasureError("MEASURE_TOO_LARGE", url.pathname);
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > max) throw new MeasureError("MEASURE_TOO_LARGE", url.pathname);
    return { status: r.status, body };
  } catch (error) {
    if (error instanceof MeasureError) throw error;
    throw new MeasureError("MEASURE_FETCH_FAILED", url.pathname);
  } finally {
    clearTimeout(timer);
  }
}

/** The page with a cache-busting query (each poll sees the current deployment, not a cached copy). */
const busted = (u: URL, n: number) => {
  const c = new URL(u);
  c.searchParams.set("sr_trial", String(n));
  return c;
};

/** Polls until the marker text is in the page; elapsed from the call. */
export async function waitForMarker(o: { url: string; marker: string; intervalMs?: number; timeoutMs?: number; fetchImpl?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
  const url = checkUrl(o.url);
  if (!o.marker) throw new MeasureError("MEASURE_ARGS_INVALID", "marker");
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = o.intervalMs ?? 10_000;
  const timeout = o.timeoutMs ?? 900_000;
  const start = now();
  let attempts = 0;
  const errors: string[] = [];
  for (;;) {
    attempts++;
    try {
      const r = await get(busted(url, attempts), LIMITS.pageBytes, o.fetchImpl);
      if (r.status === 200 && r.body.toString("utf8").includes(o.marker)) {
        return { status: "found" as const, url: url.href, marker: o.marker, elapsed_ms: now() - start, attempts, started_at: new Date(start).toISOString(), found_at: new Date(now()).toISOString(), errors };
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "error");
    }
    if (now() - start + interval > timeout) return { status: "timeout" as const, url: url.href, marker: o.marker, elapsed_ms: now() - start, attempts, started_at: new Date(start).toISOString(), errors };
    await sleep(interval);
  }
}

export type ImageReport = { src: string; status: number; bytes: number; format: string | null; width: number | null; height: number | null; exif: boolean; gps: boolean; orientation: number | null };

function describe(src: string, status: number, b: Buffer): ImageReport {
  const meta = imageMeta(b);
  const m = scanMeta(b);
  return { src, status, bytes: b.length, format: meta?.format ?? null, width: meta?.width ?? null, height: meta?.height ?? null, exif: m.exif || m.xmp, gps: hasGps(m), orientation: m.orientation };
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

/** Every published picture of the page: size and metadata. */
export async function scanPublished(o: { url: string; fetchImpl?: Fetch }) {
  const url = checkUrl(o.url);
  const page = await get(busted(url, 0), LIMITS.pageBytes, o.fetchImpl);
  const { same, skipped } = imageSources(page.body.toString("utf8"), url);
  if (same.length > LIMITS.images) throw new MeasureError("MEASURE_TOO_LARGE", "images");
  const images: ImageReport[] = [];
  for (const u of same) {
    const r = await get(u, LIMITS.imageBytes, o.fetchImpl);
    images.push(describe(u.pathname, r.status, r.body));
  }
  return { status: "measured" as const, url: url.href, page_status: page.status, images, skipped, with_gps: images.filter((i) => i.gps).map((i) => i.src), with_metadata: images.filter((i) => i.exif).map((i) => i.src) };
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
    files.push({ file: e.name, referenced: referenced.has(e.name), bytes: d.bytes, format: d.format, width: d.width, height: d.height, exif: d.exif, gps: d.gps, orientation: d.orientation });
  }
  return { status: "measured" as const, repo: o.repo, files, with_gps: files.filter((f) => f.gps).map((f) => f.file), with_metadata: files.filter((f) => f.exif).map((f) => f.file) };
}

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
      const r = await waitForMarker({ url, marker, intervalMs: Number(arg("--interval") ?? 10) * 1000, timeoutMs: Number(arg("--timeout") ?? 900) * 1000, ...(fetchImpl ? { fetchImpl } : {}) });
      return { code: r.status === "found" ? 0 : 1, out: r };
    }
    if (cmd === "images") {
      const url = arg("--url");
      if (!url) throw new MeasureError("MEASURE_ARGS_INVALID", "--url");
      return { code: 0, out: await scanPublished({ url, ...(fetchImpl ? { fetchImpl } : {}) }) };
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
