// Copies a Concept Work's static export (`out/`) into public/works/<slug>/.
// The Concept Work is built in its own repository with basePath
// /works/<slug> (docs/WORKS.md); this only checks and copies.
//
//   node scripts/import-work.mjs --slug <slug> --source <path-to-out>
//   node scripts/import-work.mjs <slug> <path-to-out>        (same, positional)
//
// Nothing under public/works is touched until the export has passed every
// check: the files are copied to a temporary directory, checked again there,
// and only then swapped in for the previous copy (which is restored if the
// swap fails). The destination is found from this script's location, so the
// working directory does not matter.
import {
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SITE_ORIGIN = "https://secondroot.jp";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const USAGE = "usage: node scripts/import-work.mjs --slug <slug> --source <path-to-out>";

/** Parses the command line; throws on anything ambiguous. */
export function parseArgs(argv) {
  const named = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--slug" || arg === "--source") {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      if (named[arg.slice(2)] !== undefined) throw new Error(`${arg} given twice`);
      named[arg.slice(2)] = value;
      i++;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0 && Object.keys(named).length > 0) throw new Error("mix of options and positional arguments");
  if (positional.length > 2) throw new Error("too many arguments");
  const slug = named.slug ?? positional[0];
  const source = named.source ?? positional[1];
  if (slug === undefined || source === undefined) throw new Error("both a slug and a source are required");
  if (slug.length > 64 || !SLUG.test(slug)) throw new Error(`invalid slug ${JSON.stringify(slug)} (lowercase letters, digits and single hyphens)`);
  return { slug, source };
}

/**
 * Lists every file under `dir` without following symlinks. Symlinks,
 * dotfiles (and dot directories), .env files, source maps and anything that
 * is not a regular file or directory are reported as problems.
 */
export function listFiles(dir) {
  const files = [];
  const problems = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const rel = relative(dir, path);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) problems.push(`${rel}: symlink`);
      else if (name.startsWith(".")) problems.push(`${rel}: dotfile`);
      else if (/\.map$/i.test(name)) problems.push(`${rel}: source map`);
      else if (st.isDirectory()) walk(path);
      else if (st.isFile()) files.push({ rel, size: st.size });
      else problems.push(`${rel}: not a regular file`);
    }
  };
  walk(dir);
  return { files: files.sort((a, b) => (a.rel < b.rel ? -1 : 1)), problems };
}

// Files that can hold URLs. Everything else (images, fonts, …) is binary.
const MARKUP = new Set([".html", ".htm", ".svg", ".xml"]);
const STYLE = new Set([".css"]);
const DATA = new Set([".txt", ".json", ".webmanifest"]);
const SCRIPT = new Set([".js", ".mjs", ".cjs"]);

// A root-relative path that names a file to fetch (as opposed to a route).
const ASSET = /\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|json|m4a|mp3|mp4|otf|pdf|png|svg|ttf|txt|wav|webm|webmanifest|webp|woff2?|xml)$/i;
// In scripts only files the browser fetches as-is count: the framework's own
// literals ("/index.txt", "/_next/", route names) are joined with the
// basePath at runtime.
const SCRIPT_ASSET = /\.(?:avif|bmp|css|eot|gif|ico|jpe?g|m4a|mp3|mp4|otf|pdf|png|svg|ttf|wav|webm|webp|woff2?)$/i;
// JSON keys whose root-relative values are fetched or navigated to as-is.
const RESOURCE_KEYS = new Set(["src", "srcset", "href", "poster", "action", "formaction", "content", "url", "image", "icon", "data", "background"]);

