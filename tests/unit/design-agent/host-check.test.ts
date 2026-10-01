import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// scripts/sales-design-capture/host-check.sh (security review round 3 C1 / H1): the machine checks
// admin.sh (install / login) and run.sh (every helper run) use. The script is run as is, with only its
// system paths pointed at fixtures and id / sudo / runuser stubbed as shell functions.
const SCRIPT = readFileSync(join(__dirname, "../../../scripts/sales-design-capture/host-check.sh"), "utf8");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

type Machine = {
  wsl?: boolean;
  conf?: string;
  interop?: "enabled" | "disabled" | null;
  user?: { name: string; uid: number; groups: string[] };
  sudoRules?: boolean;
  mounts?: string;
  writable?: string[];
};

function run(machine: Machine, call: string): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), "sr-hc-"));
  roots.push(root);
  mkdirSync(join(root, "binfmt"));
  writeFileSync(join(root, "osrelease"), machine.wsl === false ? "6.8.0-generic\n" : "5.15.167.4-microsoft-standard-WSL2\n");
  writeFileSync(join(root, "wsl.conf"), machine.conf ?? "");
  if (machine.interop) writeFileSync(join(root, "binfmt", "WSLInterop"), `${machine.interop}\ninterpreter /init\n`);
  writeFileSync(join(root, "mounts"), machine.mounts ?? "");
  const script = SCRIPT.replaceAll("/etc/wsl.conf", join(root, "wsl.conf"))
    .replaceAll("/proc/sys/kernel/osrelease", join(root, "osrelease"))
    .replaceAll("/proc/sys/fs/binfmt_misc", join(root, "binfmt"))
    .replaceAll("/proc/mounts", join(root, "mounts"))
    .replaceAll("[ -d /run/WSL ]", "false");
  const user = machine.user ?? { name: "sr-designgen", uid: 1001, groups: ["sr-designgen", "sr-capture"] };
  const stubs = `
id() { case "$1" in -u) [ "$2" = "${user.name}" ] && echo ${user.uid} || return 1 ;; -nG) echo "${user.groups.join(" ")}" ;; esac; }
sudo() { ${machine.sudoRules ? `echo "User ${user.name} may run the following commands on host:"; echo "    (ALL) ALL"` : `echo "User ${user.name} is not allowed to run sudo on host."`}; }
runuser() { shift 3; case " ${(machine.writable ?? []).join(" ")} " in *" $3 "*) return 0 ;; *) return 1 ;; esac; }
`;
  const file = join(root, "check.sh");
  writeFileSync(file, `${script}\n${stubs}\n${call}\n`);
  const r = spawnSync("bash", [file], { encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`.trim() };
}

const SAFE_CONF = "[boot]\nsystemd=true\n\n[interop]\nenabled=false\nappendWindowsPath=false\n";

describe("host-check.sh: the requester must not be able to become root or the helper", () => {
  it("WSL interop: refused unless wsl.conf turns it off AND it is off now", () => {
    expect(run({ conf: SAFE_CONF }, "sr_check_wsl_interop").code).toBe(0);
    expect(run({ conf: "[Interop]\n  Enabled = False   # off\nappendwindowspath=\"false\"\n" }, "sr_check_wsl_interop").code).toBe(0);
    const missing = run({ conf: "[boot]\nsystemd=true\n" }, "sr_check_wsl_interop");
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.out).toMatch(/^WSL_INTEROP_NOT_DISABLED/);
    expect(run({ conf: "[interop]\nenabled=false\n" }, "sr_check_wsl_interop").code).toBe(1); // Windows PATH still appended
    expect(run({ conf: "[interop]\nenabled=false\nappendWindowsPath=false\nenabled=true\n" }, "sr_check_wsl_interop").code).toBe(1); // the last one wins
    expect(run({ conf: "[boot]\nenabled=false\nappendWindowsPath=false\n" }, "sr_check_wsl_interop").code).toBe(1); // wrong section
    const live = run({ conf: SAFE_CONF, interop: "enabled" }, "sr_check_wsl_interop");
    expect(live.code).toBe(1);
    expect(live.out).toMatch(/^WSL_INTEROP_ACTIVE/); // the file changed but WSL was not restarted
    expect(run({ conf: SAFE_CONF, interop: "disabled" }, "sr_check_wsl_interop").code).toBe(0);
    expect(run({ wsl: false }, "sr_check_wsl_interop").code).toBe(0); // not WSL: nothing to check
  });

  it("requester: refused when root, in an admin-equivalent group, or the WSL default user", () => {
    expect(run({ conf: SAFE_CONF }, "sr_check_requester sr-designgen").code).toBe(0);
    for (const g of ["sudo", "admin", "wheel", "lxd", "disk", "docker", "libvirt", "kvm", "adm", "systemd-journal", "sr-igcapture"]) {
      const r = run({ conf: SAFE_CONF, user: { name: "sr-designgen", uid: 1001, groups: ["sr-designgen", g] } }, "sr_check_requester sr-designgen");
      expect(r.code, g).toBe(1);
      expect(r.out).toContain(`REQUESTER_PRIVILEGED_GROUP: sr-designgen is in ${g}`);
    }
    expect(run({ user: { name: "x", uid: 0, groups: ["root"] } }, "sr_check_requester x").out).toMatch(/^REQUESTER_IS_ROOT/);
    expect(run({ conf: SAFE_CONF }, "sr_check_requester nobody-here").out).toMatch(/^REQUESTER_UNKNOWN/);
    // uid 1000 is the user Windows opens WSL as, unless wsl.conf names another default
    expect(run({ conf: SAFE_CONF, user: { name: "sr-designgen", uid: 1000, groups: [] } }, "sr_check_requester sr-designgen").out).toMatch(/^REQUESTER_IS_WSL_DEFAULT_USER/);
    expect(run({ conf: `${SAFE_CONF}[user]\ndefault=person\n`, user: { name: "sr-designgen", uid: 1000, groups: [] } }, "sr_check_requester sr-designgen").code).toBe(0);
    expect(run({ conf: `${SAFE_CONF}[user]\ndefault=sr-designgen\n` }, "sr_check_requester sr-designgen").code).toBe(1);
    expect(run({ wsl: false, user: { name: "sr-designgen", uid: 1000, groups: [] } }, "sr_check_requester sr-designgen").code).toBe(0); // not WSL
  });

  it("root-only checks: any sudo rule, or a writable Windows drive / Startup folder, is refused", () => {
    const mounts = "C:\\134 /mnt/c 9p rw,relatime 0 0\nD:\\134 /mnt/my\\040drive drvfs rw 0 0\nnone /mnt/sr-export 9p rw 0 0\ntmpfs /tmp tmpfs rw 0 0\n";
    expect(run({ mounts }, "sr_check_requester_root sr-designgen").code).toBe(0);
    expect(run({ mounts, sudoRules: true }, "sr_check_requester_root sr-designgen").out).toMatch(/^REQUESTER_HAS_SUDO/);
    expect(run({ mounts, writable: ["/tmp"] }, "sr_check_requester_root sr-designgen").code).toBe(0); // tmpfs is not a Windows drive
    // a Windows mount the requester can write (a path with a space, as /proc/mounts encodes it)
    const dir = mkdtempSync(join(tmpdir(), "sr-hc-mnt "));
    roots.push(dir);
    const enc = dir.replaceAll(" ", "\\040");
    const writable = run({ mounts: `C:\\134 ${enc} 9p rw 0 0\n`, writable: [dir] }, "sr_check_requester_root sr-designgen");
    expect(writable.code).toBe(1);
    expect(writable.out).toContain(`REQUESTER_WRITES_WINDOWS: sr-designgen can write ${dir}`);
    expect(run({ mounts: `C:\\134 ${enc} 9p rw 0 0\n`, writable: [] }, "sr_check_requester_root sr-designgen").code).toBe(0);
    // the one export mount a person may give the requester
    expect(run({ mounts: "none /mnt/sr-export 9p rw 0 0\n", writable: ["/mnt/sr-export"] }, "sr_check_requester_root sr-designgen").code).toBe(0);
  });
});
