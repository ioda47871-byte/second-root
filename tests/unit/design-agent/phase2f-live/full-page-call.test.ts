import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodexAbortedError } from "@/lib/design-agent/codex";
import { ANSWER_TEXT_CODES, CODE_MODE_ARG_ERROR_KINDS, IMAGE_FAILURE_REASONS, TOOL_MODES } from "@/lib/design-agent/design-image/capability";
import { assembleRecord, readImageFirstRun } from "@/lib/design-agent/image-first/builder";
import { encodePng, type RgbImage } from "@/lib/design-agent/image-first/pixels";
import { buildPromptPlan, loadPromptInputs, type PromptInputs, type PromptPlan } from "@/lib/design-agent/image-first/prompt";
import { CODEX_STOP_CODES } from "@/lib/design-agent/image-first/record";
import { validateImageFirst } from "@/lib/design-agent/image-first/validate";
import { APPROVAL_PACKET_PATH, D4_PACKET, DIAGNOSTIC_ANSWERS, DIAGNOSTIC_ARG_ERROR_KINDS, DIAGNOSTIC_FAILURE_REASONS, DIAGNOSTIC_TOOL_MODES, MAX_APPROVAL_WINDOW_MS, P3_PACKET, PACKET_FIELDS, packetFieldsOf, packetOfDirection, parseUtcInstant, readApprovalPacket, runFullPageCall, type FullPageBatch, type FullPageBatchResult, type FullPageCallInput } from "@/lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import type { CommitState } from "@/lib/design-agent/phase2f-live/steps";
import { fileAtCommit } from "@/scripts/design-artifact/phase2f-live-cli";
import { UNAPPROVED_D4_PACKET_FIXTURE, UNAPPROVED_D4_PACKET_FIXTURE_SHA256, UNAPPROVED_PACKET_FIXTURE, UNAPPROVED_PACKET_FIXTURE_SHA256 } from "../image-first/fixtures/unapproved-packet";

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
/** The real packet in the repository: the draft, or the owner's filled-in version. Only state-independent checks use it. */
const REAL_PACKET = readFileSync(resolve(REPO, APPROVAL_PACKET_PATH));
/** The unapproved draft as a test-only immutable copy (header 未承認, §10 未記入); pinned by its SHA-256 below. */
const UNAPPROVED_PACKET = readFileSync(UNAPPROVED_PACKET_FIXTURE);
/**
 * The unapproved fixture filled in memory exactly as its own §10 says: the header status line rewritten, every §10 row
 * given a value. Never written to the repository.
 */
const fillUnapproved = (values: Record<keyof typeof PACKET_FIELDS, string>) => {
  let text = UNAPPROVED_PACKET.toString("utf8");
  const header = "**状態: 未承認。**";
  // the status line at the top (before the first section): the one the §10 notes say to rewrite
  expect(text.indexOf(header)).toBeGreaterThan(0);
  expect(text.indexOf(header)).toBeLessThan(text.indexOf("\n## "));
  text = text.replace(header, "**状態: 承認済み。**");
  const at = text.indexOf("## 10. 承認欄");
  let section = text.slice(at);
  for (const [k, label] of Object.entries(PACKET_FIELDS) as [keyof typeof PACKET_FIELDS, string][]) {
    const re = new RegExp(`^(\\| ${label}(?:（[^|]*)? \\| ).*( \\|)$`, "m");
    expect(re.test(section), label).toBe(true);
    section = section.replace(re, `$1${values[k]}$2`);
  }
  return Buffer.from(text.slice(0, at) + section);
};
const D3_ONLY = { status: "`承認済み`", directions: "`d3`", d1: "`なし`", d3: "`hoshigama-imagefirst-d3-20261120-01`", expires: "`2026-11-20T09:00:00Z`", planId: "`hoshigama-imagefirst-p3-20261120`", approvedBy: "2026-11-20 owner" };
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

