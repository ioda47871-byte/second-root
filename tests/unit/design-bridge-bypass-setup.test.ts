import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/sales-design-bridge/setup-vercel-bypass.sh (DEV-063): the one-paste setup of the bridge's
// own Vercel Protection Bypass. The real script runs against a fake world under
// SR_BYPASS_SETUP_TEST_ROOT: fake runuser (runs the command as this user), curl (records its argv
// and environment, plays a Vercel / app answer) and cycle.sh. Nothing real is touched.

const REPO = join(__dirname, "../..");
const SCRIPT = join(REPO, "scripts/sales-design-bridge/setup-vercel-bypass.sh");
const ALIAS = "https://second-root-git-develop-brot-yanagi.vercel.app";
const ENDPOINT = `${ALIAS}/api/internal/sales-design/jobs`;
const VERCEL_401 = JSON.stringify({ error: { code: "unauthorized" }, protection: { vercel_auth_enabled: true }, message: "Protected by Vercel Authentication" });
const APP_DISABLED = JSON.stringify({ error: "design_bridge_disabled" });
const APP_UNAUTHORIZED = JSON.stringify({ error: "unauthorized" });

type World = ReturnType<typeof world>;

function exe(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A value of the bridge's form (32 visible characters), different in every test. */
const newValue = () => `Vb${randomBytes(15).toString("hex")}`;

function world(opts: { stdin?: boolean } = {}) {
  const t = mkdtempSync(join(tmpdir(), "sr-bypass-setup-"));
  const sc = join(t, "sc");
  const bin = join(t, "bin");
  const calls = join(t, "calls.log");
  const curlStdin = join(t, "curl-stdin.log");
  mkdirSync(sc, { recursive: true });
  writeFileSync(calls, "");
  const shims = join(t, "shims.log");
  writeFileSync(shims, "");
  // runuser -u <user> -- <command…>: records argv and environment, then runs the command as this user.
  // What runs "as the bridge user" carries the marker SR_FAKE_AS_BRIDGE=1 (inserted after `env -i`).
  exe(join(bin, "runuser"), `{ printf 'runuser argv: %s\\n' "$*"; printf 'runuser env: %s\\n' "$(env | tr '\\n' ' ')"; } >> '${calls}'
while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done; shift
if [ "\${1:-}" = env ] && [ "\${2:-}" = -i ]; then shift 2; exec env -i SR_FAKE_AS_BRIDGE=1 "$@"; fi
exec "$@"`);
  // Common external commands: each records its argv (the value must never be there) and refuses to
  // touch a path under the bridge user's home unless it runs as the bridge user (root must never
  // create, move, link, read or remove files in a directory that user controls).
  for (const name of ["mktemp", "ln", "mv", "chmod", "cat", "tail", "tr", "wc", "rm", "shred", "cmp", "cp", "touch", "tee", "find", "printf", "echo", "dd", "head"]) {
    exe(join(bin, name), `real="$(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin command -v ${name})"
printf '${name} %s | env %s\\n' "$*" "$(/usr/bin/env | /usr/bin/tr '\\n' ' ')" >> '${shims}'
if [ -z "\${SR_FAKE_AS_BRIDGE:-}" ]; then
  for a in "$@"; do case "$a" in *home/sr-designbridge*) printf 'REFUSED ${name} %s\\n' "$*" >> '${calls}'; exit 97 ;; esac; done
fi
${name === "ln" ? `[ ! -f '${sc}/ln-fail' ] || exit 1
[ ! -f '${sc}/ln-race' ] || printf 'raced-%s' 0123456789abcdef > "\${@: -1}"` : ""}
exec "$real" "$@"`);
  }
  // curl: refuses unless run as the bridge user, or if it inherited root's setup lock (fd 8); records argv and environment (never stdin, which
  // only the test reads); like the real curl it would read $HOME/.curlrc unless -q comes first
  // (here: a .curlrc "traces" the header); then plays sc/curl-<with|without>.{body,status,rc}
  exe(join(bin, "curl"), `[ -n "\${SR_FAKE_AS_BRIDGE:-}" ] || { echo "REFUSED curl $*" >> '${calls}'; exit 97; }
[ ! -e /proc/$$/fd/8 ] || { echo "REFUSED curl holds the setup lock fd 8 $*" >> '${calls}'; exit 96; }
how=without; hdr=""; case " $* " in *" @- "*) how=with; hdr="$(/usr/bin/cat)"; printf '%s\\n' "$hdr" >> '${curlStdin}' ;; esac
if [ "$1" != -q ] && [ "$1" != --disable ] && [ -f "$HOME/.curlrc" ]; then printf '%s\\n' "$hdr" >> '${join(t, "curlrc-trace")}'; fi
{ printf 'curl#%s argv: %s\\n' "$how" "$*"; printf 'curl#%s env: %s\\n' "$how" "$(/usr/bin/env | /usr/bin/tr '\\n' ' ')"; } >> '${calls}'
rc=$(cat '${sc}'/curl-$how.rc 2>/dev/null || echo 0)
if [ "$rc" != 0 ]; then printf '\\n000'; exit "$rc"; fi
cat '${sc}'/curl-$how.body; printf '\\n%s' "$(cat '${sc}'/curl-$how.status)"`);
  exe(join(t, "root/sr-capture-admin/scripts/sales-design-worker/cycle.sh"), `echo "cycle# $*" >> '${calls}'
cat '${sc}/cycle.out'; exit $(cat '${sc}/cycle.rc' 2>/dev/null || echo 0)`);
  writeFileSync(join(sc, "cycle.out"), ["cycle: budget 4500 s", "cycle: vercel bypass: on", "cycle: checks: OK", "cycle: dry run: preflight and checks only", "CYCLE_RESULT CYCLE_DRY_RUN_OK phase=before_claim job=none exit=0", ""].join("\n"));

  const conf = join(t, "home/sr-designbridge/.config/second-root");
  mkdirSync(conf, { recursive: true, mode: 0o700 });
  chmodSync(conf, 0o700);
  const env = join(conf, "design-bridge.env");
  const token = join(conf, "design-bridge.token");
  const bypass = join(conf, "design-bridge.vercel-bypass");
  writeFileSync(env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}\n`, { mode: 0o600 });
  writeFileSync(token, `Tk9${randomBytes(30).toString("base64url")}\n`, { mode: 0o600 });
  if (opts.stdin !== false) writeFileSync(join(t, "tty-is-stdin"), "");
  const w = { t, sc, bin, calls, shims, curlStdin, conf, env, token, bypass, cycleConf: join(t, "etc/second-root/design-cycle.conf") };
  answer(w, "without", 401, VERCEL_401);
  answer(w, "with", 503, APP_DISABLED);
  return w;
}

function answer(w: { sc: string }, how: "with" | "without", status: number, body: string, rc = 0) {
  writeFileSync(join(w.sc, `curl-${how}.status`), String(status));
  writeFileSync(join(w.sc, `curl-${how}.body`), body);
  writeFileSync(join(w.sc, `curl-${how}.rc`), String(rc));
}

function run(w: World, args: string[] = [], input = "") {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    input,
    env: { PATH: `${w.bin}:${process.env.PATH}`, SR_BYPASS_SETUP_TEST_ROOT: w.t, SOME_SECRET_KEY: "should-not-pass" } as unknown as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
  const lines = r.stdout.trimEnd().split("\n");
  return { ...r, out: r.stdout + r.stderr, last: lines[lines.length - 1]!, calls: readFileSync(w.calls, "utf8") };
}

const curlCalls = (calls: string, how: "with" | "without") => calls.split("\n").filter((l) => l.startsWith(`curl#${how} argv:`));
const leftovers = (w: World) => readdirSync(w.conf).filter((f) => f.startsWith(".design-bridge.vercel-bypass."));

/** The value is nowhere but in the file (and in what the fake curl received on stdin). */
function expectHidden(w: World, r: ReturnType<typeof run>, value: string) {
  expect(r.out).not.toContain(value);
  expect(r.calls).not.toContain(value); // every runuser / curl argv and environment
  const shims = readFileSync(w.shims, "utf8");
  expect(shims).not.toContain(value); // every shimmed external command's argv and environment
  expect(r.calls).not.toContain("REFUSED"); // root never touched the bridge user's files itself
  expect(r.out).not.toContain(ALIAS);
  expect(r.out).not.toContain("should-not-pass");
  expect(r.calls).not.toContain("should-not-pass");
}

describe("setup-vercel-bypass.sh: the file", () => {
  it("is valid bash, executable, and refuses to run outside the root-only clone without the test world", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    expect(readFileSync(SCRIPT, "utf8").startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("run from the root-only clone: sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh");
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("BYPASS_SETUP_RESULT BYPASS_USAGE step=1");
  });

  it("refuses unknown arguments", () => {
    const w = world();
    const r = run(w, ["--force"]);
    expect(r.status).toBe(2);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_USAGE step=1");
    expect(r.calls).toBe("");
  });

  // As in design-worker-cycle.test.ts: a private mount namespace puts a copy of the script at
  // /root/sr-capture-admin on a tmpfs only this test's processes see.
  const canUnshare = spawnSync("unshare", ["-rm", "true"]).status === 0;
  it.skipIf(!canUnshare)("the production copy refuses the test hook and a non-root user", () => {
    const w = world();
    const copy = join(w.t, "setup-copy.sh");
    writeFileSync(copy, readFileSync(SCRIPT));
    const prod = "/root/sr-capture-admin/scripts/sales-design-bridge";
    const script = [
      "set -u",
      "mount -t tmpfs -o mode=0755 none /root",
      `mkdir -p ${prod}`,
      `cp '${copy}' ${prod}/setup-vercel-bypass.sh`,
      `echo '--- hook'; SR_BYPASS_SETUP_TEST_ROOT='${w.t}' bash ${prod}/setup-vercel-bypass.sh`,
      `echo '--- nobody'; unshare --user bash ${prod}/setup-vercel-bypass.sh`,
      "true",
    ].join("\n");
    const r = spawnSync("unshare", ["-rm", "bash", "-c", script], { encoding: "utf8", env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, timeout: 60_000 });
    const parts = Object.fromEntries(
      r.stdout
        .split(/^--- /m)
        .filter(Boolean)
        .map((p) => [p.split("\n")[0], p]),
    );
    expect(parts.hook).toContain("BYPASS_TEST_HOOK_REFUSED: test hooks are refused in /root/sr-capture-admin");
    expect(parts.hook).toContain("BYPASS_SETUP_RESULT BYPASS_USAGE step=1");
    expect(parts.nobody).toContain("run as root: sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh");
    expect(parts.nobody).toContain("BYPASS_SETUP_RESULT BYPASS_USAGE step=1");
    expect(readFileSync(w.calls, "utf8")).toBe("");
    expect(existsSync(w.bypass)).toBe(false);
  });
});

describe("setup-vercel-bypass.sh: one paste", () => {
  it("writes the value as the bridge user's 0600 file, appends the env lines, probes, and skips the dry run without the cycle config", () => {
    const w = world();
    const value = newValue();
    const r = run(w, [], `${value}\n`);
    expect(r.status).toBe(0);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6");
    // the file: exactly the value, a regular 0600 file of this (the bridge) user, one link, no temporary file left
    expect(readFileSync(w.bypass, "utf8")).toBe(value);
    const st = statSync(w.bypass);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o7777).toBe(0o600);
    expect(st.nlink).toBe(1);
    expect(st.uid).toBe(process.getuid!());
    expect(leftovers(w)).toEqual([]);
    // the env lines, the env file still 0600
    expect(readFileSync(w.env, "utf8")).toBe(
      `SR_DESIGN_BRIDGE_API_URL=${ALIAS}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=${w.bypass}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}\n`,
    );
    expect(statSync(w.env).mode & 0o7777).toBe(0o600);
    // the probe: once without, once with the header; the header only on curl's stdin
    expect(r.stdout).toContain("api origin: *.vercel.app ok");
    expect(r.stdout).toContain("BYPASS_FILE_WRITTEN");
    expect(r.stdout).toContain("BYPASS_ENV_APPENDED");
    expect(r.stdout).toContain("probe without the bypass: PROTECTION_ON");
    expect(r.stdout).toContain("probe with the bypass: REACHED_APP design_bridge_disabled");
    expect(r.stdout).toContain("BYPASS_OK");
    expect(curlCalls(r.calls, "without")).toHaveLength(1);
    expect(curlCalls(r.calls, "with")).toHaveLength(1);
    for (const line of [...curlCalls(r.calls, "without"), ...curlCalls(r.calls, "with")]) {
      expect(line).toContain("--max-redirs 0 --max-time 20");
      expect(line.endsWith(` ${ENDPOINT}`)).toBe(true);
      expect(line.toLowerCase()).not.toContain("authorization");
    }
    expect(curlCalls(r.calls, "with")[0]).toContain(" -H @- ");
    expect(readFileSync(w.curlStdin, "utf8")).toBe(`x-vercel-protection-bypass: ${value}\n`);
    // the cycle config is not created
    expect(r.stdout).toContain("CYCLE_CONF_ABSENT");
    expect(existsSync(w.cycleConf)).toBe(false);
    expect(existsSync(dirname(w.cycleConf))).toBe(false);
    expect(r.calls).not.toContain("cycle#");
    expectHidden(w, r, value);
    // the bridge user did the file work (the shims saw it, with the marker); curl started with -q
    const shims = readFileSync(w.shims, "utf8");
    for (const name of ["mktemp", "chmod", "ln", "rm"]) expect(shims).toMatch(new RegExp(`^${name} .*SR_FAKE_AS_BRIDGE=1`, "m"));
    for (const line of [...curlCalls(r.calls, "without"), ...curlCalls(r.calls, "with")]) expect(line).toMatch(/^curl#\w+ argv: -q /);
  });

  it("the token (and the bridge's own secrets) are never read into curl, argv or the output", () => {
    const w = world();
    const token = readFileSync(w.token, "utf8").trim();
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain(token);
    expect(r.calls).not.toContain(token);
    expect(readFileSync(w.curlStdin, "utf8")).not.toContain(token);
  });

  it("trims the whitespace and the carriage return a paste may carry", () => {
    const w = world();
    const value = newValue();
    const r = run(w, [], `  ${value} \r\n`);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6");
    expect(readFileSync(w.bypass, "utf8")).toBe(value);
  });

  it("is idempotent: run again, nothing is read or changed, and it probes again", () => {
    const w = world();
    const value = newValue();
    expect(run(w, [], `${value}\n`).status).toBe(0);
    const before = { file: statSync(w.bypass), env: readFileSync(w.env, "utf8") };
    const other = newValue();
    const r = run(w, [], `${other}\n`);
    expect(r.status).toBe(0);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6");
    expect(r.stdout).toContain("BYPASS_FILE_PRESENT");
    expect(r.stdout).toContain("BYPASS_ENV_PRESENT");
    expect(r.stdout).not.toContain("Paste the Vercel bypass value");
    expect(readFileSync(w.bypass, "utf8")).toBe(value);
    expect(statSync(w.bypass).ino).toBe(before.file.ino);
    expect(statSync(w.bypass).mtimeMs).toBe(before.file.mtimeMs);
    expect(readFileSync(w.env, "utf8")).toBe(before.env);
    expect(curlCalls(r.calls, "with")).toHaveLength(2);
    expectHidden(w, r, value);
    expectHidden(w, r, other);
  });

  it("never overwrites an existing file without --replace", () => {
    const w = world();
    const old = newValue();
    writeFileSync(w.bypass, old, { mode: 0o600 });
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("BYPASS_FILE_PRESENT");
    expect(readFileSync(w.bypass, "utf8")).toBe(old);
    expect(readFileSync(w.curlStdin, "utf8")).toBe(`x-vercel-protection-bypass: ${old}\n`);
    expectHidden(w, r, old);
  });

  it("--replace puts the new value by an atomic rename (a new inode), 0600, no temporary file left", () => {
    const w = world();
    const old = newValue();
    writeFileSync(w.bypass, old, { mode: 0o600 });
    const ino = statSync(w.bypass).ino;
    const value = newValue();
    const r = run(w, ["--replace"], `${value}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("BYPASS_FILE_REPLACED");
    expect(readFileSync(w.bypass, "utf8")).toBe(value);
    expect(statSync(w.bypass).ino).not.toBe(ino);
    expect(statSync(w.bypass).mode & 0o7777).toBe(0o600);
    expect(statSync(w.bypass).nlink).toBe(1);
    expect(leftovers(w)).toEqual([]);
    expectHidden(w, r, value);
    expectHidden(w, r, old);
  });

  it("--replace with an invalid value keeps the old file", () => {
    const w = world();
    const old = newValue();
    writeFileSync(w.bypass, old, { mode: 0o600 });
    const r = run(w, ["--replace"], "short\n");
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_VALUE_INVALID step=3");
    expect(readFileSync(w.bypass, "utf8")).toBe(old);
  });
});

describe("setup-vercel-bypass.sh: the value is refused (nothing written)", () => {
  const invalid: [string, string][] = [
    ["empty", ""],
    ["15 characters", "a".repeat(15)],
    ["257 characters", "a".repeat(257)],
    ["a space inside", "abcdefgh ijklmnopqrstu"],
    ["a tab inside", "abcdefgh\tijklmnopqrstu"],
    ["non-ASCII", "abcdefghijklmnopé"],
    ["a control character", "abcdefgh\x01ijklmnopqrstu"],
  ];
  it.each(invalid)("%s → BYPASS_VALUE_INVALID", (_, value) => {
    const w = world();
    const env = readFileSync(w.env, "utf8");
    const r = run(w, [], `${value}\n`);
    expect(r.status).toBe(4);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_VALUE_INVALID step=3");
    expect(existsSync(w.bypass)).toBe(false);
    expect(leftovers(w)).toEqual([]);
    expect(readFileSync(w.env, "utf8")).toBe(env);
    expect(r.calls).not.toContain("curl#");
    if (value.length >= 4) expect(r.out).not.toContain(value);
  });

  it("no input at all (end of file) → BYPASS_VALUE_INVALID", () => {
    const w = world();
    const r = run(w, [], "");
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_VALUE_INVALID step=3");
    expect(existsSync(w.bypass)).toBe(false);
  });

  it("the bridge token → BYPASS_EQUALS_TOKEN, nothing written, the token never printed", () => {
    const w = world();
    const token = readFileSync(w.token, "utf8").trim();
    const r = run(w, [], `${token}\n`);
    expect(r.status).toBe(4);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_EQUALS_TOKEN step=3");
    expect(existsSync(w.bypass)).toBe(false);
    expect(leftovers(w)).toEqual([]);
    expect(r.out).not.toContain(token);
    expect(r.calls).not.toContain(token);
  });

  it("an existing file that holds the bridge token → BYPASS_EQUALS_TOKEN", () => {
    const w = world();
    writeFileSync(w.bypass, readFileSync(w.token, "utf8"), { mode: 0o600 });
    const r = run(w);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_EQUALS_TOKEN step=3");
    expect(r.calls).not.toContain("curl#");
  });

  const unsafe: [string, (w: World) => void, string][] = [
    ["mode 0640", (w) => { writeFileSync(w.bypass, newValue(), { mode: 0o640 }); chmodSync(w.bypass, 0o640); }, "BYPASS_FILE_UNSAFE"],
    ["mode 0400", (w) => { writeFileSync(w.bypass, newValue(), { mode: 0o400 }); chmodSync(w.bypass, 0o400); }, "BYPASS_FILE_UNSAFE"],
    ["two links", (w) => { writeFileSync(w.bypass, newValue(), { mode: 0o600 }); linkSync(w.bypass, join(w.t, "other-link")); }, "BYPASS_FILE_UNSAFE"],
    ["a symbolic link", (w) => { const f = join(w.t, "elsewhere"); writeFileSync(f, newValue(), { mode: 0o600 }); symlinkSync(f, w.bypass); }, "BYPASS_FILE_UNSAFE"],
    ["more than 512 bytes", (w) => writeFileSync(w.bypass, "a".repeat(513), { mode: 0o600 }), "BYPASS_FILE_UNSAFE"],
    ["a directory", (w) => mkdirSync(w.bypass), "BYPASS_FILE_UNSAFE"],
    ["not one value", (w) => writeFileSync(w.bypass, "two values here!!", { mode: 0o600 }), "BYPASS_VALUE_INVALID"],
  ];
  it.each(unsafe)("an existing bypass file with %s → %s (not probed; --replace is the way out)", (_, set, code) => {
    const w = world();
    set(w);
    const r = run(w);
    expect(r.status).toBe(4);
    expect(r.last).toBe(`BYPASS_SETUP_RESULT ${code} step=3`);
    expect(r.calls).not.toContain("curl#");
    expect(readFileSync(w.env, "utf8")).toBe(`SR_DESIGN_BRIDGE_API_URL=${ALIAS}\n`);
  });
});

describe("setup-vercel-bypass.sh: read-only checks first (nothing written)", () => {
  const checks: [string, (w: World) => void, string][] = [
    ["an API URL on the custom domain", (w) => writeFileSync(w.env, "SR_DESIGN_BRIDGE_API_URL=https://secondroot.jp\n", { mode: 0o600 }), "BYPASS_API_URL_INVALID"],
    ["an API URL with two labels", (w) => writeFileSync(w.env, "SR_DESIGN_BRIDGE_API_URL=https://a.b.vercel.app\n", { mode: 0o600 }), "BYPASS_API_URL_INVALID"],
    ["an http API URL", (w) => writeFileSync(w.env, "SR_DESIGN_BRIDGE_API_URL=http://second-root-git-develop-brot-yanagi.vercel.app\n", { mode: 0o600 }), "BYPASS_API_URL_INVALID"],
    ["an API URL with a port", (w) => writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}:8443\n`, { mode: 0o600 }), "BYPASS_API_URL_INVALID"],
    ["an API URL with a query", (w) => writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}/x?y=1\n`, { mode: 0o600 }), "BYPASS_API_URL_INVALID"],
    ["two API URL lines", (w) => writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}\nSR_DESIGN_BRIDGE_API_URL=${ALIAS}\n`, { mode: 0o600 }), "BYPASS_API_URL_INVALID"],
    ["no API URL", (w) => writeFileSync(w.env, "\n", { mode: 0o600 }), "BYPASS_API_URL_INVALID"],
    ["an env file readable by others", (w) => chmodSync(w.env, 0o644), "BYPASS_ENV_FILE_UNSAFE"],
    ["a missing env file", (w) => renameSync(w.env, join(w.t, "gone")), "BYPASS_ENV_FILE_UNSAFE"],
    ["a missing token file", (w) => unlinkSync(w.token), "BYPASS_TOKEN_FILE_UNSAFE"],
    ["a token file readable by the group", (w) => chmodSync(w.token, 0o640), "BYPASS_TOKEN_FILE_UNSAFE"],
    ["a config directory writable by the group", (w) => chmodSync(w.conf, 0o770), "BYPASS_CONFIG_DIR_UNSAFE"],
    ["bypass lines for another origin", (w) => writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=${w.bypass}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=https://other.vercel.app\n`, { mode: 0o600 }), "BYPASS_ENV_CONFLICT"],
    ["a bypass line for another file", (w) => writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=/elsewhere\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}\n`, { mode: 0o600 }), "BYPASS_ENV_CONFLICT"],
    ["only one bypass line", (w) => writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}\n`, { mode: 0o600 }), "BYPASS_ENV_CONFLICT"],
    ["duplicate bypass lines", (w) => writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=${w.bypass}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=${w.bypass}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}\n`, { mode: 0o600 }), "BYPASS_ENV_CONFLICT"],
  ];
  it.each(checks)("%s → %s at step 2", (_, set, code) => {
    const w = world();
    set(w);
    const env = existsSync(w.env) ? readFileSync(w.env, "utf8") : null;
    const value = newValue();
    const r = run(w, [], `${value}\n`);
    expect(r.status).toBe(3);
    expect(r.last).toBe(`BYPASS_SETUP_RESULT ${code} step=2`);
    expect(existsSync(w.bypass)).toBe(false);
    expect(existsSync(w.env) ? readFileSync(w.env, "utf8") : null).toBe(env);
    expect(r.calls).not.toContain("curl#");
    expect(r.out).not.toContain("secondroot.jp");
    expect(r.out).not.toContain("other.vercel.app");
    expectHidden(w, r, value);
  });

  it("an API URL with a path still gives the origin (the bridge uses the origin)", () => {
    const w = world();
    writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}/\n`, { mode: 0o600 });
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(0);
    expect(readFileSync(w.env, "utf8")).toContain(`SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}\n`);
  });

  it("the two env lines already there and equal → kept as they are", () => {
    const w = world();
    const text = `# bridge\nSR_DESIGN_BRIDGE_API_URL=${ALIAS}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=${w.bypass}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}\n`;
    writeFileSync(w.env, text, { mode: 0o600 });
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("BYPASS_ENV_PRESENT");
    expect(readFileSync(w.env, "utf8")).toBe(text);
  });

  it("an env file without a final newline gets the lines on their own lines", () => {
    const w = world();
    writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}`, { mode: 0o600 });
    expect(run(w, [], `${newValue()}\n`).status).toBe(0);
    expect(readFileSync(w.env, "utf8")).toBe(`SR_DESIGN_BRIDGE_API_URL=${ALIAS}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=${w.bypass}\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}\n`);
  });

  it("a token file named in the env file is the one compared with", () => {
    const w = world();
    const other = join(w.conf, "other.token");
    const token = `Tk9${randomBytes(30).toString("base64url")}`;
    writeFileSync(other, token, { mode: 0o600 });
    writeFileSync(w.env, `SR_DESIGN_BRIDGE_API_URL=${ALIAS}\nSR_DESIGN_BRIDGE_TOKEN_FILE=${other}\n`, { mode: 0o600 });
    const r = run(w, [], `${token}\n`);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_EQUALS_TOKEN step=3");
  });
});

describe("setup-vercel-bypass.sh: the probe (no bridge token, nothing claimed)", () => {
  it("flag on: the app answers unauthorized → BYPASS_OK", () => {
    const w = world();
    answer(w, "with", 401, APP_UNAUTHORIZED);
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("probe with the bypass: REACHED_APP unauthorized");
    expect(r.stdout).toContain("BYPASS_OK");
  });

  it("Vercel refuses the value → BYPASS_REJECTED (exit 6); the file stays for --replace", () => {
    const w = world();
    answer(w, "with", 401, VERCEL_401);
    const value = newValue();
    const r = run(w, [], `${value}\n`);
    expect(r.status).toBe(6);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_REJECTED step=5");
    expect(r.stdout).toContain("--replace");
    expect(r.calls).not.toContain("cycle#");
    expectHidden(w, r, value);
  });

  it("the app answers without the bypass → PROTECTION_NOT_ON, a loud warning, no request with the bypass", () => {
    const w = world();
    answer(w, "without", 503, APP_DISABLED);
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(6);
    expect(r.last).toBe("BYPASS_SETUP_RESULT PROTECTION_NOT_ON step=5");
    expect(r.stdout).toContain("WARNING: the request reached past Vercel without the bypass. Vercel Authentication may be OFF.");
    expect(curlCalls(r.calls, "with")).toHaveLength(0);
  });

  it("a 401 without Vercel's protection body is not Vercel's protection → PROTECTION_NOT_ON", () => {
    const w = world();
    answer(w, "without", 401, APP_UNAUTHORIZED);
    expect(run(w, [], `${newValue()}\n`).last).toBe("BYPASS_SETUP_RESULT PROTECTION_NOT_ON step=5");
  });

  const failed: [string, (w: World) => void][] = [
    ["no network without the bypass", (w) => answer(w, "without", 0, "", 6)],
    ["a timeout with the bypass", (w) => answer(w, "with", 0, "", 28)],
    ["a redirect with the bypass", (w) => answer(w, "with", 302, "")],
    ["an HTML page with the bypass", (w) => answer(w, "with", 404, "<html>not found</html>")],
    ["an unexpected app error with the bypass", (w) => answer(w, "with", 400, JSON.stringify({ error: "invalid_json" }))],
  ];
  it.each(failed)("%s → PROBE_FAILED", (_, set) => {
    const w = world();
    set(w);
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(6);
    expect(r.last).toBe("BYPASS_SETUP_RESULT PROBE_FAILED step=5");
    expect(r.out).not.toContain("not found");
  });
});

describe("setup-vercel-bypass.sh: the cycle's switch and dry run", () => {
  const writeConf = (w: World, text: string) => {
    mkdirSync(dirname(w.cycleConf), { recursive: true });
    writeFileSync(w.cycleConf, text, { mode: 0o644 });
    chmodSync(w.cycleConf, 0o644);
  };
  const SHA_LINE = `SR_DESIGN_CYCLE_BRIDGE_SHA=${"0123456789abcdef".repeat(2)}01234567`;

  it("config present without the switch → appended, cycle.sh --dry-run relayed", () => {
    const w = world();
    writeConf(w, `${SHA_LINE}\n`);
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(0);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6");
    expect(readFileSync(w.cycleConf, "utf8")).toBe(`${SHA_LINE}\nSR_DESIGN_CYCLE_VERCEL_BYPASS=on\n`);
    expect(statSync(w.cycleConf).mode & 0o7777).toBe(0o644);
    expect(r.stdout).toContain("CYCLE_SWITCH_APPENDED");
    expect(r.calls).toContain("cycle# --dry-run");
    expect(r.stdout).toContain("  cycle: vercel bypass: on");
    expect(r.stdout).toContain("relayed: CYCLE_RESULT CYCLE_DRY_RUN_OK phase=before_claim job=none exit=0 (exit 0)");
    expect(r.stdout).not.toContain("cycle: budget");
  });

  it("config without a final newline → the switch on its own line", () => {
    const w = world();
    writeConf(w, SHA_LINE);
    expect(run(w, [], `${newValue()}\n`).status).toBe(0);
    expect(readFileSync(w.cycleConf, "utf8")).toBe(`${SHA_LINE}\nSR_DESIGN_CYCLE_VERCEL_BYPASS=on\n`);
  });

  it("the switch already on → unchanged, dry run relayed", () => {
    const w = world();
    writeConf(w, `${SHA_LINE}\nSR_DESIGN_CYCLE_VERCEL_BYPASS=on\n`);
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CYCLE_SWITCH_ON");
    expect(readFileSync(w.cycleConf, "utf8")).toBe(`${SHA_LINE}\nSR_DESIGN_CYCLE_VERCEL_BYPASS=on\n`);
  });

  it.each([["off", "SR_DESIGN_CYCLE_VERCEL_BYPASS=off"], ["two lines", "SR_DESIGN_CYCLE_VERCEL_BYPASS=on\nSR_DESIGN_CYCLE_VERCEL_BYPASS=on"], ["another value", "SR_DESIGN_CYCLE_VERCEL_BYPASS=yes"]])(
    "the switch set otherwise (%s) → CYCLE_SWITCH_NOT_ON, unchanged, no dry run",
    (_, line) => {
      const w = world();
      writeConf(w, `${SHA_LINE}\n${line}\n`);
      const r = run(w, [], `${newValue()}\n`);
      expect(r.status).toBe(7);
      expect(r.last).toBe("BYPASS_SETUP_RESULT CYCLE_SWITCH_NOT_ON step=6");
      expect(readFileSync(w.cycleConf, "utf8")).toBe(`${SHA_LINE}\n${line}\n`);
      expect(r.calls).not.toContain("cycle#");
    },
  );

  it("a config writable by others → CYCLE_CONF_UNSAFE, unchanged", () => {
    const w = world();
    writeConf(w, `${SHA_LINE}\n`);
    chmodSync(w.cycleConf, 0o666);
    const r = run(w, [], `${newValue()}\n`);
    expect(r.last).toBe("BYPASS_SETUP_RESULT CYCLE_CONF_UNSAFE step=6");
    expect(readFileSync(w.cycleConf, "utf8")).toBe(`${SHA_LINE}\n`);
  });

  it("the dry run stops → CYCLE_DRY_RUN_NOT_OK (exit 7), its result relayed", () => {
    const w = world();
    writeConf(w, `${SHA_LINE}\n`);
    writeFileSync(join(w.sc, "cycle.out"), "cycle: check: CHECK_BYPASS_INVALID: x\nCYCLE_RESULT CYCLE_STOP_CHECK phase=before_claim job=none exit=21\n");
    writeFileSync(join(w.sc, "cycle.rc"), "21");
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(7);
    expect(r.stdout).toContain("  cycle: check: CHECK_BYPASS_INVALID");
    expect(r.stdout).toContain("relayed: CYCLE_RESULT CYCLE_STOP_CHECK phase=before_claim job=none exit=21 (exit 21)");
    expect(r.last).toBe("BYPASS_SETUP_RESULT CYCLE_DRY_RUN_NOT_OK step=6");
  });

  it("--no-dry-run: the config is neither changed nor used", () => {
    const w = world();
    writeConf(w, `${SHA_LINE}\n`);
    const r = run(w, ["--no-dry-run"], `${newValue()}\n`);
    expect(r.status).toBe(0);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6");
    expect(readFileSync(w.cycleConf, "utf8")).toBe(`${SHA_LINE}\n`);
    expect(r.calls).not.toContain("cycle#");
  });
});

describe("setup-vercel-bypass.sh: a real terminal", () => {
  // The value is typed into a pseudo-terminal (the script's /dev/tty, no test stdin hook): the
  // terminal must not echo it, and the transcript of everything the terminal showed must not hold it.
  const PTY_PY = `
