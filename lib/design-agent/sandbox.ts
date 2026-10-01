/**
 * The OS boundary around every Codex CLI process (DEV-028 Phase 3).
 *
 * Codex's own `--sandbox read-only` still lets it READ every file the worker
 * user can. A prompt (or words inside a reference screenshot) could steer it
 * to read the signed-in Instagram browser profile, the Meta token, the
 * results, or the user's git and SSH credentials. So Codex never runs
 * directly: it runs inside bubblewrap with an allowlisted filesystem view.
 *
 *   /                      read-only (system files, no user data)
 *   /home, the real home,  empty, read-only tmpfs: every user's files are
 *   /root, /mnt, /media,   gone (the Instagram profile, the repository, the
 *   /srv, /run/user        capture spool, /mnt/c of Windows ...)
 *   /tmp, /var/tmp,        empty, writable tmpfs (thrown away)
 *   /dev/shm
 *   then, put back on top:
 *     the Codex install    read-only (its install root and node's)
 *     CODEX_HOME           read-write (its ChatGPT sign-in and session logs)
 *     the call's work dir  read-write, at the same path (schema, answer)
 *     <work dir>/inputs    read-only: COPIES of the privacy-processed PNGs
 *   own pid / ipc / uts namespaces, a fresh /proc (no other process is
 *   visible), no capabilities, a new session, dies with its parent, and a
 *   cleared environment (an allowlist is set again).
 *
 * Nothing the caller names is bound directly: bubblewrap follows a link in a
 * bind SOURCE outside the sandbox, so a link given as an "image" would expose
 * its target. Images are copied in (O_NOFOLLOW, regular file, PNG, size cap)
 * and only the copy directory is bound. Every bind source is resolved first
 * and refused when it is, contains, or lies inside a protected path.
 *
 * Fail closed: before EVERY Codex process, a probe runs in the exact same
 * sandbox and must report that no protected path is visible and that the
 * home holds nothing but the expected entries. If bubblewrap is missing,
 * cannot start, or the probe sees anything, Codex is not started.
 */
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { runBounded, type BoundedResult } from "./bounded-process";

export type SandboxFailureCode = "CODEX_NOT_INSTALLED" | "CODEX_SANDBOX_UNAVAILABLE" | "CODEX_SANDBOX_LEAK" | "CODEX_SANDBOX_CONFIG" | "CODEX_INPUT_REJECTED";

export class SandboxError extends Error {
  constructor(readonly code: SandboxFailureCode) {
    super(code);
    this.name = "SandboxError";
  }
}

/** Hidden behind an empty tmpfs whenever they exist. */
const HIDDEN_RO = ["/home", "/root", "/mnt", "/media", "/srv", "/run/user"];
const HIDDEN_RW = ["/tmp", "/var/tmp"];

/** Variables Codex may see (all others are cleared). */
const ENV_ALLOW = ["LANG", "LANGUAGE", "TZ", "USER", "LOGNAME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
/** Certificate files the CLI may need; bound read-only when they live in a hidden area. */
const ENV_FILES = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];

/** bubblewrap's own environment (it clears the child's anyway). */
const BWRAP_ENV = { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv;

/** Largest reference image copied in. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface CodexSandbox {
  /** Runs Codex with `args` inside the sandbox; the work dir is visible at its own path. */
  run(args: readonly string[], options: { workDir: string; input?: string; timeoutMs: number }): Promise<BoundedResult>;
  /** CODEX_HOME / HOME on the host (for cleaning up the CLI's session logs). */
  readonly env: Readonly<Record<string, string>>;
}

