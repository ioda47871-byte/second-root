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
  /** /proc/<pid>/status contents of running processes */
  procs?: string[];
  /** /run/WSL/<name> sockets: mode */
  sockets?: Record<string, number>;
};

function run(machine: Machine, call: string): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), "sr-hc-"));
  roots.push(root);
  mkdirSync(join(root, "binfmt"));
  writeFileSync(join(root, "osrelease"), machine.wsl === false ? "6.8.0-generic\n" : "5.15.167.4-microsoft-standard-WSL2\n");
  writeFileSync(join(root, "wsl.conf"), machine.conf ?? "");
  if (machine.interop) writeFileSync(join(root, "binfmt", "WSLInterop"), `${machine.interop}\ninterpreter /init\n`);
  writeFileSync(join(root, "mounts"), machine.mounts ?? "");
  mkdirSync(join(root, "proc"));
  (machine.procs ?? []).forEach((status, i) => {
    mkdirSync(join(root, "proc", String(100 + i)));
    writeFileSync(join(root, "proc", String(100 + i), "status"), status);
  });
  mkdirSync(join(root, "runwsl"));
  for (const [name, mode] of Object.entries(machine.sockets ?? {})) {
    const path = join(root, "runwsl", name);
    spawnSync("python3", ["-c", `import socket,os; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(path)}); os.chmod(${JSON.stringify(path)}, ${mode})`]);
  }
  const script = SCRIPT.replaceAll("/etc/wsl.conf", join(root, "wsl.conf"))
    .replaceAll("/proc/sys/kernel/osrelease", join(root, "osrelease"))
    .replaceAll("/proc/sys/fs/binfmt_misc", join(root, "binfmt"))
    .replaceAll("/proc/mounts", join(root, "mounts"))
    .replaceAll("/proc/[0-9]*/status", `${join(root, "proc")}/[0-9]*/status`)
    .replaceAll("/run/WSL/", `${join(root, "runwsl")}/`)
    .replaceAll("[ -d /run/WSL ]", "false");
  const user = machine.user ?? { name: "sr-designgen", uid: 1001, groups: ["sr-designgen", "sr-capture"] };
  const stubs = `
id() { case "$1" in -u) [ "$2" = "${user.name}" ] && echo ${user.uid} || return 1 ;; -nG) echo "${user.groups.join(" ")}" ;; esac; }
getent() { case "$2" in sudo) echo "sudo:x:27:" ;; docker) echo "docker:x:998:" ;; *) return 2 ;; esac; }
sudo() { ${machine.sudoRules ? `echo "User ${user.name} may run the following commands on host:"; echo "    (ALL) ALL"` : `echo "User ${user.name} is not allowed to run sudo on host."`}; }
runuser() { shift 3; case " ${(machine.writable ?? []).join(" ")} " in *" $3 "*) return 0 ;; *) return 1 ;; esac; }
stat() { if [ "$1" = -L ]; then command stat -c %a "$4"; else command stat "$@"; fi; }
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
    expect(run({ conf: "[interop]\n  enabled = false   # off\nappendWindowsPath=\"false\"\n" }, "sr_check_wsl_interop").code).toBe(0);
    // only the documented spelling counts, and no other spelling may say otherwise
    expect(run({ conf: "[Interop]\nenabled=false\nappendWindowsPath=false\n" }, "sr_check_wsl_interop").code).toBe(1);
    expect(run({ conf: `${SAFE_CONF}[Interop]\nEnabled=true\n` }, "sr_check_wsl_interop").code).toBe(1);
    expect(run({ conf: "[interop]\nenabled=true\nenabled=false\nappendWindowsPath=false\n" }, "sr_check_wsl_interop").code).toBe(1); // first or last: both must say false
    const missing = run({ conf: "[boot]\nsystemd=true\n" }, "sr_check_wsl_interop");
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.out).toMatch(/^WSL_INTEROP_NOT_DISABLED/);
    expect(run({ conf: "[interop]\nenabled=false\n" }, "sr_check_wsl_interop").code).toBe(1); // Windows PATH still appended
    expect(run({ conf: "[interop]\nenabled=false\nappendWindowsPath=false\nenabled=true\n" }, "sr_check_wsl_interop").code).toBe(1); // the last one wins
    expect(run({ conf: "[boot]\nenabled=false\nappendWindowsPath=false\n" }, "sr_check_wsl_interop").code).toBe(1); // wrong section
    expect(run({ conf: `${SAFE_CONF}[interop] # again\nenabled=true\n` }, "sr_check_wsl_interop").code).toBe(1); // a commented section header still counts
    const live = run({ conf: SAFE_CONF, interop: "enabled" }, "sr_check_wsl_interop");
    expect(live.code).toBe(1);
    expect(live.out).toMatch(/^WSL_INTEROP_ACTIVE/); // the file changed but WSL was not restarted
    expect(run({ conf: SAFE_CONF, interop: "disabled" }, "sr_check_wsl_interop").code).toBe(0);
    // an interop socket anyone may open: /init can still reach Windows without the binfmt entry
    expect(run({ conf: SAFE_CONF, sockets: { "1_interop": 0o777 } }, "sr_check_wsl_interop").out).toMatch(/^WSL_INTEROP_SOCKET_OPEN/);
    expect(run({ conf: SAFE_CONF, sockets: { "1_interop": 0o700 } }, "sr_check_wsl_interop").code).toBe(0);
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

  it("a running process of the requester that still holds an admin group (removed from /etc/group later) is refused", () => {
    const proc = (uid: number, groups: string) => `Name:\tclaude\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\nGroups:\t${groups}\n`;
    expect(run({ conf: SAFE_CONF, procs: [proc(1001, "994 1001"), proc(0, "0 27")] }, "sr_check_requester sr-designgen").code).toBe(0); // root's own sudo is not the requester's
    const held = run({ conf: SAFE_CONF, procs: [proc(1001, "994 27 1001")] }, "sr_check_requester sr-designgen");
    expect(held.code).toBe(1);
    expect(held.out).toMatch(/^REQUESTER_PROCESS_PRIVILEGED/);
    expect(run({ conf: SAFE_CONF, procs: [proc(1001, "998")] }, "sr_check_requester sr-designgen").code).toBe(1); // docker
    expect(run({ conf: SAFE_CONF, procs: [proc(1001, "0")] }, "sr_check_requester sr-designgen").code).toBe(1); // gid 0
  });

  it("root-only checks: any sudo rule, or a writable Windows drive / Startup folder, is refused", () => {
    const mounts = "C:\\134 /mnt/c 9p rw,relatime 0 0\nD:\\134 /mnt/my\\040drive drvfs rw 0 0\nC:\\134Users\\134me\\134SecondRootDemos /mnt/sr-export 9p rw 0 0\ntmpfs /tmp tmpfs rw 0 0\n";
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
    // the one export mount a person may give the requester: a plain folder, judged by what is mounted
    const exp = (src: string) => run({ mounts: `${src} /mnt/sr-export 9p rw 0 0\n`, writable: ["/mnt/sr-export"] }, "sr_check_requester_root sr-designgen");
    expect(exp("C:\\134Users\\134me\\134SecondRootDemos").code).toBe(0);
    for (const bad of ["C:\\134", "C:\\134Users", "C:\\134Users\\134me", "C:\\134Users\\134me\\134AppData\\134Roaming", "C:\\134ProgramData\\134x\\134y", "none", "C:\\134Users\\134me\\134x\\134..\\134..\\134..\\134PROGRA~3\\134MICROS~1", "C:\\134Users\\134me\\134..\\134..\\134x", "\\134\\134server\\134share\\134a\\134b"]) {
      const r = exp(bad);
      expect(r.code, bad).toBe(1);
      expect(r.out).toMatch(/^EXPORT_MOUNT_UNSAFE/);
    }
    // the requester may not open an interop socket
    expect(run({ sockets: { "7_interop": 0o770 }, writable: [] }, "sr_check_requester_root sr-designgen").code).toBe(0);
  });
});
