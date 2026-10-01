import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The requester jail (docs/operations/design-wsl-isolation.md). In WSL 2.7 the interop sockets
// (/run/WSL/*_interop) stay root:root 0777 with [interop] enabled=false, so the boundary between the
// requester (Claude, worker, Codex) and Windows / the Instagram profile is the jail, not the Linux user.
// What systemd does with these settings was checked against systemd 255 running as PID 1 (the review
// record lists the runs); here the settings, the probe and admin.sh's wiring are pinned.
const DIR = join(__dirname, "../../../scripts/sales-design-capture");
const PROPS = readFileSync(join(DIR, "jail", "jail.properties"), "utf8");
const ADMIN = readFileSync(join(DIR, "admin.sh"), "utf8");
const settings = PROPS.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("the requester jail", () => {
  it("hides every way to Windows and the profile, and lets the kernel refuse the rest", () => {
    for (const line of [
      "NoNewPrivileges=yes",
      "ProtectSystem=strict",
      "ProtectHome=tmpfs",
      "PrivateTmp=yes",
      "PrivateDevices=yes",
      "ProtectProc=invisible",
      "RestrictSUIDSGID=yes",
      "SystemCallArchitectures=native",
      "TemporaryFileSystem=/mnt:ro", // Windows drives, WSLg, /mnt/wsl
      "TemporaryFileSystem=/run:ro", // /run/WSL (interop sockets), /run/user, dbus
      "TemporaryFileSystem=/srv:ro",
      "InaccessiblePaths=-/usr/lib/wsl",
      "SystemCallErrorNumber=EPERM",
    ]) {
      expect(settings, line).toContain(line);
    }
    // vsock (WSL's own channel to Windows) is not among the allowed families
    const families = settings.find((l) => l.startsWith("RestrictAddressFamilies="))!;
    expect(families.split("=")[1]!.split(" ").sort()).toEqual(["AF_INET", "AF_INET6", "AF_NETLINK", "AF_UNIX"]);
    // io_uring could open sockets without socket(); the kernel log reader is gone too
    expect(settings.find((l) => l.startsWith("SystemCallFilter=~"))).toMatch(/io_uring_setup.*io_uring_enter.*io_uring_register.*syslog/);
    // the Windows host, the LAN and cloud metadata are refused by address (the DNS tunnel only is allowed)
    const deny = settings.find((l) => l.startsWith("IPAddressDeny="))!;
    for (const net of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "fc00::/7", "fe80::/10"]) expect(deny).toContain(net);
    expect(settings.find((l) => l.startsWith("IPAddressAllow="))).toBe("IPAddressAllow=127.0.0.0/8 ::1/128 10.255.255.254/32");
    // the spool: requests writable, results read-only; nothing else of /srv
    expect(settings).toContain("BindPaths=-/srv/sr-capture/requests");
    expect(settings).toContain("BindReadOnlyPaths=-/srv/sr-capture/results");
  });

  it("leaves out the settings that would break the Codex sandbox inside it (bubblewrap needs a fresh /proc)", () => {
    for (const key of ["ProtectKernelTunables", "ProtectKernelLogs", "ProtectHostname", "RestrictNamespaces", "PrivateUsers"]) {
      expect(settings.some((l) => l.startsWith(`${key}=`)), key).toBe(false);
    }
  });

  it("the probe refuses to run outside the jail's own network namespace", () => {
    const probe = readFileSync(join(DIR, "jail", "probe.py"), "utf8");
    expect(probe).toContain('open("/run/sr-jail/netns-id")');
    expect(probe).toContain('os.stat("/proc/self/ns/net").st_ino != want');
    const r = spawnSync("python3", ["-I", join(DIR, "jail", "probe.py"), userInfo().username], { encoding: "utf8" });
    expect(r.stdout).toContain("JAIL_UNSAFE NETWORK_NOT_PRIVATE");
  });

  it("the probe fails closed outside a jail, prints codes only, and refuses a browser profile left in the home", () => {
    const home = mkdtempSync(join(tmpdir(), "sr-jail-home-"));
    roots.push(home);
    const probe = (env: Record<string, string>) =>
      spawnSync("python3", ["-I", join(DIR, "jail", "probe.py"), userInfo().username], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, ...env } as unknown as NodeJS.ProcessEnv });
    const plain = probe({});
    expect(plain.status).toBe(1);
    expect(plain.stdout).toMatch(/JAIL_UNSAFE NEW_PRIVILEGES_POSSIBLE|JAIL_UNSAFE NO_SECCOMP_FILTER|JAIL_UNSAFE WRONG_USER/);
    // codes, then (only for reachable abstract sockets) their names: nothing read from a file
    for (const line of plain.stdout.trim().split("\n")) expect(line).toMatch(/^(JAIL_UNSAFE [A-Z0-9_]+|JAIL_WARN [A-Z0-9_]+|JAIL_NOTE abstract=@[\x21-\x7e]{0,80})$/);
    expect(probe({ DISPLAY: ":0" }).stdout).toContain("JAIL_UNSAFE ENV_DISPLAY");
    expect(probe({}).stdout).not.toContain("BROWSER_PROFILE_IN_HOME");
    mkdirSync(join(home, ".local", "share", "sr-instagram-browser", "Default"), { recursive: true });
    expect(probe({}).stdout).toContain("JAIL_UNSAFE BROWSER_PROFILE_IN_HOME");
    // a wrong user name is never JAIL_OK
    expect(spawnSync("python3", ["-I", join(DIR, "jail", "probe.py"), "someone-else"], { encoding: "utf8" }).stdout).toContain("JAIL_UNSAFE WRONG_USER");
  });

  it("admin.sh: every way the requester runs goes through the same jail settings and the probe", () => {
    // one list: the unit file, the person's shell, `run`, the check
    expect(ADMIN).toMatch(/grep -Ev '\^\[\[:space:\]\]\*\(#\|\$\)' "\$JAIL_LIB\/jail\.properties"/);
    expect(ADMIN).toMatch(/echo "ExecStartPre=\$py -I \$JAIL_LIB\/probe\.py \$req"/);
    expect(ADMIN).toMatch(/IPAddressDeny=%d\.%d\.%d\.%d\/32/); // the default gateway (the Windows host in WSL's NAT)
    for (const unit of ['--unit="sr-jail-shell-$$" "${JAIL_ARGS[@]}"', '--unit="sr-jail-run-$$" "${JAIL_ARGS[@]}"', '--unit="sr-jail-check-$$" "${JAIL_ARGS[@]}"']) expect(ADMIN).toContain(unit);
    // the Claude unit carries the settings, fetched on their own first: never a unit without them
    expect(ADMIN).toContain('props="$(jail_props "$req")" || {');
    expect(ADMIN).toMatch(/grep -qx "NoNewPrivileges=yes" <<<"\$props" && grep -q "\^ExecStartPre=\.\*probe\.py" <<<"\$props"/);
    expect(ADMIN).toMatch(/echo "Type=forking"\n\s+printf '%s\\n' "\$props"/);
    // the jail's own network namespace: pasta with no port forwarding either way, the gateway not mapped,
    // its id recorded for the probe; every jail unit needs it and goes with it
    expect(ADMIN).toContain("--config-net --no-map-gw -t none -u none -T none -U none --netns /run/netns/srjail");
    expect(ADMIN).toContain("stat -L -c %%i /run/netns/srjail > /run/sr-jail/netns-id");
    expect(ADMIN).toContain('JAIL_UNIT_DEPS=("Requires=$JAIL_NET" "BindsTo=$JAIL_NET" "After=$JAIL_NET")');
    expect(settings).toContain("NetworkNamespacePath=/run/netns/srjail");
    expect(settings).toContain("BindReadOnlyPaths=/run/sr-jail/netns-id");
    // Claude exiting ends tmux cleanly, so it restarts either way
    expect(ADMIN).toMatch(/echo "Type=forking"[\s\S]*?echo "Restart=always"/);
    // no login shell outside the jail
    expect(ADMIN).toContain('usermod -s /usr/sbin/nologin "$req"');
    // the jail files themselves come from a checkout the requester cannot change
    expect(ADMIN).toMatch(/for f in "\$SELF_DIR\/admin\.sh" "\$SELF_DIR\/host-check\.sh" "\$SELF_DIR\/jail\/jail\.properties" "\$SELF_DIR\/jail\/probe\.py"; do/);
    // install stops when the probe does not hold on this machine
    expect(ADMIN).toMatch(/jail_check "\$REQUESTER" \|\| \{ echo "JAIL_UNSAFE/);
    // the sign-in stops the jail first, then checks; Claude comes back whatever happens after the stop
    const login = ADMIN.slice(ADMIN.indexOf("  login)"), ADMIN.indexOf("  jail-check)"));
    expect(login.indexOf("stop_jail_units")).toBeGreaterThan(0);
    expect(login.indexOf("stop_jail_units")).toBeLessThan(login.indexOf("host_safe"));
    expect(login.indexOf("trap restore EXIT")).toBeLessThan(login.indexOf("stop_jail_units"));
  });
});
