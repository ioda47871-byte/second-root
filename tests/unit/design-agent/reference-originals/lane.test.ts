import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { measureOriginal } from "../../../../lib/design-agent/reference-originals/features";
import { checkObservation } from "../../../../lib/design-agent/reference-originals/observation";
import { decodePng } from "../../../../lib/design-agent/worker/png-paint";

const REPO = resolve(__dirname, "../../../..");
const CLI = "scripts/design-artifact/reference-original.ts";
const REF = "design-library/research/quality-pipeline/references";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A minimal RGB PNG (filter 0 on every row). */
function rgbPng(width: number, height: number, colour: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const run = (args: string[]) => {
  const r = spawnSync("npx", ["tsx", CLI, ...args], { cwd: REPO, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: JSON.parse(r.stdout || "{}") as Record<string, unknown> };
};

describe("image reference lane: features (DEV-155, Issue #193)", () => {
  it("finds the grounds of a page's sections from the row edges, even under a picture in the middle", () => {
    // three sections: cream 0-400, deep green 400-900 (with a noisy 'photo' in the middle), cream 900-1200
    const png = rgbPng(300, 1200, (x, y) => {
      if (y >= 400 && y < 900) return x > 60 && x < 240 && y > 450 && y < 850 ? [(x * 37 + y * 11) % 256, (x * 13) % 256, (y * 29) % 256] : [24, 56, 40];
      return [248, 244, 232];
    });
    const f = measureOriginal(png, decodePng(png));
    expect(f.bands.map((b) => [b.top, b.bottom])).toEqual([
      [0, 400],
      [400, 900],
      [900, 1200],
    ]);
    expect(f.bands[1]!.photo_share).toBeGreaterThan(0.3);
    expect(f.bands[0]!.photo_share).toBe(0);
    expect(f.advisory).toBe(true);
  });
});

describe("image reference lane: intake CLI", { timeout: 60_000 }, () => {
  it("refuses a picture whose SHA-256 is not the recorded one, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ref-lane-"));
    const file = join(dir, "x.png");
    writeFileSync(file, rgbPng(10, 10, () => [1, 2, 3]));
    const out = join(dir, "rec.json");
    const r = run(["--intake", "--case", "CP-016", "--key", "desktop_1440_png_sha256", "--file", file, "--out", out]);
    expect(r.code).toBe(2);
    expect(r.out.code).toBe("SHA_MISMATCH");
    expect(r.out.expected).toBe("9ea42fe1cc87056d2810069343aa937468048917650897fe69780f1e7e08107e");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses keys that are not pictures and rejected versions (counter-examples are not success references)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ref-lane-"));
    const file = join(dir, "x.png");
    writeFileSync(file, rgbPng(10, 10, () => [1, 2, 3]));
    expect(run(["--intake", "--case", "CP-016", "--key", "title", "--file", file, "--out", join(dir, "a.json")]).out.code).toBe("KEY_UNKNOWN");
    expect(run(["--intake", "--case", "CP-999", "--key", "x_sha256", "--file", file, "--out", join(dir, "b.json")]).out.code).toBe("CASE_UNKNOWN");
    const rejected = run(["--intake", "--case", "CP-023", "--key", "v1_rejected_sha256", "--file", file, "--out", join(dir, "c.json")]);
    expect([rejected.out.code, rejected.out.kind]).toEqual(["NOT_A_SUCCESS_PICTURE", "rejected"]);
    const comparison = run(["--intake", "--case", "CP-009", "--key", "hero_comparison_png_sha256", "--file", file, "--out", join(dir, "d.json")]);
    expect([comparison.out.code, comparison.out.kind]).toEqual(["NOT_A_SUCCESS_PICTURE", "comparison"]);
  });
});

describe("image reference lane: the committed CP-003 records and observations", { timeout: 60_000 }, () => {
  const manifest = JSON.parse(readFileSync(resolve(REPO, "design-library/success-cases/manifest.json"), "utf8")) as { records: Array<Record<string, string>> };
  const cp003 = manifest.records.find((r) => r.id === "CP-003")!;
  for (const view of ["desktop", "mobile"] as const) {
    it(`${view}: the record names the in-repo picture by its recorded SHA-256; the observation is of exactly it`, () => {
      const record = JSON.parse(readFileSync(resolve(REPO, `${REF}/CP-003/${view}.record.json`), "utf8"));
      const key = view === "desktop" ? "webp_sha256" : "mobile_webp_sha256";
      expect(record.image_sha256).toBe(cp003[key]);
      expect(sha(readFileSync(resolve(REPO, record.provenance.in_repo_path)))).toBe(record.image_sha256);
      expect(record.provenance.picture_committed_by_this_lane).toBe(false);
      expect(record.kind).toBe("registered_preview");
      const obs = JSON.parse(readFileSync(resolve(REPO, `${REF}/CP-003/${view}.observation.json`), "utf8"));
      expect(checkObservation(obs, record)).toEqual({ ok: true });
    });
  }

  it("an observation that names another picture, or a box outside it, is refused", () => {
    const record = JSON.parse(readFileSync(resolve(REPO, `${REF}/CP-003/desktop.record.json`), "utf8"));
    const obs = JSON.parse(readFileSync(resolve(REPO, `${REF}/CP-003/desktop.observation.json`), "utf8"));
    expect(checkObservation({ ...obs, image_sha256: "0".repeat(64) }, record)).toEqual({ ok: false, codes: ["OBSERVATION_IMAGE_MISMATCH"] });
    const outside = structuredClone(obs);
    outside.observed.motif[0].box = { x: 1000, y: 0, w: 200, h: 10 };
    expect(checkObservation(outside, record)).toEqual({ ok: false, codes: ["OBSERVATION_BOX_OUTSIDE"] });
    const mobileOnDesktop = structuredClone(obs);
    mobileOnDesktop.observed.mobile_recomposition = [{ what: "x", box: { x: 0, y: 0, w: 1, h: 1 } }];
    expect(checkObservation(mobileOnDesktop, record)).toEqual({ ok: false, codes: ["OBSERVATION_MOBILE_ONLY"] });
    expect(checkObservation({ ...obs, extra: 1 }, record)).toEqual({ ok: false, codes: ["OBSERVATION_SCHEMA"] });
  });

  it("a malformed record or one whose picture is not in the manifest is refused before the observation is read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ref-lane-"));
    const record = JSON.parse(readFileSync(resolve(REPO, `${REF}/CP-003/desktop.record.json`), "utf8"));
    const obs = resolve(REPO, `${REF}/CP-003/desktop.observation.json`);
    const noSize = join(dir, "no-size.json");
    const rest = { ...record };
    delete rest.width;
    delete rest.height;
    writeFileSync(noSize, JSON.stringify(rest));
    expect(run(["--check-observation", "--record", noSize, "--observation", obs]).out.code).toBe("RECORD_INVALID");
    const forged = join(dir, "forged.json");
    writeFileSync(forged, JSON.stringify({ ...record, image_sha256: "0".repeat(64) }));
    expect(run(["--check-observation", "--record", forged, "--observation", obs]).out.code).toBe("RECORD_NOT_IN_MANIFEST");
    expect(run(["--check-observation", "--record", noSize, "--bogus", "1"]).out.code).toBe("USAGE");
  });

  it("no picture is committed under the research references (the repository is public): every file there is JSON", () => {
    const listed = spawnSync("git", ["ls-files", REF], { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    expect(listed.length).toBeGreaterThan(0);
    for (const p of listed) expect(() => JSON.parse(readFileSync(resolve(REPO, p), "utf8"))).not.toThrow();
  });
});
