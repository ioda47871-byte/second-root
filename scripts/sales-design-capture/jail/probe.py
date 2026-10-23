#!/usr/bin/env python3
"""Requester jail probe (DEV-028 Phase 3, WSL isolation redesign).

Runs INSIDE the jail, as the requester (sr-designgen), before anything else
of that user starts (ExecStartPre of every sr-jail-* unit, without '+').
admin.sh installs it root-owned in /usr/local/lib/sr-jail/; the requester
cannot change it.

It proves, on this very machine, that the jail removed every way from the
requester's processes to Windows (and so to root and the Instagram profile):

- the WSL interop sockets (/run/WSL/*_interop) and the WSLg / X display are
  not there; no Windows drive, no /usr/lib/wsl, no /dev/vsock or /dev/dxg;
- socket(AF_VSOCK) is refused (seccomp: RestrictAddressFamilies), and so is
  io_uring (which could open sockets without the socket() system call);
- the Windows host and every private / link-local address are refused at
  once (cgroup BPF: IPAddressDeny), the WSL DNS tunnel address
  (10.255.255.254) included: the jail's DNS goes only through pasta;
- the jail's DNS address takes UDP/53 and nothing else, whatever pasta
  forwards (newer pasta also maps UDP/853 and TCP/53, TCP/853): the jail's
  namespace holds exactly the designed ip rules (read over netlink), and
  UDP to other ports and TCP to 53 / 853 are refused at once (EACCES),
  never left to hang;
- no new privileges, a seccomp filter, no other user's process visible, no
  other home, the helper's profile out of reach.

Any doubt is a failure: one "JAIL_UNSAFE <code>" line per problem, exit 1,
and systemd does not start the unit. "JAIL_OK" and exit 0 otherwise.
Codes only: no path content, no environment, nothing read is printed.
"""
import ctypes
import errno
import os
import socket
import struct
import sys
import time

# The jail's only DNS server (admin.sh JAIL_DNS; /run/sr-jail/resolv.conf). pasta answers it on UDP/53.
JAIL_DNS = "198.51.100.53"
# The IPv4 ip rules of the jail's namespace, exactly (admin.sh jail_install, sr-jail-net's ExecStartPre; DEV-088 / A-3):
# the kernel's three default rules and, for the DNS address, UDP/53 to the main table and everything else refused.
# Read from the kernel over netlink (the format of `ip rule show` does not matter). A rule more, less or different
# fails the jail. Written as "<priority>: [to <addr>/<len>] [ipproto <n>] [dport <port>] <action>" (17 = UDP).
EXPECTED_RULES = (
    "0: lookup 255",
    "98: to 198.51.100.53/32 ipproto 17 dport 853 prohibit",
    "99: to 198.51.100.53/32 ipproto 17 dport 53 lookup 254",
    "100: to 198.51.100.53/32 prohibit",
    "32766: lookup 254",
    "32767: lookup 253",
)
# The WSL DNS tunnel: on the VM's loopback, where every 0.0.0.0 service answers too. Never reachable.
WSL_DNS_TUNNEL = "10.255.255.254"

problems = []
notes = []
warnings = []


def fail(code):
    problems.append(code)


def gone(path):
    """True when the path does not exist, or is a node nothing can be done with
    (InaccessiblePaths= leaves a mode-000 node: no listing, no open, no connect)."""
    try:
        st = os.lstat(path)
    except OSError:
        return True
    import stat

    if stat.S_ISDIR(st.st_mode):
        try:
            return os.listdir(path) == [] and path in EMPTY_OK
        except OSError:
            return True
    if stat.S_ISSOCK(st.st_mode):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.connect(path)
            return False
        except OSError:
            return True
        finally:
            s.close()
    try:
        os.close(os.open(path, os.O_RDONLY | os.O_NONBLOCK))
        return False
    except OSError:
        return True


# Directories the jail itself leaves behind as empty mounts (ProtectHome=tmpfs covers /run/user).
EMPTY_OK = ("/run/user",)


def status_field(name):
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith(name + ":"):
                return line.split(":", 1)[1].strip()
    return ""


