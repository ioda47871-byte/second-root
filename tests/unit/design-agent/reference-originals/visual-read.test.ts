import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkVisualRead, coverage, imageSize, visualMode, type AssetNow } from "../../../../lib/design-agent/reference-originals/visual-read";
import { assetNow, checkAllReads, checkFails, matrixText } from "../../../../scripts/design-artifact/visual-read";

// DEV-158 (Issue #193 comments 6584276254 / 6591440695): only Claude's own viewing of the exact picture makes a view
// VISUAL_VERIFIED. A summary, a file name, a SHA or another AI's viewing never does.

const REPO = resolve(__dirname, "../../../..");
const READS = join(REPO, "design-library/research/quality-pipeline/visual-reads");
const one = () => JSON.parse(readFileSync(join(READS, "CP-003/desktop.read.json"), "utf8"));
const NOW = { sha256: one().asset.sha256, width: 1080, height: 3308 };
type Pic = { sha256: string; kind: string; view: string; in_repo_path: string | null };
const inventory = JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/originals-inventory.json"), "utf8")) as { cases: Array<{ id: string; originals: Pic[] }> };
const pictures = (id: string) => inventory.cases.find((c) => c.id === id)!.originals.filter((p) => p.kind === "original" || p.kind === "registered_preview");
const PICS = pictures("CP-003");
const codes = (r: unknown, now: AssetNow = NOW, pics: Pic[] = PICS) => {
  const c = checkVisualRead(r, now, { pictures: pics });
  return c.ok ? [] : c.codes;
};

