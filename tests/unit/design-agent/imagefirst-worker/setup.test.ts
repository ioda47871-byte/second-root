import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { exe, ID, PILOT, PREFLIGHT, SCRIPTS } from "./pilot-world";
import { cleanupTemps, commitFiles, git, REPO as REPO_ROOT, sha, tmp } from "./support";

// Issue #302: the owner's bundled one-time setup (scripts/sales-design-worker/imagefirst-autorun-setup.sh), the real file,
// against a fake WSL under SR_IMAGEFIRST_SETUP_TEST_ROOT: a temporary /usr, /etc, /var/lib, /root and /home; a stand-in for
// root's admin clone (a clone of a temporary bare origin, detached); a fake registry of four tarballs in npm's shape (curl's
// stand-in copies them by the URL's file name; the test world's own sha512 / SHA-256 pins in <root>/test-pins); an npm stub
// (at the test root's /usr/bin/npm) that installs a local tarball as npm does; systemctl / systemd-run stubs that log every
// call. No root, no systemd, no network, no npm registry, no model CLI.

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanupTemps, 60_000);
const SETUP = join(SCRIPTS, "imagefirst-autorun-setup.sh");
const CODEX_CONFIG_REPO = join(SCRIPTS, "codex-config.toml");
const UNIT_SRC = join(SCRIPTS, "systemd");
const UNITS = ["sr-imagefirst-autorun.service", "sr-imagefirst-autorun.timer"];
const PKG = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" } as const;
const VER = { claude: "2.1.295", codex: "0.159.0" } as const;
const TGZS = ["claude", "claude_native", "codex", "codex_native"] as const;
type Tgz = (typeof TGZS)[number];
const TGZ_URL: Record<Tgz, string> = {
  claude: "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.295.tgz",
  claude_native: "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.295.tgz",
  codex: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.0.tgz",
  codex_native: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.0-linux-x64.tgz",
};
const fileOf = (t: Tgz) => TGZ_URL[t].split("/").pop()!;
/** DEV-303: the files the scripts step installs (the setup's own list). */
const installFiles = () => /^INSTALL_FILES=\(\n([\s\S]*?)\n\)$/m.exec(readFileSync(join(SCRIPTS, "imagefirst-autorun-setup.sh"), "utf8"))![1]!.split("\n").map((l) => l.trim());
const CLEAN_ENV = / env=HOME,LANG,PATH,(PWD,)?(SHLVL,)?(_,)?$/;

