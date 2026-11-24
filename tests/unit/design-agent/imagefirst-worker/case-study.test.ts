import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  assertCaseStudyGate,
  CaseStudyStop,
  checkCaseStudy,
  inspectCaseStudy,
  OriginalsIndex,
  ORIGINALS_INDEX_PATH,
  renderViewingPage,
  writeViewingPage,
  type CaseStudyInspection,
  type ViewedFile,
} from "@/lib/design-agent/case-study/case-study";
import { caseStudyMain, parseCaseStudyArgs } from "@/scripts/design-artifact/case-study-check";
import { caseStudyObject, cleanupTemps, REPO, sha, tmp } from "./support";

// DEV-303 Issue #336 (docs/design/image-first-production-flow.md §1 stage 1, §3.1, §6.1 row 2): the per-shop success-case
// analysis record, its check and the owner's viewing page. FICTIONAL text only (the shop "test-shop-a" is invented); the
// images are the repository's own category-A files. No model, no network, no Codex.

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanupTemps);

const SHOP = "test-shop-a";
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const codeOf = async (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof CaseStudyStop ? e.code : String(e)));
type Obj = Record<string, unknown>;
const base = (over: Obj = {}) => caseStudyObject(SHOP, over) as Obj & { cases: Obj[] };
const withCases = (cases: Obj[], over: Obj = {}) => base({ cases, ...over });
const textCase = (id: string, extra: Obj = {}) => ({ ...base().cases[0]!, id, evidence_kind: "text_only", files: [], ...extra });
const SR001_FILES = ["index.html", "style.css", "copy.json"].map((n) => {
  const path = `design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9/${n}`;
  return { path, sha256: sha(readFileSync(resolve(REPO, path))) };
});

describe("Issue #336 originals index (category A)", () => {
  const index = OriginalsIndex.parse(JSON.parse(readFileSync(resolve(REPO, ORIGINALS_INDEX_PATH), "utf8")));
  it("lists CP-001..003 and SR-001 with the committed bytes' SHA-256 (and the ledgers' recorded values)", () => {
    expect(index.originals.map((o) => o.id)).toEqual(["CP-001", "CP-002", "CP-003", "SR-001"]);
    for (const o of index.originals) for (const f of o.files) expect(sha(readFileSync(resolve(REPO, f.path))), f.path).toBe(f.sha256);
    const manifest = JSON.parse(readFileSync(resolve(REPO, "design-library/success-cases/manifest.json"), "utf8")) as { records: Obj[] };
    const rec = (id: string) => manifest.records.find((r) => r.id === id)!;
    const files = (id: string) => index.originals.find((o) => o.id === id)!.files.map((f) => f.sha256);
    expect(files("CP-001")).toEqual([rec("CP-001").webp_sha256]);
    expect(files("CP-002")).toEqual([rec("CP-002").webp_sha256]);
    expect(files("CP-003")).toEqual([rec("CP-003").webp_sha256, rec("CP-003").mobile_webp_sha256]);
    const sr = (JSON.parse(readFileSync(resolve(REPO, "design-library/success-cases/second-root-research-successes.json"), "utf8")) as { records: { id: string; page_hashes: Obj }[] }).records.find((r) => r.id === "SR-001")!;
    expect(files("SR-001")).toEqual([sr.page_hashes.html_sha256, sr.page_hashes.css_sha256, sr.page_hashes.copy_sha256]);
  });
  it("counts CP-001..003 as references and never SR-001 (its ledger policy)", () => {
    expect(index.originals.filter((o) => o.counts_as_reference).map((o) => o.id)).toEqual(["CP-001", "CP-002", "CP-003"]);
    expect(index.private_original_ids).not.toContain("SR-001");
    expect(index.private_original_ids.some((id) => index.originals.some((o) => o.id === id))).toBe(false);
  });
});