describe("Claude's visual reads (DEV-158)", () => {
  it("every committed read passes against the file it names, and the matrix is the one the reads give", () => {
    const reads = checkAllReads();
    expect(reads.map((r) => `${r.case_id}/${r.view}`)).toEqual(["CP-001/concept", "CP-002/concept", "CP-003/desktop", "CP-003/mobile"]);
    for (const r of reads) expect(r.check, r.file).toEqual({ ok: true });
    expect(readFileSync(join(REPO, "design-library/research/quality-pipeline/visual-read-matrix.json"), "utf8")).toBe(matrixText(reads));
  });

  it("the matrix lists all 30 registered cases, 20 of them ChatGPT-viewed, with the kind of picture Claude read", () => {
    const m = JSON.parse(matrixText(checkAllReads())) as { cases: Array<{ id: string; text: { chatgpt_viewed: boolean }; read_by_Claude: Array<{ kind: string }> }> };
    expect(m.cases).toHaveLength(30);
    expect(m.cases.filter((c) => c.text.chatgpt_viewed)).toHaveLength(20);
    for (const c of m.cases) for (const r of c.read_by_Claude) expect(["original", "registered_preview"]).toContain(r.kind);
    expect(m.cases.find((c) => c.id === "CP-003")!.read_by_Claude.map((r) => r.kind)).toEqual(["registered_preview", "registered_preview"]);
  });

  it("text alone is never VISUAL_VERIFIED: the 20 ChatGPT-viewed cases stay TEXT_ONLY_PROVISIONAL unless Claude read them", () => {
    expect(visualMode(0, { chatgpt_viewed: true, case_note: true })).toBe("TEXT_ONLY_PROVISIONAL");
    expect(visualMode(0, { chatgpt_viewed: false, case_note: false })).toBe("MISSING_OR_HOLD");
    const m = JSON.parse(matrixText(checkAllReads())) as { cases: Array<{ id: string; text: { chatgpt_viewed: boolean }; read_by_Claude: Array<{ view: string }>; modes: Record<string, string> }> };
    for (const c of m.cases) {
      const views = c.read_by_Claude.map((r) => r.view);
      for (const [view, mode] of Object.entries(c.modes)) {
        if (mode === "VISUAL_VERIFIED") expect(views, `${c.id}/${view}`).toContain(view);
        else expect(views, `${c.id}/${view}`).not.toContain(view);
      }
      if (c.text.chatgpt_viewed && c.read_by_Claude.length === 0) expect(Object.values(c.modes).every((x) => x === "TEXT_ONLY_PROVISIONAL"), c.id).toBe(true);
    }
    // CP-009 / CP-016: ChatGPT viewed them and the owner matched the SHA, but Claude has not read them
    for (const id of ["CP-009", "CP-016"]) expect(Object.values(m.cases.find((c) => c.id === id)!.modes)).not.toContain("VISUAL_VERIFIED");
  });

  it("a record that only describes the picture (no crops, not marked viewed, a summary instead of boxes) fails", () => {
    const r = one();
    r.actually_viewed = false;
    expect(codes(r)).toEqual(["READ_SCHEMA"]);
    const s = one();
    s.viewed_crops = [];
    expect(codes(s)).toEqual(["READ_SCHEMA"]);
    const t = one();
    t.observation.observed = "ChatGPT の要約: 豆の弧と巨大な文字";
    expect(codes(t)).toEqual(["READ_SCHEMA"]);
    const u = one();
    u.reader.who = "chatgpt";
    expect(codes(u)).toEqual(["READ_SCHEMA"]);
  });

  it("the record is tied to the exact bytes and size of a file available now", () => {
    expect(codes(one(), null)).toContain("ASSET_NOT_AVAILABLE");
    expect(codes(one(), { ...NOW, sha256: "0".repeat(64) })).toContain("ASSET_SHA_MISMATCH");
    expect(codes(one(), { ...NOW, height: 3000 })).toContain("ASSET_SIZE_MISMATCH");
    expect(assetNow("intake:CP-009/desktop.png")).toBeNull(); // originals are not in the repository
    expect(assetNow("design-library/../package.json")).toBeNull();
  });

  it("the viewed crops must cover the picture; observations must be located, many and spread over it", () => {
    const r = one();
    r.viewed_crops = [{ x: 0, y: 0, w: 1080, h: 1100 }]; // only the first screen
    expect(codes(r)).toContain("CROPS_DO_NOT_COVER");
    const s = one();
    for (const items of Object.values(s.observation.observed) as Array<Array<{ box: { y: number; h: number } }>>) for (const it of items) it.box = { ...it.box, y: 10, h: 50 };
    expect(codes(s)).toContain("OBSERVATIONS_NOT_SPREAD");
    const t = one();
    const o = t.observation.observed;
    for (const k of Object.keys(o)) o[k] = k === "motif" || k === "hero_reading_order" ? o[k].slice(0, 1) : [];
    expect(codes(t)).toContain("TOO_FEW_LOCATED_OBSERVATIONS");
    const u = one();
    u.observation.observed.motif[0].box.y = 3300;
    expect(codes(u)).toContain("OBSERVATION_BOX_OUTSIDE");
  });

  it("a read must match exactly one adopted picture of its own case, view and kind (review H1/H2)", () => {
    // another case's picture relabelled
    const r = one();
    r.case_id = "CP-004";
    r.observation.case_id = "CP-004";
    r.asset.recorded_in_manifest = false;
    expect(codes(r, NOW, pictures("CP-004"))).toContain("PICTURE_NOT_RECORDED_FOR_CASE");
    // the desktop preview called mobile
    const m = JSON.parse(readFileSync(join(READS, "CP-003/mobile.read.json"), "utf8"));
    m.view = "desktop";
    m.observation.view = "desktop";
    m.observation.observed.mobile_recomposition = [];
    expect(codes(m, { sha256: m.asset.sha256, width: 390, height: 4502 })).toContain("PICTURE_KIND_VIEW_OR_PATH_MISMATCH");
    // a preview called an original, at a repository path
    const s = one();
    s.asset.kind = "original";
    expect(codes(s)).toEqual(expect.arrayContaining(["ORIGINAL_OUTSIDE_INTAKE", "PICTURE_KIND_VIEW_OR_PATH_MISMATCH"]));
    // a preview through intake, and a lie about the manifest
    const u = one();
    u.asset.path = "intake:CP-003/desktop.webp";
    expect(codes(u)).toEqual(expect.arrayContaining(["PREVIEW_IN_INTAKE", "PICTURE_KIND_VIEW_OR_PATH_MISMATCH"]));
    const v = one();
    v.asset.recorded_in_manifest = false;
    expect(codes(v)).toContain("MANIFEST_CLAIM_WRONG");
    // a JPEG is not a readable picture path
    const w = one();
    w.asset.path = "design-library/success-cases/assets/x.jpg";
    expect(codes(w)).toEqual(["READ_SCHEMA"]);
  });

  it("coverage is measured as area: two thin strips along the edges do not cover the picture (review M1)", () => {
    const r = one();
    r.viewed_crops = [{ x: 0, y: 0, w: 1, h: 3308 }, { x: 0, y: 0, w: 1080, h: 1 }];
    expect(codes(r)).toContain("CROPS_DO_NOT_COVER");
  });

  it("records name a session, never a model, and the reads folder holds no pictures", () => {
    for (const c of readdirSync(READS))
      for (const f of readdirSync(join(READS, c))) {
        expect(f).toMatch(/\.read\.json$/);
        const text = readFileSync(join(READS, c, f), "utf8");
        expect(text).not.toMatch(/opus|sonnet|haiku|fable|gpt-?\d/i);
        expect(JSON.parse(text).reader.session).toMatch(/^https:\/\/claude\.ai\/code\/session_/);
      }
  });

  it("reads the pixel size from PNG and WebP headers without decoding", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0xa0, 0, 0, 0x0b, 0x40]);
    expect(imageSize(png)).toEqual({ width: 1440, height: 2880 });
    expect(imageSize(readFileSync(join(REPO, "design-library/success-cases/assets/CP-003_NagoyaBeans_v4_mobile.webp")))).toEqual({ width: 390, height: 4502 });
    expect(imageSize(new TextEncoder().encode("not an image at all, just text"))).toBeNull();
    const riff = (kind: string, body: number[]) => {
      const b = new Uint8Array(30);
      b.set([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP"), ...new TextEncoder().encode(kind)]);
      b.set(body, 16);
      return b;
    };
    // VP8X: 24-bit width-1 and height-1 at 24 and 27
    expect(imageSize(riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x01, 0, 0xfc, 0x02, 0]))).toEqual({ width: 321, height: 765 });
    // VP8L: signature 0x2f, then 14-bit width-1 and height-1
    const w = 123 - 1;
    const h = 4567 - 1;
    const bits = w | (h << 14);
    expect(imageSize(riff("VP8L", [0, 0, 0, 0, 0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]))).toEqual({ width: 123, height: 4567 });
  });
  it("a read of an original absent here: only the missing file is excused; anything else still fails (review round 2 H1/M1)", () => {
    const cp009 = inventory.cases.find((c) => c.id === "CP-009")!.originals.find((p) => p.kind === "original" && p.view === "desktop")!;
    const make = () => {
      const r = one();
      Object.assign(r, { case_id: "CP-009" });
      r.observation.case_id = "CP-009";
      r.asset = { ...r.asset, path: "intake:CP-009/desktop.png", kind: "original", sha256: cp009.sha256, recorded_in_manifest: true };
      r.observation.image_sha256 = cp009.sha256;
      return r;
    };
    const dir = mkdtempSync(join(tmpdir(), "reads-"));
    mkdirSync(join(dir, "CP-009"));
    writeFileSync(join(dir, "CP-009", "desktop.read.json"), JSON.stringify(make()));
    let reads = checkAllReads(dir);
    expect(reads.map((r) => [r.check, r.bytes])).toEqual([[{ ok: true }, "not_in_ci"]]);
    expect(checkFails(reads)).toBe(false);
    // nothing in CI ties it to bytes (the original's SHA is public): it waits for the owner and never counts
    const m = JSON.parse(matrixText(reads)) as { cases: Array<{ id: string; modes: Record<string, string>; read_by_Claude: unknown[]; original_reads_pending_owner: Array<{ view: string }> }> };
    const c = m.cases.find((x) => x.id === "CP-009")!;
    expect(c.modes.desktop).toBe("TEXT_ONLY_PROVISIONAL");
    expect(c.read_by_Claude).toEqual([]);
    expect(c.original_reads_pending_owner.map((x) => x.view)).toEqual(["desktop"]);
    // not viewed, misplaced, a path that climbs out, or a picture not recorded for the case: still fail in CI
    const bad = make();
    bad.actually_viewed = false;
    writeFileSync(join(dir, "CP-009", "desktop.read.json"), JSON.stringify(bad));
    reads = checkAllReads(dir);
    expect(reads[0]!.check).toEqual({ ok: false, codes: ["READ_SCHEMA"] });
    expect(checkFails(reads)).toBe(true);
    const other = make();
    other.asset.path = "intake:../../../../package.png";
    expect(codes(other, null, pictures("CP-009"))).toEqual(["READ_SCHEMA"]);
    const wrong = make();
    wrong.asset.sha256 = "b".repeat(64);
    wrong.observation.image_sha256 = "b".repeat(64);
    wrong.asset.recorded_in_manifest = false;
    writeFileSync(join(dir, "CP-009", "desktop.read.json"), JSON.stringify(wrong));
    expect(checkAllReads(dir)[0]!.check).toEqual({ ok: false, codes: ["ASSET_NOT_AVAILABLE", "PICTURE_NOT_RECORDED_FOR_CASE"] });
    mkdirSync(join(dir, "CP-004"));
    writeFileSync(join(dir, "CP-004", "desktop.read.json"), JSON.stringify(make()));
    expect(checkAllReads(dir).find((r) => r.case_id === "CP-004")!.check).toEqual({ ok: false, codes: ["READ_FILE_PLACEMENT"] });
  });

  it("coverage counts only cells a crop covers whole: crop edges and gaps are not rounded up (round 2 L2)", () => {
    expect(coverage([{ x: 0, y: 0, w: 1081, h: 3309 }], 1081, 3309)).toBe(1);
    // two crops with a 6 px gap between them leave the gap uncovered
    expect(coverage([{ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 56, w: 100, h: 44 }], 100, 100)).toBeLessThan(1);
    // a 2 px crop straddling a cell boundary covers nothing
    expect(coverage([{ x: 3, y: 0, w: 2, h: 100 }], 100, 100)).toBe(0);
  });
  it("a file that is present but unreadable at an intake path fails; only absence is excused (round 3 M1)", () => {
    const intake = join(REPO, "design-library/research/quality-pipeline/.intake");
    mkdirSync(intake, { recursive: true });
    const tmp = mkdtempSync(join(intake, "dev158-test-"));
    const rel = `${tmp.slice(intake.length + 1)}/desktop.png`;
    const file = join(tmp, "desktop.png");
    try {
      writeFileSync(file, "not a picture");
      const now = assetNow(`intake:${rel}`);
      expect(now).toEqual({ unreadable: true, sha256: createHash("sha256").update("not a picture").digest("hex") });
      const r = one();
      expect(codes(r, now)).toEqual(expect.arrayContaining(["ASSET_UNREADABLE", "ASSET_SHA_MISMATCH"]));
      rmSync(file);
      mkdirSync(file);
      expect(assetNow(`intake:${rel}`)).toEqual({ unreadable: true, sha256: null });
      // a dangling link is there but unreadable, not absent (round 4 L1)
      rmSync(file, { recursive: true });
      symlinkSync(join(tmp, "nowhere.png"), file);
      expect(assetNow(`intake:${rel}`)).toEqual({ unreadable: true, sha256: null });
      rmSync(file);
      expect(assetNow(`intake:${rel}`)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("malformed reads are reported, not crashed on or skipped (round 3 L3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reads-"));
    writeFileSync(join(dir, "loose.json"), "{}");
    mkdirSync(join(dir, "CP-001"));
    writeFileSync(join(dir, "CP-001", "concept.read.json"), "null");
    writeFileSync(join(dir, "CP-001", "concept.read.JSON"), "{}");
    const reads = checkAllReads(dir);
    expect(Object.fromEntries(reads.map((r) => [r.file.split("/").slice(-2).join("/"), r.check.ok ? [] : r.check.codes]))).toEqual({
      "CP-001/concept.read.json": ["READ_SCHEMA"],
      "CP-001/concept.read.JSON": ["READ_FILE_PLACEMENT"],
      "visual-reads/loose.json": ["READ_FILE_PLACEMENT"],
    });
    expect(checkFails(reads)).toBe(true);
  });

  it("originals stay out of git: nothing is tracked under .intake/ and no tracked picture is an original (round 3 L2)", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(tracked.filter((p) => p.includes("quality-pipeline/.intake"))).toEqual([]);
    const originals = new Set(inventory.cases.flatMap((c) => c.originals.filter((p) => p.kind === "original").map((p) => p.sha256)));
    for (const p of tracked.filter((x) => /\.(png|webp|jpe?g)$/i.test(x))) expect(originals.has(createHash("sha256").update(readFileSync(join(REPO, p))).digest("hex")), p).toBe(false);
  });
});
