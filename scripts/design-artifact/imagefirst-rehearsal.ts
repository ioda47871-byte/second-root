/**
 * DEV-303 (owner goal 2026-11-26) CLI — OFFLINE: the SYNTHETIC whole_page rehearsal bundle of stages 3 → 6
 * (lib/design-agent/imagefirst-worker/rehearsal.ts; runbook docs/operations/first-client-pipeline.md §5). No Codex, no
 * model, no image tool, no network, no process: the pictures are drawn locally and marked synthetic in the sealed bundle.
 *
 *   npx tsx scripts/design-artifact/imagefirst-rehearsal.ts --seal    --home <empty private dir outside the repo> [--id <req-synthetic-rehearsal-…>]
 *   npx tsx scripts/design-artifact/imagefirst-rehearsal.ts --approve --home <same dir> --page-sha256 <hex from design-approval-check --page> [--id …]
 *
 * --seal     the synthetic run → packBundle → the local review inbox <home>/sr-runs/review-inbox/<id> (the existing
 *            transport), the fictional shop's pack, a synthetic review and a rehearsal site under <home>/second-root-shops.
 * --approve  the fictional approval of that synthetic run (refused for a bundle that is not synthetic) and a fictional
 *            photo-materials request naming it under <home>/rehearsal-requests.
 * The home is never the real one (REHEARSAL_HOME_IS_REAL_HOME): the jailed Claude's inbox is not touched.
 *
 * Exit: 0 done, 1 stopped (a fixed code), 2 refused (bad arguments).
 */
import { resolve } from "node:path";
import { approveRehearsal, REHEARSAL_ID, sealRehearsal } from "../../lib/design-agent/imagefirst-worker/rehearsal";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

type Args = { mode: "seal"; home: string; id: string } | { mode: "approve"; home: string; id: string; pageSha256: string };
export function parseRehearsalArgs(argv: string[]): Args | null {
  let mode: "seal" | "approve" | null = null;
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--seal" || k === "--approve") {
      if (mode !== null) return null;
      mode = k === "--seal" ? "seal" : "approve";
      continue;
    }
    const v = argv[i + 1];
    if (!["--home", "--id", "--page-sha256"].includes(k) || !v || v.startsWith("--") || k in o) return null;
    o[k] = v;
    i++;
  }
  if (mode === null || !o["--home"]) return null;
  const base = { home: resolve(o["--home"]), id: o["--id"] ?? REHEARSAL_ID };
  if (mode === "seal") return o["--page-sha256"] ? null : { mode, ...base };
  return o["--page-sha256"] ? { mode, ...base, pageSha256: o["--page-sha256"] } : null;
}

export async function rehearsalMain(argv: string[], repoRoot: string = REPO): Promise<number> {
  const args = parseRehearsalArgs(argv);
  if (!args) return (say({ status: "refused", code: "ARGS_INVALID" }), 2);
  try {
    if (args.mode === "seal") {
      const r = await sealRehearsal({ home: args.home, repo: repoRoot, id: args.id });
      say({ status: "sealed", ...r });
      return 0;
    }
    const r = await approveRehearsal({ home: args.home, repo: repoRoot, id: args.id, pageSha256: args.pageSha256 });
    say({ status: "approved_fictional", synthetic: true, ...r });
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    say({ status: "stopped", code: typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "REHEARSAL_UNEXPECTED" });
    return 1;
  }
}

if (require.main === module)
  rehearsalMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