describe("Issue #336 case study check", () => {
  it("an owner-confirmed record of 3 viewed originals passes the gate; a draft passes --draft only", async () => {
    const ok = await checkCaseStudy(bytesOf(base()), { repo: REPO, mode: "gate" });
    expect(ok).toMatchObject({ shop_id: SHOP, counted: ["CP-001", "CP-002", "CP-003"], not_counted: [], owner_confirmed: true });
    const draft = bytesOf(base({ owner_confirmation: undefined }));
    expect((await checkCaseStudy(draft, { repo: REPO, mode: "draft" })).owner_confirmed).toBe(false);
    expect(await codeOf(checkCaseStudy(draft, { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_NOT_OWNER_CONFIRMED");
  });

  it("the owner's selected_ids must be exactly the counted cases", async () => {
    const oc = (selected_ids: string[]) => bytesOf(base({ owner_confirmation: { confirmed: true, confirmed_at: "2026-11-20T00:00:00Z", selected_ids } }));
    expect(await codeOf(checkCaseStudy(oc(["CP-001", "CP-002"]), { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_SELECTION_MISMATCH");
    expect(await codeOf(checkCaseStudy(oc(["CP-001", "CP-002", "CP-003", "SR-001"]), { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_SELECTION_MISMATCH");
    expect(await codeOf(checkCaseStudy(oc(["CP-001", "CP-002", "CP-002"]), { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_SELECTION_MISMATCH");
    expect(await codeOf(checkCaseStudy(bytesOf(base({ owner_confirmation: { confirmed: false, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ["CP-001"] } })), { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_INVALID");
  });

  it("schema: strict, bounded plain text (no HTML, no link), unique ids, files for a seen case", async () => {
    const c0 = base().cases[0]!;
    const code = (o: Obj) => codeOf(inspectCaseStudy(bytesOf(o), { repo: REPO }));
    expect(await code(base({ extra: 1 }))).toBe("CASE_STUDY_INVALID");
    expect(await code(base({ schema: "sr_case_study_v0" }))).toBe("CASE_STUDY_INVALID");
    expect(await code(base({ shop_id: "Bad Shop" }))).toBe("CASE_STUDY_INVALID");
    expect(await code(base({ shop_specific_principles: ["<b>太字</b>"] }))).toBe("CASE_STUDY_TEXT_UNSAFE");
    expect(await code(base({ shop_specific_principles: ["https://example.invalid を見る"] }))).toBe("CASE_STUDY_TEXT_UNSAFE");
    expect(await code(base({ shop_specific_principles: ["改行\nあり"] }))).toBe("CASE_STUDY_TEXT_UNSAFE");
    expect(await code(base({ shop_specific_principles: ["あ".repeat(401)] }))).toBe("CASE_STUDY_INVALID");
    expect(await code(withCases([c0, c0]))).toBe("CASE_STUDY_DUPLICATE_CASE");
    expect(await code(withCases([{ ...c0, files: [] }]))).toBe("CASE_STUDY_INVALID");
    expect(await code(withCases([{ ...c0, files: [{ path: "../outside.webp", sha256: "a".repeat(64) }] }]))).toBe("CASE_STUDY_INVALID");
    expect(await code(withCases([{ ...c0, evidence_kind: "video" }]))).toBe("CASE_STUDY_INVALID");
    expect(await codeOf(inspectCaseStudy(Buffer.alloc(64 * 1024 + 1, 0x20), { repo: REPO }))).toBe("CASE_STUDY_TOO_LARGE");
    expect(await codeOf(inspectCaseStudy(Buffer.from("{"), { repo: REPO }))).toBe("CASE_STUDY_INVALID");
  });

  it("every listed file must exist with its SHA-256 (no link, no private path inside the repository)", async () => {
    const c0 = base().cases[0]! as Obj & { files: { path: string; sha256: string }[] };
    const code = (files: { path: string; sha256: string }[]) => codeOf(inspectCaseStudy(bytesOf(withCases([{ ...c0, files }, ...base().cases.slice(1)])), { repo: REPO }));
    expect(await code([{ path: c0.files[0]!.path, sha256: "0".repeat(64) }])).toBe("CASE_STUDY_SHA_MISMATCH");
    expect(await code([{ path: "design-library/success-cases/assets/CP-999_None.webp", sha256: "0".repeat(64) }])).toBe("CASE_STUDY_FILE_MISSING");
    expect(await code([{ path: resolve(REPO, c0.files[0]!.path), sha256: c0.files[0]!.sha256 }])).toBe("CASE_STUDY_PRIVATE_IN_REPO");
    const priv = tmp("sr-cs-priv-");
    expect(await code([{ path: join(priv, "absent.png"), sha256: "0".repeat(64) }])).toBe("CASE_STUDY_FILE_MISSING");
    writeFileSync(join(priv, "real.png"), "x");
    symlinkSync(join(priv, "real.png"), join(priv, "link.png"));
    expect(await code([{ path: join(priv, "link.png"), sha256: sha("x") }])).toBe("CASE_STUDY_FILE_UNSAFE");
    // even a text_only case's files are checked (it may not claim a file it did not open)
    expect(await codeOf(inspectCaseStudy(bytesOf(withCases([...base().cases, textCase("CP-005", { files: [{ path: "design-library/success-cases/CP-005-Hamsa.md", sha256: "0".repeat(64) }] })])), { repo: REPO }))).toBe("CASE_STUDY_SHA_MISMATCH");
  });

  it("text_only never counts, SR-001 never counts, an index id counts only with one of its own files", async () => {
    const [c1, c2, c3] = base().cases as Obj[];
    const sr001 = { ...c1!, id: "SR-001", evidence_kind: "page_render", files: SR001_FILES };
    const unrelated = { ...c1!, id: "CP-001", files: (c2 as { files: unknown[] }).files };
    const i = await inspectCaseStudy(bytesOf(withCases([unrelated, c3!, sr001, textCase("CP-004"), textCase("CP-002")])), { repo: REPO });
    expect(i.counted).toEqual(["CP-003"]);
    expect(i.not_counted).toEqual([
      { id: "CP-001", reason: "index_file_not_viewed" },
      { id: "SR-001", reason: "not_a_reference" },
      { id: "CP-004", reason: "text_only" },
      { id: "CP-002", reason: "text_only" },
    ]);
    expect(() => assertCaseStudyGate(i, "draft")).toThrow("CASE_STUDY_TOO_FEW_ORIGINALS");
    // 2 originals + SR-001 + text records: still too few, whatever the owner confirmed
    const two = bytesOf(withCases([c1!, c2!, sr001, textCase("CP-004")], { owner_confirmation: { confirmed: true, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ["CP-001", "CP-002", "SR-001"] } }));
    expect(await codeOf(checkCaseStudy(two, { repo: REPO, mode: "gate" }))).toBe("CASE_STUDY_TOO_FEW_ORIGINALS");
    expect(await codeOf(checkCaseStudy(two, { repo: REPO, mode: "draft" }))).toBe("CASE_STUDY_TOO_FEW_ORIGINALS");
  });

  it("a private original counts only when marked private_verified, an index-listed private id, outside the repository", async () => {
    const [c1, c2] = base().cases as Obj[];
    const priv = tmp("sr-cs-priv-");
    writeFileSync(join(priv, "restored.png"), "restored original (test bytes)");
    const file = { path: join(priv, "restored.png"), sha256: sha("restored original (test bytes)") };
    const privCase = (id: string, extra: Obj = {}) => ({ ...c1!, id, files: [file], private_verified: true, ...extra });
    const confirmed = (ids: string[]) => ({ owner_confirmation: { confirmed: true, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ids } });
    const ok = await checkCaseStudy(bytesOf(withCases([c1!, c2!, privCase("CP-034")], confirmed(["CP-001", "CP-002", "CP-034"]))), { repo: REPO, mode: "gate" });
    expect(ok.counted).toEqual(["CP-001", "CP-002", "CP-034"]);
    const i = await inspectCaseStudy(bytesOf(withCases([c1!, c2!, privCase("CP-034", { private_verified: undefined }), privCase("CP-099"), privCase("CP-014")])), { repo: REPO });
    expect(i.not_counted).toEqual([
      { id: "CP-034", reason: "private_not_marked" },
      { id: "CP-099", reason: "unknown_id" },
      { id: "CP-014", reason: "unknown_id" },
    ]);
    // a private id may not be "verified" by a file in the repository
    const inRepo = await inspectCaseStudy(bytesOf(withCases([c1!, c2!, { ...privCase("CP-035"), files: (c2 as { files: unknown[] }).files }])), { repo: REPO });
    expect(inRepo.not_counted).toEqual([{ id: "CP-035", reason: "private_file_in_repo_form" }]);
  });

  it("an invalid or missing index stops (no silent counting)", async () => {
    expect(await codeOf(inspectCaseStudy(bytesOf(base()), { repo: tmp("sr-cs-noindex-") }))).toBe("CASE_STUDY_INDEX_INVALID");
  });
});

describe("Issue #336 the owner's viewing page", () => {
  it("escapes every text and carries no script, no link to the network, no external font", () => {
    const record = base() as unknown as CaseStudyInspection["record"];
    const evil = `<script>alert("x")</script> & 'q' https://example.invalid`;
    const tampered = { ...record, shop_specific_principles: [evil], cases: record.cases.map((c) => ({ ...c, principles_to_bring: [evil], do_not_copy: [evil] })) };
    const files: ViewedFile[] = [{ case_id: "CP-001", path: `x"><script>y</script>.webp`, sha256: "a".repeat(64), bytes: Buffer.alloc(0) }];
    const html = renderViewingPage({ shop_id: SHOP, case_study_sha256: "b".repeat(64), counted: ["CP-001"], not_counted: [], owner_confirmed: false, record: tampered, files }, new Map([[files[0]!, "images/CP-001-1.webp"]]));
    expect(html).not.toMatch(/<script/i);
    // a tampered text is shown as text only: no attribute or stylesheet ever points at the network
    expect(html).not.toMatch(/(?:src|href|action)\s*=\s*["']?\s*(?:https?:|\/\/)|url\(/i);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;");
    expect(html).not.toMatch(/@import|@font-face|<link|<iframe|<object|<embed|\bon[a-z]+=/i);
    expect(html).toContain("足りない");
  });

  it("writes index.html with the viewed images copied next to it, only outside the repository, never over a used directory", async () => {
    const i = await inspectCaseStudy(bytesOf(withCases([...base().cases, { ...base().cases[0]!, id: "SR-001", evidence_kind: "page_render", files: SR001_FILES }])), { repo: REPO });
    const out = join(tmp("sr-cs-page-"), "page");
    const w = await writeViewingPage(i, { outDir: out, repo: REPO });
    expect(w.page).toBe(join(out, "index.html"));
    expect(readdirSync(join(out, "images")).sort()).toEqual(["CP-001-1.webp", "CP-002-1.webp", "CP-003-1.webp"]);
    expect(sha(readFileSync(join(out, "images", "CP-003-1.webp")))).toBe(i.files.find((f) => f.case_id === "CP-003")!.sha256);
    const html = readFileSync(w.page, "utf8");
    expect(html).not.toMatch(/<script|https?:|@import|<link/i);
    for (const n of ["CP-001-1.webp", "CP-002-1.webp", "CP-003-1.webp"]) expect(html).toContain(`src="images/${n}"`);
    expect(html).toContain("他店の参照に数えない");
    expect(html).toContain("試験用の店固有の原理");
    expect(html).toContain("オーナーの確認: 2026-11-20T00:00:00Z");
    expect(await codeOf(writeViewingPage(i, { outDir: out, repo: REPO }))).toBe("CASE_STUDY_PAGE_DIR_NOT_EMPTY");
    const inRepo = join(REPO, "tmp-case-study-page-never-written");
    expect(await codeOf(writeViewingPage(i, { outDir: inRepo, repo: REPO }))).toBe("CASE_STUDY_PAGE_IN_REPO");
    expect(existsSync(inRepo)).toBe(false);
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

  it("exit 0 passed, 1 stopped with a named code, 2 refused (a record inside the repository is never read)", async () => {
    const spy = quiet();
    try {
      const dir = tmp("sr-cs-cli-");
      const file = join(dir, "case-study.json");
      writeFileSync(file, bytesOf(base()));
      expect(await caseStudyMain(["--check", file], REPO)).toBe(0);
      writeFileSync(file, bytesOf(base({ owner_confirmation: undefined })));
      expect(await caseStudyMain(["--check", file], REPO)).toBe(1);
      expect(String(spy.mock.calls.at(-1)?.[0])).toContain("CASE_STUDY_NOT_OWNER_CONFIRMED");
      expect(await caseStudyMain(["--check", file, "--draft"], REPO)).toBe(0);
      expect(await caseStudyMain(["--page", file, "--out", join(dir, "page")], REPO)).toBe(0);
      expect(existsSync(join(dir, "page", "index.html"))).toBe(true);
      expect(await caseStudyMain(["--check", resolve(REPO, ORIGINALS_INDEX_PATH)], REPO)).toBe(2);
      expect(String(spy.mock.calls.at(-1)?.[0])).toContain("CASE_STUDY_RECORD_IN_REPO");
      expect(await caseStudyMain(["--check", join(dir, "absent.json")], REPO)).toBe(2);
      expect(await caseStudyMain(["--bogus"], REPO)).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
