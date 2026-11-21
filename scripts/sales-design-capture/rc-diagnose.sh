#!/usr/bin/env bash
# Why does the jailed Claude Remote Control (sr-jail-claude.service) disconnect, and why does a previous session in the
# Claude app say "your computer is not connected to this session"? A READ-ONLY root diagnostic the owner runs once on WSL
# (docs/operations/remote-control-resilience.md §1):
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-capture/rc-diagnose.sh
#
# It changes nothing: no systemctl verb but `show`, no journal rotation / vacuum, no tmux command, nothing started or
# stopped, no file written (not even a temporary one, on bash 5.1+; older bash backs every here-string with a file). It runs NOTHING as the requester (sr-designgen): a process of the
# requester outside the jail would trip REQUESTER_OUTSIDE_JAIL (host-check.sh). It looks only as root, through
# `systemctl show`, `journalctl` and /proc (status, cgroup, stat, comm, the argv of the processes, of which it only tests
# whether the program is Claude and a few option names are present, and where the Remote Control process's cwd points,
# compared with ~/work/second-root and never printed). Of other users' processes only Claude processes are counted. It never opens anything in the requester's home: not the
# sign-in or session files of Claude or Codex, no key, no secret. The one thing it looks at there is whether Remote
# Control's resume pointer for ~/work/second-root exists, and how old it is, with `stat` alone (never opened, its path
# and project key never printed): that pointer is what `claude remote-control --continue` reads (§2 of the doc).
#
# Output: one line per finding, `rc-diagnose: CODE[=value]`. Every line is safe to share: codes, counts, ages in minutes,
# UTC times rounded to the minute, the fixed unit names. No session id, no URL, no path, no argv, no journal text. Then a
# short read-only checklist for Windows and the Claude app. The last line is machine-readable:
#   RC_DIAGNOSE <primary cause code> codes=<every code, comma-separated>
# Exit: 0 whenever it ran (a check it could not do reads as an *_UNREADABLE code), 2 usage or an untrusted copy.
#
# Run by root, only from the root-only admin clone (/root/sr-capture-admin), like admin.sh. Any other copy runs only the
# unit tests' fake WSL (tests/unit/design-agent/rc-diagnose.test.ts, SR_RC_DIAGNOSE_TEST_ROOT).
#
# The whole script is one { ... } block, so bash has read all of it before it starts.
{
set -uo pipefail

# Restart with an allowlisted environment (marked by an argument, not a variable), as imagefirst-autostart.sh.
if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in PATH LANG TZ TMPDIR SR_RC_DIAGNOSE_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec /usr/bin/env -i "${keep[@]}" /bin/bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi
export LC_ALL=C
# The system PATH before any command is looked up (the production run never takes the test hook; a run with it is
# refused below unless it is a copy outside the admin clone, i.e. the unit tests' fake WSL with its stubs on PATH).
[ -n "${SR_RC_DIAGNOSE_TEST_ROOT:-}" ] || export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"
cd /

say() { printf 'rc-diagnose: %s\n' "$*"; }
[ "$#" -eq 0 ] || { say "usage: sudo bash /root/sr-capture-admin/scripts/sales-design-capture/rc-diagnose.sh (no arguments)"; printf 'RC_DIAGNOSE RC_DIAGNOSE_USAGE codes=RC_DIAGNOSE_USAGE\n'; exit 2; }

# ---------------------------------------------------------------- where things are
# The same names as admin.sh (JAIL_CLAUDE / JAIL_NET / ROOT_CLONE) and the pilot's units (imagefirst-pilot-preflight.sh).
JAIL_CLAUDE=sr-jail-claude.service
JAIL_NET=sr-jail-net.service
PILOT_UNITS=(sr-imagefirst-autostart.service sr-imagefirst-autostart.timer sr-design-cycle.service sr-design-cycle.timer)
ROOT_CLONE=/root/sr-capture-admin
REPO="$(dirname "$(dirname "$SELF_DIR")")"
TEST_ROOT="${SR_RC_DIAGNOSE_TEST_ROOT:-}"
REQ=sr-designgen
if [ "$REPO" = "$ROOT_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || { say "RC_DIAGNOSE_TEST_HOOK_REFUSED: test hooks are refused in the admin clone"; printf 'RC_DIAGNOSE RC_DIAGNOSE_USAGE codes=RC_DIAGNOSE_USAGE\n'; exit 2; }
  [ "$(id -u)" = 0 ] || { say "run as root: sudo bash $ROOT_CLONE/scripts/sales-design-capture/rc-diagnose.sh"; printf 'RC_DIAGNOSE RC_DIAGNOSE_USAGE codes=RC_DIAGNOSE_USAGE\n'; exit 2; }
  R=""
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
else
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || { say "run from the root-only clone: sudo bash $ROOT_CLONE/scripts/sales-design-capture/rc-diagnose.sh"; printf 'RC_DIAGNOSE RC_DIAGNOSE_USAGE codes=RC_DIAGNOSE_USAGE\n'; exit 2; }
  R="$TEST_ROOT"
fi

# The file and every directory above it owned by root and writable by nobody else (verbatim from admin.sh's trusted_path):
# root does not run, or source, what the requester or the helper could have changed.
trusted_path() {
  local p owner
  p="$(readlink -f "$1")" || return 1
  while :; do
    owner="$(stat -c %u "$p")" || return 1
    [ "$owner" = 0 ] || return 1
    [ $(( 0$(stat -c %a "$p") & 022 )) -eq 0 ] || return 1
    [ "$p" = / ] && return 0
    p="$(dirname "$p")"
  done
}
if [ -z "$R" ]; then
  for f in "$SELF" "$SELF_DIR/host-check.sh"; do
    trusted_path "$f" || { say "RC_DIAGNOSE_UNTRUSTED: run it from the root-only clone $ROOT_CLONE (design-capture-helper.md §1)"; printf 'RC_DIAGNOSE RC_DIAGNOSE_USAGE codes=RC_DIAGNOSE_USAGE\n'; exit 2; }
  done
fi
# host-check.sh: the jail check (every process of the requester in an sr-jail-*.service cgroup) is reused as is.
# shellcheck source=host-check.sh
. "$SELF_DIR/host-check.sh"
SR_PROC="$R/proc"

CODES=()
code() { CODES+=("$1"); say "$1${2:+=$2}"; }
has() { [[ " ${CODES[*]} " == *" $1 "* ]]; }
info() { say "$1=$2"; }

now() {
  if [ -n "$R" ] && [ -f "$R/clock" ]; then cat "$R/clock"; else date +%s; fi
}
NOW="$(now)"
[[ "$NOW" =~ ^[0-9]+$ ]] || NOW="$(date +%s)"
# a UTC time rounded down to the minute (no seconds: nothing to correlate beyond that)
minute() { date -u -d "@$1" +%Y-%m-%dT%H:%MZ 2>/dev/null || echo unknown; }
age_min() { echo $(( (NOW - $1) / 60 )); }
# systemctl's timestamp, asked for as @<epoch> (--timestamp=unix); anything else is parsed by date, or empty
epoch_of() {
  local v="$1"
  case "$v" in
    "" | n/a | 0) echo "" ;;
    @*) v="${v#@}"; [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo "" ;;
    *) date -d "$v" +%s 2>/dev/null || echo "" ;;
  esac
}

