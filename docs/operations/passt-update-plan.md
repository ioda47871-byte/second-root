# Updating passt / pasta without weakening the jail (DEV-086, design only)

Status: **read-only design (2026-10-22). Nothing has been installed, changed or run on the WSL machine.** No Codex
run, no passt update, no WSL config change. Every step in §5–§6 is a proposal, and each needs the human approval named in
§8, in that order. Related: [`imagegen-timeout-investigation.md`](imagegen-timeout-investigation.md) (H1),
[`design-image-poc.md`](design-image-poc.md) §"HUMAN-024" (24a result, 24b commands and the decision table),
[`design-wsl-isolation.md`](design-wsl-isolation.md) (the jail), `.ai/blockers.md` HUMAN-024.

Labels used below:
- **CONFIRMED**: read in a primary source, or checked here.
- **INFERRED**: reasoned from sources but not run.
- **UNVERIFIED**: not checked yet; marked where it matters.

## 1. Where we are

**What HUMAN-024a (2026-10-22) showed:**
- passt `0.0~git20240220.1e6f92b-1`, Ubuntu 24.04's own package.
- Kernel `6.18.33.2-microsoft-standard-WSL2`, WSL `nat`.
- Jail `JAIL_OK`, no proxy variables.
- Upstream `1e6f92b` is an ancestor of `238c69f` (checked with `git merge-base --is-ancestor` in passt.top's repository).
  So the pasta that carries every jail TCP connection does **not** ACK keep-alive segments (CONFIRMED from source, §2).

**How that produces H1:**
- Codex's reqwest sockets probe after 15 s idle, and they abort at 30 s without an ACK (`TCP_USER_TIMEOUT`).
- An image generation that keeps the connection silent for more than about 30 s is therefore cut.
- Codex retries this five times, which gives about 156 s.
- This is still **INFERRED** until HUMAN-024b measures it. **This plan is only acted on if 24b shows "A cut in the jail,
  OPEN on the host"** (the decision table in `design-image-poc.md`).

Ubuntu 24.04 has **no** newer passt: there is no `noble-updates`, `noble-security` or `noble-backports` build. The
Launchpad publishing history for noble ends with the release pocket's `1e6f92b-1` (published 2024-02-24, still
Published). The earlier release-pocket uploads (`08344da`, `f091893`, …) are Superseded by it, and the `-proposed`
uploads were Deleted. Nothing was published to noble after it. So "update passt" always means a package from outside
noble.

## 2. (a) Which upstream version fixes it

Upstream git, `https://passt.top/passt`. Commit dates are from `git log`; "first tag" is the oldest tag that contains the
commit (`git tag --contains`):

| commit | what | first tag | needed for H1? |
|---|---|---|---|
| `238c69f` "tcp: Acknowledge keep-alive segments, ignore them for the rest" (2024-11-21) | `tcp_data_from_tap()` sees `seq < seq_from_tap && len <= 1`, **sends an ACK**, resets the activity timer and ignores the segment. Before it, the probe was treated as a duplicate ACK, the second one triggered a fast retransmit, and **no ACK was sent** | `2024_11_21.238c69f` | **yes**: this is the fix |
| `472e2e9` "tcp: Don't discard window information on keep-alive segments" (2025-02-12) | keeps the window update carried by a keep-alive (`Fixes: 238c69f`). The commit message's motivation is TCP_REPAIR migration | `2025_02_17.a1e48a0` | no for H1, but it fixes the fix |
| `90f91fe` zero-window probe on ACK timeout (2025-02-12) | related robustness | `2025_02_17.a1e48a0` | no |
| `aa809d3` "tcp: Enable SO_KEEPALIVE if we see keep-alive segments from container / guest" (committed 2025-12-07, authored 2025-07-17) | pasta also turns on keepalive on its **host-side** socket, so WSL's NAT and middleboxes see traffic on a long idle connection | `2025_12_09.c3f1ba7` | not for the jail-side cut; helps the host-side leg of long idles (INFERRED) |
| `28f413d` don't clear ACK_TO_TAP_DUE with a zero window (2025-12-08) | related ACK fix | `2025_12_09.c3f1ba7` | no |
| `a681e44` / `d2f7c21` pasta sends its own keepalives to the guest after 5–10 min of tap-side inactivity (2026-02-25) | new behaviour, unrelated to H1 | `2026_05_07.1afd4ed` | no |

- **Minimum:** `2024_11_21.238c69f`.
- **Recommended:** at least `2025_12_09.c3f1ba7`, so that all three keep-alive commits are in. In practice that means
  Ubuntu 26.04's **`0.0~git20260120.386b5f5-1`** (§3). It contains `238c69f`, `472e2e9`, `90f91fe`, `aa809d3` and
  `28f413d`, and not `a681e44` / `d2f7c21`.

Upstream tags are **lightweight tags on unsigned commits** (`git cat-file -t` gives `commit`; no PGP signature on the
tag or the commits checked). Provenance therefore comes from the distribution archives' signatures, not from upstream git.

## 3. (b) Candidate sources

