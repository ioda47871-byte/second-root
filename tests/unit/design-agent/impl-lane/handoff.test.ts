import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LaneStop, prepareImplementationLane } from "@/lib/design-agent/impl-lane/handoff";
import { CSS, HTML, routeA, routeB, routeC, writePackage, type Pkg } from "../artifact/fixtures";

// DEV-128 (Phase 2e, research-isolated, Issue #159): the implementation lane gets the approved hand-off only, never the
// Codex prototype source. Fictional fixtures; no process, no model.

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const pkg = (p: Pkg) => {
  const w = writePackage(p);
  made.push(w.base);
  return w;
};
const laneParent = () => {
  const d = mkdtempSync(join(tmpdir(), "dev128-lane-"));
  made.push(d);
  return d;
};
const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof LaneStop ? e.code : String(e)));
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name])).sort();

describe("the implementation lane (hand-off only)", () => {
  it("route B: the lane holds the artifact record and the PC / SP originals, never the prototype HTML / CSS", async () => {
    const w = pkg(routeB());
    const laneDir = join(laneParent(), "lane");
    const m = await prepareImplementationLane({ packageDir: w.dir, factsPath: w.factsPath, laneDir });
    expect(filesUnder(laneDir)).toEqual(["artifact.json", "lane.json", "originals/desktop_1440.png", "originals/mobile_390.png"]);
    expect(m.files.map((f) => f.role)).toEqual(["artifact", "original", "original"]);
    // no prototype bytes or text anywhere in the lane
    for (const f of filesUnder(laneDir)) {
      const text = readFileSync(join(laneDir, f)).toString("latin1");
      expect(text, f).not.toContain(HTML);
      expect(text, f).not.toContain(CSS);
    }
    expect(statSync(laneDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(laneDir, "originals/desktop_1440.png")).mode & 0o777).toBe(0o600);
  });

  it("route C: the generated asset is handed over with the originals", async () => {
    const w = pkg(routeC());
    const laneDir = join(laneParent(), "lane");
    await prepareImplementationLane({ packageDir: w.dir, factsPath: w.factsPath, laneDir });
    expect(filesUnder(laneDir).filter((f) => f.startsWith("assets/"))).toHaveLength(1);
    expect(filesUnder(laneDir).some((f) => f.startsWith("quarantine/"))).toBe(false);
  });

  it("refuses a concept-only or incomplete artifact, an existing lane, a missing parent, a lane inside the package", async () => {
    const a = pkg(routeA());
    expect(await code(prepareImplementationLane({ packageDir: a.dir, factsPath: a.factsPath, laneDir: join(laneParent(), "lane") }))).toBe("LANE_NOT_ALLOWED");
    const b = pkg(routeB());
    const parent = laneParent();
    mkdirSync(join(parent, "lane"));
    expect(await code(prepareImplementationLane({ packageDir: b.dir, factsPath: b.factsPath, laneDir: join(parent, "lane") }))).toBe("LANE_EXISTS");
    expect(await code(prepareImplementationLane({ packageDir: b.dir, factsPath: b.factsPath, laneDir: join(parent, "no", "lane") }))).toBe("LANE_PARENT_MISSING");
    expect(await code(prepareImplementationLane({ packageDir: b.dir, factsPath: b.factsPath, laneDir: join(b.dir, "lane") }))).toBe("LANE_UNEXPECTED_CONTENT");
    // a refused lane is never created
    expect(readdirSync(b.dir)).not.toContain("lane");
  });

  it("M1: a link can never put the lane inside the package (either side of the comparison)", async () => {
    const b = pkg(routeB());
    const t = laneParent();
    symlinkSync(b.dir, join(t, "link"));
    expect(await code(prepareImplementationLane({ packageDir: b.dir, factsPath: b.factsPath, laneDir: join(t, "link", "originals", "lane") }))).toBe("LANE_UNEXPECTED_CONTENT");
    expect(await code(prepareImplementationLane({ packageDir: join(t, "link"), factsPath: b.factsPath, laneDir: join(b.dir, "lane") }))).toBe("LANE_UNEXPECTED_CONTENT");
    expect(readdirSync(join(b.dir, "originals")).sort()).toEqual(["desktop_1440.png", "mobile_390.png"]);
  });

  it("L2: a failed lane leaves nothing behind (no partial lane, no temporary directory)", async () => {
    const b = pkg(routeB());
    const parent = laneParent();
    // the second original is swapped after the intake has checked it, but before it is copied
    const { prepareImplementationLane: prep } = await import("@/lib/design-agent/impl-lane/handoff");
    const swap = setImmediate(() => writeFileSync(join(b.dir, "originals/mobile_390.png"), "swapped"));
    const r = await code(prep({ packageDir: b.dir, factsPath: b.factsPath, laneDir: join(parent, "lane") }));
    clearImmediate(swap);
    // whether the swap landed before or after the copy, there is either a complete lane or nothing
    const left = readdirSync(parent);
    if (r === "OK") expect(left).toEqual(["lane"]);
    else expect(left).toEqual([]);
  });

  it("an unsafe or altered package is stopped by the intake before anything is copied", async () => {
    const b = pkg(routeB());
    writeFileSync(join(b.dir, "originals/mobile_390.png"), "not the checked file");
    const parent = laneParent();
    await expect(prepareImplementationLane({ packageDir: b.dir, factsPath: b.factsPath, laneDir: join(parent, "lane") })).rejects.toBeTruthy();
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe("isolation", () => {
  it("imports only the intake and node built-ins; starts no process, calls no model; imported by nothing else yet", () => {
    const repo = resolve(__dirname, "../../../..");
    // the whole directory: exactly this one file (L3), with exactly these imports
    expect(readdirSync(resolve(repo, "lib/design-agent/impl-lane"))).toEqual(["handoff.ts"]);
    const src = readFileSync(resolve(repo, "lib/design-agent/impl-lane/handoff.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../artifact/intake", "node:crypto", "node:fs", "node:fs/promises", "node:path"]);
    // exactly these five static imports, and no other way to load a module (re-review L2)
    expect(src.match(/\bimport\b/g)).toHaveLength(5);
    expect(src).not.toMatch(/\brequire\b|\bimport\s*\(/);
    expect(src).not.toMatch(/child_process|\bfetch\(|codex|anthropic|openai|quarantine\/["']\s*\+/);
    const g = spawnSync("git", ["grep", "--untracked", "-lE", "impl-lane/handoff|from [\"'`]\\./handoff[\"'`]", "--", "lib", "app", "components", "scripts", "proxy.ts", "supabase", ":!lib/design-agent/impl-lane/**"], { cwd: repo, encoding: "utf8" });
    expect([g.status, g.stdout.trim()]).toEqual([1, ""]);
  });
});
