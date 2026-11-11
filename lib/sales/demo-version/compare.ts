/**
 * DEV-196d (spec §4.1・§7.2・§7.5): comparing two versions of one shop's demo for the admin compare screen.
 *
 *  - diffManifests: which files were added, removed or changed (by sha256), per role.
 *  - diffLines: a bounded LCS line diff of the visible copy, keeping whether a line is a fact or a creative heading.
 *    Over the bounds it answers TOO_LARGE instead of spending unbounded time or memory.
 *  - diffStructure: the stored structure descriptors, aspect by aspect. Read as display data only: this module does
 *    not import the structure descriptor module (its vocabulary is provisional and behind its own boundary) and shows
 *    only vocabulary-shaped words (`[a-z_]`), never free text.
 *  - compareVersionMeta: hashes, facts, worker commit, validator codes and the rights summary.
 *  - defaultBaseVersion: what the candidate is compared with by default (the approved version, else its parent).
 *
 * There is no pixel diff in v1: the visual comparison is the two renders side by side.
 *
 * Pure.
 */
import type { ArtifactManifest, ArtifactRole } from "./manifest";

export type FileChange = "added" | "removed" | "changed" | "same";
export type FileDiffEntry = {
  name: string;
  role: ArtifactRole;
  change: FileChange;
  a: { sha256: string; bytes: number } | null;
  b: { sha256: string; bytes: number } | null;
};

export function diffManifests(a: ArtifactManifest, b: ArtifactManifest): { entries: FileDiffEntry[]; counts: Record<FileChange, number> } {
  const am = new Map(a.files.map((f) => [f.name, f]));
  const bm = new Map(b.files.map((f) => [f.name, f]));
  const names = [...new Set([...am.keys(), ...bm.keys()])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const counts: Record<FileChange, number> = { added: 0, removed: 0, changed: 0, same: 0 };
  const entries = names.map((name): FileDiffEntry => {
    const fa = am.get(name) ?? null;
    const fb = bm.get(name) ?? null;
    const change: FileChange = !fa ? "added" : !fb ? "removed" : fa.sha256 === fb.sha256 && fa.bytes === fb.bytes ? "same" : "changed";
    counts[change]++;
    return {
      name,
      role: (fb ?? fa)!.role,
      change,
      a: fa ? { sha256: fa.sha256, bytes: fa.bytes } : null,
      b: fb ? { sha256: fb.sha256, bytes: fb.bytes } : null,
    };
  });
  return { entries, counts };
}

export type CopyLineKind = "fact" | "creative" | "unknown";
export type CopyLine = { text: string; kind: CopyLineKind };
export type LineOp = { op: "same" | "add" | "del"; text: string; kind: CopyLineKind };

/** Bounds of the line diff (lines per side, and DP cells after the common prefix and suffix are removed). */
export const LINE_DIFF_LIMITS = { lines: 2000, cells: 2_000_000, lineChars: 2000 } as const;

export type LineDiffResult = { ok: true; ops: LineOp[]; added: number; removed: number } | { ok: false; reason: "TOO_LARGE" };

const sameLine = (x: CopyLine, y: CopyLine) => x.text === y.text && x.kind === y.kind;

/** A line diff by longest common subsequence. Lines compare by text and kind (a heading becoming a fact is a change). */
export function diffLines(a: readonly CopyLine[], b: readonly CopyLine[]): LineDiffResult {
  if (a.length > LINE_DIFF_LIMITS.lines || b.length > LINE_DIFF_LIMITS.lines) return { ok: false, reason: "TOO_LARGE" };
  if ([...a, ...b].some((l) => typeof l.text !== "string" || l.text.length > LINE_DIFF_LIMITS.lineChars)) return { ok: false, reason: "TOO_LARGE" };
  let start = 0;
  while (start < a.length && start < b.length && sameLine(a[start]!, b[start]!)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && sameLine(a[endA - 1]!, b[endB - 1]!)) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if ((n + 1) * (m + 1) > LINE_DIFF_LIMITS.cells) return { ok: false, reason: "TOO_LARGE" };
  // lcs[i][j] = LCS length of a[start+i..endA) and b[start+j..endB)
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = sameLine(a[start + i]!, b[start + j]!) ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const ops: LineOp[] = a.slice(0, start).map((l) => ({ op: "same", text: l.text, kind: l.kind }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && sameLine(a[start + i]!, b[start + j]!)) {
      ops.push({ op: "same", text: a[start + i]!.text, kind: a[start + i]!.kind });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
      ops.push({ op: "add", text: b[start + j]!.text, kind: b[start + j]!.kind });
      j++;
    } else {
      ops.push({ op: "del", text: a[start + i]!.text, kind: a[start + i]!.kind });
      i++;
    }
  }
  for (const l of a.slice(endA)) ops.push({ op: "same", text: l.text, kind: l.kind });
  return { ok: true, ops, added: ops.filter((o) => o.op === "add").length, removed: ops.filter((o) => o.op === "del").length };
}

/** The 8 aspects of a stored structure descriptor (same names as the descriptor; restated, not imported). */
export const STRUCTURE_ASPECTS = ["hero", "flow", "navigation", "reading_path", "section_layouts", "transitions", "text_direction", "imagery"] as const;
export type StructureAspect = (typeof STRUCTURE_ASPECTS)[number];

const WORD = /^[a-z][a-z_]{0,39}$/;

/** One aspect as display text: a vocabulary word, a "→"-joined sequence, or null (missing, unmeasured or not a word). */
function aspectText(descriptor: unknown, aspect: StructureAspect): string | null {
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) return null;
  const entry = (descriptor as Record<string, unknown>)[aspect];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const value = (entry as Record<string, unknown>).value;
  if (typeof value === "string") return WORD.test(value) ? value : null;
  if (Array.isArray(value) && value.length > 0 && value.length <= 40 && value.every((v) => typeof v === "string" && WORD.test(v))) return value.join(" → ");
  return null;
}

