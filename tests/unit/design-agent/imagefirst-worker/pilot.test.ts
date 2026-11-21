import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DUMMY_ID } from "@/lib/design-agent/imagefirst-worker/review-poc";
import { cleanupTemps, commitFiles, git, REPO, sha, tmp, workerRepo } from "./support";

// Issue #302 (owner pre-approval 2026-11-21): root's one-shot pilot (scripts/sales-design-worker/imagefirst-pilot.sh) and its
// read-only preflight (imagefirst-pilot-preflight.sh), the real files, against a fake WSL under SR_IMAGEFIRST_PILOT_TEST_ROOT,
// the same way the automatic start's and the re-send wrapper's tests do: systemctl, setpriv and pgrep are stubs, the
// worker's dedicated clone is a clone of a temporary bare origin, and the clone's worker CLI and audit CLI are STUBS that
// record how they were started and leave files in the real shapes (the worker, the delivery and the audit themselves are
// tested in cycle / worker-cli / deliver-review / claude-audit tests). The re-send step runs the REAL
// imagefirst-deliver-review.sh. `codex` and `claude` on PATH are logging stubs that must never run; the PATH holds no
// other directory with either. No root, no systemd, no network, no model.

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanupTemps, 60_000);
const SCRIPTS = join(REPO, "scripts/sales-design-worker");
const PILOT = join(SCRIPTS, "imagefirst-pilot.sh");
const PREFLIGHT = join(SCRIPTS, "imagefirst-pilot-preflight.sh");
const AUTOSTART = join(SCRIPTS, "imagefirst-autostart.sh");
const ID = "hoshigama-imagefirst-d3-20261121-01";
const LOCK = '{"lockfileVersion":3}\n';
const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];
const exe = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
};

/** The stub worker CLI (imagefirst-worker.ts in the clone): --precheck, the run, --deliver-review; files in the real shapes. */
const STUB_WORKER = `import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const home = process.env.HOME ?? "";
const state = join(home, ".local", "state", "sr-design-worker", "imagefirst-worker");
const runs = join(home, "sr-runs");
const grant = process.env.SR_IMAGEFIRST_EXPECT_APPROVAL_ID ?? "";
const argv = process.argv.slice(2);
const flag = (n: string) => existsSync(join(home, n));
const text = (n: string) => readFileSync(join(home, n), "utf8").trim();
const say = (o: object) => console.log(JSON.stringify(o));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
appendFileSync(join(home, "stub.log"), JSON.stringify({ cli: "worker", argv, grant, cwd: process.cwd(), env: Object.keys(process.env).sort(), execArgv: process.execArgv }) + "\\n");
const BUNDLE = "4".repeat(64);
const delivered = (id: string) => {
  mkdirSync(join(state, "deliveries"), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "deliveries", id + ".json"), JSON.stringify({ schema: "imagefirst_bundle_delivery_v1", bundle_id: id, bundle_sha256: BUNDLE, state: "delivered" }));
  mkdirSync(join(runs, "review-inbox", id), { recursive: true, mode: 0o700 });
};
const claim = join(state, "claims", grant + ".used");
if (argv[0] === "--precheck") {
  if (existsSync(claim)) { say({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED", invoked: false, approval_id: grant }); process.exit(2); }
  if (flag("stub-precheck")) { say({ status: "refused", code: text("stub-precheck"), invoked: false, approval_id: grant }); process.exit(2); }
  say({ status: "would_run", code: null, invoked: false, approval_id: grant });
  process.exit(0);
}
if (argv[0] === "--deliver-review") {
  const code = flag("stub-deliver-exit") ? Number(text("stub-deliver-exit")) : 0;
  if (code === 0) delivered(argv[1]!);
  say({ status: code === 0 ? "delivered" : "not_delivered", code: code === 0 ? null : "RECEIVER_UNAVAILABLE", invoked: false });
  process.exit(code);
}
// the run: the one-use claim, the private run, the receipt, the hand-off line on stderr
mkdirSync(join(state, "claims"), { recursive: true, mode: 0o700 });
try { writeFileSync(claim, "{}\\n", { flag: "wx" }); } catch { say({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED", invoked: false, approval_id: grant }); process.exit(2); }
const mode = flag("stub-worker-mode") ? text("stub-worker-mode") : "ok";
const runDir = join(runs, grant + "-20261121T040000Z");
const receiptPath = runDir + ".receipt.json";
mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
const images: { file: string; sha256: string; bytes: number }[] = [];
if (mode === "ok") for (const p of ["pc-1", "pc-2", "sp-1", "sp-2", "sp-3", "sp-4"]) {
  const to = join(runDir, "parts", p + ".png");
  copyFileSync(join(home, "fixtures", p.slice(0, 2) + ".png"), to);
  const b = readFileSync(to);
  images.push({ file: "parts/" + p + ".png", sha256: sha(b), bytes: b.length });
}
const ok = mode === "ok";
writeFileSync(receiptPath, JSON.stringify({ schema: "imagefirst_worker_receipt_v1", status: ok ? "succeeded" : "stopped", stop_code: ok ? null : "CODEX_NO_IMAGE", approval_id: grant, plan_id: "hoshigama-imagefirst-p3-20261121", commit: "c".repeat(40), packet_sha256: "1".repeat(64), plan_sha256: "2".repeat(64), prompt_sha256: "3".repeat(64), prompt_chars: 12338, run_dir: runDir, images, counts: { pc: ok ? 2 : 0, sp: ok ? 4 : 0, total: images.length, stopped: 0 }, verified: ok }, null, 2) + "\\n", { mode: 0o600 });
if (!ok) { say({ status: "stopped", code: "CODEX_NO_IMAGE", invoked: true, approval_id: grant, run_dir: runDir, receipt: receiptPath }); process.exit(1); }
say({ status: "succeeded", code: null, invoked: true, approval_id: grant, run_dir: runDir, receipt: receiptPath });
if (flag("stub-review-fail")) process.stderr.write("imagefirst-worker: review " + JSON.stringify({ status: "not_delivered", code: "RECEIVER_UNAVAILABLE", bundle_sha256: BUNDLE }) + "\\n");
else { delivered(grant); process.stderr.write("imagefirst-worker: review " + JSON.stringify({ status: "delivered", code: null, bundle_sha256: BUNDLE }) + "\\n"); }
process.exit(0);
`;

