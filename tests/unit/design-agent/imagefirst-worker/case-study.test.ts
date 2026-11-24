import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  assertCaseStudyGate,
  CaseStudyStop,
  checkCaseStudy,
  inspectCaseStudy,
  OriginalsIndex,
  ORIGINALS_INDEX_PATH,
  renderViewingPage,
  SUCCESS_MANIFEST_PATH,
  viewingPageSha256,
  VIEWING_PAGE_CSP,
  writeViewingPage,
  type CaseStudyInspection,
  type ViewedFile,
} from "@/lib/design-agent/case-study/case-study";
import { caseStudyMain, parseCaseStudyArgs } from "@/scripts/design-artifact/case-study-check";
import { colourPng } from "../phase2f/fixtures";
import { CASE_STUDY_REPO_FILES, caseStudyObject, cleanupTemps, REPO, sha, tmp } from "./support";

// DEV-303 Issue #336 (docs/design/image-first-production-flow.md §1 stage 1, §3.1, §6.1 row 2): the per-shop success-case
// analysis record, its check and the owner's viewing page. FICTIONAL text and test bytes only (the shop "test-shop-a" is
// invented; "private originals" are generated PNGs recorded in a temporary copy of the index). No model, no network.

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanupTemps);

const SHOP = "test-shop-a";
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const codeOf = async (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof CaseStudyStop ? e.code : String(e)));
type Obj = Record<string, unknown>;
type FileRef = { path: string; sha256: string };
const draft = (over: Obj = {}) => caseStudyObject(SHOP, { owner_confirmation: undefined, ...over }) as Obj & { cases: (Obj & { files: FileRef[] })[] };
const withCases = (cases: Obj[], over: Obj = {}) => draft({ cases, ...over });
const textCase = (id: string, extra: Obj = {}) => ({ ...draft().cases[0]!, id, evidence_kind: "text_only", files: [], ...extra });
const SR001_FILES = ["index.html", "style.css", "copy.json"].map((n) => {
  const path = `design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9/${n}`;
  return { path, sha256: sha(readFileSync(resolve(REPO, path))) };
});
const srCase = () => ({ ...draft().cases[0]!, id: "SR-001", evidence_kind: "page_render", files: SR001_FILES });

/** The record with the owner's confirmation bound to the page it renders to (as Claude records it after the owner looked). */
async function confirmed(record: Obj, repo = REPO, ids?: string[]): Promise<Buffer> {
  const i = await inspectCaseStudy(bytesOf({ ...record, owner_confirmation: undefined }), { repo });
  return bytesOf({ ...record, owner_confirmation: { confirmed: true, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ids ?? i.counted, page_sha256: viewingPageSha256(i) } });
}

/** A copy of the repository's index, manifest and category-A images, with a private original recorded for some B ids. */
function libraryRepo(edit: (index: Obj, manifest: { records: Obj[] }) => void = () => undefined): string {
  const repo = tmp("sr-cs-lib-");
  for (const p of CASE_STUDY_REPO_FILES) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    cpSync(resolve(REPO, p), join(repo, p));
  }
  const index = JSON.parse(readFileSync(resolve(REPO, ORIGINALS_INDEX_PATH), "utf8")) as Obj;
  const manifest = JSON.parse(readFileSync(resolve(REPO, SUCCESS_MANIFEST_PATH), "utf8")) as { records: Obj[] };
  edit(index, manifest);
  writeFileSync(join(repo, ORIGINALS_INDEX_PATH), bytesOf(index));
  writeFileSync(join(repo, SUCCESS_MANIFEST_PATH), bytesOf(manifest));
  return repo;
}
/** A private place with generated (fictional) originals: PNG images and a ZIP-signed archive. */
function privateFiles(): { dir: string; png: (n: number) => FileRef; zip: FileRef; repoCopy: FileRef } {
  const dir = tmp("sr-cs-priv-");
  const png = (n: number) => {
    const b = colourPng(64 + n, 48);
    writeFileSync(join(dir, `p${n}.png`), b);
    return { path: join(dir, `p${n}.png`), sha256: sha(b) };
  };
  const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("fictional archive body")]);
  writeFileSync(join(dir, "original.zip"), zipBytes);
  const repoBytes = readFileSync(resolve(REPO, CASE_STUDY_REPO_FILES[1]!));
  writeFileSync(join(dir, "copy-of-cp001.webp"), repoBytes);
  return { dir, png, zip: { path: join(dir, "original.zip"), sha256: sha(zipBytes) }, repoCopy: { path: join(dir, "copy-of-cp001.webp"), sha256: sha(repoBytes) } };
}

