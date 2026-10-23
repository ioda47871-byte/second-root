import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// DEV-088 (A-3, docs/operations/passt-update-plan.md §4.6): the jail's DNS address 198.51.100.53 takes UDP/53 and
// nothing else, whatever pasta forwards. Newer pasta (386b5f5) also maps UDP/853, TCP/53 and TCP/853 to the host
// resolver; three ip rules in the jail's namespace refuse all of it but UDP/53. Nothing here makes a namespace or
// changes a rule: the unit text admin.sh writes is rendered, the probe's netlink reader is fed built dumps (and
// this machine's own rules, read only), and jail_check / jail_rules run with stand-ins for systemd-run and ip.
const DIR = join(__dirname, "../../../scripts/sales-design-capture");
const ADMIN = readFileSync(join(DIR, "admin.sh"), "utf8");
const PROBE_PATH = join(DIR, "jail", "probe.py");
const PROBE = readFileSync(PROBE_PATH, "utf8");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "sr-jail-dns-"));
  roots.push(d);
  return d;
};

// The rules the probe requires, from its source.
const expectedRules = (): string[] => {
  const block = /EXPECTED_RULES = \(\n([\s\S]*?)\n\)/.exec(PROBE)![1]!;
  return [...block.matchAll(/^\s+"([^"]+)",$/gm)].map((m) => m[1]!);
};

