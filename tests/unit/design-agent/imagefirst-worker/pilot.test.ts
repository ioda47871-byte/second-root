import { spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DUMMY_ID } from "@/lib/design-agent/imagefirst-worker/review-poc";
import { SandboxError, type CodexSandbox } from "@/lib/design-agent/sandbox";
import { codexSignInCheck } from "@/scripts/design-artifact/phase2f-live-cli";
import { ID, loadPngs, PILOT, PNG, PREFLIGHT, RUBRIC_FILES, SCRIPTS, SYSTEM_PATH, wsl } from "./pilot-world";
import { cleanupTemps, commitFiles, git, pointOrigin, REPO, sha, tmp } from "./support";

// Issue #302 (owner pre-approval 2026-11-21): root's one-shot pilot (scripts/sales-design-worker/imagefirst-pilot.sh) and its
// read-only preflight (imagefirst-pilot-preflight.sh), the real files, against a fake WSL under SR_IMAGEFIRST_PILOT_TEST_ROOT,
// the same way the automatic start's and the re-send wrapper's tests do: systemctl, setpriv and pgrep are stubs, the
// worker's dedicated clone is a clone of a temporary bare origin, and the clone's worker CLI and audit CLI are STUBS that
// record how they were started and leave files in the real shapes (the worker, the delivery and the audit themselves are
// tested in cycle / worker-cli / deliver-review / claude-audit tests). The re-send step runs the REAL
// imagefirst-deliver-review.sh. `codex` and `claude` on PATH are logging stubs that must never run; the PATH holds no
// other directory with either. No root, no systemd, no network, no model.

// generous: under a loaded machine each script starts several node processes (the stub CLIs) and git
vi.setConfig({ testTimeout: 600_000 });
afterAll(cleanupTemps, 60_000);
// the fake WSL (wsl()), the stub worker and audit CLIs and the pictures: ./pilot-world.ts (shared with autorun.test.ts)
const AUTOSTART = join(SCRIPTS, "imagefirst-autostart.sh");

