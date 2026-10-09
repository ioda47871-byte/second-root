/**
 * Design agent PoC (DEV-028): one shop, run by hand on the WSL design user.
 *
 *   npm run sales:design-demo -- --facts ~/sr-design-input/<shop>/facts.json \
 *     --screens ~/sr-design-input/<shop>/screens --screens-reviewed \
 *     --hint "American Editorial Bakery"
 *
 * Reads verified facts (sales_demos.content shape) and person-prepared
 * reference screenshots from outside the repository, asks Codex (ChatGPT
 * sign-in, no API key) for a design profile, renders it locally, has Codex
 * review desktop / mobile screenshots, revises the profile at most twice and
 * leaves everything in ~/.local/share/second-root-design/<run-id>/.
 * Nothing is written to a database, nothing is sent to a shop, nothing is
 * committed. See docs/operations/design-agent-wsl.md.
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { DeadlineError, killAllBoundedChildren, runBounded, RunDeadline } from "../../lib/design-agent/bounded-process";
import { codexEnvironment, CodexError, fromSandboxError, runCodexJson } from "../../lib/design-agent/codex";
import { prepareCodexSandbox } from "../../lib/design-agent/sandbox";
import { workerProtectedPaths } from "../../lib/design-agent/protected-paths";
import { runDesignPipeline, type PipelineReport, type Shots } from "../../lib/design-agent/pipeline";
import { factsToDemoView, RUN_ID } from "../../lib/design-agent/preview";
import { killPreviewServers, portInUse, screenshotPage, startPreviewServer, stopPreviewServer, type PreviewServer } from "../../lib/design-agent/preview-server";

const REPO = resolve(__dirname, "../..");
const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_REFERENCES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FACT_KEYS = ["name", "category", "ward", "address", "hours", "closed_days", "access", "phone", "description", "menu_items"] as const;

type Args = {
  facts: string;
  screens: string;
  screensReviewed: boolean;
  hint?: string;
  runId: string;
  outRoot: string;
  maxRevisions: number;
  port: number;
  codexBin: string;
  schemaMode: "strict" | "loose";
  skipBuild: boolean;
};

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
  const facts = get("facts");
  const screens = get("screens");
  if (!facts || !screens) throw new UsageError("--facts <file.json> and --screens <dir> are required.");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const runId = get("run-id") ?? `${stamp}-${randomBytes(3).toString("hex")}`;
  if (!RUN_ID.test(runId)) throw new UsageError("--run-id: letters, digits, - and _ only (6–80).");
  const schemaMode = get("schema-mode") ?? "strict";
  if (schemaMode !== "strict" && schemaMode !== "loose") throw new UsageError("--schema-mode: strict | loose");
  return {
    facts: expand(facts),
    screens: expand(screens),
    screensReviewed: argv.includes("--screens-reviewed"),
    hint: get("hint")?.slice(0, 200),
    runId,
    outRoot: expand(get("out-root") ?? join(homedir(), ".local/share/second-root-design")),
    maxRevisions: Math.min(2, Math.max(0, Number(get("max-revisions") ?? 2) || 0)),
    port: Number(get("port") ?? 3210),
    codexBin: get("codex-bin") ?? "codex",
    schemaMode,
    skipBuild: argv.includes("--skip-build"),
  };
}

const insideRepo = (path: string) => !relative(REPO, path).startsWith("..");

async function loadFacts(path: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const facts = Object.fromEntries(FACT_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  if (!factsToDemoView(facts)) throw new UsageError("The facts file does not pass the demo fact filter (name and a valid category are required).");
  return facts;
}

async function loadReferences(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  const images = names.filter((n) => IMAGE_TYPES.has(extname(n).toLowerCase()));
  if (images.length !== names.length) throw new UsageError("--screens may contain only .png / .jpg / .webp files.");
  if (images.length === 0 || images.length > MAX_REFERENCES) throw new UsageError(`--screens needs 1–${MAX_REFERENCES} images.`);
  if (images.some((n) => n.includes(","))) throw new UsageError("Screenshot file names may not contain commas.");
  const paths = images.map((n) => join(dir, n));
  for (const p of paths) if ((await stat(p)).size > MAX_IMAGE_BYTES) throw new UsageError(`${p}: larger than 8 MB.`);
  return paths;
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (insideRepo(args.facts) || insideRepo(args.screens) || insideRepo(args.outRoot)) {
    throw new UsageError("Keep --facts, --screens and --out-root outside the repository (it is public).");
  }
  if (!args.screensReviewed) {
    throw new UsageError(
      "Confirm with --screens-reviewed that the screenshots show only the public profile header and post grid: no comments, DMs, or other people's faces or personal data.",
    );
  }
  const facts = await loadFacts(args.facts);
  const references = await loadReferences(args.screens);
  const demo = factsToDemoView(facts)!;

  const runDir = join(args.outRoot, args.runId);
  await mkdir(join(runDir, "shots"), { recursive: true, mode: 0o700 });
  await chmod(args.outRoot, 0o700).catch(() => undefined);
  await writeFile(join(runDir, "facts.json"), JSON.stringify(facts, null, 2));
  await writeFile(join(runDir, "inputs.json"), JSON.stringify({ references: references.length, hint: args.hint ?? null, startedAt: new Date().toISOString() }, null, 2));
  console.log(`run ${args.runId} → ${runDir}`);

  // Codex runs only inside the OS sandbox (lib/design-agent/sandbox.ts); none of these is visible to it.
  const home = homedir();
  const sandbox = await prepareCodexSandbox({
    env: codexEnvironment(process.env),
    codexBin: args.codexBin,
    protectedPaths: [
      ...workerProtectedPaths({
        env: process.env,
        stateDir: join(home, ".local", "state", "sr-design-worker"),
        queueRoot: join(home, "sr-design-jobs"),
        outRoot: args.outRoot,
      }),
      REPO,
    ],
  }).catch((error: unknown) => {
    throw fromSandboxError(error);
  });
  const deadline = new RunDeadline(Date.now() + 75 * 60_000);
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  const overflows: string[] = [];
  const stopNow = () => {
    killPreviewServers();
    killAllBoundedChildren();
  };
  // Installed before the build, so Ctrl-C never leaves a detached child behind.
  process.once("SIGINT", () => {
    stopNow();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stopNow();
    process.exit(143);
  });
  try {
    if (!args.skipBuild) {
      console.log("building (next build)…");
      const build = await runBounded("npm", ["run", "build"], { cwd: REPO, env: codexEnvironment(process.env), timeoutMs: deadline.timeoutFor(20 * 60_000) });
      if (build.code !== 0) throw new Error("npm run build failed; run it by hand to see why.");
    }
    if (await portInUse(args.port)) throw new UsageError(`Port ${args.port} is already in use; stop that server or pass --port.`);
    server = await startPreviewServer({
      repoDir: REPO,
      port: args.port,
      env: codexEnvironment({ ...process.env, SR_DESIGN_PREVIEW_ROOT: args.outRoot }),
      timeoutMs: 90_000,
    });
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
    const b = browser;
    const report: PipelineReport = await runDesignPipeline(
      { demo, references, hint: args.hint, maxRevisions: args.maxRevisions, schemaMode: args.schemaMode },
      {
        askCodex: async ({ kind, prompt, images, schema }) => {
          let timeoutMs: number;
          try {
            timeoutMs = deadline.timeoutFor(kind === "brief" ? 15 * 60_000 : 10 * 60_000, 60_000);
          } catch {
            // Out of run time: treat like a Codex timeout (the loop falls back).
            throw new CodexError("CODEX_TIMEOUT", "No time left in this run for Codex.");
          }
          return runCodexJson({ sandbox, prompt, images, schema, timeoutMs });
        },
        writeProfile: (name, profile) => writeFile(join(runDir, `${name}.json`), JSON.stringify(profile, null, 2)),
        writeRecord: (name, value) => writeFile(join(runDir, name), JSON.stringify(value, null, 2)),
        render: async (candidate): Promise<Shots> => {
          const url = `http://127.0.0.1:${args.port}/design-preview/${args.runId}?profile=${candidate}`;
          const shots = { desktop: join(runDir, "shots", `${candidate}-desktop.png`), mobile: join(runDir, "shots", `${candidate}-mobile.png`) };
          const desktopOverflow = (await screenshotPage(b, url, shots.desktop, false)).overflow;
          const mobileOverflow = (await screenshotPage(b, url, shots.mobile, true)).overflow;
          if (desktopOverflow > 0 || mobileOverflow > 0) console.log(`  warning: ${candidate} overflows horizontally`);
          if (desktopOverflow > 0) overflows.push(`OVERFLOW_${candidate}_DESKTOP`);
          if (mobileOverflow > 0) overflows.push(`OVERFLOW_${candidate}_MOBILE`);
          return shots;
        },
        log: (line) => console.log(`  ${line}`),
      },
    );
    report.notes.push(...overflows);
    await writeFile(join(runDir, "report.json"), JSON.stringify(report, null, 2));
    if (report.after) {
      await copyFile(report.before.desktop, join(runDir, "before-desktop.png"));
      await copyFile(report.before.mobile, join(runDir, "before-mobile.png"));
      await copyFile(report.after.desktop, join(runDir, "after-desktop.png"));
      await copyFile(report.after.mobile, join(runDir, "after-mobile.png"));
    }
    console.log(`status: ${report.status}${report.notes.length ? ` (${report.notes.join(", ")})` : ""}`);
    for (const r of report.rounds) console.log(`  ${r.candidate}: ${r.verdict}, total ${r.scores.total}/25, template feel ${r.scores.generic_template_feel}/5`);
    if (report.finalCandidate) console.log(`final: ${report.finalCandidate} → ${join(runDir, "final.json")}`);
    console.log(`compare: ${join(runDir, "before-desktop.png")} / after-desktop.png (and -mobile)`);
    if (report.status === "blocked") console.log("BLOCKED: the reviewer asked for a renderer change. Read review-*.json and decide by hand.");
    return report.status === "environment_failure" ? 3 : report.status === "blocked" ? 2 : 0;
  } catch (error) {
    // Rendering or system failure: leave a code-only record, keep the template.
    const code = error instanceof UsageError ? "USAGE" : error instanceof DeadlineError ? error.code : "RENDER_OR_SYSTEM";
    await writeFile(join(runDir, "failure.json"), JSON.stringify({ status: "fallback_template", code, at: new Date().toISOString() }, null, 2)).catch(() => undefined);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopPreviewServer(server);
    killAllBoundedChildren();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    killAllBoundedChildren();
    if (error instanceof UsageError) console.error(`usage: ${error.message}`);
    else if (error instanceof CodexError) console.error(`codex: ${error.code}`);
    else console.error(error instanceof Error ? error.message : "failed");
    process.exit(1);
  },
);