# ---------------------------------------------------------------- systemd (show only)
# show <unit> <prefix>: sets <prefix>_<Key> for each key asked for; returns 1 when systemctl gave no answer.
SHOW_KEYS=LoadState,ActiveState,SubState,Result,NRestarts,ExecMainStartTimestamp,ActiveEnterTimestamp,UnitFileState,KillMode,WantedBy
show() {
  local unit="$1" pre="$2" out k v key
  for key in ${SHOW_KEYS//,/ }; do printf -v "${pre}_${key}" '%s' ""; done
  # --timestamp=unix (systemd 248+) gives @<epoch>; an older systemd answers without it
  out="$(systemctl show --timestamp=unix -p "$SHOW_KEYS" "$unit" 2>/dev/null)" || out="$(systemctl show -p "$SHOW_KEYS" "$unit" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  while IFS='=' read -r k v; do
    case ",$SHOW_KEYS," in *",$k,"*) printf -v "${pre}_${k}" '%s' "$v" ;; esac
  done <<<"$out"
  return 0
}

# The journal is streamed through awk, never held in a shell variable or a here-string: bash writes a here-string larger
# than a pipe (64 KiB) to a temporary file, and this script writes no file. Only small results (counts, a few epochs) are
# kept. journal <since epoch> <unit...>: those units' lines as "<epoch> <text>", in time order (only counted, never printed)
journal() {
  local since="$1" u args=()
  shift
  for u in "$@"; do args+=(-u "$u"); done
  journalctl -q --no-pager -o short-unix --since "@$since" "${args[@]}" 2>/dev/null
}
# kv <text>: sets each key=value word of an awk summary (keys are fixed in this script, values numbers)
kv() {
  local w
  for w in $1; do
    case "$w" in [A-Z]*=*) printf -v "J_${w%%=*}" '%s' "${w#*=}" ;; esac
  done
}

DAY=86400
WEEK=$((7 * DAY))

say "read only: nothing is started, stopped, enabled, written or run as $REQ"

