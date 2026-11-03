import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkVisualRead, imageSize, visualMode } from "../../../../lib/design-agent/reference-originals/visual-read";
import { assetNow, checkAllReads, matrixText } from "../../../../scripts/design-artifact/visual-read";

// DEV-158 (Issue #193 comments 6584276254 / 6591440695): only Claude's own viewing of the exact picture makes a view
// VISUAL_VERIFIED. A summary, a file name, a SHA or another AI's viewing never does.

const REPO = resolve(__dirname, "../../../..");
const READS = join(REPO, "design-library/research/quality-pipeline/visual-reads");
const one = () => JSON.parse(readFileSync(join(READS, "CP-003/desktop.read.json"), "utf8"));
const NOW = { sha256: one().asset.sha256, width: 1080, height: 3308 };
const SHAS = [NOW.sha256];
const codes = (r: unknown, now = NOW as typeof NOW | null, shas = SHAS) => {
  const c = checkVisualRead(r, now, { manifestSha256s: shas });
  return c.ok ? [] : c.codes;
};

describe("Claude's visual reads (DEV-158)", () => {
  it("every committed read passes against the file it names, and the matrix is the one the reads give", () => {
    const reads = checkAllReads();
    expect(reads.map((r) => `${r.case_id}/${r.view}`)).toEqual(["CP-001/concept", "CP-002/concept", "CP-003/desktop", "CP-003/mobile"]);
    for (const r of reads) expect(r.check, r.file).toEqual({ ok: true });
    expect(readFileSync(join(REPO, "design-library/research/quality-pipeline/visual-read-matrix.json"), "utf8")).toBe(matrixText(reads));
  });

  it("text alone is never VISUAL_VERIFIED: the 20 ChatGPT-viewed cases stay TEXT_ONLY_PROVISIONAL unless Claude read them", () => {
    expect(visualMode(0, { chatgpt_viewed: true, case_note: true })).toBe("TEXT_ONLY_PROVISIONAL");
    expect(visualMode(0, { chatgpt_viewed: false, case_note: false })).toBe("MISSING_OR_HOLD");
    const m = JSON.parse(matrixText(checkAllReads())) as { cases: Array<{ id: string; text: { chatgpt_viewed: boolean }; read_by_Claude: string[]; modes: Record<string, string> }> };
    for (const c of m.cases) {
      for (const [view, mode] of Object.entries(c.modes)) {
        if (mode === "VISUAL_VERIFIED") expect(c.read_by_Claude, `${c.id}/${view}`).toContain(view);
        else expect(c.read_by_Claude, `${c.id}/${view}`).not.toContain(view);
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

  it("an original must be one the manifest records, and the record must say truly whether its SHA is recorded", () => {
    const r = one();
    r.asset.kind = "original";
    expect(codes(r, NOW, [])).toEqual(expect.arrayContaining(["ORIGINAL_NOT_IN_MANIFEST", "MANIFEST_CLAIM_WRONG"]));
    const s = one();
    s.asset.recorded_in_manifest = false;
    expect(codes(s)).toContain("MANIFEST_CLAIM_WRONG");
  });

  it("records name a session, never a model, and the reads folder holds no pictures", () => {
    for (const c of readdirSync(READS))
      for (const f of readdirSync(join(READS, c))) {
        expect(f).toMatch(/\.read\.json$/);
        const text = readFileSync(join(READS, c, f), "utf8");
        expect(text).not.toMatch(/claude-(opus|sonnet|haiku|fable)|gpt-\d/i);
        expect(JSON.parse(text).reader.session).toMatch(/^https:\/\/claude\.ai\/code\/session_/);
      }
  });

  it("reads the pixel size from PNG and WebP headers without decoding", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0xa0, 0, 0, 0x0b, 0x40]);
    expect(imageSize(png)).toEqual({ width: 1440, height: 2880 });
    expect(imageSize(readFileSync(join(REPO, "design-library/success-cases/assets/CP-003_NagoyaBeans_v4_mobile.webp")))).toEqual({ width: 390, height: 4502 });
    expect(imageSize(new TextEncoder().encode("not an image at all, just text"))).toBeNull();
  });
});
