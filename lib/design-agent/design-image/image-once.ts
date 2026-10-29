/**
 * Phase 2f-2 (DEV-117): ONE image-tool call for an arbitrary, owner-approved prompt — the research test's image step
 * (route C's pictures, route A's concept). It is the PoC's image call without the PoC's gates: the same jail and
 * command line (image feature pinned on, read-only, ChatGPT sign-in only, no .env), the same session-log reading and
 * outcome classification (capability.ts), the same PNG check (png.ts). The PoC (run.ts), its v4 approval, prompt pin
 * and used-approval record are untouched; the approval, prompt pin, commit pin and call limits of this step live in
 * the caller (the research test's image step and its CLI).
 *
 * Every outcome is returned as it was observed: the picture only when the image tool saved one, otherwise the image
 * outcome and a fixed stop code (never the model's words). Nothing is retried. The CLI's session log and the image
 * dirs this call created are removed before it returns (the picture is handed back in memory).
 */
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { CodexAbortedError, CodexError, assertChatGptSignIn, codexDotenvPresent, codexLooksRateLimited, codexLooksSignedOut, listDesignAgentSessions, readCodexEvents, removeCodexSession, removeCodexSessionsOf, removeStaleCodexSessions } from "../codex";
import { SandboxError, type CodexSandbox } from "../sandbox";
import { deriveImageOutcome, parseCodexVersion, readSessionFacts, type ImageOutcome } from "./capability";
import { PngError, readPngNoFollow } from "./png";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PNG_NAME = /^[A-Za-z0-9_.-]{1,120}\.png$/i;
const MODEL = /^[0-9A-Za-z._-]{1,60}$/;

export type ImageOnceResult = {
  png: Buffer | null;
  width: number | null;
  height: number | null;
  outcome: ImageOutcome | "not_applicable";
  /** null only with a saved picture. */
  stopCode: string | null;
  threadId: string | null;
  cliVersion: string | null;
  model: string | null;
  codexMs: number;
};

/** The thread dirs of CODEX_HOME/generated_images (an empty set when there are none yet; undefined when unreadable). */
async function imageThreads(codexHome: string): Promise<Set<string> | undefined> {
  try {
    return new Set((await readdir(join(codexHome, "generated_images"))).filter((n) => THREAD_ID.test(n)));
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? new Set() : undefined;
  }
}

/** The newest PNG of the thread's image dir, fully checked; or the fixed reason there is none. */
async function takeImage(dir: string): Promise<{ bytes: Buffer; width: number; height: number } | { code: string }> {
  const info = await lstat(dir).catch(() => null);
  if (!info) return { code: "CODEX_NO_IMAGE" };
  if (info.isSymbolicLink() || !info.isDirectory()) return { code: "CODEX_IMAGE_INVALID" };
  const pngs: { path: string; mtime: number }[] = [];
  let otherRaster = false;
  for (const name of await readdir(dir)) {
    const entry = await lstat(join(dir, name)).catch(() => null);
    if (name.toLowerCase().endsWith(".png")) {
      if (!PNG_NAME.test(name) || !entry || entry.isSymbolicLink() || !entry.isFile()) return { code: "CODEX_IMAGE_INVALID" };
      pngs.push({ path: join(dir, name), mtime: entry.mtimeMs });
    } else if (/\.(jpe?g|webp|gif)$/i.test(name) && entry?.isFile() && !entry.isSymbolicLink()) otherRaster = true;
  }
  if (pngs.length === 0) return { code: otherRaster ? "CODEX_IMAGE_UNSUPPORTED_FORMAT" : "CODEX_NO_IMAGE" };
  try {
    const png = await readPngNoFollow(pngs.sort((a, b) => b.mtime - a.mtime)[0]!.path);
    return { bytes: png.bytes, width: png.width, height: png.height };
  } catch (error) {
    if (error instanceof PngError) return { code: "CODEX_IMAGE_INVALID" };
    throw error;
  }
}

/**
 * Before the call (as the PoC does): the session logs a cut-off design-agent call left behind (its work dir was
 * sr-design-codex-…) and those threads' image dirs. Other Codex sessions of the user are not touched.
 */
async function removeStaleDesignAgentState(env: Record<string, string | undefined>, codexHome: string): Promise<void> {
  for (const path of await listDesignAgentSessions(env).catch(() => [] as string[])) {
    const thread = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(basename(path))?.[1];
    if (thread) await rm(join(codexHome, "generated_images", thread), { recursive: true, force: true }).catch(() => undefined);
  }
  await removeStaleCodexSessions(env).catch(() => 0);
}

/** The cleanups of calls still running, so a CLI that is stopped hard can still remove what they left (as the PoC). */
const activeCleanups = new Set<() => Promise<void>>();
export async function cleanupActiveImageCalls(): Promise<void> {
  await Promise.all([...activeCleanups].map((c) => c().catch(() => undefined)));
}

/** The fixed stop code for an image outcome without a saved picture. */
export function imageStopCode(outcome: ImageOutcome): string {
  if (outcome === "TOOL_FAILED_USAGE_LIMIT") return "CODEX_QUOTA";
  if (outcome === "TOOL_FAILED" || outcome === "TOOL_FAILED_POLICY" || outcome === "TOOL_FAILED_UNSUPPORTED" || outcome === "TOOL_FAILED_TRANSIENT") return "CODEX_IMAGE_TOOL_FAILED";
  return "CODEX_NO_IMAGE";
}

