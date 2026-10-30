/**
 * Phase 2e (DEV-128, research-isolated): the implementation lane's input. Claude implements a design from the
 * Artifact's approved hand-off ONLY: the artifact record, the PC / SP originals and the design assets. Codex's own
 * prototype files (HTML / CSS in quarantine/) never reach the lane. (The artifact record itself carries Codex's design
 * notes as free text; that text is checked by the DEV-114 schema, not here.)
 *
 * prepareImplementationLane:
 * - runs the Artifact intake again (never trusts an earlier result) and refuses unless it allows a hand-off
 *   (render_pair_complete: concept-only or incomplete artifacts are never implemented);
 * - builds the lane in a new temporary directory next to it: exactly the intake's hand-off files (private modes,
 *   opened without following links, at most the size seen, SHA-256 re-checked), then lane.json;
 * - checks it (only the listed files and lane.json, nothing with the bytes of a prototype file) and only then renames
 *   it into place; on any failure the temporary directory is removed, so a lane either exists complete or not at all.
 *
 * What this is not: an OS-level separation. The lane is a separate directory a later implementation step is given;
 * running that step under another user / jail (so it could not read quarantine/ at all) is a separate, approved
 * change to the WSL environment and is not done here. Nothing here starts a process or calls a model.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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

/** Reads a regular file without following a link, at most the size it had when opened (a swapped FIFO or a huge file never hangs or fills memory). */
async function readNoFollow(path: string, max: number): Promise<Buffer | null> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return bytesRead === st.size ? buf : null;
  } finally {
    await fh.close();
  }
}

/** The largest file the hand-off can hold (the intake's own limits are lower). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function prepareImplementationLane(o: { packageDir: string; factsPath: string; laneDir: string }): Promise<LaneManifest> {
  const record = await intakeArtifact({ packageDir: o.packageDir, factsPath: o.factsPath });
  if (!record.implementation_handoff_allowed) throw new LaneStop("LANE_NOT_ALLOWED", record.verification_state);
  // real paths on both sides: a link can never place the lane inside the package (next to quarantine/)
  const packageDir = await realpath(o.packageDir);
  const parent = await realpath(dirname(resolve(o.laneDir))).catch(() => null);
  if (!parent || !(await lstat(parent).then((st) => st.isDirectory(), () => false))) throw new LaneStop("LANE_PARENT_MISSING");
  if (parent === packageDir || parent.startsWith(packageDir + sep)) throw new LaneStop("LANE_UNEXPECTED_CONTENT", "lane inside the package");
  const laneDir = join(parent, basename(resolve(o.laneDir)));
  if (await lstat(laneDir).then(() => true, () => false)) throw new LaneStop("LANE_EXISTS");

  const prototypeShas = new Set(record.files.filter((f) => f.role === "prototype").map((f) => f.sha256));
  const tmp = await mkdtemp(join(parent, `.${basename(laneDir)}.tmp-`));
  try {
    const files: LaneManifest["files"] = [];
    for (const f of record.handoff.files) {
      if (f.role === "prototype" || f.path.startsWith("quarantine/") || prototypeShas.has(f.sha256)) throw new LaneStop("LANE_UNEXPECTED_CONTENT", f.path);
      const bytes = await readNoFollow(join(packageDir, f.path), MAX_FILE_BYTES);
      if (!bytes) throw new LaneStop("LANE_FILE_INVALID", f.path);
      // the file read now is the one the intake checked
      if (sha256(bytes) !== f.sha256) throw new LaneStop("LANE_FILE_CHANGED", f.path);
      const dst = join(tmp, f.path);
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
      note: "The Codex prototype files are not in this lane. This is a separate directory, not an OS-level separation.",
    };
    await writeFile(join(tmp, "lane.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    // before it is visible: exactly the listed files, and no file with a prototype's bytes
    const present = await walk(tmp);
    const expected = [...files.map((f) => f.path), "lane.json"].sort();
    if (JSON.stringify(present) !== JSON.stringify(expected)) throw new LaneStop("LANE_UNEXPECTED_CONTENT", "file list");
    for (const p of present) if (prototypeShas.has(sha256(await readFile(join(tmp, p))))) throw new LaneStop("LANE_UNEXPECTED_CONTENT", p);
    // rename refuses a lane that appeared meanwhile only for a non-empty directory; check again just before
    if (await lstat(laneDir).then(() => true, () => false)) throw new LaneStop("LANE_EXISTS");
    const built = await lstat(tmp);
    await rename(tmp, laneDir);
    // the parent may have been swapped for a link after the first check: the lane's real place is checked once more.
    // Only the very directory built here (same device and inode) is ever removed, never whatever is at that path now.
    const placed = await realpath(laneDir);
    if (placed === packageDir || placed.startsWith(packageDir + sep)) {
      const there = await lstat(placed).catch(() => null);
      if (there && there.dev === built.dev && there.ino === built.ino) await rm(placed, { recursive: true, force: true });
      throw new LaneStop("LANE_UNEXPECTED_CONTENT", "lane inside the package");
    }
    return manifest;
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}
