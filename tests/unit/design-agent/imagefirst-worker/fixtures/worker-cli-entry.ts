// DEV-302 (PR #317 review H1): the TEST-ONLY entry of the IMAGE_FIRST worker CLI. It runs the real CLI function
// (scripts/sales-design-worker/imagefirst-worker.ts main) with the process's cgroup text given as its first argument
// ("unreadable": the read fails). The production entry passes nothing (its own /proc/self/cgroup) and reads no
// environment variable or argument to replace it.
//   node --import tsx worker-cli-entry.ts <cgroup text, "\n" for new lines | unreadable> <CLI arguments...>
import { runMain } from "../../../../../scripts/design-artifact/phase2f-live-cli";
import { main } from "../../../../../scripts/sales-design-worker/imagefirst-worker";

const [cgroup] = process.argv.splice(2, 1);
runMain(() =>
  main(async () => {
    if (cgroup === undefined || cgroup === "unreadable") throw new Error("EACCES");
    return cgroup.replace(/\\n/g, "\n");
  }),
);