import os, pty, select, sys, time
value = sys.stdin.readline().rstrip("\\n")
script, root, path = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execve("/bin/bash", ["bash", script], {"PATH": path, "SR_BYPASS_SETUP_TEST_ROOT": root})
out = b""
sent = False
deadline = time.time() + 50
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    if not sent and b"(not shown)" in out:
        time.sleep(0.3)
        os.write(fd, (value + "\\n").encode())
        sent = True
os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
`;
  it("reads the value from the terminal without echoing it", () => {
    const w = world({ stdin: false });
    const value = newValue();
    const r = spawnSync("python3", ["-I", "-c", PTY_PY, SCRIPT, w.t, `${w.bin}:${process.env.PATH}`], { encoding: "utf8", input: `${value}\n`, timeout: 60_000 });
    expect(r.stdout).toContain("Paste the Vercel bypass value for the design bridge (not shown)");
    expect(r.stdout).toContain("BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6");
    expect(r.stdout).not.toContain(value);
    expect(readFileSync(w.bypass, "utf8")).toBe(value);
    expect(readFileSync(w.calls, "utf8")).not.toContain(value);
  });

  it("without a terminal and without the test hook → BYPASS_NO_TTY, nothing written", () => {
    const w = world({ stdin: false });
    const r = spawnSync("setsid", ["-w", "bash", SCRIPT], {
      encoding: "utf8",
      input: `${newValue()}\n`,
      env: { PATH: `${w.bin}:${process.env.PATH}`, SR_BYPASS_SETUP_TEST_ROOT: w.t } as unknown as NodeJS.ProcessEnv,
      timeout: 60_000,
    });
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("BYPASS_SETUP_RESULT BYPASS_NO_TTY step=3");
    expect(existsSync(w.bypass)).toBe(false);
  });
});

describe("setup-vercel-bypass.sh: review fixes (DEV-063 fresh review)", () => {
  // M1: the value never reaches an external process's argv or environment. strace sees every
  // execve, including an absolute /usr/bin/printf that a PATH shim cannot catch.
  const canStrace = spawnSync("strace", ["-f", "-qq", "-e", "trace=execve", "-o", "/dev/null", "true"]).status === 0;
  it.skipIf(!canStrace)("no execve anywhere (argv or environment) carries the value", () => {
    for (const replace of [false, true]) {
      const w = world();
      if (replace) writeFileSync(w.bypass, newValue(), { mode: 0o600 });
      const value = newValue();
      const trace = join(w.t, "execve.trace");
      const r = spawnSync("strace", ["-f", "-qq", "-v", "-s", "65536", "-e", "trace=execve", "-o", trace, "bash", SCRIPT, ...(replace ? ["--replace"] : [])], {
        encoding: "utf8",
        input: `${value}\n`,
        env: { PATH: `${w.bin}:${process.env.PATH}`, SR_BYPASS_SETUP_TEST_ROOT: w.t } as unknown as NodeJS.ProcessEnv,
        timeout: 60_000,
      });
      expect(r.stdout.trimEnd().split("\n").pop()).toBe("BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6");
      const text = readFileSync(trace, "utf8");
      expect(text).toContain("execve(");
      expect(text).toContain("mktemp");
      expect(text).not.toContain(value);
      expect(readFileSync(w.bypass, "utf8")).toBe(value);
    }
  });

  // M1, statically (also where strace is missing): only builtins hold the value.
  it("every line that uses the value uses it through a bash builtin, never an external command", () => {
    const code = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#"));
    // Taint: v and BYPASS_VALUE, plus every variable assigned from a tainted one (x="$v", y=${x}, …).
    const tainted = new Set(["v", "BYPASS_VALUE"]);
    const ref = () => new RegExp(`\\$\\{?#?(${[...tainted].join("|")})\\b`);
    for (let grew = true; grew; ) {
      grew = false;
      for (const l of code) {
        for (const m of l.matchAll(/(?:^|[\s;&|({])(?:local\s+|declare\s+(?:-\w+\s+)?|readonly\s+)?([A-Za-z_]\w*)\+?=("[^"]*"|'[^']*'|\S+)/g)) {
          if (!tainted.has(m[1]) && ref().test(m[2])) {
            tainted.add(m[1]);
            grew = true;
          }
        }
      }
    }
    const uses = code.filter((l) => ref().test(l) || /"\$1" != \*|\$\{#1\}/.test(l));
    expect(uses.length).toBeGreaterThan(8);
    const names = [...tainted].join("|");
    for (const l of uses) {
      expect(l, l).not.toMatch(new RegExp(`(^|[;|&({]|\\$\\()\\s*(\\/[\\w./-]+|command|builtin|env|exec|xargs|sudo|runuser|nohup|time|stdbuf|timeout)\\s[^|]*(\\$\\{?(${names})\\b|\\$1)`));
      for (const m of l.matchAll(new RegExp(`(?:^|[;&({]|\\|\\|?|&&|\\$\\()\\s*([A-Za-z_][\\w-]*)(?=\\s[^|]*\\$\\{?(?:${names})\\b)`, "g"))) {
        expect(["printf", "valid", "is_token", "trim", "if", "local", "unset", "read", "case", "then", "elif", "IFS", ...tainted], `${m[1]} in: ${l}`).toContain(m[1]);
      }
    }
  });

  // M7, statically: every piece of shell code that touches the bridge user's files runs as that user.
  it("every `bash -c` runs through as_bridge, and root writes nothing under the bridge user's directory", () => {
    const code = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#"));
    const bashC = code.filter((l) => /\bbash -c\b/.test(l));
    expect(bashC.length).toBeGreaterThanOrEqual(5);
    for (const l of bashC) expect(l, l).toMatch(/\bas_bridge bash -c\b/);
    const VARS = "(CONF_DIR|BRIDGE_ENV|BYPASS_FILE|TOKEN_FILE)";
    const touch = new RegExp(`[<>]{1,2}\\s*"\\$${VARS}|\\b(mktemp|ln|mv|cp|rm|shred|chmod|chown|touch|tee|install|cat|tail|head|cmp)\\s[^|]*"\\$${VARS}`);
    let checked = 0;
    for (const l of code) {
      const m = touch.exec(l);
      if (!m) continue;
      checked += 1;
      expect(l.slice(0, m.index), l).toMatch(/\bas_bridge\b/);
    }
    expect(checked).toBeGreaterThanOrEqual(1);
  });

  it("the bridge user's ~/.curlrc is never read (curl starts with -q)", () => {
    const w = world();
    writeFileSync(join(w.t, "home/sr-designbridge/.curlrc"), `trace-ascii = "${join(w.t, "trace.txt")}"\n`, { mode: 0o600 });
    const value = newValue();
    const r = run(w, [], `${value}\n`);
    expect(r.status).toBe(0);
    expect(existsSync(join(w.t, "curlrc-trace"))).toBe(false);
    for (const line of [...curlCalls(r.calls, "without"), ...curlCalls(r.calls, "with")]) expect(line).toMatch(/^curl#\w+ argv: -q /);
  });

  it("temporary files left by an interrupted run are removed as the bridge user (also when the file is kept)", () => {
    for (const present of [false, true]) {
      const w = world();
      if (present) writeFileSync(w.bypass, newValue(), { mode: 0o600 });
      const stale = newValue();
      writeFileSync(join(w.conf, ".design-bridge.vercel-bypass.Ab12Cd"), stale, { mode: 0o600 });
      writeFileSync(join(w.conf, ".design-bridge.vercel-bypass.Zz99Yy"), stale, { mode: 0o600 });
      const r = run(w, [], `${newValue()}\n`);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("BYPASS_TEMP_REMOVED: 2 leftover temporary file(s)");
      expect(leftovers(w)).toEqual([]);
      expect(r.out).not.toContain(stale);
      expect(r.calls).not.toContain("REFUSED");
    }
  });

  it("a leftover-named symbolic link, hard link or FIFO is never touched (the token stays intact, no hang)", { timeout: 30_000 }, async () => {
    const w = world();
    const token = readFileSync(w.token, "utf8");
    symlinkSync(w.token, join(w.conf, ".design-bridge.vercel-bypass.Lnk001"));
    linkSync(w.token, join(w.conf, ".design-bridge.vercel-bypass.Hard01"));
    expect(spawnSync("mkfifo", [join(w.conf, ".design-bridge.vercel-bypass.Fifo01")]).status).toBe(0);
    writeFileSync(join(w.conf, ".design-bridge.vercel-bypass.Real01"), newValue(), { mode: 0o600 });
    const value = newValue();
    // Its own process group, killed as a whole after 15 s: a hang (shred opening the FIFO) fails the test, never stalls it.
    const child = spawn("bash", [SCRIPT], { detached: true, env: { PATH: `${w.bin}:${process.env.PATH}`, SR_BYPASS_SETUP_TEST_ROOT: w.t } as unknown as NodeJS.ProcessEnv });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", () => undefined);
    child.stdin.end(`${value}\n`);
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      process.kill(-child.pid!, "SIGKILL");
    }, 15_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    const r = { stdout };
    expect(killed).toBe(false);
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6");
    expect(r.stdout).toContain("BYPASS_TEMP_REMOVED: 1 leftover");
    expect(r.stdout).toContain("BYPASS_TEMP_SKIPPED: 3 entry(ies)");
    expect(readFileSync(w.token, "utf8")).toBe(token);
    expect(statSync(w.token).mode & 0o7777).toBe(0o600);
    expect(leftovers(w).sort()).toEqual([".design-bridge.vercel-bypass.Fifo01", ".design-bridge.vercel-bypass.Hard01", ".design-bridge.vercel-bypass.Lnk001"]);
    expect(readFileSync(w.bypass, "utf8")).toBe(value);
  });

  it("a second setup while one runs → BYPASS_SETUP_LOCKED, nothing done", () => {
    const w = world();
    const lock = join(w.t, "run/sr-bypass-setup.lock");
    mkdirSync(dirname(lock), { recursive: true });
    const r = spawnSync("flock", [lock, "bash", SCRIPT], {
      encoding: "utf8",
      input: `${newValue()}\n`,
      env: { PATH: `${w.bin}:${process.env.PATH}`, SR_BYPASS_SETUP_TEST_ROOT: w.t } as unknown as NodeJS.ProcessEnv,
      timeout: 20_000,
    });
    expect(r.status).toBe(11);
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("BYPASS_SETUP_RESULT BYPASS_SETUP_LOCKED step=1");
    expect(existsSync(w.bypass)).toBe(false);
    expect(readFileSync(w.env, "utf8")).toBe(`SR_DESIGN_BRIDGE_API_URL=${ALIAS}\n`);
    expect(readFileSync(w.calls, "utf8")).toBe("");
    // and once it is free, the same run works
    expect(run(w, [], `${newValue()}\n`).status).toBe(0);
  });

  it("a kept file with a NUL byte is refused, as the bridge refuses it", () => {
    const w = world();
    writeFileSync(w.bypass, Buffer.concat([Buffer.from(newValue()), Buffer.from([0]), Buffer.from("tail")]), { mode: 0o600 });
    const r = run(w);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_VALUE_INVALID step=3");
    expect(r.calls).not.toContain("curl#");
  });

  it("a file that appears between the check and the link → BYPASS_FILE_PRESENT_RACE; that file is kept, no temporary file left", () => {
    const w = world();
    writeFileSync(join(w.sc, "ln-race"), "");
    const r = run(w, [], `${newValue()}\n`);
    expect(r.status).toBe(4);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_FILE_PRESENT_RACE step=3");
    expect(readFileSync(w.bypass, "utf8")).toBe("raced-0123456789abcdef");
    expect(leftovers(w)).toEqual([]);
  });

  it("another link error (no file appeared) → BYPASS_WRITE_FAILED, nothing written, no temporary file left", () => {
    const w = world();
    writeFileSync(join(w.sc, "ln-fail"), "");
    const r = run(w, [], `${newValue()}\n`);
    expect(r.last).toBe("BYPASS_SETUP_RESULT BYPASS_WRITE_FAILED step=3");
    expect(existsSync(w.bypass)).toBe(false);
    expect(leftovers(w)).toEqual([]);
  });

  it("a read that times out discards what was typed (no Enter) → BYPASS_INPUT_TIMEOUT, nothing written", async () => {
    const w = world();
    writeFileSync(join(w.t, "read-timeout"), "1");
    const value = newValue();
    const child = spawn("bash", [SCRIPT], { env: { PATH: `${w.bin}:${process.env.PATH}`, SR_BYPASS_SETUP_TEST_ROOT: w.t } as unknown as NodeJS.ProcessEnv });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", () => undefined);
    child.stdin.write(value); // pasted, Enter never pressed; stdin stays open
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    child.stdin.destroy();
    expect(code).toBe(4);
    expect(stdout.trimEnd().split("\n").pop()).toBe("BYPASS_SETUP_RESULT BYPASS_INPUT_TIMEOUT step=3");
    expect(stdout).not.toContain(value);
    expect(existsSync(w.bypass)).toBe(false);
  });

  const notProtection: [string, number, string][] = [
    ["a Vercel 404 (DEPLOYMENT_NOT_FOUND)", 404, JSON.stringify({ error: { code: "DEPLOYMENT_NOT_FOUND", message: "The deployment could not be found on Vercel." } })],
    ["an HTML 404", 404, "<html>not found</html>"],
    ["a 502 edge error", 502, "An error occurred with your deployment\n\nFUNCTION_INVOCATION_FAILED"],
    ["a 429", 429, JSON.stringify({ error: "too_many_requests" })],
  ];
  it.each(notProtection)("without the bypass: %s is not 'Authentication off' → PROBE_FAILED", (_, status, body) => {
    const w = world();
    answer(w, "without", status, body);
    const r = run(w, [], `${newValue()}\n`);
    expect(r.last).toBe("BYPASS_SETUP_RESULT PROBE_FAILED step=5");
    expect(r.stdout).not.toContain("WARNING");
    expect(curlCalls(r.calls, "with")).toHaveLength(0);
  });

  it("with the bypass: Vercel's protection body on a status other than 401 → PROBE_FAILED, not BYPASS_REJECTED", () => {
    const w = world();
    answer(w, "with", 403, VERCEL_401);
    expect(run(w, [], `${newValue()}\n`).last).toBe("BYPASS_SETUP_RESULT PROBE_FAILED step=5");
  });
});

describe("setup-vercel-bypass.sh: the documented human step", () => {
  it("design-bridge-access.md §6 is the one command (the hand-pasted snippet is gone), §8 rotates with --replace", () => {
    const doc = readFileSync(join(REPO, "docs/operations/design-bridge-access.md"), "utf8");
    const s6 = doc.slice(doc.indexOf("## 6."), doc.indexOf("## 7."));
    const s8 = doc.slice(doc.indexOf("## 8."), doc.indexOf("## 9."));
    expect(s6).toContain("sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh\n");
    expect(s6).toContain("Second Root design bridge (WSL)");
    expect(s6).not.toMatch(/read -rs|printf "%s" "\$v"/);
    expect(s8).toContain("setup-vercel-bypass.sh --replace");
    expect(doc).toContain("npm run staging:bypass-status");
    expect(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts["staging:bypass-status"]).toBe("NODE_USE_ENV_PROXY=1 node scripts/staging/vercel-bypass-status.mjs");
  });
});

describe("setup-vercel-bypass.sh: what it never does", () => {
  it("never calls Vercel's API, systemctl, Supabase or a flag; the value is never exported or put on curl's command line", () => {
    const text = readFileSync(SCRIPT, "utf8");
    const code = text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/api\.vercel\.com|systemctl|supabase|SALES_AI_DESIGN_ENABLED/);
    // the value is never exported and never on a command line of its own
    expect(code).not.toMatch(/export\s+[^\n]*BYPASS_VALUE|declare\s+-x|set\s+-a/);
    expect(code).not.toMatch(/curl[^\n]*BYPASS_VALUE/);
  });
});
