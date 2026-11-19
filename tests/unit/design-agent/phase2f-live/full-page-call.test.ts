import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodexAbortedError } from "@/lib/design-agent/codex";
import { assembleRecord, readImageFirstRun } from "@/lib/design-agent/image-first/builder";
import { encodePng, type RgbImage } from "@/lib/design-agent/image-first/pixels";
import { buildPromptPlan, loadPromptInputs, type PromptInputs, type PromptPlan } from "@/lib/design-agent/image-first/prompt";
import { CODEX_STOP_CODES } from "@/lib/design-agent/image-first/record";
import { validateImageFirst } from "@/lib/design-agent/image-first/validate";
import { APPROVAL_PACKET_PATH, MAX_APPROVAL_WINDOW_MS, parseUtcInstant, readApprovalPacket, runFullPageCall, type FullPageBatch, type FullPageBatchResult, type FullPageCallInput } from "@/lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import type { CommitState } from "@/lib/design-agent/phase2f-live/steps";
import { fileAtCommit } from "@/scripts/design-artifact/phase2f-live-cli";

// Issue #293 P3 (preparation): the gated IMAGE_FIRST real-call step. The batch is a stub (an injected function): nothing
// here calls Codex, a model, the image tool, the network or a process. The ledger lives in a temporary directory.

const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const REPO = resolve(__dirname, "../../../..");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const COMMIT = "c".repeat(40);
const THREAD = "0193a7c2-1111-4222-8333-944455556666";
/**
 * A filled-in packet, built here in a temporary directory and never tracked (a tracked approved packet could be given to
 * the real entry). It reaches runFullPageCall only through the injected deps.packetAt, an in-process seam: the CLI's
 * packetAt is `git show <approved commit>:APPROVAL_PACKET_PATH`.
 */
const PACKET_TEXT = `# IMAGE_FIRST approval packet (test only)

**状態: 承認済み。** Built by full-page-call.test.ts in a temporary directory.

\`\`\`
## 10. a fenced example never counts
| 状態 | 未記入 |
\`\`\`

## 9. before

## 10. 承認欄（オーナーが記入する。**未記入 = 未承認**）

| 項目 | 値 |
|---|---|
| 状態（\`承認済み\` と書いて承認） | 承認済み |
| 承認する方向性（\`d1\` / \`d1,d3\`） | \`d1\` |
| d1 の承認 ID | \`test-imagefirst-d1-20261120-01\` |
| d3 の承認 ID（承認しないなら \`なし\`） | なし |
| 期限（UTC、\`YYYY-MM-DDTHH:MM:SSZ\`） | \`2026-11-20T12:00:00Z\` |
| 計画 ID | \`test-imagefirst-plan-01\` |
| 承認日・承認者 | 2026-11-20 test |

## 11. after
`;
const PACKET = (() => {
  const file = join(tmp("sr-if-packet-"), "packet.md");
  writeFileSync(file, PACKET_TEXT);
  return readFileSync(file);
})();
/** The real packet in the repository: an unapproved draft (§10 未記入). */
const REAL_PACKET = readFileSync(resolve(REPO, APPROVAL_PACKET_PATH));
const EXPIRES = "2026-11-20T12:00:00Z";
const NOW = Date.parse("2026-11-20T10:00:00+09:00");
/** The fixture packet with one §10 row's value replaced. */
const packetWith = (label: string, value: string) => {
  const text = PACKET.toString("utf8");
  const at = text.indexOf("## 10. 承認欄"); // the real §10 (not the fenced example above it)
  const re = new RegExp(`^(\\| ${label}[^|]*\\| ).*( \\|)$`, "m");
  expect(re.test(text.slice(at)), label).toBe(true);
  return Buffer.from(text.slice(0, at) + text.slice(at).replace(re, `$1${value}$2`));
};
const withPacket = (bytes: Buffer) => ({ packetBytes: bytes, expected: { packetSha256: sha(bytes) } });
/** What the stubbed packetAt returns for the next run (set by input()), and every (commit, path) it was asked for. */
let packetNext: Buffer | null = null;
let packetAsked: [string, string][] = [];

