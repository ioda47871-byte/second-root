import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 実機 resource preflight (docs/operations/wsl-resource-preflight.md): the
// memory verdict before heavy local work, and the OOM-kill check after a
// sudden "Killed". Fake /proc/meminfo and kernel logs; nothing is changed.

const SCRIPT = join(process.cwd(), "scripts/ops/wsl-resource-preflight.sh");
const dir = mkdtempSync(join(tmpdir(), "resource-preflight-"));
let n = 0;

function meminfo(totalMiB: number, availMiB: number, swapMiB: number) {
  const path = join(dir, `meminfo-${n++}`);
  writeFileSync(path, [`MemTotal: ${totalMiB * 1024} kB`, `MemFree: 1000 kB`, `MemAvailable: ${availMiB * 1024} kB`, `SwapTotal: ${swapMiB * 1024} kB`, `SwapFree: ${swapMiB * 1024} kB`].join("\n"));
  return path;
}
const run = (args: string[], env: Record<string, string>) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, SR_PREFLIGHT_MEMINFO: "", SR_PREFLIGHT_KLOG: "", ...env } });

describe("resource preflight: memory", () => {
  it("stops below 3 GiB available (the ~2.8 GiB OOM case), runs serially below 6 GiB, else at most 2", () => {
    const stop = run([], { SR_PREFLIGHT_MEMINFO: meminfo(3900, 2867, 0) });
    expect(stop.status).toBe(20);
    expect(stop.stdout).toContain("MemTotal 3900 MiB / MemAvailable 2867 MiB / SwapTotal 0 MiB / SwapFree 0 MiB");
    expect(stop.stdout).toContain("WARN: no swap");
    expect(stop.stdout).toContain("STOP");

    const serial = run([], { SR_PREFLIGHT_MEMINFO: meminfo(7900, 4500, 2048) });
    expect(serial.status).toBe(10);
    expect(serial.stdout).toContain("--maxWorkers=1 --no-file-parallelism");
    expect(serial.stdout).not.toContain("WARN");

    const ok = run([], { SR_PREFLIGHT_MEMINFO: meminfo(16000, 12000, 4096) });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("--maxWorkers=2");
  });
});

describe("resource preflight: was it an OOM kill?", () => {
  it("finds an OOM kill in the kernel log, and says so when there is none", () => {
    const oom = join(dir, "klog-oom");
    writeFileSync(oom, "[ 812.3] node invoked oom-killer: gfp_mask=0x140cca\n[ 812.4] Out of memory: Killed process 4242 (node) total-vm:5123456kB\n");
    const found = run(["--oom-check"], { SR_PREFLIGHT_KLOG: oom });
    expect(found.status).toBe(1);
    expect(found.stdout).toContain("OOM_KILL_FOUND");
    expect(found.stdout).toContain("Killed process 4242");

    const clean = join(dir, "klog-clean");
    writeFileSync(clean, "[ 1.0] Linux version 6.6\n[ 2.0] eth0: link up\n");
    const none = run(["--oom-check", "--since", "2 hours ago"], { SR_PREFLIGHT_KLOG: clean });
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("NO_OOM_KILL");
  });
});
