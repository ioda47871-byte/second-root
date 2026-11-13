import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { COPY_FACTS_NAME, priorName } from "@/lib/demo-version-package/copy";
import { importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { assertDemoContentFromFacts, canonicalJson, compCopyInput, LocalInputError, readCommittedFacts } from "@/lib/demo-version-package/local-inputs";
import { buildPackage, checkPackageCopy, PACKAGE_FORMAT_COPY, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { demoContentFromFacts, RIN_SHOP_ID, rinDemoContent, type FactsPack } from "@/lib/demo-version-package/seed-rin";
import { SENDABLE_FACTS_PATH, SENDABLE_PAGE_DIR, SENDABLE_SHOP_ID, sendableDemoContent, sendableSeedContent } from "@/lib/demo-version-package/seed-sendable";
import { isFictionalShop } from "@/lib/design-agent/quality-pipeline/copy-record";
import { reviewCopyQuality } from "@/lib/design-agent/quality-pipeline/copy-quality-review";
import { auditCompCopy, checkCompCopy, startCompCopyRevision } from "../../../scripts/design-artifact/comp-copy";

// DEV-263a (Issue #263): the fictional, photo-less sendable demo 環 (a copy of 輪's photo-less d1-v9 page with its own
// fictional facts), the v2 package of a comp with its copy (package-local.ts --copy) and the local facts path
// (import-local.ts --trusted-facts). No network, no model, no database (the import client is a stub), no browser.

const REPO = resolve(__dirname, "../../..");
const FACTS = join(REPO, SENDABLE_FACTS_PATH);
const PAGE = join(REPO, SENDABLE_PAGE_DIR);
const factsBytes = () => new Uint8Array(readFileSync(FACTS));
const pack = () => JSON.parse(readFileSync(FACTS, "utf8")) as FactsPack;
const tmp: string[] = [];
const tmpDir = (p = "sendable-") => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmp.push(d);
  return d;
};
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
const png = (w: number, h: number, c: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: c, g: 120, b: 160 } } }).png().toBuffer();
const renders = async () => ({ desktop_1440: new Uint8Array(await png(1440, 900, 90)), mobile_390: new Uint8Array(await png(390, 900, 91)) });
const pkgOfComp = async (dir: string, facts = FACTS) => {
  const c = compCopyInput(dir, facts);
  return buildPackage({ html: c.html, css: c.css, renders: await renders(), source: "test", copy: c.copy });
};
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof LocalInputError) return e.code;
    throw e;
  }
  return "no refusal";
};

/** A scratch copy of the fixture page (never written in the repository). */
const scratchPage = () => {
  const d = join(tmpDir(), "page");
  mkdirSync(d);
  for (const f of ["index.html", "style.css", "copy.json"]) cpSync(join(PAGE, f), join(d, f));
  return d;
};
/** The same page in the fictional research lane (the prose items creative_expression), for the full style audit. */
const toFictionalLane = (dir: string) => {
  const c = JSON.parse(readFileSync(join(dir, "copy.json"), "utf8"));
  c.lane = "quality_research_fictional";
  for (const i of c.items) if (i.claim_type === "proposal_pending_review") i.claim_type = "creative_expression";
  writeFileSync(join(dir, "copy.json"), `${JSON.stringify(c, null, 2)}\n`);
};

