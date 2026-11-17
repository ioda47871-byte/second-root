/**
 * Issue #139 / #263: an OFFLINE adapter for an already produced, photo-free B-route comp.
 * It reuses the existing comp-copy, comp-lane and v2 packager, rather than implementing another validator.
 *
 * node scripts/sales/demo-version/prepare-offline.mjs \
 *   --facts /private/shop/facts-pack.json --comp /private/shop/comps/<direction-id> --out /private/runs/new-run
 *
 * The comp directory's own name is the direction id: comp-lane.ts reads it from the directory name and refuses a
 * review of another direction, so the staged copy keeps it (<out>/comp/<direction-id>/).
 *
 * No candidate search, Codex/model call, DB access, upload, approval, publishing or sending.
 * All outputs (staged facts and comp, screenshots, audit, package, status) are written in --out only, which must be
 * outside this public repository and outside the input directories. The original facts and comp are only read.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const CLI = Object.freeze({
  render: "scripts/design-artifact/comp-lane.ts",
  copy: "scripts/design-artifact/comp-copy.ts",
  visual: "scripts/design-artifact/comp-lane.ts",
  package: "scripts/sales/demo-version/package-local.ts",
});
const MAIN_FILES = ["index.html", "style.css", "copy.json"];
const ROUND_FILES = [...MAIN_FILES, "copy-review.json"];
const OPTIONAL_FILES = ["review.json", "copy-review.json"];
/** The only file the copy auditor may add or replace in the staged comp. */
const COPY_REVIEW = "copy-review.json";
/** A direction id, used as the staged directory name: no separator, no leading dot (so never `.` or `..`). */
const DIRECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FINDING = /^[A-Z][A-Z0-9_]{0,79}$/;
const MAX_FINDINGS = 40;
export const STEP_TIMEOUT_MS = 180_000;
const sha = (data) => createHash("sha256").update(data).digest("hex");
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export class OfflinePrepStop extends Error {
  constructor(code) { super(code); this.name = "OfflinePrepStop"; this.code = code; }
}

function checkedFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new OfflinePrepStop("INPUT_FILE_UNSAFE");
  return readFileSync(path);
}

function filesForComp(comp) {
  if (!lstatSync(comp).isDirectory() || lstatSync(comp).isSymbolicLink()) throw new OfflinePrepStop("COMP_DIR_UNSAFE");
  const files = [...MAIN_FILES];
  for (const optional of OPTIONAL_FILES) if (existsSync(join(comp, optional))) files.push(optional);
  const rounds = join(comp, "copy-rounds");
  if (existsSync(rounds)) {
    if (!lstatSync(rounds).isDirectory() || lstatSync(rounds).isSymbolicLink()) throw new OfflinePrepStop("COPY_ROUNDS_UNSAFE");
    const names = readdirSync(rounds).sort((a, b) => Number(a) - Number(b));
    if (names.length > 2 || names.some((name, i) => name !== String(i))) throw new OfflinePrepStop("COPY_ROUNDS_MALFORMED");
    for (const name of names) {
      const dir = join(rounds, name);
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new OfflinePrepStop("COPY_ROUNDS_UNSAFE");
      if (readdirSync(dir).some((name) => !ROUND_FILES.includes(name))) throw new OfflinePrepStop("COPY_ROUNDS_UNSAFE");
      for (const file of ROUND_FILES) files.push(join("copy-rounds", name, file));
    }
  }
  // Do not silently ignore unexpected files. Comp inputs must be auditable and photo-free.
  const allowedTop = new Set([...files.filter((x) => !x.includes(sep)), ...(existsSync(rounds) ? ["copy-rounds"] : [])]);
  if (readdirSync(comp).some((name) => !allowedTop.has(name))) throw new OfflinePrepStop("COMP_UNEXPECTED_FILE");
  return files;
}

