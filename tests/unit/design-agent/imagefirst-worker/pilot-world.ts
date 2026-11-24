// The pilot's fake WSL (moved here from pilot.test.ts unchanged, so the automatic run's test can reuse it): systemctl,
// setpriv and pgrep stubs, a temporary bare origin and the worker's dedicated clone, the clone's worker CLI and audit CLI as
// STUBS that record how they were started and leave files in the real shapes, and `codex` / `claude` on PATH as logging
// stubs that must never run. No root, no systemd, no network, no model. Used by pilot.test.ts and autorun.test.ts only.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { expect } from "vitest";
import { commitFiles, git, REPO, sha, tmp, workerRepo } from "./support";

export const SPAWN_TIMEOUT_MS = 240_000;
export const SCRIPTS = join(REPO, "scripts/sales-design-worker");
export const PILOT = join(SCRIPTS, "imagefirst-pilot.sh");
export const PREFLIGHT = join(SCRIPTS, "imagefirst-pilot-preflight.sh");
export const ID = "hoshigama-imagefirst-d3-20261121-01";
export const LOCK = '{"lockfileVersion":3}\n';
/** The audit rubric v2 files the preflight's rubric row reads in the clone (copied from this repository). */
export const RUBRIC_FILES = ["lib/design-agent/imagefirst-worker/audit-rubric.ts", "lib/design-agent/imagefirst-worker/audit-schema.ts"];
const RUBRIC = Object.fromEntries(RUBRIC_FILES.map((f) => [f, readFileSync(join(REPO, f))]));
export const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];
export const exe = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
};