/** The stub audit CLI (imagefirst-audit.ts in the clone): --check-auth-only, <id> --dry-run, <id>; audit.json in the real shape. */
const STUB_AUDIT = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME ?? "";
const argv = process.argv.slice(2);
const flag = (n: string) => existsSync(join(home, n));
const say = (o: object) => console.log(JSON.stringify(o));
appendFileSync(join(home, "stub.log"), JSON.stringify({ cli: "audit", argv, env: Object.keys(process.env).sort() }) + "\\n");
if (argv[0] === "--check-auth-only") {
  if (flag("stub-auth-fail")) { say({ status: "refused", code: "CLAUDE_API_KEY_AUTH", approval_id: "--check-auth-only" }); process.exit(2); }
  say({ status: "auth_ok", code: null });
  process.exit(0);
}
const id = argv[0]!;
if (argv[1] === "--dry-run") {
  if (flag("stub-dry-fail")) { say({ status: "refused", code: "AUDIT_INPUT_TOO_LARGE", approval_id: id }); process.exit(2); }
  say({ status: "planned", code: null, approval_id: id, bundle_sha256: "4".repeat(64), verdict: null, calls: 0 });
  process.exit(0);
}
const dir = join(home, "sr-runs", "review-inbox", "audits", id);
if (existsSync(dir)) { say({ status: "refused", code: "AUDIT_EXISTS", approval_id: id }); process.exit(2); }
mkdirSync(dir, { recursive: true, mode: 0o700 });
const stopped = flag("stub-audit-quota");
const vp = (total: number) => ({ total, lowest: 4, low_criteria: [], low_checks: [], hard_fail_hits: [], verdict: "show_owner" });
const scores = { beauty: { score: 5 }, fit: { score: 4 }, originality: { score: 5 }, structure: { score: 4 }, implementability: { score: 4 } };
writeFileSync(join(dir, "audit.json"), JSON.stringify({ schema: "x", status: stopped ? "stopped" : "completed", stop_code: stopped ? "CLAUDE_QUOTA" : null, binding: { bundle_sha256: "4".repeat(64), rubric_version: "if-claude-audit-v1", rubric_sha256: "5".repeat(64) }, viewports: stopped ? { desktop_1440: null, mobile_390: null } : { desktop_1440: { scores }, mobile_390: { scores } }, derived: stopped ? { desktop_1440: null, mobile_390: null, verdict: null } : { desktop_1440: vp(22), mobile_390: vp(23), verdict: "show_owner" } }));
say({ status: stopped ? "stopped" : "completed", code: stopped ? "CLAUDE_QUOTA" : null, approval_id: id, bundle_sha256: "4".repeat(64), verdict: stopped ? null : "show_owner", calls: stopped ? 1 : 2 });
process.exit(stopped ? 1 : 0);
`;

let PC_PNG: Buffer;
let SP_PNG: Buffer;
beforeAll(async () => {
  PC_PNG = await sharp({ create: { width: 12, height: 18, channels: 3, background: "#c08040" } }).png().toBuffer();
  SP_PNG = await sharp({ create: { width: 6, height: 9, channels: 3, background: "#f0e8d8" } }).png().toBuffer();
});

type Start = { cli: "worker" | "audit"; argv: string[]; grant?: string; cwd?: string; env: string[]; execArgv?: string[] };

function wsl() {
  const t = tmp("sr-ifp-");
  const home = join(t, "home", "sr-designgen");
  const sc = join(t, "sc");
  const bin = join(t, "bin");
  for (const d of [join(t, "var", "lib"), join(t, "proc"), home, sc, bin]) mkdirSync(d, { recursive: true });
  chmodSync(home, 0o700);
  writeFileSync(join(t, "proc", "meminfo"), "MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 4000000 kB\nSwapFree: 4000000 kB\n");
  writeFileSync(join(t, "min-free-mib"), "1");
  exe(
    join(bin, "systemctl"),
    `echo "$*" >> '${sc}/systemctl.log'; u="\${@: -1}"