export interface SandboxOptions {
  /** The worker's environment (PATH, HOME, CODEX_HOME ...). */
  env: Record<string, string | undefined>;
  codexBin?: string;
  /** Tests only: another bubblewrap (production: the first `bwrap` on PATH). */
  bwrapBin?: string;
  /** Paths that must never be visible inside (checked by the probe before every call). */
  protectedPaths: readonly string[];
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

async function which(name: string, path: string | undefined): Promise<string | null> {
  if (name.includes("/")) {
    if (!isAbsolute(name)) return null;
    try {
      await access(name, constants.X_OK);
      return (await stat(name)).isFile() ? name : null;
    } catch {
      return null;
    }
  }
  for (const dir of (path ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Where a binary is installed: the npm prefix for an npm package, else its directory. */
export function installRoot(realBin: string): string {
  const marker = `${sep}lib${sep}node_modules${sep}`;
  const at = realBin.indexOf(marker);
  return at > 0 ? realBin.slice(0, at) : dirname(realBin);
}

/** The bwrap arguments for one call (pure; exported for tests). */
export function bwrapArgs(plan: {
  home: string;
  codexHome: string;
  readOnly: readonly string[];
  readOnlyFiles: readonly string[];
  extraHidden: readonly string[];
  workDir: string;
  env: Readonly<Record<string, string>>;
  existing: (path: string) => boolean;
}): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--cap-drop", "ALL"];
  args.push("--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/dev/shm");
  const hiddenRo = [...new Set([...HIDDEN_RO, plan.home, ...plan.extraHidden])].filter(plan.existing);
  // Parents before children: a later tmpfs on a parent would cover an earlier one below it.
  const tmpfs = [...new Set([...hiddenRo, ...HIDDEN_RW.filter(plan.existing)])].sort((a, b) => a.split("/").length - b.split("/").length);
  for (const path of tmpfs) args.push("--tmpfs", path);
  for (const path of plan.readOnly) args.push("--ro-bind", path, path);
  for (const path of plan.readOnlyFiles) args.push("--ro-bind", path, path);
  args.push("--bind", plan.codexHome, plan.codexHome);
  args.push("--bind", plan.workDir, plan.workDir);
  args.push("--ro-bind", join(plan.workDir, "inputs"), join(plan.workDir, "inputs"));
  // The emptied areas stay empty: nothing can be written there and found later.
  for (const path of hiddenRo) args.push("--remount-ro", path);
  args.push("--chdir", plan.workDir, "--clearenv");
  for (const [name, value] of Object.entries(plan.env)) args.push("--setenv", name, value);
  return args;
}

/** Checks one bind source: absolute, resolved, not "/" or the home, and clear of every protected path. */
async function safeSource(path: string, home: string, protectedReal: readonly string[], kind: "dir" | "file"): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new SandboxError("CODEX_SANDBOX_CONFIG");
  }
  const info = await stat(real).catch(() => null);
  if (!info || (kind === "dir" ? !info.isDirectory() : !info.isFile())) throw new SandboxError("CODEX_SANDBOX_CONFIG");
  if (real === "/" || inside(home, real)) throw new SandboxError("CODEX_SANDBOX_CONFIG");
  for (const p of protectedReal) {
    if (inside(p, real) || inside(real, p)) throw new SandboxError("CODEX_SANDBOX_CONFIG");
  }
  return real;
}

/** Resolves a protected path as far as it exists (a link to it is caught by its real target). */
async function resolveProtected(path: string): Promise<string> {
  let probe = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(probe), ...rest.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return path;
      rest.push(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Prepares the sandbox once per run. Throws SandboxError (no Codex process
 * is ever started) when bubblewrap or the Codex CLI is missing, or a bind
 * would expose a protected path.
 */
export async function prepareCodexSandbox(options: SandboxOptions): Promise<CodexSandbox> {
  const bwrap = await which(options.bwrapBin ?? "bwrap", options.env.PATH);
  if (!bwrap) throw new SandboxError("CODEX_SANDBOX_UNAVAILABLE");
  const homeRaw = options.env.HOME;
  if (!homeRaw || !isAbsolute(homeRaw)) throw new SandboxError("CODEX_SANDBOX_CONFIG");
  const home = await realpath(homeRaw).catch(() => {
    throw new SandboxError("CODEX_SANDBOX_CONFIG");
  });
  const protectedReal = await Promise.all(options.protectedPaths.map(resolveProtected));

  const whichCodex = await which(options.codexBin ?? "codex", options.env.PATH);
  if (!whichCodex) throw new SandboxError("CODEX_NOT_INSTALLED");
  const realCodex = await realpath(whichCodex).catch(() => {
    throw new SandboxError("CODEX_NOT_INSTALLED");
  });
  // Only installs inside a hidden area need putting back (anything else is visible read-only already).
  const hiddenArea = (p: string) => [...HIDDEN_RO, ...HIDDEN_RW, home].some((h) => inside(p, h));
  const readOnly = new Set<string>();
  for (const p of protectedReal) if (inside(realCodex, p)) throw new SandboxError("CODEX_SANDBOX_CONFIG");
  if (hiddenArea(realCodex)) readOnly.add(await safeSource(installRoot(realCodex), home, protectedReal, "dir"));
  // `#!/usr/bin/env node`: node's own install (nvm puts it in the home).
  const whichNode = await which("node", options.env.PATH);
  const realNode = whichNode ? await realpath(whichNode).catch(() => null) : null;
  if (realNode) {
    for (const p of protectedReal) if (inside(realNode, p)) throw new SandboxError("CODEX_SANDBOX_CONFIG");
    if (hiddenArea(realNode)) readOnly.add(await safeSource(dirname(dirname(realNode)), home, protectedReal, "dir"));
  }

  const codexHomeRaw = options.env.CODEX_HOME || join(home, ".codex");
  await mkdir(codexHomeRaw, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const codexHomeInfo = await lstat(codexHomeRaw).catch(() => null);
  if (!codexHomeInfo || codexHomeInfo.isSymbolicLink() || !codexHomeInfo.isDirectory()) throw new SandboxError("CODEX_SANDBOX_CONFIG");
  const codexHome = await safeSource(codexHomeRaw, home, protectedReal, "dir");
  for (const root of readOnly) if (inside(codexHome, root) || inside(root, codexHome)) throw new SandboxError("CODEX_SANDBOX_CONFIG");

  const env: Record<string, string> = { HOME: homeRaw, TMPDIR: "/tmp", CODEX_HOME: codexHome };
  for (const name of ENV_ALLOW) if (options.env[name] !== undefined) env[name] = options.env[name]!;
  for (const [name, value] of Object.entries(options.env)) if (name.startsWith("LC_") && value !== undefined) env[name] = value;
  const readOnlyFiles: string[] = [];
  for (const name of ENV_FILES) {
    const value = options.env[name];
    if (!value || !isAbsolute(value)) continue;
    const real = await safeSource(value, home, protectedReal, "file").catch(() => null);
    if (!real) continue; // not passed on at all
    env[name] = real;
    readOnlyFiles.push(real);
  }
  // PATH inside: node and Codex first, then the system directories.
  const pathDirs = [dirname(realCodex), ...(realNode ? [dirname(realNode)] : []), "/usr/local/bin", "/usr/bin", "/bin"];
  env.PATH = [...new Set(pathDirs)].join(delimiter);

  const existing = new Set<string>();
  for (const p of [...HIDDEN_RO, ...HIDDEN_RW, home]) if (await lstat(p).catch(() => null)) existing.add(p);
  // Protected paths outside every hidden area are hidden one by one.
  const extraHidden: string[] = [];
  for (const p of protectedReal) {
    if (hiddenArea(p)) continue;
    const info = await lstat(p).catch(() => null);
    if (info?.isDirectory()) {
      extraHidden.push(p);
      existing.add(p);
    } else if (info) {
      throw new SandboxError("CODEX_SANDBOX_CONFIG"); // a protected FILE outside the hidden areas cannot be emptied
    }
  }
  // Entries the home may show inside: the first path segment of each bind under it.
  const homeEntries = new Set<string>();
  for (const p of [...readOnly, ...readOnlyFiles, codexHome]) {
    if (inside(p, home) && p !== home) homeEntries.add(relative(home, p).split(sep)[0]!);
  }

  const argsFor = (workDir: string) =>
    bwrapArgs({ home, codexHome, readOnly: [...readOnly], readOnlyFiles, extraHidden, workDir, env, existing: (p) => existing.has(p) });

  /** The probe: same sandbox, must see none of the protected paths and nothing unexpected in the home. */
  const probe = async (workDir: string): Promise<void> => {
    const script = [
      'home="$1"; shift; allowed="$1"; shift',
      // A protected path may exist only as an EMPTY directory (a hidden area's mount point).
      'for p in "$@"; do for q in "$p" "/proc/1/root$p"; do',
      '  if [ -L "$q" ] || { [ -e "$q" ] && ! [ -d "$q" ]; }; then echo VISIBLE',
      '  elif [ -d "$q" ] && [ -n "$(ls -A "$q" 2>/dev/null)" ]; then echo VISIBLE; fi',
      "done; done",
      'for e in $(ls -A "$home" 2>/dev/null); do case " $allowed " in *" $e "*) ;; *) echo UNEXPECTED;; esac; done',
      'n=0; for d in /proc/[0-9]*; do n=$((n+1)); done; [ "$n" -le 8 ] || echo PROCS',
      "echo PROBE_OK",
    ].join("\n");
    let result: BoundedResult;
    try {
      result = await runBounded(bwrap, [...argsFor(workDir), "--", "/bin/sh", "-c", script, "probe", home, [...homeEntries].join(" "), ...protectedReal, ...options.protectedPaths], {
        env: BWRAP_ENV,
        timeoutMs: 30_000,
      });
    } catch {
      throw new SandboxError("CODEX_SANDBOX_UNAVAILABLE");
    }
    const lines = result.stdout.split("\n").filter(Boolean);
    if (result.code !== 0 || lines.at(-1) !== "PROBE_OK") throw new SandboxError("CODEX_SANDBOX_UNAVAILABLE");
    if (lines.length !== 1) throw new SandboxError("CODEX_SANDBOX_LEAK");
  };

  return {
    env: { HOME: homeRaw, CODEX_HOME: codexHome },
    async run(args, runOptions) {
      const workDir = await realpath(runOptions.workDir).catch(() => {
        throw new SandboxError("CODEX_SANDBOX_CONFIG");
      });
      const info = await lstat(workDir);
      if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new SandboxError("CODEX_SANDBOX_CONFIG");
      for (const p of protectedReal) if (inside(p, workDir) || inside(workDir, p)) throw new SandboxError("CODEX_SANDBOX_CONFIG");
      await mkdir(join(workDir, "inputs"), { recursive: true, mode: 0o700 });
      await probe(workDir);
      return runBounded(bwrap, [...argsFor(workDir), "--", realCodex, ...args], {
        env: BWRAP_ENV,
        cwd: workDir,
        timeoutMs: runOptions.timeoutMs,
        ...(runOptions.input === undefined ? {} : { input: runOptions.input }),
      });
    },
  };
}

/** png / jpg / webp by content (the worker sends PNG only; the manual CLI also takes JPEG and WebP). */
function imageType(data: Buffer): "png" | "jpg" | "webp" | null {
  if (data.subarray(0, PNG.length).equals(PNG)) return "png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/**
 * Copies reference images into <workDir>/inputs (the only place Codex can
 * read them). Each source must be a regular image file (PNG, JPEG or WebP by content) opened without following
 * a link. Returns the copies' paths. Throws CODEX_INPUT_REJECTED otherwise.
 */
export async function stageInputs(workDir: string, images: readonly string[]): Promise<string[]> {
  const dir = join(workDir, "inputs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const out: string[] = [];
  for (const [i, image] of images.entries()) {
    if (!isAbsolute(image)) throw new SandboxError("CODEX_INPUT_REJECTED");
    let handle;
    try {
      handle = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new SandboxError("CODEX_INPUT_REJECTED");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_INPUT_BYTES || info.size < 12) throw new SandboxError("CODEX_INPUT_REJECTED");
      const data = await handle.readFile();
      const ext = imageType(data);
      if (!ext) throw new SandboxError("CODEX_INPUT_REJECTED");
      const target = join(dir, `ref-${i + 1}.${ext}`);
      const copy = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await copy.writeFile(data);
      } finally {
        await copy.close();
      }
      out.push(target);
    } finally {
      await handle.close();
    }
  }
  return out;
}
