/**
 * DEV-114 Phase 2d-min: INTAKE of a Design Artifact package — an offline,
 * deterministic check that runs every time a package is used. It never calls
 * Codex, a model, a browser or the network, and it writes nothing (the CLI
 * prints the result).
 *
 * Package layout (all paths relative, plain segments):
 *   artifact.json            design_artifact_v1 (schema.ts)
 *   originals/*.png          PC 1440 / SP 390 renders, or concept images (route A)
 *   assets/*.png             design assets (route C)
 *   quarantine/*.html|*.css  the Codex prototype (routes B/C) — never handed to the implementation lane
 *
 * File safety: the package root is resolved once; the tree is walked without
 * following links (any link, device or other non-regular entry stops the
 * intake) and every file must be declared. Each file is opened with
 * O_NOFOLLOW, must be a regular file within its size cap, and must be the
 * very file the walk saw (same device/inode, its /proc fd path equal to the
 * expected path, parents unchanged); exactly the checked number of bytes is
 * read and its SHA-256 recomputed. This stops link escapes through a parent
 * directory and swaps between check and read. It cannot stop a file being
 * replaced AFTER intake: that is why the result is never stored as proof —
 * each use runs intake again on the bytes it will use.
 *
 * Verification states (never approvals):
 *   render_pair_complete  both originals are browser renders (1440 and 390 wide) and every check passed
 *   concept_only          the originals are concept images (route A / owner upload): not exact PC/SP renders
 *   incomplete            something needed is missing, the run stopped, or the generation facts are unknown
 * Only render_pair_complete allows a handoff to implementation, and even it is
 * not G2, G3 or G5 quality approval. Human gates are always reported not_done:
 * nothing here can set them.
 *
 * OS-level separation of Codex and Claude (users, jails) is Phase 2e. Here the
 * prototype is only kept out of the handoff list.
 *
 * The PNG check below is the same structural check as the design-image PoC's
 * png.ts (signature, full chunk walk with CRCs, IHDR rules, IDAT, empty IEND
 * last), written here because only that PoC and comp-impl may import
 * design-image (the PoC's isolation test). Pixels are never decoded.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import {
  CodexDesign,
  DesignArtifact,
  FactsPack,
  PACKAGE_LIMITS,
  PNG_LIMITS,
  PROTOTYPE_LIMITS,
  RelPath,
  VIEWPORTS,
  type FileLimits,
  type ViewportKey,
} from "./schema";

export class IntakeError extends Error {
  readonly code: string;
  constructor(code: string, readonly detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "IntakeError";
    this.code = code;
  }
}

export type VerificationState = "render_pair_complete" | "concept_only" | "incomplete";

export const INTAKE_NOTES = [
  "verification_state is a file and consistency check, not an owner approval.",
  "render_pair_complete does not mean G2, G3 or G5 passed; every human gate is not_done here.",
  "This record is not evidence when stored: run intake again on the bytes you will use.",
  "generation, stops and missing are the runner's report; intake re-computes file facts only.",
  "The prototype is kept out of the handoff list only; OS-level separation of Codex and Claude is Phase 2e.",
] as const;

type Stat = { dev: number; ino: number };
type Entry = { rel: string; kind: "file" | "dir"; stat: Stat; size: number };

const fail = (code: string, detail = ""): never => {
  throw new IntakeError(code, detail);
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Walks the package without following anything; refuses links, special files, depth and size beyond the caps. */
async function inventory(root: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > PACKAGE_LIMITS.maxDepth) fail("ARTIFACT_PATH_UNSAFE", `too deep: ${rel}`);
    const dirents = await readdir(rel ? join(root, rel) : root, { withFileTypes: true }).catch(() => fail("ARTIFACT_PATH_UNSAFE", `unreadable: ${rel || "."}`));
    for (const d of dirents) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (out.size >= PACKAGE_LIMITS.maxEntries) fail("ARTIFACT_TOO_LARGE", "too many entries");
      if (!RelPath.safeParse(r).success) fail("ARTIFACT_PATH_UNSAFE", r);
      const st = await lstat(join(root, r)).catch(() => fail("ARTIFACT_PATH_UNSAFE", r));
      if (st.isSymbolicLink()) fail("ARTIFACT_PATH_UNSAFE", `link: ${r}`);
      if (st.isDirectory()) {
        out.set(r, { rel: r, kind: "dir", stat: { dev: st.dev, ino: st.ino }, size: 0 });
        await walk(r, depth + 1);
      } else if (st.isFile()) {
        if (st.nlink !== 1) fail("ARTIFACT_PATH_UNSAFE", `hard link: ${r}`);
        out.set(r, { rel: r, kind: "file", stat: { dev: st.dev, ino: st.ino }, size: st.size });
      } else {
        fail("ARTIFACT_PATH_UNSAFE", `not a regular file: ${r}`);
      }
    }
  };
  await walk("", 1);
  return out;
}