# ---------------------------------------------------------------- 1. WSL VM / distro restarts
# Only index, first_entry and last_entry (microseconds) of each boot are read, never the boot id.
BOOT_AGE=""
CUR_BOOT=""
BOOT_GAP=""
if boots="$(journalctl --list-boots -o json --no-pager 2>/dev/null | sed 's/},[[:space:]]*{/}\n{/g' \
  | sed -nE 's/.*"index":(-?[0-9]+).*"first_entry":([0-9]+).*"last_entry":([0-9]+).*/\1 \2 \3/p' \
  | awk -v now="$NOW" -v day="$DAY" -v week="$((7 * DAY))" '
    { i = $1 + 0; f[i] = int($2 / 1000000); l[i] = int($3 / 1000000); n++; if (n == 1 || i < lo) lo = i; if (n == 1 || i > hi) hi = i }
    END {
      if (!n) exit 1
      for (i = lo; i <= hi; i++) if (i in f) { if (f[i] >= now - week) b7++; if (f[i] >= now - day) b1++ }
      printf "LISTED=%d B7=%d B1=%d", n, b7, b1
      if (0 in f) printf " CUR=%d", f[0]
      if ((0 in f) && (-1 in l)) printf " GAP=%d", f[0] - l[-1]
      printf "\n"
      # the most recent boots: when each began and how long WSL was down before it
      for (i = (hi - 4 > lo + 1 ? hi - 4 : lo + 1); i <= hi; i++) if ((i in f) && ((i - 1) in l)) printf "BOOT %d %d\n", f[i], (f[i] - l[i - 1]) / 60
    }')" && [ -n "$boots" ]; then
  J_LISTED=0 J_B7=0 J_B1=0 J_CUR="" J_GAP=""
  kv "$(head -n 1 <<<"$boots")"
  info WSL_BOOTS_LISTED "$J_LISTED"
  info WSL_BOOTS_7D "$J_B7"
  info WSL_BOOTS_24H "$J_B1"
  info WSL_BOOTS_PER_DAY "$(awk -v n="$J_B7" 'BEGIN { printf "%.1f", n / 7 }')"
  if [[ "$J_CUR" =~ ^[0-9]+$ ]]; then
    CUR_BOOT="$J_CUR"
    BOOT_AGE=$((NOW - J_CUR))
    info WSL_BOOT_STARTED "$(minute "$J_CUR")"
    info WSL_BOOT_AGE_MIN "$(age_min "$J_CUR")"
  fi
  [[ ! "$J_GAP" =~ ^[0-9]+$ ]] || BOOT_GAP="$J_GAP"
  grep '^BOOT ' <<<"$boots" | while read -r _ t gap; do say "WSL_BOOT at=$(minute "$t") down_before_min=$gap"; done
  # a volatile journal (or a new distro): earlier restarts cannot be counted from here
  [ "$J_LISTED" -gt 1 ] || code WSL_JOURNAL_ONE_BOOT
  if [ -n "$BOOT_AGE" ] && [ "$BOOT_AGE" -lt "$DAY" ] && [ "$J_LISTED" -ge 2 ]; then code WSL_RESTARTED_RECENTLY "$J_B1"; fi
else
  code WSL_BOOTS_UNREADABLE
fi
# the kernel's uptime is the VM's; a distro restarted inside a running VM (wsl --terminate) has a younger boot
if up="$(cut -d' ' -f1 "$R/proc/uptime" 2>/dev/null)" && [[ "$up" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  up="${up%.*}"
  info WSL_VM_UPTIME_MIN $((up / 60))
  if [ -n "$BOOT_AGE" ] && [ $((up - BOOT_AGE)) -gt 600 ]; then code WSL_DISTRO_RESTARTED_VM_KEPT; fi
else
  code WSL_UPTIME_UNREADABLE
fi
# "this boot": since the current boot's first journal entry, or the last 24 h when the boots cannot be read
SINCE_BOOT="${CUR_BOOT:-$((NOW - DAY))}"

# ---------------------------------------------------------------- 2. sr-jail-claude.service
UNIT_OK=0
UNIT_START=""
if show "$JAIL_CLAUDE" U; then
  UNIT_OK=1
  info RC_UNIT_LOAD "${U_LoadState:-unknown}"
  info RC_UNIT_ACTIVE "${U_ActiveState:-unknown}/${U_SubState:-unknown}"
  info RC_UNIT_RESULT "${U_Result:-unknown}"
  info RC_UNIT_FILE "${U_UnitFileState:-unknown}"
  info RC_UNIT_KILLMODE "${U_KillMode:-unknown}"
  info RC_UNIT_NRESTARTS "${U_NRestarts:-unknown}"
  # enabled = multi-user.target wants it: it starts with every boot of the distro (no command needed after a WSL restart)
  case " ${U_WantedBy:-} " in *" multi-user.target "*) info RC_UNIT_WANTED_BY_MULTI_USER yes ;; *) info RC_UNIT_WANTED_BY_MULTI_USER no ;; esac
  UNIT_START="$(epoch_of "$U_ActiveEnterTimestamp")"
  if [ -n "$UNIT_START" ] && [ "$U_ActiveState" = active ]; then
    info RC_UNIT_ACTIVE_SINCE "$(minute "$UNIT_START")"
    info RC_UNIT_ACTIVE_MIN "$(age_min "$UNIT_START")"
  fi
  if [ "${U_LoadState:-}" = not-found ]; then
    code RC_UNIT_NOT_INSTALLED
  elif [[ "${U_UnitFileState:-}" =~ ^(disabled|masked)$ ]] && [[ "${U_ActiveState:-}" =~ ^(inactive|failed)$ ]]; then
    # admin.sh claude-stop (the pilot's exclusion) disables it: nothing starts it again until claude-start
    code RC_UNIT_STOPPED_BY_OWNER
  fi
  if [ "${U_Result:-}" = start-limit-hit ]; then code RC_UNIT_START_LIMIT; fi
