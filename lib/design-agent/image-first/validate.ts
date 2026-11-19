/**
 * Issue #293 P1: the validator of an IMAGE_FIRST run. Pure: the caller (builder.ts) reads the private run directory and
 * hands the bytes over; every SHA, size and dimension is recomputed here, nothing in the record is taken on trust.
 *
 * It answers with fixed reject codes (record.ts REJECT_CODES and the image call's own CODEX_* stop codes) and one status:
 *   REJECT                       any reject code: the comp never reaches implementation (fail closed);
 *   AWAITING_OWNER_EVALUATION    every machine check holds and no owner evaluation exists yet;
 *   READY_FOR_IMPLEMENTATION     every check holds AND the owner's evaluation passes the design-image rubric.
 * Only a READY verdict made by this function can be handed to the implementation lane (adapter.ts).
 *
 * What it reuses instead of re-implementing: the facts pack schema (quality-pipeline/facts-pack), the fact text rule and
 * the invented-fact signs (quality-pipeline/copy-record), the Identity Lock image audit (identity/identity-lock), the PNG
 * check (design-image/png), the comp rubric (comp-impl/bundle via owner-gate.ts) and the comparison primitives
 * (comp-impl/similarity via composition.ts). The direction's own checks (C1–C7) are checkDirectionSet's, run earlier;
 * here the chosen direction is bound by SHA and read for its section order only.
 *
 * What it never does: read text off a picture as a fact (visible texts are checked AGAINST the facts, never added to
 * them), call a model, write a file, or decide that a comp is beautiful.
 */
import { createHash } from "node:crypto";
import { INVENTED_FACT_SIGNS, LABELS_BY_KEY, factParts, norm } from "../quality-pipeline/copy-record";
import { FactsPack } from "../quality-pipeline/facts-pack";
import { auditIdentity, cleanName } from "../identity/identity-lock";
import { MOCKUP_PNG_LIMITS, checkPng } from "../design-image/png";
import { brokenSeams, buildComposite, compositeProblems, COMPOSITION_LIMITS, sequenceProblems, spLooksScaledFromPc, type CompositeView } from "./composition";
import { compSetSha256, ownerGate, type OwnerGate } from "./owner-gate";
import { containsExactCrop, decodeRgb, type RgbImage } from "./pixels";
import {
  CODEX_STOP_CODES,
  DirectionView,
  IdentityFile,
  ModelFullPageComp,
  OUTPUT_KIND,
  REQUIRED_GENERATION,
  REQUIRED_RIGHTS,
  REQUIRED_STORAGE,
  ROUTE,
  VIEWPORTS,
  VisualRead,
  type ImageFirstViewport,
  type RejectCode,
  type WarningCode,
} from "./record";

/** A JSON side file that exists but does not parse. */
export const UNPARSEABLE = Symbol("unparseable");
export type JsonInput = unknown | typeof UNPARSEABLE | undefined;

export type ImplementationAsset = { path: string; bytes: Buffer; source: string; rights_record_sha256: string | null };
export type RunEvidence = {
  /** manifest.json's bytes (null: missing / unreadable) and its parsed JSON. */
  recordBytes: Buffer | null;
  record: JsonInput;
  factsPack: Buffer | null;
  direction: Buffer | null;
  /** By the record's paths (parts/…png, prompts/…txt); null = missing or unreadable. */
  parts: ReadonlyMap<string, Buffer | null>;
  prompts: ReadonlyMap<string, Buffer | null>;
  visualRead: JsonInput;
  identity: JsonInput;
  /** undefined: no evaluation yet. */
  ownerEvaluation: JsonInput;
  /** Claude's implementation assets, when the check is run at implementation time. */
  implementationAssets?: readonly ImplementationAsset[];
};

export type ImageFirstStatus = "REJECT" | "AWAITING_OWNER_EVALUATION" | "READY_FOR_IMPLEMENTATION";
export type ImageFirstVerdict = {
  schema: "image_first_verdict_v0";
  status: ImageFirstStatus;
  /** Sorted, distinct; empty unless REJECT. */
  rejects: RejectCode[];
  /** Fixed detail strings per code (never a picture's text, a prompt or a path outside the run). */
  details: { code: RejectCode; detail: string }[];
  warnings: WarningCode[];
  record_sha256: string | null;
  comp_set_sha256: string | null;
  parts: { viewport: ImageFirstViewport; index: number; sha256: string; width: number; height: number; bytes: number }[];
  composites: Record<ImageFirstViewport, { width: number; height: number; sha256: string; parts: CompositeView["parts"] } | null>;
  owner: OwnerGate | null;
  note: string;
};

