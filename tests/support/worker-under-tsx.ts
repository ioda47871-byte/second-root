// Runs one design worker job under tsx, the way run.sh starts the worker in
// production (tsx transforms differently from vitest: e.g. keepNames adds a
// __name() helper that page.evaluate callbacks must not depend on).
// Prints the worker report and the run's report.json as one JSON line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeLayout, runWorker, startMockSite, writeJob } from "../unit/design-agent/worker-support";

async function main() {
  const site = await startMockSite();
  try {
    const l = makeLayout();
    writeJob(l, "job-tsx", "https://www.instagram.com/stripes_shop/");
    const { report } = await runWorker(l, site);
    let run: unknown = null;
    try {
      run = JSON.parse(readFileSync(join(l.out, "job-tsx", "report.json"), "utf8"));
    } catch {
      /* no result */
    }
    process.stdout.write(`${JSON.stringify({ report, run })}\n`);
  } finally {
    site.server.close();
  }
}

void main();
