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
    // the Windows host, the LAN, cloud metadata and the WSL DNS tunnel address are refused by address
    const deny = settings.find((l) => l.startsWith("IPAddressDeny="))!;
    for (const net of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "fc00::/7", "fe80::/10"]) expect(deny).toContain(net);
    // the spool: requests writable, results read-only; nothing else of /srv
    expect(settings).toContain("BindPaths=-/srv/sr-capture/requests");
    expect(settings).toContain("BindReadOnlyPaths=-/srv/sr-capture/results");
  });

  it("shows exactly the capture spool and the design bridge spool of /srv, nothing more (DEV-031)", () => {
    // Every setting that names a path under /srv, with its direction. The bridge's jobs are read-only
    // in the jail and its results writable; /srv/sr-design-bridge itself, the bridge user's home
    // (token, state) and any other /srv path stay out.
    const srv = settings.filter((l) => /(^|[=:\s-])\/srv(\/|$|:|\s)/.test(l)).sort();
    expect(srv).toEqual(
      [
        "BindPaths=-/srv/sr-capture/requests",
        "BindPaths=-/srv/sr-design-bridge/from-worker",
        "BindReadOnlyPaths=-/srv/sr-capture/results",
        "BindReadOnlyPaths=-/srv/sr-design-bridge/to-worker",
        "TemporaryFileSystem=/srv:ro",
      ].sort(),
    );
    // the bridge spool comes after the empty /srv, so it is laid over it, never replaced by it
    const at = (line: string) => settings.indexOf(line);
    expect(at("TemporaryFileSystem=/srv:ro")).toBeLessThan(at("BindReadOnlyPaths=-/srv/sr-design-bridge/to-worker"));
    expect(at("TemporaryFileSystem=/srv:ro")).toBeLessThan(at("BindPaths=-/srv/sr-design-bridge/from-worker"));
    // no other kind of mount or path setting reaches the bridge user's home or token
    expect(settings.filter((l) => /sr-designbridge|design-bridge\.token|\.config\/second-root/.test(l))).toEqual([]);
    // the probe fails the jail when the bridge user's home is visible
    const probe = readFileSync(join(DIR, "jail", "probe.py"), "utf8");
    expect(probe).toContain('"/home/sr-designbridge",');
    // the network and the rest of the boundary are unchanged by this: same families, no new allow
    expect(settings.find((l) => l.startsWith("IPAddressAllow="))).toBe("IPAddressAllow=127.0.0.0/8 ::1/128 198.51.100.53/32");
    expect(settings.filter((l) => /^(BindPaths|BindReadOnlyPaths)=/.test(l)).sort()).toEqual(
      [
        "BindPaths=-/mnt/sr-export",
        "BindPaths=-/srv/sr-capture/requests",
        "BindPaths=-/srv/sr-design-bridge/from-worker",
        "BindReadOnlyPaths=-/srv/sr-capture/results",
        "BindReadOnlyPaths=-/srv/sr-design-bridge/to-worker",
        "BindReadOnlyPaths=/run/sr-jail/netns-id",
        "BindReadOnlyPaths=/run/sr-jail/resolv.conf:/etc/resolv.conf",
      ].sort(),
    );
  });

  it("leaves out the settings that would break the Codex sandbox inside it (bubblewrap needs a fresh /proc)", () => {
    for (const key of ["ProtectKernelTunables", "ProtectKernelLogs", "ProtectHostname", "RestrictNamespaces", "PrivateUsers"]) {
      expect(settings.some((l) => l.startsWith(`${key}=`)), key).toBe(false);
    }
  });

  it("DNS is UDP-only: TCP to the jail's DNS address is refused in the jail's namespace before pasta starts; edns0; the WSL DNS tunnel stays unreachable", () => {
    // the rule: inside the jail's namespace only (ip -n srjail), right after the namespace is made, before pasta
    const rule = 'echo "ExecStartPre=$ip_bin -n srjail rule add to $JAIL_DNS/32 ipproto tcp prohibit priority 100"';
    expect(ADMIN).toContain(rule);
    const netns = ADMIN.indexOf('echo "ExecStartPre=$ip_bin netns add srjail"');
    expect(netns).toBeGreaterThan(0);
    expect(ADMIN.indexOf(rule)).toBeGreaterThan(netns);
    expect(ADMIN.indexOf(rule)).toBeLessThan(ADMIN.indexOf('echo "ExecStart=$pasta_bin'));
    // UDP/53 still forwarded by pasta; the jail's resolv.conf asks for EDNS0 (fewer truncated answers)
    expect(ADMIN).toContain("--dns-forward $JAIL_DNS --netns /run/netns/srjail");
    expect(ADMIN).toMatch(/printf \\"nameserver \$JAIL_DNS\\\\\\\\noptions edns0\\\\\\\\n\\" > \/run\/sr-jail\/resolv\.conf/);
    // the jail never reaches the WSL DNS tunnel (10.0.0.0/8 denied; only pasta's own unit may)
    expect(settings.find((l) => l.startsWith("IPAddressAllow="))).not.toContain("10.255.255.254");
    expect(settings.find((l) => l.startsWith("IPAddressDeny="))).toContain("10.0.0.0/8");
    // the probe checks both, with the same address admin.sh uses, and fails closed
    const probe = readFileSync(join(DIR, "jail", "probe.py"), "utf8");
    expect(probe).toContain('JAIL_DNS = "198.51.100.53"');
    expect(probe).toContain('WSL_DNS_TUNNEL = "10.255.255.254"');
    for (const code of ["DNS_TCP_NOT_REFUSED", "DNS_TCP_REFUSED_SLOWLY", "DNS_TUNNEL_REACHABLE", "DNS_TUNNEL_NOT_FILTERED"]) expect(probe).toContain(`fail("${code}")`);
    expect(probe).toMatch(/if e\.errno != errno\.EACCES:\n\s+fail\("DNS_TCP_NOT_REFUSED"\)/);
    expect(probe).not.toMatch(/ip in \("0\.0\.0\.0", "10\.255\.255\.254"\)/); // no longer skipped
    // outside a jail (no rule): TCP to the DNS address is not refused, so the probe fails
    const r = spawnSync("python3", ["-I", join(DIR, "jail", "probe.py"), userInfo().username], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/JAIL_UNSAFE DNS_TCP_(NOT_REFUSED|REFUSED_SLOWLY)/);
  }, 30_000);

  it("the probe refuses to run outside the jail's own network namespace", () => {
    const probe = readFileSync(join(DIR, "jail", "probe.py"), "utf8");
    expect(probe).toContain('open("/run/sr-jail/netns-id")');
    expect(probe).toContain('os.stat("/proc/self/ns/net").st_ino != want');
    const r = spawnSync("python3", ["-I", join(DIR, "jail", "probe.py"), userInfo().username], { encoding: "utf8" });
    expect(r.stdout).toContain("JAIL_UNSAFE NETWORK_NOT_PRIVATE");
  }, 30_000);

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
  }, 60_000);

  it("admin.sh: every way the requester runs goes through the same jail settings and the probe", () => {
    // one list: the unit file, the person's shell, `run`, the check
    expect(ADMIN).toMatch(/grep -Ev '\^\[\[:space:\]\]\*\(#\|\$\)' "\$JAIL_LIB\/jail\.properties"/);
    expect(ADMIN).toMatch(/echo "ExecStartPre=\$py -I \$JAIL_LIB\/probe\.py \$req"/);
    expect(ADMIN).toMatch(/IPAddressDeny=%d\.%d\.%d\.%d\/32/); // the default gateway (the Windows host in WSL's NAT)
    for (const unit of ['--unit="sr-jail-shell-$$" "${JAIL_ARGS[@]}" -- /bin/bash -l', '--unit="sr-jail-run-$$-$RANDOM" -p RuntimeMaxSec=3500 "${JAIL_ARGS[@]}" -- "$@"', '--unit="sr-jail-check-$$" "${args[@]}" -- "$py"']) expect(ADMIN).toContain(unit);
    // the Claude unit carries the settings, fetched on their own first: never a unit without them
    expect(ADMIN).toContain('props="$(jail_props "$req")" || {');
    expect(ADMIN).toMatch(/grep -qx "NoNewPrivileges=yes" <<<"\$props" && grep -q "\^ExecStartPre=\.\*probe\.py" <<<"\$props"/);
    expect(ADMIN).toMatch(/echo "Type=forking"\n\s+printf '%s\\n' "\$props"/);
    // the jail's own network namespace: pasta with no port forwarding either way, the gateway not mapped,
    // its id recorded for the probe; every jail unit needs it and goes with it
    expect(ADMIN).toContain("--config-net --no-map-gw -t none -u none -T none -U none --dns-forward $JAIL_DNS --netns /run/netns/srjail");
    // the jail never reaches the WSL DNS tunnel address (on the VM's loopback, where every 0.0.0.0 service answers):
    // its only DNS server is a documentation address that pasta alone answers on port 53
    expect(settings).toContain("IPAddressAllow=127.0.0.0/8 ::1/128 198.51.100.53/32");
    expect(settings).toContain("BindReadOnlyPaths=/run/sr-jail/resolv.conf:/etc/resolv.conf");
    expect(ADMIN).toContain("JAIL_DNS=198.51.100.53");
    expect(ADMIN).toContain("stat -L -c %%i /run/netns/srjail > /run/sr-jail/netns-id");
    expect(ADMIN).toContain('JAIL_UNIT_DEPS=("Requires=$JAIL_NET" "BindsTo=$JAIL_NET" "After=$JAIL_NET")');
    expect(settings).toContain("NetworkNamespacePath=/run/netns/srjail");
    expect(settings).toContain("BindReadOnlyPaths=/run/sr-jail/netns-id");
    // Claude exiting ends tmux cleanly, so it restarts either way
    expect(ADMIN).toMatch(/echo "Type=forking"[\s\S]*?echo "Restart=always"/);
    // jail-check runs the probe as the unit's own command (systemd-run --pipe drops ExecStartPre output),
    // with every other jail setting kept
    const check = ADMIN.slice(ADMIN.indexOf("jail_check() {"), ADMIN.indexOf("stop_jail_units() {"));
    expect(check).toMatch(/\[ "\$\{JAIL_ARGS\[\$i\]\}" = -p \] && \[\[ "\$\{JAIL_ARGS\[\$\(\(i \+ 1\)\)\]\}" == ExecStartPre=\* \]\]/);
    expect(check).toContain('-- "$py" -I "$JAIL_LIB/probe.py" "$req"');
    // a loaded unit that dropped a setting (older systemd, a typo) is refused
    expect(ADMIN).toContain('systemd-analyze verify "/etc/systemd/system/$JAIL_CLAUDE"');
    expect(ADMIN).toMatch(/for want in NoNewPrivileges=yes ProtectSystem=strict ProtectHome=tmpfs PrivateDevices=yes ProtectProc=invisible NetworkNamespacePath=\/run\/netns\/srjail RestrictSUIDSGID=yes; do/);
    // root runs and installs only from the root-only clone, at the approved commit
    expect(ADMIN).toContain("ROOT_CLONE=/root/sr-capture-admin");
    expect(ADMIN).toContain('[ "$(git -C "$SELF_DIR" rev-parse HEAD 2>/dev/null)" = "$sha" ]');
    expect(ADMIN).toContain('install -m 0644 "$SELF_DIR/systemd/sr-capture.service"');
    expect(ADMIN).not.toContain("$HOME_DIR/second-root/scripts/sales-design-capture/systemd");
    // ptrace is refused inside the jail
    expect(settings.find((l) => l.startsWith("SystemCallFilter=~"))).toMatch(/ptrace process_vm_readv process_vm_writev/);
    // no login shell outside the jail
    expect(ADMIN).toContain('usermod -s /usr/sbin/nologin "$req"');
    // the jail files themselves come from a checkout the requester cannot change
    expect(ADMIN).toMatch(/for f in "\$SELF_DIR\/admin\.sh" "\$SELF_DIR\/host-check\.sh" "\$SELF_DIR\/jail\/jail\.properties" "\$SELF_DIR\/jail\/probe\.py"; do/);
    // install stops when the probe does not hold on this machine
    expect(ADMIN).toMatch(/jail_check "\$REQUESTER" \|\| \{ echo "JAIL_UNSAFE/);
    // install: an old requester process (Phase 2) is refused, the shell becomes nologin, and only then the checks
    const install = ADMIN.slice(ADMIN.indexOf("  install)"), ADMIN.indexOf("  approve)"));
    expect(install.indexOf('pgrep -u "$REQUESTER"')).toBeGreaterThan(0);
    expect(install.indexOf('pgrep -u "$REQUESTER"')).toBeLessThan(install.indexOf('usermod -s /usr/sbin/nologin "$REQUESTER"'));
    expect(install.indexOf('usermod -s /usr/sbin/nologin "$REQUESTER"')).toBeLessThan(install.indexOf("host_safe"));
    // the sign-in stops the jail first, then checks; Claude comes back whatever happens after the stop
    const login = ADMIN.slice(ADMIN.indexOf("  login)"), ADMIN.indexOf("  jail-check)"));
    expect(login.indexOf("stop_jail_units")).toBeGreaterThan(0);
    expect(login.indexOf("stop_jail_units")).toBeLessThan(login.indexOf("host_safe"));
    expect(login.indexOf("trap restore EXIT")).toBeLessThan(login.indexOf("stop_jail_units"));
    // and nothing starts Claude during the sign-in: a runtime drop-in whose condition never holds
    // (a runtime mask would lose to the unit file in /etc), removed again by restore
    expect(login.indexOf("ConditionPathExists=/nonexistent/sr-login-in-progress")).toBeGreaterThan(0);
    expect(login.indexOf("ConditionPathExists=/nonexistent/sr-login-in-progress")).toBeLessThan(login.indexOf("stop_jail_units"));
    expect(login).toContain('rm -f "$LOGIN_DROPIN"');
  });
});