/** Every file under a staged directory (relative path -> SHA-256); a link or another kind of entry is refused. */
function snapshot(root) {
  const files = new Map();
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel ? join(rel, name) : name;
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) throw new OfflinePrepStop("STAGED_COMP_MUTATED");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.set(path, sha(readFileSync(join(root, path))));
      else throw new OfflinePrepStop("STAGED_COMP_MUTATED");
    }
  };
  walk("");
  return files;
}
const sameFiles = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** The new run directory: absent, outside the repository, and neither inside nor around an input directory. */
function checkOutput(out, inputDirs) {
  if (existsSync(out)) throw new OfflinePrepStop("OUTPUT_EXISTS");
  const realParent = realpathSync(dirname(out));
  if (!lstatSync(realParent).isDirectory() || inside(REPO, realParent)) throw new OfflinePrepStop("OUTPUT_IN_REPO");
  const name = basename(out);
  if (name === "." || name === ".." || resolve(realParent, name) !== out) throw new OfflinePrepStop("OUTPUT_UNSAFE");
  if (inputDirs.some((dir) => inside(dir, out) || inside(out, dir))) throw new OfflinePrepStop("OUTPUT_OVERLAPS_INPUT");
}

// Runs a step in its own process group and kills the whole group (a browser included) on timeout, when the step ends,
// or when the supervisor itself is stopped. Exit 124 with the marker on stderr means the step timed out.
const SUPERVISOR = `
const { spawn } = require("node:child_process");
const [ms, ...cmd] = process.argv.slice(1);
const child = spawn(process.execPath, cmd, { stdio: "inherit", detached: true });
const killTree = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
const timer = setTimeout(() => { killTree(); process.stderr.write("STEP_TIMEOUT: supervisor\\n"); process.exit(124); }, Number(ms));
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { killTree(); process.exit(125); });
child.on("error", () => { clearTimeout(timer); process.exit(2); });
child.on("exit", (code) => { clearTimeout(timer); killTree(); process.exit(code ?? 2); });
`;

/** The leading `CODE:` of stderr, never its text (the text may hold paths or shop words). */
function stderrCode(stderr) {
  if (!stderr) return null;
  const m = /^([A-Z][A-Z0-9_]{1,40}):/.exec(stderr);
  return m ? m[1] : "STDERR_TEXT";
}

/** Runs node with these arguments under the supervisor and parses stdout as JSON. Exported for the timeout test. */
export function runSupervised(nodeArgs, timeoutMs = STEP_TIMEOUT_MS) {
  const result = spawnSync(process.execPath, ["-e", SUPERVISOR, String(timeoutMs), ...nodeArgs], {
    cwd: REPO, encoding: "utf8", timeout: timeoutMs + 10_000, killSignal: "SIGTERM", maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env }, shell: false,
  });
  const base = { exit: result.status ?? 2, stderrCode: stderrCode(result.stderr) };
  if (result.error) return { ...base, output: null, errorCode: result.error.code === "ETIMEDOUT" ? "STEP_TIMEOUT" : "STEP_ERROR" };
  if (result.status === 124 && result.stderr.includes("STEP_TIMEOUT: supervisor")) return { ...base, output: null, errorCode: "STEP_TIMEOUT" };
  try { return { ...base, output: JSON.parse(result.stdout), errorCode: null }; }
  catch { return { ...base, output: null, errorCode: "STEP_INVALID_OUTPUT" }; }
}

/** Run only repository-owned scripts; never interpolate a shop-controlled string in a shell. */
export function runRepoStep(step, args, { timeoutMs = STEP_TIMEOUT_MS } = {}) {
  return runSupervised(["--import", "tsx", resolve(REPO, CLI[step]), ...args], timeoutMs);
}

export function stepCode(step, result) {
  if (result.errorCode) return result.errorCode;
  if (!result.output || typeof result.output !== "object") return "STEP_INVALID_OUTPUT";
  if (step === "render") return result.exit === 0 && result.output.status === "OK" ? null : "RENDER_GATE_STOP";
  if (step === "copy") return result.exit === 0 && result.output.mayShowOwner === true ? null : `COPY_${String(result.output.step ?? "STOP").toUpperCase()}`;
  if (step === "visual") return result.exit === 0 && result.output.ok === true ? null : "VISUAL_REVIEW_STOP";
  if (step === "package") return result.exit === 0 && result.output.status === "OK" && result.output.format === "sales_demo_version_package_v2" ? null : "PACKAGE_STOP";
  return "UNKNOWN_STEP";
}