/** The stub worker CLI (imagefirst-worker.ts in the clone): --precheck, the run, --deliver-review; files in the real shapes. */
export const STUB_WORKER = `import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const home = process.env.HOME ?? "";
const state = join(home, ".local", "state", "sr-design-worker", "imagefirst-worker");
const runs = join(home, "sr-runs");
const argv = process.argv.slice(2);
// DEV-303: a standing request (--request <id> --request-sha256 <hex>, the run's private copy in SR_IMAGEFIRST_REQUEST_FILE):
// the request id takes the approval id's place; the copy must have exactly the SHA-256 root passed
const requestMode = argv[0] === "--request";
const grant = requestMode ? (argv[1] ?? "") : (process.env.SR_IMAGEFIRST_EXPECT_APPROVAL_ID ?? "");
const flag = (n: string) => existsSync(join(home, n));
const text = (n: string) => readFileSync(join(home, n), "utf8").trim();
const say = (o: object) => console.log(JSON.stringify(o));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
// what a model CLI started by this worker would see as its config dir (CODEX_HOME; else ~/.codex)
const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
const seen = (d: string) => { try { return (readdirSync(d, { recursive: true }) as string[]).map(String).sort(); } catch { return null; } };
const reqFile = process.env.SR_IMAGEFIRST_REQUEST_FILE ?? null;
const reqSha = reqFile && existsSync(reqFile) ? sha(readFileSync(reqFile)) : null;
appendFileSync(join(home, "stub.log"), JSON.stringify({ cli: "worker", argv, grant, cwd: process.cwd(), env: Object.keys(process.env).sort(), execArgv: process.execArgv, codexHome: process.env.CODEX_HOME ?? null, codexFiles: seen(codexHome), requestFile: reqFile, requestSha: reqSha }) + "\\n");
if (requestMode && (argv[2] !== "--request-sha256" || reqSha !== argv[3])) { say({ status: "refused", code: "REQUEST_SHA_MISMATCH", invoked: false, approval_id: grant }); process.exit(2); }
// a standing request's precheck (--request <id> --request-sha256 <hex> --precheck): one JSON line, 0 would_run / 2 refused, nothing written
if (requestMode && argv[4] === "--precheck") {
  if (flag("stub-request-precheck")) { say({ status: "refused", code: text("stub-request-precheck"), invoked: false, request_id: grant }); process.exit(2); }
  say({ status: "would_run", code: null, invoked: false, request_id: grant });
  process.exit(0);
}
// a sign-in refreshed by the CLI during the run (the automatic run copies it back afterwards)
if ((argv.length === 0 || requestMode) && flag("stub-refresh") && process.env.CODEX_HOME) writeFileSync(join(process.env.CODEX_HOME, "auth.json"), "refreshed-codex\\n");
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
  say({ status: "would_run", code: null, invoked: false, approval_id: grant, ...(flag("stub-no-expiry") ? {} : { expires_at: flag("stub-expires") ? text("stub-expires") : "2099-01-01T00:00:00Z" }) });
  process.exit(0);
}
if (argv[0] === "--check-codex-auth-only") {
  if (flag("stub-codex-auth")) { say({ status: "refused", code: text("stub-codex-auth"), invoked: false }); process.exit(2); }
  say({ status: "codex_auth_ok", code: null, invoked: false });
  process.exit(0);
}
if (argv[0] === "--deliver-review") {
  const code = flag("stub-deliver-exit") ? Number(text("stub-deliver-exit")) : 0;
  if (code === 0) delivered(argv[1]!);
  say({ status: code === 0 ? "delivered" : "not_delivered", code: code === 0 ? null : "RECEIVER_UNAVAILABLE", bundle_sha256: BUNDLE, inbox_dir: join(runs, "review-inbox"), previews_dir: join(runs, "review-inbox", "previews", argv[1]!), invoked: false });
  process.exit(code);
}
// the run: the one-use claim, the private run, the receipt, the hand-off line on stderr
mkdirSync(join(state, "claims"), { recursive: true, mode: 0o700 });
try { writeFileSync(claim, "{}\\n", { flag: "wx" }); } catch { say({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED", invoked: false, approval_id: grant }); process.exit(2); }
const mode = flag("stub-worker-mode") ? text("stub-worker-mode") : "ok";
if (mode === "refuse") { say({ status: "refused", code: "APPROVAL_NOT_GRANTED", invoked: false, approval_id: grant }); process.exit(2); }
if (mode === "timeout") process.exit(124);
const runDir = join(runs, grant + "-20261121T040000Z");
const receiptPath = runDir + ".receipt.json";
mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
const images: { file: string; sha256: string; bytes: number }[] = [];
// stub-seven: one picture more than the run may make (root's after-run image ceiling must catch it)
if (mode === "ok") for (const p of ["pc-1", "pc-2", "sp-1", "sp-2", "sp-3", "sp-4", ...(flag("stub-seven") ? ["pc-3"] : [])]) {
  const to = join(runDir, "parts", p + ".png");
  copyFileSync(join(home, "fixtures", p.slice(0, 2) + ".png"), to);
  const b = readFileSync(to);
  images.push({ file: "parts/" + p + ".png", sha256: sha(b), bytes: b.length });
}
if (mode === "sleep") {
  // as the real worker: a stop ends the run with a receipt (WORKER_INTERRUPTED), exit 1
  process.on("SIGTERM", () => {
    appendFileSync(join(home, "stub-term.log"), "term\\n");
    writeFileSync(receiptPath, JSON.stringify({ schema: "imagefirst_worker_receipt_v1", status: "stopped", stop_code: "WORKER_INTERRUPTED", approval_id: grant, commit: "c".repeat(40), run_dir: runDir, images: [], counts: { pc: 0, sp: 0, total: 0, stopped: 0 }, verified: false }) + "\\n", { mode: 0o600 });
    say({ status: "stopped", code: "WORKER_INTERRUPTED", invoked: true, approval_id: grant, run_dir: runDir, receipt: receiptPath });
    process.exit(1);
  });
  appendFileSync(join(home, "stub-sleeping"), "1");
  setTimeout(() => process.exit(3), 60_000);
} else {
const ok = mode === "ok";
writeFileSync(receiptPath, JSON.stringify({ schema: "imagefirst_worker_receipt_v1", status: ok ? "succeeded" : "stopped", stop_code: ok ? null : "CODEX_NO_IMAGE", approval_id: grant, plan_id: "hoshigama-imagefirst-p3-20261121", commit: "c".repeat(40), packet_sha256: "1".repeat(64), plan_sha256: "2".repeat(64), prompt_sha256: "3".repeat(64), prompt_chars: 12338, run_dir: runDir, images, counts: { pc: ok ? 2 : 0, sp: ok ? 4 : 0, total: images.length, stopped: 0 }, verified: ok }, null, 2) + "\\n", { mode: 0o600 });
if (!ok) { say({ status: "stopped", code: "CODEX_NO_IMAGE", invoked: true, approval_id: grant, run_dir: runDir, receipt: receiptPath }); process.exit(1); }
say({ status: "succeeded", code: null, invoked: true, approval_id: grant, run_dir: runDir, receipt: receiptPath });
if (flag("stub-review-fail")) process.stderr.write("imagefirst-worker: review " + JSON.stringify({ status: "not_delivered", code: "RECEIVER_UNAVAILABLE", bundle_sha256: BUNDLE }) + "\\n");
else { delivered(grant); process.stderr.write("imagefirst-worker: review " + JSON.stringify({ status: "delivered", code: null, bundle_sha256: BUNDLE }) + "\\n"); }
process.exit(0);
}
`;

