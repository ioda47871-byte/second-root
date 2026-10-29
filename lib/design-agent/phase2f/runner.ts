/**
 * Phase 2f-1: the minimal runner that turns one Codex design run into a Design
 * Artifact package (DEV-114) and checks it, for routes A, B and C.
 *
 *   B: Codex answer (codex_design_v1, prototype as text) → answer check → prototype
 *      safety check → render PC 1440 / SP 390 (dsf 1, JS off, network shut) →
 *      measure sections → real PNG decode → package → intake
 *   C: as B, plus one generated image per asset the prototype shows (each its own
 *      call and approval). A failed image that is not essential becomes an explicit
 *      B fallback (failure kept); an essential one, or a policy refusal, stops for
 *      the owner.
 *   A: wraps an existing image PoC output (report + one PNG) as a concept_only
 *      package (route A never reaches render_pair_complete).
 *
 * Codex and the image tool are reached only through ports given by the caller:
 * the 2f-1 tests use pseudo ports; the real ones (2f-2) need separate approval.
 * The runner never retries: a recovery is only ever suggested, and every new
 * run needs its own approval (the call limits cannot grow inside a run).
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Browser } from "playwright";
import { checkCodexDesign, IntakeError, intakeArtifact, type IntakeRecord } from "../artifact/intake";
import { STOP_CLASSES, type DesignArtifact, type FactsPack, type IMAGE_OUTCOMES } from "../artifact/schema";
import { decodeCheck } from "./decode-check";
import { buildAssetPrompt, buildDesignPrompt, codexDesignJsonSchema, type DesignBrief } from "./prompt";
import { checkPrototype, PrototypeUnsafe } from "./prototype-safety";
import { RENDER_VIEWPORTS, renderPrototype, RenderError, type MeasuredBox, type RenderKey, type RenderPrototype } from "./render-prototype";

type ImageOutcome = (typeof IMAGE_OUTCOMES)[number];
type StopClass = (typeof STOP_CLASSES)[number];
type Generation = DesignArtifact["observed"]["generation"];

/** Per-run limits (the owner's plan: one design call, one asset call, 15 min a call, about 2 h in all). Never raised by a recovery. */
export type RunLimits = { maxDesignCalls: number; maxAssetCalls: number; callTimeoutMs: number; totalBudgetMs: number };
export const PLAN_LIMITS: RunLimits = { maxDesignCalls: 1, maxAssetCalls: 1, callTimeoutMs: 15 * 60 * 1000, totalBudgetMs: 2 * 60 * 60 * 1000 };

/** A port failure the runner records as it is (fixed code and class). */
export class PortStop extends Error {
  constructor(readonly code: string, readonly stopClass: StopClass) {
    super(code);
    this.name = "PortStop";
  }
}

/** One Codex design call. `generation` is what the port observed (never Codex's words); image_outcome is set by the runner. */
/** `signal` aborts when the runner's time limit passes: a real port must stop its process then (a 2f-2 duty). */
export type DesignPort = (req: { prompt: string; promptSha256: string; schema: object; timeoutMs: number; signal: AbortSignal }) => Promise<{ answer: unknown; generation: Omit<Generation, "image_outcome"> }>;
/** One image-tool call for one asset (route C). */
export type AssetPort = (req: { assetId: string; prompt: string; promptSha256: string; timeoutMs: number; signal: AbortSignal }) => Promise<{ png: Buffer | null; image_outcome: ImageOutcome; stop_code: string | null; approval_id: string | null }>;

export type RunLog = {
  route_requested: string;
  route_delivered: string | null;
  design_calls: number;
  asset_calls: number;
  prompt_sha256: string | null;
  /** Codex's own estimate of the geometry, kept for comparison with the measured one. */
  declared_geometry: unknown;
  stops: { code: string; class: string; stage: string }[];
  ms: number;
};

export type RunResult =
  | { status: "done"; packageDir: string; record: IntakeRecord; log: RunLog }
  | { status: "stopped"; code: string; stopClass: StopClass; ownerCheck: boolean; recovery: string; log: RunLog };