# rtnetlink (linux/netlink.h, linux/rtnetlink.h, linux/fib_rules.h)
NLMSG_ERROR, NLMSG_DONE, RTM_NEWRULE, RTM_GETRULE = 2, 3, 32, 34
NLM_F_REQUEST, NLM_F_DUMP = 0x1, 0x300
FRA_DST, FRA_PRIORITY, FRA_SUPPRESS_PREFIXLEN, FRA_TABLE, FRA_PROTOCOL, FRA_IP_PROTO, FRA_DPORT_RANGE = 1, 6, 14, 15, 21, 22, 24
FR_ACT_TO_TBL, FR_ACT_PROHIBIT = 1, 8


def describe_rule(payload):
    """One RTM_NEWRULE payload (struct fib_rule_hdr + attributes) as the text EXPECTED_RULES uses. Anything the
    text cannot say (a source, an interface, a mark, a uid range, a source port, a TOS, a flag such as "not")
    is written as a marker that matches nothing, so such a rule can never pass for an expected one."""
    family, dst_len, src_len, tos, table, _res1, _res2, action, flags = struct.unpack_from("=8BI", payload, 0)
    attrs = {}
    off = 12
    while off + 4 <= len(payload):
        alen, atype = struct.unpack_from("=HH", payload, off)
        if alen < 4 or off + alen > len(payload):
            raise ValueError("bad attribute")
        atype &= 0x3FFF
        if atype in attrs:
            raise ValueError("repeated attribute")
        attrs[atype] = payload[off + 4 : off + alen]
        off += (alen + 3) & ~3
    if off != len(payload):
        raise ValueError("trailing bytes")
    words = []
    words.append("%d:" % (struct.unpack("=I", attrs.pop(FRA_PRIORITY))[0] if FRA_PRIORITY in attrs else 0))
    if family != socket.AF_INET:
        words.append("family=%d" % family)
    if src_len or tos or flags:
        words.append("other=%d/%d/%d" % (src_len, tos, flags))
    dst = attrs.pop(FRA_DST, None)
    if dst_len or dst is not None:
        words.append("to %s/%d" % (socket.inet_ntoa(dst) if dst is not None and len(dst) == 4 else "?", dst_len))
    if FRA_IP_PROTO in attrs:
        words.append("ipproto %d" % attrs.pop(FRA_IP_PROTO)[0])
    if FRA_DPORT_RANGE in attrs:
        start, end = struct.unpack("=HH", attrs.pop(FRA_DPORT_RANGE))
        words.append("dport %d" % start if start == end else "dport %d-%d" % (start, end))
    # always sent by the kernel: the table (also for prohibit, then 0), "no suppress_prefixlen" (-1), and the
    # rule's protocol, a label of who added it (kernel / unspec) that changes nothing in the lookup
    if FRA_TABLE in attrs:
        table = struct.unpack("=I", attrs.pop(FRA_TABLE))[0]
    if attrs.pop(FRA_SUPPRESS_PREFIXLEN, struct.pack("=i", -1)) != struct.pack("=i", -1):
        words.append("suppress_prefixlen")
    attrs.pop(FRA_PROTOCOL, None)
    for atype in sorted(attrs):
        words.append("attr%d" % atype)
    if action == FR_ACT_TO_TBL:
        words.append("lookup %d" % table)
    elif action == FR_ACT_PROHIBIT:
        words.append("prohibit")
    else:
        words.append("action%d" % action)
    return " ".join(words)


def parse_rule_dump(chunks, seq):
    """The rules of an RTM_GETRULE dump, in the kernel's order (by priority), from the datagrams received.
    Raises ValueError on anything but a complete, well-formed answer to this request."""
    rules = []
    for data in chunks:
        off = 0
        while off < len(data):
            if off + 16 > len(data):
                raise ValueError("short message")
            length, mtype, _flags, mseq, _pid = struct.unpack_from("=IHHII", data, off)
            if length < 16 or off + length > len(data) or mseq != seq:
                raise ValueError("bad message")
            if mtype == NLMSG_DONE:
                return rules
            if mtype == NLMSG_ERROR or mtype != RTM_NEWRULE:
                raise ValueError("unexpected message")
            rules.append(describe_rule(data[off + 16 : off + length]))
            off += (length + 3) & ~3
    raise ValueError("no end of dump")