/** The stub audit CLI (imagefirst-audit.ts in the clone): --check-auth-only, <id> --dry-run, <id>; audit.json in the real shape. */
export const STUB_AUDIT = `import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME ?? "";
const argv = process.argv.slice(2);
const flag = (n: string) => existsSync(join(home, n));
const say = (o: object) => console.log(JSON.stringify(o));
// what the Claude CLI started by this audit would see as its config dir (CLAUDE_CONFIG_DIR; else ~/.claude)
const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
const seen = (d: string) => { try { return (readdirSync(d, { recursive: true }) as string[]).map(String).sort(); } catch { return null; } };
appendFileSync(join(home, "stub.log"), JSON.stringify({ cli: "audit", argv, env: Object.keys(process.env).sort(), claudeDir: process.env.CLAUDE_CONFIG_DIR ?? null, claudeFiles: seen(claudeDir), codexHome: process.env.CODEX_HOME ?? null }) + "\\n");
if (argv.length === 1 && argv[0] !== "--check-auth-only" && flag("stub-refresh") && process.env.CLAUDE_CONFIG_DIR) writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "refreshed-claude\\n");
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

/** The pictures the stub run copies (made once by loadPngs(), in a beforeAll). */
export const PNG = { pc: Buffer.alloc(0), sp: Buffer.alloc(0) };
export async function loadPngs() {
  PNG.pc = await sharp({ create: { width: 12, height: 18, channels: 3, background: "#c08040" } }).png().toBuffer();
  PNG.sp = await sharp({ create: { width: 6, height: 9, channels: 3, background: "#f0e8d8" } }).png().toBuffer();
}

export type Start = { cli: "worker" | "audit"; argv: string[]; grant?: string; cwd?: string; env: string[]; execArgv?: string[]; codexHome?: string | null; codexFiles?: string[] | null; claudeDir?: string | null; claudeFiles?: string[] | null; requestFile?: string | null; requestSha?: string | null };

export function wsl() {
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
  exe(
    join(bin, "pgrep"),
    `[ -f '${sc}/pgrep-error' ] && exit 3; [ -f '${sc}/pgrep' ] && exit 0
# pgrep-hold-after N: the (N+1)th call holds once for 3 s (pgrep-holding marks it), then answers "none"
if [ -f '${sc}/pgrep-hold-after' ]; then echo x >> '${sc}/pgrep-calls'; if [ "$(wc -l < '${sc}/pgrep-calls')" -gt "$(cat '${sc}/pgrep-hold-after')" ] && [ ! -f '${sc}/pgrep-held' ]; then touch '${sc}/pgrep-held' '${sc}/pgrep-holding'; sleep 3; fi; fi
exit 1`,
  );
  // the real model CLIs must never run: logging stubs that fail
  for (const name of ["codex", "claude"]) exe(join(bin, name), `echo "${name} $*" >> '${sc}/model-cli.log'; exit 97`);
  symlinkSync(process.execPath, join(bin, "node"));
  // the worker's Codex sign-in (a placeholder file: presence only) and the pictures the stub run copies
  mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".codex", "auth.json"), "{}\n", { mode: 0o600 });
  mkdirSync(join(home, "fixtures"));
  writeFileSync(join(home, "fixtures", "pc.png"), PNG.pc);
  writeFileSync(join(home, "fixtures", "sp.png"), PNG.sp);
  const src = workerRepo();
  commitFiles(src, { ".gitignore": Buffer.from("node_modules\n"), "package-lock.json": Buffer.from(LOCK), ...RUBRIC, "scripts/sales-design-worker/imagefirst-worker.ts": Buffer.from(STUB_WORKER), "scripts/sales-design-worker/imagefirst-audit.ts": Buffer.from(STUB_AUDIT) }, "stub worker and audit (test)");
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
    const started = Date.now();
    const r = spawnSync("bash", [script, ...args], { env, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
    // a script cut by this test's own timeout traps the SIGTERM and exits as a stop: never mistake that for a check's result
    expect(/stopped by a signal|PILOT_STOP_SIGNAL/.test(r.stdout), `${script} was stopped by a signal after ${Date.now() - started} ms (this test's ${SPAWN_TIMEOUT_MS} ms spawn timeout?), not by a check\n${r.stdout}`).toBe(false);
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
  /** What actually spends: the worker run (no arguments, or a standing request's --request), the audit (no --dry-run), the re-send. */
  const spent = () => starts().filter((s) => (s.cli === "worker" && (s.argv.length === 0 || (s.argv[0] === "--request" && !s.argv.includes("--precheck")))) || (s.cli === "audit" && s.argv.length === 1 && s.argv[0] !== "--check-auth-only"));
  return { t, home, sc, bin, clone, origin, src, env, spawn, pilot, preflight, starts, spent };
}
