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

  // Under the basePath, with no "." / ".." segment that could climb out of it.
  const underBase = (value) =>
    (value === basePath || (/^[/?#]/.test(value.slice(basePath.length)) && value.startsWith(basePath))) &&
    !pathOf(value).split("/").some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg));
  const isRoute = (value) => routes.has(pathOf(value) || "/");

  for (const f of files) {
    const ext = extname(f.rel).toLowerCase();
    if (!MARKUP.has(ext) && !STYLE.has(ext) && !DATA.has(ext) && !SCRIPT.has(ext)) continue;
    const text = readFileSync(join(dir, f.rel), "utf8");
    const report = (kind, value) => problems.push(`${f.rel}: ${kind} ${value}`);

    // Markup and CSS: every root-relative URL must carry the basePath.
    // Browsers ignore surrounding whitespace in URL values.
    const strict = (kind, raw) => {
      const value = raw.trim();
      if (rootRelative(value) && !underBase(value)) report(kind, value);
      // A protocol-relative URL to Second Root itself is a root-relative one in disguise.
      if (value.startsWith("//") && sameSite(value) && !underBase(new URL(`https:${value}`).pathname)) report(kind, value);
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
    const checkValue = (kind, key, raw) => {
      const value = raw.trim();
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
      // Tag bodies as a browser splits them: attributes need no whitespace
      // between them (`alt="x"src=…`, `<img/src=…>`), and unquoted values may
      // contain "=".
      for (const m of markup.matchAll(/<[a-zA-Z][^\s/>]*((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
        for (const a of m[1].matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g)) {
          const name = a[1].toLowerCase();
          const value = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
          if (name === "srcset" || name === "imagesrcset") checkSrcset(`${name}=`, value);
          else if (name === "style") checkCss(value);
          else strict(`${name}=`, value);
          // <meta http-equiv="refresh" content="0;url=/…">
          const refresh = name === "content" && value.match(/^\s*\d*(?:\.\d*)?\s*[;,]\s*url\s*=\s*['"]?([^'"]+)/i);
          if (refresh) strict("refresh url", refresh[1]);
        }
      }
      // Canonical and og:url, when absolute, must name this Concept Work.
      const absolute = [
        ...[...text.matchAll(/<link\b[^>]*[\s"']rel=["']?canonical["']?[^>]*>/gi)].map((t) => ["canonical", attr(t[0], "href")]),
        ...[...text.matchAll(/<meta\b[^>]*[\s"']property=["']?(og:url|og:image|twitter:image)["']?[^>]*>/gi)].map((t) => [t[1], attr(t[0], "content")]),
        ...[...text.matchAll(/<meta\b[^>]*[\s"']name=["']?(twitter:image)["']?[^>]*>/gi)].map((t) => [t[1], attr(t[0], "content")]),
      ];
      for (const [kind, value] of absolute) {
        if (!value) continue;
        let v = decodeEntities(value).trim();
        if (v.startsWith("//")) v = `https:${v}`;
        if (!/^https?:/i.test(v)) continue;
        const ok = (v === origin || (/^[/?#]/.test(v.slice(origin.length)) && v.startsWith(origin))) && underBase(new URL(v).pathname);
        if (!ok) report(kind, v);
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

// The value of attribute `name` in a tag (not `data-name`).
function attr(tag, name) {
  const m = tag.match(new RegExp(`[\\s"'/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function sameSite(protocolRelative) {
  try {
    return new URL(`https:${protocolRelative}`).hostname.toLowerCase() === new URL(SITE_ORIGIN).hostname;
  } catch {
    return false;
  }
}

function unescape(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["\\/])/g, "$1");
}

// Decodes character references once, as a browser does for attribute values.
const NAMED = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", sol: "/", period: ".", colon: ":", num: "#", quest: "?" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref) => {
    if (ref[0] !== "#") return NAMED[ref.toLowerCase()] ?? whole;
    const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

/**
 * Imports `source` as public/works/<slug> under `repoRoot`. Throws, leaving
 * public/works untouched, if any check fails.
 */
export function importWork({ slug, source, repoRoot = REPO_ROOT, log = () => {}, rename = renameSync }) {
  if (!SLUG.test(slug)) throw new Error(`invalid slug ${JSON.stringify(slug)}`);
  const root = realpathSync(repoRoot);
  // public/, public/works/ and the destination must be real directories, so the
  // containment checks below compare real paths.
  for (const p of [join(root, "public"), join(root, "public", "works")]) {
    if (isSymlink(p)) throw new Error(`${p} is a symlink`);
  }
  mkdirSync(join(root, "public", "works"), { recursive: true });
  const worksRoot = realpathSync(join(root, "public", "works"));
  const dest = join(worksRoot, slug);
  if (isSymlink(dest)) throw new Error(`${dest} is a symlink`);

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
  const tmp = mkdtempSync(join(root, ".works-import-"));
  const staged = join(tmp, slug);
  const backup = join(tmp, `${slug}.previous`);
  let keepTmp = false;
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
    if (hadPrevious) rename(dest, backup);
    try {
      rename(staged, dest);
    } catch (error) {
      if (hadPrevious) {
        try {
          rename(backup, dest);
        } catch (restoreError) {
          // Never delete the only remaining copy.
          keepTmp = true;
          throw new Error(
            `could not move the new copy into place (${error.message}) nor restore the previous one (${restoreError.message}); the previous copy is kept at ${backup}`,
          );
        }
      }
      throw error;
    }
    log(`Imported ${listed.files.length} files into ${relative(root, dest)}.`);
    return { files: listed.files.length, dest, pages: [...new Set(listed.files.filter((f) => f.rel.endsWith(".html") && !f.rel.includes(sep)).map((f) => f.rel.slice(0, -5)))].filter((p) => !["index", "404", "_not-found"].includes(p)) };
  } finally {
    if (!keepTmp) rmSync(tmp, { recursive: true, force: true });
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
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
