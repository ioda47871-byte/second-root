/**
 * DEV-114 Phase 2d-min CLI: intake of a Design Artifact package (offline).
 *
 *   npx tsx scripts/design-artifact/intake.ts --package <dir> --facts <facts-pack.json>
 *
 * Prints the intake record (JSON) to stdout. The record is derived every time
 * and is not evidence when stored: run intake again on the bytes you will use.
 * verification_state is never an approval; every human gate is reported not_done.
 * Nothing is written, fetched, rendered or sent to Codex or a model.
 * Exit: 0 record printed (any verification state), 2 refused (usage or a stop code).
 */
import { resolve } from "node:path";
import { IntakeError, intakeArtifact } from "../../lib/design-agent/artifact/intake";

const VALUE_FLAGS = ["--package", "--facts"] as const;

/** Strict parsing: an unknown or repeated flag, a missing value or a --flag=value form is refused. */
function parseArgs(argv: string[]): Record<(typeof VALUE_FLAGS)[number], string> | null {
  const out: Partial<Record<(typeof VALUE_FLAGS)[number], string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i] as (typeof VALUE_FLAGS)[number];
    const value = argv[i + 1];
    if (!(VALUE_FLAGS as readonly string[]).includes(name) || name in out || value === undefined || value === "" || value.startsWith("--")) return null;
    out[name] = value;
  }
  return out["--package"] && out["--facts"] ? (out as Record<(typeof VALUE_FLAGS)[number], string>) : null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("usage: --package <dir> --facts <facts-pack.json>");
    return 2;
  }
  try {
    const record = await intakeArtifact({ packageDir: resolve(args["--package"]), factsPath: resolve(args["--facts"]) });
    console.log(JSON.stringify(record, null, 2));
    return 0;
  } catch (e) {
    console.error(e instanceof IntakeError ? e.message : "REFUSED");
    return 2;
  }
}

main().then((code) => process.exit(code));