let cached: { plan: PromptPlan; inputs: PromptInputs } | null = null;
async function planD1() {
  cached ??= await (async () => {
    const inputs = await loadPromptInputs((p) => readFile(resolve(REPO, p)), "d1");
    return { plan: buildPromptPlan(inputs), inputs };
  })();
  return cached;
}

/** A synthetic picture (flat colours; PC: two columns of blocks, SP: one column of bars), never a real comp. */
function picture(kind: "pc" | "sp", seed: number): RgbImage {
  const width = 768;
  const height = 1152;
  const data = Buffer.alloc(width * height * 3);
  const base: [number, number, number] = kind === "pc" ? [20 + seed * 30, 40, 90] : [230, 200 - seed * 25, 150];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let c = base;
      if (kind === "pc" && x > width * 0.1 && x < width * 0.45 && Math.floor(y / 96) % 2 === 0) c = [240, 230, 210];
      if (kind === "pc" && x > width * 0.55 && x < width * 0.9 && Math.floor(y / 40) % 3 === 0) c = [250, 160, 60];
      if (kind === "sp" && x > width * 0.08 && x < width * (0.4 + (seed % 3) * 0.15) && Math.floor(y / 60) % 2 === 1) c = [30, 30, 30];
      data.set(c, (y * width + x) * 3);
    }
  return { width, height, data };
}

function okBatch(n = 6, over: Partial<FullPageBatchResult> = {}): FullPageBatchResult {
  const images = Array.from({ length: n }, (_, i) => {
    const img = picture(i < 2 ? "pc" : "sp", i);
    return { png: encodePng(img), width: img.width, height: img.height };
  });
  return { images, outcome: "IMAGE_SAVED", stopCode: null, imageCalls: n, imageFailed: 0, imageCallIds: images.map((_, i) => `ig_call_${i + 1}`), threadId: THREAD, cliVersion: "0.169.0", model: null, ...over };
}

function setup() {
  const state = tmp("sr-if-ledger-");
  const runs = tmp("sr-if-runs-");
  const calls: { prompt: string; maxImages: number }[] = [];
  const batchOf =
    (r: FullPageBatchResult | (() => Promise<FullPageBatchResult>)): FullPageBatch =>
    async (o) => {
      calls.push({ prompt: o.prompt, maxImages: o.maxImages });
      return typeof r === "function" ? r() : r;
    };
  packetAsked = [];
  return { state, runs, calls, batchOf, ledger: openLedger(state) };
}

/** `packetBytes` (test only): what the stubbed packetAt returns for this run (default: the approved test packet). */
async function input(s: ReturnType<typeof setup>, over: Partial<Omit<FullPageCallInput, "expected">> & { expected?: Partial<FullPageCallInput["expected"]>; packetBytes?: Buffer | null } = {}): Promise<FullPageCallInput> {
  const { plan, inputs } = await planD1();
  const { expected, packetBytes, ...rest } = over;
  packetNext = packetBytes === undefined ? PACKET : packetBytes;
  return {
    plan,
    inputs,
    packetPath: resolve(REPO, APPROVAL_PACKET_PATH),
    humanApprovalConfirmed: true,
    approvalId: "test-imagefirst-d1-20261120-01",
    planId: "test-imagefirst-plan-01",
    approvalExpires: EXPIRES,
    expected: { promptSha256: plan.batch.sha256, promptChars: plan.batch.chars, commit: COMMIT, planSha256: plan.plan_sha256, packetSha256: sha(PACKET), ...expected },
    outDir: join(s.runs, "run-1"),
    repoRoot: REPO,
    ...rest,
  };
}
const deps = (s: ReturnType<typeof setup>, batch: FullPageBatch, commit: CommitState = { head: COMMIT, base: COMMIT, clean: true }) => ({
  ledger: s.ledger,
  batch,
  commit: async () => commit,
  packetAt: async (c: string, p: string) => {
    packetAsked.push([c, p]);
    return packetNext;
  },
  preflight: async () => null,
  now: () => NOW,
});
const ledgerEntries = (s: ReturnType<typeof setup>) => (existsSync(join(s.state, "approvals")) ? readdirSync(join(s.state, "approvals")) : []);

