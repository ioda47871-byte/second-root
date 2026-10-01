import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listFiles, parseArgs, scanExport } from "../../scripts/import-work.mjs";

// scripts/import-work.mjs copies a Concept Work's static export into
// public/works/<slug>/. These tests run a copy of the script inside a
// throwaway repository layout, so the real public/works is never touched.

const SCRIPT = resolve(__dirname, "../../scripts/import-work.mjs");
const REAL_WORKS = resolve(__dirname, "../../public/works");

let root: string;
let repo: string;
let works: string;

function write(base: string, rel: string, content: string) {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), content);
}

/** A minimal, valid export built with basePath /works/<slug>. */
function makeExport(slug = "demo", name = "out") {
  const dir = join(root, name);
  const b = `/works/${slug}`;
  write(dir, "index.html", `<!DOCTYPE html><html><head><link rel="stylesheet" href="${b}/_next/static/a.css"/><link rel="canonical" href="https://secondroot.jp${b}"/><meta property="og:url" content="https://secondroot.jp${b}/"/><script src="${b}/_next/static/app.js" async=""></script></head><body><a href="${b}/about">About</a><img src="${b}/images/a.jpg" srcset="${b}/images/a.jpg 1x, ${b}/images/a@2x.jpg 2x"/><script>self.__next_f.push([1,"3:[\\"$\\",\\"a\\",null,{\\"href\\":\\"/about\\"}]"])</script></body></html>`);
  write(dir, "about.html", `<!DOCTYPE html><html><head></head><body><a href="${b}">Home</a></body></html>`);
  write(dir, "index.txt", `0:{"href":"/about"}\n1:["$","img",null,{"src":"${b}/images/a.jpg"}]\n2:"/#top"\n`);
  write(dir, "_next/static/a.css", `body{background:url(${b}/images/bg.png)}`);
  write(dir, "_next/static/app.js", `const r="/about";const i="/_next/";const t="/index.txt";`);
  write(dir, "images/a.jpg", "jpg");
  return dir;
}

