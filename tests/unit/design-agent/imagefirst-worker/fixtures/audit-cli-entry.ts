// Issue #302 (PR #311 re-review L-c): the TEST-ONLY entry of the audit CLI. It runs the real CLI function
// (scripts/sales-design-worker/imagefirst-audit.ts auditCli) with a fake claude and a fake systemctl given as its first
// two arguments. The production entry fixes both (claude on PATH, /usr/bin/systemctl) and reads nothing to replace them.
//   node --import tsx audit-cli-entry.ts <fake claude> <fake systemctl> <CLI arguments...>
import { auditCli } from "../../../../../scripts/sales-design-worker/imagefirst-audit";

process.umask(0o077);
const [claudeBin, systemctl, ...args] = process.argv.slice(2);
auditCli(args, { claudeBin: claudeBin!, systemctl: systemctl! }).then((c) => process.exit(c), () => process.exit(1));