describe("IMAGE_FIRST P3 real-call step: refused before the approval is used", () => {
  const cases: [string, (s: ReturnType<typeof setup>) => Promise<FullPageCallInput>, string, CommitState?][] = [
    ["the owner's flag is missing", (s) => input(s, { humanApprovalConfirmed: false }), "HUMAN_APPROVAL_REQUIRED"],
    ["the plan is not the approved one", (s) => input(s, { expected: { planSha256: "0".repeat(64) } }), "PLAN_PIN_MISMATCH"],
    ["the packet's bytes are not the approved ones", (s) => input(s, { packetBytes: Buffer.from("other packet") }), "PACKET_PIN_MISMATCH"],
    ["the packet is unreadable / untracked", (s) => input(s, { packetBytes: null }), "PACKET_PIN_MISMATCH"],
    ["the batch prompt SHA is not the approved one", (s) => input(s, { expected: { promptSha256: "0".repeat(64) } }), "PROMPT_PIN_MISMATCH"],
    ["the batch prompt length is not the approved one", async (s) => input(s, { expected: { promptChars: (await planD1()).plan.batch.chars + 1 } }), "PROMPT_PIN_MISMATCH"],
    ["the commit is not the approved one", (s) => input(s, { expected: { commit: "d".repeat(40) } }), "COMMIT_PIN_MISMATCH"],
    ["the tree is not clean", (s) => input(s), "COMMIT_PIN_MISMATCH", { head: COMMIT, base: COMMIT, clean: false }],
    ["the approval names the other direction", (s) => input(s, { approvalId: "test-imagefirst-d3-20261120-01" }), "APPROVAL_ID_DIRECTION_MISMATCH"],
    ["the approval id is not in the IMAGE_FIRST format", (s) => input(s, { approvalId: "phase2f-image-20261120-01" }), "APPROVAL_ID_DIRECTION_MISMATCH"],
    ["the approval is past its expiry", (s) => input(s, { approvalExpires: "2026-11-19T23:59:59Z" }), "APPROVAL_EXPIRED"],
    ["the expiry is not a date", (s) => input(s, { approvalExpires: "next week" }), "APPROVAL_EXPIRY_INVALID"],
    ["the expiry is a bare day (no explicit UTC instant)", (s) => input(s, { approvalExpires: "2026-11-20" }), "APPROVAL_EXPIRY_INVALID"],
    ["the expiry carries an offset instead of Z", (s) => input(s, { approvalExpires: "2026-11-20T21:00:00+09:00" }), "APPROVAL_EXPIRY_INVALID"],
    ["the expiry is an impossible date", (s) => input(s, { approvalExpires: "2026-11-31T12:00:00Z" }), "APPROVAL_EXPIRY_INVALID"],
    ["the expiry is more than 24 hours ahead", (s) => input(s, { approvalExpires: "2026-11-21T01:00:01Z" }), "APPROVAL_EXPIRY_TOO_FAR"],
    ["the expiry is years ahead", (s) => input(s, { approvalExpires: "9999-12-31T23:59:59Z" }), "APPROVAL_EXPIRY_TOO_FAR"],
    ["the packet path is a file under tests/", (s) => input(s, { packetPath: resolve(REPO, "tests/unit/design-agent/phase2f-live/full-page-call.test.ts") }), "PACKET_PATH_NOT_ALLOWED"],
    ["the packet path is another doc of the repository", (s) => input(s, { packetPath: resolve(REPO, "docs/design/image-first-handoff.md") }), "PACKET_PATH_NOT_ALLOWED"],
    [
      "the packet path is a copy of the packet outside the repository",
      (s) => {
        const file = join(tmp("sr-if-copy-"), "image-first-hoshigama-p3-packet.md");
        writeFileSync(file, PACKET);
        return input(s, { packetPath: file });
      },
      "PACKET_PATH_NOT_ALLOWED",
    ],
    ["the packet path does not exist", (s) => input(s, { packetPath: resolve(REPO, "docs/design/no-such-packet.md") }), "PACKET_PATH_NOT_ALLOWED"],
    ["the real packet in the repository is an unapproved draft (§10 未記入)", (s) => input(s, withPacket(REAL_PACKET)), "PACKET_NOT_APPROVED"],
    ["a §10 field is still 未記入", (s) => input(s, withPacket(packetWith("承認日・承認者", "未記入"))), "PACKET_NOT_APPROVED"],
    ["the packet's status is not 承認済み", (s) => input(s, withPacket(packetWith("状態", "未承認"))), "PACKET_NOT_APPROVED"],
    ["the packet has no §10", (s) => input(s, withPacket(Buffer.from("# packet\n\n## 9. after\n"))), "PACKET_NOT_APPROVED"],
    ["the packet names d3 approved but gives it no id", (s) => input(s, withPacket(packetWith("承認する方向性", "`d1,d3`"))), "PACKET_NOT_APPROVED"],
    ["the packet's approval id is not the one given", (s) => input(s, withPacket(packetWith("d1 の承認 ID", "`test-imagefirst-d1-20261120-02`"))), "PACKET_APPROVAL_MISMATCH"],
    ["the packet's expiry is not the one given", (s) => input(s, withPacket(packetWith("期限", "`2026-11-20T11:00:00Z`"))), "PACKET_APPROVAL_MISMATCH"],
    ["the packet's plan id is not the one given", (s) => input(s, withPacket(packetWith("計画 ID", "`test-imagefirst-plan-02`"))), "PACKET_APPROVAL_MISMATCH"],
    [
      "the packet does not approve this direction",
      async (s) => {
        const { plan } = await planD1();
        return input(s, { ...withPacket(PACKET), plan: { ...plan, direction_key: "d3" }, approvalId: "test-imagefirst-d3-20261120-01" });
      },
      "PACKET_APPROVAL_MISMATCH",
    ],
    ["the run directory is inside the repository", async (s) => input(s, { outDir: join(REPO, "tmp-if-run-never-created") }), "RUN_DIR_IN_REPO"],
    [
      "the run directory is inside the (given) repository root",
      async (s) => {
        const repo = tmp("sr-if-fake-repo-");
        mkdirSync(join(repo, "runs"));
        return input(s, { repoRoot: repo, outDir: join(repo, "runs", "x") });
      },
      "RUN_DIR_IN_REPO",
    ],
    [
      "the run directory already exists",
      async (s) => {
        mkdirSync(join(s.runs, "run-1"));
        return input(s);
      },
      "OUT_DIR_EXISTS",
    ],
    ["the run directory is relative", (s) => input(s, { outDir: "runs/x" }), "OUT_DIR_INVALID"],
    // the packet names the same malformed plan id, so the shared plan-id check is what refuses
    ["the plan id is malformed", (s) => input(s, { planId: "X", ...withPacket(packetWith("計画 ID", "X")) }), "PLAN_ID_INVALID"],
  ];

  it.each(cases.map(([name, make, code, commit]) => ({ name, make, code, commit })))("$name → $code; nothing is reserved, created or called", async ({ make, code, commit }) => {
    const s = setup();
    const i = await make(s);
    const r = await runFullPageCall(i, deps(s, s.batchOf(okBatch()), commit));
    expect(r).toEqual({ status: "stopped", code, stage: "precheck", aborted: false });
    expect(s.calls).toEqual([]);
    expect(ledgerEntries(s)).toEqual([]);
    expect(existsSync(join(s.runs, "run-1", "run-plan.json"))).toBe(false);
  });

  it("the preflight's stop refuses before the approval is used", async () => {
    const s = setup();
    const r = await runFullPageCall(await input(s), { ...deps(s, s.batchOf(okBatch())), preflight: async () => "CODEX_DOTENV_PRESENT" });
    expect(r).toMatchObject({ status: "stopped", code: "CODEX_DOTENV_PRESENT", stage: "precheck" });
    expect(s.calls).toEqual([]);
    expect(ledgerEntries(s)).toEqual([]);
  });

  it("a used approval is refused, and is never used twice", async () => {
    const s = setup();
    expect((await runFullPageCall(await input(s), deps(s, s.batchOf(okBatch())))).status).toBe("succeeded");
    const again = await runFullPageCall(await input(s, { outDir: join(s.runs, "run-2") }), deps(s, s.batchOf(okBatch())));
    expect(again).toMatchObject({ status: "stopped", code: "APPROVAL_ALREADY_USED", stage: "precheck" });
    expect(s.calls).toHaveLength(1);
  });
});

