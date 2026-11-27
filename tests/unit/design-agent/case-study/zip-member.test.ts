import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { CaseStudyStop, inspectCaseStudy, ORIGINALS_INDEX_PATH, SUCCESS_MANIFEST_PATH, viewingPageHtml } from "@/lib/design-agent/case-study/case-study";
import { referencesJa } from "@/lib/design-agent/image-first/request-prompt";
import { caseStudyUseOf } from "@/lib/design-agent/imagefirst-worker/request";
import { colourPng } from "../phase2f/fixtures";
import { cleanupTemps, REPO, sha, tmp } from "../imagefirst-worker/support";

// DEV-364 (owner originals 2026-11-27; PR #381 review): a member of a recorded category-B ZIP counts as an ORIGINAL only
// when the repository's allowlist names it (ZIP SHA-256 + member path + member SHA-256) and it is inside that ZIP and its
// SHA256SUMS; such a member becomes a reference the prompt calls 原本. Anything else stays evidence only. FICTIONAL data only: an invented ZIP whose SHA-256 is
// recorded for CP-033 in a temporary copy of the index. No Codex, no model, no network.

afterAll(cleanupTemps);

/** A stored (uncompressed) ZIP of the given members. */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, e.data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const DESKTOP = colourPng(1440, 2400);
const OVERVIEW = colourPng(1200, 800);
const MEMBER = "site/desktop_1440_full.png";
const sumsOf = (entries: { name: string; data: Buffer }[]) => Buffer.from(entries.map((e) => `${sha(e.data)}  ${e.name}\n`).join(""));

/**
 * A temporary repository whose index records the ZIP's SHA-256 for CP-033 and allowlists `allow` (default: MEMBER with
 * DESKTOP's SHA-256) as its adopted-page members, and a private folder with the ZIP and its extracted members.
 */
function world(o: { members?: { name: string; data: Buffer }[]; sums?: Buffer | null; allow?: { path: string; sha256: string }[]; manifestCp033?: Record<string, string> } = {}) {
  const members = o.members ?? [{ name: MEMBER, data: DESKTOP }, { name: "site/PC_SP_overview.png", data: OVERVIEW }];
  const entries = o.sums === null ? members : [...members, { name: "SHA256SUMS", data: o.sums ?? sumsOf(members) }];
  const zipBytes = zip(entries);
  const repo = tmp("sr-zipm-repo-");
  mkdirSync(join(repo, "design-library/success-cases"), { recursive: true });
  const index = JSON.parse(readFileSync(resolve(REPO, ORIGINALS_INDEX_PATH), "utf8")) as { expected_sha256: Record<string, string[]>; zip_member_originals?: Record<string, unknown[]> };
  index.expected_sha256["CP-033"] = [sha(zipBytes)];
  index.zip_member_originals = { ...index.zip_member_originals, "CP-033": (o.allow ?? [{ path: MEMBER, sha256: sha(DESKTOP) }]).map((x) => ({ zip_sha256: sha(zipBytes), ...x })) };
  writeFileSync(join(repo, ORIGINALS_INDEX_PATH), JSON.stringify(index));
  const manifest = JSON.parse(readFileSync(resolve(REPO, SUCCESS_MANIFEST_PATH), "utf8")) as { records: Record<string, unknown>[] };
  if (o.manifestCp033) manifest.records = [...manifest.records.filter((r) => r.id !== "CP-033"), { id: "CP-033", ...o.manifestCp033 }];
  writeFileSync(join(repo, SUCCESS_MANIFEST_PATH), JSON.stringify(manifest));
  const priv = tmp("sr-zipm-priv-");
  writeFileSync(join(priv, "CP-033.zip"), zipBytes);
  mkdirSync(join(priv, "x", "site"), { recursive: true });
  for (const m of members) writeFileSync(join(priv, "x", m.name), m.data);
  return { repo, priv, zipSha: sha(zipBytes), zipPath: join(priv, "CP-033.zip") };
}
const obs = { composition: "構図", information_design: "情報設計", shop_character: "店らしさ", pc_sp: "PC と SP" };
function recordOf(files: Record<string, unknown>[], extra: Record<string, unknown> = { private_verified: true }, id = "CP-033") {
  return Buffer.from(JSON.stringify({ schema: "sr_case_study_v1", shop_id: "test-shop-z", cases: [{ id, evidence_kind: "image", files, observations: obs, principles_to_bring: ["原理"], do_not_copy: ["写さない"], ...extra }], shop_specific_principles: ["店の原理"] }));
}
const codeOf = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof CaseStudyStop ? e.code : String(e)));
const memberOf = (w: { priv: string; zipSha: string }, name = MEMBER, data = DESKTOP, over: Record<string, unknown> = {}) => ({ path: join(w.priv, "x", name), sha256: sha(data), zip_member: { zip_sha256: w.zipSha, path: name, ...over } });