/** Reads exactly `size` bytes of a regular file opened with O_NOFOLLOW, after proving it is the file the walk saw. */
async function readChecked(root: string, entries: Map<string, Entry>, rel: string, maxBytes: number): Promise<Buffer> {
  const e = entries.get(rel);
  if (!e || e.kind !== "file") return fail("ARTIFACT_FILE_MISSING", rel);
  if (e.size > maxBytes) fail("ARTIFACT_TOO_LARGE", rel);
  const path = join(root, rel);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => fail("ARTIFACT_PATH_UNSAFE", rel));
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.dev !== e.stat.dev || st.ino !== e.stat.ino || st.size !== e.size || st.nlink !== 1) fail("ARTIFACT_PATH_UNSAFE", `changed: ${rel}`);
    // the open file is this path inside the root (no parent swapped to a link in between); Linux only, fails closed elsewhere
    const real = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => fail("ARTIFACT_PATH_UNSAFE", "cannot confirm the opened file"));
    if (real !== path) fail("ARTIFACT_PATH_UNSAFE", `escaped: ${rel}`);
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      const pst = await lstat(join(root, p)).catch(() => fail("ARTIFACT_PATH_UNSAFE", p));
      const known = entries.get(p);
      if (!known || pst.isSymbolicLink() || !pst.isDirectory() || pst.dev !== known.stat.dev || pst.ino !== known.stat.ino) fail("ARTIFACT_PATH_UNSAFE", `parent changed: ${p}`);
    }
    const buf = Buffer.alloc(e.size + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got !== e.size) fail("ARTIFACT_PATH_UNSAFE", `size changed while reading: ${rel}`);
    return buf.subarray(0, e.size);
  } finally {
    await handle.close();
  }
}

/** Reads a JSON input outside the package (the facts pack): a regular file, not a link, within its cap. */
async function readJsonInput(path: string, maxBytes: number, code: string): Promise<{ bytes: Buffer; json: unknown }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => fail(code, "cannot open"));
  let bytes: Buffer;
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) fail(code, "not a regular file within the cap");
    bytes = await handle.readFile();
    if (bytes.length > maxBytes) fail(code, "too large");
  } finally {
    await handle.close();
  }
  try {
    return { bytes, json: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return fail(code, "not JSON");
  }
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[] }[] } } }, value: unknown, code: string): T {
  const r = schema.safeParse(value);
  if (!r.success) return fail(code, r.error.issues[0]?.path.map(String).join(".") ?? "");
  return r.data;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Valid (colour type → bit depths) pairs from the PNG specification. */
const PNG_DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** A complete, well-formed PNG within `limits`; returns its size, or stops with ARTIFACT_PNG_INVALID. */
export function checkArtifactPng(bytes: Buffer, limits: FileLimits, rel = ""): { width: number; height: number } {
  const bad = () => fail("ARTIFACT_PNG_INVALID", rel);
  if (bytes.length > limits.maxBytes || bytes.length < PNG_SIGNATURE.length + 12 * 3 + 13 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) bad();
  let at = 8;
  let chunks = 0;
  let width = 0;
  let height = 0;
  let idat = 0;
  let ended = false;
  while (at < bytes.length) {
    if (ended || at + 12 > bytes.length) bad();
    const length = bytes.readUInt32BE(at);
    if (length > 0x7fffffff || at + 12 + length > bytes.length) bad();
    const type = bytes.subarray(at + 4, at + 8);
    const name = type.toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(name)) bad();
    const data = bytes.subarray(at + 8, at + 8 + length);
    if ((crc32(Buffer.concat([type, data])) >>> 0) !== bytes.readUInt32BE(at + 8 + length)) bad();
    if (chunks === 0) {
      if (name !== "IHDR" || length !== 13) bad();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (!(PNG_DEPTHS[data[9]!] ?? []).includes(data[8]!) || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) bad();
      if (width < limits.minSide || height < limits.minSide || width > limits.maxSide || height > limits.maxSide || width * height > limits.maxPixels) bad();
    } else if (name === "IHDR") {
      bad();
    }
    if (name === "IDAT") idat += 1;
    if (name === "IEND") {
      if (length !== 0) bad();
      ended = true;
    }
    chunks += 1;
    at += 12 + length;
  }
  if (!ended || idat === 0) bad();
  return { width, height };
}