export type StructureDiffEntry = { aspect: StructureAspect; a: string | null; b: string | null; changed: boolean };

/** Aspect by aspect. An aspect missing on either side counts as changed unless both are missing (unknown is not "same"). */
export function diffStructure(a: unknown, b: unknown): StructureDiffEntry[] {
  return STRUCTURE_ASPECTS.map((aspect) => {
    const x = aspectText(a, aspect);
    const y = aspectText(b, aspect);
    return { aspect, a: x, b: y, changed: x !== y };
  });
}

const CODE = /^[A-Z][A-Z0-9_]{2,47}$/;

/** The fixed codes of a stored `validator_result` (`{ok, codes[]}`), and whether it passed. Anything else → not ok. */
export function validatorCodes(result: unknown): { ok: boolean; codes: string[] } {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return { ok: false, codes: [] };
  const r = result as Record<string, unknown>;
  const codes = Array.isArray(r.codes) ? [...new Set(r.codes.filter((c): c is string => typeof c === "string" && CODE.test(c)))].sort() : [];
  return { ok: r.ok === true, codes };
}

/** The `by_status` counts of a stored rights summary (§8.4), known keys and safe integers only. */
export function rightsCounts(summary: unknown): Record<string, number> {
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return {};
  const by = (summary as Record<string, unknown>).by_status;
  if (typeof by !== "object" || by === null || Array.isArray(by)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(by)) if (/^[a-z_]{1,40}$/.test(k) && Number.isSafeInteger(v) && (v as number) >= 0) out[k] = v as number;
  return out;
}

export type VersionMetaInput = {
  id: string;
  bundle_sha256: string;
  facts_sha256: string;
  worker_commit: string | null;
  validator_result: unknown;
  rights_summary: unknown;
};

export type VersionMetaDiff = {
  bundleChanged: boolean;
  factsChanged: boolean;
  workerCommit: { a: string | null; b: string | null; changed: boolean };
  validator: { a: { ok: boolean; codes: string[] }; b: { ok: boolean; codes: string[] }; added: string[]; removed: string[] };
  rights: { status: string; a: number; b: number }[];
};

export function compareVersionMeta(a: VersionMetaInput, b: VersionMetaInput): VersionMetaDiff {
  const va = validatorCodes(a.validator_result);
  const vb = validatorCodes(b.validator_result);
  const ra = rightsCounts(a.rights_summary);
  const rb = rightsCounts(b.rights_summary);
  const commit = (c: string | null) => (typeof c === "string" && /^[0-9a-f]{7,40}$/.test(c) ? c : null);
  return {
    bundleChanged: a.bundle_sha256 !== b.bundle_sha256,
    factsChanged: a.facts_sha256 !== b.facts_sha256,
    workerCommit: { a: commit(a.worker_commit), b: commit(b.worker_commit), changed: commit(a.worker_commit) !== commit(b.worker_commit) },
    validator: { a: va, b: vb, added: vb.codes.filter((c) => !va.codes.includes(c)), removed: va.codes.filter((c) => !vb.codes.includes(c)) },
    rights: [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort().map((status) => ({ status, a: ra[status] ?? 0, b: rb[status] ?? 0 })),
  };
}

/**
 * The version the candidate is compared with by default: the demo's approved version (when it is not the candidate),
 * else the candidate's parent, else none. Only ids of this demo's versions are returned.
 */
export function defaultBaseVersion(o: {
  candidateId: string;
  approvedVersionId: string | null;
  versions: ReadonlyArray<{ id: string; parent_version_id: string | null }>;
}): string | null {
  const ids = new Set(o.versions.map((v) => v.id));
  const candidate = o.versions.find((v) => v.id === o.candidateId);
  if (!candidate) return null;
  if (o.approvedVersionId && o.approvedVersionId !== o.candidateId && ids.has(o.approvedVersionId)) return o.approvedVersionId;
  if (candidate.parent_version_id && ids.has(candidate.parent_version_id)) return candidate.parent_version_id;
  return null;
}