const NOTE =
  "READY_FOR_IMPLEMENTATION means the machine checks hold and the owner's rubric passed this exact comp. It is not a quality verdict on the implementation, never a production or publication approval, and the picture's text is never a fact source.";

/** Widths a browser render of the page has (CSS px at scale 1 and 2): the image tool is not asked for them and cannot set them. */
export const BROWSER_RENDER_WIDTHS: readonly number[] = [1440, 390, 2880, 780];
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Things kept from a READY verdict for the adapter only (never serialised, never forgeable from outside). */
type Handoff = { runId: string; recordSha256: string; composites: Record<ImageFirstViewport, CompositeView> };
const HANDOFFS = new WeakMap<ImageFirstVerdict, Handoff>();
/** The adapter's way to a READY verdict's composites: null for anything this function did not make READY. */
export const handoffOf = (v: ImageFirstVerdict): Handoff | null => (v.status === "READY_FOR_IMPLEMENTATION" ? (HANDOFFS.get(v) ?? null) : null);

/** Fail-closed reading of the image call's outcome: a stopped, failed or inconclusive run is never a comp. */
function codexProblems(g: ModelFullPageComp["generation"], totalParts: number, add: (c: RejectCode, d: string) => void): void {
  if (g.stop_code !== null) {
    if ((CODEX_STOP_CODES as readonly string[]).includes(g.stop_code)) add(g.stop_code as RejectCode, "stop_code");
    else add("CODEX_STOP_UNKNOWN", "stop_code");
  }
  switch (g.outcome) {
    case "IMAGE_SAVED":
      break;
    case "NO_SESSION_LOG":
    case "TOOL_NOT_SEEN_CODE_MODE":
      // DEV-080: no call seen in code mode (or no readable log) is inconclusive, never "not called"
      add("CODEX_OUTCOME_INCONCLUSIVE", g.outcome);
      break;
    case "TOOL_NOT_CALLED":
    case "TOOL_CALLED_NO_FILE":
    case "not_applicable":
      add("CODEX_NO_IMAGE", g.outcome);
      break;
    case "TOOL_FAILED_USAGE_LIMIT":
      add("CODEX_QUOTA", g.outcome);
      break;
    default:
      // TOOL_FAILED, _POLICY (owner decision: no fallback), _UNSUPPORTED, _TRANSIENT
      add("CODEX_IMAGE_TOOL_FAILED", g.outcome);
  }
  // one approved run, no retry: any failed call stops it; more calls than kept pictures means unseen pictures
  if (g.image_failed > 0) add("CODEX_IMAGE_TOOL_FAILED", "image_failed");
  if (g.image_calls > totalParts) add("CODEX_IMAGE_CALLS_EXCEEDED", "image_calls");
  if (g.image_completed !== totalParts) add("CODEX_IMAGE_COUNT_MISMATCH", "image_completed");
}

/** JPEG / WebP / GIF bytes: the tool saved a raster that is not a PNG. */
const otherRaster = (b: Buffer) => (b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 4).toString("latin1") === "RIFF" || b.subarray(0, 3).toString("latin1") === "GIF";