case "$1" in
  is-enabled) [ -f '${sc}/isenabled-fail' ] && exit 1; if [ -f '${sc}'/enabled-"$u" ]; then cat '${sc}'/enabled-"$u"; exit 0; fi; echo disabled; exit 1 ;;
  show)
    [ -f '${sc}/show-fail' ] && exit 1
    if [ "$3" = LoadState ]; then if [ -f '${sc}'/load-"$u" ]; then cat '${sc}'/load-"$u"; else echo loaded; fi; exit 0; fi
    # jail-active-after N: the jailed Claude turns active after N reads of its state
    if [ "$u" = sr-jail-claude.service ] && [ -f '${sc}/jail-active-after' ]; then echo x >> '${sc}/jail-reads'; if [ "$(wc -l < '${sc}/jail-reads')" -gt "$(cat '${sc}/jail-active-after')" ]; then echo active; exit 0; fi; fi
    if [ -f '${sc}'/"$u" ]; then cat '${sc}'/"$u"; else echo inactive; fi ;;
  *) echo "$*" >> '${sc}/systemctl-other.log'; exit 1 ;;
esac`,
  );
  exe(join(bin, "setpriv"), `opts=(); while [ "$1" != "--" ]; do opts+=("$1"); shift; done; shift; echo "\${opts[*]}" >> '${sc}/setpriv.log'; exec "$@"`);
  exe(join(bin, "pgrep"), `[ -f '${sc}/pgrep-error' ] && exit 3; [ -f '${sc}/pgrep' ] && exit 0; exit 1`);
  // the real model CLIs must never run: logging stubs that fail
  for (const name of ["codex", "claude"]) exe(join(bin, name), `echo "${name} $*" >> '${sc}/model-cli.log'; exit 97`);
  symlinkSync(process.execPath, join(bin, "node"));
  // the worker's Codex sign-in (a placeholder file: presence only) and the pictures the stub run copies
  mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".codex", "auth.json"), "{}\n", { mode: 0o600 });
  mkdirSync(join(home, "fixtures"));
  writeFileSync(join(home, "fixtures", "pc.png"), PC_PNG);
  writeFileSync(join(home, "fixtures", "sp.png"), SP_PNG);
  const src = workerRepo();
  commitFiles(src, { ".gitignore": Buffer.from("node_modules\n"), "package-lock.json": Buffer.from(LOCK), "scripts/sales-design-worker/imagefirst-worker.ts": Buffer.from(STUB_WORKER), "scripts/sales-design-worker/imagefirst-audit.ts": Buffer.from(STUB_AUDIT) }, "stub worker and audit (test)");
  // npm ci is skipped when the lock's hash is the one recorded (as the automatic start; the test world never runs npm)
  mkdirSync(join(home, ".local", "state", "sr-design-worker"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".local", "state", "sr-design-worker", "imagefirst-autostart.npm-lock.sha256"), `${sha(Buffer.from(LOCK))}\n`);
  const origin = join(t, "origin.git");
  git(t, "init", "-q", "--bare", origin);
  git(src, "push", "-q", origin, "HEAD:refs/heads/develop");
  const clone = join(home, "imagefirst", "second-root");
  mkdirSync(join(home, "imagefirst"));
  git(t, "clone", "-q", "--branch", "develop", origin, clone);
  mkdirSync(join(clone, "node_modules"), { recursive: true });
  symlinkSync(join(REPO, "node_modules", "tsx"), join(clone, "node_modules", "tsx"), "dir");
  const env = { PATH: [bin, ...SYSTEM_PATH].join(":"), SR_IMAGEFIRST_PILOT_TEST_ROOT: t, OPENAI_API_KEY: "should-not-pass", ANTHROPIC_API_KEY: "should-not-pass" } as unknown as NodeJS.ProcessEnv;
  const spawn = (script: string, args: string[], re: RegExp) => {
    const r = spawnSync("bash", [script, ...args], { env, encoding: "utf8", timeout: 110_000 });
    const last = r.stdout.trim().split("\n").pop() ?? "";
    const m = re.exec(last);
    expect(m, r.stdout + r.stderr).not.toBeNull();
    expect(Number(m![m!.length - 1])).toBe(r.status);
    // no real model CLI, ever
    expect(existsSync(join(sc, "model-cli.log")), "a codex / claude binary was started").toBe(false);
    expect(existsSync(join(sc, "systemctl-other.log")), "systemctl was asked for something other than show / is-enabled").toBe(false);
    return { r, m: m! };
  };
  const pilot = (args: string[]) => {
    const { r, m } = spawn(PILOT, args, /^IMAGEFIRST_PILOT (\S+) phase=(\S+) approval=(\S+) exit=(\d+)$/);
    return { status: r.status, code: m[1]!, phase: m[2]!, approval: m[3]!, stdout: r.stdout };
  };
  const preflight = (args: string[]) => {
    const { r, m } = spawn(PREFLIGHT, args, /^IMAGEFIRST_PILOT_PREFLIGHT (\S+) approval=(\S+) failed=(\d+) exit=(\d+)$/);
    return { status: r.status, verdict: m[1]!, failed: Number(m[3]), stdout: r.stdout, rows: Object.fromEntries([...r.stdout.matchAll(/^imagefirst-pilot-preflight: \| (\S+)\s+\| (PASS|FAIL) \| (.*)$/gm)].map((x) => [x[1]!, { ok: x[2] === "PASS", why: x[3]! }])) };
  };
  const starts = (): Start[] => (existsSync(join(home, "stub.log")) ? readFileSync(join(home, "stub.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Start) : []);
  /** What actually spends: the worker run (no arguments), the audit (no --dry-run), the re-send. */
  const spent = () => starts().filter((s) => (s.cli === "worker" && s.argv.length === 0) || (s.cli === "audit" && s.argv.length === 1 && s.argv[0] !== "--check-auth-only"));
  return { t, home, sc, bin, clone, env, pilot, preflight, starts, spent };
}

describe("Issue #302 pilot: the test world itself", () => {
  it("the PATH the scripts get holds no real codex or claude (only the logging stubs)", () => {
    for (const dir of SYSTEM_PATH) for (const name of ["codex", "claude"]) expect(existsSync(join(dir, name)), `${dir}/${name}`).toBe(false);
  });
});

describe("Issue #302 pilot: the read-only preflight (fake WSL)", () => {
  it("all PASS: exit 0, one row per check, and it changes nothing (no claim, run, delivery or audit; only reads)", () => {
    const w = wsl();
    const p = w.preflight([ID]);
    expect([p.status, p.verdict, p.failed]).toEqual([0, "PASS", 0]);
    expect(Object.keys(p.rows)).toEqual(["resource", "disk", "exclusion", "timers", "clone", "no_prior_run", "approval", "codex", "claude_bin", "claude_auth"]);
    expect(Object.values(p.rows).every((r) => r.ok)).toBe(true);
    // it ran only the worker's precheck (with this approval as the grant) and the audit's auth-only check
    expect(w.starts().map((s) => [s.cli, s.argv.join(" ")])).toEqual([["worker", "--precheck"], ["audit", "--check-auth-only"]]);
    expect(w.starts()[0]!.grant).toBe(ID);
    expect(existsSync(join(w.home, ".local", "state", "sr-design-worker", "imagefirst-worker", "claims"))).toBe(false);
    expect(existsSync(join(w.home, "sr-runs"))).toBe(false);
    expect(existsSync(join(w.t, "var", "lib", "sr-imagefirst-autostart"))).toBe(false);
    expect(git(w.clone, "status", "--porcelain", "--untracked-files=all")).toBe("");
    // the worker's allowlisted environment: no API key reaches it
    for (const s of w.starts()) expect(s.env.filter((k) => /API_KEY|PILOT_TEST/.test(k))).toEqual([]);
  });

  const cases: [string, (w: ReturnType<typeof wsl>) => void, string][] = [
      ["memory STOP", (w) => writeFileSync(join(w.t, "proc", "meminfo"), "MemTotal: 4000000 kB\nMemAvailable: 1000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"), "resource"],
      ["disk", (w) => writeFileSync(join(w.t, "min-free-mib"), "999999999"), "disk"],
      ["jail active", (w) => writeFileSync(join(w.sc, "sr-jail-claude.service"), "active"), "exclusion"],
      ["jail enabled", (w) => writeFileSync(join(w.sc, "enabled-sr-jail-claude.service"), "enabled"), "exclusion"],
      ["design cycle active", (w) => writeFileSync(join(w.sc, "sr-design-cycle.service"), "activating"), "exclusion"],
      ["a worker process", (w) => writeFileSync(join(w.sc, "pgrep"), ""), "exclusion"],
      ["systemd unreadable", (w) => writeFileSync(join(w.sc, "show-fail"), ""), "exclusion"],
      ["design cycle timer enabled", (w) => writeFileSync(join(w.sc, "enabled-sr-design-cycle.timer"), "enabled"), "timers"],
      ["autostart timer active", (w) => writeFileSync(join(w.sc, "sr-imagefirst-autostart.timer"), "active"), "timers"],
      ["autostart service enabled", (w) => writeFileSync(join(w.sc, "enabled-sr-imagefirst-autostart.service"), "enabled"), "timers"],
      ["clone dirty", (w) => writeFileSync(join(w.clone, "untracked.txt"), "x"), "clone"],
      ["clone ahead (a local commit)", (w) => commitFiles(w.clone, { "local.txt": Buffer.from("x") }, "local"), "clone"],
      ["a claim already exists", (w) => { const d = join(w.home, ".local", "state", "sr-design-worker", "imagefirst-worker", "claims"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${ID}.used`), "{}"); }, "no_prior_run"],
      ["an audit already exists", (w) => mkdirSync(join(w.home, "sr-runs", "review-inbox", "audits", ID), { recursive: true }), "no_prior_run"],
      ["precheck: not approved (no job)", (w) => writeFileSync(join(w.home, "stub-precheck"), "APPROVAL_EXPIRED"), "approval"],
      ["codex missing", (w) => rmSync(join(w.bin, "codex")), "codex"],
      ["codex not signed in", (w) => rmSync(join(w.home, ".codex", "auth.json")), "codex"],
      ["codex .env present", (w) => writeFileSync(join(w.home, ".codex", ".env"), "X=1\n"), "codex"],
      ["claude missing", (w) => rmSync(join(w.bin, "claude")), "claude_bin"],
      ["claude: API key / not the subscription", (w) => writeFileSync(join(w.home, "stub-auth-fail"), ""), "claude_auth"],
    ];
  it.each(cases)("a failing check (%s): FAIL and exit 20, and the pilot stops there; nothing that spends runs", (name, arrange, row) => {
    const w = wsl();
    arrange(w);
    const p = w.preflight([ID]);
    expect([p.status, p.verdict], name).toEqual([20, "FAIL"]);
    expect(p.rows[row]?.ok, `${name}: ${row}`).toBe(false);
    expect(w.spent(), name).toEqual([]);
    const r = w.pilot([ID]);
    expect([r.status, r.code, r.phase], name).toEqual([20, "PILOT_PREFLIGHT_FAILED", "before_claim"]);
    expect(w.spent(), name).toEqual([]);
    expect(r.stdout, name).not.toMatch(/starting the worker/);
  });

  it("a clone behind origin/develop fails with the hint; --sync-clone fast-forwards it (as the automatic start's step 5), then it passes", () => {
    const w = wsl();
    // origin moves on (the owner merged the packet PR): the clone is behind
    const ahead = tmp("sr-ifp-ahead-");
    git(ahead, "clone", "-q", "--branch", "develop", join(w.t, "origin.git"), ".");
    commitFiles(ahead, { "docs/new.md": Buffer.from("x") }, "merged on develop");
    git(ahead, "push", "-q", "origin", "HEAD:refs/heads/develop");
    const before = w.preflight([ID]);
    expect(before.status).toBe(20);
    expect(before.rows.clone!.why).toMatch(/behind origin\/develop.*--sync-clone/);
    expect(before.rows.approval!.ok).toBe(false);
    const s = w.pilot(["--sync-clone"]);
    expect([s.status, s.code]).toEqual([0, "PILOT_SYNCED"]);
    expect(git(w.clone, "rev-parse", "HEAD")).toBe(git(ahead, "rev-parse", "HEAD"));
    expect(w.spent()).toEqual([]);
    expect(w.preflight([ID]).status).toBe(0);
    // a dirty clone is never synced (nothing is cleaned)
    const v = wsl();
    writeFileSync(join(v.clone, "untracked.txt"), "x");
    expect(v.pilot(["--sync-clone"])).toMatchObject({ status: 20, code: "PILOT_SYNC_TREE_DIRTY" });
    expect(existsSync(join(v.clone, "untracked.txt"))).toBe(true);
  });

  it("usage and the approval id: none, two, malformed, the dummy's reserved date: 2, nothing started", () => {
    const w = wsl();
    for (const args of [[], [ID, ID], ["../x"], [`${ID}\n`], [DUMMY_ID]]) {
      expect(w.preflight(args).status, args.join(" ")).toBe(2);
      expect(w.pilot(args).status, args.join(" ")).toBe(2);
    }
    expect(w.starts()).toEqual([]);
  });
});