def ipv4_rules():
    """The IPv4 ip rules of this process's network namespace, read from the kernel (a dump needs no privilege)."""
    s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0)  # NETLINK_ROUTE
    s.settimeout(2)
    try:
        s.bind((0, 0))
        seq = int(time.time()) & 0x7FFFFFFF
        hdr = struct.pack("=8BI", socket.AF_INET, 0, 0, 0, 0, 0, 0, 0, 0)
        s.sendto(struct.pack("=IHHII", 16 + len(hdr), RTM_GETRULE, NLM_F_REQUEST | NLM_F_DUMP, seq, 0) + hdr, (0, 0))
        chunks = []
        while True:
            chunks.append(s.recv(65536))
            try:
                return parse_rule_dump(chunks, seq)
            except ValueError as e:
                if str(e) != "no end of dump" or len(chunks) > 64:
                    raise
    finally:
        s.close()


def main():
    want_user = sys.argv[1] if len(sys.argv) > 1 else ""
    import pwd

    try:
        me = pwd.getpwuid(os.getuid()).pw_name
    except KeyError:
        me = ""
    if os.getuid() == 0 or me != want_user:
        fail("WRONG_USER")
    if status_field("NoNewPrivs") != "1":
        fail("NEW_PRIVILEGES_POSSIBLE")
    if status_field("Seccomp") != "2":
        fail("NO_SECCOMP_FILTER")

    # Windows and the display: none of it may be visible.
    for path in (
        "/run/WSL",
        "/mnt/c",
        "/mnt/wslg",
        "/usr/lib/wsl",
        "/tmp/.X11-unix",
        "/run/user",
        "/dev/vsock",
        "/dev/dxg",
        "/home/sr-igcapture",
        "/home/sr-designbridge",
        "/srv/sr-capture-admin",
        "/init",
        "/root/sr-capture-admin",
    ):
        if not gone(path):
            fail("VISIBLE_" + path.strip("/").replace("/", "_").replace(".", "").replace("-", "_").upper())
    # what cannot be listed counts as a failure too (unknown is not fine)
    try:
        for name in os.listdir("/run"):
            # systemd/ and resolvconf/ appear only as the place of a bound resolv.conf
            if name not in ("systemd", "user", "sr-jail", "resolvconf"):
                fail("RUN_NOT_EMPTY")
                break
    except OSError:
        fail("RUN_UNCHECKED")
    try:
        others = [n for n in os.listdir("/home") if n != want_user]
        if others:
            fail("OTHER_HOMES_VISIBLE")
    except OSError:
        fail("HOME_UNCHECKED")
    try:
        mnt = [n for n in os.listdir("/mnt") if n not in ("wsl", "sr-export")]
        if mnt:
            fail("MNT_NOT_EMPTY")
        if os.path.isdir("/mnt/wsl") and [n for n in os.listdir("/mnt/wsl") if n != "resolv.conf"]:
            fail("MNT_WSL_NOT_EMPTY")
    except OSError:
        fail("MNT_UNCHECKED")
    # /srv: only the two spools, and of the design bridge spool only its two directories,
    # with the bridge's jobs read-only (DEV-031). Missing is fine (not installed yet).
    try:
        if [n for n in os.listdir("/srv") if n not in ("sr-capture", "sr-design-bridge")]:
            fail("SRV_NOT_EMPTY")
        if os.path.isdir("/srv/sr-design-bridge"):
            if [n for n in os.listdir("/srv/sr-design-bridge") if n not in ("to-worker", "from-worker")]:
                fail("BRIDGE_SPOOL_NOT_EMPTY")
            if os.path.isdir("/srv/sr-design-bridge/to-worker") and os.access("/srv/sr-design-bridge/to-worker", os.W_OK):
                fail("BRIDGE_JOBS_WRITABLE")
    except OSError:
        fail("SRV_UNCHECKED")
    # the system is read-only (ProtectSystem=strict): a unit file that dropped the setting shows here
    for path in ("/usr/sr-jail-probe-write", "/etc/sr-jail-probe-write", "/var/sr-jail-probe-write"):
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
            os.unlink(path)
            fail("SYSTEM_WRITABLE")
        except OSError:
            pass
    for var in ("WSL_INTEROP", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "PULSE_SERVER"):
        if os.environ.get(var):
            fail("ENV_" + var)

    # The requester's own home is visible in the jail: no signed-in browser profile may be
    # left there (the Phase 2 profile lived in ~/.local/share/sr-instagram-browser).
    home = os.path.expanduser("~")
    for rel in (".local/share/sr-instagram-browser", ".config/chromium", ".config/google-chrome", "snap/chromium"):
        if os.path.lexists(os.path.join(home, rel)):
            fail("BROWSER_PROFILE_IN_HOME")

    # The jail's own network namespace (sr-jail-net.service): the id root recorded when it
    # made the namespace must be ours. Then abstract sockets and loopback of the WSL VM
    # (the WSLg X server, systemd's buses, other users' localhost services) are not here.
    try:
        with open("/run/sr-jail/netns-id") as f:
            want = int(f.read().strip())
        if os.stat("/proc/self/ns/net").st_ino != want:
            fail("NETWORK_NOT_PRIVATE")
    except (OSError, ValueError):
        fail("NETWORK_NOT_PRIVATE")

    # The kernel ways out: vsock (WSL's own channel to Windows) and io_uring.
    try:
        s = socket.socket(getattr(socket, "AF_VSOCK", 40), socket.SOCK_STREAM)
        s.close()
        fail("VSOCK_ALLOWED")
    except OSError:
        pass
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        params = ctypes.create_string_buffer(120)
        nr = {"x86_64": 425, "aarch64": 425}.get(os.uname().machine)
        if nr is None:
            fail("UNKNOWN_ARCH")
        else:
            fd = libc.syscall(nr, 1, params)
            if fd >= 0:
                os.close(fd)
                fail("IO_URING_ALLOWED")
            elif ctypes.get_errno() not in (errno.EPERM, errno.ENOSYS, errno.EACCES):
                fail("IO_URING_UNCLEAR")
    except OSError:
        fail("IO_URING_UNCHECKED")

    # The network: the Windows host (the default gateway) and private / link-local
    # addresses must be refused by the cgroup filter (IPAddressDeny). A dropped TCP
    # SYN only times out, so UDP is used: a refused send fails at once with EPERM.
    targets = ["192.168.255.254", "172.16.255.254", "10.0.0.1", "169.254.169.254", "100.64.0.1", WSL_DNS_TUNNEL]
    try:
        with open("/proc/net/route") as f:
            next(f)
            for line in f:
                cols = line.split()
                if len(cols) > 2 and cols[1] == "00000000":
                    gw = int(cols[2], 16)
                    targets.append(socket.inet_ntoa(gw.to_bytes(4, "little")))
    except (OSError, StopIteration, ValueError):
        fail("ROUTE_UNCHECKED")
    for ip in targets:
        if ip == "0.0.0.0":
            continue
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            u.sendto(b"x", (ip, 9))
            fail("PRIVATE_NETWORK_REACHABLE")
        except PermissionError:
            pass
        except OSError:
            fail("PRIVATE_NETWORK_NOT_FILTERED")
        finally:
            u.close()
    # The WSL DNS tunnel on its own DNS port too, over both protocols. A dropped TCP SYN would only
    # time out, so TCP passes when it times out or the kernel refuses to send (EPERM / EACCES).
    # A connection, or a refusal from the far end (the packet got out), fails.
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        u.sendto(b"x", (WSL_DNS_TUNNEL, 53))
        fail("DNS_TUNNEL_REACHABLE")
    except PermissionError:
        pass
    except OSError:
        fail("DNS_TUNNEL_NOT_FILTERED")
    finally:
        u.close()
    t = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    t.settimeout(1)
    try:
        t.connect((WSL_DNS_TUNNEL, 53))
        fail("DNS_TUNNEL_REACHABLE")
    except (TimeoutError, socket.timeout):
        pass
    except OSError as e:
        if e.errno not in (errno.EPERM, errno.EACCES):
            fail("DNS_TUNNEL_NOT_FILTERED")
    finally:
        t.close()

    # The jail's DNS address takes UDP/53 and nothing else, whatever pasta forwards (DEV-088 / A-3): newer pasta
    # also maps UDP/853, TCP/53 and TCP/853 to the host resolver. Inside the jail's namespace the ip rules refuse
    # the rest ("prohibit", EACCES) at once, before a packet reaches pasta. First the rules themselves, exactly.
    try:
        if tuple(ipv4_rules()) != EXPECTED_RULES:
            fail("DNS_RULES_NOT_EXACT")
    except (OSError, ValueError, IndexError, struct.error):
        fail("DNS_RULES_UNCHECKED")
    # TCP to 53 and 853: refused at once (without it a truncated answer would hang a lookup ~2 minutes).
    for port in (53, 853):
        t = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        t.settimeout(1.5)
        started = time.monotonic()
        try:
            t.connect((JAIL_DNS, port))
            fail("DNS_TCP_NOT_REFUSED")
        except OSError as e:
            if e.errno != errno.EACCES:
                fail("DNS_TCP_NOT_REFUSED")
            elif time.monotonic() - started > 1.0:
                fail("DNS_TCP_REFUSED_SLOWLY")
        finally:
            t.close()
    # UDP to any port but 53: refused (853 is DNS over QUIC/DTLS, which newer pasta forwards; 9 stands for the rest).
    for port in (853, 9):
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            u.sendto(b"x", (JAIL_DNS, port))
            fail("DNS_UDP_PORT_NOT_REFUSED")
        except OSError as e:
            if e.errno != errno.EACCES:
                fail("DNS_UDP_PORT_NOT_REFUSED")
        finally:
            u.close()

    for ip in ("fd00::1", "fe80::1%1"):
        try:
            u = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        except OSError:
            break  # no IPv6 at all
        try:
            u.sendto(b"x", (ip, 9))
            fail("PRIVATE_NETWORK6_REACHABLE")
        except PermissionError:
            pass
        except OSError as e:
            # no route: unreachable anyway
            if e.errno not in (errno.ENETUNREACH, errno.EADDRNOTAVAIL, errno.EHOSTUNREACH, errno.EINVAL):
                fail("PRIVATE_NETWORK6_NOT_FILTERED")
        finally:
            u.close()

    # Abstract Unix sockets live in the network namespace, which the jail shares: a listening
    # one (an X server of WSLg, another distro's service) would be reachable. Any that answers
    # is a failure; its name (not secret) is printed so a person can see what it was.
    try:
        with open("/proc/net/unix") as f:
            next(f)
            names = sorted({cols[7] for cols in (l.split() for l in f) if len(cols) > 7 and cols[7].startswith("@")})
    except (OSError, StopIteration):
        names = []
    for name in names[:200]:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(1)
        try:
            s.connect("\0" + name[1:])
            fail("ABSTRACT_SOCKET_REACHABLE")
            notes.append("abstract=" + "".join(c if 32 < ord(c) < 127 else "?" for c in name[:80]))
        except OSError:
            pass
        finally:
            s.close()

    # ptrace is refused (a jailed process must take over nothing, whatever ptrace_scope is).
    # Checked on a child of our own with PTRACE_SEIZE (does not stop it), then the child goes.
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        child = os.fork()
        if child == 0:
            time.sleep(10)
            os._exit(0)
        try:
            if libc.ptrace(0x4206, child, 0, 0) == 0:  # PTRACE_SEIZE
                fail("PTRACE_ALLOWED")
        finally:
            os.kill(child, 9)
            os.waitpid(child, 0)
    except OSError:
        fail("PTRACE_UNCHECKED")

    # Other processes: invisible (ProtectProc=invisible) and the helper's work out of reach.
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                if os.stat("/proc/" + pid).st_uid != os.getuid():
                    fail("OTHER_PROCESSES_VISIBLE")
                    break
            except OSError:
                pass
    try:
        os.listdir("/proc/1/root")
        fail("PID1_ROOT_READABLE")
    except OSError:
        pass

    # Not a boundary, but without it nothing works: say so instead of failing later (admin.sh jail-check
    # fails on it, with getent). Only once every check passed: then TCP to the DNS address is proven refused
    # at once, so a truncated answer cannot make this lookup hang (without the rule it would wait ~2 minutes).
    if not problems:
        try:
            socket.getaddrinfo("github.com", 443, proto=socket.IPPROTO_TCP)
        except OSError:
            warnings.append("DNS_NOT_WORKING")

    for code in warnings:
        print("JAIL_WARN " + code)
    if problems:
        for code in sorted(set(problems)):
            print("JAIL_UNSAFE " + code)
        for note in notes:
            print("JAIL_NOTE " + note)
        return 1
    print("JAIL_OK")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - any doubt is a failure
        print("JAIL_UNSAFE PROBE_ERROR")
        sys.exit(1)