else
  code RC_UNIT_UNREADABLE
fi

# systemd's own lines about the unit, counted over 7 days and in this boot. An exit is Claude ending (systemd logs one
# exit as several lines: lines within 10 s are one exit). "Scheduled restart job" is systemd's automatic restart
# (Restart=always); a stop and start by a person (claude-stop / claude-start, approve / jail-install) has none, and a
# restart of sr-jail-net shows in section 3. For each exit a start followed, the gap until that start; resume after a
# stop works for about 4 h. EXITS: the exit epochs (for section 3), one per exit.
JOURNAL_OK=1
EXITS=""
STOP_GAP=""
EXIT_RE='Deactivated successfully|Failed with result|Main process exited|: Stopped '
if sum="$(journal $((NOW - WEEK)) "$JAIL_CLAUDE" | awk -v boot="$SINCE_BOOT" -v exitre="$EXIT_RE" '
    { split($1, a, "."); t = a[1] + 0; nb = (t >= boot) }
    /: Started / { s7++; if (nb) sb++; last = t; if (x) gap = t - x; if (x && t - x > maxgap) maxgap = t - x; x = 0 }
    /Scheduled restart job/ { a7++; if (nb) ab++ }
    /: Stopped / { st7++; if (nb) stb++ }
    /Start request repeated too quickly|start-limit-hit/ { lim7++ }
    /Failed with result|Failed to start/ { f7++ }
    /Deactivated successfully/ { c7++ }
    /JAIL_UNSAFE/ { p7++ }
    $0 ~ exitre { if (t - lx > 10) { e7++; ex = ex (ex == "" ? "" : ",") t; lastx = t } lx = t; x = t }
    END {
      printf "S7=%d SB=%d A7=%d AB=%d ST7=%d STB=%d LIM7=%d F7=%d C7=%d P7=%d E7=%d LAST=%d LASTX=%d GAP=%s MAXGAP=%s EXITS=%s\n",
        s7, sb, a7, ab, st7, stb, lim7, f7, c7, p7, e7, last, lastx, (gap == "" ? "" : gap), (maxgap == "" ? "" : maxgap), ex
    }')"; then
  J_GAP="" J_MAXGAP="" J_EXITS=""
  kv "$sum"
  info RC_UNIT_STARTS_7D "$J_S7"
  info RC_UNIT_STARTS_THIS_BOOT "$J_SB"
  info RC_UNIT_AUTO_RESTARTS_7D "$J_A7"
  info RC_UNIT_AUTO_RESTARTS_THIS_BOOT "$J_AB"
  info RC_UNIT_STOPS_7D "$J_ST7"
  info RC_UNIT_STOPS_THIS_BOOT "$J_STB"
  info RC_UNIT_EXITED_CLEANLY_7D "$J_C7"
  info RC_UNIT_FAILED_7D "$J_F7"
  info RC_UNIT_EXITS_7D "$J_E7"
  [ "$J_LAST" = 0 ] || info RC_UNIT_LAST_START "$(minute "$J_LAST")"
  [ "$J_LASTX" = 0 ] || info RC_UNIT_LAST_EXIT "$(minute "$J_LASTX")"
  if [[ "$J_GAP" =~ ^[0-9]+$ ]]; then
    info RC_LAST_EXIT_TO_START_MIN $((J_GAP / 60))
    info RC_MAX_EXIT_TO_START_MIN_7D $((J_MAXGAP / 60))
    STOP_GAP="$J_GAP"
  fi
  EXITS="$J_EXITS"
  # automatic restarts in this boot only (not a person's stop / start, not a WSL restart)
  if [ "$J_AB" -gt 0 ]; then code RC_UNIT_RESTARTS "$J_AB"; fi
  if [ "$J_LIM7" -gt 0 ] && ! has RC_UNIT_START_LIMIT; then code RC_UNIT_START_LIMIT "$J_LIM7"; fi
  if [ "$J_P7" -gt 0 ]; then code RC_UNIT_PROBE_FAILED "$J_P7"; fi
else
  JOURNAL_OK=0
fi
# a WSL restart is a stop as well: how long WSL was down before this boot
if [[ "$BOOT_GAP" =~ ^[0-9]+$ ]] && { [ -z "$STOP_GAP" ] || [ "$BOOT_GAP" -gt "$STOP_GAP" ]; }; then STOP_GAP="$BOOT_GAP"; fi
if [[ "$STOP_GAP" =~ ^[0-9]+$ ]] && [ "$STOP_GAP" -gt 14400 ]; then code RC_STOP_GAP_OVER_4H $((STOP_GAP / 60)); fi