describe("Issue #336 originals index (category A, recorded SHA-256s for B, C never)", () => {
  const index = OriginalsIndex.parse(JSON.parse(readFileSync(resolve(REPO, ORIGINALS_INDEX_PATH), "utf8")));
  it("lists CP-001..003 and SR-001 with the committed bytes' SHA-256 (and the ledgers' recorded values)", () => {
    expect(index.originals.map((o) => o.id)).toEqual(["CP-001", "CP-002", "CP-003", "SR-001"]);
    for (const o of index.originals) for (const f of o.files) expect(sha(readFileSync(resolve(REPO, f.path))), f.path).toBe(f.sha256);
    const manifest = JSON.parse(readFileSync(resolve(REPO, SUCCESS_MANIFEST_PATH), "utf8")) as { records: Obj[] };
    const rec = (id: string) => manifest.records.find((r) => r.id === id)!;
    const files = (id: string) => index.originals.find((o) => o.id === id)!.files.map((f) => f.sha256);
    expect(files("CP-001")).toEqual([rec("CP-001").webp_sha256]);
    expect(files("CP-002")).toEqual([rec("CP-002").webp_sha256]);
    expect(files("CP-003")).toEqual([rec("CP-003").webp_sha256, rec("CP-003").mobile_webp_sha256]);
    const sr = (JSON.parse(readFileSync(resolve(REPO, "design-library/success-cases/second-root-research-successes.json"), "utf8")) as { records: { id: string; page_hashes: Obj }[] }).records.find((r) => r.id === "SR-001")!;
    expect(files("SR-001")).toEqual([sr.page_hashes.html_sha256, sr.page_hashes.css_sha256, sr.page_hashes.copy_sha256]);
  });
  it("counts CP-001..003 only; C ids are unavailable; every B id has a recorded SHA-256 (manifest or adoption record)", () => {
    expect(index.originals.filter((o) => o.counts_as_reference).map((o) => o.id)).toEqual(["CP-001", "CP-002", "CP-003"]);
    expect(index.unavailable_ids).toEqual(["CP-026", "CP-027", "CP-028", "CP-029", "CP-030", "CP-031", "CP-032"]);
    expect(index.private_original_ids.some((id) => index.unavailable_ids.includes(id) || index.originals.some((o) => o.id === id))).toBe(false);
    const manifest = JSON.parse(readFileSync(resolve(REPO, SUCCESS_MANIFEST_PATH), "utf8")) as { records: Obj[] };
    for (const id of index.private_original_ids) {
      const fromManifest = Object.entries(manifest.records.find((r) => r.id === id) ?? {}).filter(([k, v]) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v) && !/rejected|not_preferred/.test(k));
      expect(fromManifest.length + (index.expected_sha256[id]?.length ?? 0), id).toBeGreaterThan(0);
    }
    // the adoption records' values, as originals-catalog.md and PRs #237 / #240 give them
    const catalog = readFileSync(resolve(REPO, "design-library/success-cases/originals-catalog.md"), "utf8");
    for (const id of ["CP-034", "CP-035", "CP-036", "CP-037"]) expect(catalog, id).toContain(index.expected_sha256[id]![0]!);
    expect(index.expected_sha256["SR-002"]).toEqual(["da08c7981d26f269e73408edb0f12d631f1fd19071f4e7853138086795392695"]);
    expect(index.expected_sha256["CP-033"]).toEqual(["5f18b6672bbc60d7db18c2af7b123fd2db448a78b8272c5e085746f1634edd77"]);
  });
});