// sr-jail-net.service as jail_install writes it, with stand-in binary paths.
const renderNetUnit = (): string => {
  const start = ADMIN.indexOf('  net_unit="$(');
  const end = ADMIN.indexOf('  )"\n  claude_unit="$(');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const script = [
    "set -euo pipefail",
    "ip_bin=/usr/sbin/ip pasta_bin=/usr/bin/pasta systemctl_bin=/usr/bin/systemctl",
    "JAIL_DNS=198.51.100.53 JAIL_CLAUDE=sr-jail-claude.service",
    ADMIN.slice(start, end + 4),
    'printf "%s\\n" "$net_unit"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};

const fn = (name: string): string => {
  const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m").exec(ADMIN);
  expect(m, name).not.toBeNull();
  return m![0];
};

describe("the jail's DNS rules (DEV-088, A-3)", () => {
  it("the unit makes exactly these three rules, in a namespace just made, refusals first, all before pasta", () => {
    const unit = renderNetUnit().split("\n");
    const pre = unit.filter((l) => l.startsWith("ExecStartPre="));
    expect(pre.slice(0, 5)).toEqual([
      "ExecStartPre=-/usr/sbin/ip netns delete srjail",
      "ExecStartPre=/usr/sbin/ip netns add srjail",
      "ExecStartPre=/usr/sbin/ip -n srjail rule add to 198.51.100.53/32 prohibit priority 100",
      "ExecStartPre=/usr/sbin/ip -n srjail rule add to 198.51.100.53/32 ipproto udp dport 853 prohibit priority 98",
      "ExecStartPre=/usr/sbin/ip -n srjail rule add to 198.51.100.53/32 ipproto udp dport 53 lookup main priority 99",
    ]);
    // the old TCP-only rule is gone; no other rule is made, changed or removed anywhere in admin.sh
    expect(ADMIN).not.toContain("ipproto tcp prohibit");
    expect(unit.filter((l) => / rule /.test(l))).toHaveLength(3);
    expect(ADMIN.match(/ rule add /g)).toHaveLength(3);
    expect(ADMIN).not.toMatch(/ rule (del|delete|flush|replace|change) /);
    // the rule lines carry no "-": a failing one fails the unit before pasta starts (no namespace without them)
    for (const l of pre.slice(2, 5)) expect(l.startsWith("ExecStartPre=-")).toBe(false);
    // ... and they come before pasta and before the netns id / resolv.conf a jail unit needs
    const idx = (s: string) => unit.findIndex((l) => l.startsWith(s));
    const lastRule = idx("ExecStartPre=/usr/sbin/ip -n srjail rule add to 198.51.100.53/32 ipproto udp dport 53");
    expect(lastRule).toBeLessThan(idx("ExecStartPre=/bin/sh -c 'stat -L -c %%i /run/netns/srjail > /run/sr-jail/netns-id"));
    expect(lastRule).toBeLessThan(idx("ExecStart=/usr/bin/pasta"));
    // idempotent: every start (a restart, a re-install, a reboot) makes a new namespace, so the set is made once in
    // an empty rule table; the namespace goes with the unit
    expect(unit).toContain("ExecStopPost=-/usr/sbin/ip netns delete srjail");
    expect(unit).toContain("Restart=always");
    // pasta's flags and its own address filter are unchanged by this
    expect(unit).toContain("ExecStart=/usr/bin/pasta -f -q --runas 0 --config-net --no-map-gw -t none -u none -T none -U none --dns-forward 198.51.100.53 --netns /run/netns/srjail");
    expect(unit).toContain("IPAddressAllow=10.255.255.254/32");
    expect(unit).toContain("IPAddressDeny=10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 ::1/128 fc00::/7 fe80::/10");
  });

  it("the probe requires exactly the rules the unit makes, plus the kernel's three defaults", () => {
    const made = [...renderNetUnit().matchAll(/rule add to (\S+) (?:ipproto (udp) dport (\d+) )?(prohibit|lookup main) priority (\d+)$/gm)].map((m) => ({
      prio: Number(m[5]),
      text: `${m[5]}: to ${m[1]}${m[2] ? ` ipproto 17 dport ${m[3]}` : ""} ${m[4] === "prohibit" ? "prohibit" : "lookup 254"}`,
    }));
    expect(made).toHaveLength(3);
    const kernel = [
      { prio: 0, text: "0: lookup 255" },
      { prio: 32766, text: "32766: lookup 254" },
      { prio: 32767, text: "32767: lookup 253" },
    ];
    expect(expectedRules()).toEqual([...kernel, ...made].sort((a, b) => a.prio - b.prio).map((r) => r.text));
    expect(expectedRules()).toEqual([
      "0: lookup 255",
      "98: to 198.51.100.53/32 ipproto 17 dport 853 prohibit",
      "99: to 198.51.100.53/32 ipproto 17 dport 53 lookup 254",
      "100: to 198.51.100.53/32 prohibit",
      "32766: lookup 254",
      "32767: lookup 253",
    ]);
  });

  it("the probe's netlink reader: the designed set passes; anything more, less or different fails closed", () => {
    // Built RTM_NEWRULE dumps, the way the kernel sends them (fib_nl_fill_rule / fib4_rule_fill in v6.18:
    // FRA_TABLE, FRA_SUPPRESS_PREFIXLEN and FRA_PROTOCOL always; FRA_PRIORITY unless 0; then the selectors).
    const harness = String.raw`
import importlib.util, json, socket, struct, sys
spec = importlib.util.spec_from_file_location("probe", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SEQ = 7
D = "198.51.100.53"
def attr(t, data):
    a = struct.pack("=HH", 4 + len(data), t) + data
    return a + b"\0" * ((4 - len(a) % 4) % 4)
def rule(prio, table, action=1, dst=None, proto=None, dport=None, flags=0, extra=b"", proto_label=0, seq=SEQ, dst_len=None):
    body = struct.pack("=8BI", socket.AF_INET, (32 if dst else 0) if dst_len is None else dst_len, 0, 0, table if table < 256 else 252, 0, 0, action, flags)
    body += attr(15, struct.pack("=I", table)) + attr(14, struct.pack("=i", -1)) + attr(21, bytes([proto_label]))
    if prio:
        body += attr(6, struct.pack("=I", prio))
    if dport:
        body += attr(24, struct.pack("=HH", *dport))
    if proto:
        body += attr(22, bytes([proto]))
    body += extra
    if dst:
        body += attr(1, socket.inet_aton(dst))
    return struct.pack("=IHHII", 16 + len(body), 32, 2, seq, 0) + body
DONE = struct.pack("=IHHII", 20, 3, 2, SEQ, 0) + b"\0\0\0\0"
K0, KMAIN, KDEF = rule(0, 255, proto_label=2), rule(32766, 254, proto_label=2), rule(32767, 253, proto_label=2)
R98, R99, R100 = rule(98, 0, 8, D, 17, (853, 853)), rule(99, 254, 1, D, 17, (53, 53)), rule(100, 0, 8, D)
cases = {
    "designed": [K0, R98, R99, R100, KMAIN, KDEF],
    "before_a3": [K0, rule(100, 0, 8, D, 6), KMAIN, KDEF],
    "no_rules": [K0, KMAIN, KDEF],
    "missing_98": [K0, R99, R100, KMAIN, KDEF],
    "missing_100": [K0, R98, R99, KMAIN, KDEF],
    "99_opens_853": [K0, R98, rule(99, 254, 1, D, 17, (853, 853)), R100, KMAIN, KDEF],
    "99_port_range": [K0, R98, rule(99, 254, 1, D, 17, (53, 853)), R100, KMAIN, KDEF],
    "99_any_proto": [K0, R98, rule(99, 254, 1, D, None, (53, 53)), R100, KMAIN, KDEF],
    "99_tcp": [K0, R98, rule(99, 254, 1, D, 6, (53, 53)), R100, KMAIN, KDEF],
    "99_whole_net": [K0, R98, rule(99, 254, 1, D, 17, (53, 53), dst_len=24), R100, KMAIN, KDEF],
    "extra_allow": [K0, rule(50, 254, 1, D), R98, R99, R100, KMAIN, KDEF],
    "duplicate_99": [K0, R98, R99, R99, R100, KMAIN, KDEF],
    "100_inverted": [K0, R98, R99, rule(100, 0, 8, D, flags=2), KMAIN, KDEF],
    "98_blackhole": [K0, rule(98, 0, 6, D, 17, (853, 853)), R99, R100, KMAIN, KDEF],
    "99_from_iif": [K0, R98, rule(99, 254, 1, D, 17, (53, 53), extra=attr(3, b"tap0\0")), R100, KMAIN, KDEF],
    "99_dport_mask": [K0, R98, rule(99, 254, 1, D, 17, (53, 53), extra=attr(29, struct.pack("=H", 0))), R100, KMAIN, KDEF],
    "100_other_table": [K0, R98, R99, rule(100, 200, 1, D), KMAIN, KDEF],
    "main_moved": [K0, R98, R99, R100, rule(32765, 254, proto_label=2), KDEF],
}
out = {}
for name, msgs in cases.items():
    rules = m.parse_rule_dump([b"".join(msgs) + DONE], SEQ)
    out[name] = {"rules": rules, "exact": tuple(rules) == m.EXPECTED_RULES}
# the same dump split over several datagrams
whole = b"".join(cases["designed"]) + DONE
out["split"] = tuple(m.parse_rule_dump([b"".join(cases["designed"][:2]), b"".join(cases["designed"][2:]) + DONE], SEQ)) == m.EXPECTED_RULES
# malformed or foreign answers are errors (the probe says DNS_RULES_UNCHECKED), never a pass
bad = {
    "no_done": [b"".join(cases["designed"])],
    "wrong_seq": [b"".join(cases["designed"][:-1]) + rule(32767, 253, seq=8) + DONE],
    "truncated": [whole[:-30]],
    "nlmsg_error": [struct.pack("=IHHII", 36, 2, 0, SEQ, 0) + struct.pack("=i", -13) + b"\0" * 16],
    "short_attr": [struct.pack("=IHHII", 16 + 12 + 4, 32, 2, SEQ, 0) + struct.pack("=8BI", 2, 0, 0, 0, 254, 0, 0, 1, 0) + struct.pack("=HH", 2, 15) + DONE],
    "repeated_attr": [rule(99, 254, 1, D, 17, (53, 53), extra=attr(24, struct.pack("=HH", 1, 65535))) + DONE],
}
# 1 to 3 bytes after the last attribute (too short for another one) inside the message: refused, not ignored
for n in (1, 2, 3):
    r = rule(100, 0, 8, D)
    bad["trailing_%d" % n] = [struct.pack("=I", len(r) + n) + r[4:] + b"\0" * n + b"\0" * ((4 - n) % 4) + DONE]
out["bad"] = {}
for name, chunks in bad.items():
    try:
        m.parse_rule_dump(chunks, SEQ)
        out["bad"][name] = "PARSED"
    except (ValueError, IndexError, struct.error):
        out["bad"][name] = "REFUSED"
print(json.dumps(out))
`;
    const r = spawnSync("python3", ["-I", "-c", harness, PROBE_PATH], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, { rules: string[]; exact: boolean }> & { split: boolean; bad: Record<string, string> };
    expect(out.designed).toEqual({ rules: expectedRules(), exact: true });
    expect(out.split).toBe(true);
    // today's rule set (before A-3) and a namespace without rules are both refused
    expect(out.before_a3!.rules).toEqual(["0: lookup 255", "100: to 198.51.100.53/32 ipproto 6 prohibit", "32766: lookup 254", "32767: lookup 253"]);
    for (const name of [
      "before_a3",
      "no_rules",
      "missing_98",
      "missing_100",
      "99_opens_853",
      "99_port_range",
      "99_any_proto",
      "99_tcp",
      "99_whole_net",
      "extra_allow",
      "duplicate_99",
      "100_inverted",
      "98_blackhole",
      "99_from_iif",
      "99_dport_mask",
      "100_other_table",
      "main_moved",
    ]) {
      expect(out[name]!.exact, name).toBe(false);
    }
    // what the reader could not express shows up as a marker, never as a clean expected line
    expect(out["100_inverted"]!.rules).toContain("100: other=0/0/2 to 198.51.100.53/32 prohibit");
    expect(out["98_blackhole"]!.rules).toContain("98: to 198.51.100.53/32 ipproto 17 dport 853 action6");
    expect(out["99_from_iif"]!.rules).toContain("99: to 198.51.100.53/32 ipproto 17 dport 53 attr3 lookup 254");
    expect(out["99_port_range"]!.rules).toContain("99: to 198.51.100.53/32 ipproto 17 dport 53-853 lookup 254");
    expect(out.bad).toEqual({
      no_done: "REFUSED",
      wrong_seq: "REFUSED",
      truncated: "REFUSED",
      nlmsg_error: "REFUSED",
      short_attr: "REFUSED",
      repeated_attr: "REFUSED",
      trailing_1: "REFUSED",
      trailing_2: "REFUSED",
      trailing_3: "REFUSED",
    });
  }, 30_000);

  it("the probe's netlink reader reads this machine's real rules (read only) and they are not the jail's", () => {
    const r = spawnSync(
      "python3",
      ["-I", "-c", 'import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location("probe", sys.argv[1])\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nprint(json.dumps(m.ipv4_rules()))', PROBE_PATH],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const rules = JSON.parse(r.stdout) as string[];
    // a host namespace: at least the kernel's local and main lookups, and never the jail's set
    expect(rules).toContain("0: lookup 255");
    expect(rules).toContain("32766: lookup 254");
    for (const line of rules) expect(line).toMatch(/^\d+: /);
    expect(rules).not.toEqual(expectedRules());
  }, 30_000);

  it("jail-check: the probe first, then name resolution with getent; any failure is a failure", () => {
    const d = scratch();
    const log = join(d, "log");
    // systemd-run stand-in: logs its arguments, fails the probe or getent when told to
    writeFileSync(
      join(d, "systemd-run"),
      `#!/bin/bash\nprintf '%s\\n' "$*" >> "${log}"\ncase "$*" in\n  *probe.py*) [ "\${FAIL_PROBE:-0}" = 1 ] && { echo "JAIL_UNSAFE DNS_RULES_NOT_EXACT"; exit 1; }; echo JAIL_OK ;;\n  *getent*) [ "\${FAIL_DNS:-0}" = 1 ] && exit 2; echo "140.82.112.3 github.com" ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(d, "systemd-run"), 0o755);
    const run = (env: Record<string, string>) => {
      writeFileSync(log, "");
      const script = [
        "set -euo pipefail",
        "JAIL_LIB=/usr/local/lib/sr-jail",
        "jail_python() { echo /usr/bin/python3; }",
        'jail_args() { JAIL_ARGS=(-p NoNewPrivileges=yes -p "ExecStartPre=/usr/bin/python3 -I $JAIL_LIB/probe.py $1" -p Requires=sr-jail-net.service); }',
        fn("jail_check"),
        'jail_check sr-designgen && echo "RC=0" || echo "RC=$?"',
      ].join("\n");
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${d}:/usr/bin:/bin`, ...env } as unknown as NodeJS.ProcessEnv });
      return { out: r.stdout, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
    };
    const ok = run({});
    expect(ok.out).toBe("JAIL_OK\nJAIL_DNS_OK\nRC=0\n");
    expect(ok.calls).toHaveLength(2);
    expect(ok.calls[0]).toContain("--unit=sr-jail-check-");
    expect(ok.calls[0]).toContain("-- /usr/bin/python3 -I /usr/local/lib/sr-jail/probe.py sr-designgen");
    // the lookup runs with the same jail settings (minus the probe as ExecStartPre)
    expect(ok.calls[1]).toMatch(/--unit=sr-jail-dns-\d+ -p NoNewPrivileges=yes -p Requires=sr-jail-net\.service -- getent hosts github\.com$/);
    for (const c of ok.calls) expect(c).not.toContain("ExecStartPre=");
    // the probe refuses: no lookup at all (it could hang without the TCP refusal), and the check fails
    const unsafe = run({ FAIL_PROBE: "1" });
    expect(unsafe.out).toBe("JAIL_UNSAFE DNS_RULES_NOT_EXACT\nRC=1\n");
    expect(unsafe.calls).toHaveLength(1);
    // the probe passes but nothing resolves: the check fails
    const noDns = run({ FAIL_DNS: "1" });
    expect(noDns.out).toMatch(/^JAIL_OK\nJAIL_DNS_FAILED: getent hosts github\.com did not resolve inside the jail \(UDP\/53 through pasta\)\nRC=1\n$/);
    // every caller still stops on a failed check
    expect(ADMIN).toMatch(/jail_check "\$REQUESTER" \|\| \{ echo "JAIL_UNSAFE: the jail does not hold on this machine \(lines above\)\. Claude is not started\."; exit 3; \}/);
    expect(ADMIN).toMatch(/jail_install "\$REQUESTER"\n\s+jail_check "\$REQUESTER" \|\| \{ echo "JAIL_UNSAFE: the jail does not hold on this machine \(lines above\)"; exit 3; \}/);
  });

  it("jail-rules prints the namespace's rules in a stable form, reads only, and says so when there is no jail network", () => {
    const body = fn("jail_rules");
    // read only: shows rules, never makes, removes or changes one
    expect(body).not.toMatch(/rule (add|del|delete|flush|replace|change)|netns (add|delete)|systemctl/);
    expect(body).toContain("ip -n srjail -4 rule show");
    expect(body).toContain("ip -n srjail -6 rule show");
    expect(ADMIN).toMatch(/ {2}jail-rules\)\n {4}jail_rules\n {4};;/);
    expect(ADMIN).toContain('echo "jail network rules:"; jail_rules || true');
    const d = scratch();
    const run = (ipScript: string) => {
      writeFileSync(join(d, "ip"), ipScript);
      chmodSync(join(d, "ip"), 0o755);
      return spawnSync("bash", ["-c", ["set -euo pipefail", body, 'jail_rules && echo "RC=0" || echo "RC=$?"'].join("\n")], {
        encoding: "utf8",
        env: { PATH: `${d}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv,
      }).stdout;
    };
    // the same text `ip rule show` prints (a tab after the priority), blanks squeezed
    const after = run(
      `#!/bin/bash\ncase "$*" in\n  *-4*) printf '0:\\tfrom all lookup local\\n98:\\tfrom all to 198.51.100.53 ipproto udp dport 853 prohibit\\n99:\\tfrom all to 198.51.100.53 ipproto udp dport 53 lookup main\\n100:\\tfrom all to 198.51.100.53 prohibit\\n32766:\\tfrom all lookup main \\n32767:\\tfrom all lookup default\\n' ;;\n  *-6*) printf '0:\\tfrom all lookup local\\n32766:\\tfrom all lookup main\\n' ;;\nesac\n`,
    );
    expect(after).toBe(
      [
        "inet:",
        "0: from all lookup local",
        "98: from all to 198.51.100.53 ipproto udp dport 853 prohibit",
        "99: from all to 198.51.100.53 ipproto udp dport 53 lookup main",
        "100: from all to 198.51.100.53 prohibit",
        "32766: from all lookup main",
        "32767: from all lookup default",
        "inet6:",
        "0: from all lookup local",
        "32766: from all lookup main",
        "RC=0",
        "",
      ].join("\n"),
    );
    // no IPv6 rules at all (a kernel without them) is not an error; no namespace is
    expect(run(`#!/bin/bash\ncase "$*" in *-4*) printf '0:\\tfrom all lookup local\\n' ;; *) echo "RTNETLINK answers: Address family not supported by protocol" >&2; exit 2 ;; esac\n`)).toBe(
      "inet:\n0: from all lookup local\ninet6:\nRC=0\n",
    );
    expect(run(`#!/bin/bash\necho 'Cannot open network namespace "srjail": No such file or directory' >&2\nexit 1\n`)).toBe("NO_JAIL_NETNS: sr-jail-net is not running\nRC=1\n");
  });
});