beforeAll(loadPngs);

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
    expect(Object.keys(p.rows)).toEqual(["resource", "disk", "exclusion", "timers", "clone", "no_prior_run", "rubric", "approval", "codex", "claude_bin", "claude_auth"]);
    expect(Object.values(p.rows).every((r) => r.ok)).toBe(true);
    // it ran only the worker's precheck (with this approval as the grant) and the audit's auth-only check
    expect(w.starts().map((s) => [s.cli, s.argv.join(" ")])).toEqual([["worker", "--precheck"], ["worker", "--check-codex-auth-only"], ["audit", "--check-auth-only"]]);
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
      ["codex: an API-key login (the sandboxed sign-in check)", (w) => writeFileSync(join(w.home, "stub-codex-auth"), "CODEX_API_KEY_AUTH"), "codex"],
      ["codex: the sandbox cannot start", (w) => writeFileSync(join(w.home, "stub-codex-auth"), "CODEX_SANDBOX_UNAVAILABLE"), "codex"],
      ["codex: ~/sr-runs missing (OUT_DIR_PARENT_MISSING)", (w) => writeFileSync(join(w.home, "stub-codex-auth"), "OUT_DIR_PARENT_MISSING"), "codex"],
      ["the clone's audit is not rubric v2", (w) => { commitFiles(w.clone, { [RUBRIC_FILES[0]!]: Buffer.from('export const AUDIT_RUBRIC_VERSION = "if-claude-audit-v1";\n') }, "old rubric"); pointOrigin(w.clone); }, "rubric"],
      ["under 20 min of the approval left", (w) => writeFileSync(join(w.home, "stub-expires"), new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")), "approval"],
      ["the precheck reports no expiry", (w) => writeFileSync(join(w.home, "stub-no-expiry"), ""), "approval"],
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
    expect(p.rows[row]?.ok, `${name}: ${row}\n${p.stdout}`).toBe(false);
    expect(w.spent(), name).toEqual([]);
    const r = w.pilot([ID]);
    expect([r.status, r.code, r.phase], name).toEqual([20, "PILOT_PREFLIGHT_FAILED", "before_claim"]);
    expect(w.spent(), name).toEqual([]);
    expect(r.stdout, name).not.toMatch(/starting the worker/);
  });

  it("round 2 review L2: the Codex check refusing with OUT_DIR_PARENT_MISSING names the fix (create ~/sr-runs, mode 700)", () => {
    const w = wsl();
    writeFileSync(join(w.home, "stub-codex-auth"), "OUT_DIR_PARENT_MISSING");
    const p = w.preflight([ID]);
    expect(p.status).toBe(20);
    expect(p.rows.codex!.ok).toBe(false);
    expect(p.rows.codex!.why).toMatch(/^OUT_DIR_PARENT_MISSING: create ~sr-designgen\/sr-runs first \(owned by \S+, mode 700\)/);
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
    const after = w.preflight([ID]);
    expect(after.status, after.stdout).toBe(0);
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
      ["worker", "--check-codex-auth-only"],
      ["audit", "--check-auth-only"],
      ["worker", ""],
      ["audit", `${ID} --dry-run`],
      ["audit", ID],
    ]);
    const run = w.starts()[3]!;
    expect(run.grant).toBe(ID);
    expect(run.cwd).toBe(w.clone);
    expect(run.execArgv!.join(" ")).toMatch(/--import tsx/);
    expect(run.env.filter((k) => /API_KEY|PILOT_TEST/.test(k))).toEqual([]);
    const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
    const gid = spawnSync("id", ["-g"], { encoding: "utf8" }).stdout.trim();
    const drops = readFileSync(join(w.sc, "setpriv.log"), "utf8").trim().split("\n");
    expect(new Set(drops)).toEqual(new Set([`--reuid=${uid} --regid=${gid} --init-groups --reset-env --no-new-privs`]));
    // the summary (review L1 / L2): "share:" lines carry codes, counts, sizes and yes/no only; every SHA-256 is "local-only:"
    const receipt = readFileSync(join(w.home, "sr-runs", `${ID}-20261121T040000Z.receipt.json`));
    const part = (kind: string) => r.stdout.split("\n").filter((l) => l.startsWith(`imagefirst-pilot: ${kind}: `)).map((l) => l.slice(`imagefirst-pilot: ${kind}: `.length));
    const share = part("share");
    const local = part("local-only");
    expect(share).toEqual([
      `approval=${ID} codex_runs=1 (one worker run; never retried) delivery=delivered`,
      `approval_id=${ID}`,
      `commit=${"c".repeat(40)} (the approved develop commit)`,
      "receipt=status=succeeded stop_code=none",
      "images=pc=2 sp=4 total=6 verified=true",
      "image=pc-1 size=12x18 sha_matched=yes",
      "image=pc-2 size=12x18 sha_matched=yes",
      "image=sp-1 size=6x9 sha_matched=yes",
      "image=sp-2 size=6x9 sha_matched=yes",
      "image=sp-3 size=6x9 sha_matched=yes",
      "image=sp-4 size=6x9 sha_matched=yes",
      "delivery=state=delivered",
      "audit=status=completed stop_code=none rubric=if-claude-audit-v1 bundle_sha_matched=yes",
      "scores_desktop_1440=total=22 lowest=4 verdict=show_owner hard_fails=0 beauty=5 fit=4 implementability=4 originality=5 structure=4",
      "scores_mobile_390=total=23 lowest=4 verdict=show_owner hard_fails=0 beauty=5 fit=4 implementability=4 originality=5 structure=4",
      "verdict=show_owner (advisory only; the owner decides)",
    ]);
    // nothing shareable carries a SHA-256 or a local path
    for (const l of share) expect(l, l).not.toMatch(/[0-9a-f]{64}|\/home\/|sr-runs|\/tmp\//);
    expect(local).toContain(`receipt_sha256=${sha(receipt)}`);
    expect(local).toContain(`image_sha256=pc-1 ${sha(PNG.pc)}`);
    expect(local).toContain(`image_sha256=sp-4 ${sha(PNG.sp)}`);
    expect(local).toContain(`bundle_sha256=${"4".repeat(64)}`);
    expect(local).toContain(`rubric_sha256=${"5".repeat(64)}`);
    // the echoed worker / hand-off / audit lines carry no local path and no bundle SHA
    for (const l of r.stdout.split("\n").filter((x) => /^imagefirst-pilot: (worker|hand-off|audit dry run|audit): /.test(x))) expect(l, l).not.toMatch(/[0-9a-f]{64}|\/home\/|sr-runs|\/tmp\//);
    expect(r.stdout).toMatch(/^imagefirst-pilot: worker: \{"status":"succeeded".*"run_dir":"<local>","receipt":"<local>"\}$/m);
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
    expect(r.stdout).toMatch(/share: receipt=status=stopped stop_code=CODEX_NO_IMAGE/);
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
    // round 2 review L1: the re-send's result line names its places (previews_dir, inbox_dir): replaced by <local>
    expect(r.stdout).toMatch(/^imagefirst-deliver-review: worker: \{"status":"delivered".*"inbox_dir":"<local>","previews_dir":"<local>"/m);
    for (const l of r.stdout.split("\n").filter((x) => !x.startsWith("imagefirst-pilot: local-only: "))) expect(l, l).not.toMatch(/\/home\/|sr-runs\/|\/tmp\/|[0-9a-f]{64}/);
    expect(w.spent().map((s) => [s.cli, s.argv.join(" ")])).toEqual([["worker", ""], ["audit", ID]]);
  });

  it("the worker refuses (exit 2) or times out (124): stop with that code, no delivery, no dry run, no audit (review L6)", () => {
    for (const [mode, status, code] of [["refuse", 2, "PILOT_WORKER_REFUSED"], ["timeout", 1, "PILOT_WORKER_TIMEOUT"]] as const) {
      const w = wsl();
      writeFileSync(join(w.home, "stub-worker-mode"), mode);
      const r = w.pilot([ID]);
      expect([r.status, r.code, r.phase], mode).toEqual([status, code, "after_claim"]);
      expect(w.spent().map((s) => s.cli), mode).toEqual(["worker"]);
      expect(w.starts().filter((s) => s.argv.includes("--dry-run") || s.argv[0] === "--deliver-review"), mode).toEqual([]);
    }
  });

  it("a stop signal while the worker runs is passed on, the worker's receipt is waited for, and the pilot ends PILOT_INTERRUPTED (review M2 / L6)", async () => {
    const w = wsl();
    writeFileSync(join(w.home, "stub-worker-mode"), "sleep");
    const child = spawnChild("bash", [PILOT, ID], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    const closed = new Promise<number | null>((res) => child.on("close", (c) => res(c)));
    for (let i = 0; i < 3000 && !existsSync(join(w.home, "stub-sleeping")); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(w.home, "stub-sleeping")), out).toBe(true);
    child.kill("SIGTERM");
    const code = await closed;
    expect(out.trim().split("\n").pop(), out).toBe(`IMAGEFIRST_PILOT PILOT_INTERRUPTED phase=after_claim approval=${ID} exit=1`);
    expect(code).toBe(1);
    expect(readFileSync(join(w.home, "stub-term.log"), "utf8")).toContain("term");
    expect(out).toMatch(/share: receipt=status=stopped stop_code=WORKER_INTERRUPTED/);
    expect(w.spent().map((s) => s.cli)).toEqual(["worker"]);
    expect(w.starts().filter((s) => s.argv.includes("--dry-run"))).toEqual([]);
    expect(existsSync(join(w.sc, "model-cli.log"))).toBe(false);
  });

  it("a stop signal before the worker (during the preflight) ends the pilot there: exit 40, phase=before_claim, nothing spent", async () => {
    const w = wsl();
    // the preflight's claude auth check sleeps, so the stop arrives while the pilot waits for its preflight
    const audit = join(w.clone, "scripts", "sales-design-worker", "imagefirst-audit.ts");
    writeFileSync(audit, `import { appendFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(join(process.env.HOME ?? "", "stub-sleeping"), "1");\nsetTimeout(() => process.exit(0), 5_000);\n`);
    git(w.clone, "commit", "-q", "-am", "sleeping audit stub");
    pointOrigin(w.clone);
    git(w.clone, "push", "-q", "origin", "HEAD:refs/heads/develop");
    const child = spawnChild("bash", [PILOT, ID], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    const closed = new Promise<number | null>((res) => child.on("close", (c) => res(c)));
    for (let i = 0; i < 3000 && !existsSync(join(w.home, "stub-sleeping")); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(w.home, "stub-sleeping")), out).toBe(true);
    child.kill("SIGTERM");
    const code = await closed;
    expect(out.trim().split("\n").pop(), out).toBe(`IMAGEFIRST_PILOT PILOT_STOP_SIGNAL phase=before_claim approval=${ID} exit=40`);
    expect(code).toBe(40);
    expect(w.spent()).toEqual([]);
  });


  it.each([
    // pgrep calls: 2 in the preflight's busy(), 2 before the worker, 2 after it, 2 before the dry run, 2 before the audit
    ["the dry run", 6],
    ["the audit", 8],
  ] as const)("round 2 review L3: a stop during the idle check before %s does not start it (PILOT_INTERRUPTED)", async (step, holdAfter) => {
    const w = wsl();
    writeFileSync(join(w.sc, "pgrep-hold-after"), String(holdAfter));
    const child = spawnChild("bash", [PILOT, ID], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    const closed = new Promise<number | null>((res) => child.on("close", (c) => res(c)));
    for (let i = 0; i < 3000 && !existsSync(join(w.sc, "pgrep-holding")); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(w.sc, "pgrep-holding")), out).toBe(true);
    child.kill("SIGTERM");
    const code = await closed;
    expect(out.trim().split("\n").pop(), `${step}\n${out}`).toBe(`IMAGEFIRST_PILOT PILOT_INTERRUPTED phase=after_claim approval=${ID} exit=1`);
    expect(code).toBe(1);
    const audits = w.starts().filter((s) => s.cli === "audit").map((s) => s.argv.join(" "));
    expect(audits, step).toEqual(step === "the dry run" ? ["--check-auth-only"] : ["--check-auth-only", `${ID} --dry-run`]);
    expect(w.spent().map((s) => s.cli), step).toEqual(["worker"]);
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
    expect(r.stdout).toMatch(/share: audit=status=stopped stop_code=CLAUDE_QUOTA/);
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
      // the admin clone's files checked with the automatic start's trusted_path (review M1), verbatim
      const tp = (file: string) => {
        const s = src(file);
        const start = s.indexOf("\ntrusted_path() {\n");
        return s.slice(start, s.indexOf("\n}\n", start) + 3);
      };
      expect(tp(f).length, f).toBeGreaterThan(150);
      expect(tp(f), f).toBe(tp(AUTOSTART));
      // and the signal handler keyed on PHASE (review M2), as the automatic start's
      const handler = (file: string) => /\non_signal\(\) \{\n[\s\S]*?\n\}\n/.exec(src(file))![0].split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      if (f === PILOT) expect(handler(f).replace("PILOT_STOP_SIGNAL", "X")).toBe(handler(AUTOSTART).replace("AUTOSTART_STOP_SIGNAL", "X"));
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
    // the one worker run, and (--autorun only) the re-send from the fresh clone (docs/operations/imagefirst-autorun.md)
    expect(pilot.match(/imagefirst-worker\.ts[^\n]*/g)).toEqual(['imagefirst-worker.ts >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &', 'imagefirst-worker.ts --deliver-review "$APPROVAL" >"$WORK/deliver" 2>/dev/null 8>&- 9>&-']);
    expect(pilot.match(/imagefirst-audit\.ts[^\n]*/g)).toEqual(['imagefirst-audit.ts "$APPROVAL" --dry-run >"$WORK/dry" 2>/dev/null 8>&- 9>&-', 'imagefirst-audit.ts "$APPROVAL" >"$WORK/audit" 2>/dev/null 8>&- 9>&- &']);
    expect(pilot.match(/bash "\$(PREFLIGHT|DELIVER)"[^\n]*/g)).toEqual(['bash "$PREFLIGHT" "$APPROVAL" >"$WORK/preflight" 2>&1 8>&- 9>&-', 'bash "$DELIVER" "$APPROVAL" >"$WORK/deliver" 2>&1']);
    expect(pre.match(/imagefirst-worker\.ts[^\n]*/g)).toEqual(['imagefirst-worker.ts --precheck >"$WORK/precheck" 2>/dev/null 8>&- 9>&-', 'imagefirst-worker.ts --check-codex-auth-only >"$WORK/codex" 2>/dev/null 8>&- 9>&-']);
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

describe("Issue #302 pilot review H1: the Codex sign-in is checked before any approval is used (stubs only)", () => {
  type Run = CodexSandbox["run"];
  const sandboxOf = (run: Run): CodexSandbox => ({ env: {}, run });
  const answer = (stdout: string, code = 0) => async () => ({ code, signal: null, stdout, stderr: "", timedOut: false });

  it("ChatGPT: ok; an API-key login, signed out, a broken sandbox (set-up or probe), a .env: the fixed code; only `login status` is ever run", async () => {
    const seen: string[][] = [];
    const ctx = (preflight: string | null, run: Run) => ({ preflight: async () => preflight, sandbox: () => (preflight === null ? sandboxOf(async (a, o) => (seen.push([...a]), run(a, o))) : null) });
    expect(await codexSignInCheck(ctx(null, answer("Logged in using ChatGPT\n")))).toBeNull();
    expect(await codexSignInCheck(ctx(null, answer("Logged in using an API key - sk-...\n")))).toBe("CODEX_API_KEY_AUTH");
    expect(await codexSignInCheck(ctx(null, answer("Not logged in\n", 1)))).toBe("CODEX_NOT_SIGNED_IN");
    // the per-call sandbox probe fails inside run(): the sandbox's own code
    expect(await codexSignInCheck(ctx(null, async () => Promise.reject(new SandboxError("CODEX_SANDBOX_LEAK"))))).toBe("CODEX_SANDBOX_LEAK");
    // the generation path's preflight refuses (no bubblewrap, no codex, a .env): that code, and nothing is run
    for (const code of ["CODEX_SANDBOX_UNAVAILABLE", "CODEX_NOT_INSTALLED", "CODEX_DOTENV_PRESENT"]) expect(await codexSignInCheck(ctx(code, answer("Logged in using ChatGPT\n")))).toBe(code);
    expect(await codexSignInCheck({ preflight: async () => null, sandbox: () => null })).toBe("CODEX_SANDBOX_UNAVAILABLE");
    expect(seen.every((a) => a.join(" ") === "login status")).toBe(true);
    expect(seen.length).toBe(4);
  });

  it("the real worker CLI --check-codex-auth-only (no codex on PATH): refused with a fixed code, exit 2, nothing claimed or written", () => {
    const home = tmp("sr-ifp-codexauth-");
    const bin = join(home, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    mkdirSync(join(home, "sr-runs"), { mode: 0o700 });
    const r = spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/sales-design-worker/imagefirst-worker.ts"), "--check-codex-auth-only"], { cwd: REPO, encoding: "utf8", env: { HOME: home, PATH: [bin, ...SYSTEM_PATH].join(":") } as unknown as NodeJS.ProcessEnv, timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!) as { status: string; code: string; invoked: boolean };
    expect(out.status).toBe("refused");
    expect(out.code).toMatch(/^CODEX_(NOT_INSTALLED|SANDBOX_UNAVAILABLE|SANDBOX_CONFIG)$/);
    expect(out.invoked).toBe(false);
    expect(Object.keys(out).sort()).toEqual(["code", "invoked", "status"]);
    // no claim, no ledger, no run directory
    expect(existsSync(join(home, ".local", "state", "sr-design-worker", "imagefirst-worker"))).toBe(false);
    expect(existsSync(join(home, "sr-runs", ".codex-sign-in-check"))).toBe(false);
  });
});