export function validateImageFirst(e: RunEvidence): ImageFirstVerdict {
  const details: { code: RejectCode; detail: string }[] = [];
  const warnings = new Set<WarningCode>();
  const add = (code: RejectCode, detail: string) => details.push({ code, detail });
  const out = (extra: Partial<ImageFirstVerdict> = {}): ImageFirstVerdict => {
    const rejects = [...new Set(details.map((d) => d.code))].sort();
    const seen = new Set<string>();
    return {
      schema: "image_first_verdict_v0",
      status: rejects.length ? "REJECT" : "AWAITING_OWNER_EVALUATION",
      rejects,
      details: details.filter((d) => (seen.has(`${d.code}|${d.detail}`) ? false : (seen.add(`${d.code}|${d.detail}`), true))),
      warnings: [...warnings].sort(),
      record_sha256: e.recordBytes ? sha256(e.recordBytes) : null,
      comp_set_sha256: null,
      parts: [],
      composites: { desktop_1440: null, mobile_390: null },
      owner: null,
      note: NOTE,
      ...extra,
    };
  };

  if (!e.recordBytes || e.record === undefined || e.record === UNPARSEABLE) {
    add("COMP_RECORD_INVALID", e.recordBytes ? "manifest_unparseable" : "manifest_missing");
    return out();
  }
  const parsed = ModelFullPageComp.safeParse(e.record);
  if (!parsed.success) {
    add("COMP_RECORD_INVALID", "schema");
    return out();
  }
  const r = parsed.data;
  const recordSha = sha256(e.recordBytes);

  // what the record says it is: a model-generated full-page comp of the IMAGE_FIRST route, from Codex's image tool
  if (r.output_kind !== OUTPUT_KIND) add("COMP_NOT_MODEL_GENERATED", "output_kind");
  if (r.route !== ROUTE) add("COMP_NOT_MODEL_GENERATED", "route");
  if (r.generation.tool !== REQUIRED_GENERATION.tool || r.generation.image_tool !== REQUIRED_GENERATION.image_tool) add("COMP_NOT_MODEL_GENERATED", "generation_tool");
  for (const [k, v] of Object.entries(REQUIRED_RIGHTS)) if (r.rights[k as keyof typeof REQUIRED_RIGHTS] !== v) add("COMP_RIGHTS_MISSING", k);
  for (const [k, v] of Object.entries(REQUIRED_STORAGE)) if (r.storage[k as keyof typeof REQUIRED_STORAGE] !== v) add("COMP_PROVENANCE_MISSING", `storage_${k}`);

  const vps = VIEWPORTS.filter((v) => r.viewports[v] !== null);
  if (!r.viewports.desktop_1440) add("COMP_PC_MISSING", "desktop_1440");
  if (!r.viewports.mobile_390) add("COMP_SP_MISSING", "mobile_390");
  const allParts = vps.flatMap((v) => r.viewports[v]!.parts.map((p) => ({ v, p })));
  codexProblems(r.generation, allParts.length, add);

  // provenance: who ran what, when, under which approval (unknown provenance is refused; an unknown model is a warning)
  const g = r.generation;
  if (!g.cli_version) add("COMP_PROVENANCE_MISSING", "cli_version");
  if (!g.repo_commit) add("COMP_PROVENANCE_MISSING", "repo_commit");
  if (!g.plan_id) add("COMP_PROVENANCE_MISSING", "plan_id");
  if (!g.started_at || !g.finished_at || Date.parse(g.finished_at) < Date.parse(g.started_at)) add("COMP_PROVENANCE_MISSING", "generation_time");
  if (!r.generated_at) add("COMP_PROVENANCE_MISSING", "generated_at");
  if (!g.image_model) warnings.add("IMAGE_MODEL_UNKNOWN");
  if (!g.session_model) warnings.add("SESSION_MODEL_UNKNOWN");
  if (g.approval_ids.length === 0 || new Set(g.approval_ids).size !== g.approval_ids.length) add("COMP_GENERATION_UNAPPROVED", "approval_ids");
  if (!g.approval_packet_sha256) add("COMP_GENERATION_UNAPPROVED", "approval_packet");

  // the shop facts: the pack's bytes are the recorded ones, and it is this shop's pack
  let facts: { id: string; key: string; value: string }[] = [];
  if (!e.factsPack || !r.facts_pack_sha256) add("COMP_PROVENANCE_MISSING", "facts_pack");
  else {
    if (sha256(e.factsPack) !== r.facts_pack_sha256) add("COMP_SHA_MISMATCH", "facts_pack");
    let pack: unknown;
    try {
      pack = JSON.parse(e.factsPack.toString("utf8"));
    } catch {
      pack = null;
    }
    const fp = FactsPack.safeParse(pack);
    if (!fp.success) add("COMP_PROVENANCE_MISSING", "facts_pack_invalid");
    else {
      facts = fp.data.facts;
      if (fp.data.shop_id !== r.shop.shop_id) add("COMP_SHA_MISMATCH", "facts_pack_shop");
    }
  }
  // the chosen direction (only that object): bound by SHA, read for its section order
  let directionIds: string[] | null = null;
  if (!e.direction || !r.direction.direction_sha256) add("COMP_PROVENANCE_MISSING", "direction");
  else {
    if (sha256(e.direction) !== r.direction.direction_sha256) add("COMP_SHA_MISMATCH", "direction");
    let d: unknown;
    try {
      d = JSON.parse(e.direction.toString("utf8"));
    } catch {
      d = null;
    }
    const dv = DirectionView.safeParse(d);
    if (!dv.success) add("COMP_PROVENANCE_MISSING", "direction_invalid");
    else {
      directionIds = dv.data.sections.map((s) => s.id);
      if (dv.data.id !== r.direction.direction_id) add("COMP_SHA_MISMATCH", "direction_id");
    }
  }

  // every picture: the bytes are the recorded ones, a complete PNG, from the image tool under an approved call
  const decoded: Record<ImageFirstViewport, Map<number, RgbImage>> = { desktop_1440: new Map(), mobile_390: new Map() };
  const partsOut: ImageFirstVerdict["parts"] = [];
  const itemIds = new Set<string>();
  let allDecoded = true;
  for (const { v, p } of allParts) {
    const bytes = e.parts.get(p.file) ?? null;
    if (p.rendered_from !== "image_tool") add("COMP_NOT_MODEL_GENERATED", `${v}_${p.index}_rendered_from`);
    if (BROWSER_RENDER_WIDTHS.includes(p.width)) add("COMP_NOT_MODEL_GENERATED", `${v}_${p.index}_browser_width`);
    if (!p.call.thread_id || !THREAD_ID.test(p.call.thread_id) || !p.call.item_id || !ITEM_ID.test(p.call.item_id)) add("COMP_PROVENANCE_MISSING", `${v}_${p.index}_call_id`);
    else if (itemIds.has(`${p.call.thread_id}/${p.call.item_id}`)) add("COMP_NOT_MODEL_GENERATED", `${v}_${p.index}_call_reused`);
    else itemIds.add(`${p.call.thread_id}/${p.call.item_id}`);
    if (!p.call.approval_id || !g.approval_ids.includes(p.call.approval_id)) add("COMP_GENERATION_UNAPPROVED", `${v}_${p.index}_approval`);
    const prompt = e.prompts.get(p.prompt_file) ?? null;
    if (!prompt) add("COMP_PROVENANCE_MISSING", `${v}_${p.index}_prompt`);
    else if (sha256(prompt) !== p.prompt_sha256 || prompt.toString("utf8").length !== p.prompt_chars) add("COMP_SHA_MISMATCH", `${v}_${p.index}_prompt`);
    if (!bytes) {
      add("COMP_SHA_MISMATCH", `${v}_${p.index}_part_unreadable`);
      allDecoded = false;
      continue;
    }
    let info;
    try {
      info = checkPng(bytes, MOCKUP_PNG_LIMITS);
    } catch {
      add(otherRaster(bytes) ? "CODEX_IMAGE_UNSUPPORTED_FORMAT" : "CODEX_IMAGE_INVALID", `${v}_${p.index}`);
      allDecoded = false;
      continue;
    }
    const sha = sha256(bytes);
    partsOut.push({ viewport: v, index: p.index, sha256: sha, width: info.width, height: info.height, bytes: bytes.length });
    if (sha !== p.png_sha256 || info.width !== p.width || info.height !== p.height || bytes.length !== p.bytes) add("COMP_SHA_MISMATCH", `${v}_${p.index}_part`);
    const rgb = decodeRgb(bytes);
    if (!rgb) {
      add("COMP_PART_UNDECODABLE", `${v}_${p.index}`);
      allDecoded = false;
      continue;
    }
    if (COMPOSITION_LIMITS.upscaleWarn * rgb.width < r.viewports[v]!.target_css_width) warnings.add("PART_UPSCALED_OVER_2X");
    decoded[v].set(p.index, rgb);
  }

  // the composition of each viewport, declared before generation, then built and checked
  const composites: Partial<Record<ImageFirstViewport, CompositeView>> = {};
  for (const v of vps) {
    const c = r.viewports[v]!;
    const shas = c.parts.map((p) => p.png_sha256);
    if (new Set(shas).size !== shas.length) add("COMP_SECTION_SEQUENCE_INVALID", `${v}_picture_repeated`);
    const seqProblems = directionIds ? sequenceProblems(c, v, directionIds) : ["DIRECTION_UNKNOWN"];
    for (const s of seqProblems) add("COMP_SECTION_SEQUENCE_INVALID", `${v}_${s}`);
    if (!allDecoded || seqProblems.length > 0) continue;
    const view = buildComposite(c, v, decoded[v]);
    composites[v] = view;
    const cp = compositeProblems(view);
    if (cp.heroOnly) add("COMP_HERO_ONLY", `${v}_composite_height`);
    if (cp.outOfRange) add("COMP_COMPOSITE_OUT_OF_RANGE", `${v}_composite_height`);
    for (const s of brokenSeams(c, view)) add("COMP_SEAM_BROKEN", `${v}_after_part_${s.after_part}`);
  }
  if (composites.desktop_1440 && composites.mobile_390 && spLooksScaledFromPc(composites.desktop_1440, composites.mobile_390, decoded.desktop_1440, decoded.mobile_390)) add("COMP_SP_IS_PC_SCALED", "pixels");

  // the located read of each picture (bound to its SHA): page structure, SP independence, and the texts it shows
  const partShas = allParts.map(({ p }) => p.png_sha256);
  const read = e.visualRead === undefined || e.visualRead === UNPARSEABLE ? null : VisualRead.safeParse(e.visualRead);
  if (!read || !read.success) add("COMP_VISUAL_READ_MISSING", read ? "schema" : "missing");
  else {
    const vr = read.data;
    const readShas = vr.parts.map((x) => x.inspected_sha256);
    if (vr.run_id !== r.run_id || readShas.length !== partShas.length || new Set(readShas).size !== readShas.length || partShas.some((s) => !readShas.includes(s))) add("COMP_VISUAL_READ_MISSING", "parts_not_bound");
    else {
      if (!vr.sp_independent.judged) add("COMP_SP_IS_PC_SCALED", "visual_read");
      const readOf = (sha: string) => vr.parts.find((x) => x.inspected_sha256 === sha)!;
      for (const v of vps) {
        const c = r.viewports[v]!;
        const reads = c.parts.map((p) => readOf(p.png_sha256));
        const seen = new Set(reads.flatMap((x) => x.observed_section_ids));
        if (c.section_order.some((id) => !seen.has(id))) add("COMP_HERO_ONLY", `${v}_sections_not_seen`);
        if (!reads[0]!.header_visible) add("COMP_HERO_ONLY", `${v}_no_header`);
        if (!reads[reads.length - 1]!.footer_visible) add("COMP_HERO_ONLY", `${v}_no_footer`);
        if (reads.some((x) => x.photo_only)) add("COMP_NOT_A_WEBSITE", `${v}_photo_only`);
        for (const k of ["nav", "text_blocks", "info_block"] as const) if (!reads.some((x) => x.web_structure[k])) add("COMP_NOT_A_WEBSITE", `${v}_no_${k}`);
        if (reads.some((x) => x.looks_like_browser_screenshot)) add("COMP_NOT_MODEL_GENERATED", `${v}_looks_like_screenshot`);
      }
      const t = textProblems(vr.parts.flatMap((x) => x.visible_texts), facts, r.shop.display_name);
      if (t.fabricated > 0) add("COMP_TEXT_FABRICATED", `texts_${t.fabricated}`);
      if (t.wrongName > 0) add("COMP_IDENTITY_REJECT", "visible_shop_name");
    }
  }

  // the Identity Lock (unchanged): one recorded inspection per picture, its target this record's shop
  const idf = e.identity === undefined || e.identity === UNPARSEABLE ? null : IdentityFile.safeParse(e.identity);
  if (!idf || !idf.success || idf.data.run_id !== r.run_id) add("COMP_IDENTITY_HOLD", idf ? "identity_invalid" : "identity_missing");
  else {
    for (const sha of partShas) {
      const audit = idf.data.audits.find((a) => (a as { output?: { image_sha256?: unknown } } | null)?.output?.image_sha256 === sha) as Record<string, unknown> | undefined;
      if (!audit) {
        add("COMP_IDENTITY_HOLD", "part_not_audited");
        continue;
      }
      const target = (audit.target ?? {}) as Record<string, unknown>;
      if (cleanName(target.official_name) !== cleanName(r.shop.display_name) || target.category_code !== r.shop.category_code) add("COMP_IDENTITY_REJECT", "target_not_this_shop");
      const res = auditIdentity(audit);
      if (res.status === "REJECT") add("COMP_IDENTITY_REJECT", "audit");
      else if (res.status === "HOLD") add("COMP_IDENTITY_HOLD", "audit");
    }
  }

  // implementation assets: never a picture cut out of the comp; every asset from a rights record
  if (e.implementationAssets) {
    const views = Object.values(composites);
    const partSet = new Set(partShas);
    const compositeShas = new Set(views.map((x) => sha256(x.png)));
    for (const a of e.implementationAssets) {
      const s = sha256(a.bytes);
      if (a.source === "comp_crop" || partSet.has(s) || compositeShas.has(s)) {
        add("COMP_CROP_AS_ASSET", a.path);
        continue;
      }
      if (a.source !== "photo_intake" && a.source !== "placeholder") add("ASSET_RIGHTS_MISSING", a.path);
      else if (a.source === "photo_intake" && !(a.rights_record_sha256 && /^[a-f0-9]{64}$/.test(a.rights_record_sha256))) add("ASSET_RIGHTS_MISSING", a.path);
      const img = decodeRgb(a.bytes);
      if (img && ([...decoded.desktop_1440.values(), ...decoded.mobile_390.values()].some((p) => containsExactCrop(p, img)) || views.some((x) => containsExactCrop(x.image, img)))) add("COMP_CROP_AS_ASSET", a.path);
    }
  }

  const setSha = compSetSha256(r);
  const extra: Partial<ImageFirstVerdict> = {
    comp_set_sha256: setSha,
    parts: partsOut,
    composites: Object.fromEntries(VIEWPORTS.map((v) => [v, composites[v] ? { width: composites[v].width, height: composites[v].height, sha256: sha256(composites[v].png), parts: composites[v].parts } : null])) as ImageFirstVerdict["composites"],
  };
  // the owner's evaluation: only after every machine check holds does a pass mean READY
  let owner: OwnerGate | null = null;
  if (e.ownerEvaluation !== undefined) {
    owner = ownerGate(e.ownerEvaluation === UNPARSEABLE ? null : e.ownerEvaluation, { runId: r.run_id, recordSha256: recordSha, compSetSha256: setSha });
    if (!owner.pass) add("COMP_NOT_OWNER_APPROVED", owner.reasons.join(","));
  }
  const verdict = out({ ...extra, owner });
  if (verdict.status !== "REJECT" && owner?.pass && composites.desktop_1440 && composites.mobile_390) {
    verdict.status = "READY_FOR_IMPLEMENTATION";
    HANDOFFS.set(verdict, { runId: r.run_id, recordSha256: recordSha, composites: { desktop_1440: composites.desktop_1440, mobile_390: composites.mobile_390 } });
  }
  return verdict;
}