const ROLE_DIR = { original: "originals/", asset: "assets/", prototype: "quarantine/" } as const;
const GENERATION_REQUIRED = ["tool", "tool_version", "approval_id", "prompt_sha256", "worker_commit", "run_id", "started_at", "finished_at"] as const;

export type IntakeRecord = ReturnType<typeof buildRecord>;

function buildRecord(a: DesignArtifact, x: {
  artifactSha: string;
  state: VerificationState;
  reasons: string[];
  files: { path: string; role: string; sha256: string; bytes: number; width?: number; height?: number }[];
}) {
  const allowed = x.state === "render_pair_complete";
  return {
    schema: "artifact_intake_record_v1" as const,
    artifact_id: a.artifact_id,
    route: a.route,
    source_kind: a.source_kind,
    artifact_json_sha256: x.artifactSha,
    facts_pack_sha256: a.facts_pack_sha256,
    verification_state: x.state,
    implementation_handoff_allowed: allowed,
    reasons: x.reasons,
    files: x.files,
    handoff: {
      // only design originals, assets and the artifact itself; the prototype role is never listed
      files: allowed ? [{ path: "artifact.json", role: "artifact", sha256: x.artifactSha }, ...x.files.filter((f) => f.role !== "prototype").map((f) => ({ path: f.path, role: f.role, sha256: f.sha256 }))] : [],
      excluded_roles: ["prototype"] as const,
    },
    runner_reported: { generation: a.observed.generation, stops: a.observed.stops, missing: a.observed.missing },
    human_gates: { identity_visual_check: "not_done", g2_design: "not_done", g3_responsive: "not_done", g5_final_comparison: "not_done" } as const,
    notes: [...INTAKE_NOTES],
  };
}

