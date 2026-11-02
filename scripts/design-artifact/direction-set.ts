/**
 * DEV-157 (Issue #193, T1): check an art-direction set (`art_direction_set_v0`) before any comp is drawn (offline).
 *
 *   npx tsx scripts/design-artifact/direction-set.ts --set <direction-set.json> --facts <facts-pack.json>
 *
 * Prints the check as JSON. Exits 0 for READY_FOR_COMPS, 1 for HOLD, 2 for a usage or read error.
 * READY_FOR_COMPS is never a quality verdict (see lib/design-agent/quality-pipeline/direction-set.ts).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkDirectionSet, type SetCheck } from "../../lib/design-agent/quality-pipeline/direction-set";

const REPO = resolve(__dirname, "../..");
const PRINCIPLES = "design-library/research/quality-pipeline/principles-v1.json";

export function runDirectionSetCheck(setPath: string, factsPath: string): SetCheck {
  const factsRaw = readFileSync(factsPath);
  const facts = JSON.parse(factsRaw.toString("utf8")) as { facts?: Array<{ id: string }> };
  const principles = JSON.parse(readFileSync(resolve(REPO, PRINCIPLES), "utf8")) as { cases: Array<{ id: string }>; principles: Array<{ id: string }> };
  return checkDirectionSet(JSON.parse(readFileSync(setPath, "utf8")), {
    factIds: (facts.facts ?? []).map((f) => f.id),
    factsSha256: createHash("sha256").update(factsRaw).digest("hex"),
    viewedCases: principles.cases.map((c) => c.id),
    principleIds: principles.principles.map((p) => p.id),
  });
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
    r = runDirectionSetCheck(resolve(set), resolve(facts));
  } catch (e) {
    process.stderr.write(`READ_ERROR: ${(e as Error).message}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(r.status === "READY_FOR_COMPS" ? 0 : 1);
}