/** The finding codes a step printed (codes[], findings[].code, code): codes only, at most MAX_FINDINGS. */
export function findingCodes(output) {
  if (!output || typeof output !== "object") return [];
  const codes = [
    ...(Array.isArray(output.codes) ? output.codes : []),
    ...(Array.isArray(output.findings) ? output.findings.map((f) => f?.code) : []),
    output.code,
  ];
  return [...new Set(codes.filter((c) => typeof c === "string" && FINDING.test(c)))].slice(0, MAX_FINDINGS);
}

/**
 * Stages a copy of the supplied facts and comp in --out and runs every step on that copy, checking before and after
 * each step that the original bytes, the staged facts and the staged comp did not change. The only stage allowed to
 * change the staged comp is the existing copy auditor, and only its copy-review.json.
 * `runStep` is injectable for deterministic tests; the CLI uses runRepoStep.
 */
export function prepareOffline({ factsPath, compDir, outDir }, runStep = runRepoStep) {
  const facts = resolve(factsPath);
  const comp = resolve(compDir);
  const out = resolve(outDir);
  if (realpathSync(facts) !== facts || realpathSync(comp) !== comp) throw new OfflinePrepStop("INPUT_SYMLINK_PARENT");
  const direction = basename(comp);
  if (!DIRECTION_NAME.test(direction)) throw new OfflinePrepStop("COMP_NAME_UNSAFE");
  checkOutput(out, [comp, dirname(facts)]);
  const factsBytes = checkedFile(facts);
  const factsSha = sha(factsBytes);
  const paths = filesForComp(comp);
  const bytes = new Map(paths.map((path) => [path, checkedFile(join(comp, path))]));
  const original = new Map([...bytes].map(([path, data]) => [path, sha(data)]));
  let input;
  let copy;
  try { input = JSON.parse(factsBytes.toString("utf8")); copy = JSON.parse(bytes.get("copy.json").toString("utf8")); }
  catch { throw new OfflinePrepStop("INPUT_JSON_INVALID"); }
  if (input.schema !== "shop_facts_pack_v1" || !Array.isArray(input.facts) ||
      typeof input.shop_id !== "string" || copy.schema !== "comp_copy_v1" ||
      copy.shop_id !== input.shop_id || copy.facts_sha256 !== factsSha) {
    throw new OfflinePrepStop("FACTS_COPY_MISMATCH");
  }

  mkdirSync(out, { mode: 0o700 });
  const started = Date.now();
  const report = {
    run_id: basename(out),
    schema: "sales_offline_comp_run_v1",
    status: "blocked",
    code: "RUN_INCOMPLETE",
    shop_id: input.shop_id,
    direction_id: direction,
    facts_sha256: factsSha,
    comp_inputs_sha256: Object.fromEntries(original),
    staged_comp_after_copy_sha256: null,
    steps: [],
    render_review: null,
    elapsed_ms: 0,
    package_sha256: null,
    owner_approval: "required",
    external_send: "disabled",
  };
  const save = () => { report.elapsed_ms = Date.now() - started; writeFileSync(join(out, "status.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); };
  const stop = (entry) => { report.code = entry.code; report.steps.push({ ...entry, outcome: "stopped" }); save(); return report; };
  save();

  // The steps read only these copies: the facts copy is hashed, the comp copy keeps the direction id as its name.
  const stagedFacts = join(out, "input", "facts-pack.json");
  const staged = join(out, "comp", direction);
  try {
    mkdirSync(dirname(stagedFacts), { mode: 0o700 });
    writeFileSync(stagedFacts, factsBytes, { mode: 0o600, flag: "wx" });
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    for (const path of paths) {
      if (path.includes(sep)) mkdirSync(dirname(join(staged, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(staged, path), bytes.get(path), { mode: 0o600, flag: "wx" });
    }
    if (sha(readFileSync(stagedFacts)) !== factsSha || !sameFiles(snapshot(staged), original)) throw new OfflinePrepStop("STAGING_MISMATCH");
  } catch (error) {
    return stop({ step: "stage", code: error instanceof OfflinePrepStop ? error.code : "STAGING_FAILED" });
  }

  let expectedStaged = original;
  const checkUnchanged = () => {
    if (sha(checkedFile(facts)) !== factsSha || paths.some((path) => sha(checkedFile(join(comp, path))) !== original.get(path))) {
      throw new OfflinePrepStop("INPUT_MUTATED");
    }
    if (sha(checkedFile(stagedFacts)) !== factsSha) throw new OfflinePrepStop("STAGED_FACTS_MUTATED");
    if (!sameFiles(snapshot(staged), expectedStaged)) throw new OfflinePrepStop("STAGED_COMP_MUTATED");
  };
  // After the copy audit, the staged comp is re-hashed: only copy-review.json may differ from the original bytes.
  const acceptCopyAudit = () => {
    const now = snapshot(staged);
    const changed = [...new Set([...now.keys(), ...original.keys()])].filter((k) => now.get(k) !== original.get(k));
    if (changed.some((k) => k !== COPY_REVIEW)) throw new OfflinePrepStop("STAGED_COMP_MUTATED");
    expectedStaged = now;
    report.staged_comp_after_copy_sha256 = Object.fromEntries(now);
  };

  const steps = [
    // comp-lane examines a show_owner review against copy-review.json; audit first.
    ["copy", ["--audit", staged, "--facts", stagedFacts]],
    ["render", ["--dir", staged, "--facts", stagedFacts, "--out", join(out, "renders")]],
    ["visual", ["--check-review", staged, "--facts", stagedFacts]],
    ["package", ["--out", join(out, "package"), "--copy", staged, "--facts", stagedFacts]],
  ];
  for (const [step, args] of steps) {
    let result = null;
    const stepStarted = Date.now();
    // Exit code and finding codes only: never stdout/stderr text, which may hold paths or shop words.
    const record = () => ({
      step,
      duration_ms: Date.now() - stepStarted,
      exit: Number.isInteger(result?.exit) ? result.exit : null,
      findings: findingCodes(result?.output),
      ...(result?.stderrCode ? { stderr_code: result.stderrCode } : {}),
      ...(step === "copy" ? { copy_step: typeof result?.output?.step === "string" ? result.output.step : null } : {}),
    });
    try {
      checkUnchanged();
      result = runStep(step, args);
      if (step === "copy") acceptCopyAudit();
      checkUnchanged();
      let code = stepCode(step, result);
      if (step === "render" && result.output && typeof result.output === "object") {
        const review = result.output.review;
        report.render_review = review && typeof review === "object"
          ? { structural_ok: review.structural_ok === true, renders_match_here: review.renders_match_here === true }
          : review === "none" ? "none" : null;
      }
      // checkReviewFile validates the schema even for revise/drop; only show_owner proceeds.
      if (!code && step === "visual") {
        const verdict = JSON.parse(checkedFile(join(staged, "review.json")).toString("utf8")).verdict;
        if (verdict !== "show_owner") code = "VISUAL_NOT_READY_FOR_OWNER";
      }
      if (code) return stop({ ...record(), code });
      report.steps.push({ ...record(), outcome: "ok" });
      if (step === "package") report.package_sha256 = typeof result.output.bundle_sha256 === "string" ? result.output.bundle_sha256 : null;
      save();
    } catch (error) {
      return stop({ ...record(), code: error instanceof OfflinePrepStop ? error.code : "STEP_EXCEPTION" });
    }
  }
  report.status = "package_prepared_owner_review_required";
  report.code = null;
  save();
  return report;
}

function arg(k) { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = arg("--facts"), c = arg("--comp"), o = arg("--out");
  if (!f || !c || !o || process.argv.length !== 8) {
    process.stderr.write("usage: node scripts/sales/demo-version/prepare-offline.mjs --facts <file> --comp <comp dir named by its direction id> --out <new directory outside the repository and the inputs>\n");
    process.exit(2);
  }
  try {
    const report = prepareOffline({ factsPath: f, compDir: c, outDir: o });
    process.stdout.write(`${JSON.stringify({ status: report.status, code: report.code, facts_sha256: report.facts_sha256, steps: report.steps.map(({ step, outcome, code }) => ({ step, outcome, ...(code ? { code } : {}) })) })}\n`);
    process.exit(report.status === "package_prepared_owner_review_required" ? 0 : 1);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "blocked", code: error instanceof OfflinePrepStop ? error.code : "INPUT_ERROR" })}\n`);
    process.exit(2);
  }
}
