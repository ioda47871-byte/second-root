// Shared code for the self-hosted Google Fonts (DEV-303): the demo display faces
// (generate-demo-fonts.mjs) and the official site's faces (generate-site-fonts.mjs).
//
// A target's font files are the exact bytes next/font/google downloaded: the
// same Google Fonts CSS2 request (URL and User-Agent as in next/font) and the
// woff2 unicode-range subsets it lists, unmodified. Each file's sha256 is in the
// target's manifest.json. `--check` compares the committed files with the
// manifest; a regeneration (`--packs`) rewrites the manifest from what Google
// serves, so if Google serves other bytes, --check still passes and it is the
// digest pinned in the unit tests (fontsDigest) that fails. The license text and copyright notice of each family
// (SIL Open Font License 1.1) come from a pinned @fontsource tarball, checked
// against its sha256 and npm integrity. The generated module has one
// next/font/local call per unicode-range subset, in Google's order and with
// Google's descriptors, so a page downloads only the subsets of the characters
// it shows.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The User-Agent next/font/google sends (next/dist/compiled/@next/font/dist/google/fetch-resource.js): it selects woff2. */
export const NEXT_FONT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36";

/** NOTICE: the copyright notice embedded in the font files, where the package LICENSE names someone else. */
export function noticeText(fam) {
  return `${fam.family}\n\nCopyright notice embedded in these font files (the LICENSE file beside this one is\nthe SIL Open Font License 1.1 text from ${fam.license.package}@${fam.license.version}):\n\n${fam.notice}\n`;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const integrityOf = (buf) => `sha512-${createHash("sha512").update(buf).digest("base64")}`;

/**
 * The @font-face rules of a Google Fonts CSS2 response, in order. `subset` is the
 * comment directly above a rule (Google labels only the Latin, Cyrillic, … subsets;
 * the numbered Japanese subsets have none), or null.
 */
export function parseGoogleCss(css) {
  const faces = [];
  for (const m of css.matchAll(/(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)) {
    const get = (prop) => m[2].match(new RegExp(`${prop}:\\s*([^;]+);`))?.[1]?.trim();
    const url = m[2].match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/)?.[1];
    const face = { subset: m[1] ?? null, url, family: get("font-family")?.replace(/^'|'$/g, ""), weight: get("font-weight"), style: get("font-style"), stretch: get("font-stretch") ?? null, unicodeRange: get("unicode-range") };
    if (!face.url || !face.weight || !face.style || !face.unicodeRange) throw new Error(`unexpected @font-face: ${m[2].slice(0, 160)}`);
    faces.push(face);
  }
  return faces;
}

/**
 * One self-hosted font set.
 * cfg: { fontsDir, manifestPath, modulePath, fontsPathFromModule ("fonts" or ""), header: string[],
 *        rootFiles: the only files allowed directly in fontsDir (the rest are family directories),
 *        manifestTop: object, families: [{ dir, family, exportName, variable, google, license, ... }],
 *        preload(fam, face): boolean, manifestFamily(fam): object (the fields kept in the manifest) }
 */
export function fontTarget(cfg) {
  const prefix = cfg.fontsPathFromModule ? `./${cfg.fontsPathFromModule}/` : "./";
  const licenseRef = (dir) => (cfg.fontsPathFromModule ? `${cfg.fontsPathFromModule}/${dir}/LICENSE` : `${dir}/LICENSE`);

  function renderModule(manifest) {
    const lines = [...cfg.header, "/* eslint-disable @typescript-eslint/no-unused-vars */", 'import localFont from "next/font/local";', ""];
    for (const fam of manifest.families) {
      lines.push(`// ${fam.family}: SIL Open Font License 1.1 (${licenseRef(fam.dir)})`);
      fam.faces.forEach((face, i) => {
        const name = i === 0 ? `export const ${fam.exportName}` : `const ${fam.exportName}${i}`;
        const declarations = [
          { prop: "font-family", value: `'${fam.family}'` },
          ...(face.stretch ? [{ prop: "font-stretch", value: face.stretch }] : []),
          { prop: "unicode-range", value: face.unicodeRange },
        ];
        const opts = [
          `src: [{ path: ${JSON.stringify(`${prefix}${fam.dir}/${face.file}`)}, weight: ${JSON.stringify(face.weight)}, style: ${JSON.stringify(face.style)} }]`,
          `display: "swap"`,
          `preload: ${face.preload}`,
          `adjustFontFallback: false`,
          ...(i === 0 ? [`variable: ${JSON.stringify(fam.variable)}`, `fallback: [${JSON.stringify(`"${fam.family} Fallback"`)}]`] : []),
          `declarations: [${declarations.map((d) => `{ prop: ${JSON.stringify(d.prop)}, value: ${JSON.stringify(d.value)} }`).join(", ")}]`,
        ];
        lines.push(`${name} = localFont({ ${opts.join(", ")} });`);
      });
      lines.push("");
    }
    return lines.join("\n");
  }

  function formatManifest(manifest) {
    const faces = [];
    const placeholders = { ...manifest, families: manifest.families.map((f) => ({ ...f, faces: f.faces.map((x) => `@@face${faces.push(x) - 1}@@`) })) };
    return `${JSON.stringify(placeholders, null, 2).replace(/"@@face(\d+)@@"/g, (_, i) => JSON.stringify(faces[Number(i)]))}\n`;
  }

  function checkCommitted() {
    const problems = [];
    const manifest = JSON.parse(readFileSync(cfg.manifestPath, "utf8"));
    if (readFileSync(cfg.modulePath, "utf8") !== renderModule(manifest)) problems.push(`${relative(REPO, cfg.modulePath)} is not what the manifest renders to`);
    if (readFileSync(cfg.manifestPath, "utf8") !== formatManifest(manifest)) problems.push("manifest.json is not in its generated format");
    const listed = new Set();
    for (const fam of manifest.families) {
      listed.add(`${fam.dir}/LICENSE`);
      const license = join(cfg.fontsDir, fam.dir, "LICENSE");
      if (!existsSync(license) || sha256(readFileSync(license)) !== fam.license.sha256) problems.push(`${fam.dir}/LICENSE does not match the manifest`);
      if (fam.notice) {
        listed.add(`${fam.dir}/NOTICE`);
        const notice = join(cfg.fontsDir, fam.dir, "NOTICE");
        if (!existsSync(notice) || readFileSync(notice, "utf8") !== noticeText(fam)) problems.push(`${fam.dir}/NOTICE does not match the manifest`);
      }
      for (const face of fam.faces) {
        const rel = `${fam.dir}/${face.file}`;
        if (listed.has(rel)) continue;
        listed.add(rel);
        const path = join(cfg.fontsDir, rel);
        if (!existsSync(path)) { problems.push(`missing ${rel}`); continue; }
        const buf = readFileSync(path);
        if (buf.length !== face.bytes || sha256(buf) !== face.sha256) problems.push(`${rel} does not match the manifest`);
      }
    }
    const rootFiles = new Set(cfg.rootFiles);
    for (const d of readdirSync(cfg.fontsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) {
        if (!rootFiles.has(d.name)) problems.push(`unlisted file ${d.name}`);
        continue;
      }
      for (const f of readdirSync(join(cfg.fontsDir, d.name))) if (!listed.has(`${d.name}/${f}`)) problems.push(`unlisted file ${d.name}/${f}`);
    }
    return problems;
  }

  async function fetchBuffer(url) {
    const res = await fetch(url, { headers: { "User-Agent": NEXT_FONT_USER_AGENT } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  function readLicense(packsDir, lic, work) {
    const tgz = readFileSync(join(packsDir, lic.tgz));
    if (sha256(tgz) !== lic.tgzSha256) throw new Error(`${lic.tgz}: sha256 mismatch`);
    if (integrityOf(tgz) !== lic.integrity) throw new Error(`${lic.tgz}: integrity mismatch`);
    const dir = mkdtempSync(join(work, "pkg-"));
    execFileSync("tar", ["-xzf", join(packsDir, lic.tgz), "-C", dir, "package/LICENSE", "package/metadata.json"]);
    const meta = JSON.parse(readFileSync(join(dir, "package", "metadata.json"), "utf8"));
    if (meta.license?.type !== "OFL-1.1") throw new Error(`${lic.package}: not OFL-1.1`);
    const text = readFileSync(join(dir, "package", "LICENSE"), "utf8");
    if (!text.includes("SIL OPEN FONT LICENSE Version 1.1")) throw new Error(`${lic.package}: LICENSE has no OFL 1.1 text`);
    return { path: join(dir, "package", "LICENSE"), copyright: meta.license.attribution, sha256: sha256(readFileSync(join(dir, "package", "LICENSE"))) };
  }

  async function generate(packsDir) {
    const work = mkdtempSync(join(tmpdir(), "sr-local-fonts-"));
    const manifest = { ...cfg.manifestTop, families: [] };
    try {
      for (const fam of cfg.families) {
        const license = readLicense(packsDir, fam.license, work);
        const parsed = parseGoogleCss((await fetchBuffer(fam.google)).toString("utf8"));
        const out = join(cfg.fontsDir, fam.dir);
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out, { recursive: true });
        copyFileSync(license.path, join(out, "LICENSE"));
        if (fam.notice) writeFileSync(join(out, "NOTICE"), noticeText(fam));
        const byUrl = new Map(); // a variable font Google lists under several weights is one file
        const faces = [];
        for (const [i, f] of parsed.entries()) {
          if (f.family !== fam.family) throw new Error(`${fam.google}: unexpected family ${f.family}`);
          if (!byUrl.has(f.url)) {
            const buf = await fetchBuffer(f.url);
            const file = `${fam.dir}-${String(i).padStart(3, "0")}-${f.weight.replace(" ", "-")}-${f.style}.woff2`;
            writeFileSync(join(out, file), buf);
            byUrl.set(f.url, { file, bytes: buf.length, sha256: sha256(buf) });
          }
          const { file, bytes, sha256: hash } = byUrl.get(f.url);
          const face = { file, weight: f.weight, style: f.style, stretch: f.stretch, unicodeRange: f.unicodeRange, subset: f.subset };
          faces.push({ ...face, preload: cfg.preload(fam, face), bytes, sha256: hash, source: f.url });
        }
        manifest.families.push({ ...cfg.manifestFamily(fam), license: { ...fam.license, sha256: license.sha256, copyright: license.copyright }, faces });
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    writeFileSync(cfg.manifestPath, formatManifest(manifest));
    writeFileSync(cfg.modulePath, renderModule(manifest));
    const files = new Map(manifest.families.flatMap((f) => f.faces.map((x) => [`${f.dir}/${x.file}`, x.bytes])));
    const bytes = [...files.values()].reduce((s, b) => s + b, 0);
    console.log(`${manifest.families.reduce((s, f) => s + f.faces.length, 0)} faces, ${files.size} woff2 files, ${(bytes / 1048576).toFixed(2)} MiB -> ${relative(REPO, cfg.fontsDir)}`);
  }

  return { renderModule, formatManifest, checkCommitted, generate };
}

/**
 * One sha256 over a manifest's font files: the sorted unique "<dir>/<file> <sha256>" lines.
 * The unit tests pin it, so a regeneration that gets other bytes from Google (which rewrites
 * the manifest, and so still passes --check) fails until the pin is deliberately updated.
 */
export function fontsDigest(manifest) {
  const lines = new Set(manifest.families.flatMap((f) => f.faces.map((x) => `${f.dir}/${x.file} ${x.sha256}`)));
  return sha256(Buffer.from([...lines].sort().join("\n")));
}

/** The command line shared by the generators: --packs <dir> (network) or --check (offline). */
export async function runCli(target, name, argv = process.argv) {
  const i = argv.indexOf("--packs");
  if (i > 0 && argv[i + 1]) return target.generate(argv[i + 1]);
  if (argv.includes("--check")) {
    const problems = target.checkCommitted();
    for (const p of problems) console.error(p);
    if (problems.length) process.exit(1);
    console.log(`${name}: generated module and files match the manifest`);
    return;
  }
  console.error(`usage: ${name} --packs <dir> | --check`);
  process.exit(2);
}