# ---------------------------------------------------------------- 3. sr-jail-net.service (BindsTo: a restart restarts Claude)
if show "$JAIL_NET" N; then
  info RC_NET_ACTIVE "${N_ActiveState:-unknown}/${N_SubState:-unknown}"
  info RC_NET_NRESTARTS "${N_NRestarts:-unknown}"
  netStart="$(epoch_of "$N_ActiveEnterTimestamp")"
  [ -z "$netStart" ] || info RC_NET_ACTIVE_SINCE "$(minute "$netStart")"
else
  code RC_NET_UNREADABLE
fi
# every start of the net unit in this boot after its first one (automatic, or a person's restart / approve /
# jail-install) restarted Claude with it
if sum="$(journal $((NOW - WEEK)) "$JAIL_NET" | awk -v boot="$SINCE_BOOT" '
    /: Started / { split($1, a, "."); s7++; if (a[1] + 0 >= boot) sb++ }
    END { printf "NS7=%d NSB=%d\n", s7, sb }')"; then
  kv "$sum"
  info RC_NET_STARTS_7D "$J_NS7"
  info RC_NET_STARTS_THIS_BOOT "$J_NSB"
  if [ "$J_NSB" -gt 1 ]; then code RC_NET_RESTARTS $((J_NSB - 1)); fi
else
  JOURNAL_OK=0
fi

# Exits of Claude that followed a network failure in the 15 minutes before (server mode gives up after about 10 minutes
# without the network and exits: official docs). Only counted; no journal text is printed.
NET_RE='Network is unreachable|network is unreachable|ENETUNREACH|No route to host|Temporary failure in name resolution|DNS_NOT_WORKING|Connection timed out|carrier lost|Link DOWN|link down'
if sum="$(journal $((NOW - WEEK)) "$JAIL_CLAUDE" "$JAIL_NET" systemd-resolved.service systemd-networkd.service | awk -v netre="$NET_RE" -v exits="$EXITS" '
    BEGIN { n = split(exits, x, ",") }
    $0 ~ netre {
      split($1, a, "."); t = a[1] + 0; lines++
      for (i = 1; i <= n; i++) if (!(i in hit) && x[i] - t >= 0 && x[i] - t <= 900) { hit[i] = 1; c++ }
    }
    END { printf "NETLINES=%d AFTERNET=%d\n", lines, c }')"; then
  kv "$sum"
  info RC_NETWORK_ERROR_LINES_7D "$J_NETLINES"
  info RC_EXITS_AFTER_NETWORK_ERROR_7D "$J_AFTERNET"
  if [ "$J_AFTERNET" -gt 0 ]; then code RC_EXIT_AFTER_NETWORK_LOSS "$J_AFTERNET"; fi
else
  JOURNAL_OK=0
fi
[ "$JOURNAL_OK" = 1 ] || code RC_JOURNAL_UNREADABLE

# ---------------------------------------------------------------- 4. the processes (/proc, as root)
# For each process of the requester: its unit (the cgroup v2 line), and what it is. Its argv is read only to test for a
# few option names; it is never printed (it may carry a session id). Remote Control is either the server mode
# (`claude remote-control`, many sessions; exits after about 10 minutes without the network) or the interactive mode
# (`claude --remote-control`, one session; retries for as long as an outage lasts). Of other users' processes (a Claude
# Desktop WSL-local session runs as the person's own user) only Claude processes are counted.
PROC_OK=0
RC_COUNT=0
RC_OLDEST=""
RC_UNIT=""
RC_MODE=""
RC_PID=""
RC_CONT=0
RC_SID=0
RC_NAMED=0
RC_SPAWN=""
RC_NOCREATE=0
TMUX_COUNT=0
TMUX_UNIT=""
IN_UNIT_OTHER=0
OTHER_CLAUDE=0
OTHER_RC=0
RC_PIDS=()
RC_PPIDS=()
# what admin.sh's unit itself starts around Claude (the tmux client and the shell of its ExecStart)
LAUNCHERS='^(tmux|bash|sh)$'
OUTSIDE=()
uid="$(id -u "$REQ" 2>/dev/null)" || uid=""
CLK="$(getconf CLK_TCK 2>/dev/null)"; [[ "$CLK" =~ ^[0-9]+$ ]] && [ "$CLK" -gt 0 ] || CLK=100
BTIME="$(awk '$1 == "btime" { print $2 }' "$SR_PROC/stat" 2>/dev/null)"
# claude_at <comm> <argv...>: where Claude Code's program is in this argv (0: the native `claude` binary, or comm says
# claude; 1: node / bun running Claude Code's script), or nothing when the process is not Claude Code. Only the program
# counts: `grep claude`, `tmux ... -s claude` or another tool's cli.js (Playwright's) are not Claude.
claude_at() {
  local comm="$1"
  shift
  case "${1##*/}" in
    claude | claude.exe) echo 0; return 0 ;;
    node | node[0-9]* | bun)
      case "${2:-}" in
        */claude | */@anthropic-ai/claude-code/cli.js | */@anthropic-ai/claude-code/cli.mjs) echo 1; return 0 ;;
      esac
      ;;
  esac
  if [ "$comm" = claude ]; then echo 0; return 0; fi
  return 1
}
# rc_mode <program index> <argv...>: server (the word right after the program is `remote-control` or its alias `rc`),
# interactive (`--remote-control` / `--rc`, with or without a name), or nothing.
rc_mode() {
  local p="$1" a mode=""
  shift
  shift $((p + 1))
  case "${1:-}" in remote-control | rc) echo server; return 0 ;; esac
  for a in "$@"; do
    case "$a" in --remote-control | --remote-control=* | --rc | --rc=*) mode=interactive ;; esac
  done
  echo "$mode"
}
if [ -z "$uid" ]; then
  code REQUESTER_UNKNOWN
