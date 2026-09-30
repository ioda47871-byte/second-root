// Copies a Concept Work's static export (`out/`) into public/works/<slug>/.
// The Concept Work is built in its own repository with
// basePath /works/<slug> (docs/WORKS.md); this only checks and copies.
//
//   node scripts/import-work.mjs --slug <slug> --source <path-to-out>
//   node scripts/import-work.mjs <slug> <path-to-out>        (same, positional)
//
// The previous copy is replaced as a whole, so files the new build no longer
// produces do not linger.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.some((a) => a.startsWith("--")) ? [] : args;
const slug = flag("--slug") ?? positional[0];
const outArg = flag("--source") ?? positional[1];
if (!slug || !outArg || !/^[a-z0-9-]+$/.test(slug)) {
  console.error("usage: node scripts/import-work.mjs --slug <slug> --source <path-to-out>");
  process.exit(1);
}

const out = resolve(outArg);
const dest = resolve("public/works", slug);
const basePath = `/works/${slug}`;

if (!existsSync(join(out, "index.html")) || !existsSync(join(out, "_next"))) {
  console.error(`${out} does not look like a static export (index.html and _next/ are required).`);
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(out);

// Every root-relative URL in the pages must stay under the basePath; one that
// does not would resolve against Second Root itself (its /_next, /images, …).
const problems = [];
for (const file of files.filter((f) => /\.(html|txt)$/.test(f))) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/(?:src|href|srcset|content)=\\?"(\/[^"\\]*)/gi)) {
    // Allowed: the basePath itself, or followed by "/", "#" (a link to "/#") or "?".
    const rest = match[1].startsWith(basePath) ? match[1].slice(basePath.length) : null;
    if (rest === null || (rest !== "" && !/^[/#?]/.test(rest))) {
      problems.push(`${relative(out, file)}: ${match[1]}`);
    }
  }
  // Absolute canonical / og:url, when a page has them, must name its /works URL.
  for (const match of text.matchAll(/(?:rel="canonical" href|property="og:url" content)="([^"]+)"/g)) {
    if (/^https?:/.test(match[1]) && !match[1].startsWith(`https://secondroot.jp${basePath}`)) {
      problems.push(`${relative(out, file)}: ${match[1]}`);
    }
  }
}
if (problems.length > 0) {
  console.error(`URLs outside ${basePath} (was it built with basePath "${basePath}"?):`);
  for (const p of [...new Set(problems)].slice(0, 20)) console.error(`  ${p}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(out, dest, { recursive: true });

const pages = readdirSync(out)
  .filter((f) => f.endsWith(".html") && !["404.html", "_not-found.html", "index.html"].includes(f))
  .map((f) => f.slice(0, -".html".length));
console.log(`Imported ${files.length} files into ${relative(process.cwd(), dest)}.`);
console.log(`Pages: / ${pages.map((p) => `/${p}`).join(" ")}`);
console.log(`Make sure next.config.ts (staticWorks) lists: ${JSON.stringify(pages)}`);
