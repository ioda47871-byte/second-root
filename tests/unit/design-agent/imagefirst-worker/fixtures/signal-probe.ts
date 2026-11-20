/**
 * Issue #302 review M4 test fixture (worker-cli.test.ts), run as `node --import tsx` like the worker and the entry.
 *   <out> count : counts SIGTERMs while its event loop is busy (80 ms in every 100 ms), writes the count 0.8 s after the first
 *   <out> stop  : the real stopSignals with the worker's repeatGraceMs; writes "abort", then "graceful" 8 s later and
 *                 exits 0, unless a hard stop comes first (its cleanup writes "hard", exit 1)
 * Writes <out>.ready once its handlers are installed.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { WORKER_STOP } from "../../../../../lib/design-agent/imagefirst-worker/cycle";
import { stopSignals } from "../../../../../scripts/design-artifact/phase2f-live-cli";

const out = process.argv[2]!;
if (process.argv[3] === "count") {
  let n = 0;
  process.on("SIGTERM", () => {
    n += 1;
    if (n === 1)
      setTimeout(() => {
        writeFileSync(out, String(n));
        process.exit(0);
      }, 800);
  });
  setInterval(() => {
    const end = Date.now() + 80;
    while (Date.now() < end);
  }, 100);
} else {
  const { controller } = stopSignals({ hardStopMs: 30_000, repeatGraceMs: WORKER_STOP.repeatGraceMs, cleanup: async () => appendFileSync(out, "hard\n") });
  controller.signal.addEventListener("abort", () => {
    appendFileSync(out, "abort\n");
    setTimeout(() => {
      appendFileSync(out, "graceful\n");
      process.exit(0);
    }, 8_000);
  });
  setInterval(() => undefined, 1_000);
}
writeFileSync(`${out}.ready`, "");