elif [ -d "$SR_PROC" ]; then
  PROC_OK=1
  for d in "$SR_PROC"/[0-9]*; do
    owner="$(awk '/^Uid:/ { print $2 " " $3 " " $4 " " $5; exit }' "$d/status" 2>/dev/null)" || continue
    mapfile -d '' -t argv <"$d/cmdline" 2>/dev/null || argv=()
    [ "${#argv[@]}" -gt 0 ] || argv=("")
    comm="$(cat "$d/comm" 2>/dev/null)"
    claude=0
    mode=""
    if at="$(claude_at "$comm" "${argv[@]}")"; then
      claude=1
      mode="$(rc_mode "$at" "${argv[@]}")"
    fi
    case " $owner " in
      *" $uid "*) ;;
      *)
        [ "$claude" = 0 ] || OTHER_CLAUDE=$((OTHER_CLAUDE + 1))
        [ -z "$mode" ] || OTHER_RC=$((OTHER_RC + 1))
        continue
        ;;
    esac
    cg="$(sed -n 's/^0:://p' "$d/cgroup" 2>/dev/null | head -n 1)"
    unit="${cg##*/}"
    case "$unit" in *.service | *.scope) ;; *) unit=other ;; esac
    if [ -n "$mode" ]; then
      RC_COUNT=$((RC_COUNT + 1))
      RC_PIDS+=("${d##*/}")
      RC_PPIDS+=("$(awk '/^PPid:/ { print $2; exit }' "$d/status" 2>/dev/null)")
      start=""
      st="$(sed -E 's/^.*\) //' "$d/stat" 2>/dev/null)"
      ticks="$(awk '{ print $20 }' <<<"$st")"
      if [[ "$ticks" =~ ^[0-9]+$ ]] && [[ "$BTIME" =~ ^[0-9]+$ ]]; then start=$((BTIME + ticks / CLK)); fi
      if [ -z "$RC_OLDEST" ] || { [ -n "$start" ] && [ "$start" -lt "$RC_OLDEST" ]; }; then
        RC_OLDEST="$start"
        RC_UNIT="$unit"
        RC_MODE="$mode"
        RC_PID="$d"
        RC_CONT=0; RC_SID=0; RC_NAMED=0; RC_SPAWN=""; RC_NOCREATE=0
        prev=""
        for a in "${argv[@]}"; do
          case "$a" in
            -c | --continue) RC_CONT=1 ;;
            --session-id | --session-id=*) RC_SID=1 ;;
            --name | --name=* | --remote-control=*) RC_NAMED=1 ;;
            --spawn=same-dir | --spawn=worktree | --spawn=session) RC_SPAWN="${a#--spawn=}" ;;
            --spawn=*) RC_SPAWN=other ;;
            --no-create-session-in-dir) RC_NOCREATE=1 ;;
          esac
          if [ "$prev" = --spawn ]; then case "$a" in same-dir | worktree | session) RC_SPAWN="$a" ;; *) RC_SPAWN=other ;; esac; fi
          prev="$a"
        done
      fi
    elif [[ "$comm" == "tmux: server" ]] || [[ "${argv[0]}" == "tmux: server"* ]]; then
      TMUX_COUNT=$((TMUX_COUNT + 1))
      TMUX_UNIT="$unit"
    elif [ "$unit" = "$JAIL_CLAUDE" ] && [ "$claude" = 0 ] && ! [[ "$comm" =~ $LAUNCHERS ]]; then
      # a job Claude started inside the unit (worker, Codex, Chromium, tests): a restart of the unit kills it
      IN_UNIT_OTHER=$((IN_UNIT_OTHER + 1))
    fi
    if ! [[ "$cg" =~ ^/system\.slice/sr-jail-[a-z0-9-]+\.service$ ]]; then
      case "$unit" in sr-imagefirst-autostart.service | sr-design-cycle.service) OUTSIDE+=("$unit") ;; *) OUTSIDE+=(other) ;; esac
    fi
  done
