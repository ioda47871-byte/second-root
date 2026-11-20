import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DUMMY_ID } from "@/lib/design-agent/imagefirst-worker/review-poc";
import { cleanupTemps, commitFiles, git, ID, REPO, tmp, workerRepo } from "./support";

// Issue #302 P3 follow-up (PR #310 review H1 / M3): root's re-send wrapper
// (scripts/sales-design-worker/imagefirst-deliver-review.sh), the real file, against a fake WSL under
// SR_IMAGEFIRST_DELIVER_TEST_ROOT, the same way the automatic start's tests do: systemctl, setpriv and pgrep are stubs,
// the worker's dedicated clone is a clone of a temporary bare origin, and the clone's worker CLI is a STUB that records
// how it was started (the re-send itself is tested in deliver-review.test.ts). No root, no systemd, no network.

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanupTemps, 60_000);
const SCRIPT = join(REPO, "scripts/sales-design-worker/imagefirst-deliver-review.sh");
const AUTOSTART = join(REPO, "scripts/sales-design-worker/imagefirst-autostart.sh");
const exe = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
};
/** The stub worker CLI: records argv, cwd and environment names; prints one JSON line; exits with $HOME/stub-exit. */
const STUB = `import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME ?? "";
appendFileSync(join(home, "stub.log"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort(), execArgv: process.execArgv }) + "\\n");
const code = existsSync(join(home, "stub-exit")) ? Number(readFileSync(join(home, "stub-exit"), "utf8")) : 0;
function finish() {
  console.log(JSON.stringify({ status: code === 0 ? "delivered" : code === 1 ? "not_delivered" : "refused", code: null, invoked: false }));
  process.exit(code);
}
if (existsSync(join(home, "stub-sleep"))) {
  // as the real CLI: a stop aborts the delivery attempt (REVIEW_ABORTED, exit 2)
  process.on("SIGTERM", () => { appendFileSync(join(home, "stub-term.log"), "term\\n"); console.log(JSON.stringify({ status: "refused", code: "REVIEW_ABORTED", invoked: false })); process.exit(2); });
  appendFileSync(join(home, "stub-sleeping"), "1");
  setTimeout(finish, 30_000);
} else finish();
`;

