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
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { killAllBoundedChildren, runBounded, RunDeadline } from "../../lib/design-agent/bounded-process";
import { codexEnvironment, CodexError, runCodexJson } from "../../lib/design-agent/codex";
import { runDesignPipeline, type PipelineReport, type Shots } from "../../lib/design-agent/pipeline";
import { factsToDemoView, RUN_ID } from "../../lib/design-agent/preview";

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
  const paths = images.map((n) => join(dir, n));
  for (const p of paths) if ((await stat(p)).size > MAX_IMAGE_BYTES) throw new UsageError(`${p}: larger than 8 MB.`);
  return paths;
}

// ---------------------------------------------------------------- local server

function startServer(port: number, previewRoot: string): ChildProcess {
  const env = codexEnvironment({ ...process.env, SR_DESIGN_PREVIEW_ROOT: previewRoot, PORT: String(port) });
  const child = spawn("npx", ["next", "start", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: REPO, env, stdio: "ignore", detached: true });
  return child;
}

async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/design-preview/not-a-run-id`);
      if (res.status === 404) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("The local preview server did not start.");
}

function stopServer(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

async function screenshot(browser: Browser, url: string, path: string, mobile: boolean): Promise<void> {
  const context = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" } : { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
  );
  try {
    const page = await context.newPage();
    const res = await page.goto(url, { waitUntil: "networkidle" });
    if (res?.status() !== 200) throw new Error(`preview returned ${String(res?.status())}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) console.log(`  warning: ${mobile ? "mobile" : "desktop"} overflows by ${overflow}px`);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path, fullPage: true, clip: { x: 0, y: 0, width: mobile ? 390 : 1440, height: Math.min(height, mobile ? 3200 : 2800) } });
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (insideRepo(args.facts) || insideRepo(args.screens)) throw new UsageError("Keep --facts and --screens outside the repository (it is public).");
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

  const deadline = new RunDeadline(Date.now() + 75 * 60_000);
  if (!args.skipBuild) {
    console.log("building (next build)…");
    const build = await runBounded("npm", ["run", "build"], { cwd: REPO, env: process.env, timeoutMs: deadline.timeoutFor(20 * 60_000) });
    if (build.code !== 0) throw new Error("npm run build failed; run it by hand to see why.");
  }
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  const stop = () => {
    stopServer(server);
    killAllBoundedChildren();
  };
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(143);
  });
  try {
    server = startServer(args.port, args.outRoot);
    await waitForServer(args.port, 90_000);
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
    const b = browser;
    const report: PipelineReport = await runDesignPipeline(
      { demo, references, hint: args.hint, maxRevisions: args.maxRevisions, schemaMode: args.schemaMode },
      {
        askCodex: ({ kind, prompt, images, schema }) =>
          runCodexJson({ prompt, images, schema, codexBin: args.codexBin, timeoutMs: deadline.timeoutFor(kind === "brief" ? 15 * 60_000 : 10 * 60_000, 60_000) }),
        writeProfile: (name, profile) => writeFile(join(runDir, `${name}.json`), JSON.stringify(profile, null, 2)),
        writeRecord: (name, value) => writeFile(join(runDir, name), JSON.stringify(value, null, 2)),
        render: async (candidate): Promise<Shots> => {
          const url = `http://127.0.0.1:${args.port}/design-preview/${args.runId}?profile=${candidate}`;
          const shots = { desktop: join(runDir, "shots", `${candidate}-desktop.png`), mobile: join(runDir, "shots", `${candidate}-mobile.png`) };
          await screenshot(b, url, shots.desktop, false);
          await screenshot(b, url, shots.mobile, true);
          return shots;
        },
        log: (line) => console.log(`  ${line}`),
      },
    );
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
  } finally {
    await browser?.close();
    stop();
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