fi
yn() { if [ "$1" = 1 ]; then echo yes; else echo no; fi; }
if [ "$PROC_OK" = 1 ]; then
  info RC_PROCESSES "$RC_COUNT"
  if [ "$RC_COUNT" -gt 0 ]; then
    info RC_MODE "$RC_MODE"
    info RC_PROC_UNIT "$([ "$RC_UNIT" = "$JAIL_CLAUDE" ] && echo "$JAIL_CLAUDE" || echo other)"
    if [ -n "$RC_OLDEST" ]; then
      info RC_PROC_STARTED "$(minute "$RC_OLDEST")"
      info RC_PROC_AGE_MIN "$(age_min "$RC_OLDEST")"
      if [ -n "$UNIT_START" ]; then
        diff=$((RC_OLDEST - UNIT_START))
        if [ "${diff#-}" -le 120 ]; then info RC_PROC_STARTED_WITH_UNIT yes; else info RC_PROC_STARTED_WITH_UNIT no; code RC_PROC_YOUNGER_THAN_UNIT "$((diff / 60))"; fi
      fi
    fi
    # which sessions a restart brings back (official docs): neither option = every session the server was serving
    if [ "$RC_SID" = 1 ]; then restore=session-id; elif [ "$RC_CONT" = 1 ]; then restore=continue; else restore=plain; fi
    info RC_ARGV_RESTORE "$restore"
    info RC_ARGV_CONTINUE "$(yn "$RC_CONT")"
    info RC_ARGV_SESSION_ID "$(yn "$RC_SID")"
    info RC_ARGV_NAME "$(yn "$RC_NAMED")"
    info RC_ARGV_SPAWN "${RC_SPAWN:-default}"
    info RC_ARGV_CREATE_SESSION_IN_DIR "$([ "$RC_NOCREATE" = 1 ] && echo off || echo default)"
    # with --no-create-session-in-dir a stop archives the sessions (official docs): nothing to bring back
    [ "$RC_NOCREATE" = 0 ] || code RC_NO_CREATE_SESSION_IN_DIR
    # the directory the server runs in (the resume record is kept per directory): compared, never printed
    home_dir="$(getent passwd "$REQ" 2>/dev/null | cut -d: -f6)"
    cwd="$(readlink "$RC_PID/cwd" 2>/dev/null)" || cwd=""
    if [ -z "$cwd" ]; then
      info RC_PROC_CWD unreadable
    elif [ -n "$home_dir" ] && [ "$cwd" = "$home_dir/work/second-root" ]; then
      info RC_PROC_CWD expected
    else
      info RC_PROC_CWD other
      code RC_PROC_CWD_UNEXPECTED
    fi
  fi
  # two servers for the same directory: a stop of one archives the sessions (official docs). A Remote Control process
  # whose parent is itself one (a session it started, if it does so: unverified on a real machine) is not another server.
  servers=0
  for i in "${!RC_PIDS[@]}"; do
    case " ${RC_PIDS[*]} " in *" ${RC_PPIDS[$i]:-x} "*) ;; *) servers=$((servers + 1)) ;; esac
  done
  info RC_SERVERS "$servers"
  [ "$servers" -le 1 ] || code RC_MULTIPLE_SERVERS "$servers"
  if [ "$RC_COUNT" = 0 ] && [ "$UNIT_OK" = 1 ] && [ "${U_ActiveState:-}" = active ]; then code RC_PROC_MISSING; fi
  info RC_TMUX_SERVERS "$TMUX_COUNT"
  [ "$TMUX_COUNT" = 0 ] || info RC_TMUX_UNIT "$([ "$TMUX_UNIT" = "$JAIL_CLAUDE" ] && echo "$JAIL_CLAUDE" || echo other)"
  info RC_UNIT_OTHER_PROCS "$IN_UNIT_OTHER"
  [ "$IN_UNIT_OTHER" = 0 ] || code RC_UNIT_JOBS_AT_RISK "$IN_UNIT_OTHER"
  # Claude of other users (e.g. a Claude Desktop WSL-local session, which runs as the person's own user): counts only
  info OTHER_USER_CLAUDE_PROCS "$OTHER_CLAUDE"
  info OTHER_USER_RC_PROCS "$OTHER_RC"
  [ "$OTHER_CLAUDE" = 0 ] || code OTHER_USER_CLAUDE_RUNNING "$OTHER_CLAUDE"
  # processes of the requester outside every sr-jail-*.service unit: reported, as host-check.sh (sr_check_requester_jailed)
  info REQUESTER_OUTSIDE_JAIL_PROCS "${#OUTSIDE[@]}"
  if [ "${#OUTSIDE[@]}" -gt 0 ]; then
    printf '%s\n' "${OUTSIDE[@]}" | sort | uniq -c | while read -r n u; do say "REQUESTER_OUTSIDE_JAIL_UNIT $u=$n"; done
  fi
  if ! jailed="$(sr_check_requester_jailed "$REQ" 2>/dev/null)"; then
    code "$(sed -nE 's/^([A-Z_]+):.*/\1/p' <<<"$jailed" | head -n 1 | grep -E '^[A-Z_]+$' || echo REQUESTER_JAIL_CHECK_FAILED)"
  fi
else
  has REQUESTER_UNKNOWN || code RC_PROC_UNREADABLE
fi