export async function generateImageOnce(o: { sandbox: CodexSandbox; prompt: string; timeoutMs: number; tmpBase: string; signal?: AbortSignal; now?: () => number }): Promise<ImageOnceResult> {
  const now = o.now ?? Date.now;
  const { sandbox, signal } = o;
  const withSignal = signal === undefined ? {} : { signal };
  if (signal?.aborted) throw new CodexAbortedError();
  const codexHome = sandbox.env.CODEX_HOME ?? join(sandbox.env.HOME ?? "/nonexistent", ".codex");
  const result = (r: Partial<ImageOnceResult> & Pick<ImageOnceResult, "outcome" | "stopCode">): ImageOnceResult => ({ png: null, width: null, height: null, threadId: null, cliVersion: null, model: null, codexMs: 0, ...r });
  // before any Codex process: Codex would load $CODEX_HOME/.env past the cleared environment (DEV-078)
  if (await codexDotenvPresent(codexHome)) return result({ outcome: "not_applicable", stopCode: "CODEX_DOTENV_PRESENT" });
  await removeStaleDesignAgentState(sandbox.env, codexHome);
  await assertChatGptSignIn({ sandbox, ...withSignal });
  let cwd: string | undefined;
  let threadId: string | null = null;
  let before: Set<string> | undefined;
  // the picture is in memory by the time this runs: the thread's image dir, any image dir this call created, and its
  // session logs go (also when the CLI is stopped hard: cleanupActiveImageCalls)
  let pending: Promise<void> | undefined;
  const cleanup = (): Promise<void> =>
    (pending ??= (async () => {
      const images = join(codexHome, "generated_images");
      if (threadId) await rm(join(images, threadId), { recursive: true, force: true }).catch(() => undefined);
      if (before) for (const name of (await imageThreads(codexHome)) ?? []) if (!before.has(name)) await rm(join(images, name), { recursive: true, force: true }).catch(() => undefined);
      if (threadId) await removeCodexSession(threadId, sandbox.env).catch(() => 0);
      if (cwd) {
        await removeCodexSessionsOf(sandbox.env, new Set([cwd, await realpath(cwd).catch(() => cwd!)])).catch(() => undefined);
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    })());
  activeCleanups.add(cleanup);
  try {
    cwd = await mkdtemp(join(o.tmpBase, "sr-design-codex-"));
    // the version, in the same jail (no config, no model); unknown is a warning for the caller, never a failure
    const version = await sandbox.run(["--version"], { workDir: cwd, timeoutMs: 30_000, ...withSignal }).catch(() => null);
    const cliVersion = version && version.code === 0 && !version.timedOut ? parseCodexVersion(version.stdout) : null;
    if (signal?.aborted) throw new CodexAbortedError();
    before = await imageThreads(codexHome);
    const started = now();
    let run;
    try {
      // the PoC's command line: the image feature pinned on, read-only, the built-in provider only
      run = await sandbox.run(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-c", 'model_provider="openai"', "-c", "features.image_generation=true", "--cd", cwd, "-"], {
        workDir: cwd,
        input: o.prompt,
        timeoutMs: o.timeoutMs,
        ...withSignal,
      });
    } catch (error) {
      return result({ outcome: "not_applicable", stopCode: error instanceof SandboxError ? error.code : "CODEX_SANDBOX_UNAVAILABLE", cliVersion });
    }
    const codexMs = now() - started;
    const events = readCodexEvents(run.stdout);
    if (events.threadId !== undefined && THREAD_ID.test(events.threadId)) threadId = events.threadId;
    // the CLI's own record of the image tool (fixed facts only), read before the log is removed
    const facts = await readSessionFacts(codexHome, threadId ? { threadId } : { cwds: new Set([cwd, await realpath(cwd).catch(() => cwd!)]) });
    const model = facts.model !== null && facts.model !== "other" && MODEL.test(facts.model) ? facts.model : null;
    const base = { threadId, cliVersion: cliVersion ?? facts.cli_version, model, codexMs };
    if (run.aborted || signal?.aborted) throw new CodexAbortedError();
    if (run.timedOut) return result({ ...base, outcome: deriveImageOutcome(facts, false), stopCode: "CODEX_TIMEOUT" });
    if (run.code !== 0 && codexLooksSignedOut(run.stdout, run.stderr)) return result({ ...base, outcome: "not_applicable", stopCode: "CODEX_NOT_SIGNED_IN" });
    if (run.code !== 0 && codexLooksRateLimited(run.stdout, run.stderr)) return result({ ...base, outcome: deriveImageOutcome(facts, false), stopCode: "CODEX_QUOTA" });
    if (run.code !== 0) return result({ ...base, outcome: deriveImageOutcome(facts, false), stopCode: "CODEX_EXEC_FAILED" });
    if (!threadId) return result({ ...base, outcome: deriveImageOutcome(facts, false), stopCode: "CODEX_NO_THREAD" });
    const image = await takeImage(join(codexHome, "generated_images", threadId));
    if ("code" in image) {
      const outcome = deriveImageOutcome(facts, false);
      // as the PoC: no picture and the CLI's own rate-limit words is a usage limit
      if (image.code === "CODEX_NO_IMAGE" && codexLooksRateLimited(run.stdout, run.stderr)) return result({ ...base, outcome, stopCode: "CODEX_QUOTA" });
      // the image tool's own failure decides the code; otherwise the file problem as found
      return result({ ...base, outcome, stopCode: image.code === "CODEX_NO_IMAGE" ? imageStopCode(outcome) : image.code });
    }
    return result({ ...base, png: image.bytes, width: image.width, height: image.height, outcome: "IMAGE_SAVED", stopCode: null });
  } catch (error) {
    if (error instanceof CodexAbortedError || error instanceof CodexError) throw error;
    if (error instanceof SandboxError) return result({ outcome: "not_applicable", stopCode: error.code });
    throw error;
  } finally {
    await cleanup();
    activeCleanups.delete(cleanup);
  }
}