let cachedD3: { plan: PromptPlan; inputs: PromptInputs } | null = null;
async function planD3() {
  cachedD3 ??= await (async () => {
    const inputs = await loadPromptInputs((p) => readFile(resolve(REPO, p)), "d3");
    return { plan: buildPromptPlan(inputs), inputs };
  })();
  return cachedD3;
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
    ["the unapproved draft packet (test fixture: header 未承認, §10 未記入)", (s) => input(s, withPacket(UNAPPROVED_PACKET)), "PACKET_NOT_APPROVED"],
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

  it("the fixture packet reads as approved for d1 only; the unapproved draft fixture does not read", () => {
    expect(readApprovalPacket(PACKET)).toEqual({ status: "承認済み", directions: ["d1"], approvalIds: { d1: "test-imagefirst-d1-20261120-01", d3: "なし" }, expires: EXPIRES, planId: "test-imagefirst-plan-01", approvedBy: "2026-11-20 test" });
    expect(readApprovalPacket(UNAPPROVED_PACKET)).toBeNull();
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

  it("the unapproved fixture is the immutable draft copy (pinned by its bytes) and no packet under tests/ reads as approved", () => {
    expect(sha(UNAPPROVED_PACKET)).toBe(UNAPPROVED_PACKET_FIXTURE_SHA256);
    const text = UNAPPROVED_PACKET.toString("utf8");
    expect(text.slice(0, text.indexOf("\n## "))).toContain("**状態: 未承認。**");
    expect(readApprovalPacket(UNAPPROVED_PACKET)).toBeNull();
    // a tracked approved packet could be given to the real entry: none may exist under tests/
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "__screenshots__" ? [] : walk(join(dir, e.name))) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));
    for (const f of walk(resolve(REPO, "tests"))) expect(readApprovalPacket(readFileSync(f)), f).toBeNull();
  });

  it("the unapproved fixture, filled in exactly as its own §10 says, is accepted by the packet checks", () => {
    const filled = fillUnapproved({ status: "`承認済み`", directions: "`d1`", d1: "`hoshigama-imagefirst-d1-20261120-01`", d3: "`なし`", expires: "`2026-11-20T09:00:00Z`", planId: "`hoshigama-imagefirst-p3-20261120`", approvedBy: "2026-11-20 owner" });
    expect(readApprovalPacket(filled)).toEqual({ status: "承認済み", directions: ["d1"], approvalIds: { d1: "hoshigama-imagefirst-d1-20261120-01", d3: "なし" }, expires: "2026-11-20T09:00:00Z", planId: "hoshigama-imagefirst-p3-20261120", approvedBy: "2026-11-20 owner" });
  });
  it("the unapproved fixture, filled for d3 alone with d1 ID なし, is accepted and invalid directions are rejected", () => {
    const filled = fillUnapproved(D3_ONLY);
    expect(readApprovalPacket(filled)).toEqual({ status: "承認済み", directions: ["d3"], approvalIds: { d1: "なし", d3: "hoshigama-imagefirst-d3-20261120-01" }, expires: "2026-11-20T09:00:00Z", planId: "hoshigama-imagefirst-p3-20261120", approvedBy: "2026-11-20 owner" });
    const approved = filled.toString("utf8");
    const section = approved.slice(approved.indexOf("## 10. 承認欄"));
    const directionLine = section.split("\n").find((line) => line.startsWith("| 承認する方向性（"));
    const d1Line = section.split("\n").find((line) => line.startsWith("| d1 の承認 ID（"));
    expect(directionLine).toBeDefined();
    expect(d1Line).toBeDefined();
    for (const invalid of ["d2", "d3,d3", "d3,d1", "d1,d3,d3", ""]) {
      const changed = directionLine!.replace(" | `d3` |", ` | \`${invalid}\` |`);
      expect(changed).not.toBe(directionLine);
      expect(readApprovalPacket(Buffer.from(approved.replace(directionLine!, changed)))).toBeNull();
    }
    const badD1 = d1Line!.replace(" | `なし` |", " | `hoshigama-imagefirst-d1-20261120-01` |");
    expect(badD1).not.toBe(d1Line);
    expect(readApprovalPacket(Buffer.from(approved.replace(d1Line!, badD1)))).toBeNull();
  });

  it("the d3-only filled fixture runs a d3 plan once (stub batch) and refuses a d1 run", async () => {
    const filled = fillUnapproved(D3_ONLY);
    const { plan, inputs } = await planD3();
    const d3 = { plan, inputs, approvalId: "hoshigama-imagefirst-d3-20261120-01", planId: "hoshigama-imagefirst-p3-20261120", approvalExpires: "2026-11-20T09:00:00Z" };
    const d3Expected = { promptSha256: plan.batch.sha256, promptChars: plan.batch.chars, planSha256: plan.plan_sha256, packetSha256: sha(filled) };
    // d1 against the d3-only packet is refused before anything is used
    const s1 = setup();
    const d1 = await input(s1, { ...withPacket(filled), approvalId: "hoshigama-imagefirst-d1-20261120-01", planId: d3.planId, approvalExpires: d3.approvalExpires });
    expect(await runFullPageCall(d1, deps(s1, s1.batchOf(okBatch())))).toEqual({ status: "stopped", code: "PACKET_APPROVAL_MISMATCH", stage: "precheck", aborted: false });
    expect(s1.calls).toEqual([]);
    expect(ledgerEntries(s1)).toEqual([]);
    // the d3 run with the packet's values succeeds once; the same approval never runs again
    const s = setup();
    const ok = await runFullPageCall(await input(s, { ...d3, packetBytes: filled, expected: d3Expected }), deps(s, s.batchOf(okBatch())));
    expect(ok).toMatchObject({ status: "succeeded", images: 6 });
    expect(s.calls).toEqual([{ prompt: plan.batch.prompt, maxImages: 6 }]);
    const again = await runFullPageCall(await input(s, { ...d3, packetBytes: filled, expected: d3Expected, outDir: join(s.runs, "run-2") }), deps(s, s.batchOf(okBatch())));
    expect(again).toMatchObject({ status: "stopped", code: "APPROVAL_ALREADY_USED", stage: "precheck" });
    expect(s.calls).toHaveLength(1);
  });

  it("the real packet holds the state-independent invariants: draft, or approved for d3 alone with d1 なし", () => {
    const text = REAL_PACKET.toString("utf8");
    // lines outside code fences
    const lines: string[] = [];
    let fence = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
      else if (!fence) lines.push(line);
    }
    expect(fence).toBe(false);
    const starts = lines.flatMap((l, n) => (/^## 10\.\s/.test(l) ? [n] : []));
    expect(starts).toHaveLength(1);
    const rest = lines.slice(starts[0]! + 1);
    const stop = rest.findIndex((l) => /^#{1,2} /.test(l));
    const rows = (stop < 0 ? rest : rest.slice(0, stop))
      .filter((l) => l.startsWith("|"))
      .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
      .filter((c) => c.length === 2 && !/^-+$/.test(c[0]!) && c[0] !== "項目");
    const labelOf = (c: string[]) => c[0]!.split("（")[0]!.trim();
    // every §10 row present exactly once, and nothing else
    expect(rows.map(labelOf).sort()).toEqual(Object.values(PACKET_FIELDS).sort());
    const row = (label: string) => rows.find((c) => labelOf(c) === label)![1]!;
    const firstH2 = lines.findIndex((l) => /^## /.test(l));
    const header = [...lines.slice(0, firstH2).join("\n").matchAll(/\*\*状態[:：]\s*([^。*\s]+)。?\*\*/g)].map((m) => m[1]);
    expect(header).toHaveLength(1);
    const status = row(PACKET_FIELDS.status).replace(/^`([^`]*)`$/, "$1");
    if (header[0] === "承認済み") {
      expect(status).toBe("承認済み");
      // the only experiment the owner approved: d3 alone, d1 なし
      const read = readApprovalPacket(REAL_PACKET);
      expect(read).not.toBeNull();
      expect(read!.directions).toEqual(["d3"]);
      expect(read!.approvalIds.d1).toBe("なし");
    } else {
      expect(header[0]).toBe("未承認");
      expect(status).toBe("未記入");
      for (const label of Object.values(PACKET_FIELDS)) expect(row(label), label).toContain("未記入");
      expect(readApprovalPacket(REAL_PACKET)).toBeNull();
    }
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

  it("Issue #335: a stopped call.json carries the run's fixed diagnostics (counts, booleans, codes, slugs), never a text", async () => {
    const s = setup();
    const i = await input(s);
    const diagnostics = { exec_cells: 1, cell_named_image_tool: true, arg_error: true, arg_error_kind: "REF_PATHS_TOO_MANY", other_tool_calls: 0, tool_mode: "unknown", model: "gpt-6.1-terra", cli_version: "0.159.0", image_failure_reasons: [], answer: "TEXT_OTHER" };
    const r = await runFullPageCall(i, deps(s, s.batchOf(okBatch(0, { stopCode: "CODEX_IMAGE_ARGS_REFUSED", outcome: "TOOL_REFUSED_ARGS", imageCalls: 0, diagnostics }))));
    expect(r).toEqual({ status: "stopped", code: "CODEX_IMAGE_ARGS_REFUSED", stage: "call", aborted: false, outcome: "TOOL_REFUSED_ARGS" });
    const call = JSON.parse(readFileSync(join(i.outDir, "call.json"), "utf8")) as Record<string, unknown>;
    expect(call).toMatchObject({ status: "failed", code: "CODEX_IMAGE_ARGS_REFUSED", outcome: "TOOL_REFUSED_ARGS", image_calls: 0, diagnostics });
    // a field that is not a fixed value is dropped to null, never written
    const s2 = setup();
    const i2 = await input(s2);
    const odd = { ...diagnostics, model: "free text with spaces", answer: "a sentence.", arg_error_kind: "x y", exec_cells: -1, image_failure_reasons: ["OTHER", "not a code"] };
    await runFullPageCall(i2, deps(s2, s2.batchOf(okBatch(0, { stopCode: "CODEX_NO_IMAGE", outcome: "TOOL_NOT_SEEN_CODE_MODE", imageCalls: 0, diagnostics: odd }))));
    const call2 = JSON.parse(readFileSync(join(i2.outDir, "call.json"), "utf8")) as { diagnostics: Record<string, unknown> };
    expect(call2.diagnostics).toMatchObject({ model: null, answer: null, arg_error_kind: null, exec_cells: null, image_failure_reasons: ["OTHER"] });
    // Issue #335 follow-up: a code-shaped word outside the fixed lists is null too (tool_mode, answer, arg_error_kind, reasons)
    const s4 = setup();
    const i4 = await input(s4);
    const unknownCodes = { ...diagnostics, tool_mode: "turbo_mode", answer: "TEXT_SECRET", arg_error_kind: "REF_SOMETHING_NEW", image_failure_reasons: ["HTTP_5XX", "MADE_UP_REASON", "NO_TEXT"] };
    await runFullPageCall(i4, deps(s4, s4.batchOf(okBatch(0, { stopCode: "CODEX_IMAGE_ARGS_REFUSED", outcome: "TOOL_REFUSED_ARGS", imageCalls: 0, diagnostics: unknownCodes }))));
    const call4 = JSON.parse(readFileSync(join(i4.outDir, "call.json"), "utf8")) as { diagnostics: Record<string, unknown> };
    expect(call4.diagnostics).toMatchObject({ tool_mode: null, answer: null, arg_error_kind: null, image_failure_reasons: ["HTTP_5XX", "NO_TEXT"], exec_cells: 1, model: "gpt-6.1-terra" });
    // every value of each fixed list passes through unchanged
    for (const [k, v] of [["tool_mode", "code_mode_only"], ["answer", "TEXT_TOOL_UNAVAILABLE"], ["arg_error_kind", "ARGS_PARSE"]] as const) {
      const s5 = setup();
      const i5 = await input(s5);
      await runFullPageCall(i5, deps(s5, s5.batchOf(okBatch(0, { stopCode: "CODEX_IMAGE_ARGS_REFUSED", outcome: "TOOL_REFUSED_ARGS", imageCalls: 0, diagnostics: { ...diagnostics, [k]: v } }))));
      expect((JSON.parse(readFileSync(join(i5.outDir, "call.json"), "utf8")) as { diagnostics: Record<string, unknown> }).diagnostics[k]).toBe(v);
    }
    // a batch result without diagnostics (a stop before Codex ran) records null
    const s3 = setup();
    const i3 = await input(s3);
    await runFullPageCall(i3, deps(s3, s3.batchOf(okBatch(0, { stopCode: "CODEX_DOTENV_PRESENT", outcome: "not_applicable", imageCalls: 0 }))));
    expect((JSON.parse(readFileSync(join(i3.outDir, "call.json"), "utf8")) as { diagnostics: unknown }).diagnostics).toBeNull();
  });

  it("Issue #335 follow-up: the diagnostics' fixed value lists are capability.ts's own lists (kept in step)", () => {
    expect([...DIAGNOSTIC_TOOL_MODES]).toEqual([...TOOL_MODES]);
    expect([...DIAGNOSTIC_ANSWERS]).toEqual([...ANSWER_TEXT_CODES]);
    expect([...DIAGNOSTIC_ARG_ERROR_KINDS]).toEqual([...CODE_MODE_ARG_ERROR_KINDS]);
    expect([...DIAGNOSTIC_FAILURE_REASONS]).toEqual([...IMAGE_FAILURE_REASONS]);
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

// Issue #302 (d4 run path): d4 is approved only by its own packet, read with its own rows; d1 / d3 only by the P3 packet.
describe("IMAGE_FIRST d4: its own packet, never the P3 packet (and the other way round)", () => {
  const D4_UNAPPROVED = readFileSync(UNAPPROVED_D4_PACKET_FIXTURE);
  const D4_ID = "hoshigama-imagefirst-d4-20261120-01";
  const D4_PLAN = "hoshigama-imagefirst-p4-20261120";
  const D4_EXPIRES = "2026-11-20T09:00:00Z";
  /** The unapproved d4 fixture filled in memory exactly as its own §10 says (never written to the repository). */
  const fillD4 = (values: Partial<Record<string, string>> = {}) => {
    let text = D4_UNAPPROVED.toString("utf8");
    expect(text.slice(0, text.indexOf("\n## "))).toContain("**状態: 未承認。**");
    text = text.replace("**状態: 未承認。**", "**状態: 承認済み。**");
    const at = text.indexOf("## 10. 承認欄");
    let section = text.slice(at);
    const base: Record<string, string> = { status: "`承認済み`", directions: "`d4`", d4: `\`${D4_ID}\``, expires: `\`${D4_EXPIRES}\``, planId: `\`${D4_PLAN}\``, approvedBy: "2026-11-20 owner (test)" };
    for (const [k, label] of Object.entries(packetFieldsOf(D4_PACKET))) {
      const re = new RegExp(`^(\\| ${label}(?:（[^|]*)? \\| ).*( \\|)$`, "m");
      expect(re.test(section), label).toBe(true);
      section = section.replace(re, `$1${values[k] ?? base[k]}$2`);
    }
    return Buffer.from(text.slice(0, at) + section);
  };
  let cachedD4: { plan: PromptPlan; inputs: PromptInputs } | null = null;
  const planD4 = async () => {
    cachedD4 ??= await (async () => {
      const inputs = await loadPromptInputs((p) => readFile(resolve(REPO, p)), "d4");
      return { plan: buildPromptPlan(inputs), inputs };
    })();
    return cachedD4;
  };
  const d4Input = async (s: ReturnType<typeof setup>, packet: Buffer, over: Partial<Omit<FullPageCallInput, "expected">> = {}) => {
    const { plan, inputs } = await planD4();
    return input(s, { plan, inputs, packetPath: resolve(REPO, D4_PACKET.path), approvalId: D4_ID, planId: D4_PLAN, approvalExpires: D4_EXPIRES, packetBytes: packet, expected: { promptSha256: plan.batch.sha256, promptChars: plan.batch.chars, planSha256: plan.plan_sha256, packetSha256: sha(packet) }, ...over });
  };

  it("the packet table: one packet per direction; the P3 rows are PACKET_FIELDS, the d4 packet has a d4 row only", () => {
    expect(packetOfDirection("d1")).toBe(P3_PACKET);
    expect(packetOfDirection("d3")).toBe(P3_PACKET);
    expect(packetOfDirection("d4")).toBe(D4_PACKET);
    for (const k of ["d2", "d5", "toString", "__proto__", ""]) expect(packetOfDirection(k), k).toBeNull();
    expect(P3_PACKET.path).toBe(APPROVAL_PACKET_PATH);
    expect(D4_PACKET.path).toBe("docs/design/image-first-hoshigama-d4-packet.md");
    expect(packetFieldsOf(P3_PACKET)).toEqual(PACKET_FIELDS);
    expect(Object.values(packetFieldsOf(D4_PACKET)).sort()).toEqual(["d4 の承認 ID", "承認する方向性", "承認日・承認者", "期限", "状態", "計画 ID"].sort());
  });

  it("the d4 fixture is the unapproved draft (pinned), reads as approved for d4 only once filled, and never with the P3 rows", () => {
    expect(sha(D4_UNAPPROVED)).toBe(UNAPPROVED_D4_PACKET_FIXTURE_SHA256);
    expect(readApprovalPacket(D4_UNAPPROVED, D4_PACKET)).toBeNull();
    const filled = fillD4();
    expect(readApprovalPacket(filled, D4_PACKET)).toEqual({ status: "承認済み", directions: ["d4"], approvalIds: { d4: D4_ID }, expires: D4_EXPIRES, planId: D4_PLAN, approvedBy: "2026-11-20 owner (test)" });
    // a d4 packet is never a P3 approval, a P3 packet never a d4 one
    expect(readApprovalPacket(filled)).toBeNull();
    expect(readApprovalPacket(fillUnapproved(D3_ONLY), D4_PACKET)).toBeNull();
    for (const bad of ["`d3`", "`d1`", "`d3,d4`", "`d4,d4`", "``"]) expect(readApprovalPacket(fillD4({ directions: bad }), D4_PACKET), bad).toBeNull();
    expect(readApprovalPacket(fillD4({ d4: "`なし`" }), D4_PACKET)).toBeNull();
    expect(readApprovalPacket(Buffer.from(filled.toString("utf8").replace("**状態: 承認済み。**", "**状態: 未承認。**")), D4_PACKET)).toBeNull();
    // the P3 packet's d3 row added to a d4 packet: an extra row, not read
    expect(readApprovalPacket(Buffer.from(filled.toString("utf8").replace("| 計画 ID", `| d3 の承認 ID | \`hoshigama-imagefirst-d3-20261120-01\` |\n| 計画 ID`)), D4_PACKET)).toBeNull();
  });

  it("no packet under tests/ reads as an approved d4 packet either", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "__screenshots__" ? [] : walk(join(dir, e.name))) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));
    for (const f of walk(resolve(REPO, "tests"))) expect(readApprovalPacket(readFileSync(f), D4_PACKET), f).toBeNull();
  });

  it("the real d4 packet: the draft (header 未承認, §10 未記入, not read), or approved for d4 alone", () => {
    const real = readFileSync(resolve(REPO, D4_PACKET.path));
    const text = real.toString("utf8");
    if (text.slice(0, text.indexOf("\n## ")).includes("**状態: 未承認。**")) {
      const section = text.slice(text.lastIndexOf("\n## 10."));
      for (const label of Object.values(packetFieldsOf(D4_PACKET))) expect(new RegExp(`^\\| ${label}(?:（[^|]*)? \\| 未記入 \\|$`, "m").test(section), label).toBe(true);
      expect(readApprovalPacket(real, D4_PACKET)).toBeNull();
    } else {
      expect(readApprovalPacket(real, D4_PACKET)?.directions).toEqual(["d4"]);
    }
    expect(readApprovalPacket(real)).toBeNull();
  });

  it("a d4 plan with its filled packet runs once (stub batch); the same approval never runs again", async () => {
    const filled = fillD4();
    const s = setup();
    const ok = await runFullPageCall(await d4Input(s, filled), deps(s, s.batchOf(okBatch())));
    expect(ok).toMatchObject({ status: "succeeded", images: 6 });
    expect(s.calls).toEqual([{ prompt: (await planD4()).plan.batch.prompt, maxImages: 6 }]);
    expect(packetAsked).toEqual([[COMMIT, D4_PACKET.path]]);
    const again = await runFullPageCall(await d4Input(s, filled, { outDir: join(s.runs, "run-2") }), deps(s, s.batchOf(okBatch())));
    expect(again).toMatchObject({ status: "stopped", code: "APPROVAL_ALREADY_USED", stage: "precheck" });
    expect(s.calls).toHaveLength(1);
  });

  it("refused before anything is used: the other direction's packet path, id or packet, or the unapproved draft", async () => {
    const filled = fillD4();
    const { plan: d3Plan, inputs: d3Inputs } = await planD3();
    const cases: [string, (s: ReturnType<typeof setup>) => Promise<FullPageCallInput>, string][] = [
      ["d4 with the P3 packet's path", (s) => d4Input(s, filled, { packetPath: resolve(REPO, APPROVAL_PACKET_PATH) }), "PACKET_PATH_NOT_ALLOWED"],
      ["d4 with a d3 approval id", (s) => d4Input(s, filled, { approvalId: "hoshigama-imagefirst-d3-20261120-01" }), "APPROVAL_ID_DIRECTION_MISMATCH"],
      ["d4 with the unapproved d4 draft", (s) => d4Input(s, D4_UNAPPROVED), "PACKET_NOT_APPROVED"],
      ["d4 with an approved P3 packet (d3) at the d4 path", (s) => d4Input(s, fillUnapproved(D3_ONLY)), "PACKET_NOT_APPROVED"],
      ["d4 with another d4 id than the packet's", (s) => d4Input(s, filled, { approvalId: "hoshigama-imagefirst-d4-20261120-02" }), "PACKET_APPROVAL_MISMATCH"],
      ["d4 with another plan id than the packet's", (s) => d4Input(s, filled, { planId: "hoshigama-imagefirst-p4-20261121" }), "PACKET_APPROVAL_MISMATCH"],
      [
        "d3 with the d4 packet's path",
        (s) => input(s, { plan: d3Plan, inputs: d3Inputs, packetPath: resolve(REPO, D4_PACKET.path), approvalId: "hoshigama-imagefirst-d3-20261120-01", planId: "hoshigama-imagefirst-p3-20261120", approvalExpires: D4_EXPIRES, packetBytes: filled, expected: { promptSha256: d3Plan.batch.sha256, promptChars: d3Plan.batch.chars, planSha256: d3Plan.plan_sha256, packetSha256: sha(filled) } }),
        "PACKET_PATH_NOT_ALLOWED",
      ],
      [
        "d3 with the approved d4 packet's bytes at the P3 path",
        (s) => input(s, { plan: d3Plan, inputs: d3Inputs, approvalId: "hoshigama-imagefirst-d3-20261120-01", planId: "hoshigama-imagefirst-p3-20261120", approvalExpires: D4_EXPIRES, packetBytes: filled, expected: { promptSha256: d3Plan.batch.sha256, promptChars: d3Plan.batch.chars, planSha256: d3Plan.plan_sha256, packetSha256: sha(filled) } }),
        "PACKET_NOT_APPROVED",
      ],
      ["a direction with no packet (d2-like key)", async (s) => d4Input(s, filled, { plan: { ...(await planD4()).plan, direction_key: "d2" as PromptPlan["direction_key"] }, approvalId: "hoshigama-imagefirst-d2-20261120-01" }), "PACKET_PATH_NOT_ALLOWED"],
    ];
    for (const [name, make, code] of cases) {
      const s = setup();
      const r = await runFullPageCall(await make(s), deps(s, s.batchOf(okBatch())));
      expect(r, name).toEqual({ status: "stopped", code, stage: "precheck", aborted: false });
      expect(s.calls, name).toEqual([]);
      expect(ledgerEntries(s), name).toEqual([]);
    }
  }, 30_000); // nine entry refusals plus two plan builds: ~3.4 s alone, over the 5 s default under a parallel run (PR #320 review M1)
});
