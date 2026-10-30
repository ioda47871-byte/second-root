/**
 * Phase 2e (DEV-128, research-isolated): the implementation lane's input. Claude implements a design from the
 * Artifact's approved hand-off ONLY: the artifact record, the PC / SP originals and the design assets. Codex's own
 * prototype source (HTML / CSS in quarantine/) never reaches the lane, so the implementation cannot be a copy of it.
 *
 * prepareImplementationLane:
 * - runs the Artifact intake again (never trusts an earlier result) and refuses unless it allows a hand-off
 *   (render_pair_complete: concept-only or incomplete artifacts are never implemented);
 * - copies exactly the intake's hand-off files into a NEW lane directory (private modes, never overwriting),
 *   re-checking each file's SHA-256 as it is read, refusing links;
 * - checks the lane afterwards: only the listed files and lane.json, nothing with the bytes of a prototype file.
 *
 * What this is not: an OS-level separation. The lane is a separate directory a later implementation step is given;
 * running that step under another user / jail (so it could not read quarantine/ at all) is a separate, approved
 * change to the WSL environment and is not done here. Nothing here starts a process or calls a model.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { intakeArtifact } from "../artifact/intake";

export class LaneStop extends Error {
  constructor(
    readonly code: "LANE_NOT_ALLOWED" | "LANE_EXISTS" | "LANE_PARENT_MISSING" | "LANE_FILE_INVALID" | "LANE_FILE_CHANGED" | "LANE_UNEXPECTED_CONTENT",
    readonly detail = "",
  ) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "LaneStop";
  }
}

export type LaneManifest = {
  schema: "implementation_lane_v1";
  artifact_id: string;
  artifact_json_sha256: string;
  files: { path: string; role: string; sha256: string }[];
  excluded_roles: readonly ["prototype"];
  note: string;
};

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort();
}

export async function prepareImplementationLane(o: { packageDir: string; factsPath: string; laneDir: string }): Promise<LaneManifest> {
  const packageDir = resolve(o.packageDir);
  const laneDir = resolve(o.laneDir);
  const record = await intakeArtifact({ packageDir, factsPath: o.factsPath });
  if (!record.implementation_handoff_allowed) throw new LaneStop("LANE_NOT_ALLOWED", record.verification_state);
  // the lane is outside the package (a lane inside it would sit next to quarantine/)
  if (laneDir === packageDir || laneDir.startsWith(packageDir + sep)) throw new LaneStop("LANE_UNEXPECTED_CONTENT", "lane inside the package");
  if (!(await lstat(dirname(laneDir)).then((s) => s.isDirectory(), () => false))) throw new LaneStop("LANE_PARENT_MISSING");
  try {
    await mkdir(laneDir, { mode: 0o700 });
  } catch {
    throw new LaneStop("LANE_EXISTS");
  }

  const prototypeShas = new Set(record.files.filter((f) => f.role === "prototype").map((f) => f.sha256));
  const files: LaneManifest["files"] = [];
  for (const f of record.handoff.files) {
    if (f.role === "prototype" || f.path.startsWith("quarantine/") || prototypeShas.has(f.sha256)) throw new LaneStop("LANE_UNEXPECTED_CONTENT", f.path);
    const src = join(packageDir, f.path);
    const st = await lstat(src).catch(() => null);
    if (!st || !st.isFile()) throw new LaneStop("LANE_FILE_INVALID", f.path);
    const bytes = await readFile(src);
    // the file read now is the one the intake checked
    if (sha256(bytes) !== f.sha256) throw new LaneStop("LANE_FILE_CHANGED", f.path);
    const dst = join(laneDir, f.path);
    await mkdir(dirname(dst), { recursive: true, mode: 0o700 });
    await writeFile(dst, bytes, { mode: 0o600, flag: "wx" });
    files.push({ path: f.path, role: f.role, sha256: f.sha256 });
  }
  const manifest: LaneManifest = {
    schema: "implementation_lane_v1",
    artifact_id: record.artifact_id,
    artifact_json_sha256: record.artifact_json_sha256,
    files,
    excluded_roles: ["prototype"],
    note: "The Codex prototype source is not in this lane. This is a separate directory, not an OS-level separation.",
  };
  await writeFile(join(laneDir, "lane.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });

  // afterwards: exactly the listed files, and no file with a prototype's bytes
  const present = await walk(laneDir);
  const expected = [...files.map((f) => f.path), "lane.json"].sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) throw new LaneStop("LANE_UNEXPECTED_CONTENT", "file list");
  for (const p of present) if (prototypeShas.has(sha256(await readFile(join(laneDir, p))))) throw new LaneStop("LANE_UNEXPECTED_CONTENT", p);
  return manifest;
}