/** Recovery suggestions (never automatic). */
export const RECOVERY = {
  new_run: "A new run may be started only with a new, explicit approval (new approval ID; the previous run is referenced, its history kept).",
  owner_check: "Stopped for the owner. If the owner finds a false positive or a fixable cause, a NEW run may be approved (new approval ID, revised request SHA recorded with the previous run's reference); nothing is retried automatically.",
  fix_input: "The input or Codex's answer is not usable as is; inspect it. A new run needs a new approval.",
  wait: "An environment limit (quota, sign-in, sandbox). Wait or fix the environment; a new run needs a new approval.",
} as const;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/**
 * The per-call time limit, enforced by the runner itself: when it passes, the port's signal aborts (a real port must
 * stop its process then) and the run stops with `code`, even if the port ignores the signal.
 */
async function withTimeout<T>(call: (signal: AbortSignal) => Promise<T>, ms: number, code: string): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PortStop(code, "interrupted"));
        }, Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A neutral placeholder PNG (16 × 16, one mid grey) for an asset that could not be generated in a fallback. */
export function placeholderPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // 16 rows, each a filter byte (0) and 16 RGB pixels of mid grey
  const raw = Buffer.alloc(16 * 49, 0xc8);
  for (let y = 0; y < 16; y++) raw[y * 49] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const POLICY_OUTCOMES: readonly ImageOutcome[] = ["TOOL_FAILED_POLICY"];
const QUOTA_OUTCOMES: readonly ImageOutcome[] = ["TOOL_FAILED_USAGE_LIMIT"];

type Common = { facts: { path: string; pack: FactsPack }; shop: { shop_id: string; display_name: string }; artifactId: string; outDir: string; limits?: RunLimits; now?: () => number };