| source | version | contains the fix? | provenance / signing | how it would be installed | maintenance |
|---|---|---|---|---|---|
| Ubuntu noble (`-updates`, `-security`, `-backports`) | none: only `1e6f92b-1` | – | – | – | – |
| **Ubuntu 26.04 LTS `resolute`** (release pocket) | **`0.0~git20260120.386b5f5-1`**, published 2026-01-22 | **yes, all three** | `InRelease` signed by "Ubuntu Archive Automatic Signing Key (2018)" (key `F6ECB376…991BC93C`, already in noble's `/usr/share/keyrings/ubuntu-archive-keyring.gpg`) → `universe/binary-amd64/Packages.xz` SHA256 → deb SHA256 `49eaf773c120432bdf439d26d3de4d9867116580a819e6eba815b600c45b9840`. **Checked here** (gpgv "Good signature"; Packages hash matched Release; the deb matched Packages) | download that one `.deb`, verify the chain, `dpkg -i`. **Do not** add resolute to `sources.list` | universe. resolute is supported until 2031, but universe gets no guaranteed security updates. Security or bug fixes would appear as a resolute SRU, which a person would have to fetch again by hand |
| Ubuntu 26.10 `stonking` / 27.04 `tenacious` | `0.0~git20260728.f8df3f1-1` | yes | same archive key | same | interim releases (9 months). Newer isolation churn (§4.3) |
| Ubuntu 25.04 `plucky` / 25.10 `questing` | `2025_02_17.a1e48a0` / `2025_05_03.587980c-2` | `238c69f` and `472e2e9` only | same archive key | same | **both end of life**. Not recommended |
| Debian 13 `trixie` (stable) | `0.0~git20250503.587980c-2+deb13u1` | `238c69f` and `472e2e9`, not `aa809d3` | Debian archive key (not on Ubuntu by default) | would need the Debian keyring | stable updates. The only trixie update so far raised the AppArmor ABI to 4.0 |
| Debian `trixie-backports` / testing / unstable | `f8df3f1-1~bpo13+1` / `cba3570-1` | yes | Debian archive key | same | the newest (2026-10-02) includes isolation and AppArmor changes made that same week (§4.3) |
| upstream git tag, built from source | any tag | yes | **unsigned** lightweight tags over HTTPS only. A build depends on the local toolchain (`make`; `seccomp.sh` generates the filter at build time), and its reproducibility was not checked | `make` + manual install | a person owns every rebuild. **Conflicts with the standing rule** (below) |
| passt.top `/builds/latest/x86_64/` | builds of the current untagged HEAD (`8ba4132`, 2026-10-14), plus "unofficial" rpm/deb | yes | **no signature or checksum file** next to them; the project calls them unofficial | copy the binary | none. Not recommended |

The packages are maintained by upstream's own maintainer (Stefano Brivio signs the Debian changelog entries). Ubuntu
syncs them from Debian, so resolute's package is upstream's own Debian packaging.

**The standing rule.** `design-wsl-isolation.md` §6 says: "他の release の deb や自前の build は入れない" (do not install
another release's deb or a self-built binary). **Every candidate that fixes H1 breaks this rule**, because noble has no
newer passt. So the update needs an explicit, written exception from the human (A-2 in §8). That PR would also update §6.

**Recommendation: Ubuntu 26.04 `resolute`'s `passt_0.0~git20260120.386b5f5-1_amd64.deb`, installed alone with
`dpkg -i`, then `apt-mark hold passt`.** Reasons:

- **The fix and its follow-ups.** It has `238c69f`, `472e2e9` and `aa809d3`, and not the 2026-02 keepalive-to-guest
  change.
- **Provenance.** It is verifiable with the archive key the machine already trusts, through the signed `InRelease`. No
  new key, no new apt source and no pinning to another release are needed.
- **Dependencies.** The only dependency is `libc6 (>= 2.38)`. The binary needs no glibc symbol newer than `GLIBC_2.38`
  (checked with `objdump -T`), and noble has 2.39. Nothing else on the system is pulled forward.
- **Same paths.** `/usr/bin/pasta` is still a hard link to `/usr/bin/passt`, so the unit's `ExecStart` does not change.
- **Support.** It comes from an LTS series with the same maintainer chain. Its supported life is longer than the
  interim releases'.
- **Stability.** It predates the 2026-05 to 2026-10 isolation and AppArmor rework (§4.3).

**What gets worse.** Updates become manual (§6.3). Today's state is the same, though: noble's passt has not changed
since 2024-02, and it sits in universe too. There are no CVEs for passt in the Ubuntu CVE tracker or the Debian security
tracker (checked 2026-10-22).

## 4. (c) Keeping the jail exactly as strong

### 4.1 How the jail runs pasta (`scripts/sales-design-capture/admin.sh`)

- **The binary.** `pasta_bin="$(command -v pasta)"` must be root-owned all the way up (:149). The path is resolved
  **when `jail-install` runs** and written into the unit.
- **The unit.** `sr-jail-net.service` (:163-190):
  - `ExecStartPre`: `ip netns add srjail`; an ip rule `to 198.51.100.53/32 ipproto tcp prohibit` inside the namespace;
    the jail's `resolv.conf` and the netns id.
  - `ExecStart=/usr/bin/pasta -f -q --runas 0 --config-net --no-map-gw -t none -u none -T none -U none --dns-forward
    198.51.100.53 --netns /run/netns/srjail`.
  - pasta's own sockets: `IPAddressAllow=10.255.255.254/32` (the WSL DNS tunnel) and
    `IPAddressDeny=10/8 172.16/12 192.168/16 169.254/16 100.64/10 127/8 ::1 fc00::/7 fe80::/10`.
  - `Restart=always`.
  - `tests/unit/design-agent/jail.test.ts` pins the ExecStart flag string and the order of the ip rule.
- **The jail side** (`jail.properties`):
  - `NetworkNamespacePath=/run/netns/srjail`.
  - `IPAddressAllow=127/8 ::1 198.51.100.53/32`.
  - `IPAddressDeny` with the private ranges, plus the default gateway (added by `jail_props`).
  - The seccomp filter and the rest of the list.
  - `probe.py` checks it before every start: `JAIL_OK`, or one of the `JAIL_UNSAFE` codes such as
    `NETWORK_NOT_PRIVATE`, `PRIVATE_NETWORK_REACHABLE`, `DNS_TUNNEL_REACHABLE`, `DNS_TCP_NOT_REFUSED`.
- **No port forwarding.** There is none in either direction. Outbound jail connections are terminated by pasta, which
  opens its own host socket.

### 4.2 Did any flag change meaning between `1e6f92b` and `386b5f5`?

Compared from `passt.1` and `conf.c` at both commits:

| flag | 1e6f92b | 386b5f5 | effect on the jail |
|---|---|---|---|
| `-f`, `-q`, `--netns <path>` (implies `--netns-only`) | as now | same text | none |
| `--runas 0` | `conf_ugid()`: an explicit `--runas` wins; without it, root becomes `nobody` | same code | none (pasta stays uid 0, as today) |
| `--config-net` | configures the namespace's address and routes like the host's | same | none |
| `-t none -u none -T none -U none` | no port forwarding | `none` still parsed (`conf.c:218`); the port-spec parser was rewritten in 2026-04, **after** 386b5f5 | none |
| `--no-map-gw` | do not map the gateway to the host | same. New in 2024-08: `--map-host-loopback` defaults to the gateway **unless `--no-map-gw`**, and `--map-guest-addr` defaults to unset (`conf.c:2061-2067`, `fwd.c`). So nothing on the host is mapped | none |
| `--dns-forward 198.51.100.53` | maps **UDP/53 only** to the first host resolver | maps **UDP and TCP, ports 53 and 853** (`becf81a`, 2024-07, `fwd.c` `is_dns_flow`). New `--dns-host` (default: the first resolver in the host's `resolv.conf`, as before) | **changed**, see below |

**DNS after the update.** On the TCP side nothing changes for the jail. The ip rule refuses **all** TCP to
198.51.100.53 inside the namespace, so TCP/53 and TCP/853 are still refused with `EACCES`, and `probe.py`'s
`DNS_TCP_NOT_REFUSED` check still applies. **UDP to 198.51.100.53:853 is new.** Today it goes nowhere; after the update
pasta would forward it to the host resolver, `10.255.255.254:853`. The WSL DNS tunnel address sits on the VM's loopback,
where every `0.0.0.0` UDP service answers (`design-wsl-isolation.md` §2). That is a small widening.

- **Proposal (A-3, its own PR before the update):** change the namespace rules to "UDP/53 to 198.51.100.53 allowed,
  everything else to it prohibited". For example:
  - `ip -n srjail rule add to 198.51.100.53/32 ipproto udp dport 53 lookup main priority 99`
  - `ip -n srjail rule add to 198.51.100.53/32 prohibit priority 100`
- Add a `probe.py` check that UDP to `198.51.100.53:853` fails at once (`EACCES`), and update `jail.test.ts`.
- The alternative is to accept the residual in writing. Either way, A-3 is decided before A-5.
- iproute2 6.1 (noble) supports `ipproto`/`dport` in rules. Whether `prohibit` returns `EACCES` for UDP `sendto` as
  it does for TCP connect is **UNVERIFIED**: the PR's test must show it.
- The newer pasta also *could* carry DNS over TCP. Using that would loosen the UDP-only design and is **not** proposed.

### 4.3 AppArmor

**CONFIRMED from the two `.deb` files (`dpkg-deb -c`):**
- **noble `1e6f92b-1`** ships `/etc/apparmor.d/usr.bin.passt` (`profile passt /usr/bin/passt{,.avx2}`) and the
  abstractions. It ships **no `usr.bin.pasta`** (Launchpad bug 2077158, fixed only in later packages). `pasta` is a hard
  link, and AppArmor attaches by the exec path. So **`/usr/bin/pasta` runs unconfined by AppArmor today**, whatever the
  LSM state.
- **resolute `386b5f5-1`** adds `/etc/apparmor.d/usr.bin.pasta`: `profile pasta /usr/bin/pasta{,.avx2}
  flags=(attach_disconnected)`, ABI 4.0, `include <abstractions/pasta>`.
  - Its file rules allow `@{run}/user/@{uid}/**`, `/tmp/**`, `@{PROC}/[0-9]*/ns/net` and the `/proc/net/*` tables.
  - They **do not allow `/run/netns/srjail`**, which `--netns` opens (INFERRED from the profile text, not run).
  - The profile has **no `include if exists <local/usr.bin.pasta>`** (Launchpad bug 2165739, open), so a local
    override file would not be read.
  - The postinst loads the profile only when `aa-enabled` succeeds.

**Is AppArmor active on this WSL kernel? INFERRED no.** Microsoft's `config-wsl` for the 6.18 branch has:
- `CONFIG_SECURITY_APPARMOR=y`, but `CONFIG_DEFAULT_SECURITY_SELINUX=y`.
- `CONFIG_LSM="landlock,lockdown,yama,loadpin,safesetid,integrity,selinux,apparmor,tomoyo,bpf"`.

SELinux comes first among the exclusive LSMs, so AppArmor is not the active major LSM unless the kernel command line
changes it. The snapshot (§5, V-0) checks `/sys/kernel/security/lsm` and `aa-enabled`.

**Consequences:**
- **AppArmor inactive** (expected): the new profile file is installed but never loaded. pasta stays exactly as confined
  as today (not by AppArmor). Nothing is weakened.
- **AppArmor active:** the update **adds** confinement, so it cannot weaken anything. But pasta would most likely fail
  to open `/run/netns/srjail`. Then `sr-jail-net` fails, and with it every jail unit (`BindsTo`): the jail **fails
  closed** and Claude does not start. The fix is contingency A-9: put the profile in complain mode, read the denials,
  then either add `/run/netns/srjail r,` (and whatever else the denials show) to the conffile, or disable the profile,
  which returns to today's unconfined state. Do not remove the jail's own limits to make pasta start.

**A source-built binary at another path loses the profile.** `make install` defaults to `/usr/local/bin`, and root's
`secure_path` puts `/usr/local/bin` **before** `/usr/bin`. The next `jail-install` would then silently put
`/usr/local/bin/pasta` into the unit: no profile attaches to it, and it is outside dpkg's verification. Another reason
not to build from source. If a source build is ever approved, it must replace `/usr/bin/{passt,pasta}` (same paths)
under a dpkg divert, never `/usr/local`.

### 4.4 seccomp, capabilities, privileges

passt confines itself (`isolation.c`):
- It drops capabilities it does not need.
- It detaches into new namespaces and `pivot_root`s into an empty tmpfs.
- It installs a seccomp filter generated at build time from the source's `#syscalls` annotations.

Between the two versions, `isolation.c` changed (+48/−38). The commit relevant to root use is `5da0316` "keep
CAP_DAC_OVERRIDE initially", which keeps it during start-up. Larger isolation changes happened **after** `386b5f5`:
2026-07 `--chroot-fallback`, 2026-09 "Don't create our userns as nobody", and 2026-10 AppArmor fixes for the new
user-namespace procedure. This is one more reason to prefer `386b5f5` over Debian testing's `cba3570`.

The new package adds **one binary, `/usr/bin/passt-repair`** (a TCP_REPAIR helper for VM migration). Its mode is
`0755`: no setuid, and the postinst runs no `setcap` (it only reloads AppArmor profiles). Nothing runs it in the jail
or in our units. So no new privileged entry point appears (CONFIRMED from `dpkg-deb -c` and the postinst).

The system-side limits come from systemd and the kernel, not from pasta, and the update does not touch them:
- the unit's `IPAddressAllow/Deny` (cgroup BPF);
- the jail's seccomp list and `IPAddressDeny`;
- the namespace's ip rule.

**V-0 and V-3 compare the running pasta's `/proc/<pid>/status`** (`Uid`, `CapEff`, `CapPrm`, `CapBnd`, `NoNewPrivs`,
`Seccomp`). Any capability present after the update that was not present before stops the rollout (§6).

### 4.5 What stays the same

These are the same before and after:
- the unit file;
- `jail.properties`;
- the netns path and the netns-id check;
- `IPAddressAllow/Deny`, both pasta's and the jail's;
- the jail's `resolv.conf`;
- the namespace's ip rule (unless A-3 tightens it).

dpkg does not touch `/etc/systemd/system/sr-jail-*.service`. The only behaviour changes are inside pasta:
- keep-alive ACKs;
- `SO_KEEPALIVE` on its host-side sockets when the jail sends keepalives;
- the DNS mapping in §4.2.

## 5. (d) Verification plan (each step needs approval first; nothing here has been run)

Before any heavy step on the WSL machine, run the resource preflight (`docs/operations/wsl-resource-preflight.md`).

**V-0 — snapshot before the update (A-4).** Run in the human's WSL shell, outside the jail. Keep the output. Everything
is read only except one root-only state file, `/root/sr-passt-update/v0-state`. It records what V-2 and the rollback
must put back: whether Claude is enabled and active, whether passt is held, and whether the AppArmor `local/` file and
cache for pasta exist.

```bash
dpkg-query -W -f='${Package} ${Version} ${db:Status-Abbrev}\n' passt
apt-cache policy passt | head -n 6
apt-mark showhold | grep -x passt || echo "passt: not held"
stat -c '%i %h %U:%G %a %n' /usr/bin/passt /usr/bin/passt.avx2 /usr/bin/pasta /usr/bin/pasta.avx2
sha256sum /usr/bin/passt /usr/bin/passt.avx2
out="$(dpkg --verify passt)"; if [ -z "$out" ]; then echo "dpkg-verify: clean"; else printf '%s\n' "$out"; fi
apt-cache rdepends --installed --no-recommends --no-suggests passt | tail -n +3 | grep . || echo "no installed package depends on passt"
ls -l /etc/apparmor.d/local/ 2>&1 | grep -E 'usr\.bin\.pas' || echo "apparmor local/: no passt or pasta file"
sudo find /var/cache/apparmor -name 'usr.bin.pas*' 2>/dev/null | grep . || echo "apparmor cache: no passt or pasta entry"
systemctl is-enabled sr-jail-claude.service; systemctl is-active sr-jail-claude.service
sudo install -d -m 0700 /root/sr-passt-update
{
  echo "claude_enabled=$(systemctl is-enabled sr-jail-claude.service 2>/dev/null || true)"
  echo "claude_active=$(systemctl is-active sr-jail-claude.service 2>/dev/null || true)"
  echo "passt_held=$(apt-mark showhold | grep -qx passt && echo yes || echo no)"
  echo "local_pasta=$([ -e /etc/apparmor.d/local/usr.bin.pasta ] && echo present || echo absent)"
  echo "cache_pasta=$(sudo find /var/cache/apparmor -name usr.bin.pasta 2>/dev/null | grep -q . && echo present || echo absent)"
} | sudo tee /root/sr-passt-update/v0-state
systemctl cat sr-jail-net.service | sha256sum
systemctl show sr-jail-net.service -p ExecStart -p IPAddressAllow -p IPAddressDeny --no-pager
PID="$(systemctl show -p MainPID --value sr-jail-net.service)"; echo "pasta pid: $PID"
sudo readlink "/proc/$PID/exe"
sudo grep -E '^(Uid|Gid|CapEff|CapPrm|CapBnd|NoNewPrivs|Seccomp|Seccomp_filters):' "/proc/$PID/status"
cat /sys/kernel/security/lsm; echo
aa-enabled 2>&1 || true
ls -l /etc/apparmor.d/usr.bin.passt /etc/apparmor.d/usr.bin.pasta 2>&1
sudo ip -n srjail rule show
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh jail-check
```

Also keep the HUMAN-024b outputs, jail and host, as the baseline.

Expected for today's package:
- `/usr/bin/passt` sha256 `2edcf1d787b21564045045f27def85e6397b930557ce5884ed8bfa8d0c77e048`;
- `passt.avx2` `da1809a041fd9075e638aaffc2b40b7be1723824fb8d0b6697c074c0cb4baec8`;
- `pasta` and `pasta.avx2` are hard links to them (same inode, link count 2);
- `dpkg-verify: clean`. On dpkg 1.22 `dpkg --verify` exits 0 even when it finds problems, which is why the snippet
  tests its output. Exception: `missing` lines only under `/usr/share/doc` or `/usr/share/man` come from dpkg
  path-excludes on a minimized image (`/etc/dpkg/dpkg.cfg.d/`) and are expected. Any line on `/usr/bin` or an `/etc`
  conffile means a passt file was changed locally: stop and report. "Clean" in V-3 and R-3 means the same as here;
  those doc and man lines may appear there too;
- most likely `passt_held=no` and no pasta file in `local/` or in the cache. Whatever V-0 shows is the state the
  rollback restores.

**V-1 — fetch and verify the package (part of A-5, no install).** Run as root in a fresh root-only directory:

```bash
sudo install -d -m 0700 /root/sr-passt-update
sudo bash -euo pipefail -c '
cd /root/sr-passt-update
apt-get download passt=0.0~git20240220.1e6f92b-1
echo "de07c44dcae84b58107cdf47e58f7d6ca2fdd466b193a10aea8a7115cf97bead  passt_0.0~git20240220.1e6f92b-1_amd64.deb" | sha256sum -c
curl -fsSLo InRelease https://archive.ubuntu.com/ubuntu/dists/resolute/InRelease
gpgv --keyring /usr/share/keyrings/ubuntu-archive-keyring.gpg --output Release InRelease
H="$(awk '"'"'/^SHA256:/{x=1;next} /^[A-Z]/{x=0} x && $3=="universe/binary-amd64/Packages.xz"{print $1}'"'"' Release)"
curl -fsSLo Packages.xz https://archive.ubuntu.com/ubuntu/dists/resolute/universe/binary-amd64/Packages.xz
echo "$H  Packages.xz" | sha256sum -c
xz -dc Packages.xz | awk '"'"'/^Package: passt$/{p=1} p&&/^(Version|Filename|SHA256):/{print} p&&/^$/{p=0}'"'"'
curl -fsSLo passt_0.0~git20260120.386b5f5-1_amd64.deb https://archive.ubuntu.com/ubuntu/pool/universe/p/passt/passt_0.0~git20260120.386b5f5-1_amd64.deb
echo "49eaf773c120432bdf439d26d3de4d9867116580a819e6eba815b600c45b9840  passt_0.0~git20260120.386b5f5-1_amd64.deb" | sha256sum -c
dpkg-deb -f passt_0.0~git20260120.386b5f5-1_amd64.deb Package Version Depends
dpkg-deb -c passt_0.0~git20260120.386b5f5-1_amd64.deb | awk "{print \$6}"
'
```

**Stop if:**
- `gpgv` does not say "Good signature";
- any `sha256sum -c` fails;
- the `Packages` stanza shows a different `Version` or `SHA256` (resolute may have published an update since this plan
  was written; re-review it then).

The old deb kept here is the rollback copy (§6). `apt-get download` into a root-only directory prints a harmless
`W: Download is performed unsandboxed as root` warning. The script was run end to end in a scratch directory
on 2026-10-22: every check passed and the stanza matched.

**V-2 — the update (A-5).** Run it as a person, at the console:

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop
echo "49eaf773c120432bdf439d26d3de4d9867116580a819e6eba815b600c45b9840  /root/sr-passt-update/passt_0.0~git20260120.386b5f5-1_amd64.deb" | sudo sha256sum -c
sudo dpkg -i /root/sr-passt-update/passt_0.0~git20260120.386b5f5-1_amd64.deb
sudo apt-mark hold passt
sudo systemctl restart sr-jail-net.service
systemctl is-active sr-jail-net.service
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh jail-check
```

- The hash is checked again right before `dpkg -i`, so the file installed is the file V-1 verified. If
  `sha256sum -c` fails, do not run `dpkg -i`.
- `dpkg -i` must not ask about a modified conffile. V-0's `dpkg --verify` output shows whether any was modified; if a
  prompt appears, answer **N** (keep the current one) and stop.
- If `sr-jail-net` is not `active` or `jail-check` is not `JAIL_OK`, roll back (§6). Do not change the jail to make it
  start.
- `claude-stop` **disables** `sr-jail-claude`. Restoring Claude is a separate step (V-2b), run only after the V-3 checks
  below pass.

**V-2b — restore Claude to its V-0 state (success path).** Run after V-3's immediate checks pass. The hold set in V-2 is
the one intended change (§6.2), so it stays.

```bash
CLAUDE_ENABLED="$(sudo sed -n 's/^claude_enabled=//p' /root/sr-passt-update/v0-state)"
if [ "$CLAUDE_ENABLED" = enabled ]; then sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start; else echo "sr-jail-claude stays stopped (V-0: ${CLAUDE_ENABLED:-unknown})"; fi
systemctl is-enabled sr-jail-claude.service; systemctl is-active sr-jail-claude.service
```

The last line must show the V-0 values (`claude_enabled` / `claude_active` in `v0-state`). If V-0 had Claude enabled but
not active, `claude-start` leaves it active: note that difference and do not stop it again on your own.

**V-3 — checks after the update (same approval as A-5):**
- **The 24a host commands.**
  - `dpkg-query` shows `0.0~git20260120.386b5f5-1`.
  - The first line of `pasta --version` is now `pasta 0.0~git20260120.386b5f5-1` (pasta prints its mode name, then the
    version). This build embeds its version; noble's printed `pasta unknown version`.
  - `/usr/bin/passt` sha256 is `a10789852407f65160c4abfac002efe511b254e6ab2cbfc658e807575db44832`, and `passt.avx2` is
    `e02708849808156f0c7f92f39b7d970b01f2d5c392fc559eeb294dbda72abed7`.
  - `apt-mark showhold` lists `passt`.
  - `dpkg --verify` (the V-0 form) prints `dpkg-verify: clean`.
- **The rest of V-0, compared line by line.**
  - The unit hash, `ExecStart`, `IPAddressAllow/Deny` and `ip -n srjail rule show` are **identical**.
  - In `/proc/<pid>/status`: `Uid` is the same; `CapEff/CapPrm/CapBnd` are not larger; `NoNewPrivs` is the same;
    `Seccomp` is `2` (filter) as before.
  - `/sys/kernel/security/lsm` and `aa-enabled` are unchanged. If AppArmor is active, see A-9.
- **The jail and DNS.**
  - `admin.sh jail-check` → `JAIL_OK`.
  - `sudo bash …/admin.sh run sr-designgen -- getent hosts github.com` resolves.
  - If A-3 was applied, its new check passes.
- **24b in the jail and 24b-host again** (A-6). Expected in the jail: **A no longer cut at about 27 s, all three
  `OPEN`**, and the host unchanged. If A is still cut in the jail, the keep-alive fix did not take effect, or something
  else drops the ACKs. Stop and report; do not go on to Codex.
- **The in-jail tests, optional** (A-7, after the resource preflight). `design-wsl-isolation.md` §5 ran
  `tests/unit/design-agent/sandbox.test.ts` (real bubblewrap attacks) and `worker.test.ts` (Chromium) in the jail
  (73 pass). Run the same two through `admin.sh run sr-designgen -- …` from the requester's checkout.

**V-4 — one Codex run (A-8, separately approved).** Only after V-3 passes: HUMAN-021b's v1 command once, as 24c.
Expected:
- `img_call_ms` for the first call well under the 156 s pattern;
- no `140-170s` in `img_fail_timing`;
- ideally an image.

A failure with a different timing is new evidence for H2/H3, not a reason to roll back passt.

**Optional, container-side (not the WSL machine).** An A/B of the two pasta binaries in a scratch network namespace:
- the jail's exact flags;
- a local TLS server;
- the 24b probe with `CA` pointed at the test certificate.

Expected: `1e6f92b` cuts A at about 27 s, and `386b5f5` keeps it open. It was set up in this session but **not run**:
the session's permission check stopped running the probe inside the scratch namespace. It needs the session owner's
permission, and its result would add evidence but replace none of V-3.

## 6. (e) Rollback and the hold policy

### 6.1 Rollback (approved together with A-5 as its abort path; run by a person)

The rollback **purges** the hand-installed package, then installs the verified noble deb. A plain downgrade with
`dpkg -i` is not used, for two reasons:
- **It leaves `/etc/apparmor.d/usr.bin.pasta` behind.** The noble package does not ship that conffile, so dpkg keeps
  it as an obsolete conffile of `passt`. If it stays on disk, noble's postinst still acts on it: it creates
  `local/usr.bin.pasta` and, when AppArmor is enabled, runs `apparmor_parser -r -T -W`, which writes a cache entry.
- **Moving the file aside does not help.** If it is moved aside first, `dpkg --verify` then reports `missing c` for it
  indefinitely.

`dpkg --purge passt` removes every passt conffile, and the 386b5f5 postrm (dh_apparmor) removes `local/` and
`/var/cache/apparmor/*/` for `usr.bin.pasta`, `usr.bin.passt` and `usr.bin.passt-repair`. After `dpkg -i` of the old
deb, the dpkg database and `/etc/apparmor.d` are as noble's package leaves them, which is the V-0 state, and
`dpkg --verify` is clean.

Purging is only safe when:
- no passt conffile was changed locally (a purge would discard the change);
- no installed package depends on passt (`dpkg --purge` would refuse).

R-1 checks both. The jail is stopped during the purge, so a missing `/usr/bin/pasta` affects nothing.

**R-1 — checks (read only).** Stop if:
- `sha256sum -c` fails;
- the verify output is not `dpkg-verify: clean` (apart from the doc and man lines V-0 allows);
- a package depends on passt.

If either of the last two is true, use the fallback below.

```bash
echo "de07c44dcae84b58107cdf47e58f7d6ca2fdd466b193a10aea8a7115cf97bead  /root/sr-passt-update/passt_0.0~git20240220.1e6f92b-1_amd64.deb" | sudo sha256sum -c
out="$(dpkg --verify passt)"; if [ -z "$out" ]; then echo "dpkg-verify: clean"; else printf '%s\n' "$out"; fi
apt-cache rdepends --installed --no-recommends --no-suggests passt | tail -n +3 | grep . || echo "no installed package depends on passt"
sudo cat /root/sr-passt-update/v0-state
```

**R-2 — roll back.**

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop
sudo systemctl stop sr-jail-net.service
if [ -e /etc/apparmor.d/usr.bin.pasta ]; then
  sudo cp -p /etc/apparmor.d/usr.bin.pasta /root/sr-passt-update/usr.bin.pasta.from-386b5f5
  if aa-enabled --quiet 2>/dev/null; then sudo apparmor_parser -R /etc/apparmor.d/usr.bin.pasta || true; fi
fi
sudo apt-mark unhold passt
sudo dpkg --purge passt
sudo dpkg -i /root/sr-passt-update/passt_0.0~git20240220.1e6f92b-1_amd64.deb
if [ "$(sudo sed -n 's/^local_pasta=//p' /root/sr-passt-update/v0-state)" = absent ]; then sudo rm -f /etc/apparmor.d/local/usr.bin.pasta; fi
if [ "$(sudo sed -n 's/^cache_pasta=//p' /root/sr-passt-update/v0-state)" = absent ]; then sudo find /var/cache/apparmor -name usr.bin.pasta -delete 2>/dev/null || true; fi
if [ "$(sudo sed -n 's/^passt_held=//p' /root/sr-passt-update/v0-state)" = yes ]; then sudo apt-mark hold passt; fi
sudo systemctl start sr-jail-net.service
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh jail-check
```

- **The profile.** The loaded `pasta` profile (if AppArmor is active) is unloaded before the purge, because the purge
  removes the file but not the policy in the kernel. A copy is kept for reference. noble's postinst reloads its own
  `usr.bin.passt`.
- **The `local/` and cache cleanup.** It only removes what V-0 showed absent. The purge's postrm normally removes them
  already, so these lines are a no-op then.
- **The hold.** It ends as V-0 had it: unheld, unless V-0 showed `passt_held=yes`. It is lifted before the purge
  because dpkg may refuse to remove a held package.
- **Fallback, only if R-1 rules out the purge.**
  - Unload and move `/etc/apparmor.d/usr.bin.pasta` aside **before** the downgrade (same `if` block, `mv` instead of
    `cp`), then `sudo dpkg -i` the old deb.
  - Clean `local/` and the cache as above.
  - Afterwards `dpkg --verify passt` prints exactly one expected line, `missing   c /etc/apparmor.d/usr.bin.pasta` (an
    obsolete conffile); any other line is a problem.
  - Record that line, and keep any locally changed conffile as it was.
- **Why not `apt-get install passt=0.0~git20240220.1e6f92b-1`.** The apt form also works (noble's release pocket still
  has that version), but the verified local copy works offline and pins the exact bytes.

**R-3 — verify, then restore Claude to its V-0 state:**
- `dpkg-query -W passt` → `0.0~git20240220.1e6f92b-1`;
- the first line of `pasta --version` → `pasta unknown version`;
- `/usr/bin/passt` sha256 `2edcf1d7…c77e048`;
- the V-0 `dpkg --verify` form prints `dpkg-verify: clean`, or with the fallback only the one `missing c` line;
- `ls -l /etc/apparmor.d/local/` and the cache `find` print the same as in V-0;
- `apt-mark showhold` matches `passt_held` in `v0-state`;
- `jail-check` → `JAIL_OK`;
- the V-0 `/proc/<pid>/status` lines match the snapshot.

Then run V-2b's block, which starts Claude only if V-0 had it enabled.

- **On a WSL backup:** `wsl --export` before A-5 is possible, but it is a Windows-side action with its own disk cost.
  It is not proposed; the deb copy is enough for one package.

### 6.2 Hold policy

- While `386b5f5-1` is installed by hand: **`apt-mark hold passt`**.
  - Today apt would not change it anyway: resolute is not an apt source, and noble's version is lower, so apt never
    downgrades on its own.
  - The hold makes that explicit, covers a future noble upload with a higher version string, and shows up in
    `apt-mark showhold`.
  - unattended-upgrades respects holds.
- After a rollback to noble's version: the hold state is whatever V-0 recorded (normally unheld). The machine is then
  back on the normal noble package, which gets whatever noble publishes.
- Any later change of the hand-installed version (a resolute SRU, a security fix) is a new approval. Follow V-1 → V-3
  with the new version and hash, and keep the previous deb as the rollback copy.

### 6.3 Who keeps it current

A hand-installed package gets no automatic updates. Proposal (A-10):
- A person, or Claude in a docs session, checks resolute's passt publishing history and the Ubuntu and Debian security
  trackers monthly, and before any jail change.
- Return to the distro package when noble gets a fixed passt (unlikely) or when the machine moves to 26.04.

## 7. (f) If updating is undesirable

- **pasta options in `1e6f92b`: none apply.**
  - The man page and `conf.c` at `1e6f92b` have no TCP keep-alive option.
  - The TCP-related options are `-t/-T` (port forwarding), `--no-tcp`, `--no-splice` and the address mappings.
  - The keep-alive handling is fixed code in `tcp_data_from_tap()`.
  - Nothing in pasta can be configured to ACK keep-alives.
- **Make the client not need ACKs.**
  - Codex has no key for `TCP_USER_TIMEOUT` or keepalive (investigation §6).
  - A provider override with `request_max_retries = 0` only shortens the failure to about 31 s.
  - The jail-wide sysctls (`net.ipv4.tcp_keepalive_*`) do not apply, because reqwest sets per-socket values.
  - Not a fix.
- **slirp4netns instead of pasta.**
  - A different user-space stack with its own TCP handling. Whether it ACKs keep-alives was not researched.
  - It changes the jail's network design: no `--dns-forward` equivalent with the same semantics, a different gateway
    model, a new root-run component, re-validating every probe check.
  - A large isolation change. Not recommended.
- **A loopback proxy inside the jail.**
  - It does not help: its upstream socket also goes through pasta (investigation §6).
  - It would only help if it never sent keepalives, and then it would need its own idle handling.
  - Not recommended.
- **The WSL networking mode** (`.wslconfig`). This only matters if 24b-host is cut too. It changes nothing about pasta.
- **Move the machine to Ubuntu 26.04** (`do-release-upgrade`). That gives the same passt from a supported apt source,
  but it is a whole-distro change: systemd, apparmor, kernel userspace. The jail would need re-validation from scratch.
  Possibly the right long-term answer, but not as a fix for this.
- **An upstream report.** passt already fixed this in 2024-11, so there is nothing to report there. A request to Ubuntu
  for a noble SRU of `238c69f` is possible:
  - passt is in universe, so an SRU needs a sponsor;
  - it is an external post, so it is the human's decision (A-11);
  - it is slow.

  The Codex side (reqwest's 30 s `TCP_USER_TIMEOUT` default) is already discussed upstream (openai/codex#24323, #45381).

## 8. (g) Approvals, in order

Nothing advances without the one before it. Each is a separate human decision.

| # | approval | runs on | depends on |
|---|---|---|---|
| A-1 | **HUMAN-024b** (jail) and **24b-host**: the Codex-free probe | WSL, read-only network | – (pending) |
| A-2 | Proceed with a passt update **and** grant a written exception to `design-wsl-isolation.md` §6 for exactly `passt 0.0~git20260120.386b5f5-1` from Ubuntu resolute, verified as in V-1 (the docs change goes in the A-3 PR or its own) | decision | A-1 shows "cut in the jail, OPEN on the host" |
| A-3 | The jail's DNS rule: only UDP/53 to 198.51.100.53, plus a probe check and tests (§4.2), as a code PR. **Or** accept the UDP/853 residual in writing | repo PR, then `admin.sh approve <sha>` on WSL (the usual approval) | A-2 |
| A-4 | V-0 snapshot (read only) | WSL | A-2 (and A-3 deployed, if chosen) |
| A-5 | V-1 fetch and verify, V-2 update and hold, the immediate V-3 checks; **rollback (§6.1) approved together with A-5 as its abort path** | WSL, root | A-4 |
| A-6 | 24b in the jail and 24b-host after the update | WSL | A-5 passes V-3 |
| A-7 | In-jail `sandbox.test.ts` / `worker.test.ts` (optional; resource preflight first) | WSL | A-5 |
| A-8 | One Codex image run (24c-style, HUMAN-021b's v1 command) | WSL, plan quota | A-6 shows A `OPEN` |
| A-9 | Contingency, only if AppArmor is active and pasta is denied: complain mode → add `/run/netns/srjail r,` to the profile, or disable the pasta profile (back to today's unconfined state) | WSL | A-5 fails on AppArmor |
| A-10 | Maintenance owner and cadence for the hand-installed package (§6.3) | process | A-5 |
| A-11 | Optional: ask Ubuntu for a noble SRU (external post) | external | any time |

## 9. Confirmed vs inferred

| claim | status | evidence |
|---|---|---|
| installed passt `1e6f92b` lacks the keep-alive ACK | CONFIRMED | 24a; `git merge-base --is-ancestor 1e6f92b 238c69f`; the `238c69f` diff |
| H1 on our path is caused by pasta | INFERRED, pending 24b / 24b-host | investigation §3 |
| noble has no newer passt in any pocket | CONFIRMED (2026-10-22) | Launchpad `getPublishedSources` |
| resolute deb's signature chain and hashes | CONFIRMED | gpgv + Release/Packages/deb SHA256 checked here |
| resolute deb installs on noble (libc6 ≥ 2.38 only, no symbol newer than GLIBC_2.38) | CONFIRMED (static) / install not run | `dpkg-deb -f`, `objdump -T` |
| jail flags keep their meaning, except `--dns-forward` gaining TCP and 853 | CONFIRMED (man page + `conf.c`/`fwd.c` at both commits) | §4.2 |
| `/usr/bin/pasta` is unconfined by AppArmor today | CONFIRMED (package contents) | no `usr.bin.pasta` in noble's deb |
| AppArmor inactive on this WSL kernel | INFERRED | `config-wsl` LSM order; V-0 checks |
| resolute's pasta profile would deny `/run/netns/srjail` | INFERRED (profile text) | §4.3; A-9 |
| `prohibit` gives `EACCES` for UDP `sendto` | UNVERIFIED | A-3's test |
| the update makes 24b's A `OPEN` | INFERRED | the `238c69f` diff; V-3 / A-6 measure it |
| pasta's capability / seccomp state unchanged after the update | UNVERIFIED | V-0 vs V-3 `/proc/<pid>/status` |

## 10. Sources

- passt git: <https://passt.top/passt/> (commits [`238c69f`](https://passt.top/passt/commit/?id=238c69f9af458e41dea5ad8c988dbf65b05b5172),
  [`472e2e9`](https://passt.top/passt/commit/?id=472e2e930f6e17d9d8664d6cf44c47af1db58bb3),
  [`aa809d3`](https://passt.top/passt/commit/?id=aa809d31827638c09a08671800c4053d3d0ab5ed),
  [`becf81a`](https://passt.top/passt/commit/?id=becf81a), [`5da0316`](https://passt.top/passt/commit/?id=5da0316));
  [tags](https://passt.top/passt/refs/tags); [keep-alive log](https://passt.top/passt/log/?qt=grep&q=keep-alive);
  report: [containers/podman discussion 24572](https://github.com/containers/podman/discussions/24572);
  unofficial builds: <https://passt.top/builds/latest/x86_64/>.
- Ubuntu: [Launchpad passt source package](https://launchpad.net/ubuntu/+source/passt) (publishing history via the
  Launchpad API); [bug 2077158](https://bugs.launchpad.net/ubuntu/+source/passt/+bug/2077158) (pasta profile missing);
  [bug 2165739](https://bugs.launchpad.net/ubuntu/+source/passt/+bug/2165739) (no local overrides);
  archive `dists/{noble,resolute}/InRelease` and `universe/binary-amd64/Packages.xz`;
  [Ubuntu CVE tracker](https://ubuntu.com/security/cves?package=passt).
- Debian: [tracker](https://tracker.debian.org/pkg/passt), madison (`api.ftp-master.debian.org`),
  [security tracker](https://security-tracker.debian.org/tracker/source-package/passt),
  [trixie `+deb13u1` changelog](https://metadata.ftp-master.debian.org/changelogs//main/p/passt/passt_0.0~git20250503.587980c-2+deb13u1_changelog).
- WSL kernel config: [microsoft/WSL2-Linux-Kernel `linux-msft-wsl-6.18.y` `arch/x86/configs/config-wsl`](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.y/arch/x86/configs/config-wsl).
- systemd v255: `src/run/run.c` (`--expand-environment` default), `src/basic/env-util.c` (`replace_env_full`, `replace_env_argv`),
  `src/core/dbus-execute.c` (`UNIT_ESCAPE_SPECIFIERS`), `man/systemd-run.xml`.
- This repository: `scripts/sales-design-capture/admin.sh:100-106, :144-228`; `scripts/sales-design-capture/jail/jail.properties:47-67`;
  `tests/unit/design-agent/jail.test.ts`; `docs/operations/design-wsl-isolation.md` §2, §5, §6.
