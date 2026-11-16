/**
 * Issue #139 / #263: an OFFLINE adapter for an already produced, photo-free B-route comp.
 * It reuses the existing comp-lane, comp-copy and v2 packager, rather than implementing another validator.
 *
 * node scripts/sales/demo-version/prepare-offline.mjs \
 *   --facts /private/shop/facts-pack.json --comp /private/shop/comp --out /private/runs/new-run
 *
 * No candidate search, Codex/model call, DB access, upload, approval, publishing or sending.
 * All outputs (screenshots, staged audit and package, status) are outside this public repository.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
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

function requireOutsideRepo(out) {
  if (existsSync(out)) throw new OfflinePrepStop("OUTPUT_EXISTS");
  const parent = dirname(out);
  const realParent = realpathSync(parent);
  if (!lstatSync(realParent).isDirectory() || inside(REPO, realParent)) throw new OfflinePrepStop("OUTPUT_IN_REPO");
  if (basename(out) === "." || basename(out) === ".." || resolve(realParent, basename(out)) !== out) throw new OfflinePrepStop("OUTPUT_UNSAFE");
}

/** Run only repository-owned scripts; never interpolate a shop-controlled string in a shell. */
export function runRepoStep(step, args) {
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, CLI[step]), ...args], {
    cwd: REPO, encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env }, shell: false,
  });
  if (result.error) return { exit: 2, output: null, errorCode: result.error.code === "ETIMEDOUT" ? "STEP_TIMEOUT" : "STEP_ERROR" };
  try { return { exit: result.status ?? 2, output: JSON.parse(result.stdout), errorCode: null }; }
  catch { return { exit: result.status ?? 2, output: null, errorCode: "STEP_INVALID_OUTPUT" }; }
}

function stepCode(step, result) {
  if (result.errorCode) return result.errorCode;
  if (!result.output || typeof result.output !== "object") return "STEP_INVALID_OUTPUT";
  if (step === "render") return result.exit === 0 && result.output.status === "OK" ? null : "RENDER_GATE_STOP";
  if (step === "copy") return result.exit === 0 && result.output.mayShowOwner === true ? null : `COPY_${String(result.output.step ?? "STOP").toUpperCase()}`;
  if (step === "visual") return result.exit === 0 && result.output.ok === true ? null : "VISUAL_REVIEW_STOP";
  if (step === "package") return result.exit === 0 && result.output.status === "OK" && result.output.format === "sales_demo_version_package_v2" ? null : "PACKAGE_STOP";
  return "UNKNOWN_STEP";
}

/**
 * Stages a safe copy of the supplied comp and checks that the original bytes do not change.
 * The only stage allowed to mutate the staged comp is the existing copy auditor.
 * `runStep` is injectable for deterministic tests; the CLI uses runRepoStep.
 */
export function prepareOffline({ factsPath, compDir, outDir }, runStep = runRepoStep) {
  const facts = resolve(factsPath);
  const comp = resolve(compDir);
  const out = resolve(outDir);
  requireOutsideRepo(out);
  if (realpathSync(facts) !== facts || realpathSync(comp) !== comp) throw new OfflinePrepStop("INPUT_SYMLINK_PARENT");
  const factsBytes = checkedFile(facts);
  const paths = filesForComp(comp);
  const original = new Map(paths.map((path) => [path, sha(checkedFile(join(comp, path)))]));
  let input;
  let copy;
  try { input = JSON.parse(factsBytes.toString("utf8")); copy = JSON.parse(checkedFile(join(comp, "copy.json")).toString("utf8")); }
  catch { throw new OfflinePrepStop("INPUT_JSON_INVALID"); }
  if (input.schema !== "shop_facts_pack_v1" || !Array.isArray(input.facts) ||
      typeof input.shop_id !== "string" || copy.schema !== "comp_copy_v1" ||
      copy.shop_id !== input.shop_id || copy.facts_sha256 !== sha(factsBytes)) {
    throw new OfflinePrepStop("FACTS_COPY_MISMATCH");
  }
  const checkUnchanged = () => {
    if (sha(checkedFile(facts)) !== sha(factsBytes) || paths.some((path) => sha(checkedFile(join(comp, path))) !== original.get(path))) {
      throw new OfflinePrepStop("INPUT_MUTATED");
    }
  };
  mkdirSync(out, { mode: 0o700 });
  const staged = join(out, "comp");
  mkdirSync(staged, { mode: 0o700 });
  for (const path of paths) {
    const dst = join(staged, path);
    if (path.includes(sep)) mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    cpSync(join(comp, path), dst, { recursive: false, errorOnExist: true });
  }
  const started = Date.now();
  const report = {
    run_id: basename(out),
    schema: "sales_offline_comp_run_v1",
    status: "blocked",
    code: "RUN_INCOMPLETE",
    shop_id: input.shop_id,
    facts_sha256: sha(factsBytes),
    comp_inputs_sha256: Object.fromEntries(original),
    steps: [],
    elapsed_ms: 0,
    package_sha256: null,
    owner_approval: "required",
    external_send: "disabled",
  };
  const save = () => { report.elapsed_ms = Date.now() - started; writeFileSync(join(out, "status.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); };
  save();
  const steps = [
    ["render", ["--dir", staged, "--facts", facts, "--out", join(out, "renders")]],
    ["copy", ["--audit", staged, "--facts", facts]],
    ["visual", ["--check-review", staged, "--facts", facts]],
    ["package", ["--out", join(out, "package"), "--copy", staged, "--facts", facts]],
  ];
  for (const [step, args] of steps) {
    try {
      checkUnchanged();
      const stepStarted = Date.now();
      const result = runStep(step, args);
      checkUnchanged();
      const code = stepCode(step, result);
      report.steps.push({ step, outcome: code ? "stopped" : "ok", duration_ms: Date.now() - stepStarted, ...(code ? { code } : {}),
        ...(step === "copy" ? { copy_step: result.output?.step ?? null, findings: (Array.isArray(result.output?.codes) ? result.output.codes : []).filter((x) => typeof x === "string").slice(0, 40) } : {}),
      });
      if (code) { report.code = code; save(); return report; }
      if (step === "package") report.package_sha256 = typeof result.output.bundle_sha256 === "string" ? result.output.bundle_sha256 : null;
      save();
    } catch (error) {
      report.code = error instanceof OfflinePrepStop ? error.code : "STEP_EXCEPTION";
      report.steps.push({ step, outcome: "stopped", code: report.code });
      save();
      return report;
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
    process.stderr.write("usage: node scripts/sales/demo-version/prepare-offline.mjs --facts <file> --comp <dir> --out <new directory outside repo>\n");
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
