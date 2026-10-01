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
  once (cgroup BPF: IPAddressDeny), except the WSL DNS tunnel;
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
import sys

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
    targets = ["192.168.255.254", "172.16.255.254", "10.0.0.1", "169.254.169.254", "100.64.0.1"]
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
        if ip in ("0.0.0.0", "10.255.255.254"):
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
            import time

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

    # Not a boundary, but without it nothing works: say so instead of failing later.
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
