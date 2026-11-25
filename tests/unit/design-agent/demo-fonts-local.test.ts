import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAMILIES, MANIFEST_PATH, MODULE_PATH, checkCommitted, formatManifest, renderModule } from "../../../scripts/fonts/generate-demo-fonts.mjs";

// DEV-303: the demo display faces are committed files loaded with next/font/local
// (no Google Fonts download at build time). The generated module must be exactly
// what the manifest renders to, every committed font file must match the
// manifest, and the faces must be declared as next/font/google declared them.

type Face = { file: string; weight: string; style: string; stretch: string | null; unicodeRange: string; subset: string | null; preload: boolean; bytes: number; sha256: string; source: string };
type Family = { dir: string; family: string; exportName: string; variable: string; google: string; license: { package: string; version: string; copyright: string }; faces: Face[] };
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { families: Family[] };
const byVar = new Map(manifest.families.map((f) => [f.variable, f]));

describe("demo fonts, self-hosted with next/font/local (DEV-303)", () => {
  it("regenerating from the manifest is byte-identical, and every committed file matches it", () => {
    expect(readFileSync(MODULE_PATH, "utf8")).toBe(renderModule(manifest));
    expect(readFileSync(MANIFEST_PATH, "utf8")).toBe(formatManifest(manifest));
    expect(checkCommitted()).toEqual([]);
  });

  it("the manifest is the generator's families: next/font/google's requests, pinned license packages", () => {
    type Source = { family: string; google: string; license: { package: string; version: string } };
    const key = (f: Source) => `${f.family} ${f.google} ${f.license.package}@${f.license.version}`;
    expect(manifest.families.map(key)).toEqual((FAMILIES as Source[]).map(key));
    for (const f of manifest.families) for (const x of f.faces) expect(x.source.startsWith("https://fonts.gstatic.com/"), x.file).toBe(true);
  });

  it("the families, weights, styles, axes and preloads equal fixed expected values (those next/font/google had)", () => {
    const shape = (v: string) => {
      const f = byVar.get(v)!;
      return { family: f.family, faces: [...new Set(f.faces.map((x) => `${x.weight}/${x.style}/${x.stretch ?? "-"}`))], preloaded: f.faces.filter((x) => x.preload).map((x) => `${x.subset}/${x.style}`) };
    };
    expect(shape("--font-editorial")).toEqual({ family: "Playfair Display", faces: ["400 900/italic/-", "400 900/normal/-"], preloaded: ["latin/italic", "latin/normal"] });
    expect(shape("--font-grotesk")).toEqual({ family: "Archivo", faces: ["100 900/normal/62% 125%"], preloaded: ["latin/normal"] });
    expect(shape("--font-ja-editorial")).toEqual({ family: "Zen Old Mincho", faces: ["400/normal/-", "900/normal/-"], preloaded: [] });
    expect(shape("--font-ja-condensed")).toEqual({ family: "Zen Kaku Gothic New", faces: ["400/normal/-", "900/normal/-"], preloaded: [] });
    expect(shape("--font-ja-light")).toEqual({ family: "M PLUS 1", faces: ["100 900/normal/-"], preloaded: [] });
  });

  it("one face per unicode-range subset (counts as Google served them); the manifest's ranges cover sample kana and kanji (ranges only, not glyph presence)", () => {
    const counts = Object.fromEntries(manifest.families.map((f) => [f.family, f.faces.length]));
    expect(counts).toEqual({ "Playfair Display": 8, Archivo: 3, "Zen Old Mincho": 244, "Zen Kaku Gothic New": 242, "M PLUS 1": 119 });
    for (const f of manifest.families) for (const x of f.faces) expect(x.file.endsWith(".woff2") && x.unicodeRange.startsWith("U+"), x.file).toBe(true);
    // hiragana, katakana and a common kanji are each in some subset of every Japanese face, at every weight
    const has = (range: string, cp: number) => range.split(",").some((r) => {
      const [a, b] = r.trim().replace("U+", "").split("-").map((h) => parseInt(h, 16));
      return cp >= a! && cp <= (b ?? a)!;
    });
    for (const v of ["--font-ja-editorial", "--font-ja-condensed", "--font-ja-light"]) {
      const f = byVar.get(v)!;
      for (const w of new Set(f.faces.map((x) => x.weight))) {
        for (const cp of [0x3042, 0x30a2, 0x5e97]) expect(f.faces.some((x) => x.weight === w && has(x.unicodeRange, cp)), `${f.family} ${w} U+${cp.toString(16)}`).toBe(true);
      }
    }
  });

  it("keeps the OFL license and copyright notice of every family", () => {
    for (const f of manifest.families) {
      const license = readFileSync(join(MANIFEST_PATH, "..", f.dir, "LICENSE"), "utf8");
      expect(license, f.family).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(license.startsWith(f.license.copyright.slice(0, 40)), f.family).toBe(true);
      expect(f.license.copyright, f.family).toMatch(/^Copyright 20\d\d The .+ Authors/);
    }
  });

  it("names the same CSS variables, with the fallback faces copied from next/font/google", () => {
    const generated = readFileSync(MODULE_PATH, "utf8");
    const fallback = readFileSync(join(MANIFEST_PATH, "..", "..", "fonts-fallback.css"), "utf8");
    for (const f of manifest.families) {
      expect(generated).toContain(`export const ${f.exportName} = localFont(`);
      expect(generated).toContain(`variable: "${f.variable}", fallback: ["\\"${f.family} Fallback\\""]`);
      expect(fallback).toContain(`font-family:"${f.family} Fallback"`);
    }
    const fontsTs = readFileSync(join(MANIFEST_PATH, "..", "..", "fonts.ts"), "utf8");
    expect(generated + fontsTs).not.toMatch(/from "next\/font\/google"/);
  });
});