const rootRelative = (value) => value.startsWith("/") && !value.startsWith("//");
const pathOf = (value) => value.split(/[?#]/)[0];

/** Checks the export in `dir` (built with basePath /works/<slug>); returns problems. */
export function scanExport(dir, slug, files = listFiles(dir).files) {
  const basePath = `/works/${slug}`;
  const origin = `${SITE_ORIGIN}${basePath}`;
  const problems = [];
  const has = (rel) => files.some((f) => f.rel === rel);
  if (!has("index.html")) problems.push("index.html is missing");
  if (!files.some((f) => f.rel.startsWith(`_next${sep}`))) problems.push("_next/ is missing");

  // Routes of this export: the router adds the basePath to these itself, so
  // they may appear without it in RSC payloads and scripts (never in markup).
  const routes = new Set(["/"]);
  for (const f of files) {
    if (f.rel.endsWith(".html") && f.rel !== "index.html") routes.add(`/${f.rel.slice(0, -5).split(sep).join("/")}`);
  }

  const underBase = (value) => value === basePath || /^[/?#]/.test(value.slice(basePath.length)) && value.startsWith(basePath);
  const isRoute = (value) => routes.has(pathOf(value) || "/");

  for (const f of files) {
    const ext = extname(f.rel).toLowerCase();
    if (!MARKUP.has(ext) && !STYLE.has(ext) && !DATA.has(ext) && !SCRIPT.has(ext)) continue;
    const text = readFileSync(join(dir, f.rel), "utf8");
    const report = (kind, value) => problems.push(`${f.rel}: ${kind} ${value}`);

    // Markup and CSS: every root-relative URL must carry the basePath.
    const strict = (kind, value) => {
      if (rootRelative(value) && !underBase(value)) report(kind, value);
    };
    const checkSrcset = (kind, value) => {
      for (const candidate of value.split(",")) strict(kind, candidate.trim().split(/\s+/)[0] ?? "");
    };
    const checkCss = (css) => {
      for (const m of css.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)) strict("css url()", m[2].trim());
      for (const m of css.matchAll(/@import\s+(["'])([^"']*)\1/gi)) strict("css @import", m[2]);
    };
    // RSC payloads, JSON and scripts: root-relative values must carry the
    // basePath or name a route of this export; asset files and values of
    // resource keys (src, href, …) outside the basePath are rejected.
    const checkValue = (kind, key, value) => {
      if (key === "srcset" || key === "imagesrcset") return checkSrcset(kind, value);
      if (!rootRelative(value) || underBase(value) || isRoute(value)) return;
      if (ASSET.test(pathOf(value)) || RESOURCE_KEYS.has(key)) report(kind, value);
    };
    // Position-independent, so free text in a payload (RSC "T" rows) cannot
    // shift the scan: every "key":"value" pair, then every quoted
    // root-relative string on its own.
    const checkJson = (kind, json) => {
      for (const m of json.matchAll(/"([A-Za-z_$][\w$-]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        checkValue(kind, m[1].toLowerCase(), unescape(m[2]));
      }
      for (const m of json.matchAll(/"(\/(?!\/)(?:[^"\\\s]|\\.)*)"/g)) checkValue(kind, "", unescape(m[1]));
    };
    // Inline scripts hold the RSC payload inside JS string literals.
    const checkInlineScript = (body) => {
      for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        let decoded;
        try {
          decoded = JSON.parse(`"${m[1]}"`);
        } catch {
          continue;
        }
        checkValue("inline script", "", decoded);
        checkJson("inline script", decoded);
      }
    };

    if (MARKUP.has(ext)) {
      let markup = text;
      // Inline scripts carry the RSC payload as escaped JSON; styles are CSS.
      markup = markup.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (whole, body) => {
        checkInlineScript(body);
        return whole.slice(0, whole.indexOf(">") + 1);
      });
      markup = markup.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (whole, body) => {
        checkCss(body);
        return "";
      });
      for (const m of markup.matchAll(/<[a-z][^\s/>]*((?:\s+[^\s"'=<>`/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/gi)) {
        for (const a of m[1].matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
          const name = a[1].toLowerCase();
          const value = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
          if (name === "srcset" || name === "imagesrcset") checkSrcset(`${name}=`, value);
          else if (name === "style") checkCss(value);
          else strict(`${name}=`, value);
        }
      }
      // Canonical and og:url, when absolute, must name this Concept Work.
      const absolute = [
        ...[...text.matchAll(/<link\b[^>]*\brel=["']?canonical["']?[^>]*>/gi)].map((t) => ["canonical", t[0].match(/\bhref=["']?([^"'\s>]+)/i)?.[1]]),
        ...[...text.matchAll(/<meta\b[^>]*\bproperty=["']?(og:url|og:image|twitter:image)["']?[^>]*>/gi)].map((t) => [t[1], t[0].match(/\bcontent=["']?([^"'\s>]+)/i)?.[1]]),
        ...[...text.matchAll(/<meta\b[^>]*\bname=["']?(twitter:image)["']?[^>]*>/gi)].map((t) => [t[1], t[0].match(/\bcontent=["']?([^"'\s>]+)/i)?.[1]]),
      ];
      for (const [kind, value] of absolute) {
        if (!value || !/^https?:/i.test(value)) continue;
        const v = decodeEntities(value);
        if (!(v === origin || /^[/?#]/.test(v.slice(origin.length)) && v.startsWith(origin))) report(kind, v);
      }
    } else if (STYLE.has(ext)) {
      checkCss(text);
    } else if (DATA.has(ext)) {
      checkJson("payload", text);
    } else {
      for (const m of text.matchAll(/(["'`])(\/(?!\/)[^"'`\s\\]*)\1/g)) {
        if (!underBase(m[2]) && SCRIPT_ASSET.test(pathOf(m[2]))) report("script literal", m[2]);
      }
    }
  }
  return [...new Set(problems)];
}

function unescape(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["\\/])/g, "$1");
}

function decodeEntities(s) {
  return s.replace(/&(?:amp|#38|#x26);/gi, "&").replace(/&(?:quot|#34|#x22);/gi, '"').replace(/&(?:#39|#x27|apos);/gi, "'");
}

const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

/**
 * Imports `source` as public/works/<slug> under `repoRoot`. Throws, leaving
 * public/works untouched, if any check fails.
 */
export function importWork({ slug, source, repoRoot = REPO_ROOT, log = () => {} }) {
  if (!SLUG.test(slug)) throw new Error(`invalid slug ${JSON.stringify(slug)}`);
  const worksRoot = join(realpathSync(repoRoot), "public", "works");
  mkdirSync(worksRoot, { recursive: true });
  const dest = join(worksRoot, slug);

  if (!existsSync(source)) throw new Error(`${source} does not exist`);
  if (lstatSync(source).isSymbolicLink()) throw new Error(`${source} is a symlink`);
  const src = realpathSync(source);
  if (!lstatSync(src).isDirectory()) throw new Error(`${source} is not a directory`);
  if (inside(src, worksRoot) || inside(worksRoot, src)) {
    throw new Error(`the source must be outside public/works (and not contain it): ${src}`);
  }
  if (inside(src, dest) || inside(dest, src)) throw new Error("the source and the destination overlap");

  const listed = listFiles(src);
  const problems = [...listed.problems, ...scanExport(src, slug, listed.files)];
  if (problems.length > 0) throw new ExportError(problems, slug);

  // Copy to a temporary directory next to public/ (same filesystem, not served).
  const tmp = mkdtempSync(join(realpathSync(repoRoot), ".works-import-"));
  const staged = join(tmp, slug);
  const backup = join(tmp, `${slug}.previous`);
  try {
    for (const f of listed.files) {
      mkdirSync(dirname(join(staged, f.rel)), { recursive: true });
      copyFileSync(join(src, f.rel), join(staged, f.rel), constants.COPYFILE_EXCL);
    }
    // Check the copy itself: same files, same sizes, still clean.
    const copied = listFiles(staged);
    const same =
      copied.files.length === listed.files.length &&
      copied.files.every((f, i) => f.rel === listed.files[i].rel && f.size === listed.files[i].size);
    const recheck = [...copied.problems, ...scanExport(staged, slug, copied.files)];
    if (!same) recheck.push("the copied files differ from the source (changed during import?)");
    if (recheck.length > 0) throw new ExportError(recheck, slug);

    const hadPrevious = existsSync(dest);
    if (hadPrevious) renameSync(dest, backup);
    try {
      renameSync(staged, dest);
    } catch (error) {
      if (hadPrevious) renameSync(backup, dest);
      throw error;
    }
    log(`Imported ${listed.files.length} files into ${relative(realpathSync(repoRoot), dest)}.`);
    return { files: listed.files.length, dest, pages: [...new Set(listed.files.filter((f) => f.rel.endsWith(".html") && !f.rel.includes(sep)).map((f) => f.rel.slice(0, -5)))].filter((p) => !["index", "404", "_not-found"].includes(p)) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export class ExportError extends Error {
  constructor(problems, slug) {
    super(`the export was rejected (built with basePath "/works/${slug}"?):\n  ${problems.slice(0, 30).join("\n  ")}`);
    this.problems = problems;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { slug, source } = parseArgs(process.argv.slice(2));
    const result = importWork({ slug, source: resolve(source), log: (m) => console.log(m) });
    console.log(`Pages: / ${result.pages.map((p) => `/${p}`).join(" ")}`);
    console.log(`Make sure next.config.ts (staticWorks) lists: ${JSON.stringify(result.pages.sort())}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (!(error instanceof ExportError)) console.error(USAGE);
    process.exit(1);
  }
}
