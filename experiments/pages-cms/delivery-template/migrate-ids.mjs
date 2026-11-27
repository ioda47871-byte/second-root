// Makes already-delivered works / news entries editable in Pages CMS again (Issue #380, 2026-11-28): rewrites only ids
// that are not UUIDs (e.g. "job-1") to deterministic UUIDs, keeping file names and every other byte. Dry run by default.
//
//   node migrate-ids.mjs            # report what would change (nothing is written)
//   node migrate-ids.mjs --write    # write it (a second run changes nothing)
//
// The logic is site/migrate-ids.ts (a copy of Second Root's, generated — do not edit). No network.
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const HERE = dirname(fileURLToPath(import.meta.url));
register();
const { migrateIds } = await import(pathToFileURL(`${HERE}/site/migrate-ids.ts`).href);
const report = await migrateIds(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : HERE, { write: process.argv.includes("--write") });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.status === "refused" ? 1 : 0);