/** Intake of the package at `packageDir`, against the facts pack at `factsPath`. Throws IntakeError on anything unsafe or inconsistent. */
export async function intakeArtifact(input: { packageDir: string; factsPath: string }) {
  const root = await realpath(input.packageDir).catch(() => fail("ARTIFACT_PATH_UNSAFE", "package not found"));
  const rootSt = await lstat(root);
  if (!rootSt.isDirectory()) fail("ARTIFACT_PATH_UNSAFE", "package is not a directory");
  const entries = await inventory(root);

  const artifactBytes = await readChecked(root, entries, "artifact.json", PACKAGE_LIMITS.artifactJsonBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(artifactBytes.toString("utf8"));
  } catch {
    fail("ARTIFACT_SCHEMA_INVALID", "artifact.json is not JSON");
  }
  const a = parse(DesignArtifact, raw, "ARTIFACT_SCHEMA_INVALID");

  // facts: the pack the artifact names, byte for byte
  const facts = await readJsonInput(input.factsPath, PACKAGE_LIMITS.factsJsonBytes, "ARTIFACT_FACTS_INVALID");
  if (sha256(facts.bytes) !== a.facts_pack_sha256) fail("ARTIFACT_FACT_PACK_MISMATCH", "facts_pack_sha256");
  const pack = parse(FactsPack, facts.json, "ARTIFACT_FACTS_INVALID");
  if (pack.shop_id !== a.shop.shop_id) fail("ARTIFACT_FACT_PACK_MISMATCH", "shop_id");
  const factIds = new Set(pack.facts.map((f) => f.id));
  if (factIds.size !== pack.facts.length) fail("ARTIFACT_FACTS_INVALID", "duplicate fact id");

  // every file is declared once, under its role's directory, and every declared file is referenced exactly once
  const o = a.observed;
  const declared = new Map(o.files.map((f) => [f.path, f]));
  if (declared.size !== o.files.length) fail("ARTIFACT_FILE_ROLE_MISMATCH", "duplicate path");
  for (const f of o.files) if (!f.path.startsWith(ROLE_DIR[f.role])) fail("ARTIFACT_FILE_ROLE_MISMATCH", f.path);
  const onDisk = [...entries.values()].filter((e) => e.kind === "file").map((e) => e.rel);
  for (const rel of onDisk) if (rel !== "artifact.json" && !declared.has(rel)) fail("ARTIFACT_UNDECLARED_FILE", rel);
  const refs: [string, "original" | "asset" | "prototype"][] = [];
  for (const k of Object.keys(VIEWPORTS) as ViewportKey[]) {
    const og = o.originals[k];
    if (og.state === "present") refs.push([og.path, "original"]);
  }
  for (const as of o.assets) refs.push([as.path, "asset"]);
  if (o.prototype) refs.push([o.prototype.html_path, "prototype"], [o.prototype.css_path, "prototype"]);
  const refPaths = refs.map((r) => r[0]);
  if (new Set(refPaths).size !== refPaths.length) fail("ARTIFACT_FILE_ROLE_MISMATCH", "a file referenced twice");
  for (const [p, role] of refs) if (declared.get(p)?.role !== role) fail("ARTIFACT_FILE_ROLE_MISMATCH", p);
  for (const p of declared.keys()) if (!refPaths.includes(p)) fail("ARTIFACT_FILE_ROLE_MISMATCH", `unreferenced: ${p}`);

  // route consistency
  const route = (ok: boolean, why: string) => ok || fail("ARTIFACT_ROUTE_INCONSISTENT", why);
  const presents = (Object.keys(VIEWPORTS) as ViewportKey[]).map((k) => [k, o.originals[k]] as const);
  for (const [k, og] of presents) {
    if (og.state !== "present") continue;
    if (og.kind === "viewport_render") {
      route(og.rendered_from === "html_prototype_screenshot", `${k}: a viewport render comes from the prototype screenshot`);
      route(a.route !== "A_image", `${k}: route A has no browser render`);
      route(o.render !== null, `${k}: render conditions missing`);
    } else {
      route(a.route === "A_image", `${k}: routes B/C deliver browser renders`);
      route(og.rendered_from === (a.source_kind === "chatgpt_owner_upload_compat" ? "owner_upload" : "image_tool"), `${k}: concept image source`);
    }
  }
  if (a.source_kind === "chatgpt_owner_upload_compat") route(a.route === "A_image", "an owner upload is a concept image (route A)");
  if (a.route === "A_image") {
    route(o.prototype === null && o.render === null && o.assets.length === 0, "route A carries no prototype, render or assets");
    if (a.source_kind === "codex_generated" && presents.some(([, og]) => og.state === "present")) route(o.generation.image_outcome === "IMAGE_SAVED", "route A image without IMAGE_SAVED");
  } else {
    route(o.prototype !== null, `${a.route} needs the prototype`);
    if (a.route === "B_html_prototype") route(o.assets.every((s) => s.kind === "placeholder") && o.generation.image_outcome === "not_applicable", "route B generates no images");
    if (a.route === "C_hybrid") route(o.assets.every((s) => s.kind !== "ai_concept" || s.approval_id !== null), "route C: each generated asset needs its own approval ID");
  }

  // files: re-read, re-hash, re-measure
  let total = artifactBytes.length;
  const files: { path: string; role: string; sha256: string; bytes: number; width?: number; height?: number }[] = [];
  for (const f of o.files) {
    let cap: number = PROTOTYPE_LIMITS.html;
    let limits: FileLimits | null = null;
    if (f.role === "original") {
      const [k, og] = presents.find(([, g]) => g.state === "present" && g.path === f.path)!;
      if (og.state !== "present") continue;
      limits = og.kind === "concept_image" ? PNG_LIMITS.concept_image : k === "desktop_1440" ? PNG_LIMITS.viewport_render_desktop_1440 : PNG_LIMITS.viewport_render_mobile_390;
      cap = limits.maxBytes;
    } else if (f.role === "asset") {
      limits = PNG_LIMITS.asset;
      cap = limits.maxBytes;
    } else if (f.path === o.prototype?.css_path) {
      cap = PROTOTYPE_LIMITS.css;
    }
    if (limits && !f.path.endsWith(".png")) fail("ARTIFACT_FILE_ROLE_MISMATCH", f.path);
    if (f.role === "prototype" && !(f.path === o.prototype?.html_path ? f.path.endsWith(".html") : f.path.endsWith(".css"))) fail("ARTIFACT_FILE_ROLE_MISMATCH", f.path);
    const bytes = await readChecked(root, entries, f.path, cap);
    total += bytes.length;
    if (total > PACKAGE_LIMITS.totalBytes) fail("ARTIFACT_TOO_LARGE", "package");
    if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256) fail("ARTIFACT_SHA_MISMATCH", f.path);
    const rec: (typeof files)[number] = { path: f.path, role: f.role, sha256: f.sha256, bytes: f.bytes };
    if (limits) {
      const info = checkArtifactPng(bytes, limits, f.path);
      rec.width = info.width;
      rec.height = info.height;
    } else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        fail("ARTIFACT_PROTOTYPE_INVALID", f.path);
      }
    }
    files.push(rec);
  }
  for (const [k, og] of presents) {
    if (og.state !== "present") continue;
    const rec = files.find((f) => f.path === og.path)!;
    if (rec.width !== og.width || rec.height !== og.height) fail("ARTIFACT_VIEWPORT_MISMATCH", `${k}: declared size`);
    if (og.kind === "viewport_render" && (og.width !== VIEWPORTS[k] || og.height !== a.declared.structure_spec.page_height[k]))
      fail("ARTIFACT_VIEWPORT_MISMATCH", `${k}: a render is ${VIEWPORTS[k]} wide and as tall as the spec's page`);
  }

  // the declared design: every reference resolves, the structure is coherent
  const d = a.declared;
  const spec = d.structure_spec;
  for (const part of Object.values(d.design_dna)) for (const f of part.fact_refs) if (!factIds.has(f)) fail("ARTIFACT_FACT_UNRESOLVED", f);
  const sectionIds = spec.sections.map((s) => s.id);
  const sectionSet = new Set(sectionIds);
  if (sectionSet.size !== sectionIds.length) fail("ARTIFACT_STRUCTURE_INVALID", "duplicate section id");
  const assetIds = new Set(o.assets.map((s) => s.id));
  if (assetIds.size !== o.assets.length) fail("ARTIFACT_ASSET_UNRESOLVED", "duplicate asset id");
  for (const k of Object.keys(VIEWPORTS) as ViewportKey[]) {
    const order = spec.order[k];
    if (order.length !== sectionIds.length || new Set(order).size !== order.length || order.some((id) => !sectionSet.has(id))) fail("ARTIFACT_STRUCTURE_INVALID", `order.${k}`);
    const path = spec.reading_path[k];
    if (new Set(path).size !== path.length || path.some((id) => !sectionSet.has(id))) fail("ARTIFACT_STRUCTURE_INVALID", `reading_path.${k}`);
  }
  for (const s of spec.sections) {
    for (const k of Object.keys(VIEWPORTS) as ViewportKey[]) {
      const b = s.boxes[k];
      if (b.x + b.w > VIEWPORTS[k] || b.y + b.h > spec.page_height[k]) fail("ARTIFACT_STRUCTURE_INVALID", `${s.id}.${k}: box outside the page`);
    }
    for (const t of s.live_text) if ("fact_ref" in t && !factIds.has(t.fact_ref)) fail("ARTIFACT_FACT_UNRESOLVED", t.fact_ref);
    for (const id of s.asset_refs) if (!assetIds.has(id)) fail("ARTIFACT_ASSET_UNRESOLVED", id);
  }

  // state: derived here every time, never read from anywhere
  const reasons: string[] = [];
  for (const [k, og] of presents) if (og.state !== "present") reasons.push(`original_${og.state}:${k}`);
  const g = o.generation;
  if (g.status !== "succeeded") reasons.push(`generation_${g.status}`);
  const unknown = GENERATION_REQUIRED.filter((f) => g[f] === null);
  if (unknown.length) reasons.push(`generation_unverified:${unknown.join(",")}`);
  if (g.started_at && g.finished_at && Date.parse(g.started_at) > Date.parse(g.finished_at)) reasons.push("generation_unverified:time_order");
  if (o.stops.length) reasons.push(`run_stopped:${o.stops.map((s) => s.code).join(",")}`);
  for (const m of o.missing) reasons.push(`declared_missing:${m.item}`);
  const allRender = presents.every(([, og]) => og.state === "present" && og.kind === "viewport_render");
  const state: VerificationState = reasons.length ? "incomplete" : allRender ? "render_pair_complete" : "concept_only";
  if (state === "concept_only") reasons.push("concept_images_are_not_pc_sp_renders");

  return buildRecord(a, { artifactSha: sha256(artifactBytes), state, reasons, files });
}

/** The answer Codex may give (routes A/B/C): exactly CodexDesign, checked before a runner writes anything. */
export function checkCodexDesign(value: unknown) {
  return parse(CodexDesign, value, "CODEX_DESIGN_INVALID");
}