describe("IMAGE_FIRST P3 real-call step: the approval packet and its expiry are read strictly", () => {
  it("parseUtcInstant takes only a real UTC instant written YYYY-MM-DDTHH:MM:SSZ", () => {
    expect(parseUtcInstant("2026-11-20T12:00:00Z")).toBe(Date.UTC(2026, 10, 20, 12, 0, 0));
    expect(parseUtcInstant("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
    for (const bad of ["2026-02-31T12:00:00Z", "2027-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-11-20T24:00:00Z", "2026-11-20T12:60:00Z", "2026-11-20T12:00:60Z", "2026-11-20", "2026-11-20T12:00:00", "2026-11-20T12:00:00.000Z", "2026-11-20T21:00:00+09:00", " 2026-11-20T12:00:00Z", "next week"])
      expect(parseUtcInstant(bad), bad).toBeNull();
    expect(MAX_APPROVAL_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("the fixture packet reads as approved for d1 only; the real draft packet does not read", () => {
    expect(readApprovalPacket(PACKET)).toEqual({ status: "承認済み", directions: ["d1"], approvalIds: { d1: "test-imagefirst-d1-20261120-01", d3: "なし" }, expires: EXPIRES, planId: "test-imagefirst-plan-01", approvedBy: "2026-11-20 test" });
    expect(readApprovalPacket(REAL_PACKET)).toBeNull();
    // the commit is not a row of the packet (the packet is part of that commit): a packet that adds one is not read
    const withCommit = Buffer.from(PACKET.toString("utf8").replace("| 計画 ID |", `| 承認コミット | ${COMMIT} |\n| 計画 ID |`));
    expect(readApprovalPacket(withCommit)).toBeNull();
    // a repeated row is not read
    expect(readApprovalPacket(Buffer.from(PACKET.toString("utf8").replace("| 計画 ID |", "| 計画 ID | `x` |\n| 計画 ID |")))).toBeNull();
  });

  it("only one real §10 counts: a second §10 refuses, a filled fenced example never stands in for an unfilled §10", () => {
    const text = PACKET.toString("utf8");
    const section = text.slice(text.indexOf("## 10. 承認欄"), text.indexOf("## 11."));
    expect(readApprovalPacket(Buffer.from(`${text}\n${section}`))).toBeNull();
    const unfilled = section.replace("| 承認日・承認者 | 2026-11-20 test |", "| 承認日・承認者 | 未記入 |");
    expect(readApprovalPacket(Buffer.from(text.replace(section, unfilled)))).toBeNull();
    expect(readApprovalPacket(Buffer.from(text.replace("## 9. before", `\`\`\`\n${section}\`\`\`\n\n## 9. before`).replace(section + "## 11.", unfilled + "## 11.")))).toBeNull();
    // an unclosed fence refuses
    expect(readApprovalPacket(Buffer.from(`${text}\n\`\`\`\n`))).toBeNull();
  });

  it("the header must say 承認済み too: still 未承認, missing, or disagreeing with §10 refuses", () => {
    const text = PACKET.toString("utf8");
    expect(readApprovalPacket(Buffer.from(text.replace("**状態: 承認済み。**", "**状態: 未承認。**")))).toBeNull();
    expect(readApprovalPacket(Buffer.from(text.replace("**状態: 承認済み。**", "")))).toBeNull();
    expect(readApprovalPacket(Buffer.from(text.replace("# IMAGE_FIRST approval packet (test only)", "# IMAGE_FIRST approval packet（下書き・**未承認**）")))).toBeNull();
    expect(readApprovalPacket(Buffer.from(text.replace("**状態: 承認済み。**", "**状態: 承認済み。** 状態: 差し戻し")))).toBeNull();
  });

  it("the real packet, filled in exactly as its own §10 says, is accepted by the packet checks", () => {
    let text = REAL_PACKET.toString("utf8");
    const header = "**状態: 未承認。**";
    // the status line at the top (before the first section): the one the §10 notes say to rewrite
    expect(text.indexOf(header)).toBeGreaterThan(0);
    expect(text.indexOf(header)).toBeLessThan(text.indexOf("\n## "));
    text = text.replace(header, "**状態: 承認済み。**");
    const at = text.indexOf("## 10. 承認欄");
    let section = text.slice(at);
    const fill = (label: string, value: string) => {
      const re = new RegExp(`^(\\| ${label}(?:（[^|]*)? \\| ).*( \\|)$`, "m");
      expect(re.test(section), label).toBe(true);
      section = section.replace(re, `$1${value}$2`);
    };
    fill("状態", "`承認済み`");
    fill("承認する方向性", "`d1`");
    fill("d1 の承認 ID", "`hoshigama-imagefirst-d1-20261120-01`");
    fill("d3 の承認 ID", "`なし`");
    fill("期限", "`2026-11-20T09:00:00Z`");
    fill("計画 ID", "`hoshigama-imagefirst-p3-20261120`");
    fill("承認日・承認者", "2026-11-20 owner");
    expect(readApprovalPacket(Buffer.from(text.slice(0, at) + section))).toEqual({ status: "承認済み", directions: ["d1"], approvalIds: { d1: "hoshigama-imagefirst-d1-20261120-01", d3: "なし" }, expires: "2026-11-20T09:00:00Z", planId: "hoshigama-imagefirst-p3-20261120", approvedBy: "2026-11-20 owner" });
  });

  it("the packet is read only after the commit pin and the clean-tree check, as committed at the approved commit", async () => {
    const s = setup();
    expect(await runFullPageCall(await input(s), deps(s, s.batchOf(okBatch()), { head: COMMIT, base: COMMIT, clean: false }))).toMatchObject({ code: "COMMIT_PIN_MISMATCH" });
    expect(await runFullPageCall(await input(s), deps(s, s.batchOf(okBatch()), { head: "d".repeat(40), base: COMMIT, clean: true }))).toMatchObject({ code: "COMMIT_PIN_MISMATCH" });
    expect(packetAsked).toEqual([]);
    expect((await runFullPageCall(await input(s), deps(s, s.batchOf(okBatch())))).status).toBe("succeeded");
    expect(packetAsked).toEqual([[COMMIT, APPROVAL_PACKET_PATH]]);
  });

  it("fileAtCommit reads the committed bytes, never the working tree's", async () => {
    const repo = tmp("sr-if-git-");
    const git = (...a: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
      expect(r.status, a.join(" ")).toBe(0);
      return r.stdout.trim();
    };
    git("init", "-q");
    mkdirSync(join(repo, "docs/design"), { recursive: true });
    writeFileSync(join(repo, APPROVAL_PACKET_PATH), "committed 状態\n");
    git("add", ".");
    git("commit", "-q", "-m", "packet");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(repo, APPROVAL_PACKET_PATH), "working tree, not committed\n");
    expect(await fileAtCommit(head, APPROVAL_PACKET_PATH, repo)).toEqual(Buffer.from("committed 状態\n"));
    expect(await fileAtCommit("HEAD", APPROVAL_PACKET_PATH, repo)).toBeNull();
    expect(await fileAtCommit(head, "../x", repo)).toBeNull();
    expect(await fileAtCommit(head, "docs/design/missing.md", repo)).toBeNull();
  });

  it("the CLI never reads the packet from the working tree: its bytes come only from fileAtCommit", () => {
    const cli = readFileSync(resolve(REPO, "scripts/design-artifact/image-first-generate.ts"), "utf8");
    expect(cli).toMatch(/const packet = resolve\(args\.get\("--packet"\)!\);/);
    expect(cli).toMatch(/packetPath: packet,/);
    expect(cli).toMatch(/packetAt: \(commit, rel\) => fileAtCommit\(commit, rel\),/);
    expect(cli).not.toMatch(/readFile\(packet|packetBytes|trackedInRepo/);
    expect(APPROVAL_PACKET_PATH).toBe("docs/design/image-first-hoshigama-p3-packet.md");
    expect(existsSync(resolve(REPO, "tests/unit/design-agent/phase2f-live/fixtures"))).toBe(false);
  });

  it("an expiry exactly 24 hours ahead is accepted (the cap is inclusive)", async () => {
    const s = setup();
    const expires = new Date(NOW + MAX_APPROVAL_WINDOW_MS).toISOString().replace(".000Z", "Z");
    const i = await input(s, { approvalExpires: expires, ...withPacket(packetWith("期限", `\`${expires}\``)) });
    expect((await runFullPageCall(i, deps(s, s.batchOf(okBatch())))).status).toBe("succeeded");
  });
});

describe("IMAGE_FIRST P3 real-call step: the first failure ends the run (no retry, the approval stays used)", () => {
  it.each(CODEX_STOP_CODES.map((c) => [c]))("a batch stopped with %s writes no run plan and records the stop", async (code) => {
    const s = setup();
    const i = await input(s);
    const r = await runFullPageCall(i, deps(s, s.batchOf(okBatch(2, { stopCode: code, outcome: "TOOL_FAILED", imageFailed: 1, imageCalls: 3 }))));
    expect(r).toEqual({ status: "stopped", code, stage: "call", aborted: false, outcome: "TOOL_FAILED" });
    expect(s.calls).toHaveLength(1);
    expect(existsSync(join(i.outDir, "run-plan.json"))).toBe(false);
    expect(readdirSync(join(i.outDir, "parts"))).toEqual([]);
    expect(readdirSync(join(i.outDir, "stopped")).sort()).toEqual(["image-1.png", "image-2.png"]);
    const call = JSON.parse(readFileSync(join(i.outDir, "call.json"), "utf8")) as { status: string; code: string };
    expect([call.status, call.code]).toEqual(["failed", code]);
    expect(await s.ledger.get(i.approvalId)).toMatchObject({ receipt: { kind: "full_page_comp", route: "image_first", slot: "first-1" }, result: { status: "failed", code } });
    // the approval is used: the same id never runs again
    expect(await runFullPageCall(await input(s, { outDir: join(s.runs, "run-2") }), deps(s, s.batchOf(okBatch())))).toMatchObject({ code: "APPROVAL_ALREADY_USED" });
    expect(s.calls).toHaveLength(1);
  });

  it("fewer pictures than planned, with no stop code, is CODEX_IMAGE_COUNT_MISMATCH", async () => {
    const s = setup();
    const i = await input(s);
    expect(await runFullPageCall(i, deps(s, s.batchOf(okBatch(5))))).toMatchObject({ status: "stopped", code: "CODEX_IMAGE_COUNT_MISMATCH", stage: "call" });
    expect(existsSync(join(i.outDir, "run-plan.json"))).toBe(false);
  });

  it("an aborted call is recorded as aborted", async () => {
    const s = setup();
    const i = await input(s);
    const r = await runFullPageCall(
      i,
      deps(
        s,
        s.batchOf(async () => {
          throw new CodexAbortedError();
        }),
      ),
    );
    expect(r).toEqual({ status: "stopped", code: "CODEX_ABORTED", stage: "call", aborted: true });
    expect(await s.ledger.get(i.approvalId)).toMatchObject({ result: { status: "aborted", code: "CODEX_ABORTED" } });
  });

  it("a batch that returns after the stop signal is aborted; its pictures are kept under stopped/, never as parts", async () => {
    const s = setup();
    const controller = new AbortController();
    const i = await input(s, { signal: controller.signal });
    const r = await runFullPageCall(
      i,
      deps(
        s,
        s.batchOf(async () => {
          controller.abort();
          return okBatch();
        }),
      ),
    );
    expect(r).toEqual({ status: "stopped", code: "CODEX_ABORTED", stage: "call", aborted: true });
    expect(existsSync(join(i.outDir, "run-plan.json"))).toBe(false);
    expect(readdirSync(join(i.outDir, "parts"))).toEqual([]);
    expect(readdirSync(join(i.outDir, "stopped")).sort()).toEqual(["image-1.png", "image-2.png", "image-3.png", "image-4.png", "image-5.png", "image-6.png"]);
    const call = JSON.parse(readFileSync(join(i.outDir, "call.json"), "utf8")) as { status: string; code: string; images: number; stopped: unknown[] };
    expect([call.status, call.code, call.images, call.stopped.length]).toEqual(["aborted", "CODEX_ABORTED", 6, 6]);
    expect(await s.ledger.get(i.approvalId)).toMatchObject({ result: { status: "aborted", code: "CODEX_ABORTED" } });
  });
});

describe("IMAGE_FIRST P3 real-call step: one stubbed success reaches AWAITING_OWNER_EVALUATION", () => {
  it("writes the private run in the Phase 2 builder's shape; assembled and validated it awaits the owner", async () => {
    const s = setup();
    const i = await input(s);
    const { plan, inputs } = await planD1();
    const r = await runFullPageCall(i, deps(s, s.batchOf(okBatch())));
    expect(r).toMatchObject({ status: "succeeded", images: 6, warnings: ["session_model_unknown"] });
    expect(s.calls).toEqual([{ prompt: plan.batch.prompt, maxImages: 6 }]);
    expect(await s.ledger.get(i.approvalId)).toMatchObject({ receipt: { kind: "full_page_comp", route: "image_first", prompt_sha256: plan.batch.sha256, commit: COMMIT }, result: { status: "succeeded" } });
    expect(readFileSync(join(i.outDir, "facts-pack.json"))).toEqual(inputs.factsBytes);
    expect(readFileSync(join(i.outDir, "direction.json"))).toEqual(inputs.directionBytes);
    expect(readFileSync(join(i.outDir, "prompts", "batch.txt"), "utf8")).toBe(plan.batch.prompt);

    // offline, as the owner would: --assemble, then the located read and the identity audits, then --run
    const built = await assembleRecord(i.outDir);
    expect(built.problems).toEqual([]);
    const record = built.record!;
    expect(record.generation).toMatchObject({ approval_ids: [i.approvalId], approval_packet_sha256: sha(PACKET), plan_id: i.planId, repo_commit: COMMIT, image_model: null, stop_code: null });
    const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(i.outDir, "manifest.json"), recordBytes);
    const name = plan.shop.display_name;
    const hours = inputs.facts.facts.find((f) => f.key === "hours")!.value;
    const parts = (["desktop_1440", "mobile_390"] as const).flatMap((v) => record.viewports[v]!.parts.map((p, n, all) => ({ p, first: n === 0, last: n === all.length - 1 })));
    writeFileSync(
      join(i.outDir, "visual-read.json"),
      JSON.stringify({
        schema: "image_first_visual_read_v0",
        run_id: record.run_id,
        method: "assistant_visual",
        parts: parts.map(({ p, first, last }) => ({
          inspected_sha256: p.png_sha256,
          observed_section_ids: p.sections.map((x) => x.id),
          header_visible: first,
          footer_visible: last,
          web_structure: { nav: first, text_blocks: true, info_block: last },
          photo_only: false,
          looks_like_browser_screenshot: false,
          visible_texts: first ? [{ text: name, kind: "shop_name" }] : last ? [{ text: "営業時間", kind: "ui_label" }, { text: hours, kind: "fact" }] : [],
          note: "synthetic stub picture (test only)",
        })),
        sp_independent: { judged: true, note: "synthetic stub (test only)" },
      }),
    );
    writeFileSync(
      join(i.outDir, "identity.json"),
      JSON.stringify({
        schema: "image_first_identity_v0",
        run_id: record.run_id,
        audits: parts.map(({ p }) => ({
          schema_version: 1,
          case_id: "CP-901",
          attempt_id: "stub",
          target: { official_name: name, allowed_aliases: [], category_code: plan.shop.category_code, official_source_url: "https://example.com/fictional-bakery" },
          prompt: { shop_name: name, category_code: plan.shop.category_code, is_research_only: true },
          output: { image_sha256: p.png_sha256 },
          visual_inspection: { status: "completed", method: "assistant_visual", inspected_image_sha256: p.png_sha256, reviewer_note: "stub", visible_site_identity_labels: [name], category_code: plan.shop.category_code, unreadable_site_identity: false, image_looks_like_unrelated_shop: false },
        })),
      }),
    );
    const verdict = validateImageFirst(await readImageFirstRun(i.outDir));
    expect(verdict.rejects).toEqual([]);
    expect(verdict.status).toBe("AWAITING_OWNER_EVALUATION");
    expect(verdict.warnings).toEqual(["IMAGE_MODEL_UNKNOWN", "SESSION_MODEL_UNKNOWN"]);
    expect(verdict.parts).toHaveLength(6);
  }, 60_000);
});
