# Host checks for the Instagram capture helper (DEV-028 Phase 3; security
# review round 3 C1 / H1). Sourced by admin.sh (as root, full checks) and
# run.sh (as sr-igcapture, before every run). Each check prints ONE code line
# and returns 1 when the machine lets the requester (sr-designgen: the
# worker, Claude, Codex) become root or the helper user, i.e. read the
# signed-in browser profile:
#
# - Any process of the requester outside the requester jail: in WSL2 every Linux
#   process can reach Windows (the /run/WSL interop sockets stay root:root 0777
#   even with [interop] enabled=false; vsock), and Windows can start
#   `wsl.exe -u root`. The jail (jail/jail.properties, proven by jail/probe.py)
#   is the boundary; interop off in /etc/wsl.conf is kept as hygiene.
# - The requester is the WSL default user (Windows opens a shell as it and
#   people type sudo there), or can write the Windows drive's Startup folders
#   (a file there runs as the Windows user, who can start wsl.exe -u root).
# - The requester is root, in an admin-equivalent group, or (root only can
#   see this) has any sudo rule.

SR_PROC=/proc
SR_PRIVILEGED_GROUPS="root sudo admin wheel adm lxd incus incus-admin disk docker libvirt kvm shadow systemd-journal sr-igcapture"

sr_is_wsl() {
  grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null || [ -d /run/WSL ]
}

