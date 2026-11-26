import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSite } from "@/experiments/pages-cms/build";
import { Q1_TODAY, writeFixture } from "@/experiments/pages-cms/fixtures";
import { CAFE_SITE } from "@/experiments/pages-cms/shop-site";
import { ORIGIN_MARKER, stageForGates } from "@/experiments/pages-cms/stage-for-gates";
import { IMAGE_FIRST_ORIGIN_MARKER, main } from "@/scripts/sales/demo-version/package-local";

// DEV-364 (quality-proof-plan §2.10 / §6 row 3b, the tripwire part): the IMAGE_FIRST staging writes an origin marker,
// and package-local.ts's existing --source / --copy modes refuse a folder holding it, before anything is read or
// rendered. A TRIPWIRE, not tamper-proof (deleting the marker defeats it). Unmarked folders behave exactly as before.
// FICTIONAL, local; no package is written, no browser is started.

const temps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sr-origin-")));
  chmodSync(d, 0o700);
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const run = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { write: (s) => void out.push(s), writeErr: (s) => void err.push(s) });
  return { code, out: out.join(""), err: err.join("") };
};
const page = () => {
  const d = tmp();
  writeFileSync(join(d, "index.html"), "<!doctype html><title>架空</title><h1>架空の店</h1>");
  writeFileSync(join(d, "style.css"), "body{margin:0}");
  return d;
};

describe("DEV-364: the IMAGE_FIRST origin marker (a tripwire)", () => {
  it("the IMAGE_FIRST staging writes it next to index.html; package-local restates the same name", async () => {
    expect(IMAGE_FIRST_ORIGIN_MARKER).toBe(ORIGIN_MARKER);
    const repo = join(tmp(), "repo");
    await writeFixture(repo, CAFE_SITE.fixtures()["items-3"]!);
    const dist = join(tmp(), "dist");
    await buildSite({ repo, outDir: dist, today: Q1_TODAY, site: CAFE_SITE });
    const staged = await stageForGates({ dist, outDir: join(tmp(), "staged") });
    expect(staged.marker).toBe(ORIGIN_MARKER);
    expect(JSON.parse(readFileSync(join(staged.dir, ORIGIN_MARKER), "utf8"))).toMatchObject({ schema: "sr_build_origin_v1", origin: "image_first", tripwire_only: true });
    // the CMS build itself (dist/) is not the staged IMAGE_FIRST output and carries no marker
    expect(existsSync(join(dist, ORIGIN_MARKER))).toBe(false);
    // the staged IMAGE_FIRST output is refused by --source, before anything is read or rendered; nothing is written
    const out = join(tmp(), "pkg");
    const r = await run(["--out", out, "--source", staged.dir]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ status: "FAIL", code: "IMAGE_FIRST_OUTPUT" });
    expect(existsSync(out)).toBe(false);
  });

  it("--source and --copy refuse a marked folder (any entry by that name, a dangling link included)", async () => {
    const marked = page();
    writeFileSync(join(marked, IMAGE_FIRST_ORIGIN_MARKER), "{}");
    expect((await run(["--out", join(tmp(), "pkg"), "--source", marked])).out).toContain("IMAGE_FIRST_OUTPUT");
    // --copy is refused before its copy files are read (none exist here)
    expect((await run(["--out", join(tmp(), "pkg"), "--copy", marked, "--facts", join(marked, "facts.json")])).out).toContain("IMAGE_FIRST_OUTPUT");
    const linked = page();
    symlinkSync(join(linked, "nowhere.json"), join(linked, IMAGE_FIRST_ORIGIN_MARKER));
    expect((await run(["--out", join(tmp(), "pkg"), "--source", linked])).out).toContain("IMAGE_FIRST_OUTPUT");
    const dirMarker = page();
    mkdirSync(join(dirMarker, IMAGE_FIRST_ORIGIN_MARKER));
    expect((await run(["--out", join(tmp(), "pkg"), "--source", dirMarker])).out).toContain("IMAGE_FIRST_OUTPUT");
  });

  it("an unmarked folder goes on exactly as before (here: it reaches the reading of the page, as today)", async () => {
    // a folder without the marker and without a page: the same error as before the tripwire (the page is read next)
    const empty = tmp();
    await expect(run(["--out", join(tmp(), "pkg"), "--source", empty])).rejects.toThrow(/ENOENT/);
    // --copy without the marker: the comp reader's own refusal, as before
    const r = await run(["--out", join(tmp(), "pkg"), "--copy", empty, "--facts", join(empty, "facts.json")]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("IMAGE_FIRST_OUTPUT");
    // usage errors are still usage errors (exit 2) and come first
    expect((await run(["--source", page()])).code).toBe(2);
  });
});