describe("DEV-364 an allowlisted member of a recorded category-B ZIP counts as an original", () => {
  it("on the allowlist, inside the ZIP and its SHA256SUMS: an original reference (原本); another marked member stays evidence only", async () => {
    const w = world();
    const member = memberOf(w);
    const overview = memberOf(w, "site/PC_SP_overview.png", OVERVIEW);
    const i = await inspectCaseStudy(recordOf([{ path: w.zipPath, sha256: w.zipSha }, overview, member]), { repo: w.repo });
    expect(i.counted).toEqual(["CP-033"]);
    expect(i.counting_files["CP-033"]).toEqual([{ path: w.zipPath, sha256: w.zipSha }, { path: member.path, sha256: member.sha256 }]);
    const refs = caseStudyUseOf(i).use.references;
    expect(refs).toEqual([{ id: "ref-1", case_id: "CP-033", name: "ref-1.png", sha256: sha(DESKTOP), media_type: "image/png" }]);
    expect(referencesJa(refs)).toBe("成功例の原本 1 枚");
  });

  it("PR #381 review H1: a member that is not on the allowlist never counts, whatever its name (a sheet named like a full page too)", async () => {
    // the overview saved under a full-page name, and a correct member of a ZIP whose id has no allowlist entry for it
    const sheet = colourPng(1440, 1200);
    const w = world({ members: [{ name: "site/desktop_1440_full.png", data: sheet }, { name: "site/OneSheet.png", data: OVERVIEW }], allow: [{ path: MEMBER, sha256: sha(DESKTOP) }] });
    const i = await inspectCaseStudy(recordOf([{ path: w.zipPath, sha256: w.zipSha }, memberOf(w, MEMBER, sheet), memberOf(w, "site/OneSheet.png", OVERVIEW)]), { repo: w.repo });
    expect(i.counting_files["CP-033"]).toEqual([{ path: w.zipPath, sha256: w.zipSha }]);
    expect(caseStudyUseOf(i).use.references).toEqual([]);
    // without zip_member the listed image is evidence only, as before
    const v = world();
    const j = await inspectCaseStudy(recordOf([{ path: v.zipPath, sha256: v.zipSha }, { path: join(v.priv, "x", MEMBER), sha256: sha(DESKTOP) }]), { repo: v.repo });
    expect(j.counting_files["CP-033"]).toEqual([{ path: v.zipPath, sha256: v.zipSha }]);
  });

  it("PR #381 review M1: an allowlisted member whose SHA-256 the manifest records as a viewing copy stays a viewing copy", async () => {
    const w = world({ manifestCp033: { preview_png_sha256: sha(DESKTOP) } });
    const i = await inspectCaseStudy(recordOf([{ path: w.zipPath, sha256: w.zipSha }, memberOf(w)]), { repo: w.repo });
    expect(i.counting_files["CP-033"]).toContainEqual({ path: join(w.priv, "x", MEMBER), sha256: sha(DESKTOP), copy: "viewing" });
    expect(caseStudyUseOf(i).use.references.map((r) => r.copy)).toEqual(["viewing"]);
  });

  it("refuses an allowlisted claim the ZIP does not back (CASE_STUDY_ZIP_MEMBER_MISMATCH)", async () => {
    const run = (w: { repo: string }, files: Record<string, unknown>[], extra?: Record<string, unknown>) => codeOf(inspectCaseStudy(recordOf(files, extra), { repo: w.repo }));
    const w = world();
    const zipFile = { path: w.zipPath, sha256: w.zipSha };
    // the ZIP not listed in the case; not a private_verified category-B case
    expect(await run(w, [memberOf(w)])).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    expect(await run(w, [zipFile, memberOf(w)], {})).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    // the allowlist names bytes the ZIP does not hold at that path (the extracted file is those bytes)
    const other = colourPng(1440, 2401);
    const v = world({ allow: [{ path: MEMBER, sha256: sha(other) }] });
    writeFileSync(join(v.priv, "x", "fake.png"), other);
    expect(await run(v, [{ path: v.zipPath, sha256: v.zipSha }, { path: join(v.priv, "x", "fake.png"), sha256: sha(other), zip_member: { zip_sha256: v.zipSha, path: MEMBER } }])).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    // no SHA256SUMS, a SHA256SUMS line that does not match, a SHA256SUMS without the member
    for (const sums of [null, Buffer.from(`${"f".repeat(64)}  ${MEMBER}\n`), Buffer.from(`${sha(OVERVIEW)}  site/PC_SP_overview.png\n`)]) {
      const x = world({ sums });
      expect(await run(x, [{ path: x.zipPath, sha256: x.zipSha }, memberOf(x)]), String(sums)).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    }
  });

  it("a ZIP whose SHA-256 is not recorded for the id never lends its members", async () => {
    const w = world();
    const index = JSON.parse(readFileSync(join(w.repo, ORIGINALS_INDEX_PATH), "utf8")) as { expected_sha256: Record<string, string[]> };
    index.expected_sha256["CP-033"] = ["d".repeat(64)];
    writeFileSync(join(w.repo, ORIGINALS_INDEX_PATH), JSON.stringify(index));
    expect(await codeOf(inspectCaseStudy(recordOf([{ path: w.zipPath, sha256: w.zipSha }, memberOf(w)]), { repo: w.repo }))).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
  });
});

