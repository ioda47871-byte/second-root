/**
 * Issue #302: the MANUAL Claude CLI audit of ONE delivered IMAGE_FIRST bundle (lib/design-agent/imagefirst-worker/
 * claude-audit.ts; docs/operations/imagefirst-claude-audit.md). No Remote Control: the owner's signed-in `claude` CLI is
 * started once per viewport with no tools, and sees only the verified preview bytes. Not chained into anything: the
 * automatic start and the worker never start this script; the owner runs it by hand, as the worker user, outside the jail,
 * while sr-jail-claude is stopped (both use the same ~/.claude).
 *
 *   node --import tsx scripts/sales-design-worker/imagefirst-audit.ts <approval id> [--dry-run]
 *   node --import tsx scripts/sales-design-worker/imagefirst-audit.ts --dummy [--dry-run]     (the review PoC's dummy bundle)
 *
 * --dry-run verifies everything and prints the plan (images and bytes per call); it starts no claude process and writes
 * nothing. The facts pack and the direction text are read from this clone, pinned by SHA-256. Places (outside the
 * repository, refused otherwise): runs ~/sr-runs (its review-inbox), state $XDG_STATE_HOME/sr-design-worker/imagefirst-worker.
 *
 * One JSON line on stdout: codes, counts, SHA-256s and the advisory verdict only (never the findings text, which stays in
 * the private audit.json / AUDIT.md). Exit: 0 completed or planned, 1 stopped after the marker (a code is recorded),
 * 2 refused (nothing spent, nothing written).
 */
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AuditStop, DUMMY_AUDIT_ID, loadAuditMaterial, runClaudeAudit } from "../../lib/design-agent/imagefirst-worker/claude-audit";
import { jailIdle, SYSTEMCTL } from "../../lib/design-agent/imagefirst-worker/jail-state";
import { childEnvironment } from "../../lib/design-agent/worker/env";

process.umask(0o077);
const REPO = resolve(__dirname, "../..");
/** Tests only (both honoured only with SR_IMAGEFIRST_AUDIT_TEST_MODE=1): a fake claude and a fake systemctl. */
const TEST_MODE = process.env.SR_IMAGEFIRST_AUDIT_TEST_MODE === "1";
const say = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function real(p: string): Promise<string> {
  const abs = resolve(p);
  const r = await realpath(abs).catch(() => null);
  if (r) return r;
  const parent = dirname(abs);
  return parent === abs ? abs : join(await real(parent), relative(parent, abs));
}
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  if (rest.length !== 1 || args.filter((a) => a === "--dry-run").length > 1) return (say({ status: "refused", code: "USAGE" }), 2);
  const dummy = rest[0] === "--dummy";
  const approvalId = dummy ? DUMMY_AUDIT_ID : rest[0]!;
  const stateDir = join(expandHome(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker", "imagefirst-worker");
  const runsDir = join(homedir(), "sr-runs");
  const repo = await real(REPO);
  for (const p of [stateDir, runsDir]) if (within(await real(p), repo)) return (say({ status: "refused", code: "PLACE_INSIDE_REPO" }), 2);
  const env = childEnvironment(process.env);
  const claudeBin = TEST_MODE && process.env.SR_IMAGEFIRST_AUDIT_CLAUDE_BIN ? process.env.SR_IMAGEFIRST_AUDIT_CLAUDE_BIN : "claude";
  const systemctl = TEST_MODE && process.env.SR_IMAGEFIRST_AUDIT_SYSTEMCTL ? process.env.SR_IMAGEFIRST_AUDIT_SYSTEMCTL : SYSTEMCTL;
  const controller = new AbortController();
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(s, () => controller.abort());
  try {
    const material = await loadAuditMaterial((rel) => readFile(join(REPO, rel)));
    const r = await runClaudeAudit({ approvalId, runsDir, stateDir, material, claudeBin, env: process.env, jailIdle: () => jailIdle(env, systemctl), dummy, dryRun, signal: controller.signal });
    say({ status: r.status, code: r.code, approval_id: r.approval_id, bundle_sha256: r.bundle_sha256, verdict: r.verdict, calls: r.calls, plan: r.plan, dir: r.dir });
    return r.status === "stopped" ? 1 : 0;
  } catch (error) {
    const code = error instanceof AuditStop ? error.code : typeof (error as { code?: unknown })?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test((error as { code: string }).code) ? (error as { code: string }).code : "AUDIT_UNEXPECTED";
    say({ status: "refused", code, approval_id: approvalId });
    return 2;
  }
}

main().then((c) => process.exit(c), () => process.exit(1));