/** Writes the package files and artifact.json, then runs intake on it. */
async function writeAndIntake(c: Common, files: Record<string, Buffer>, artifact: Omit<DesignArtifact, "facts_pack_sha256" | "observed"> & { observed: Omit<DesignArtifact["observed"], "files"> }) {
  await mkdir(c.outDir, { recursive: false });
  const observedFiles: DesignArtifact["observed"]["files"] = [];
  for (const [rel, data] of Object.entries(files)) {
    const parts = rel.split("/");
    await mkdir(join(c.outDir, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(c.outDir, rel), data, { mode: 0o600, flag: "wx" });
    const role = rel.startsWith("originals/") ? "original" : rel.startsWith("assets/") ? "asset" : "prototype";
    observedFiles.push({ path: rel, role, sha256: sha256(data), bytes: data.length });
  }
  const factsBytes = await readFile(c.facts.path);
  const full: DesignArtifact = { ...artifact, facts_pack_sha256: sha256(factsBytes), observed: { ...artifact.observed, files: observedFiles } } as DesignArtifact;
  await writeFile(join(c.outDir, "artifact.json"), JSON.stringify(full, null, 2), { mode: 0o600, flag: "wx" });
  return intakeArtifact({ packageDir: c.outDir, factsPath: c.facts.path });
}

/** Routes B and C. */
export async function runPrototypeRoute(c: Common & { route: "B_html_prototype" | "C_hybrid"; browser: Browser; brief: DesignBrief; designPort: DesignPort; assetPort?: AssetPort; render?: RenderPrototype }): Promise<RunResult> {
  // tests may substitute the renderer (to reproduce a blocked request); the CLI never does
  const render = c.render ?? renderPrototype;
  const limits = c.limits ?? PLAN_LIMITS;
  const now = c.now ?? Date.now;
  const started = now();
  const log: RunLog = { route_requested: c.route, route_delivered: null, design_calls: 0, asset_calls: 0, prompt_sha256: null, declared_geometry: null, stops: [], ms: 0 };
  const stop = (code: string, stopClass: StopClass, recovery: string, ownerCheck = false): RunResult => {
    log.ms = now() - started;
    return { status: "stopped", code, stopClass, ownerCheck, recovery, log };
  };
  const budgetLeft = () => limits.totalBudgetMs - (now() - started);

  // 1. one design call
  const built = buildDesignPrompt({ route: c.route, facts: c.facts.pack, brief: c.brief, maxAssets: limits.maxAssetCalls });
  log.prompt_sha256 = built.sha256;
  if (limits.maxDesignCalls < 1) return stop("RUN_LIMIT_DESIGN_CALLS", "approval", RECOVERY.new_run);
  if (budgetLeft() <= 0) return stop("RUN_TIME_BUDGET", "interrupted", RECOVERY.new_run);
  let answer: unknown;
  let generation: Omit<Generation, "image_outcome">;
  try {
    log.design_calls += 1;
    const ms = Math.min(limits.callTimeoutMs, budgetLeft());
    ({ answer, generation } = await withTimeout((signal) => c.designPort({ prompt: built.prompt, promptSha256: built.sha256, schema: codexDesignJsonSchema(), timeoutMs: ms, signal }), ms, "CODEX_TIMEOUT"));
  } catch (e) {
    if (e instanceof PortStop) return stop(e.code, e.stopClass, e.stopClass === "environment" ? RECOVERY.wait : RECOVERY.new_run);
    return stop("RUN_DESIGN_PORT_FAILED", "request", RECOVERY.new_run);
  }

  // 2. the answer: exactly codex_design_v1, with a prototype
  let design;
  try {
    design = checkCodexDesign(answer);
  } catch {
    return stop("CODEX_DESIGN_INVALID", "output", RECOVERY.fix_input);
  }
  if (!design.prototype) return stop("CODEX_NO_PROTOTYPE", "output", RECOVERY.fix_input);
  const proto = design.prototype;
  const spec = design.structure_spec;
  log.declared_geometry = { page_height: spec.page_height, boxes: Object.fromEntries(spec.sections.map((s) => [s.id, s.boxes])) };
  const assetIds = [...new Set(spec.sections.flatMap((s) => s.asset_refs))].sort();
  if (c.route === "B_html_prototype" && assetIds.length) return stop("CODEX_ASSETS_ON_ROUTE_B", "output", RECOVERY.fix_input);
  const assetPaths = assetIds.map((id) => `assets/${id}.png`);

  // 3. safety before anything is rendered or generated
  let alts: Record<string, string>;
  try {
    ({ alts } = await checkPrototype(c.browser, proto, assetPaths));
  } catch (e) {
    if (e instanceof PrototypeUnsafe) return stop("PROTOTYPE_UNSAFE", "output", RECOVERY.fix_input, true);
    throw e;
  }

  // 4. route C: one image per asset, each its own approved call; a failure is recorded as it is
  let route: "B_html_prototype" | "C_hybrid" = c.route;
  let imageOutcome: ImageOutcome = "not_applicable";
  const assets: DesignArtifact["observed"]["assets"] = [];
  const assetFiles = new Map<string, Buffer>();
  let fallback: DesignArtifact["observed"]["fallback"] = null;
  if (c.route === "C_hybrid") {
    if (!assetIds.length) return stop("CODEX_NO_ASSET_ON_ROUTE_C", "output", RECOVERY.fix_input);
    if (assetIds.length > limits.maxAssetCalls) return stop("RUN_LIMIT_ASSET_CALLS", "approval", RECOVERY.new_run, true);
    if (!c.assetPort) return stop("RUN_NO_ASSET_PORT", "input", RECOVERY.fix_input);
    // a preflight render with placeholders BEFORE any image call: no approved image call is spent on a page that
    // would be stopped, and where each picture really sits is measured, not taken from Codex's declaration
    const placeholders = new Map(assetPaths.map((p) => [p, placeholderPng()] as const));
    let pre;
    try {
      pre = await render(c.browser, proto, placeholders, spec.sections.map((s) => s.id));
    } catch (e) {
      if (e instanceof RenderError) return stop(e.code, "output", RECOVERY.fix_input);
      throw e;
    }
    if (pre.desktop_1440.blocked + pre.mobile_390.blocked > 0) return stop("PROTOTYPE_NETWORK_ATTEMPT", "output", RECOVERY.fix_input, true);
    const heroIds = new Set(spec.sections.filter((s) => s.role === "hero").map((s) => s.id));
    const essential = new Set<string>();
    for (const id of assetIds) {
      const path = `assets/${id}.png`;
      const placed = [pre.desktop_1440.assets[path], pre.mobile_390.assets[path]];
      const where = new Set(placed.flatMap((p) => p?.sections ?? []));
      const declared = spec.sections.filter((s) => s.asset_refs.includes(id)).map((s) => s.id);
      // the declaration must match the page: a picture shown nowhere, or not in the section that declares it, stops
      if (!placed.some((p) => p?.shown) || declared.some((d) => !where.has(d))) return stop("CODEX_ASSET_PLACEMENT_MISMATCH", "output", RECOVERY.fix_input);
      // essential: in the hero, in the first screen at either width, or outside every section (its role is unknown)
      if ([...where].some((w) => heroIds.has(w)) || placed.some((p) => p?.firstScreen || p?.outsideSections)) essential.add(id);
    }
    for (const id of assetIds) {
      const path = `assets/${id}.png`;
      const alt = alts[path];
      if (!alt) return stop("ASSET_DESCRIPTION_MISSING", "output", RECOVERY.fix_input);
      if (budgetLeft() <= 0) return stop("RUN_TIME_BUDGET", "interrupted", RECOVERY.new_run);
      const req = buildAssetPrompt({ facts: c.facts.pack, alt, assetId: id });
      let res;
      try {
        log.asset_calls += 1;
        const ms = Math.min(limits.callTimeoutMs, budgetLeft());
        res = await withTimeout((signal) => c.assetPort!({ assetId: id, prompt: req.prompt, promptSha256: req.sha256, timeoutMs: ms, signal }), ms, "CODEX_IMAGE_TIMEOUT");
      } catch (e) {
        if (e instanceof PortStop) return stop(e.code, e.stopClass, e.stopClass === "environment" ? RECOVERY.wait : RECOVERY.new_run);
        return stop("RUN_ASSET_PORT_FAILED", "request", RECOVERY.new_run);
      }
      if (res.image_outcome === "IMAGE_SAVED") {
        // a saved image without its file is a port fault, never reclassified
        if (!res.png) return stop("RUN_ASSET_PORT_FAILED", "request", RECOVERY.new_run);
        assets.push({ id, path, kind: "ai_concept", approval_id: res.approval_id, use: "design_only" });
        assetFiles.set(path, res.png);
        continue;
      }
      // a failed image: never a success
      if (POLICY_OUTCOMES.includes(res.image_outcome)) return stop("IMAGE_POLICY_REFUSAL", "capability", RECOVERY.owner_check, true);
      if (QUOTA_OUTCOMES.includes(res.image_outcome)) return stop("CODEX_QUOTA", "environment", RECOVERY.wait);
      if (essential.has(id)) return stop("IMAGE_ESSENTIAL_FAILED", "capability", RECOVERY.owner_check, true);
      // the failure must arrive classified (outcome and stop code); it is kept exactly as it came, never filled in
      if (res.image_outcome === "not_applicable" || !res.stop_code) return stop("RUN_ASSET_PORT_FAILED", "request", RECOVERY.new_run);
      // explicit fallback to B: every picture becomes a neutral placeholder, the failure is kept as it was
      route = "B_html_prototype";
      imageOutcome = res.image_outcome;
      fallback = { from_route: "C_hybrid", image_outcome: res.image_outcome, image_stop_code: res.stop_code, image_approval_id: res.approval_id, image_essential: false, decided_by: "runner" };
      assets.splice(0, assets.length);
      for (const other of assetIds) {
        assetFiles.set(`assets/${other}.png`, placeholderPng());
        assets.push({ id: other, path: `assets/${other}.png`, kind: "placeholder", approval_id: null, use: "design_only" });
      }
      break;
    }
    if (route === "C_hybrid") imageOutcome = "IMAGE_SAVED";
  }

  // 5. render both widths; any blocked request is a safety stop
  let rendered;
  try {
    rendered = await render(c.browser, proto, assetFiles, spec.sections.map((s) => s.id));
  } catch (e) {
    if (e instanceof RenderError) return stop(e.code, "output", RECOVERY.fix_input);
    throw e;
  }
  if (rendered.desktop_1440.blocked + rendered.mobile_390.blocked > 0) return stop("PROTOTYPE_NETWORK_ATTEMPT", "output", RECOVERY.fix_input, true);

  // 6. real decode, measured geometry (the render, not Codex's estimate), problems recorded (incomplete), not hidden
  const stops: DesignArtifact["observed"]["stops"] = [];
  const missing: DesignArtifact["observed"]["missing"] = [];
  const originals = {} as DesignArtifact["observed"]["originals"];
  const pageHeight = {} as Record<RenderKey, number>;
  const boxes: Record<string, Record<RenderKey, MeasuredBox>> = {};
  for (const k of Object.keys(RENDER_VIEWPORTS) as RenderKey[]) {
    const r = rendered[k];
    const width = RENDER_VIEWPORTS[k].width;
    const decoded = decodeCheck(r.png, width);
    if (!decoded.ok && decoded.code !== "RENDER_BLANK") return stop(decoded.code, "output", RECOVERY.fix_input);
    const height = decoded.height!;
    if (!decoded.ok) stops.push({ code: "RENDER_BLANK", class: "output", stage: "render" });
    if (r.scrollWidth > width) stops.push({ code: "PROTOTYPE_HORIZONTAL_OVERFLOW", class: "output", stage: "render" });
    pageHeight[k] = height;
    originals[k] = { state: "present", path: `originals/${k}.png`, kind: "viewport_render", rendered_from: "html_prototype_screenshot", width, height };
    for (const s of spec.sections) {
      const m = r.sections[s.id];
      if (!m) missing.push({ item: `section_not_marked_${k}_${s.id}`.slice(0, 61).replace(/[^a-z0-9_]/g, "_"), reason: "no element carries this data-section in the render" });
      const box = m ?? { x: 0, y: 0, w: 0, h: 0 };
      // page coordinates, clipped to the page (an overflow is recorded above, never hidden)
      // the part of the box inside the page (a box sticking out on any side keeps only its visible part)
      const x1 = Math.max(0, Math.floor(box.x));
      const y1 = Math.max(0, Math.floor(box.y));
      const x2 = Math.min(width, Math.ceil(box.x + box.w));
      const y2 = Math.min(height, Math.ceil(box.y + box.h));
      const visible = box.w > 0 && box.h > 0 && x2 > x1 && y2 > y1;
      const x = Math.min(x1, width);
      const y = Math.min(y1, height);
      const w = visible ? x2 - x1 : 0;
      const h = visible ? y2 - y1 : 0;
      (boxes[s.id] ??= {} as Record<RenderKey, MeasuredBox>)[k] = { x, y, w, h };
    }
  }
  const measuredSpec = { ...spec, page_height: pageHeight, sections: spec.sections.map((s) => ({ ...s, boxes: boxes[s.id]! })) };

  // 7. package + intake (state is derived by intake, never written here)
  const generationObserved: Generation = { ...generation, image_outcome: imageOutcome };
  const files: Record<string, Buffer> = {
    "originals/desktop_1440.png": rendered.desktop_1440.png,
    "originals/mobile_390.png": rendered.mobile_390.png,
    "quarantine/index.html": Buffer.from(proto.html, "utf8"),
    "quarantine/style.css": Buffer.from(proto.css, "utf8"),
    ...Object.fromEntries(assetFiles),
  };
  log.stops = stops.map((s) => ({ ...s }));
  try {
    const record = await writeAndIntake(c, files, {
      schema: "design_artifact_v1",
      artifact_id: c.artifactId,
      route,
      source_kind: "codex_generated",
      shop: c.shop,
      declared: { schema: design.schema, design_dna: design.design_dna, structure_spec: measuredSpec, interaction_spec: [] },
      observed: {
        originals,
        render: { device_scale_factor: 1, javascript: "disabled", network: "blocked", full_page: true },
        assets,
        prototype: { html_path: "quarantine/index.html", css_path: "quarantine/style.css" },
        generation: generationObserved,
        stops,
        missing,
        fallback,
      },
    });
    log.route_delivered = route;
    log.ms = now() - started;
    return { status: "done", packageDir: c.outDir, record, log };
  } catch (e) {
    if (e instanceof IntakeError) return stop(e.code, "output", RECOVERY.fix_input);
    throw e;
  }
}

/** Route A: wraps an image PoC output directory (report.json + one PNG) as a concept_only package. */
export async function packageConceptRun(c: Common & { pocDir: string; generation: Omit<Generation, "image_outcome"> }): Promise<RunResult> {
  const now = c.now ?? Date.now;
  const started = now();
  const log: RunLog = { route_requested: "A_image", route_delivered: null, design_calls: 0, asset_calls: 0, prompt_sha256: c.generation.prompt_sha256, declared_geometry: null, stops: [], ms: 0 };
  const stop = (code: string): RunResult => ({ status: "stopped", code, stopClass: "input", ownerCheck: false, recovery: RECOVERY.fix_input, log: { ...log, ms: now() - started } });
  let report: { png_sha256?: unknown; width?: unknown; height?: unknown };
  try {
    report = JSON.parse(await readFile(join(c.pocDir, "report.json"), "utf8")) as typeof report;
  } catch {
    return stop("CONCEPT_REPORT_INVALID");
  }
  const pngs = (await readdir(c.pocDir)).filter((n) => n.endsWith(".png"));
  if (pngs.length !== 1) return stop("CONCEPT_IMAGE_COUNT");
  const png = await readFile(join(c.pocDir, pngs[0]!));
  if (typeof report.png_sha256 !== "string" || sha256(png) !== report.png_sha256) return stop("CONCEPT_SHA_MISMATCH");
  if (typeof report.width !== "number" || typeof report.height !== "number") return stop("CONCEPT_REPORT_INVALID");
  const decoded = decodeCheck(png, report.width);
  // a valid PNG in a format the reader does not decode is noted, not stopped (intake still checks its structure)
  const unsupported = !decoded.ok && decoded.code === "RENDER_UNSUPPORTED_FORMAT";
  if (unsupported) log.stops.push({ code: "CONCEPT_DECODE_UNSUPPORTED_FORMAT", class: "inconclusive", stage: "intake" });
  else if (!decoded.ok) return stop(decoded.code === "RENDER_BLANK" ? "CONCEPT_IMAGE_BLANK" : decoded.code === "RENDER_SIZE_MISMATCH" ? "CONCEPT_REPORT_INVALID" : "CONCEPT_IMAGE_UNDECODABLE");
  if (decoded.ok && decoded.height !== report.height) return stop("CONCEPT_REPORT_INVALID");
  const size = decoded.ok ? { width: decoded.width, height: decoded.height } : { width: report.width, height: report.height };
  const design = {
    schema: "codex_design_v1" as const,
    // route A has no Codex structure answer: the concept image carries the design; the brief's facts tie it to the shop
    design_dna: Object.fromEntries(["hero", "typography", "palette", "product_visual", "section_rhythm", "navigation", "mobile", "implementation"].map((p) => [p, { choice: "concept image (route A): see the picture", fact_refs: [c.facts.pack.facts[0]!.id] }])) as DesignArtifact["declared"]["design_dna"],
    structure_spec: {
      page_height: { desktop_1440: Math.min(16000, size.height), mobile_390: Math.min(16000, size.height) },
      sections: [{ id: "concept", role: "other" as const, boxes: { desktop_1440: { x: 0, y: 0, w: 1440, h: Math.min(16000, size.height) }, mobile_390: { x: 0, y: 0, w: 390, h: Math.min(16000, size.height) } }, live_text: [], asset_refs: [] }],
      order: { desktop_1440: ["concept"], mobile_390: ["concept"] },
      reading_path: { desktop_1440: ["concept"], mobile_390: ["concept"] },
    },
    interaction_spec: [] as never[],
  };
  try {
    const record = await writeAndIntake(c, { "originals/desktop_concept.png": png }, {
      schema: "design_artifact_v1",
      artifact_id: c.artifactId,
      route: "A_image",
      source_kind: "codex_generated",
      shop: c.shop,
      declared: design,
      observed: {
        originals: { desktop_1440: { state: "present", path: "originals/desktop_concept.png", kind: "concept_image", rendered_from: "image_tool", width: size.width, height: size.height }, mobile_390: { state: "missing" } },
        render: null,
        assets: [],
        prototype: null,
        generation: { ...c.generation, image_outcome: "IMAGE_SAVED" },
        stops: [],
        missing: [
          { item: "mobile_concept_image", reason: "route A produced one concept image; a separate 390 design was not generated" },
          ...(unsupported ? [{ item: "concept_pixels_not_decoded", reason: "the PNG format is not one the runner decodes; only its structure was checked" }] : []),
        ],
        fallback: null,
      },
    });
    return { status: "done", packageDir: c.outDir, record, log: { ...log, route_delivered: "A_image", ms: now() - started } };
  } catch (e) {
    if (e instanceof IntakeError) return stop(e.code);
    throw e;
  }
}