describe("DEV-364 the repository's allowlist", () => {
  it("names only members of handover success_zip ZIPs of the same id, by path, member SHA-256 and ZIP SHA-256 (no image)", () => {
    const index = JSON.parse(readFileSync(resolve(REPO, ORIGINALS_INDEX_PATH), "utf8")) as { zip_member_originals: Record<string, { zip_sha256: string; path: string; sha256: string }[]> };
    const handover = JSON.parse(readFileSync(resolve(REPO, "design-library/success-cases/originals-handover.json"), "utf8")) as { cases: { id: string; request: { sha256: string | null; role: string }[] }[] };
    expect(Object.keys(index.zip_member_originals).sort()).toEqual(["CP-033", "CP-037"]);
    for (const [id, list] of Object.entries(index.zip_member_originals)) {
      const zips = handover.cases.find((c) => c.id === id)!.request.filter((r) => r.role === "success_zip").map((r) => r.sha256);
      for (const e of list) {
        expect(zips, `${id} ${e.path}`).toContain(e.zip_sha256);
        expect(e.path).toMatch(/\.png$/);
        expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe("DEV-364 owner_review: shown on the confirmation page, never in the prompt", () => {
  it("renders the selection reasons, planned direction and questions (escaped); the plan's case-study use ignores them", async () => {
    const w = world();
    const member = { path: join(w.priv, "x", MEMBER), sha256: sha(DESKTOP), zip_member: { zip_sha256: w.zipSha, path: MEMBER } };
    const base = JSON.parse(recordOf([{ path: w.zipPath, sha256: w.zipSha }, member]).toString("utf8")) as Record<string, unknown>;
    const owner_review = { selection_reasons: ["工程の順を読む順にした原本"], planned_direction: ["一日の時間軸で上から下へ読む & 来店情報を先に"], questions: ["この選定でよいか"] };
    const without = await inspectCaseStudy(Buffer.from(JSON.stringify(base)), { repo: w.repo });
    const withIt = await inspectCaseStudy(Buffer.from(JSON.stringify({ ...base, owner_review })), { repo: w.repo });
    const html = viewingPageHtml(withIt);
    expect(html).toContain("オーナーに見てほしいこと（記録と確認のため。画像の指示には入らない）");
    expect(html).toContain("<li>工程の順を読む順にした原本</li>");
    expect(html).toContain("一日の時間軸で上から下へ読む &amp; 来店情報を先に");
    expect(viewingPageHtml(without)).not.toContain("オーナーに見てほしいこと");
    // the prompt's input is the same with or without it (only the record's SHA-256 differs)
    const a = caseStudyUseOf(without).use;
    const b = caseStudyUseOf(withIt).use;
    expect({ ...b, sha256: a.sha256 }).toEqual(a);
    // unsafe text is refused like every other text of the record
    expect(await codeOf(inspectCaseStudy(Buffer.from(JSON.stringify({ ...base, owner_review: { ...owner_review, questions: ["<b>x</b>"] } })), { repo: w.repo }))).toBe("CASE_STUDY_TEXT_UNSAFE");
  });
});
