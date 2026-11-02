/**
 * DEV-157 (Issue #193, T1): check an art-direction set (`art_direction_set_v0`) before any comp is drawn (offline).
 *
 *   npx tsx scripts/design-artifact/direction-set.ts --set <direction-set.json> --facts <facts-pack.json> [--principles <principles-v1.json>]
 *
 * Prints the check as JSON. Exits 0 for READY_FOR_COMPS, 1 for HOLD, 2 for a usage error or an input that cannot be read
 * (a missing file, bad JSON, a facts pack that is not `shop_facts_pack_v1`, a malformed principles file), 3 for a bug.
 * READY_FOR_COMPS is never a quality verdict (see lib/design-agent/quality-pipeline/direction-set.ts).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FactsPack } from "../../lib/design-agent/artifact/schema";
import { checkDirectionSet, type CheckInputs, type SetCheck } from "../../lib/design-agent/quality-pipeline/direction-set";

const REPO = resolve(__dirname, "../..");
const PRINCIPLES = "design-library/research/quality-pipeline/principles-v1.json";

export class InputError extends Error {}

/** The parts of principles-v1.json the check reads. */
const Principles = z.object({
  cases: z.array(z.object({ id: z.string().regex(/^CP-\d{3}$/), principles: z.array(z.string().regex(/^P\d$/)) })).min(1),
  principles: z.array(z.object({ id: z.string().regex(/^P\d$/) })).min(1),
});

function readJson(path: string): { raw: Buffer; json: unknown } {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    throw new InputError(`cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return { raw, json: JSON.parse(raw.toString("utf8")) };
  } catch (e) {
    throw new InputError(`not JSON: ${path}: ${(e as Error).message}`);
  }
}

/** The check's inputs from a facts pack and the committed principles data. */
export function loadInputs(factsPath: string, principlesPath = resolve(REPO, PRINCIPLES)): CheckInputs {
  const { raw, json } = readJson(factsPath);
  const pack = FactsPack.safeParse(json);
  if (!pack.success) throw new InputError(`not a shop_facts_pack_v1: ${pack.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const ids = pack.data.facts.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new InputError("facts pack has duplicated fact ids");
  const parsed = Principles.safeParse(readJson(principlesPath).json);
  if (!parsed.success) throw new InputError(`${principlesPath} is malformed: ${parsed.error.issues[0]?.message ?? ""}`);
  const principles = parsed.data;
  return {
    shopId: pack.data.shop_id,
    factIds: ids,
    factsSha256: createHash("sha256").update(raw).digest("hex"),
    viewedCases: principles.cases.map((c) => c.id),
    principleIds: principles.principles.map((p) => p.id),
    casePrinciples: Object.fromEntries(principles.cases.map((c) => [c.id, c.principles])),
  };
}

export function runDirectionSetCheck(setPath: string, factsPath: string, principlesPath?: string): SetCheck {
  const inputs = loadInputs(factsPath, principlesPath);
  return checkDirectionSet(readJson(setPath).json, inputs);
}

if (require.main === module) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const [set, facts] = [arg("--set"), arg("--facts")];
  if (!set || !facts) {
    process.stderr.write("USAGE: --set <direction-set.json> --facts <facts-pack.json>\n");
    process.exit(2);
  }
  let r: SetCheck;
  try {
    const principles = arg("--principles");
    r = runDirectionSetCheck(resolve(set), resolve(facts), principles ? resolve(principles) : undefined);
  } catch (e) {
    if (e instanceof InputError) {
      process.stderr.write(`INPUT_ERROR: ${e.message}\n`);
      process.exit(2);
    }
    // a bug must not look like a HOLD (1)
    process.stderr.write(`BUG: ${(e as Error).stack ?? String(e)}\n`);
    process.exit(3);
  }
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(r.status === "READY_FOR_COMPS" ? 0 : 1);
}