describe("Issue #302 pilot: the one-shot run (fake WSL, stub worker and audit)", () => {
  it("happy path: preflight, ONE worker run (the automatic start's setpriv line and grant), delivered, dry run, ONE audit, a summary of hashes", () => {
    const w = wsl();
    const r = w.pilot([ID]);
    expect([r.status, r.code, r.phase, r.approval]).toEqual([0, "PILOT_DONE", "after_claim", ID]);
    expect(w.starts().map((s) => [s.cli, s.argv.join(" ")])).toEqual([
      ["worker", "--precheck"],
      ["audit", "--check-auth-only"],
      ["worker", ""],
      ["audit", `${ID} --dry-run`],
      ["audit", ID],
    ]);
    const run = w.starts()[2]!;
    expect(run.grant).toBe(ID);
    expect(run.cwd).toBe(w.clone);
    expect(run.execArgv!.join(" ")).toMatch(/--import tsx/);
    expect(run.env.filter((k) => /API_KEY|PILOT_TEST/.test(k))).toEqual([]);
    const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
    const gid = spawnSync("id", ["-g"], { encoding: "utf8" }).stdout.trim();
    const drops = readFileSync(join(w.sc, "setpriv.log"), "utf8").trim().split("\n");
    expect(new Set(drops)).toEqual(new Set([`--reuid=${uid} --regid=${gid} --init-groups --reset-env --no-new-privs`]));
    // the summary: codes, hashes and numbers only
    const receipt = readFileSync(join(w.home, "sr-runs", `${ID}-20261121T040000Z.receipt.json`));
    const summary = r.stdout.split("\n").filter((l) => l.startsWith("imagefirst-pilot: summary: ")).map((l) => l.slice("imagefirst-pilot: summary: ".length));
    expect(summary).toContain(`approval=${ID} codex_runs=1 (one worker run; never retried) delivery=delivered`);
    expect(summary).toContain(`receipt_sha256=${sha(receipt)}`);
    expect(summary).toContain(`commit=${"c".repeat(40)}`);
    expect(summary).toContain("images=pc=2 sp=4 total=6 verified=true");
    expect(summary).toContain(`image=parts/pc-1.png sha256=${sha(PC_PNG)} size=12x18 sha_matches_file=yes`);
    expect(summary).toContain(`image=parts/sp-4.png sha256=${sha(SP_PNG)} size=6x9 sha_matches_file=yes`);
    expect(summary).toContain(`delivery=state=delivered bundle_sha256=${"4".repeat(64)}`);
    expect(summary).toContain(`rubric=version=if-claude-audit-v1 sha256=${"5".repeat(64)}`);
    expect(summary).toContain("scores_desktop_1440=total=22 lowest=4 verdict=show_owner hard_fails=0 beauty=5 fit=4 implementability=4 originality=5 structure=4");
    expect(summary).toContain("verdict=show_owner (advisory only; the owner decides)");
    expect(r.stdout).not.toMatch(/auth\.json|\{\}|BEGIN|token/i);
  });

  it("a second run is refused before anything spends (the preflight's no_prior_run and the worker's own claim)", () => {
    const w = wsl();
    expect(w.pilot([ID]).code).toBe("PILOT_DONE");
    const second = w.pilot([ID]);
    expect([second.status, second.code, second.phase]).toEqual([20, "PILOT_PREFLIGHT_FAILED", "before_claim"]);
    expect(second.stdout).toMatch(/\| no_prior_run \| FAIL/);
    expect(second.stdout).toMatch(/\| approval\s+\| FAIL \| precheck exit 2: .*APPROVAL_ALREADY_CLAIMED/);
    expect(w.spent().map((s) => [s.cli, s.argv.join(" ")])).toEqual([["worker", ""], ["audit", ID]]);
  });

  it("a worker that does not succeed: stop, no delivery re-send, no dry run, no audit (and the claim stays used)", () => {
    const w = wsl();
    writeFileSync(join(w.home, "stub-worker-mode"), "fail");
    const r = w.pilot([ID]);
    expect([r.status, r.code, r.phase]).toEqual([1, "PILOT_WORKER_STOPPED", "after_claim"]);
    expect(w.starts().filter((s) => s.cli === "audit").map((s) => s.argv.join(" "))).toEqual(["--check-auth-only"]);
    expect(w.starts().filter((s) => s.argv[0] === "--deliver-review")).toEqual([]);
    expect(r.stdout).toMatch(/summary: receipt_status=stopped stop_code=CODEX_NO_IMAGE/);
    // never retried: the next pilot is refused by the claim
    expect(w.pilot([ID]).code).toBe("PILOT_PREFLIGHT_FAILED");
    expect(w.spent().filter((s) => s.cli === "worker")).toHaveLength(1);
  });

  it("the jailed Claude starting during the run: stopped at the next step boundary, no dry run, no audit", () => {
    // reads of the jail's state: 1 = the preflight's busy(), 2 = before the worker, 3 = after the worker (active)
    const w = wsl();
    writeFileSync(join(w.sc, "jail-active-after"), "2");
    const r = w.pilot([ID]);
    expect([r.status, r.code, r.phase]).toEqual([1, "PILOT_BUSY", "after_claim"]);
    expect(r.stdout).toMatch(/busy: sr-jail-claude\.service is active \(after the worker\)/);
    expect(w.spent().map((s) => [s.cli, s.argv.join(" ")])).toEqual([["worker", ""]]);
    expect(w.starts().filter((s) => s.argv.includes("--dry-run"))).toEqual([]);
    // started between the preflight and the worker: busy before anything spends (12)
    const v = wsl();
    writeFileSync(join(v.sc, "jail-active-after"), "1");
    expect(v.pilot([ID])).toMatchObject({ status: 12, code: "PILOT_BUSY", phase: "before_claim" });
    expect(v.spent()).toEqual([]);
  });

  it("the hand-off did not deliver: root's re-send wrapper ONCE (the real script), then the audit", () => {
    const w = wsl();
    writeFileSync(join(w.home, "stub-review-fail"), "");
    const r = w.pilot([ID]);
    expect([r.status, r.code]).toEqual([0, "PILOT_DONE"]);
    expect(r.stdout).toMatch(/^IMAGEFIRST_DELIVER_REVIEW DELIVER_DONE approval=hoshigama-imagefirst-d3-20261121-01 exit=0$/m);
    expect(w.starts().filter((s) => s.argv[0] === "--deliver-review").map((s) => s.argv)).toEqual([["--deliver-review", ID]]);
    expect(r.stdout).toMatch(/delivery=delivered_by_resend/);
    expect(w.spent().map((s) => [s.cli, s.argv.join(" ")])).toEqual([["worker", ""], ["audit", ID]]);
  });

  it("not delivered after the one re-send: stop, no dry run, no audit", () => {
    const w = wsl();
    writeFileSync(join(w.home, "stub-review-fail"), "");
    writeFileSync(join(w.home, "stub-deliver-exit"), "1");
    const r = w.pilot([ID]);
    expect([r.status, r.code]).toEqual([1, "PILOT_NOT_DELIVERED"]);
    expect(w.starts().filter((s) => s.argv[0] === "--deliver-review")).toHaveLength(1);
    expect(w.starts().filter((s) => s.cli === "audit").map((s) => s.argv.join(" "))).toEqual(["--check-auth-only"]);
  });

  it("the dry run refuses (over the caps): stop, no audit; an audit that stops is not retried", () => {
    const w = wsl();
    writeFileSync(join(w.home, "stub-dry-fail"), "");
    expect(w.pilot([ID])).toMatchObject({ status: 1, code: "PILOT_AUDIT_DRY_RUN_FAILED" });
    expect(w.spent().map((s) => s.cli)).toEqual(["worker"]);
    const v = wsl();
    writeFileSync(join(v.home, "stub-audit-quota"), "");
    const r = v.pilot([ID]);
    expect([r.status, r.code]).toEqual([1, "PILOT_AUDIT_STOPPED"]);
    expect(r.stdout).toMatch(/summary: audit_status=stopped stop_code=CLAUDE_QUOTA/);
    expect(v.spent().map((s) => [s.cli, s.argv.join(" ")])).toEqual([["worker", ""], ["audit", ID]]);
  });
});

