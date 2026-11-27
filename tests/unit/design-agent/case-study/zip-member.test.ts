import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { CaseStudyStop, inspectCaseStudy, ORIGINALS_INDEX_PATH, SUCCESS_MANIFEST_PATH, viewingPageHtml } from "@/lib/design-agent/case-study/case-study";
import { referencesJa } from "@/lib/design-agent/image-first/request-prompt";
import { caseStudyUseOf } from "@/lib/design-agent/imagefirst-worker/request";
import { colourPng } from "../phase2f/fixtures";
import { cleanupTemps, REPO, sha, tmp } from "../imagefirst-worker/support";

// DEV-364 (owner originals 2026-11-27): a member of a verified category-B ZIP counts as an ORIGINAL when it is bound by
// the ZIP's recorded SHA-256, its member path and its own SHA-256, and listed in the ZIP's own SHA256SUMS; such a member
// becomes a reference the prompt calls 原本. Previews never count. FICTIONAL data only: an invented ZIP whose SHA-256 is
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

/** A temporary repository whose index records `zipBytes`' SHA-256 for CP-033, and a private folder with the ZIP and its extracted members. */
function world(o: { members?: { name: string; data: Buffer }[]; sums?: Buffer | null } = {}) {
  const members = o.members ?? [{ name: MEMBER, data: DESKTOP }, { name: "site/PC_SP_overview.png", data: OVERVIEW }];
  const entries = o.sums === null ? members : [...members, { name: "SHA256SUMS", data: o.sums ?? sumsOf(members) }];
  const zipBytes = zip(entries);
  const repo = tmp("sr-zipm-repo-");
  mkdirSync(join(repo, "design-library/success-cases"), { recursive: true });
  const index = JSON.parse(readFileSync(resolve(REPO, ORIGINALS_INDEX_PATH), "utf8")) as { expected_sha256: Record<string, string[]> };
  index.expected_sha256["CP-033"] = [sha(zipBytes)];
  writeFileSync(join(repo, ORIGINALS_INDEX_PATH), JSON.stringify(index));
  writeFileSync(join(repo, SUCCESS_MANIFEST_PATH), readFileSync(resolve(REPO, SUCCESS_MANIFEST_PATH)));
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

describe("DEV-364 a verified member of a recorded category-B ZIP counts as an original", () => {
  it("bound by ZIP SHA-256 + member path + member SHA-256 and listed in SHA256SUMS: an original reference (原本); a preview member never counts", async () => {
    const w = world();
    const member = { path: join(w.priv, "x", MEMBER), sha256: sha(DESKTOP), zip_member: { zip_sha256: w.zipSha, path: MEMBER } };
    const overview = { path: join(w.priv, "x", "site/PC_SP_overview.png"), sha256: sha(OVERVIEW), zip_member: { zip_sha256: w.zipSha, path: "site/PC_SP_overview.png" } };
    const i = await inspectCaseStudy(recordOf([{ path: w.zipPath, sha256: w.zipSha }, overview, member]), { repo: w.repo });
    expect(i.counted).toEqual(["CP-033"]);
    expect(i.counting_files["CP-033"]).toEqual([{ path: w.zipPath, sha256: w.zipSha }, { path: member.path, sha256: member.sha256 }]);
    const refs = caseStudyUseOf(i).use.references;
    expect(refs).toEqual([{ id: "ref-1", case_id: "CP-033", name: "ref-1.png", sha256: sha(DESKTOP), media_type: "image/png" }]);
    expect(referencesJa(refs)).toBe("成功例の原本 1 枚");
  });

  it("without zip_member the listed image is evidence only (the case counts through its ZIP; no reference) — as before", async () => {
    const w = world();
    const i = await inspectCaseStudy(recordOf([{ path: w.zipPath, sha256: w.zipSha }, { path: join(w.priv, "x", MEMBER), sha256: sha(DESKTOP) }]), { repo: w.repo });
    expect(i.counted).toEqual(["CP-033"]);
    expect(i.counting_files["CP-033"]).toEqual([{ path: w.zipPath, sha256: w.zipSha }]);
    expect(caseStudyUseOf(i).use.references).toEqual([]);
  });

  it("refuses a claim the ZIP does not back (CASE_STUDY_ZIP_MEMBER_MISMATCH)", async () => {
    const member = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => ({ path: join(w.priv, "x", MEMBER), sha256: sha(DESKTOP), zip_member: { zip_sha256: w.zipSha, path: MEMBER, ...over } });
    const run = (w: ReturnType<typeof world>, files: Record<string, unknown>[], extra?: Record<string, unknown>, id?: string) => codeOf(inspectCaseStudy(recordOf(files, extra, id), { repo: w.repo }));
    const w = world();
    const zipFile = { path: w.zipPath, sha256: w.zipSha };
    // another member path, the ZIP not listed in the case, another ZIP SHA-256, an unsafe member path
    expect(await run(w, [zipFile, member(w, { path: "site/other.png" })])).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    expect(await run(w, [member(w)])).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    expect(await run(w, [zipFile, member(w, { zip_sha256: "e".repeat(64) })])).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    expect(await run(w, [zipFile, member(w, { path: "../desktop_1440_full.png" })])).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    // the extracted file is not the member's bytes (another picture under the same name)
    const other = world();
    writeFileSync(join(other.priv, "x", "fake.png"), colourPng(1440, 2401));
    expect(await run(other, [{ path: other.zipPath, sha256: other.zipSha }, { path: join(other.priv, "x", "fake.png"), sha256: sha(colourPng(1440, 2401)), zip_member: { zip_sha256: other.zipSha, path: MEMBER } }])).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    // no SHA256SUMS, a SHA256SUMS line that does not match, a SHA256SUMS without the member
    for (const sums of [null, Buffer.from(`${"f".repeat(64)}  ${MEMBER}\n`), Buffer.from(`${sha(OVERVIEW)}  site/PC_SP_overview.png\n`)]) {
      const v = world({ sums });
      expect(await run(v, [{ path: v.zipPath, sha256: v.zipSha }, member(v)]), String(sums)).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
    }
    // not a private_verified category-B case
    expect(await run(w, [zipFile, member(w)], {})).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
  });

  it("a ZIP whose SHA-256 is not recorded for the id never lends its members", async () => {
    const w = world();
    const index = JSON.parse(readFileSync(join(w.repo, ORIGINALS_INDEX_PATH), "utf8")) as { expected_sha256: Record<string, string[]> };
    index.expected_sha256["CP-033"] = ["d".repeat(64)];
    writeFileSync(join(w.repo, ORIGINALS_INDEX_PATH), JSON.stringify(index));
    const files = [{ path: w.zipPath, sha256: w.zipSha }, { path: join(w.priv, "x", MEMBER), sha256: sha(DESKTOP), zip_member: { zip_sha256: w.zipSha, path: MEMBER } }];
    expect(await codeOf(inspectCaseStudy(recordOf(files), { repo: w.repo }))).toBe("CASE_STUDY_ZIP_MEMBER_MISMATCH");
  });
});

describe("DEV-364 preview-like member names never count", () => {
  it("overview / comparison / before-after sheets, thumbnails and combined PC+SP sheets are verified but not counted", async () => {
    const names = ["site/PC_SP_FIRSTVIEW.png", "site/CP_SP_OVERVIEW.png", "site/first_view_comparison.png", "site/BEFORE_AFTER_PC.png", "site/MARTELLI_preview.png", "site/thumbs.png"];
    const members = names.map((name, n) => ({ name, data: colourPng(800 + n, 600) }));
    const w = world({ members });
    const files = [{ path: w.zipPath, sha256: w.zipSha }, ...members.map((m) => ({ path: join(w.priv, "x", m.name), sha256: sha(m.data), zip_member: { zip_sha256: w.zipSha, path: m.name } }))];
    const i = await inspectCaseStudy(recordOf(files), { repo: w.repo });
    expect(i.counting_files["CP-033"]).toEqual([{ path: w.zipPath, sha256: w.zipSha }]);
    expect(caseStudyUseOf(i).use.references).toEqual([]);
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