/** Runs the script copy in the throwaway repo; returns exit status and output. */
function run(args: string[], cwd = root) {
  try {
    const stdout = execFileSync(process.execPath, [join(repo, "scripts/import-work.mjs"), ...args], { cwd, encoding: "utf8", stdio: "pipe" });
    return { status: 0, out: stdout };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { status: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

const leftovers = () => readdirSync(repo).filter((n) => n.startsWith(".works-import-"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "import-work-"));
  repo = join(root, "repo");
  works = join(repo, "public/works");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(works, { recursive: true });
  cpSync(SCRIPT, join(repo, "scripts/import-work.mjs"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("import-work: a valid export", () => {
  it("is copied into public/works/<slug> and replaces the previous copy", () => {
    const out = makeExport();
    write(works, "demo/stale.html", "old");
    const r = run(["--slug", "demo", "--source", out]);
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(works, "demo/index.html"), "utf8")).toContain("/works/demo/about");
    expect(existsSync(join(works, "demo/stale.html"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("targets the repository of the script whatever the working directory", () => {
    const out = makeExport();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const r = run(["--slug", "demo", "--source", out], elsewhere);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(works, "demo/index.html"))).toBe(true);
    expect(existsSync(join(elsewhere, "public"))).toBe(false);
  });

  it("still accepts the positional form", () => {
    const r = run(["demo", makeExport()]);
    expect(r.status, r.out).toBe(0);
  });

  it("passes for the three Concept Works in public/works", () => {
    for (const slug of ["yasashii-beauty-salon", "midori-seitai", "hoshi-no-cha"]) {
      const dir = join(REAL_WORKS, slug);
      const listed = listFiles(dir);
      expect(listed.problems, slug).toEqual([]);
      expect(listed.files.length, slug).toBeGreaterThan(50);
      expect(scanExport(dir, slug, listed.files), slug).toEqual([]);
    }
  });

  it("catches a basePath leak planted in a real Concept Work", () => {
    const planted: Array<[string, string, string]> = [
      // the RSC payload of the page (.txt)
      ["index.txt", '"/works/hoshi-no-cha/images/', '"/images/'],
      // the same payload inlined in the HTML as escaped JS strings
      ["index.html", '\\"/works/hoshi-no-cha/images/footer-night.png\\"', '\\"/images/footer-night.png\\"'],
    ];
    for (const [rel, from, to] of planted) {
      const copy = join(root, `planted-${rel}`);
      cpSync(join(REAL_WORKS, "hoshi-no-cha"), copy, { recursive: true });
      const original = readFileSync(join(copy, rel), "utf8");
      expect(original, rel).toContain(from);
      writeFileSync(join(copy, rel), original.split(from).join(to));
      expect(scanExport(copy, "hoshi-no-cha").some((p) => p.startsWith(rel)), rel).toBe(true);
    }
  });

  it("imports a real Concept Work end to end", () => {
    const copy = join(root, "hoshi-out");
    cpSync(join(REAL_WORKS, "hoshi-no-cha"), copy, { recursive: true });
    const r = run(["--slug", "hoshi-no-cha", "--source", copy]);
    expect(r.status, r.out).toBe(0);
    expect(listFiles(join(works, "hoshi-no-cha")).files).toEqual(listFiles(copy).files);
  });
});

describe("import-work: URLs outside the basePath are rejected", () => {
  const cases: Array<[string, string, string]> = [
    ["a .txt payload with a root-relative src", "index.txt", `1:["$","img",null,{"src":"/images/c.jpg"}]\n`],
    ["a .txt payload with an unknown href", "about.txt", `1:{"href":"/admin"}\n`],
    ["an escaped RSC payload inside an inline script", "x.html", `<html><body><script>self.__next_f.push([1,"1:{\\"src\\":\\"/_next/static/leak.js\\"}"])</script></body></html>`],
    ["a single-quoted src", "x.html", `<img src='/images/a.jpg'>`],
    ["a single-quoted href", "x.html", `<a href='/about'>x</a>`],
    ["an unquoted src", "x.html", `<img src=/images/a.jpg>`],
    ["an unquoted href", "x.html", `<a href=/about>x</a>`],
    ["a second srcset candidate", "x.html", `<img srcset="/works/demo/a.jpg 1x, /images/b.jpg 2x">`],
    ["a poster", "x.html", `<video poster="/images/p.jpg"></video>`],
    ["a form action", "x.html", `<form action="/api/contact"></form>`],
    ["a favicon link", "x.html", `<link rel="icon" href="/favicon.ico">`],
    ["a CSS url() in a stylesheet", "_next/static/b.css", `.x{background:url(/images/bg.png)}`],
    ["a quoted CSS url()", "_next/static/b.css", `.x{background:url("/images/bg.png")}`],
    ["a CSS @import", "_next/static/b.css", `@import "/_next/static/other.css";`],
    ["an inline style url()", "x.html", `<div style="background:url(/images/bg.png)"></div>`],
    ["a <style> block url()", "x.html", `<style>.x{background:url('/images/bg.png')}</style>`],
    ["a root-relative image in a script", "_next/static/c.js", `const img="/images/x.png";`],
    ["a root-relative font in a script", "_next/static/c.js", "const f=`/fonts/a.woff2`;"],
    ["a root-relative image in JSON", "data.json", `{"image":"/og.png"}`],
    ["an unkeyed asset path in JSON", "data.json", `["/images/a.webp"]`],
    ["an SVG href", "icon.svg", `<svg xmlns="http://www.w3.org/2000/svg"><image href="/images/a.png"/></svg>`],
  ];

  for (const [label, rel, content] of cases) {
    it(`rejects ${label}`, () => {
      const out = makeExport();
      write(out, rel, content);
      const r = run(["--slug", "demo", "--source", out]);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain("rejected");
      expect(existsSync(join(works, "demo"))).toBe(false);
    });
  }

  it("rejects a canonical that only shares a prefix with the basePath", () => {
    const out = makeExport();
    write(out, "x.html", `<link rel="canonical" href="https://secondroot.jp/works/demoevil/">`);
    expect(run(["--slug", "demo", "--source", out]).status).toBe(1);
  });

  it("rejects an og:url on another site or another work", () => {
    for (const url of ["https://secondroot.jp/works/demo-other", "https://evil.example/works/demo", "https://secondroot.jp/"]) {
      const out = makeExport("demo", `out-${url.length}`);
      write(out, "x.html", `<meta property="og:url" content="${url}"/>`);
      expect(run(["--slug", "demo", "--source", out]).status, url).toBe(1);
    }
  });

  it("accepts a canonical at the basePath followed by /, ? or #", () => {
    for (const suffix of ["", "/", "/about", "?a=1", "#x"]) {
      const out = makeExport("demo", `ok-${suffix.length}-${suffix.charCodeAt(0) || 0}`);
      write(out, "x.html", `<link rel="canonical" href="https://secondroot.jp/works/demo${suffix}">`);
      const r = run(["--slug", "demo", "--source", out]);
      expect(r.status, `${suffix}: ${r.out}`).toBe(0);
    }
  });
});

describe("import-work: unsafe files are rejected before anything is copied", () => {
  it("rejects a symlink to a file inside the export", () => {
    const out = makeExport();
    symlinkSync(join(out, "about.html"), join(out, "alias.html"));
    const r = run(["--slug", "demo", "--source", out]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("alias.html: symlink");
  });

  it("rejects a symlink to a file outside the export and never copies its content", () => {
    const secret = join(root, "outside.env");
    writeFileSync(secret, "SECRET=1");
    const out = makeExport();
    symlinkSync(secret, join(out, "leak.txt"));
    mkdirSync(join(root, "outdir"));
    writeFileSync(join(root, "outdir/secret.txt"), "SECRET=2");
    symlinkSync(join(root, "outdir"), join(out, "linkdir"));
    const r = run(["--slug", "demo", "--source", out]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("leak.txt: symlink");
    expect(r.out).toContain("linkdir: symlink");
    expect(existsSync(join(works, "demo"))).toBe(false);
  });

  it("rejects a symlinked source directory", () => {
    const out = makeExport();
    symlinkSync(out, join(root, "out-link"));
    expect(run(["--slug", "demo", "--source", join(root, "out-link")]).status).toBe(1);
  });

  for (const [label, rel] of [
    [".env", ".env"],
    [".env.local", ".env.local"],
    ["a hidden file", "_next/.hidden"],
    ["a hidden directory", ".cache/x.txt"],
    ["a source map", "_next/static/app.js.map"],
  ]) {
    it(`rejects ${label}`, () => {
      const out = makeExport();
      write(out, rel, "x");
      const r = run(["--slug", "demo", "--source", out]);
      expect(r.status).toBe(1);
      expect(existsSync(join(works, "demo"))).toBe(false);
    });
  }

  it("rejects an export without index.html or _next/", () => {
    const out = makeExport();
    rmSync(join(out, "_next"), { recursive: true });
    expect(run(["--slug", "demo", "--source", out]).status).toBe(1);
  });
});

describe("import-work: the existing copy survives a failed import", () => {
  it("keeps public/works/<slug> unchanged and leaves no staging directory", () => {
    const good = makeExport("demo", "good");
    expect(run(["--slug", "demo", "--source", good]).status).toBe(0);
    const before = listFiles(join(works, "demo")).files;

    const bad = makeExport("demo", "bad");
    write(bad, "index.txt", `1:{"src":"/images/c.jpg"}\n`);
    expect(run(["--slug", "demo", "--source", bad]).status).toBe(1);
    expect(listFiles(join(works, "demo")).files).toEqual(before);
    expect(readFileSync(join(works, "demo/index.txt"), "utf8")).not.toContain("/images/c.jpg");
    expect(leftovers()).toEqual([]);
  });
});

describe("import-work: source and destination", () => {
  it("rejects the destination itself as the source", () => {
    const good = makeExport();
    expect(run(["--slug", "demo", "--source", good]).status).toBe(0);
    const r = run(["--slug", "demo", "--source", join(works, "demo")]);
    expect(r.status).toBe(1);
    expect(existsSync(join(works, "demo/index.html"))).toBe(true);
  });

  it("rejects a source inside public/works or containing it", () => {
    const good = makeExport();
    expect(run(["--slug", "demo", "--source", good]).status).toBe(0);
    for (const source of [join(works, "demo/_next"), join(works, "other"), join(repo, "public"), repo, root]) {
      mkdirSync(source, { recursive: true });
      const r = run(["--slug", "demo", "--source", source]);
      expect(r.status, source).toBe(1);
    }
    expect(existsSync(join(works, "demo/index.html"))).toBe(true);
  });

  it("rejects a source that does not exist or is a file", () => {
    expect(run(["--slug", "demo", "--source", join(root, "missing")]).status).toBe(1);
    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    expect(run(["--slug", "demo", "--source", file]).status).toBe(1);
  });
});

describe("import-work: command line", () => {
  it("requires a value after --slug and --source", () => {
    expect(() => parseArgs(["--slug", "--source", "out"])).toThrow(/--slug needs a value/);
    expect(() => parseArgs(["--slug", "demo", "--source"])).toThrow(/--source needs a value/);
    expect(() => parseArgs(["--slug", "", "--source", "out"])).toThrow(/--slug needs a value/);
    expect(() => parseArgs(["--source", "out"])).toThrow(/required/);
    expect(run(["--slug", "--source", makeExport()]).status).toBe(1);
    expect(existsSync(join(works, "--source"))).toBe(false);
  });

  it("rejects unknown options, repeated options and mixed forms", () => {
    expect(() => parseArgs(["--slug", "demo", "--source", "out", "--force"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--slug", "a", "--slug", "b", "--source", "out"])).toThrow(/twice/);
    expect(() => parseArgs(["--slug", "demo", "out"])).toThrow(/mix/);
    expect(() => parseArgs(["demo", "out", "extra"])).toThrow(/too many/);
  });

  it("accepts only safe slugs", () => {
    for (const slug of ["hoshi-no-cha", "midori-seitai", "yasashii-beauty-salon", "a", "a1-b2"]) {
      expect(parseArgs(["--slug", slug, "--source", "out"]).slug).toBe(slug);
    }
    for (const slug of [".", "..", ".hidden", "../x", "a/b", "a\\b", "-x", "x-", "a--b", "A", "a b", "a.b", "a_b", "é", "x".repeat(65)]) {
      expect(() => parseArgs([slug, "out"]), slug).toThrow();
    }
  });

  it("never writes outside public/works for a traversal slug", () => {
    const out = makeExport();
    for (const slug of ["..", "../../x", "%2e%2e"]) {
      expect(run([slug, out]).status, slug).toBe(1);
    }
    expect(readdirSync(works)).toEqual([]);
    expect(readdirSync(repo).sort()).toEqual(["public", "scripts"]);
  });
});
