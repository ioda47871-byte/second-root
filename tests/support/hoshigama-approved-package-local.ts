// DEV-139 — TESTS ONLY. Runs the real scripts/sales/demo-version/package-local.ts (its own argv) after
// simulateOwnerApproval() (tests/support/hoshigama-approval-stub.ts) has set, in this process only, the two fields of
// ほし窯's swap spec an owner approval would set. The repository's spec is unchanged; the real CLI never runs this.
import { simulateOwnerApproval } from "./hoshigama-approval-stub";

simulateOwnerApproval();
// package-local.ts runs its main() when it is loaded, with this process's argv (`--out …` after this file's path)
void import("../../scripts/sales/demo-version/package-local");