# ---------------------------------------------------------------- 5. Remote Control's resume pointer (stat only)
# A restart of the server brings back its sessions for about 4 h after it stopped (official docs; plain start: every
# session it served, --continue: the first one, --session-id: that one). The docs do not say where the record is kept.
# Observed in the CLI 2.1.330 binary only (unconfirmed on the owner's WSL): a per-project pointer file in the requester's
# Claude state, <config>/projects/<project key>/bridge-pointer.json, the key being the directory with every character but
# [A-Za-z0-9] turned into "-", cleared when its mtime is older than 4 h by default. The unit starts Claude in
# ~/work/second-root. Only whether it exists and its mtime are read, with stat as root: it is never opened, and neither its
# path nor the project key is printed.
RESUME_WINDOW=14400
home="$(getent passwd "$REQ" 2>/dev/null | cut -d: -f6)"
if [[ "$home" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  key="$(printf '%s' "$home/work/second-root" | sed 's/[^A-Za-z0-9]/-/g')"
  pointer="$R$home/.claude/projects/$key/bridge-pointer.json"
  if mtime="$(stat -c %Y -- "$pointer" 2>/dev/null)" && [[ "$mtime" =~ ^[0-9]+$ ]]; then
    info RC_BRIDGE_POINTER present
    info RC_BRIDGE_POINTER_AGE_MIN "$(age_min "$mtime")"
    # written by the server running now? (a restart whose restore failed may leave an older one)
    if [ -n "$RC_OLDEST" ]; then
      if [ "$mtime" -ge "$RC_OLDEST" ]; then info RC_BRIDGE_POINTER_SINCE_PROC_START yes; else info RC_BRIDGE_POINTER_SINCE_PROC_START no; fi
    fi
    if [ $((NOW - mtime)) -le "$RESUME_WINDOW" ]; then
      info RC_BRIDGE_POINTER_AGE lt4h
      code RC_RESUME_WINDOW_OPEN
    else
      info RC_BRIDGE_POINTER_AGE gt4h
      code RC_RESUME_WINDOW_EXPIRED
    fi
  else
    info RC_BRIDGE_POINTER absent
    code RC_NO_RESUME_POINTER
  fi
else
  code RC_BRIDGE_POINTER_UNREADABLE
fi
unset home key pointer mtime

# ---------------------------------------------------------------- 6. the pilot / automatic start (mutual exclusion with Claude)
for u in "${PILOT_UNITS[@]}"; do
  if show "$u" P; then
    say "PILOT_UNIT $u load=${P_LoadState:-unknown} active=${P_ActiveState:-unknown} file=${P_UnitFileState:-unknown}"
  else
    say "PILOT_UNIT $u UNREADABLE"
  fi
done

# ---------------------------------------------------------------- the primary cause
PRIMARY=RC_NO_LINUX_CAUSE_FOUND
# A candidate, not a confirmed cause: the order is the most specific first (docs/operations/remote-control-resilience.md §1)
for c in RC_UNIT_NOT_INSTALLED RC_UNIT_STOPPED_BY_OWNER RC_UNIT_START_LIMIT RC_UNIT_PROBE_FAILED RC_PROC_MISSING RC_NO_CREATE_SESSION_IN_DIR RC_MULTIPLE_SERVERS RC_PROC_CWD_UNEXPECTED RC_STOP_GAP_OVER_4H RC_EXIT_AFTER_NETWORK_LOSS WSL_RESTARTED_RECENTLY WSL_DISTRO_RESTARTED_VM_KEPT RC_NET_RESTARTS RC_UNIT_RESTARTS RC_PROC_YOUNGER_THAN_UNIT; do
  if has "$c"; then PRIMARY="$c"; break; fi
done
if [ "$PRIMARY" = RC_NO_LINUX_CAUSE_FOUND ]; then
  for c in RC_UNIT_UNREADABLE RC_JOURNAL_UNREADABLE WSL_BOOTS_UNREADABLE RC_PROC_UNREADABLE; do
    if has "$c"; then PRIMARY=RC_DIAGNOSE_UNREADABLE; break; fi
  done
fi

say "--- Windows (PowerShell, read only; never change .wslconfig without the owner's approval):"
say "  wsl --version"
say "  wsl -l -v"
say "  Get-Content \$env:USERPROFILE\\.wslconfig"
say "--- Claude app: write down, for the session that said 'not connected' / 'disconnected':"
say "    1. which kind it was: a session of this jailed server (its name starts with the hostname), or a Claude Desktop"
say "       Code-tab WSL session where Remote Control was switched on (/remote-control); this script sees only the first kind"
say "       (OTHER_USER_CLAUDE_PROCS counts Claude processes of other users, e.g. a Desktop WSL session)"
say "    2. when it was last used and when it said so (the gap against the 4 h resume window)"
say "    3. whether Windows slept, restarted or updated in between, and whether Claude Desktop updated or restarted"
say "--- docs/operations/remote-control-resilience.md §1 explains each code."

summary=""
for c in "${CODES[@]}"; do summary="${summary:+$summary,}${c%%=*}"; done
printf 'RC_DIAGNOSE %s codes=%s\n' "$PRIMARY" "${summary:-none}"
exit 0
}