describe("Issue #302 pilot: the copied primitives stay identical; nothing installs, enables or schedules it", () => {
  const src = (f: string) => readFileSync(f, "utf8");
  const code = (f: string) => src(f).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const fn = (file: string) => {
    const s = src(file);
    const start = s.indexOf("\nbusy() {\n");
    return s.slice(start, s.indexOf("\n}\n", start) + 3);
  };
  const lineAndNext = (file: string, startsWith: string) => {
    // compared without the leading indentation (the preflight runs it inside an if)
    const lines = src(file).split("\n").map((l) => l.trim());
    const i = lines.findIndex((l) => l.startsWith(startsWith));
    expect(i, `${file}: ${startsWith}`).toBeGreaterThanOrEqual(0);
    return lines.slice(i, i + 2).join("\n");
  };

  it("busy(), the privilege drop, the worker's precheck and run lines and their limits are the automatic start's, verbatim", () => {
    for (const f of [PILOT, PREFLIGHT]) {
      expect(fn(f).length, f).toBeGreaterThan(200);
      expect(fn(f), f).toBe(fn(AUTOSTART));
      const drop = (file: string) => src(file).split("\n").find((l) => l.startsWith("AS_WORKER=(setpriv "));
      expect(drop(f), f).toBe(drop(AUTOSTART));
    }
    const pre = '"${AS_WORKER[@]}" timeout --foreground --kill-after="$KILL_AFTER" "$PRECHECK_TIMEOUT"';
    expect(lineAndNext(PREFLIGHT, pre)).toBe(lineAndNext(AUTOSTART, pre));
    const run = '"${AS_WORKER[@]}" timeout --foreground --kill-after="$WORKER_KILL_AFTER" "$WORKER_TIMEOUT"';
    expect(lineAndNext(PILOT, run)).toBe(lineAndNext(AUTOSTART, run));
    const value = (file: string, name: string) => new RegExp(`^${name}=(\\S+)$`, "m").exec(src(file))?.[1];
    for (const name of ["KILL_AFTER", "WORKER_TIMEOUT", "WORKER_KILL_AFTER", "FETCH_TIMEOUT", "GIT_TIMEOUT", "NPM_TIMEOUT", "NPM_HASH_FILE", "GRANT_ENV"]) expect(value(PILOT, name), name).toBe(value(AUTOSTART, name));
    for (const name of ["KILL_AFTER", "FETCH_TIMEOUT", "GIT_TIMEOUT", "PRECHECK_TIMEOUT", "GRANT_ENV"]) expect(value(PREFLIGHT, name), name).toBe(value(AUTOSTART, name));
    // --sync-clone: every command line of the automatic start's step 5, verbatim
    // (compared without the leading indentation: the pilot runs them inside its --sync-clone branch)
    const pilot = src(PILOT).split("\n").map((l) => l.trim());
    const step5 = src(AUTOSTART).split("\n").filter((l) => /^(in_clone |dirty="\$\(in_clone |head="\$\(in_clone |base="\$\(in_clone )/.test(l) || /^ {2}(\[ -f node_modules|timeout --kill-after="\$2"|mkdir -p "\$\(dirname)/.test(l));
    expect(step5.length).toBeGreaterThanOrEqual(9);
    for (const l of step5) expect(pilot, l).toContain(l.trim());
    // the preflight's fetch is the same command
    expect(src(PREFLIGHT)).toContain('in_clone timeout --kill-after="$KILL_AFTER" "$FETCH_TIMEOUT" git fetch --quiet --no-tags origin "+refs/heads/develop:refs/remotes/origin/develop" >/dev/null 2>&1');
  });

  it("each script starts exactly the existing pieces it names, and never a model CLI, the entry or a unit change", () => {
    const pilot = code(PILOT);
    const pre = code(PREFLIGHT);
    expect(pilot.match(/imagefirst-worker\.ts[^\n]*/g)).toEqual(['imagefirst-worker.ts >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &']);
    expect(pilot.match(/imagefirst-audit\.ts[^\n]*/g)).toEqual(['imagefirst-audit.ts "$APPROVAL" --dry-run >"$WORK/dry" 2>/dev/null 8>&- 9>&-', 'imagefirst-audit.ts "$APPROVAL" >"$WORK/audit" 2>/dev/null 8>&- 9>&- &']);
    expect(pilot.match(/bash "\$(PREFLIGHT|DELIVER)"[^\n]*/g)).toEqual(['bash "$PREFLIGHT" "$APPROVAL" >"$WORK/preflight" 2>&1 8>&- 9>&-', 'bash "$DELIVER" "$APPROVAL" >"$WORK/deliver" 2>&1']);
    expect(pre.match(/imagefirst-worker\.ts[^\n]*/g)).toEqual(['imagefirst-worker.ts --precheck >"$WORK/precheck" 2>/dev/null 8>&- 9>&-']);
    expect(pre.match(/imagefirst-audit\.ts[^\n]*/g)).toEqual(["imagefirst-audit.ts --check-auth-only >\"$WORK/auth\" 2>/dev/null 8>&- 9>&-"]);
    for (const [name, c] of [["pilot", pilot], ["preflight", pre]] as const) {
      expect(c, name).not.toMatch(/image-first-generate|generateImage|anthropic|openai|imagefirst-autostart\.json|imagefirst-run\.json|\/etc\/sr-design-worker/i);
      // systemctl only reads (show / is-enabled): never enable, disable, start, stop, mask, daemon-reload, link
      for (const m of c.matchAll(/systemctl\s+(\S+)/g)) expect(["show", "is-enabled"], `${name}: systemctl ${m[1]}`).toContain(m[1]);
      // a model CLI is never started: codex / claude appear only as `command -v` presence checks (the preflight)
      // (a command position: the start of a line or a quoted command, after ; & | $( exec then do env timeout --)
      const commandAt = /(^|[;&|]\s*|\$\(\s*|\b(?:exec|then|do|env|--)\s+|-c\s+['"]|["}]\s+)(codex|claude)(?![\w-])/;
      expect(c.split("\n").map((l) => l.trim()).filter((l) => commandAt.test(l) && !/command -v (codex|claude)'/.test(l)), name).toEqual([]);
    }
    expect(pre.match(/command -v (codex|claude)/g)).toEqual(["command -v codex", "command -v claude"]);
    // nothing installs, enables or schedules either script
    const g = spawnSync("git", ["grep", "--untracked", "-lE", "(ExecStart|OnCalendar|systemctl.*(enable|start)).*imagefirst-pilot", "--", ".", ":!tests/**"], { cwd: REPO, encoding: "utf8" });
    expect(g.stdout.trim()).toBe("");
  });
});