function world() {
  const base = tmp("sr-ifs-");
  const R = join(base, "R");
  const sc = join(base, "sc");
  const bin = join(base, "bin");
  const home = join(R, "home", "sr-designgen");
  for (const d of [sc, bin, join(R, "usr", "bin"), join(R, "usr", "local", "bin"), join(R, "usr", "local", "lib"), join(R, "etc", "systemd", "system"), join(R, "var", "lib"), join(R, "root"), join(home, ".npm-global", "bin"), join(home, ".local", "bin")]) mkdirSync(d, { recursive: true, mode: 0o755 });
  // the machine as it is today: root's symlinks /usr/local/bin/{claude,codex} into the worker's home
  const oldTargets = { claude: join(home, ".npm-global", "bin", "claude"), codex: join(home, ".local", "bin", "codex") };
  for (const [name, target] of Object.entries(oldTargets)) {
    writeFileSync(target, `#!/bin/sh\necho ${name} must never run >> '${sc}/model-cli.log'\nexit 97\n`, { mode: 0o755 });
    symlinkSync(target, join(R, "usr", "local", "bin", name));
  }
  // root's node (never executed: a placeholder) and the npm stub: it installs a local tarball as npm does (the package dir
  // from package/, the bin link from package.json) and records how it was run; npm-tamper changes an installed file.
  // Two real npm 11 behaviours (seen with npm 11.19.0): one file given as both --userconfig and --globalconfig (/dev/null
  // twice too) exits 1 before anything ("double-loading config"); and a global install, --omit=optional or not, also nests
  // the optional native packages unless --os / --cpu exclude this platform (linux / x64). npm-fail: npm's noisy failure
  // with token-like strings in its output.
  writeFileSync(join(R, "usr", "bin", "node"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  exe(
    join(R, "usr", "bin", "npm"),
    `echo "npm $* HOME=$HOME umask=$(umask) env=$(env | cut -d= -f1 | LC_ALL=C sort | tr '\\n' ,)" >> '${sc}/npm.log'
cmd="$1"; shift; prefix=""; args=(); ucfg=""; gcfg=""; os=linux; cpu=x64
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2 ;; --userconfig) ucfg="$2"; shift 2 ;; --globalconfig) gcfg="$2"; shift 2 ;;
  --os=*) os="\${1#--os=}"; shift ;; --cpu=*) cpu="\${1#--cpu=}"; shift ;; -*) shift ;; *) args+=("$1"); shift ;; esac; done
if [ -n "$ucfg" ] && [ -n "$gcfg" ] && [ "$(readlink -f -- "$ucfg")" = "$(readlink -f -- "$gcfg")" ]; then
  printf 'npm error Exit prior to config file resolving\nnpm error cause\nnpm error double-loading config "%s" as "global", previously loaded as "user"\n' "$gcfg" >&2
  exit 1
fi
for c in "$ucfg" "$gcfg"; do
  [ -n "$c" ] || continue
  if [ -L "$c" ]; then t=link; elif [ -f "$c" ]; then t=file; else t=other; fi
  echo "cfg $cmd $c type=$t mode=$(stat -c %a -- "$c") size=$(stat -L -c %s -- "$c") dirmode=$(stat -c %a -- "$(dirname -- "$c")")" >> '${sc}/npm-cfg.log'
done
if [ -f '${sc}/npm-fail' ]; then
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22; do echo "npm http fetch filler line $i"; done
  echo "npm error code ETARGET" >&2
  echo "npm error //registry.npmjs.org/:_authToken=npm_SECRETAUTH123" >&2
  echo "npm error Authorization: Bearer sk-SECRETBEARER456" >&2
  echo "npm error fetch https://bob:SECRETPASS789@registry.example/x.tgz" >&2
  echo "npm error token=SECRETTOKEN000 refused" >&2
  echo "npm error A complete log of this run can be found in: /root/.npm/_logs/x.log" >&2
  exit 1
fi
for a in "\${args[@]}"; do
  if [ "$cmd" = install ]; then
    meta="$(tar -xzOf "$a" package/package.json | python3 -I -c 'import json, sys; d = json.load(sys.stdin); k = list(d["bin"])[0]; print(d["name"], k, d["bin"][k])')"
    read -r name b rel <<<"$meta"
    d="$prefix/lib/node_modules/$name"
    # as npm: an entry of another package in the way is an error (EEXIST)
    if [ -e "$prefix/bin/$b" ] || [ -L "$prefix/bin/$b" ]; then case "$(readlink -f "$prefix/bin/$b")" in "$d"/*) ;; *) echo "EEXIST $prefix/bin/$b" >&2; exit 1 ;; esac; fi
    rm -rf "$d"; mkdir -p "$d"; tar -xzf "$a" -C "$d" --strip-components=1; chmod 755 "$d/$rel"; ln -sfn "../lib/node_modules/$name/$rel" "$prefix/bin/$b"
    if [ -f '${sc}/npm-tamper' ]; then echo tampered >> "$d/package.json"; fi
    if [ -f '${sc}/npm-extra' ]; then echo extra > "$d/extra.js"; fi
    if [ "$os" = linux ] && [ "$cpu" = x64 ]; then
      case "$name" in @anthropic-ai/claude-code) n=@anthropic-ai/claude-code-linux-x64 ;; *) n=@openai/codex-linux-x64 ;; esac
      mkdir -p "$d/node_modules/$n"; echo '{"name":"'"$n"'"}' > "$d/node_modules/$n/package.json"
    fi
  else
    case "$a" in @anthropic-ai/claude-code) b=claude ;; @openai/codex) b=codex ;; *) exit 2 ;; esac
    rm -rf "$prefix/lib/node_modules/$a"; rm -f "$prefix/bin/$b"
  fi
done`,
  );
  // the registry: four tarballs in npm's shape; curl's stand-in copies one by the URL's file name
  const registry = join(base, "registry");
  mkdirSync(registry);
  exe(
    join(bin, "curl"),
    `echo "curl $* env=$(env | cut -d= -f1 | LC_ALL=C sort | tr '\\n' ,)" >> '${sc}/curl.log'
out=""; url=""; max=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --max-filesize) max="$2"; shift 2 ;; --proto|--proto-redir) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
f='${registry}'/"\${url##*/}"
[ -f "$f" ] || exit 22
# as curl: a file over --max-filesize is refused (exit 63)
if [ -n "$max" ] && [ "$(stat -c %s "$f")" -gt "$max" ]; then exit 63; fi
cp "$f" "$out"`,
  );
  // df's stand-in: the real df, or (df-small) a filesystem with 10 MiB free
  exe(join(bin, "df"), `if [ -f '${sc}/df-small' ]; then printf 'Filesystem 1048576-blocks Used Available Capacity Mounted on\\n/dev/x 100 90 10 90%% /\\n'; exit 0; fi\nexec /usr/bin/df "$@"`);
  const elf = (fill: number) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(1_200_000, fill)]);
  const natives = { claude: elf(1), codex: elf(2) };
  const trees: Record<Tgz, Record<string, Buffer>> = {
    claude: {
      "package.json": Buffer.from(JSON.stringify({ name: PKG.claude, version: VER.claude, bin: { claude: "bin/claude.exe" }, scripts: { postinstall: "node install.cjs" } })),
      "bin/claude.exe": Buffer.from('echo "Error: claude native binary not installed." >&2\nexit 1\n'),
      "install.cjs": Buffer.from("throw new Error('never run')\n"),
    },
    claude_native: { "package.json": Buffer.from(JSON.stringify({ name: "@anthropic-ai/claude-code-linux-x64", version: VER.claude })), claude: natives.claude },
    codex: { "package.json": Buffer.from(JSON.stringify({ name: PKG.codex, version: VER.codex, bin: { codex: "bin/codex.js" } })), "bin/codex.js": Buffer.from("#!/usr/bin/env node\n") },
    codex_native: { "package.json": Buffer.from(JSON.stringify({ name: PKG.codex, version: `${VER.codex}-linux-x64` })), "vendor/x86_64-unknown-linux-musl/bin/codex": natives.codex },
  };
  const pins: Record<string, string> = { BIN_claude: sha(natives.claude), BIN_codex: sha(natives.codex) };
  const writePins = () => writeFileSync(join(R, "test-pins"), Object.entries(pins).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o644 });
  /** (Re)build one tarball from its tree (extra: a step in its package dir before packing) and pin its sha512. */
  const pack = (t: Tgz, extra?: (dir: string) => void, tarArgs: string[] = []) => {
    const dir = join(base, "build", t);
    rmSync(dir, { recursive: true, force: true });
    for (const [rel, body] of Object.entries(trees[t])) {
      mkdirSync(dirname(join(dir, "package", rel)), { recursive: true, mode: 0o755 });
      writeFileSync(join(dir, "package", rel), body, { mode: 0o755 });
    }
    extra?.(join(dir, "package"));
    const out = join(registry, fileOf(t));
    const r = spawnSync("tar", ["-czf", out, ...tarArgs, "-C", dir, "package"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    pins[`SRI_${t}`] = `sha512-${createHash("sha512").update(readFileSync(out)).digest("base64")}`;
    pins[`SIZE_${t}`] = String(statSync(out).size);
    writePins();
  };
  for (const t of TGZS) pack(t);
  exe(
    join(bin, "systemctl"),
    `echo "$*" >> '${sc}/systemctl.log'; u="\${@: -1}"
case "$1" in
  show) f='${sc}'/"$3-$u"; if [ -f "$f" ]; then cat "$f"; exit 0; fi
    case "$3" in ActiveState) echo inactive ;; LoadState) if [ -f '${R}/etc/systemd/system/'"$u" ]; then echo loaded; else echo not-found; fi ;; NeedDaemonReload) echo no ;; *) echo ;; esac ;;
  is-enabled) if [ -f '${sc}'/enabled-"$u" ]; then cat '${sc}'/enabled-"$u"; [ "$(cat '${sc}'/enabled-"$u")" = enabled ]; exit; fi
    if [ -f '${R}/etc/systemd/system/'"$u" ]; then echo disabled; else echo not-found; fi; exit 1 ;;
  enable) [ -f '${sc}/enable-fail' ] && exit 1; echo enabled > '${sc}'/enabled-"$u" ;;
  disable) echo disabled > '${sc}'/enabled-"$u"; echo inactive > '${sc}'/ActiveState-"$u" ;;
  daemon-reload) if [ -f '${sc}/reload-fail' ]; then exit 1; fi ;;
  list-timers) echo "Sun 2026-11-22 10:10:00 UTC 4min left - - $u sr-imagefirst-autorun.service" ;;
  *) exit 1 ;;
esac`,
  );
  exe(
    join(bin, "systemd-run"),
    `printf '%s\\n' "$@" > '${sc}/systemd-run.args'; echo "$*" >> '${sc}/systemd-run.log'
if [ -f '${sc}/hardening-fail' ]; then echo "admin.sh: line 12: /root/x: Read-only file system"; exit 1; fi
printf 'drwx------ sr-designgen:sr-designgen /home/sr-designgen\\napproved: none\\nnode: none\\njail: enabled / active\\njail network rules:\\n'`,
  );
  // origin and root's admin clone, detached at origin's develop
  const src = tmp("sr-ifs-src-");
  git(src, "init", "-q", "-b", "develop");
  commitFiles(src, { "README.md": Buffer.from("x\n") }, "init (test)");
  const origin = join(base, "origin.git");
  git(base, "init", "-q", "--bare", origin);
  git(src, "push", "-q", origin, "HEAD:refs/heads/develop");
  const admin = join(R, "root", "sr-capture-admin");
  git(base, "clone", "-q", "--branch", "develop", origin, admin);
  git(admin, "checkout", "-q", "--detach", "origin/develop");
  const head = git(admin, "rev-parse", "HEAD");
  const state = join(R, "var", "lib", "sr-imagefirst-autostart");
  const etc = join(R, "etc", "sr-design-worker");
  // proxy / CA / npm variables in the caller's environment must never reach npm or curl
  const env = {
    PATH: [bin, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    SR_IMAGEFIRST_SETUP_TEST_ROOT: R,
    HTTPS_PROXY: "http://proxy.invalid:1",
    http_proxy: "http://proxy.invalid:1",
    NODE_EXTRA_CA_CERTS: "/tmp/x.pem",
    SSL_CERT_FILE: "/tmp/x.pem",
    npm_config_registry: "http://registry.invalid",
  } as unknown as NodeJS.ProcessEnv;
  const run = (args: string[]) => {
    const r = spawnSync("bash", [SETUP, ...args], { env, encoding: "utf8", timeout: 100_000 });
    const last = r.stdout.trim().split("\n").pop() ?? "";
    const m = /^IMAGEFIRST_SETUP (\S+) exit=(\d+)$/.exec(last);
    expect(m, r.stdout + r.stderr).not.toBeNull();
    expect(Number(m![2]), r.stdout + r.stderr).toBe(r.status);
    expect(existsSync(join(sc, "model-cli.log")), "a claude / codex binary was started").toBe(false);
    const steps: Record<string, { state: string; why: string }> = {};
    for (const x of r.stdout.matchAll(/^SETUP_STEP (\S+) (DONE|TODO|BLOCKED) (.*)$/gm)) steps[x[1]!] = { state: x[2]!, why: x[3]! };
    return { status: r.status, code: m![1]!, stdout: r.stdout, steps };
  };
  const lines = (f: string) => (existsSync(join(sc, f)) ? readFileSync(join(sc, f), "utf8").trim().split("\n").filter(Boolean) : []);
  /** Every path under the test root: type, mode, size, mtime, link target, content hash. */
  const snapshot = () => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        const s = lstatSync(p);
        const k = p.slice(R.length);
        if (s.isSymbolicLink()) out[k] = `link ${readlinkSync(p)}`;
        else if (s.isDirectory()) { out[k] = `dir ${s.mode.toString(8)} ${s.mtimeMs}`; walk(p); }
        else out[k] = `file ${s.mode.toString(8)} ${s.size} ${s.mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
      }
    };
    walk(R);
    return out;
  };
  const allDone = (steps: Record<string, { state: string }>) => Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.state]));
  const nm = (...p: string[]) => join(R, "usr", "local", "lib", "node_modules", ...p);
  return { base, R, sc, bin, home, admin, origin, src, head, state, etc, oldTargets, registry, natives, trees, pins, pack, writePins, run, lines, snapshot, allDone, nm };
}
type World = ReturnType<typeof world>;
const DONE4 = { cli: "DONE", codex_config: "DONE", scripts: "DONE", units: "DONE", hardening_check: "DONE" };
const apply = (w: World) => w.run(["apply", "--yes", "--expect", w.head]);
/** Nothing of the CLIs changed: the old links in place, no package, no npm call, no download dir left. */
const cliUntouched = (w: World) => {
  for (const name of ["claude", "codex"] as const) expect(readlinkSync(join(w.R, "usr", "local", "bin", name))).toBe(w.oldTargets[name]);
  expect(existsSync(w.nm())).toBe(false);
  expect(w.lines("npm.log")).toEqual([]);
  if (existsSync(w.state)) expect(readdirSync(w.state).filter((n) => n.startsWith("setup-download"))).toEqual([]);
};

describe("Issue #302 one-time setup: check is read-only", () => {
  it("on today's machine: every step TODO, CHECK_OK, nothing written anywhere, only systemctl show / is-enabled", () => {
    const w = world();
    const before = w.snapshot();
    const r = w.run(["check", "--expect", w.head]);
    expect(r).toMatchObject({ status: 0, code: "CHECK_OK" });
    expect(w.allDone(r.steps)).toEqual({ cli: "TODO", codex_config: "TODO", scripts: "TODO", units: "TODO", hardening_check: "TODO" });
    expect(r.steps.cli!.why).toContain(`claude: /usr/local/bin/claude -> ${w.oldTargets.claude}`);
    expect(r.stdout).toContain(`codex-config.toml SHA-256 ${sha(readFileSync(CODEX_CONFIG_REPO))}`);
    expect(w.snapshot()).toEqual(before);
    expect(existsSync(w.state)).toBe(false);
    for (const l of w.lines("systemctl.log")) expect(l).toMatch(/^(show -p \S+ --value|is-enabled) \S+$/);
    expect(w.lines("npm.log")).toEqual([]);
    expect(w.lines("curl.log")).toEqual([]);
    expect(w.lines("systemd-run.log")).toEqual([]);
    // the default mode is check
    expect(w.run(["--expect", w.head])).toMatchObject({ status: 0, code: "CHECK_OK" });
    expect(w.snapshot()).toEqual(before);
  });
});

describe("Issue #302 one-time setup: refusals (nothing changed)", () => {
  it("usage, no --yes, no / malformed --expect, a check with --yes, an unknown mode", () => {
    const w = world();
    const before = w.snapshot();
    expect(w.run(["apply", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_NEEDS_YES" });
    expect(w.run(["enable-timer", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_NEEDS_YES" });
    expect(w.run(["rollback", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_NEEDS_YES" });
    expect(w.run(["apply", "--yes"])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["rollback", "--yes"])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["check"])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["apply", "--yes", "--expect", w.head.slice(0, 12)])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["apply", "--yes", "--expect", w.head.toUpperCase()])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["check", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    expect(w.run(["install", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    expect(w.run(["apply", "--yes", "--expect", w.head, "--force"])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    expect(w.snapshot()).toEqual(before);
    expect(w.lines("npm.log")).toEqual([]);
  });

  it("a wrong --expect, develop moved on, a dirty or attached admin clone", () => {
    const w = world();
    const before = w.snapshot();
    expect(w.run(["apply", "--yes", "--expect", "a".repeat(40)])).toMatchObject({ status: 2, code: "SETUP_ADMIN_NOT_EXPECTED" });
    // develop moved on: the admin clone still at the old commit, which is no longer origin's develop
    commitFiles(w.src, { "docs/x.md": Buffer.from("x") }, "merged (test)");
    git(w.src, "push", "-q", w.origin, "HEAD:refs/heads/develop");
    const moved = w.run(["apply", "--yes", "--expect", w.head]);
    expect(moved).toMatchObject({ status: 2, code: "SETUP_EXPECT_NOT_DEVELOP" });
    expect(w.run(["check", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_EXPECT_NOT_DEVELOP" });
    git(w.src, "push", "-q", "--force", w.origin, `${w.head}:refs/heads/develop`);
    writeFileSync(join(w.admin, "stray.txt"), "x");
    expect(w.run(["apply", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_ADMIN_CLONE_DIRTY" });
    expect(w.run(["check", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_ADMIN_CLONE_DIRTY" });
    rmSync(join(w.admin, "stray.txt"));
    git(w.admin, "checkout", "-q", "-B", "develop");
    expect(w.run(["apply", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_ADMIN_NOT_DETACHED" });
    git(w.admin, "checkout", "-q", "--detach");
    git(w.admin, "branch", "-q", "-D", "develop");
    expect(w.run(["check", "--expect", w.head])).toMatchObject({ status: 0, code: "CHECK_OK" });
    const after = w.snapshot();
    // only the admin clone changed (the test's stray file, checkout -B / branch -D), nothing the setup owns
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (!k.startsWith("/root/sr-capture-admin")) expect(after[k], k).toBe(before[k]);
    expect(w.lines("npm.log")).toEqual([]);
    expect(w.lines("systemd-run.log")).toEqual([]);
  });

  it("an unexpected /usr/local/bin/claude (a link elsewhere, a regular file, a link with ..): BLOCKED, nothing touched", () => {
    const w = world();
    const slot = join(w.R, "usr", "local", "bin", "claude");
    mkdirSync(join(w.R, "opt"));
    writeFileSync(join(w.R, "opt", "claude"), "x", { mode: 0o755 });
    const variants: [string, () => void][] = [
      ["a link outside the worker's home", () => symlinkSync(join(w.R, "opt", "claude"), slot)],
      ["a regular file", () => writeFileSync(slot, "x", { mode: 0o755 })],
      ["a link through ..", () => symlinkSync(join(w.home, "..", "..", "opt", "claude"), slot)],
    ];
    for (const [what, make] of variants) {
      rmSync(slot, { force: true });
      make();
      const before = w.snapshot();
      const c = w.run(["check", "--expect", w.head]);
      expect(c, what).toMatchObject({ status: 3, code: "CHECK_BLOCKED" });
      expect(c.steps.cli!.state, what).toBe("BLOCKED");
      const a = apply(w);
      expect(a, what).toMatchObject({ status: 3, code: "SETUP_BLOCKED" });
      expect(w.snapshot(), what).toEqual(before);
    }
    expect(w.lines("npm.log")).toEqual([]);
    expect(w.lines("curl.log")).toEqual([]);
    expect(w.lines("systemd-run.log")).toEqual([]);
    expect(w.lines("systemctl.log").filter((l) => !/^(show|is-enabled) /.test(l))).toEqual([]);
  });
});

describe("Issue #302 one-time setup: the pinned tarballs (no vendor code runs as root)", () => {
  it("the production pins refuse any other tarball: the download is verified before anything changes", () => {
    const w = world();
    rmSync(join(w.R, "test-pins"));
    const r = apply(w);
    expect(r).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(r.stdout).toContain(`${TGZ_URL.claude} is not the pinned tarball`);
    cliUntouched(w);
    expect(w.lines("curl.log")).toHaveLength(1);
  });

  it("a changed tarball (one byte), a missing one, or a member that is a symlink: refused, nothing changed", () => {
    const w = world();
    const f = join(w.registry, fileOf("codex_native"));
    const good = readFileSync(f);
    const bad = Buffer.from(good);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    writeFileSync(f, bad);
    expect(apply(w)).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    cliUntouched(w);
    rmSync(f);
    expect(apply(w).stdout).toContain(`the download of ${TGZ_URL.codex_native} failed`);
    cliUntouched(w);
    // pinned, but with a symlink member: refused by the member check
    w.pack("codex_native", (dir) => symlinkSync("/etc/passwd", join(dir, "vendor", "link")));
    const m = apply(w);
    expect(m).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(m.stdout).toContain("not a plain file or directory under package/");
    cliUntouched(w);
  });

  it("a native binary that is not the pinned one inside a pinned tarball, or a tampered npm install: refused", () => {
    const w = world();
    w.trees.claude_native.claude = Buffer.concat([w.natives.claude, Buffer.from("x")]);
    w.pack("claude_native");
    expect(apply(w).stdout).toContain("the native claude in the verified tarball is not the pinned binary");
    cliUntouched(w);
    w.trees.claude_native.claude = w.natives.claude;
    w.pack("claude_native");
    writeFileSync(join(w.sc, "npm-tamper"), "");
    const t = apply(w);
    expect(t).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(t.stdout).toContain("package.json is not the verified tarball's");
  });
});

describe("Issue #302 one-time setup: size, space, extra files, special mode bits (PR #328 round 2)", () => {
  it("too little free space in the state dir's filesystem: SETUP_BLOCKED before any download", () => {
    const w = world();
    writeFileSync(join(w.sc, "df-small"), "");
    const r = apply(w);
    expect(r).toMatchObject({ status: 3, code: "SETUP_BLOCKED" });
    expect(r.stdout).toContain("10 MiB free");
    expect(r.stdout).toContain("need 1024 MiB");
    expect(w.lines("curl.log")).toEqual([]);
    cliUntouched(w);
  });

  it("a tarball larger than its pinned size: curl stops it (--max-filesize), nothing changed", () => {
    const w = world();
    // an incompressible 64 KiB inside, so the tarball is far over 100 + 4096 bytes
    w.pack("codex_native", (dir) => writeFileSync(join(dir, "padding.bin"), randomBytes(65536)));
    w.pins.SIZE_codex_native = "100";
    w.writePins();
    const r = apply(w);
    expect(r).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(r.stdout).toContain("larger than the pinned 100 bytes");
    expect(w.lines("curl.log").pop()).toContain("--max-filesize 4196 ");
    cliUntouched(w);
  });

  it("an installed package dir with a file that is not in its tarball: refused", () => {
    const w = world();
    writeFileSync(join(w.sc, "npm-extra"), "");
    const r = apply(w);
    expect(r).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(r.stdout).toContain("holds entries that are not in the verified tarball: extra.js");
  });

  it("a member with a setuid, setgid or sticky bit is refused; after placing, the bits are cleared as a second guard", () => {
    const w = world();
    // the archive's member modes (tar --mode: this test user may not set a setuid bit on a real file)
    for (const mode of ["u+s", "g+s", "+t"]) {
      w.pack("codex", undefined, [`--mode=${mode}`]);
      const r = apply(w);
      expect(r, mode).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
      expect(r.stdout, mode).toContain("setuid / setgid / sticky bit");
      cliUntouched(w);
    }
    w.pack("codex");
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(readFileSync(join(w.state, "setup.log"), "utf8")).toContain(` apply chmod -R u-s,g-s,-t ${w.nm(PKG.claude)} ${w.nm(PKG.codex)}\n`);
    for (const f of [w.nm(PKG.claude, "bin", "claude.exe"), w.nm(PKG.codex, "bin", "codex.js")]) expect(statSync(f).mode & 0o7000, f).toBe(0);
  });

  it("a rollback that fails after restoring the links can be run again and completes", () => {
    const w = world();
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    writeFileSync(join(w.sc, "reload-fail"), "");
    const first = w.run(["rollback", "--yes", "--expect", w.head]);
    expect(first).toMatchObject({ status: 35, code: "ROLLBACK_INCOMPLETE" });
    for (const name of ["claude", "codex"] as const) expect(readlinkSync(join(w.R, "usr", "local", "bin", name))).toBe(w.oldTargets[name]);
    rmSync(join(w.sc, "reload-fail"));
    const second = w.run(["rollback", "--yes", "--expect", w.head]);
    expect(second, second.stdout).toMatchObject({ status: 0, code: "ROLLBACK_DONE" });
    expect(second.stdout).toContain("already points to");
    expect(readFileSync(join(w.state, "setup.log"), "utf8")).toMatch(/ rollback done ok=1\n$/);
  });
});

describe("Issue #302 one-time setup: apply", () => {
  it("installs the pinned CLIs root-owned, the config, the units and the switch; runs check 1; never enables the timer; idempotent", () => {
    const w = world();
    // the old hourly automatic start is installed and enabled: apply disables it
    writeFileSync(join(w.sc, "LoadState-sr-imagefirst-autostart.timer"), "loaded");
    writeFileSync(join(w.sc, "enabled-sr-imagefirst-autostart.timer"), "enabled");
    const r = apply(w);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(w.allDone(r.steps)).toEqual(DONE4);
    // the four downloads: https only, curl's config ignored (-q first), a clean environment (no proxy / CA variable)
    const curl = w.lines("curl.log");
    expect(curl).toHaveLength(4);
    for (const [i, t] of TGZS.entries()) {
      expect(curl[i]).toMatch(new RegExp(`^curl -q -fsSL --proto =https --proto-redir =https --max-filesize ${Number(w.pins[`SIZE_${t}`]) + 4096} -o \\S+/setup-download\\.\\w+/${t}\\.tgz ${TGZ_URL[t].replace(/[.]/g, "\\.")}`));
      expect(curl[i]).toMatch(CLEAN_ENV);
    }
    // npm: once, from the two verified local tarballs, scripts ignored, optional dependencies not fetched, no npm config,
    // HOME=/root, umask 022, a clean environment
    const npm = w.lines("npm.log");
    expect(npm).toHaveLength(1);
    expect(npm[0]).toMatch(new RegExp(`^npm install -g --prefix ${w.R}/usr/local --userconfig ${w.state}/setup-npmrc\\.\\w+/userconfig --globalconfig ${w.state}/setup-npmrc\\.\\w+/globalconfig --no-audit --no-fund --no-update-notifier --loglevel=error --os=sr-none --cpu=sr-none --ignore-scripts --omit=optional \\S+/setup-download\\.\\w+/claude\\.tgz \\S+/setup-download\\.\\w+/codex\\.tgz HOME=${w.R}/root umask=0022 `));
    expect(npm[0]).toMatch(CLEAN_ENV);
    expect(readdirSync(w.state).filter((n) => n.startsWith("setup-download"))).toEqual([]);
    for (const name of ["claude", "codex"] as const) {
      expect(JSON.parse(readFileSync(w.nm(PKG[name], "package.json"), "utf8"))).toMatchObject({ name: PKG[name], version: VER[name] });
      // the worker's own CLIs are untouched
      expect(readFileSync(w.oldTargets[name], "utf8")).toContain("must never run");
    }
    // claude: what the skipped postinstall did, done by the script (the native binary over the placeholder, 0755)
    expect(realpathSync(join(w.R, "usr", "local", "bin", "claude"))).toBe(w.nm(PKG.claude, "bin", "claude.exe"));
    expect(readFileSync(w.nm(PKG.claude, "bin", "claude.exe"))).toEqual(w.natives.claude);
    expect(statSync(w.nm(PKG.claude, "bin", "claude.exe")).mode & 0o777).toBe(0o755);
    // codex: its native package where npm puts the optional dependency
    expect(realpathSync(join(w.R, "usr", "local", "bin", "codex"))).toBe(w.nm(PKG.codex, "bin", "codex.js"));
    expect(readFileSync(w.nm(PKG.codex, "node_modules", "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex"))).toEqual(w.natives.codex);
    // the reviewed Codex config, the units, the switch
    expect(sha(readFileSync(join(w.etc, "codex-config.toml")))).toBe(sha(readFileSync(CODEX_CONFIG_REPO)));
    expect(statSync(join(w.etc, "codex-config.toml")).mode & 0o777).toBe(0o644);
    expect(statSync(w.etc).mode & 0o777).toBe(0o755);
    for (const u of UNITS) {
      expect(readFileSync(join(w.R, "etc", "systemd", "system", u))).toEqual(readFileSync(join(UNIT_SRC, u)));
      expect(statSync(join(w.R, "etc", "systemd", "system", u)).mode & 0o777).toBe(0o644);
    }
    expect(JSON.parse(readFileSync(join(w.etc, "imagefirst-autostart.json"), "utf8"))).toEqual({ enabled: true });
    expect(statSync(join(w.etc, "imagefirst-autostart.json")).mode & 0o777).toBe(0o644);
    // systemctl: the old timer disabled, daemon-reload, and never an enable
    const scl = w.lines("systemctl.log");
    expect(scl).toContain("disable --now sr-imagefirst-autostart.timer");
    expect(scl).toContain("daemon-reload");
    expect(scl.filter((l) => l.startsWith("enable"))).toEqual([]);
    expect(existsSync(join(w.sc, "enabled-sr-imagefirst-autorun.timer"))).toBe(false);
    // check 1: once, admin.sh status
    const hr = w.lines("systemd-run.log");
    expect(hr).toHaveLength(1);
    expect(hr[0]).toMatch(/^--wait --pipe --collect -p .* \/usr\/bin\/bash \S+\/scripts\/sales-design-capture\/admin\.sh status$/);
    // root's log: 0600 in a 0700 state dir, with what the old links pointed to and what apply changed
    expect(statSync(w.state).mode & 0o777).toBe(0o700);
    expect(statSync(join(w.state, "setup.log")).mode & 0o777).toBe(0o600);
    const log = readFileSync(join(w.state, "setup.log"), "utf8");
    expect(log).toContain(`apply OLD_LINK claude -> ${w.oldTargets.claude}\n`);
    expect(log).toContain(`apply OLD_LINK codex -> ${w.oldTargets.codex}\n`);
    for (const s of ["cli", "codex_config", "scripts", "units", "hardening_check"]) expect(log).toContain(` apply APPLIED ${s}\n`);
    // DEV-303: root's scripts installed (root's files, byte-identical, 0755 scripts / 0644 data, 0755 dirs) with SHA256SUMS
    const inst = join(w.R, "usr", "local", "lib", "sr-imagefirst");
    const files = installFiles();
    for (const rel of files) {
      expect(readFileSync(join(inst, rel)), rel).toEqual(readFileSync(join(REPO_ROOT, rel)));
      expect(statSync(join(inst, rel)).mode & 0o777, rel).toBe(rel.endsWith(".sh") ? 0o755 : 0o644);
      expect(log, rel).toContain(` apply installed /usr/local/lib/sr-imagefirst/${rel} sha256=${sha(readFileSync(join(REPO_ROOT, rel)))}\n`);
    }
    for (const d of [inst, join(inst, "scripts"), join(inst, "scripts", "sales-design-capture", "jail")]) expect(statSync(d).mode & 0o777, d).toBe(0o755);
    expect(readFileSync(join(inst, "SHA256SUMS"), "utf8")).toBe(files.map((rel) => `${sha(readFileSync(join(REPO_ROOT, rel)))}  ${rel}\n`).join(""));
    expect(statSync(join(inst, "SHA256SUMS")).mode & 0o777).toBe(0o644);
    // check 1 runs the INSTALLED admin.sh
    expect(hr[0]).toContain(` /usr/bin/bash ${inst}/scripts/sales-design-capture/admin.sh status`);
    expect(r.stdout).toContain("The timer is NOT enabled");

    // a second apply: every step DONE, nothing run again
    const before = w.snapshot();
    const again = apply(w);
    expect(again).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(w.allDone(again.steps)).toEqual(DONE4);
    expect(again.stdout).toContain("nothing to do");
    expect(w.lines("npm.log")).toHaveLength(1);
    expect(w.lines("curl.log")).toHaveLength(4);
    expect(w.lines("systemd-run.log")).toHaveLength(1);
    expect(w.lines("systemctl.log").filter((l) => !/^(show|is-enabled) /.test(l))).toEqual(["disable --now sr-imagefirst-autostart.timer", "daemon-reload"]);
    // only the log (and its lock) moved
    const after = w.snapshot();
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (!/^\/var\/lib\/sr-imagefirst-autostart(\/setup\.(log|lock))?$/.test(k)) expect(after[k], k).toBe(before[k]);
    const c = w.run(["check", "--expect", w.head]);
    expect(c).toMatchObject({ status: 0, code: "CHECK_OK" });
    expect(w.allDone(c.steps)).toEqual(DONE4);
  });

  it("cli is DONE only with the real native binaries: the placeholder, a short ELF or another binary is TODO", () => {
    const w = world();
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    const exe_ = w.nm(PKG.claude, "bin", "claude.exe");
    const native = w.nm(PKG.codex, "node_modules", "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex");
    const variants: [string, string, Buffer][] = [
      ["the claude placeholder", exe_, w.trees.claude["bin/claude.exe"]!],
      ["a short ELF", exe_, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3])],
      ["another codex binary", native, Buffer.concat([w.natives.codex, Buffer.from("x")])],
    ];
    for (const [what, f, body] of variants) {
      const keep = readFileSync(f);
      writeFileSync(f, body);
      chmodSync(f, 0o755);
      const c = w.run(["check", "--expect", w.head]);
      expect(c.steps.cli!.state, what).toBe("TODO");
      expect(c.steps.cli!.why, what).toMatch(/is not the pinned (native )?binary/);
      writeFileSync(f, keep);
    }
    expect(w.run(["check", "--expect", w.head]).steps.cli!.state).toBe("DONE");
  });

  it("keeps an owner's existing switch (enabled:false); a failed npm install is TODO again and retried", () => {
    const w = world();
    mkdirSync(w.etc, { mode: 0o755 });
    writeFileSync(join(w.etc, "imagefirst-autostart.json"), '{"enabled": false}\n', { mode: 0o644 });
    writeFileSync(join(w.sc, "npm-fail"), "");
    const first = apply(w);
    expect(first).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(first.stdout).toContain("rollback --yes --expect");
    rmSync(join(w.sc, "npm-fail"));
    expect(w.run(["check", "--expect", w.head]).steps.cli!.state).toBe("TODO");
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(readFileSync(join(w.etc, "imagefirst-autostart.json"), "utf8")).toBe('{"enabled": false}\n');
    // the old links were recorded once (the first apply) and the log still says where they pointed
    const log = readFileSync(join(w.state, "setup.log"), "utf8");
    expect(log.match(/OLD_LINK claude/g)).toHaveLength(1);
  });

  it("DEV-303 npm 11: two distinct empty root-only config files (never /dev/null twice), the natives excluded by --os/--cpu", () => {
    const w = world();
    const r = apply(w);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "APPLY_OK" });
    // the stub (as npm 11) refuses one file loaded as user and global config: the script no longer passes that
    expect(w.lines("npm.log").filter((l) => l.includes("/dev/null"))).toEqual([]);
    expect(readFileSync(SETUP, "utf8")).not.toMatch(/--(user|global)config \/dev\/null/);
    const cfg = w.lines("npm-cfg.log");
    expect(cfg).toHaveLength(2);
    for (const l of cfg) expect(l).toMatch(new RegExp(`^cfg install ${w.state}/setup-npmrc\\.\\w+/(user|global)config type=file mode=600 size=0 dirmode=700$`));
    const paths = cfg.map((l) => l.split(" ")[2]!);
    expect(new Set(paths).size).toBe(2);
    for (const p of paths) expect(existsSync(p)).toBe(false);
    expect(readdirSync(w.state).filter((n) => n.startsWith("setup-npmrc") || n === "setup-npm.out")).toEqual([]);
    // npm's output is not shown on success
    expect(r.stdout).not.toContain("npm|");
    // the codex native is the verified one the script placed, and claude's nested native never appeared
    expect(existsSync(w.nm(PKG.claude, "node_modules"))).toBe(false);
    expect(readdirSync(w.nm(PKG.codex, "node_modules", "@openai"))).toEqual(["codex-linux-x64"]);
    expect(readFileSync(w.nm(PKG.codex, "node_modules", "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex"))).toEqual(w.natives.codex);
  });

  it("DEV-303 npm 11 stub: /dev/null (or one file) twice exits 1 with the double-loading message; without --os/--cpu the natives nest", () => {
    const w = world();
    const npm = join(w.R, "usr", "bin", "npm");
    const env = { PATH: "/usr/bin:/bin", HOME: w.base } as unknown as NodeJS.ProcessEnv;
    const one = join(w.base, "one.npmrc");
    writeFileSync(one, "");
    for (const [u, g] of [["/dev/null", "/dev/null"], [one, one]] as const) {
      const r = spawnSync(npm, ["install", "-g", "--prefix", join(w.base, "p0"), "--userconfig", u, "--globalconfig", g, join(w.registry, fileOf("codex"))], { env, encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`double-loading config "${g}" as "global", previously loaded as "user"`);
    }
    const install = (prefix: string, extra: string[]) => {
      const r = spawnSync(npm, ["install", "-g", "--prefix", prefix, "--ignore-scripts", "--omit=optional", ...extra, join(w.registry, fileOf("claude")), join(w.registry, fileOf("codex"))], { env, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    };
    install(join(w.base, "p1"), []);
    expect(existsSync(join(w.base, "p1", "lib", "node_modules", PKG.claude, "node_modules", "@anthropic-ai", "claude-code-linux-x64"))).toBe(true);
    expect(existsSync(join(w.base, "p1", "lib", "node_modules", PKG.codex, "node_modules", "@openai", "codex-linux-x64"))).toBe(true);
    install(join(w.base, "p2"), ["--os=sr-none", "--cpu=sr-none"]);
    for (const name of ["claude", "codex"] as const) expect(existsSync(join(w.base, "p2", "lib", "node_modules", PKG[name], "node_modules"))).toBe(false);
  });

  it("DEV-303 a failing npm: its last lines (token-like strings masked) and the first error line in the output and setup.log", () => {
    const w = world();
    writeFileSync(join(w.sc, "npm-fail"), "");
    const r = apply(w);
    expect(r).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(r.stdout).toContain("SETUP_CLI_FAILED: npm install failed: npm error code ETARGET;");
    const log = readFileSync(join(w.state, "setup.log"), "utf8");
    for (const text of [r.stdout, log]) {
      expect(text).toContain("npm| npm error //registry.npmjs.org/:_authToken=***");
      expect(text).toContain("npm| npm error Authorization: Bearer ***");
      expect(text).toContain("npm| npm error fetch https://***@registry.example/x.tgz");
      expect(text).toContain("npm| npm error token=*** refused");
      expect(text).toContain("npm| npm error A complete log of this run");
      expect(text).not.toMatch(/SECRET/);
      // only the last 20 lines
      expect(text).not.toMatch(/filler line 8$/m);
      expect(text).toContain("npm| npm http fetch filler line 22");
    }
    expect(log).toContain("cli failed: npm install failed: npm error code ETARGET");
    // npm's full output stays root-only in the state dir; the config files are gone
    expect(statSync(join(w.state, "setup-npm.out")).mode & 0o777).toBe(0o600);
    expect(readdirSync(w.state).filter((n) => n.startsWith("setup-npmrc"))).toEqual([]);
  });

  it("a hardening failure stops before anything further: no recorded pass, the timer off, enable-timer refused", () => {
    const w = world();
    writeFileSync(join(w.sc, "hardening-fail"), "");
    const r = apply(w);
    expect(r).toMatchObject({ status: 33, code: "SETUP_HARDENING_FAILED" });
    expect(r.stdout).toContain("Read-only file system");
    expect(r.stdout).toContain(`rollback --yes --expect ${w.head}`);
    expect(r.stdout).not.toContain("after apply:");
    expect(existsSync(join(w.state, "setup-hardening.ok"))).toBe(false);
    expect(w.lines("systemctl.log").filter((l) => l.startsWith("enable"))).toEqual([]);
    const t = w.run(["enable-timer", "--yes", "--expect", w.head]);
    expect(t).toMatchObject({ status: 4, code: "TIMER_NOT_READY" });
    expect(t.steps.hardening_check!.state).toBe("TODO");
    expect(w.lines("systemctl.log").filter((l) => l.startsWith("enable"))).toEqual([]);
    // fixed: only check 1 runs again
    rmSync(join(w.sc, "hardening-fail"));
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(w.lines("npm.log")).toHaveLength(1);
    expect(w.lines("systemd-run.log")).toHaveLength(2);
  });
});

describe("Issue #302 one-time setup: enable-timer and rollback", () => {
  it("enable-timer refuses unless every step is DONE (TODO: 4, BLOCKED: 3), then enables the timer once", () => {
    const w = world();
    expect(w.run(["enable-timer", "--yes", "--expect", w.head])).toMatchObject({ status: 4, code: "TIMER_NOT_READY" });
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    writeFileSync(join(w.sc, "ActiveState-sr-imagefirst-autostart.service"), "active");
    expect(w.run(["enable-timer", "--yes", "--expect", w.head])).toMatchObject({ status: 3, code: "SETUP_BLOCKED" });
    rmSync(join(w.sc, "ActiveState-sr-imagefirst-autostart.service"));
    const t = w.run(["enable-timer", "--yes", "--expect", w.head]);
    expect(t).toMatchObject({ status: 0, code: "TIMER_ENABLED" });
    expect(t.stdout).toMatch(/list-timers: .*sr-imagefirst-autorun\.timer sr-imagefirst-autorun\.service/);
    expect(w.lines("systemctl.log").filter((l) => l.startsWith("enable"))).toEqual(["enable --now sr-imagefirst-autorun.timer"]);
    expect(readFileSync(join(w.state, "setup.log"), "utf8")).toContain("enable-timer systemctl enable --now sr-imagefirst-autorun.timer");
  });

  it("rollback restores the old links exactly, removes what apply added, and never touches used/, autorun/, the switch or the old timer", () => {
    const w = world();
    writeFileSync(join(w.sc, "LoadState-sr-imagefirst-autostart.timer"), "loaded");
    writeFileSync(join(w.sc, "enabled-sr-imagefirst-autostart.timer"), "enabled");
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(w.run(["enable-timer", "--yes", "--expect", w.head])).toMatchObject({ status: 0, code: "TIMER_ENABLED" });
    for (const d of ["used", "autorun"]) {
      mkdirSync(join(w.state, d, ID), { recursive: true, mode: 0o700 });
      writeFileSync(join(w.state, d, ID, "commit"), "c\n");
    }
    // rollback does not ask for develop: it works after develop moved on
    commitFiles(w.src, { "docs/x.md": Buffer.from("x") }, "merged (test)");
    git(w.src, "push", "-q", w.origin, "HEAD:refs/heads/develop");
    const r = w.run(["rollback", "--yes", "--expect", w.head]);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "ROLLBACK_DONE" });
    for (const name of ["claude", "codex"] as const) {
      expect(readlinkSync(join(w.R, "usr", "local", "bin", name))).toBe(w.oldTargets[name]);
      expect(existsSync(w.nm(PKG[name]))).toBe(false);
    }
    for (const u of UNITS) expect(existsSync(join(w.R, "etc", "systemd", "system", u))).toBe(false);
    expect(existsSync(join(w.etc, "codex-config.toml"))).toBe(false);
    expect(existsSync(join(w.state, "setup-hardening.ok"))).toBe(false);
    expect(existsSync(join(w.etc, "imagefirst-autostart.json"))).toBe(true);
    for (const d of ["used", "autorun"]) expect(readFileSync(join(w.state, d, ID, "commit"), "utf8")).toBe("c\n");
    const scl = w.lines("systemctl.log");
    expect(scl).toContain("disable --now sr-imagefirst-autorun.timer");
    // the old hourly timer stays disabled
    expect(scl.filter((l) => /^enable .*autostart/.test(l))).toEqual([]);
    expect(readFileSync(join(w.sc, "enabled-sr-imagefirst-autostart.timer"), "utf8").trim()).toBe("disabled");
    expect(r.stdout).toContain("stays disabled");
    expect(r.stdout).toContain("root must not run claude / codex");
    const un = w.lines("npm.log").pop()!;
    expect(un).toMatch(new RegExp(`^npm uninstall -g --prefix ${w.R}/usr/local --userconfig ${w.state}/setup-npmrc\\.\\w+/userconfig --globalconfig ${w.state}/setup-npmrc\\.\\w+/globalconfig --no-audit --no-fund --no-update-notifier --loglevel=error --os=sr-none --cpu=sr-none ${PKG.claude} ${PKG.codex} HOME=${w.R}/root umask=0022 `));
    // the same safe config files as the install: two distinct empty root-only files, gone afterwards
    const ucfg = w.lines("npm-cfg.log").filter((l) => l.startsWith("cfg uninstall "));
    expect(ucfg).toHaveLength(2);
    for (const l of ucfg) expect(l).toMatch(/ type=file mode=600 size=0 dirmode=700$/);
    expect(new Set(ucfg.map((l) => l.split(" ")[2])).size).toBe(2);
    expect(readdirSync(w.state).filter((n) => n.startsWith("setup-npmrc") || n === "setup-npm.out")).toEqual([]);
    expect(un).toMatch(CLEAN_ENV);
    expect(readFileSync(join(w.state, "setup.log"), "utf8")).toContain(`rollback restored ${w.R}/usr/local/bin/claude -> ${w.oldTargets.claude}`);
    // a second rollback: nothing recorded since the complete one, nothing done
    const again = w.run(["rollback", "--yes", "--expect", w.head]);
    expect(again).toMatchObject({ status: 0, code: "ROLLBACK_DONE" });
    expect(again.stdout).toContain("records no change by apply");
  });

  it("rollback removes only what apply recorded: a codex-config.toml and units that were already there stay", () => {
    const w = world();
    mkdirSync(w.etc, { mode: 0o755 });
    writeFileSync(join(w.etc, "codex-config.toml"), readFileSync(CODEX_CONFIG_REPO), { mode: 0o644 });
    for (const u of UNITS) writeFileSync(join(w.R, "etc", "systemd", "system", u), readFileSync(join(UNIT_SRC, u)), { mode: 0o644 });
    writeFileSync(join(w.etc, "imagefirst-autostart.json"), '{"enabled": true}\n', { mode: 0o644 });
    // exact modes, whatever the test runner's umask
    for (const f of [w.etc, join(w.etc, "codex-config.toml"), join(w.etc, "imagefirst-autostart.json"), ...UNITS.map((u) => join(w.R, "etc", "systemd", "system", u))]) chmodSync(f, f === w.etc ? 0o755 : 0o644);
    const before = apply(w);
    expect(before).toMatchObject({ status: 0, code: "APPLY_OK" });
    const log = readFileSync(join(w.state, "setup.log"), "utf8");
    expect(log).not.toContain("APPLIED codex_config");
    expect(log).not.toContain("APPLIED units");
    expect(w.run(["rollback", "--yes", "--expect", w.head])).toMatchObject({ status: 0, code: "ROLLBACK_DONE" });
    expect(existsSync(join(w.etc, "codex-config.toml"))).toBe(true);
    for (const u of UNITS) expect(existsSync(join(w.R, "etc", "systemd", "system", u))).toBe(true);
    expect(w.lines("systemctl.log").filter((l) => /^(disable|daemon-reload)/.test(l))).toEqual([]);
    expect(existsSync(w.nm(PKG.claude))).toBe(false);
    expect(readlinkSync(join(w.R, "usr", "local", "bin", "claude"))).toBe(w.oldTargets.claude);
  });

  it("rollback after a failed npm install restores the links; a gone target is not restored; a running service refuses", () => {
    const w = world();
    writeFileSync(join(w.sc, "npm-fail"), "");
    const a = apply(w);
    expect(a).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(existsSync(join(w.R, "usr", "local", "bin", "claude"))).toBe(false);
    rmSync(w.oldTargets.codex);
    writeFileSync(join(w.sc, "ActiveState-sr-imagefirst-autorun.service"), "activating");
    expect(w.run(["rollback", "--yes", "--expect", w.head])).toMatchObject({ status: 3, code: "SETUP_BLOCKED" });
    expect(existsSync(join(w.R, "usr", "local", "bin", "claude"))).toBe(false);
    rmSync(join(w.sc, "ActiveState-sr-imagefirst-autorun.service"));
    const r = w.run(["rollback", "--yes", "--expect", w.head]);
    expect(r).toMatchObject({ status: 0, code: "ROLLBACK_DONE" });
    expect(readlinkSync(join(w.R, "usr", "local", "bin", "claude"))).toBe(w.oldTargets.claude);
    expect(existsSync(join(w.R, "usr", "local", "bin", "codex"))).toBe(false);
    expect(r.stdout).toContain("no longer exists: not restored");
  });
});

describe("DEV-303 one-time setup: the installed scripts and the standing pre-authorization", () => {
  const POLICY = (w: World) => join(w.etc, "imagefirst-standing.json");
  it("standing: writes root's policy (0644) with the limits, a UTC not_after D days ahead and the admin clone's origin URL; logged; nothing else changes", () => {
    const w = world();
    const before = w.snapshot();
    const t0 = Date.now();
    const r = w.run(["standing", "--yes", "--expect", w.head, "--per-day", "2", "--per-week", "8", "--days", "30"]);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "STANDING_WRITTEN" });
    const p = JSON.parse(readFileSync(POLICY(w), "utf8"));
    expect(Object.keys(p)).toEqual(["schema", "per_day", "per_week", "not_after", "created_at", "worker_commit", "origin_url"]);
    // CRITICAL: the worker code every run executes is the commit the owner typed (= the verified admin clone HEAD = develop then)
    expect(p).toMatchObject({ schema: "sr_imagefirst_standing_v1", per_day: 2, per_week: 8, worker_commit: w.head, origin_url: w.origin });
    const created = Date.parse(p.created_at);
    expect(p.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Math.abs(created - t0)).toBeLessThan(120_000);
    expect(Date.parse(p.not_after) - created).toBe(30 * 86400_000);
    expect(statSync(POLICY(w)).mode & 0o777).toBe(0o644);
    expect(statSync(w.etc).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(w.state, "setup.log"), "utf8")).toMatch(/ standing standing written: per_day=2 per_week=8 not_after=\S+Z created_at=\S+Z worker_commit=[0-9a-f]{40} origin_url=\S+\n/);
    expect(r.stdout).toContain("standing --revoke --yes");
    // nothing but the policy, /etc/sr-design-worker and root's log / lock: no unit, no package, no timer, no install
    const after = w.snapshot();
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (!/^\/(etc|var\/lib|etc\/sr-design-worker(\/imagefirst-standing\.json)?|var\/lib\/sr-imagefirst-autostart(\/setup\.(log|lock))?)$/.test(k)) expect(after[k], k).toBe(before[k]);
    expect(w.lines("systemctl.log").filter((l) => !/^(show|is-enabled) /.test(l))).toEqual([]);
    expect(w.lines("npm.log")).toEqual([]);
    // the policy is the one the automatic run accepts (its own parser, verbatim)
    const autorun = readFileSync(join(SCRIPTS, "imagefirst-autorun.sh"), "utf8");
    const py = /\nSTANDING_PY='\n([\s\S]*?)\n'\n/.exec(autorun)![1]!;
    const chk = spawnSync("python3", ["-I", "-c", py, POLICY(w), String(Math.floor(Date.now() / 1000)), "4", "20", "90"], { encoding: "utf8" });
    expect(chk.stdout.trim()).toBe(`OK 2 8 ${w.origin} ${w.head}`);
    // running it again replaces it (new limits)
    expect(w.run(["standing", "--yes", "--expect", w.head, "--per-day", "1", "--per-week", "1", "--days", "1"])).toMatchObject({ status: 0, code: "STANDING_WRITTEN" });
    expect(JSON.parse(readFileSync(POLICY(w), "utf8"))).toMatchObject({ per_day: 1, per_week: 1 });
    // check shows it (read-only)
    expect(w.run(["check", "--expect", w.head]).stdout).toMatch(/standing pre-authorization: \{"schema": "sr_imagefirst_standing_v1", "per_day": 1/);
  });

  it("standing refuses limits over the ceilings (N <= 4, M <= 20, M >= N, D <= 90), no --yes, no --expect or develop moved: nothing written", () => {
    const w = world();
    const before = w.snapshot();
    const bad: [string[], number, string][] = [
      [["--per-day", "5", "--per-week", "20", "--days", "30"], 2, "STANDING_INVALID"],
      [["--per-day", "2", "--per-week", "21", "--days", "30"], 2, "STANDING_INVALID"],
      [["--per-day", "2", "--per-week", "8", "--days", "91"], 2, "STANDING_INVALID"],
      [["--per-day", "3", "--per-week", "2", "--days", "30"], 2, "STANDING_INVALID"],
      [["--per-day", "0", "--per-week", "2", "--days", "30"], 2, "STANDING_INVALID"],
      [["--per-day", "2", "--per-week", "8"], 2, "STANDING_INVALID"],
      [["--per-day", "2.5", "--per-week", "8", "--days", "30"], 2, "STANDING_INVALID"],
      [["--per-day", "-1", "--per-week", "8", "--days", "30"], 2, "STANDING_INVALID"],
    ];
    for (const [args, status, code] of bad) expect(w.run(["standing", "--yes", "--expect", w.head, ...args]), args.join(" ")).toMatchObject({ status, code });
    expect(w.run(["standing", "--expect", w.head, "--per-day", "2", "--per-week", "8", "--days", "30"])).toMatchObject({ status: 2, code: "SETUP_NEEDS_YES" });
    expect(w.run(["standing", "--yes", "--per-day", "2", "--per-week", "8", "--days", "30"])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["apply", "--yes", "--expect", w.head, "--per-day", "2"])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    expect(w.run(["check", "--expect", w.head, "--revoke"])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    commitFiles(w.src, { "docs/x.md": Buffer.from("x") }, "merged (test)");
    git(w.src, "push", "-q", w.origin, "HEAD:refs/heads/develop");
    expect(w.run(["standing", "--yes", "--expect", w.head, "--per-day", "2", "--per-week", "8", "--days", "30"])).toMatchObject({ status: 2, code: "SETUP_EXPECT_NOT_DEVELOP" });
    expect(w.snapshot()).toEqual(before);
  });

  it("standing --revoke --yes removes the policy (no --expect, no admin clone needed); logged; a link is removed, never followed", () => {
    const w = world();
    expect(w.run(["standing", "--yes", "--expect", w.head, "--per-day", "2", "--per-week", "8", "--days", "30"])).toMatchObject({ status: 0, code: "STANDING_WRITTEN" });
    expect(w.run(["standing", "--revoke"])).toMatchObject({ status: 2, code: "SETUP_NEEDS_YES" });
    expect(w.run(["standing", "--revoke", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    // the admin clone gone or dirty does not matter
    writeFileSync(join(w.admin, "stray.txt"), "x");
    const r = w.run(["standing", "--revoke", "--yes"]);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "STANDING_REVOKED" });
    expect(existsSync(POLICY(w))).toBe(false);
    expect(readFileSync(join(w.state, "setup.log"), "utf8")).toContain(` standing standing revoked: rm ${POLICY(w)}\n`);
    expect(w.run(["standing", "--revoke", "--yes"])).toMatchObject({ status: 0, code: "STANDING_REVOKED" });
    writeFileSync(join(w.base, "target.json"), "keep\n");
    symlinkSync(join(w.base, "target.json"), POLICY(w));
    expect(w.run(["standing", "--revoke", "--yes"])).toMatchObject({ status: 0, code: "STANDING_REVOKED" });
    expect(() => lstatSync(POLICY(w))).toThrow();
    expect(readFileSync(join(w.base, "target.json"), "utf8")).toBe("keep\n");
  });

  it("standing --unfreeze --yes removes root's freeze (logged); a leading - in the admin clone's origin URL is refused", () => {
    const w = world();
    expect(w.run(["standing", "--unfreeze", "--yes"])).toMatchObject({ status: 0, code: "STANDING_UNFROZEN" });
    writeFileSync(join(w.state, "standing.frozen"), "frozen_at=1\nid=req-x01\nreason=AUTORUN_IMAGE_CAP_EXCEEDED 7 images (at most 6)\n");
    expect(w.run(["standing", "--unfreeze"])).toMatchObject({ status: 2, code: "SETUP_NEEDS_YES" });
    expect(w.run(["standing", "--unfreeze", "--revoke", "--yes"])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    expect(w.run(["apply", "--unfreeze", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    const r = w.run(["standing", "--unfreeze", "--yes"]);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "STANDING_UNFROZEN" });
    expect(existsSync(join(w.state, "standing.frozen"))).toBe(false);
    expect(readFileSync(join(w.state, "setup.log"), "utf8")).toContain(" standing standing unfrozen: frozen_at=1 id=req-x01 reason=AUTORUN_IMAGE_CAP_EXCEEDED");
    git(w.admin, "config", "remote.origin.url", "-uhoh");
    expect(w.run(["standing", "--yes", "--expect", w.head, "--per-day", "2", "--per-week", "8", "--days", "30"])).toMatchObject({ status: 2, code: "SETUP_ADMIN_CLONE_UNREADABLE" });
    expect(existsSync(join(w.etc, "imagefirst-standing.json"))).toBe(false);
  });

  it("scripts: an installed file changed, writable by others or missing is TODO / BLOCKED; apply puts the admin clone's copy back; rollback removes the installed copy but keeps the policy", () => {
    const w = world();
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    const inst = join(w.R, "usr", "local", "lib", "sr-imagefirst");
    const pilot = join(inst, "scripts", "sales-design-worker", "imagefirst-pilot.sh");
    writeFileSync(pilot, "# changed\n", { mode: 0o755 });
    let c = w.run(["check", "--expect", w.head]);
    expect(c.steps.scripts).toMatchObject({ state: "TODO" });
    expect(c.steps.scripts!.why).toContain("imagefirst-pilot.sh differs");
    expect(w.run(["enable-timer", "--yes", "--expect", w.head])).toMatchObject({ status: 4, code: "TIMER_NOT_READY" });
    chmodSync(pilot, 0o777);
    c = w.run(["check", "--expect", w.head]);
    expect(c).toMatchObject({ status: 3, code: "CHECK_BLOCKED" });
    expect(c.steps.scripts).toMatchObject({ state: "BLOCKED" });
    chmodSync(pilot, 0o755);
    rmSync(join(inst, "SHA256SUMS"));
    expect(w.run(["check", "--expect", w.head]).steps.scripts!.why).toContain("SHA256SUMS absent");
    const again = apply(w);
    expect(again, again.stdout).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(readFileSync(pilot)).toEqual(readFileSync(PILOT));
    expect(w.allDone(again.steps)).toEqual(DONE4);
    expect(w.run(["standing", "--yes", "--expect", w.head, "--per-day", "2", "--per-week", "8", "--days", "30"])).toMatchObject({ status: 0, code: "STANDING_WRITTEN" });
    expect(w.run(["rollback", "--yes", "--expect", w.head])).toMatchObject({ status: 0, code: "ROLLBACK_DONE" });
    expect(existsSync(inst)).toBe(false);
    expect(existsSync(POLICY(w))).toBe(true);
  });

  it("the units start only the installed copy; every installed script treats /usr/local/lib/sr-imagefirst as a production copy", () => {
    const service = readFileSync(join(UNIT_SRC, "sr-imagefirst-autorun.service"), "utf8");
    for (const l of service.split("\n").filter((x) => /^Exec/.test(x))) expect(l).toMatch(/ \/usr\/local\/lib\/sr-imagefirst\/scripts\/sales-design-worker\/imagefirst-autorun\.sh( --restore)?$/);
    for (const rel of installFiles().filter((f) => /imagefirst-(pilot|pilot-preflight|approve|autorun-setup|deliver-review)\.sh$/.test(f))) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(src, rel).toContain("INSTALL_DIR=/usr/local/lib/sr-imagefirst");
      expect(src, rel).toMatch(/if \[ "\$REPO" = "\$PROD_CLONE" \] \|\| \[ "\$REPO" = "\$INSTALL_DIR" \]; then/);
    }
    // admin.sh's own files (what it sources and checks) are installed with it
    for (const f of ["scripts/sales-design-capture/admin.sh", "scripts/sales-design-capture/host-check.sh", "scripts/sales-design-capture/jail/jail.properties", "scripts/sales-design-capture/jail/probe.py", "scripts/ops/wsl-resource-preflight.sh"]) expect(installFiles()).toContain(f);
  });
});

describe("Issue #302 one-time setup: pinned values", () => {
  it("the codex-config SHA-256 is the one the pilot and its preflight pin (read from them), and the repository's file", () => {
    const want = sha(readFileSync(CODEX_CONFIG_REPO));
    for (const f of [PILOT, PREFLIGHT]) expect(new RegExp(`^CODEX_CONFIG_SHA256=${want}$`, "m").test(readFileSync(f, "utf8")), f).toBe(true);
    const script = readFileSync(SETUP, "utf8");
    // no copy of its own: it reads the pilot's and the preflight's
    expect(script).not.toContain(want);
    expect(script).toContain("imagefirst-pilot-preflight.sh imagefirst-pilot.sh");
    const w = world();
    expect(w.run(["check", "--expect", w.head]).stdout).toContain(`codex-config.toml SHA-256 ${want}`);
  });

  it("the tarball pins: the four registry URLs, sha512 integrity values, and the two native SHA-256 values", () => {
    const script = readFileSync(SETUP, "utf8");
    for (const t of TGZS) {
      expect(script).toContain(`[${t}]=${TGZ_URL[t]}\n`);
      expect(script).toMatch(new RegExp(`^  \\[${t}\\]=sha512-[A-Za-z0-9+/]{86}==$`, "m"));
    }
    for (const b of ["claude", "codex"]) expect(script).toMatch(new RegExp(`^  \\[${b}\\]=[0-9a-f]{64}$`, "m"));
    // no proxy / CA / npm variable is passed on: the clean-env allowlist is exactly these
    expect(script).toContain("for name in PATH LANG TZ SR_IMAGEFIRST_SETUP_TEST_ROOT; do");
    expect(script).not.toMatch(/HTTPS?_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|npm_config_/);
  });

  it("check 1's hardening is exactly the service unit's [Service] properties, both directions, but the lifecycle ones", () => {
    const unit = readFileSync(join(UNIT_SRC, "sr-imagefirst-autorun.service"), "utf8");
    const service = unit.slice(unit.indexOf("[Service]"));
    const LIFECYCLE = new Set(["Type", "ExecStart", "ExecStopPost", "TimeoutStartSec", "TimeoutStopSec", "KillMode", "SuccessExitStatus"]);
    const unitProps = new Set([...service.matchAll(/^([A-Za-z]+)=(.*)$/gm)].filter((m) => !LIFECYCLE.has(m[1]!)).map((m) => `${m[1]}=${m[2]}`));
    const script = readFileSync(SETUP, "utf8");
    const block = /^HARDENING=\(\n([\s\S]*?)\n\)$/m.exec(script)![1]!;
    const scriptProps = new Set([...block.matchAll(/^ {2}-p "([^"]+)"$/gm)].map((m) => m[1]!));
    expect(block.split("\n").length).toBe(scriptProps.size);
    expect([...scriptProps].sort()).toEqual([...unitProps].sort());
    for (const p of ["ProtectKernelLogs=yes", "LockPersonality=yes", "RestrictRealtime=yes", "UMask=0077", "ReadWritePaths=/home/sr-designgen -/var/lib/sr-design-cycle", "StateDirectory=sr-imagefirst-autostart"]) expect(scriptProps.has(p), p).toBe(true);
    // and systemd-run gets them, one -p each
    const w = world();
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    const args = readFileSync(join(w.sc, "systemd-run.args"), "utf8").trim().split("\n");
    const given = new Set(args.flatMap((a, i) => (args[i - 1] === "-p" ? [a] : [])));
    expect([...given].sort()).toEqual([...unitProps].sort());
  });

  it("the production copy refuses a test hook; a test copy refuses root (the guards are in the file)", () => {
    const script = readFileSync(SETUP, "utf8");
    expect(script).toContain('[ -z "$TEST_ROOT" ] || { say "SETUP_TEST_HOOK_REFUSED');
    expect(script).toContain('[ "$(id -u)" = 0 ] ||');
    expect(script).toContain('[ "$(id -u)" != 0 ] || { say "SETUP_TEST_COPY_AS_ROOT');
  });
});
