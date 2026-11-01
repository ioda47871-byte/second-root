// DEV-142 (Issue #180): helpers for the MOCK end-to-end run of the three methods. A test helper, never lib.
// Everything here is MOCK: nothing calls Codex, an image tool, the network or a paid API, and nothing here is a
// quality check of its own (the unsourced-line count below is the design-director evaluation's counting rule, kept
// here in the study's test and recorded only, never registered as a check or a gate).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Browser } from "playwright";
import { LIMITS } from "@/lib/design-agent/loop/controller";

export const REPO = resolve(__dirname, "../../../..");
export const STUDY = "design-library/research/three-methods";
export const MOCK = `${STUDY}/mock`;
export const readRepo = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export type Method = "VISUAL_FIRST" | "LAYOUT_FIRST" | "DIRECTION_FIRST";
export type Page = { html: string; css: string; assets: ReadonlyMap<string, Buffer> };

/** Where the generated PNGs and records go: THREE_METHODS_MOCK_OUT when given (it must not hold an earlier run), else a new temp dir. */
export function outDir(): { dir: string; temp: boolean } {
  const given = process.env.THREE_METHODS_MOCK_OUT;
  if (given) {
    if (existsSync(given) && readdirSync(given).length > 0) throw new Error("THREE_METHODS_MOCK_OUT must be a new or empty directory");
    mkdirSync(given, { recursive: true });
    return { dir: resolve(given), temp: false };
  }
  return { dir: mkdtempSync(join(tmpdir(), "dev142-mock-")), temp: true };
}

/**
 * The MOCK asset: one solid-colour RGB PNG made here, with a tEXt chunk saying so. It stands in for an image the
 * method would ask Codex for; it is not a generated image and is never counted as one.
 */
export function mockPng(w: number, h: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  const text = Buffer.from("Description\0MOCK solid-colour stand-in (DEV-142); not a generated image", "latin1");
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("tEXt", text), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * The generation facts the fake design port reports, so the runner's intake can derive its state. The values only
 * have the format intake checks; none is an approval, a real commit or a real model (intake never treats them as
 * approval either). The run record keeps approval_id null for the same reason. The package's artifact.json still reads
 * source_kind "codex_generated" and status "succeeded" (the shape intake requires); only these MOCK values mark it.
 */
export const MOCK_GENERATION = {
  status: "succeeded" as const,
  tool: "codex_cli" as const,
  tool_version: "0.0.0-mock",
  model_reported: "mock-no-model",
  approval_id: "mock-not-an-approval-dev142",
  prompt_sha256: "0".repeat(64),
  worker_commit: "0".repeat(40),
  run_id: "mock_dev142_vb",
  started_at: "2026-11-01T00:00:00Z",
  finished_at: "2026-11-01T00:00:00Z",
};

/**
 * "Unsourced lines", counted the way the design-director evaluation counts them (docs/design/design-director-eval/
 * README.md, score-direction-prototypes.mts.txt `sentenceLike`): a visible line that is not in any fact value (and holds
 * none) and reads as a sentence (ends with 。！？!? or holds 、). An evaluation count, recorded only; not a check.
 */
export function unsourcedLines(visibleText: string, factValues: readonly string[]): string[] {
  const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
  const values = factValues.map(norm);
  return visibleText
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      const n = norm(l);
      if (values.some((v) => v.includes(n) || n.includes(v))) return false;
      return /[。！？!?]$/.test(n) || n.includes("、");
    });
}

/** The page's visible text (innerText) at one width: its own files only, JS off, every other request refused. */
export async function visibleText(browser: Browser, page: Page, width: number): Promise<string> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
  try {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://mock.invalid") return route.abort();
      const path = url.pathname.slice(1);
      if (path === "index.html") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page.html });
      if (path === "style.css") return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: page.css });
      const file = page.assets.get(path);
      return file ? route.fulfill({ status: 200, contentType: "image/png", body: file }) : route.abort();
    });
    const p = await context.newPage();
    await p.goto("http://mock.invalid/index.html", { waitUntil: "load" });
    return (await p.evaluate("document.body.innerText")) as string;
  } finally {
    await context.close();
  }
}

/** What one attempt of Claude's implementation measured: enough to apply the study's repair-trigger rule (§4). */
export type AttemptMeasure = { identity: "REJECT" | "HOLD" | "PASS_IDENTITY_ONLY"; scrollWidth: { desktop_1440: number; mobile_390: number } };
export const WIDTHS = { desktop_1440: 1440, mobile_390: 390 } as const;
export const OVERFLOW_CAUSE = "IMPL_HORIZONTAL_OVERFLOW";

/**
 * The study's repair-trigger rule (§4), with runLoop's LIMITS as the caps:
 * - identity REJECT / HOLD stops the run for the owner at once (never repaired);
 * - the horizontal overflow of Claude's own implementation is the ONLY repair trigger; each repair is the next
 *   attempt (in the mock, a pre-written fixture: the fix is written by hand, never generated), capped by
 *   LIMITS.implementationAttempts and LIMITS.fixesPerCause; past them the run stops for the owner;
 * - everything else (SP findings, unsourced lines, compare differences) is never looked at here: record-only.
 */
export async function repairLoop<T>(attempts: readonly T[], measure: (a: T) => Promise<AttemptMeasure>) {
  const history: { attempt: number; identity: AttemptMeasure["identity"]; scroll_width: AttemptMeasure["scrollWidth"]; overflow: string[] }[] = [];
  const fixes: Record<string, number> = {};
  for (let i = 0; i < attempts.length; i++) {
    const m = await measure(attempts[i]!);
    const overflow = (Object.keys(WIDTHS) as (keyof typeof WIDTHS)[]).filter((k) => m.scrollWidth[k] > WIDTHS[k]);
    history.push({ attempt: i + 1, identity: m.identity, scroll_width: m.scrollWidth, overflow });
    const done = (stop: { code: string; stage: string; reason: string } | null) => ({ final: i, repair_attempts: Object.values(fixes).reduce((a, b) => a + b, 0), fixes_by_cause: { ...fixes }, history, stop });
    if (m.identity !== "PASS_IDENTITY_ONLY") return done({ code: `IDENTITY_${m.identity}`, stage: "implementation", reason: "MOCK: identity REJECT/HOLD stops the run for the owner; never repaired (§4)" });
    if (overflow.length === 0) return done(null);
    const used = fixes[OVERFLOW_CAUSE] ?? 0;
    if (i + 1 >= LIMITS.implementationAttempts || used >= LIMITS.fixesPerCause) return done({ code: "REPAIR_LIMIT_REACHED", stage: "implementation", reason: "MOCK: Claude's implementation still overflows at the runLoop LIMITS; stopped for the owner" });
    if (i + 1 >= attempts.length) return done({ code: "REPAIR_NOT_AVAILABLE", stage: "implementation", reason: "MOCK: no further hand-written attempt exists" });
    fixes[OVERFLOW_CAUSE] = used + 1;
  }
  throw new Error("repairLoop: no attempts");
}

/** The record's top-level and nested keys, as the template has them (a record must carry each). */
export function templateKeys(t: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(t).flatMap(([k, v]) => {
    const key = `${prefix}${k}`;
    if (v && typeof v === "object" && !Array.isArray(v)) return [key, ...templateKeys(v as Record<string, unknown>, `${key}.`)];
    return [key];
  });
}