/**
 * The picture's visible texts against the facts (the picture is never a fact source): a "fact" text must be a fact's
 * text (factParts); any other text, with the facts' texts and the allowed labels taken out, must not look like an
 * invented fact (INVENTED_FACT_SIGNS); a shop name must be this shop's. Counts only (the texts are never echoed).
 */
export function textProblems(texts: readonly { text: string; kind: string }[], facts: readonly { key: string; value: string }[], displayName: string): { fabricated: number; wrongName: number } {
  const parts = [...new Set(facts.flatMap((f) => [...factParts(f.value)]))].filter((x) => x.length > 0).sort((a, b) => b.length - a.length);
  const labels = new Set(Object.values(LABELS_BY_KEY).flat().map(norm));
  let fabricated = 0;
  let wrongName = 0;
  for (const t of texts) {
    const n = norm(t.text);
    if (t.kind === "shop_name") {
      if (cleanName(t.text) !== cleanName(displayName) || cleanName(t.text) === "") wrongName++;
      continue;
    }
    if (t.kind === "fact") {
      if (!facts.some((f) => factParts(f.value).has(n))) fabricated++;
      continue;
    }
    if (t.kind === "ui_label" && labels.has(n)) continue;
    let rest = n;
    for (const p of [...parts, norm(displayName)]) if (p) rest = rest.split(p).join("\u0000");
    if (INVENTED_FACT_SIGNS.some(([, re]) => rest.split("\u0000").some((piece) => re.test(piece)))) fabricated++;
  }
  return { fabricated, wrongName };
}