describe("the fixture: a fictional, photo-less page whose copy passes in both lanes", () => {
  it("is a fictional shop (id, 架空 name, example placeholders), not 輪", () => {
    const p = pack();
    expect(p.shop_id).toBe(SENDABLE_SHOP_ID);
    expect(isFictionalShop({ shopId: p.shop_id, facts: p.facts })).toBe(true);
    expect(p.facts.find((f) => f.key === "address")!.value.startsWith("架空市")).toBe(true);
    expect(p.facts.find((f) => f.key === "phone")!.value.startsWith("000-")).toBe(true);
    const html = readFileSync(join(PAGE, "index.html"), "utf8");
    expect(html.replace(/車輪/g, "")).not.toContain("輪");
    expect(html).not.toMatch(/<img|url\(|<script|<wbr|<br/i);
  });

  it("real_shop_proposal: the committed copy review is valid for these files and at owner review (only COPY_APPROVAL_MISSING)", () => {
    const g = checkCompCopy(PAGE, FACTS);
    expect(g).toMatchObject({ step: "owner_review", mayShowOwner: true, lane: "real_shop_proposal", round: 0, copyVerdict: "approve_candidate", sendBlockers: ["OWNER_APPROVAL_MISSING"] });
    const review = JSON.parse(readFileSync(join(PAGE, "copy-review.json"), "utf8"));
    expect(review.verdict).toBe("hold");
    expect(review.findings.map((f: { code: string }) => f.code)).toEqual(["COPY_APPROVAL_MISSING"]);
  });

  it("quality_research_fictional: the same page and prose audit to approve_candidate with no finding", () => {
    const d = scratchPage();
    toFictionalLane(d);
    const g = auditCompCopy(d, FACTS);
    expect(g).toMatchObject({ step: "owner_review", copyVerdict: "approve_candidate", findings: [] });
    const r = reviewCopyQuality({ factsPack: factsBytes(), copyRecord: readFileSync(join(d, "copy.json")), pageHtml: readFileSync(join(d, "index.html")), pageCss: readFileSync(join(d, "style.css")) });
    expect(r.verdict).toBe("approve_candidate");
  });

  it("the demo content is derived from the facts pack the same way as 輪's (one derivation)", () => {
    const rin = JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/bicycle/facts-pack.json"), "utf8")) as FactsPack;
    expect(rinDemoContent(rin)).toEqual(demoContentFromFacts(rin));
    expect(sendableDemoContent(pack())).toEqual(demoContentFromFacts(pack()));
    expect(() => sendableDemoContent(rin)).toThrow("FACTS_PACK_NOT_SENDABLE_SHOP");
  });
});

describe("package-local --copy: a v2 package of a comp with its copy", () => {
  it("the fixture packages as v2; with the facts from the facts path only the owner's decision is left", async () => {
    const pkg = await pkgOfComp(PAGE);
    expect(pkg.format).toBe(PACKAGE_FORMAT_COPY);
    expect(pkg.images).toEqual([]);
    expect(checkPackageCopy(pkg, { trustedFactsPack: factsBytes() })).toMatchObject({ status: "checked", lane: "real_shop_proposal", copy_verdict: "approve_candidate", facts_from_facts_path: true, send_blockers: ["OWNER_APPROVAL_MISSING"] });
    expect(checkPackageCopy(pkg).send_blockers).toEqual(["OWNER_APPROVAL_MISSING", "FACTS_NOT_FROM_FACTS_PATH"]);
  });

  it("carries the earlier rounds of the revision chain (copy-rounds/<i>/)", async () => {
    const d = scratchPage();
    toFictionalLane(d);
    const swap = (pairs: Array<[string, string]>) => {
      for (const f of ["copy.json", "index.html"]) {
        let s = readFileSync(join(d, f), "utf8");
        for (const [a, b] of pairs) {
          expect(s.includes(a), `${a} in ${f}`).toBe(true);
          s = s.split(f === "index.html" ? `>${a}</h2>` : `"${a}"`).join(f === "index.html" ? `>${b}</h2>` : `"${b}"`);
        }
        writeFileSync(join(d, f), s);
      }
    };
    const plain: Array<[string, string]> = [["修理のご案内", "スポークの先に、修理がある。"], ["修理の流れ", "どこを直すか、先に決める。"], ["空気の入れ方の講座", "空気を入れる日。"], ["店舗情報", "一周して、店先へ。"]];
    swap(plain);
    expect(auditCompCopy(d, FACTS).step).toBe("revise");
    startCompCopyRevision(d, FACTS);
    swap(plain.map(([a, b]) => [b, a]));
    expect(auditCompCopy(d, FACTS).step).toBe("owner_review");
    const pkg = await pkgOfComp(d);
    expect(pkg.copy!.files.map((f) => f.name)).toEqual(expect.arrayContaining([priorName(0, "copy.json"), priorName(0, "index.html"), priorName(0, "style.css"), priorName(0, "review.json"), COPY_FACTS_NAME]));
    expect(checkPackageCopy(pkg)).toMatchObject({ status: "checked", round: 1 });
  });

  it("refuses a comp without its copy record, copy review or facts pack, and malformed rounds", () => {
    const noReview = scratchPage();
    expect(code(() => compCopyInput(noReview, FACTS))).toBe("COPY_REVIEW_MISSING");
    const noRecord = scratchPage();
    cpSync(join(PAGE, "copy-review.json"), join(noRecord, "copy-review.json"));
    rmSync(join(noRecord, "copy.json"));
    expect(code(() => compCopyInput(noRecord, FACTS))).toBe("COPY_RECORD_MISSING");
    const noFacts = scratchPage();
    cpSync(join(PAGE, "copy-review.json"), join(noFacts, "copy-review.json"));
    expect(code(() => compCopyInput(noFacts, join(noFacts, "missing.json")))).toBe("FACTS_PACK_MISSING");
    mkdirSync(join(noFacts, "copy-rounds", "1"), { recursive: true });
    expect(code(() => compCopyInput(noFacts, FACTS))).toBe("COPY_ROUNDS_MALFORMED");
  });

  it("the CLI: --copy needs --facts (usage), and a comp without its review is refused before anything is rendered", () => {
    const out = join(tmpDir(), "pkg");
    const run = (args: string[]) => spawnSync("npx", ["tsx", join(REPO, "scripts/sales/demo-version/package-local.ts"), ...args], { cwd: REPO, encoding: "utf8", env: { ...process.env, PLAYWRIGHT_CHROMIUM_EXECUTABLE: "/nonexistent" } });
    expect(run(["--out", out, "--copy", PAGE]).status).toBe(2);
    expect(run(["--out", out, "--copy", PAGE, "--facts", FACTS, "--source", SENDABLE_PAGE_DIR]).status).toBe(2);
    const r = run(["--out", out, "--copy", scratchPage(), "--facts", FACTS]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ status: "FAIL", code: "COPY_REVIEW_MISSING" });
  }, 120_000);
});