describe("Issue #336 case study check", () => {
  it("an owner-confirmed record of 3 viewed originals passes the gate; a draft passes --draft only", async () => {
    const ok = await checkCaseStudy(bytesOf(caseStudyObject(SHOP)), { repo: REPO, mode: "gate" });
    expect(ok).toMatchObject({ shop_id: SHOP, counted: ["CP-001", "CP-002", "CP-003"], not_counted: [], owner_confirmed: true });
    expect(await checkCaseStudy(await confirmed(draft()), { repo: REPO, mode: "gate" })).toMatchObject({ counted: ["CP-001", "CP-002", "CP-003"] });
    const d = bytesOf(draft());
    expect((await checkCaseStudy(d, { repo: REPO, mode: "draft" })).owner_confirmed).toBe(false);
    expect(await codeOf(checkCaseStudy(d, { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_NOT_OWNER_CONFIRMED");
  });

  it("the owner's selected_ids must be exactly the counted cases", async () => {
    for (const ids of [["CP-001", "CP-002"], ["CP-001", "CP-002", "CP-003", "SR-001"], ["CP-001", "CP-002", "CP-002"]]) expect(await codeOf(checkCaseStudy(await confirmed(draft(), REPO, ids), { repo: REPO, mode: "gate" })), ids.join()).toBe("CASE_STUDY_SELECTION_MISMATCH");
    expect(await codeOf(checkCaseStudy(bytesOf(draft({ owner_confirmation: { confirmed: false, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ["CP-001"], page_sha256: "0".repeat(64) } })), { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_INVALID");
    // a confirmation without the page it binds to is not a confirmation
    expect(await codeOf(checkCaseStudy(bytesOf(draft({ owner_confirmation: { confirmed: true, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ["CP-001", "CP-002", "CP-003"] } })), { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_INVALID");
  });

  it("M3: the confirmation is bound to the page the owner viewed; any change to what the page shows needs a new one", async () => {
    const good = JSON.parse((await confirmed(draft())).toString()) as Obj & { owner_confirmation: Obj; cases: Obj[] };
    expect(await codeOf(checkCaseStudy(bytesOf({ ...good, owner_confirmation: { ...good.owner_confirmation, page_sha256: "0".repeat(64) } }), { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_PAGE_MISMATCH");
    // a principle changed after the owner looked: the record still parses and counts, but the page differs
    const edited = { ...good, cases: good.cases.map((c, n) => (n === 0 ? { ...c, principles_to_bring: ["後から書き換えた原理"] } : c)) };
    expect(await codeOf(checkCaseStudy(bytesOf(edited), { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_PAGE_MISMATCH");
    // recording the confirmation itself (date, note) never changes the page
    const noted = { ...good, owner_confirmation: { ...good.owner_confirmation, confirmed_at: "2026-11-21T09:00:00Z", note: "オーナーが確認（試験）" } };
    expect((await checkCaseStudy(bytesOf(noted), { repo: REPO, mode: "gate" })).counted).toHaveLength(3);
  });

  it("schema: strict, bounded plain text (no HTML, no link), unique ids, unique files, files for a seen case", async () => {
    const c0 = draft().cases[0]!;
    const code = (o: Obj) => codeOf(inspectCaseStudy(bytesOf(o), { repo: REPO }));
    expect(await code(draft({ extra: 1 }))).toBe("CASE_STUDY_INVALID");
    expect(await code(draft({ schema: "sr_case_study_v0" }))).toBe("CASE_STUDY_INVALID");
    expect(await code(draft({ shop_id: "Bad Shop" }))).toBe("CASE_STUDY_INVALID");
    expect(await code(draft({ shop_specific_principles: ["<b>太字</b>"] }))).toBe("CASE_STUDY_TEXT_UNSAFE");
    expect(await code(draft({ shop_specific_principles: ["https://example.invalid を見る"] }))).toBe("CASE_STUDY_TEXT_UNSAFE");
    expect(await code(draft({ shop_specific_principles: ["改行\nあり"] }))).toBe("CASE_STUDY_TEXT_UNSAFE");
    expect(await code(draft({ shop_specific_principles: ["あ".repeat(401)] }))).toBe("CASE_STUDY_INVALID");
    expect(await code(withCases([c0, c0]))).toBe("CASE_STUDY_DUPLICATE_CASE");
    expect(await code(withCases([{ ...c0, files: [] }]))).toBe("CASE_STUDY_INVALID");
    expect(await code(withCases([{ ...c0, files: [{ path: "../outside.webp", sha256: "a".repeat(64) }] }]))).toBe("CASE_STUDY_INVALID");
    expect(await code(withCases([{ ...c0, evidence_kind: "video" }]))).toBe("CASE_STUDY_INVALID");
    expect(await codeOf(inspectCaseStudy(Buffer.alloc(64 * 1024 + 1, 0x20), { repo: REPO }))).toBe("CASE_STUDY_TOO_LARGE");
    expect(await codeOf(inspectCaseStudy(Buffer.from("{"), { repo: REPO }))).toBe("CASE_STUDY_INVALID");
  });

  it("M1a: one file cannot stand for two cases (the same SHA-256 twice is refused)", async () => {
    const [c1, c2, c3] = draft().cases;
    expect(await codeOf(inspectCaseStudy(bytesOf(withCases([c1!, c2!, { ...c3!, files: [...c3!.files, c1!.files[0]!] }])), { repo: REPO }))).toBe("CASE_STUDY_DUPLICATE_FILE");
    const p = privateFiles().png(1);
    expect(await codeOf(inspectCaseStudy(bytesOf(withCases([c1!, { ...c2!, id: "CP-004", private_verified: true, files: [p] }, { ...c3!, id: "CP-005", private_verified: true, files: [{ ...p }] }])), { repo: REPO }))).toBe("CASE_STUDY_DUPLICATE_FILE");
  });

  it("every listed file must exist with its SHA-256, under design-library/ or outside the repository, with no link", async () => {
    const c0 = draft().cases[0]!;
    const code = (files: FileRef[], kind = "image") => codeOf(inspectCaseStudy(bytesOf(withCases([{ ...c0, evidence_kind: kind, files }, ...draft().cases.slice(1)])), { repo: REPO }));
    expect(await code([{ path: c0.files[0]!.path, sha256: "0".repeat(64) }])).toBe("CASE_STUDY_SHA_MISMATCH");
    expect(await code([{ path: "design-library/success-cases/assets/CP-999_None.webp", sha256: "0".repeat(64) }])).toBe("CASE_STUDY_FILE_MISSING");
    expect(await code([{ path: resolve(REPO, c0.files[0]!.path), sha256: c0.files[0]!.sha256 }])).toBe("CASE_STUDY_PRIVATE_IN_REPO");
    // L1: repo-relative files only under design-library/ (never e.g. package.json or a test fixture)
    expect(await code([{ path: "package.json", sha256: sha(readFileSync(resolve(REPO, "package.json"))) }], "text_only")).toBe("CASE_STUDY_FILE_OUTSIDE_LIBRARY");
    const priv = tmp("sr-cs-priv-");
    expect(await code([{ path: join(priv, "absent.png"), sha256: "0".repeat(64) }])).toBe("CASE_STUDY_FILE_MISSING");
    writeFileSync(join(priv, "real.png"), colourPng());
    symlinkSync(join(priv, "real.png"), join(priv, "link.png"));
    expect(await code([{ path: join(priv, "link.png"), sha256: sha(colourPng()) }])).toBe("CASE_STUDY_FILE_UNSAFE");
    // even a text_only case's files are checked (it may not claim a file it did not open)
    expect(await codeOf(inspectCaseStudy(bytesOf(withCases([...draft().cases, textCase("CP-005", { files: [{ path: "design-library/success-cases/CP-005-Hamsa.md", sha256: "0".repeat(64) }] })])), { repo: REPO }))).toBe("CASE_STUDY_SHA_MISMATCH");
  });

  it("M1c: evidence image takes only real images (extension and magic bytes) or a cited archive; page_render adds html/css/json", async () => {
    const c0 = draft().cases[0]!;
    const priv = tmp("sr-cs-type-");
    const put = (name: string, b: Buffer) => (writeFileSync(join(priv, name), b), { path: join(priv, name), sha256: sha(b) });
    const code = (kind: string, f: FileRef) => codeOf(inspectCaseStudy(bytesOf(withCases([...draft().cases, { ...c0, id: "CP-004", evidence_kind: kind, private_verified: true, files: [f] }])), { repo: REPO }));
    expect(await code("image", put("fake.png", Buffer.from("not a png at all")))).toBe("CASE_STUDY_EVIDENCE_FILE_INVALID");
    expect(await code("image", put("png-as.webp", colourPng(70, 40)))).toBe("CASE_STUDY_EVIDENCE_FILE_INVALID");
    expect(await code("image", put("notes.txt", Buffer.from("plain notes")))).toBe("CASE_STUDY_EVIDENCE_FILE_INVALID");
    expect(await code("image", put("page.html", Buffer.from("<p>x</p>")))).toBe("CASE_STUDY_EVIDENCE_FILE_INVALID");
    expect(await code("image", put("fake.zip", Buffer.from("no zip signature")))).toBe("CASE_STUDY_EVIDENCE_FILE_INVALID");
    expect(await code("page_render", put("notes.md", Buffer.from("# notes")))).toBe("CASE_STUDY_EVIDENCE_FILE_INVALID");
    // accepted types (they still do not count without a recorded SHA-256)
    expect(await code("page_render", put("page2.html", Buffer.from("<p>y</p>")))).toBe("resolved");
    expect(await code("image", put("real.png", colourPng(71, 40)))).toBe("resolved");
    expect(await code("text_only", put("any.txt", Buffer.from("text record")))).toBe("resolved");
  });

  it("text_only never counts, SR-001 never counts, an index id counts only with one of its own files", async () => {
    const [c1, c2, c3] = draft().cases;
    const unrelated = { ...c1!, id: "CP-001", files: c2!.files };
    const i = await inspectCaseStudy(bytesOf(withCases([unrelated, c3!, srCase(), textCase("CP-004"), textCase("CP-002")])), { repo: REPO });
    expect(i.counted).toEqual(["CP-003"]);
    expect(i.not_counted).toEqual([
      { id: "CP-001", reason: "index_file_not_viewed" },
      { id: "SR-001", reason: "not_a_reference" },
      { id: "CP-004", reason: "text_only" },
      { id: "CP-002", reason: "text_only" },
    ]);
    expect(() => assertCaseStudyGate(i, "draft")).toThrow("CASE_STUDY_TOO_FEW_ORIGINALS");
    const two = await confirmed(withCases([c1!, c2!, srCase(), textCase("CP-004")]), REPO, ["CP-001", "CP-002", "SR-001"]);
    expect(await codeOf(checkCaseStudy(two, { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_TOO_FEW_ORIGINALS");
    expect(await codeOf(checkCaseStudy(two, { repo: REPO, mode: "draft" }))).toBe("CASE_STUDY_TOO_FEW_ORIGINALS");
  });

  it("L2: SR-001 never counts, even if an index were edited to say it does", async () => {
    const repo = libraryRepo((index) => {
      for (const o of index.originals as Obj[]) if (o.id === "SR-001") o.counts_as_reference = true;
    });
    for (const f of SR001_FILES) {
      mkdirSync(dirname(join(repo, f.path)), { recursive: true });
      cpSync(resolve(REPO, f.path), join(repo, f.path));
    }
    const i = await inspectCaseStudy(bytesOf(withCases([...draft().cases.slice(0, 2), srCase()])), { repo });
    expect(i.not_counted).toEqual([{ id: "SR-001", reason: "not_a_reference" }]);
  });

  it("M1b/M1d: a private original counts only with a SHA-256 recorded for that id; never a copy of a repository original, never a C id", async () => {
    const [c1, c2] = draft().cases;
    const p = privateFiles();
    const [a, b, c, d] = [p.png(1), p.png(2), p.png(3), p.png(4)];
    // fictional records: CP-004's manifest entry gets the test PNG's SHA-256 (a rejected revision field gets another);
    // SR-002 and CP-033 get the test PNG / archive SHA-256s as their adoption values
    const repo = libraryRepo((index, manifest) => {
      const cp004 = manifest.records.find((r) => r.id === "CP-004")!;
      cp004.desktop_original_png_sha256 = a.sha256;
      const cp021 = manifest.records.find((r) => r.id === "CP-021")!;
      cp021.rejected_v2_png_sha256 = b.sha256;
      (index.expected_sha256 as Obj)["SR-002"] = [c.sha256];
      (index.expected_sha256 as Obj)["CP-033"] = [p.zip.sha256];
    });
    const priv = (id: string, files: FileRef[], extra: Obj = {}) => ({ ...c1!, id, private_verified: true, files, ...extra });
    const ok = await checkCaseStudy(await confirmed(withCases([c1!, priv("CP-004", [a]), priv("SR-002", [c])]), repo), { repo, mode: "gate" });
    expect(ok.counted).toEqual(["CP-001", "CP-004", "SR-002"]);
    const i = await inspectCaseStudy(
      bytesOf(
        withCases([
          c1!,
          c2!,
          priv("CP-021", [b]), // only a rejected revision's SHA-256: not the adopted original
          priv("CP-005", [d]), // nothing recorded matches
          priv("CP-026", [p.png(5)]), // category C
          priv("CP-099", [p.png(6)]),
          priv("SR-002", [p.png(7)], { private_verified: undefined }),
        ]),
      ),
      { repo },
    );
    expect(i.not_counted).toEqual([
      { id: "CP-021", reason: "private_sha_unrecorded" },
      { id: "CP-005", reason: "private_sha_unrecorded" },
      { id: "CP-026", reason: "original_unavailable" },
      { id: "CP-099", reason: "unknown_id" },
      { id: "SR-002", reason: "private_not_marked" },
    ]);
    // a private id may not be "verified" by a repository file, nor by a private copy of one
    expect((await inspectCaseStudy(bytesOf(withCases([c1!, priv("CP-035", c2!.files)])), { repo })).not_counted).toEqual([{ id: "CP-035", reason: "private_file_in_repo_form" }]);
    expect(await codeOf(inspectCaseStudy(bytesOf(withCases([c2!, priv("CP-004", [p.repoCopy])])), { repo }))).toBe("CASE_STUDY_PRIVATE_IS_REPO_ORIGINAL");
  });

  it("M1d: a cited archive must have the recorded SHA-256 and come with the viewed images", async () => {
    const [c1, c2] = draft().cases;
    const p = privateFiles();
    const img = p.png(1);
    const repo = libraryRepo((index) => {
      (index.expected_sha256 as Obj)["CP-033"] = [p.zip.sha256];
    });
    const priv = (id: string, files: FileRef[]) => ({ ...c1!, id, private_verified: true, files });
    // the adopted archive and the image Claude looked at inside it: counts
    expect((await inspectCaseStudy(bytesOf(withCases([c1!, c2!, priv("CP-033", [p.zip, img])])), { repo })).counted).toEqual(["CP-001", "CP-002", "CP-033"]);
    // the archive alone: not the viewed images
    expect((await inspectCaseStudy(bytesOf(withCases([c1!, priv("CP-033", [p.zip])])), { repo })).not_counted).toEqual([{ id: "CP-033", reason: "archive_without_images" }]);
    // an archive that is not the adopted one, even with images
    expect((await inspectCaseStudy(bytesOf(withCases([c1!, priv("CP-034", [p.zip, img])])), { repo })).not_counted).toEqual([{ id: "CP-034", reason: "archive_sha_unrecorded" }]);
  });

  it("an invalid or missing index stops (no silent counting)", async () => {
    expect(await codeOf(inspectCaseStudy(bytesOf(draft()), { repo: tmp("sr-cs-noindex-") }))).toBe("CASE_STUDY_INDEX_INVALID");
  });
});

describe("Issue #336 the owner's viewing page", () => {
  it("escapes every text, carries a CSP and no script, no link to the network, no external font", () => {
    const record = draft() as unknown as CaseStudyInspection["record"];
    const evil = `<script>alert("x")</script> & 'q' https://example.invalid`;
    const tampered = { ...record, shop_specific_principles: [evil], cases: record.cases.map((c) => ({ ...c, principles_to_bring: [evil], do_not_copy: [evil] })) };
    const files: ViewedFile[] = [{ case_id: "CP-001", path: `x"><script>y</script>.webp`, sha256: "a".repeat(64), bytes: Buffer.alloc(0) }];
    const html = renderViewingPage({ shop_id: SHOP, case_study_sha256: "b".repeat(64), counted: ["CP-001"], not_counted: [], owner_confirmed: false, record: tampered, files }, new Map([[files[0]!, "images/CP-001-1.webp"]]));
    expect(html).not.toMatch(/<script/i);
    // a tampered text is shown as text only: no attribute or stylesheet ever points at the network
    expect(html).not.toMatch(/(?:src|href|action)\s*=\s*["']?\s*(?:https?:|\/\/)|url\(/i);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;");
    expect(html).not.toMatch(/@import|@font-face|<link|<iframe|<object|<embed|\bon[a-z]+=/i);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${VIEWING_PAGE_CSP}">`);
    expect(VIEWING_PAGE_CSP).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    expect(html).toContain("足りない");
  });

  it("writes index.html with the viewed images copied next to it and prints the SHA-256 the confirmation binds", async () => {
    const i = await inspectCaseStudy(bytesOf(withCases([...draft().cases, srCase()])), { repo: REPO });
    const out = join(tmp("sr-cs-page-"), "page");
    const w = await writeViewingPage(i, { outDir: out, repo: REPO });
    expect(w.page).toBe(join(out, "index.html"));
    expect(readdirSync(join(out, "images")).sort()).toEqual(["CP-001-1.webp", "CP-002-1.webp", "CP-003-1.webp"]);
    expect(sha(readFileSync(join(out, "images", "CP-003-1.webp")))).toBe(i.files.find((f) => f.case_id === "CP-003")!.sha256);
    const html = readFileSync(w.page, "utf8");
    expect(w.page_sha256).toBe(sha(html));
    expect(w.page_sha256).toBe(viewingPageSha256(i));
    expect(html).not.toMatch(/<script|https?:|@import|<link/i);
    for (const n of ["CP-001-1.webp", "CP-002-1.webp", "CP-003-1.webp"]) expect(html).toContain(`src="images/${n}"`);
    expect(html).toContain("他店の参照に数えない");
    expect(html).toContain("試験用の店固有の原理");
    expect(await codeOf(writeViewingPage(i, { outDir: out, repo: REPO }))).toBe("CASE_STUDY_PAGE_DIR_NOT_EMPTY");
  });

  it("M2: never inside the repository, also through a linked ancestor", async () => {
    const i = await inspectCaseStudy(bytesOf(draft()), { repo: REPO });
    const repo = libraryRepo();
    const inRepo = join(repo, "tmp-case-study-page-never-written");
    expect(await codeOf(writeViewingPage(i, { outDir: inRepo, repo }))).toBe("CASE_STUDY_PAGE_IN_REPO");
    expect(existsSync(inRepo)).toBe(false);
    // ~/x -> <repo>/design-library: <link>/a/b/page would land inside the repository
    const outside = tmp("sr-cs-link-");
    symlinkSync(join(repo, "design-library"), join(outside, "lib-link"));
    const viaLink = join(outside, "lib-link", "a", "b", "page");
    expect(await codeOf(writeViewingPage(i, { outDir: viaLink, repo }))).toBe("CASE_STUDY_PAGE_IN_REPO");
    expect(existsSync(join(repo, "design-library", "a"))).toBe(false);
    // a link that points outside the repository is fine
    const elsewhere = tmp("sr-cs-elsewhere-");
    symlinkSync(elsewhere, join(outside, "out-link"));
    expect((await writeViewingPage(i, { outDir: join(outside, "out-link", "page"), repo })).page).toBe(join(outside, "out-link", "page", "index.html"));
    expect(existsSync(join(elsewhere, "page", "index.html"))).toBe(true);
  });
});

describe("Issue #336 the CLI", () => {
  const quiet = () => vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  it("parses --check [--draft] and --page --out only", () => {
    expect(parseCaseStudyArgs(["--check", "/x.json"])).toMatchObject({ mode: "check", draft: false });
    expect(parseCaseStudyArgs(["--check", "/x.json", "--draft"])).toMatchObject({ mode: "check", draft: true });
    expect(parseCaseStudyArgs(["--page", "/x.json", "--out", "/o"])).toMatchObject({ mode: "page", out: "/o" });
    for (const bad of [[], ["--check"], ["--check", "/x", "--page", "/y"], ["--page", "/x.json"], ["--page", "/x", "--out", "/o", "--draft"], ["--check", "/x", "--out", "/o"], ["--check", "/x", "--draft", "--draft"], ["--check", "--draft"]]) expect(parseCaseStudyArgs(bad), bad.join(" ")).toBeNull();
  });

  it("draft → page (prints page_sha256) → the owner's confirmation recorded with it → gate passes; 2 refused, record in repo never read", async () => {
    const spy = quiet();
    try {
      const dir = tmp("sr-cs-cli-");
      const file = join(dir, "case-study.json");
      writeFileSync(file, bytesOf(draft()));
      expect(await caseStudyMain(["--check", file], REPO)).toBe(1);
      expect(String(spy.mock.calls.at(-1)?.[0])).toContain("CASE_STUDY_NOT_OWNER_CONFIRMED");
      expect(await caseStudyMain(["--check", file, "--draft"], REPO)).toBe(0);
      expect(await caseStudyMain(["--page", file, "--out", join(dir, "page")], REPO)).toBe(0);
      const printed = JSON.parse(String(spy.mock.calls.at(-1)?.[0])) as { page_sha256: string };
      expect(printed.page_sha256).toBe(sha(readFileSync(join(dir, "page", "index.html"))));
      writeFileSync(file, bytesOf({ ...draft(), owner_confirmation: { confirmed: true, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ["CP-001", "CP-002", "CP-003"], page_sha256: printed.page_sha256 } }));
      expect(await caseStudyMain(["--check", file], REPO)).toBe(0);
      expect(await caseStudyMain(["--check", resolve(REPO, ORIGINALS_INDEX_PATH)], REPO)).toBe(2);
      expect(String(spy.mock.calls.at(-1)?.[0])).toContain("CASE_STUDY_RECORD_IN_REPO");
      expect(await caseStudyMain(["--check", join(dir, "absent.json")], REPO)).toBe(2);
      expect(await caseStudyMain(["--bogus"], REPO)).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