function wsl() {
  const t = tmp("sr-idr-");
  const home = join(t, "home", "sr-designgen");
  const sc = join(t, "sc");
  const bin = join(t, "bin");
  for (const d of [join(t, "var", "lib"), home, sc, bin]) mkdirSync(d, { recursive: true });
  chmodSync(home, 0o700);
  exe(
    join(bin, "systemctl"),
    `echo "$*" >> '${sc}/systemctl.log'; u="\${@: -1}"
if [ "$1" = is-enabled ]; then [ -f '${sc}/isenabled-fail' ] && exit 1; if [ -f '${sc}'/enabled-"$u" ]; then cat '${sc}'/enabled-"$u"; exit 0; fi; echo disabled; exit 1; fi
[ -f '${sc}/show-fail' ] && exit 1
# jail-active-after N: the jailed Claude turns active after N reads of its state (the second busy() sees it)
if [ "$u" = sr-jail-claude.service ] && [ -f '${sc}/jail-active-after' ]; then echo x >> '${sc}/jail-reads'; if [ "$(wc -l < '${sc}/jail-reads')" -gt "$(cat '${sc}/jail-active-after')" ]; then echo active; exit 0; fi; fi
if [ -f '${sc}'/"$u" ]; then cat '${sc}'/"$u"; else echo inactive; fi`,
  );
  exe(join(bin, "setpriv"), `opts=(); while [ "$1" != "--" ]; do opts+=("$1"); shift; done; shift; echo "\${opts[*]}" >> '${sc}/setpriv.log'; exec "$@"`);
  exe(join(bin, "pgrep"), `[ -f '${sc}/pgrep-error' ] && exit 3; [ -f '${sc}/pgrep' ] && exit 0; exit 1`);
  const src = workerRepo();
  commitFiles(src, { ".gitignore": Buffer.from("node_modules\n"), "scripts/sales-design-worker/imagefirst-worker.ts": Buffer.from(STUB) }, "stub worker (test)");
  const origin = join(t, "origin.git");
  git(t, "init", "-q", "--bare", origin);
  git(src, "push", "-q", origin, "HEAD:refs/heads/develop");
  const clone = join(home, "imagefirst", "second-root");
  mkdirSync(join(home, "imagefirst"));
  git(t, "clone", "-q", "--branch", "develop", origin, clone);
  mkdirSync(join(clone, "node_modules"), { recursive: true });
  symlinkSync(join(REPO, "node_modules", "tsx"), join(clone, "node_modules", "tsx"), "dir");
  const env = { PATH: `${bin}:${process.env.PATH}`, SR_IMAGEFIRST_DELIVER_TEST_ROOT: t, OPENAI_API_KEY: "should-not-pass" } as unknown as NodeJS.ProcessEnv;
  const run = (args: string[]) => {
    const r = spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8", timeout: 50_000 });
    const last = r.stdout.trim().split("\n").pop() ?? "";
    const m = /^IMAGEFIRST_DELIVER_REVIEW (\S+) approval=(\S+) exit=(\d+)$/.exec(last);
    expect(m, r.stdout + r.stderr).not.toBeNull();
    expect(Number(m![3])).toBe(r.status);
    return { status: r.status, code: m![1]!, approval: m![2]!, stdout: r.stdout };
  };
  const starts = () => (existsSync(join(home, "stub.log")) ? readFileSync(join(home, "stub.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; cwd: string; env: string[]; execArgv: string[] }) : []);
  return { t, home, sc, bin, clone, env, run, starts };
}

describe("root's review re-send wrapper (fake WSL, stub worker)", () => {
  it("idle: starts the worker CLI once, as the worker (setpriv, allowlisted env), in its clone, with --deliver-review <id>", () => {
    const w = wsl();
    const r = w.run([ID]);
    expect([r.status, r.code, r.approval]).toEqual([0, "DELIVER_DONE", ID]);
    expect(r.stdout).toMatch(/^imagefirst-deliver-review: worker: \{"status":"delivered"/m);
    const s = w.starts();
    expect(s).toHaveLength(1);
    expect(s[0]!.argv).toEqual(["--deliver-review", ID]);
    expect(s[0]!.cwd).toBe(w.clone);
    expect(s[0]!.execArgv.join(" ")).toMatch(/--import tsx/);
    expect(s[0]!.env).not.toContain("OPENAI_API_KEY");
    expect(s[0]!.env).not.toContain("SR_IMAGEFIRST_DELIVER_TEST_ROOT");
    const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
    const gid = spawnSync("id", ["-g"], { encoding: "utf8" }).stdout.trim();
    expect(readFileSync(join(w.sc, "setpriv.log"), "utf8").trim().split("\n").at(-1)).toBe(`--reuid=${uid} --regid=${gid} --init-groups --reset-env --no-new-privs`);
  });

  it("passes the worker's result on: not delivered = 1, refused = 2", () => {
    const w = wsl();
    writeFileSync(join(w.home, "stub-exit"), "1");
    expect(w.run([ID])).toMatchObject({ status: 1, code: "DELIVER_NOT_DELIVERED" });
    writeFileSync(join(w.home, "stub-exit"), "2");
    expect(w.run([ID])).toMatchObject({ status: 2, code: "DELIVER_WORKER_REFUSED" });
    expect(w.starts()).toHaveLength(2);
  });

  it("busy (the jailed Claude active or enabled, the design cycle active, systemd unreadable, a worker process): 12, nothing started", () => {
    const cases: [string, string][] = [
      ["sr-jail-claude.service", "active"],
      ["enabled-sr-jail-claude.service", "enabled"],
      ["enabled-sr-jail-claude.service", "static"],
      ["sr-design-cycle.service", "activating"],
      ["show-fail", ""],
      ["isenabled-fail", ""],
      ["pgrep", ""],
      ["pgrep-error", ""],
    ];
    for (const [file, body] of cases) {
      const w = wsl();
      writeFileSync(join(w.sc, file), body);
      expect(w.run([ID]), file).toMatchObject({ status: 12, code: "DELIVER_BUSY" });
      expect(w.starts(), file).toEqual([]);
    }
    // masked is idle, as for the automatic start
    const m = wsl();
    writeFileSync(join(m.sc, "enabled-sr-jail-claude.service"), "masked");
    expect(m.run([ID]).code).toBe("DELIVER_DONE");
  });

  it("an automatic start poll holding its lock: busy, nothing started", async () => {
    const w = wsl();
    const lock = join(w.t, "var", "lib", "sr-imagefirst-autostart");
    mkdirSync(lock, { recursive: true });
    const holder = spawn("flock", [join(lock, "autostart.lock"), "sleep", "20"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 100 && !existsSync(join(lock, "autostart.lock")); i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 200));
      expect(w.run([ID])).toMatchObject({ status: 12, code: "DELIVER_BUSY" });
      expect(w.starts()).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("a design cycle holding cycle.sh's lock: busy, nothing started", async () => {
    const w = wsl();
    const dir = join(w.t, "var", "lib", "sr-design-cycle");
    mkdirSync(dir, { recursive: true });
    const holder = spawn("flock", [join(dir, "cycle.lock"), "sleep", "20"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 100 && !existsSync(join(dir, "cycle.lock")); i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 200));
      expect(w.run([ID])).toMatchObject({ status: 12, code: "DELIVER_BUSY" });
      expect(w.starts()).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("the second busy() right before the start: the jailed Claude started meanwhile = busy, nothing started", () => {
    const w = wsl();
    writeFileSync(join(w.sc, "jail-active-after"), "1");
    expect(w.run([ID])).toMatchObject({ status: 12, code: "DELIVER_BUSY" });
    expect(readFileSync(join(w.sc, "jail-reads"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(w.starts()).toEqual([]);
  });

  it("a stop signal during the re-send is passed on and reported as DELIVER_INTERRUPTED (1), never as refused", async () => {
    const w = wsl();
    writeFileSync(join(w.home, "stub-sleep"), "");
    const child = spawn("bash", [SCRIPT, ID], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    const closed = new Promise<number | null>((res) => child.on("close", (c) => res(c)));
    for (let i = 0; i < 1500 && !existsSync(join(w.home, "stub-sleeping")); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(w.home, "stub-sleeping"))).toBe(true);
    child.kill("SIGTERM");
    const code = await closed;
    expect(out.trim().split("\n").pop()).toBe(`IMAGEFIRST_DELIVER_REVIEW DELIVER_INTERRUPTED approval=${ID} exit=1`);
    expect(code).toBe(1);
    expect(readFileSync(join(w.home, "stub-term.log"), "utf8")).toContain("term");
    expect(w.starts()).toHaveLength(1);
  });

  it("usage and the approval id: none, two, malformed, the dummy's reserved date: 2, nothing started", () => {
    const w = wsl();
    for (const [args, code] of [[[], "DELIVER_USAGE"], [[ID, ID], "DELIVER_USAGE"], [["../x"], "DELIVER_ID_INVALID"], [[`${ID}\n`], "DELIVER_ID_INVALID"], [[DUMMY_ID], "DELIVER_ID_RESERVED"]] as const) {
      expect(w.run([...args]), args.join(" ")).toMatchObject({ status: 2, code });
    }
    expect(w.starts()).toEqual([]);
  });

  it("the worker's clone dirty or not on origin/develop: 20, nothing started (never cleaned, fetched or checked out)", () => {
    const w = wsl();
    writeFileSync(join(w.clone, "untracked.txt"), "x");
    expect(w.run([ID])).toMatchObject({ status: 20, code: "DELIVER_STOP_TREE_DIRTY" });
    expect(existsSync(join(w.clone, "untracked.txt"))).toBe(true);
    const v = wsl();
    commitFiles(v.clone, { "local.txt": Buffer.from("x") }, "a local commit");
    expect(v.run([ID])).toMatchObject({ status: 20, code: "DELIVER_STOP_NOT_ON_ORIGIN_DEVELOP" });
    expect(w.starts()).toEqual([]);
    expect(v.starts()).toEqual([]);
  });

  it("keeps the automatic start's busy() and privilege drop verbatim; nothing installs, enables or schedules it", () => {
    const fn = (file: string) => {
      const src = readFileSync(file, "utf8");
      const start = src.indexOf("\nbusy() {\n");
      return src.slice(start, src.indexOf("\n}\n", start) + 3);
    };
    expect(fn(SCRIPT).length).toBeGreaterThan(200);
    expect(fn(SCRIPT)).toBe(fn(AUTOSTART));
    const line = (file: string) => readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("AS_WORKER=(setpriv "));
    expect(line(SCRIPT)).toBeDefined();
    expect(line(SCRIPT)).toBe(line(AUTOSTART));
    const g = spawnSync("git", ["grep", "--untracked", "-lE", "(ExecStart|OnCalendar|systemctl.*(enable|start)).*imagefirst-deliver-review", "--", ".", ":!tests/**"], { cwd: REPO, encoding: "utf8" });
    expect(g.stdout.trim()).toBe("");
    // the wrapper starts only the worker CLI's re-send mode: never the cycle, the entry, Codex or a model
    const src = readFileSync(SCRIPT, "utf8");
    expect(src.match(/imagefirst-worker\.ts --deliver-review "\$APPROVAL"/g)).toHaveLength(1);
    const code = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/image-first-generate|codex|anthropic|openai|--precheck|GRANT_ENV/i);
  });
});