describe("import-local --trusted-facts: the local facts path", () => {
  /** A scratch git repository with one committed facts pack. */
  const gitRepo = () => {
    const d = tmpDir("facts-repo-");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...a], { cwd: d, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(d, "facts.json"), readFileSync(FACTS));
    git("add", "facts.json");
    git("commit", "-q", "-m", "facts");
    // the remote-tracking develop as a clone would have it (nothing is fetched)
    git("update-ref", "refs/remotes/origin/develop", "HEAD");
    return { d, git };
  };

  it("reads only a committed, unmodified file inside the repository (no symbolic link)", () => {
    const { d } = gitRepo();
    expect(Buffer.from(readCommittedFacts(d, "facts.json")).equals(readFileSync(FACTS))).toBe(true);
    writeFileSync(join(d, "untracked.json"), readFileSync(FACTS));
    expect(code(() => readCommittedFacts(d, "untracked.json"))).toBe("TRUSTED_FACTS_NOT_COMMITTED");
    execFileSync("git", ["add", "untracked.json"], { cwd: d });
    expect(code(() => readCommittedFacts(d, "untracked.json"))).toBe("TRUSTED_FACTS_NOT_COMMITTED");
    writeFileSync(join(d, "facts.json"), `${readFileSync(FACTS, "utf8")} `);
    expect(code(() => readCommittedFacts(d, "facts.json"))).toBe("TRUSTED_FACTS_MODIFIED");
    const outside = join(tmpDir(), "facts.json");
    writeFileSync(outside, readFileSync(FACTS));
    expect(code(() => readCommittedFacts(d, outside))).toBe("TRUSTED_FACTS_OUTSIDE_REPO");
    expect(code(() => readCommittedFacts(d, "../facts.json"))).toBe("TRUSTED_FACTS_OUTSIDE_REPO");
    symlinkSync(outside, join(d, "link.json"));
    expect(code(() => readCommittedFacts(d, "link.json"))).toBe("TRUSTED_FACTS_SYMLINK");
    expect(code(() => readCommittedFacts(d, "missing.json"))).toBe("TRUSTED_FACTS_MISSING");
  });

  it("PR #266 M1: a pack committed only at the local HEAD (not the same blob on origin/develop) is refused", () => {
    const { d, git } = gitRepo();
    // a new pack committed on the local branch only
    writeFileSync(join(d, "head-only.json"), readFileSync(FACTS));
    git("add", "head-only.json");
    git("commit", "-q", "-m", "head only");
    expect(code(() => readCommittedFacts(d, "head-only.json"))).toBe("TRUSTED_FACTS_NOT_ON_DEVELOP");
    expect(Buffer.from(readCommittedFacts(d, "head-only.json", { requireBase: false })).equals(readFileSync(FACTS))).toBe(true);
    // the develop pack changed by a local commit (committed, unmodified on disk, but not develop's blob)
    writeFileSync(join(d, "facts.json"), `${readFileSync(FACTS, "utf8")}\n`);
    git("commit", "-q", "-am", "local edit");
    expect(code(() => readCommittedFacts(d, "facts.json"))).toBe("TRUSTED_FACTS_NOT_ON_DEVELOP");
    // no origin/develop at all
    git("update-ref", "-d", "refs/remotes/origin/develop");
    expect(code(() => readCommittedFacts(d, "facts.json"))).toBe("TRUSTED_FACTS_NOT_ON_DEVELOP");
  });

  it("the fixture's facts pack is committed at this repository's HEAD", () => {
    expect(Buffer.from(readCommittedFacts(REPO, SENDABLE_FACTS_PATH, { requireBase: false })).equals(readFileSync(FACTS))).toBe(true);
  });

  it("the demo content must be the content derived from the same facts pack bytes (key order aside)", () => {
    const content = sendableSeedContent(factsBytes());
    expect(content.facts_pack_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertDemoContentFromFacts(content, factsBytes())).not.toThrow();
    const reordered = JSON.parse(canonicalJson(content));
    expect(() => assertDemoContentFromFacts(reordered, factsBytes())).not.toThrow();
    expect(code(() => assertDemoContentFromFacts({ ...content, hours: "9:00〜18:00" }, factsBytes()))).toBe("TRUSTED_FACTS_CONTENT_MISMATCH");
    // without the sha (content derived the 輪 way only) it is refused
    expect(code(() => assertDemoContentFromFacts(sendableDemoContent(pack()), factsBytes()))).toBe("TRUSTED_FACTS_SHA_MISMATCH");
    expect(code(() => assertDemoContentFromFacts({ ...content, extra: 1 }, factsBytes()))).toBe("TRUSTED_FACTS_CONTENT_MISMATCH");
    const rin = readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/bicycle/facts-pack.json"));
    expect(code(() => assertDemoContentFromFacts(content, new Uint8Array(rin)))).toBe("TRUSTED_FACTS_SHA_MISMATCH");
    expect(code(() => assertDemoContentFromFacts(content, new TextEncoder().encode("{}")))).toBe("TRUSTED_FACTS_SHA_MISMATCH");
  });

  it("PR #266 M1: the whole pack is bound — an added fact (F17 創業50年) is refused, mapped or not", () => {
    const content = sendableSeedContent(factsBytes());
    const withFact = (key: string) => {
      const p = pack();
      p.facts.push({ id: "F17", key, value: "創業50年", source_id: "S1" } as FactsPack["facts"][number]);
      return new TextEncoder().encode(`${JSON.stringify(p, null, 2)}\n`);
    };
    // an unmapped key: the demo content would not carry it, so the derivation refuses it
    expect(code(() => sendableSeedContent(withFact("history")))).toBe("TRUSTED_FACTS_UNMAPPED_KEY");
    expect(code(() => assertDemoContentFromFacts({ ...content, facts_pack_sha256: createHash("sha256").update(withFact("history")).digest("hex") }, withFact("history")))).toBe("TRUSTED_FACTS_UNMAPPED_KEY");
    // a mapped key on the seeded demo: the sha no longer names the trusted bytes
    expect(code(() => assertDemoContentFromFacts(content, withFact("statement_3")))).toBe("TRUSTED_FACTS_SHA_MISMATCH");
    expect(code(() => assertDemoContentFromFacts(content, withFact("history")))).toBe("TRUSTED_FACTS_SHA_MISMATCH");
    // a key twice
    expect(code(() => sendableSeedContent(withFact("hours")))).toBe("TRUSTED_FACTS_DUPLICATE_KEY");
  });

  it("PR #266 L1: a 輪 demo is refused whatever the facts pack", () => {
    const rinBytes = new Uint8Array(readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/bicycle/facts-pack.json")));
    const rinContent = rinDemoContent(JSON.parse(new TextDecoder().decode(rinBytes)) as FactsPack);
    expect(rinContent.facts_pack).toBe(RIN_SHOP_ID);
    expect(code(() => assertDemoContentFromFacts(rinContent, rinBytes))).toBe("TRUSTED_FACTS_RIN_DEMO");
    expect(code(() => assertDemoContentFromFacts({ ...sendableSeedContent(factsBytes()), facts_pack: RIN_SHOP_ID }, factsBytes()))).toBe("TRUSTED_FACTS_RIN_DEMO");
  });

  it("the CLI refuses a facts pack outside the repository before any request", () => {
    const outside = join(tmpDir(), "facts.json");
    writeFileSync(outside, readFileSync(FACTS));
    const r = spawnSync("npx", ["tsx", join(REPO, "scripts/sales/demo-version/import-local.ts"), "--package", tmpDir(), "--seed-sendable", "--trusted-facts", outside], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_DB_URL: "" },
    });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ status: "FAIL", code: "TRUSTED_FACTS_OUTSIDE_REPO" });
    // the sendable shop is never imported without the facts path
    const u = spawnSync("npx", ["tsx", join(REPO, "scripts/sales/demo-version/import-local.ts"), "--package", tmpDir(), "--seed-sendable"], { cwd: REPO, encoding: "utf8" });
    expect(u.status).toBe(2);
  }, 120_000);

  it("import with the facts from the facts path: stored as from the facts path, the copy send block waits only on the owner", async () => {
    const pkg = await pkgOfComp(PAGE);
    const DEMO = "11111111-1111-4111-8111-111111111111";
    const VERSION = "22222222-2222-4222-8222-222222222222";
    const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = (p: DemoVersionPackage) =>
      ({
        from: (table: string) => ({
          select: () => {
            const q = {
              eq: () => q,
              in: () => q,
              order: async () => ({ data: [], error: null }),
              maybeSingle: async () => ({ data: table === "sales_demos" ? { prospect_id: "33333333-3333-4333-8333-333333333333", content: sendableSeedContent(factsBytes()) } : { id: VERSION, demo_id: DEMO, version_no: 1, storage_prefix: `v1/${DEMO}/${VERSION}/`, bundle_sha256: p.bundleSha256 }, error: null }),
            };
            return q;
          },
        }),
        rpc: async (name: string, args: Record<string, unknown>) => {
          rpcs.push({ name, args });
          return { data: { version_id: VERSION, replayed: false }, error: null };
        },
      }) as never;
    const objects = new Map<string, Uint8Array>();
    const store: PackageStore = { download: async (k) => objects.get(k) ?? null, upload: async (k, b) => void objects.set(k, b) };
    // what import-local.ts does with --trusted-facts: the committed bytes, the content check, then the import
    // (readCommittedFacts is tested above on a scratch repository: this branch's fixture is not on origin/develop yet)
    const trusted = factsBytes();
    assertDemoContentFromFacts(sendableSeedContent(factsBytes()), trusted);
    const res = await importPackage(pkg, { client: client(pkg), store, demoId: DEMO, trustedFactsPack: trusted });
    expect(res.copy).toMatchObject({ status: "checked", facts_from_facts_path: true, copy_verdict: "approve_candidate", send_blockers: ["OWNER_APPROVAL_MISSING"] });
    const recorded = rpcs.find((r) => r.name === "sales_record_copy_review")!;
    expect(recorded.args).toMatchObject({ p_facts_from_facts_path: true, p_gate_blockers: ["OWNER_APPROVAL_MISSING"], p_version_id: VERSION });
  });
});