# The value of [section] key in /etc/wsl.conf, lowercased (the last one wins; '' if unset).
sr_wsl_conf() {
  awk -v sec="$1" -v key="$2" '
    /^[[:space:]]*[#;]/ { next }
    /^[[:space:]]*\[/ { s = $0; sub(/[#;].*$/, "", s); gsub(/[][[:space:]]/, "", s); cur = tolower(s); next }
    cur == tolower(sec) {
      i = index($0, "="); if (i == 0) next
      k = substr($0, 1, i - 1); v = substr($0, i + 1)
      gsub(/[[:space:]]/, "", k); sub(/[[:space:]]*[#;].*$/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); gsub(/"/, "", v)
      if (tolower(k) == tolower(key)) val = tolower(v)
    }
    END { print val }' /etc/wsl.conf 2>/dev/null
}

# WSL's own ini reading may differ from ours (case, duplicates): accept only the documented
# spelling ([interop], the exact key) and require EVERY spelling of the key in any interop-like
# section to say false.
sr_wsl_conf_all_false() {
  awk -v key="$1" '
    /^[[:space:]]*[#;]/ { next }
    /^[[:space:]]*\[/ { s = $0; sub(/[#;].*$/, "", s); gsub(/[][[:space:]]/, "", s); exact = (s == "interop"); loose = (tolower(s) == "interop"); next }
    loose {
      i = index($0, "="); if (i == 0) next
      k = substr($0, 1, i - 1); v = substr($0, i + 1)
      gsub(/[[:space:]]/, "", k); sub(/[[:space:]]*[#;].*$/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); gsub(/"/, "", v)
      if (tolower(k) != tolower(key)) next
      if (tolower(v) != "false") bad = 1
      if (exact && k == key) ok = 1
    }
    END { exit !(ok && !bad) }' /etc/wsl.conf 2>/dev/null
}

sr_check_wsl_interop() {
  sr_is_wsl || return 0
  if ! sr_wsl_conf_all_false enabled || ! sr_wsl_conf_all_false appendWindowsPath; then
    echo "WSL_INTEROP_NOT_DISABLED: /etc/wsl.conf needs [interop] enabled=false and appendWindowsPath=false, then 'wsl --shutdown' from Windows"
    return 1
  fi
  local f
  for f in /proc/sys/fs/binfmt_misc/WSLInterop*; do
    if [ -e "$f" ] && head -n 1 "$f" 2>/dev/null | grep -qx enabled; then
      echo "WSL_INTEROP_ACTIVE: interop is still on; run 'wsl --shutdown' from Windows and open WSL again"
      return 1
    fi
  done
  # WSL 2.7 keeps /run/WSL/*_interop (root:root 0777) even with interop off, and Microsoft does
  # not treat enabled=false as a security boundary: these checks are hygiene only. What keeps the
  # requester from Windows is the jail (sr_check_requester_jailed; jail/probe.py).
  return 0
}

# Every process of the requester must run inside a requester jail unit
# (/system.slice/sr-jail-*.service: Claude Remote Control, a person's jailed shell). Only root
# can put a process into that cgroup; a process outside could open the WSL interop socket.
# The login shell must be nologin, so `su`, `wsl.exe -u` and ssh give no shell outside.
sr_check_requester_jailed() {
  local req="$1" uid shell d line jailed owner
  uid="$(id -u "$req" 2>/dev/null)" || return 0
  shell="$(getent passwd "$req" | cut -d: -f7)"
  case "$shell" in
    /usr/sbin/nologin | /sbin/nologin | /bin/false | /usr/bin/false) ;;
    *) echo "REQUESTER_HAS_LOGIN_SHELL: $req has $shell (admin.sh install sets nologin)"; return 1 ;;
  esac
  for d in "$SR_PROC"/[0-9]*; do
    owner="$(awk '/^Uid:/ { print $2 " " $3 " " $4 " " $5; exit }' "$d/status" 2>/dev/null)" || continue
    case " $owner " in *" $uid "*) ;; *) continue ;; esac
    jailed=0
    # exact match: the jail units have no Delegate=, so no sub-cgroup exists (one would read as outside: fail-safe)
    while IFS= read -r line; do
      [[ "$line" =~ ^0::/system\.slice/sr-jail-[a-z0-9-]+\.service$ ]] && jailed=1
    done 2>/dev/null <"$d/cgroup"
    # a process that ended between the two reads is not a problem
    [ -e "$d" ] || continue
    if [ "$jailed" != 1 ]; then
      echo "REQUESTER_OUTSIDE_JAIL: a process of $req runs outside the requester jail; stop it (sudo pkill -u $req) and use admin.sh shell / claude-start"
      return 1
    fi
  done
  return 0
}

# The supplementary groups a RUNNING process holds stay until it ends: removing the requester
# from sudo / docker in /etc/group does not take them from a shell or Claude started before.
sr_check_requester_processes() {
  local req="$1" uid gids=" 0 " g gid f key a b c d rest x mine hit
  uid="$(id -u "$req" 2>/dev/null)" || return 0
  for g in $SR_PRIVILEGED_GROUPS; do
    gid="$(getent group "$g" 2>/dev/null | cut -d: -f3)"
    [ -n "$gid" ] && gids="$gids$gid "
  done
  for f in "$SR_PROC"/[0-9]*/status; do
    mine=0
    hit=0
    while read -r key a b c d rest; do
      case "$key" in
        Uid:) for x in $a $b $c $d; do [ "$x" = "$uid" ] && mine=1; done ;;
        Gid: | Groups:) for x in $a $b $c $d $rest; do case "$gids" in *" $x "*) hit=1 ;; esac; done ;;
      esac
    done 2>/dev/null <"$f"
    if [ "$mine" = 1 ] && [ "$hit" = 1 ]; then
      echo "REQUESTER_PROCESS_PRIVILEGED: a running process of $req still holds an admin group; stop it (sudo pkill -u $req) and run again"
      return 1
    fi
  done
  return 0
}

# sr_check_requester <user> — what any user can see (groups, its running processes, uid, the WSL default user).
sr_check_requester() {
  local req="$1" uid g
  uid="$(id -u "$req" 2>/dev/null)" || { echo "REQUESTER_UNKNOWN: $req"; return 1; }
  [ "$uid" != 0 ] || { echo "REQUESTER_IS_ROOT: $req"; return 1; }
  for g in $(id -nG "$req" 2>/dev/null); do
    case " $SR_PRIVILEGED_GROUPS " in
      *" $g "*) echo "REQUESTER_PRIVILEGED_GROUP: $req is in $g (remove it: sudo gpasswd -d $req $g)"; return 1 ;;
    esac
  done
  sr_check_requester_processes "$req" || return 1
  sr_check_requester_jailed "$req" || return 1
  if sr_is_wsl; then
    local def
    def="$(sr_wsl_conf user default)"
    if [ "$def" = "$req" ] || { [ -z "$def" ] && [ "$uid" = 1000 ]; }; then
      echo "REQUESTER_IS_WSL_DEFAULT_USER: $req is the user Windows opens WSL as; use a separate requester user"
      return 1
    fi
  fi
  return 0
}

# /proc/mounts writes a space as \040: decode exactly three octal digits per escape (printf %b alone
# reads "\0" plus up to three more digits, so "My\040Drive\0402" would come out wrong).
sr_unoctal() {
  printf '%b' "$(printf '%s' "$1" | sed 's/\\\([0-7][0-7][0-7]\)/\\0\1/g')"
}

# sr_check_requester_root <user> — what only root can see: sudo rules, writable Windows Startup folders.
sr_check_requester_root() {
  local req="$1"
  if sudo -n -l -U "$req" 2>/dev/null | grep -q "may run the following"; then
    echo "REQUESTER_HAS_SUDO: $req has sudo rules (sudo -l -U $req); remove them"
    return 1
  fi
  local dev mnt type rest d src
  while read -r dev mnt type rest; do
    case "$type" in 9p | drvfs | virtiofs) ;; *) continue ;; esac
    mnt="$(sr_unoctal "$mnt")"
    src="$(sr_unoctal "$dev")"
    if [ "$mnt" = /mnt/sr-export ]; then
      # The one export folder a person may give the requester (design-capture-helper.md): it must be a plain
      # folder under a user's folder (C:\\Users\\<you>\\<folder>), no '..' or 8.3 short names ('~'), no system tree.
      if ! printf '%s' "$src" | grep -Eqi '^[A-Za-z]:\\Users\\[^\\]+\\[^\\]+' || printf '%s' "$src" | grep -Eq '\.\.|~' \
        || printf '%s' "$src" | grep -Eqi '\\(AppData|ProgramData|Windows|Start Menu|Startup)(\\|$)'; then
        echo "EXPORT_MOUNT_UNSAFE: /mnt/sr-export must be one plain folder such as C:\\Users\\<you>\\SecondRootDemos"
        return 1
      fi
    fi
    for d in "$mnt" "$mnt"/Users/*/AppData/Roaming/Microsoft/Windows/"Start Menu"/Programs/Startup "$mnt"/AppData/Roaming/Microsoft/Windows/"Start Menu"/Programs/Startup \
      "$mnt"/*/AppData/Roaming/Microsoft/Windows/"Start Menu"/Programs/Startup "$mnt/ProgramData/Microsoft/Windows/Start Menu/Programs/StartUp"; do
      [ -d "$d" ] || continue
      [ "$d" = /mnt/sr-export ] && continue
      if runuser -u "$req" -- test -w "$d" 2>/dev/null; then
        echo "REQUESTER_WRITES_WINDOWS: $req can write $d (a Windows drive mounted writable for it)"
        return 1
      fi
    done
  done </proc/mounts
  return 0
}
