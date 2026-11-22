#!/usr/bin/env bash
# Second Root IMAGE_FIRST owner approval command (Issue #302, docs/operations/imagefirst-autorun.md): the owner's ONE root
# command after merging an approved packet. It writes root's one-use run marker for the automatic run
# (imagefirst-autorun.sh), and nothing else: it never starts the worker or the pilot, never stops Remote Control, never
# claims, never creates root's used/<id> or attempt/<id>.
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-approve.sh <approval id>
#
# Run by root, only from the root-only admin clone (/root/sr-capture-admin), by a person. In this order (anything
# unexpected refuses; no marker is written):
#   1. the id: hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN, not the dummy PoC's reserved date 00000000
#   2. the production copy: this script root's and writable by nobody else up to /; the admin clone clean, and after a
#      fetch of origin develop its HEAD is origin/develop (else the exact checkout line is printed; it never updates itself);
#      then, in that root-owned clone at that commit, the id's own packet has §10 状態 承認済み and exactly this id in its
#      "<d> の承認 ID" row (plain line patterns, no parser); its 期限 row, when readable, is the packet's expiry (past:
#      refused; the marker carries it when within 24 h, and the worker's precheck must report the same)
#   3. the owner's switch /etc/sr-design-worker/imagefirst-autostart.json exists and says {"enabled": true} (else the
#      lines to turn it on are printed): a marker without the switch would do nothing, so it is not written
#   4. the old hourly automatic start's units neither active nor enabled (it reads the same marker and would run the
#      worker without the pilot's audit): else refused
#   5. the automatic run's lock (no firing meanwhile); root's used/<id> or attempt/<id> absent (one use per id); the
#      current marker, if any, names this id, or one that is used, attempted or expired (never replaces a pending other id)
#   6. the worker's own precheck, ONLY when the worker user is idle (the automatic start's busy(), verbatim: the jailed
#      Claude stopped and disabled, no process of the worker user): the dedicated clone synced as the automatic start's
#      step 5 and imagefirst-worker.ts --precheck as the worker, outside the jail, with this id as the grant. Only exit 0
#      with exactly {"status":"would_run","code":null,"invoked":false,"approval_id":<id>,"expires_at":<UTC>Z} and at least
#      20 min left is accepted; the marker then carries that expiry.
#      While Remote Control (or anything of the worker user) runs, which is the usual case, NOTHING runs as the worker
#      (the same rule as every other root script: no worker-controlled code outside the jail while the jail's processes
#      live): the marker gets the packet's own expiry (else now + 24 h, with a note) and every check is made at run time,
#      with Remote Control stopped and the worker's clone pinned to root's verified commit:
#      the pilot's preflight (the worker's precheck for this id, the 20 min rule, no prior run), then the worker's own
#      checks and claim. The marker names only the id the owner typed; it grants nothing the packet does not.
#   7. the marker written atomically (a temporary file in the same directory, 0644 root's, renamed over the old one) as
#      exactly {"approval_id": "<id>", "expires_at": "<UTC>Z"}
#
# Output: fixed lines; the last line is machine-readable:
#   IMAGEFIRST_APPROVE <CODE> approval=<id|none> exit=<n>
# Exit: 0 recorded (APPROVE_RECORDED: checked by the worker's precheck; APPROVE_RECORDED_DEFERRED: checked at run time),
#       2 refused (usage, id, switch, marker, admin clone, the old automatic start, used / attempted, the precheck's line),
#       10 the worker would not run this id now (not approved, expired, a pin, the ledger, ...), 11 locked,
#       20 the worker's clone or the admin clone could not be checked (fetch / git / npm), 40 / 41 signal / internal.
#
# The whole script is one { ... } block, so bash has read all of it before it starts.
{
set -euo pipefail

# Restart with an allowlisted environment (marked by an argument, not a variable).
if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in PATH LANG TZ HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy \
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SR_IMAGEFIRST_APPROVE_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec /usr/bin/env -i "${keep[@]}" /bin/bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
umask 077
cd /

# ---------------------------------------------------------------- limits (every step is cut by timeout(1))
KILL_AFTER=30
FETCH_TIMEOUT=180
GIT_TIMEOUT=60
PRECHECK_TIMEOUT=300
NPM_TIMEOUT=900
MAX_WINDOW=86400
# the pilot's preflight asks for 20 min of the approval left
MIN_LEFT_SECONDS=1200
GRANT_ENV=SR_IMAGEFIRST_EXPECT_APPROVAL_ID

APPROVAL=none
FINISHED=0
WORK=""
TMP_MARKER=""

say() { printf 'imagefirst-approve: %s\n' "$*"; }
finish() {
  local code="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  [ -z "$WORK" ] || rm -rf "$WORK"
  [ -z "$TMP_MARKER" ] || rm -f -- "$TMP_MARKER"
  printf 'IMAGEFIRST_APPROVE %s approval=%s exit=%s\n' "$code" "$APPROVAL" "$rc"
  exit "$rc"
}
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return
  say "stopped by an unexpected error (exit $rc); no marker was written"
  finish APPROVE_STOP_INTERNAL 41
}
on_signal() { finish APPROVE_STOP_SIGNAL 40; }
trap on_exit EXIT
trap on_signal INT TERM HUP

# ---------------------------------------------------------------- 1. the approval id
[ "$#" -eq 1 ] || { say "usage: imagefirst-approve.sh <approval id>"; finish APPROVE_USAGE 2; }
[[ "$1" =~ ^hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}$ ]] || { say "APPROVE_ID_INVALID: expected hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN"; finish APPROVE_ID_INVALID 2; }
APPROVAL="$1"
[[ "$APPROVAL" != hoshigama-imagefirst-d[34]-00000000-* ]] || { say "APPROVE_ID_RESERVED: the date 00000000 is the dummy PoC's, never a real run's"; finish APPROVE_ID_RESERVED 2; }

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
TEST_ROOT="${SR_IMAGEFIRST_APPROVE_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || { say "APPROVE_TEST_HOOK_REFUSED: test hooks are refused in $PROD_CLONE"; finish APPROVE_USAGE 2; }
  [ "$(id -u)" = 0 ] || { say "run as root: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-approve.sh <approval id>"; finish APPROVE_USAGE 2; }
  R=""
  WORKER_USER=sr-designgen
  FILE_ROOT=root
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  WORKER_PATH=/usr/local/bin:/usr/bin:/bin
  ADMIN_GIT="$REPO"
else
  # Any other copy runs only the unit tests' fake WSL (tests/unit/design-agent/imagefirst-worker/approve.test.ts).
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || { say "run from the root-only clone: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-approve.sh <approval id>"; finish APPROVE_USAGE 2; }
  R="$TEST_ROOT"
  WORKER_USER="$(id -un)"
  FILE_ROOT="$(id -un)"
  WORKER_PATH="$PATH"
  # the test world's stand-in for root's admin clone
  ADMIN_GIT="$R$PROD_CLONE"
fi
ETC="$R/etc/sr-design-worker"
SWITCH="$ETC/imagefirst-autostart.json"
MARKER="$ETC/imagefirst-run.json"
STATE="$R/var/lib/sr-imagefirst-autostart"
CYCLE_STATE="$R/var/lib/sr-design-cycle"
WORKER_HOME="$R/home/sr-designgen"
CLONE="$WORKER_HOME/imagefirst/second-root"
NPM_HASH_FILE=.local/state/sr-design-worker/imagefirst-autostart.npm-lock.sha256

now() {
  if [ -n "$R" ] && [ -f "$R/clock" ]; then cat "$R/clock"; else date +%s; fi
}
in_clone() { "${AS_WORKER[@]}" "$@" 7>&- 8>&- 9>&-; }

# The file and every directory above it owned by root and writable by nobody else (as cycle.sh / admin.sh).
# (Verbatim from the automatic start.)
trusted_path() {
  local p
  p="$(readlink -f "$1")" || return 1
  while :; do
    [ "$(stat -c %u "$p")" = 0 ] || return 1
    [ $(( 0$(stat -c %a "$p") & 022 )) -eq 0 ] || return 1
    [ "$p" = / ] && return 0
    p="$(dirname "$p")"
  done
}
# An owner file: a regular file (not a link), root's (the test world: this user's), writable by nobody else, small.
# (Verbatim from the automatic start.)
owner_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %s "$1")" -le 4096 ] || return 1
  if [ -z "$R" ]; then trusted_path "$1"; else
    [ "$(stat -c %U "$1")" = "$FILE_ROOT" ] && [ $(( 0$(stat -c %a "$1") & 022 )) -eq 0 ]
  fi
}

# Busy unless both units are stopped and the worker user runs nothing. Fail closed: an error or any other state is busy.
# (Verbatim from the automatic start; approve.test.ts pins that the two stay identical.)
BUSY_WHY=""
busy() {
  local unit st pg_real=0 pg_eff=0
  for unit in sr-jail-claude.service sr-design-cycle.service; do
    st="$(systemctl show -p ActiveState --value "$unit" 2>/dev/null)" || st=error
    if ! [[ "$st" =~ ^(inactive|failed)$ ]]; then BUSY_WHY="$unit is ${st:-unknown}"; return 0; fi
  done
  # as cycle.sh's DEV-187 grant: the jailed Claude must also be disabled or masked (sr-jail-net's ExecStartPost starts
  # it again while it is enabled). Any other answer, an error or no answer (not-found included) is busy.
  st="$(systemctl is-enabled sr-jail-claude.service 2>/dev/null)" || true
  if ! [[ "$st" =~ ^(disabled|masked)$ ]]; then BUSY_WHY="sr-jail-claude.service is not disabled or masked (${st:-no answer})"; return 0; fi
  # pgrep: 0 = a process (busy), 1 = none, 2+ = error (cannot tell: busy). Only "1" from both checks is idle.
  pgrep -U "$WORKER_USER" >/dev/null 2>&1 || pg_real=$?
  pgrep -u "$WORKER_USER" >/dev/null 2>&1 || pg_eff=$?
  if [ "$pg_real" -ne 1 ] || [ "$pg_eff" -ne 1 ]; then BUSY_WHY="a process of $WORKER_USER is running (or pgrep could not tell)"; return 0; fi
  return 1
}

# A unit that must not start on its own: not active, and not enabled (or not installed at all). Read only.
# (Verbatim from the pilot's preflight.)
UNIT_WHY=""
unit_off() {
  local u="$1" st load en
  st="$(systemctl show -p ActiveState --value "$u" 2>/dev/null)" || st=error
  [[ "$st" =~ ^(inactive|failed)$ ]] || { UNIT_WHY="$u is ${st:-unknown}"; return 1; }
  load="$(systemctl show -p LoadState --value "$u" 2>/dev/null)" || load=error
  [ "$load" != not-found ] || return 0
  en="$(systemctl is-enabled "$u" 2>/dev/null)" || true
  [[ "$en" =~ ^(disabled|masked)$ ]] || { UNIT_WHY="$u is not disabled or masked (${en:-no answer})"; return 1; }
  return 0
}

# The automatic start's parsers of root's own two files, verbatim (no other file is parsed by root here).
SWITCH_PY='
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        d = json.load(f)
except Exception:
    print("INVALID"); sys.exit(0)
if not isinstance(d, dict) or set(d) != {"enabled"} or not isinstance(d["enabled"], bool):
    print("INVALID")
else:
    print("ON" if d["enabled"] else "OFF")
'
MARKER_PY='
import datetime, json, re, sys
path, now, window = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
try:
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
except Exception:
    print("INVALID"); sys.exit(0)
if not isinstance(d, dict) or set(d) != {"approval_id", "expires_at"}:
    print("INVALID"); sys.exit(0)
a, e = d["approval_id"], d["expires_at"]
if not isinstance(a, str) or not re.fullmatch(r"hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}", a, re.ASCII):
    print("INVALID"); sys.exit(0)
if re.match(r"hoshigama-imagefirst-d[34]-00000000-", a, re.ASCII):
    print("INVALID"); sys.exit(0)  # the dummy PoC reserved date: never a real run (PR #308 review L4, PR #309 review N-2)
if not isinstance(e, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", e, re.ASCII):
    print("INVALID"); sys.exit(0)
try:
    t = int(datetime.datetime.strptime(e, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp())
except ValueError:
    print("INVALID"); sys.exit(0)
if t < now:
    print("EXPIRED " + a)
elif t - now > window:
    print("TOO_FAR " + a)
else:
    print("OK " + a)
'

# ---------------------------------------------------------------- 2. the production copy; the admin clone on origin/develop
if [ -z "$R" ]; then
  trusted_path "$SELF" || { say "APPROVE_ADMIN_CLONE_UNTRUSTED: $SELF must be root's and writable by nobody else, up to /"; finish APPROVE_ADMIN_CLONE_UNTRUSTED 2; }
fi
[ -d "$ADMIN_GIT/.git" ] || { say "APPROVE_ADMIN_CLONE_MISSING: $ADMIN_GIT"; finish APPROVE_ADMIN_CLONE_MISSING 2; }
admin_dirty="$(git -C "$ADMIN_GIT" status --porcelain --untracked-files=normal 2>/dev/null)" || admin_dirty="unreadable"
[ -z "$admin_dirty" ] || { say "APPROVE_ADMIN_CLONE_DIRTY: $PROD_CLONE has changes (nothing is cleaned automatically)"; finish APPROVE_ADMIN_CLONE_DIRTY 2; }
timeout --kill-after="$KILL_AFTER" "$FETCH_TIMEOUT" git -C "$ADMIN_GIT" fetch --quiet --no-tags origin "+refs/heads/develop:refs/remotes/origin/develop" >/dev/null 2>&1 ||
  { say "git fetch of the admin clone failed"; finish APPROVE_ADMIN_FETCH 20; }
admin_head="$(git -C "$ADMIN_GIT" rev-parse HEAD 2>/dev/null)" || admin_head=""
admin_base="$(git -C "$ADMIN_GIT" rev-parse origin/develop 2>/dev/null)" || admin_base=""
[[ "$admin_base" =~ ^[0-9a-f]{40}$ ]] || { say "origin/develop is unreadable in the admin clone"; finish APPROVE_ADMIN_FETCH 20; }
if [ "$admin_head" != "$admin_base" ]; then
  say "APPROVE_ADMIN_CLONE_NOT_DEVELOP: the admin clone is at ${admin_head:-?}, origin/develop is $admin_base. Run, then this command again:"
  say "  sudo git -C $PROD_CLONE checkout -q --detach $admin_base"
  finish APPROVE_ADMIN_CLONE_NOT_DEVELOP 2
fi
say "admin clone $PROD_CLONE at $admin_head (clean, = origin/develop)"

# ---------------------------------------------------------------- 2b. the packet for this id, read from root's own admin clone
# Root reads only its own clone (clean, = origin/develop, just verified), at that commit, and checks plain lines with bash
# patterns (no parser): the id's own packet (d3: the p3 packet, d4: the d4 packet) has §10 with 状態 承認済み and this exact
# id in its "<d> の承認 ID" row; its 期限 row, when it is a plain UTC time, is the packet's own expiry. The worker's
# readApprovalPacket stays the real check (at run time, and in the precheck below when the worker user is idle).
case "$APPROVAL" in
  hoshigama-imagefirst-d3-*) PACKET_PATH=docs/design/image-first-hoshigama-p3-packet.md; KEY=d3 ;;
  *) PACKET_PATH=docs/design/image-first-hoshigama-d4-packet.md; KEY=d4 ;;
esac
packet="$(git -C "$ADMIN_GIT" show "$admin_head:$PACKET_PATH" 2>/dev/null)" || packet=""
section="${packet#*$'\n'"## 10. 承認欄"}"
[ -n "$packet" ] && [ "$section" != "$packet" ] || { say "APPROVE_PACKET_MISSING: $PACKET_PATH (with its §10) is not in the admin clone at $admin_head"; finish APPROVE_PACKET_MISSING 2; }
re_id='^\| '"$KEY"' の承認 ID[^|]*\| +`?([a-z0-9-]+)`? +\|$'
re_status='^\| 状態[^|]*\| +`?承認済み`? +\|$'
re_expires='^\| 期限[^|]*\| +`?([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)`? +\|$'
id_ok=0
status_ok=0
PACKET_EXPIRES=""
while IFS= read -r line; do
  [[ "$line" =~ $re_id ]] && [ "${BASH_REMATCH[1]}" = "$APPROVAL" ] && id_ok=1
  [[ "$line" =~ $re_status ]] && status_ok=1
  [[ "$line" =~ $re_expires ]] && PACKET_EXPIRES="${BASH_REMATCH[1]}"
done <<<"$section"
[ "$id_ok" = 1 ] && [ "$status_ok" = 1 ] ||
  { say "APPROVE_PACKET_NO_ID: $PACKET_PATH §10 at $admin_head is not 承認済み for exactly $APPROVAL (merge the approved packet first)"; finish APPROVE_PACKET_NO_ID 2; }
if [ -n "$PACKET_EXPIRES" ]; then
  pexp_s="$(date -u -d "$PACKET_EXPIRES" +%s 2>/dev/null)" || pexp_s=""
  if ! [[ "$pexp_s" =~ ^[0-9]+$ ]]; then PACKET_EXPIRES=""
  elif [ "$pexp_s" -lt "$(now)" ]; then say "APPROVE_PACKET_EXPIRED: the packet's expiry $PACKET_EXPIRES has passed"; finish APPROVE_PACKET_EXPIRED 2
  fi
fi
say "packet $PACKET_PATH at $admin_head: 承認済み for $APPROVAL, expiry ${PACKET_EXPIRES:-unreadable}"

# ---------------------------------------------------------------- 3. the owner's switch must be on
if [ ! -e "$SWITCH" ] && [ ! -L "$SWITCH" ]; then
  say "APPROVE_SWITCH_OFF: the switch is absent, so the automatic run would do nothing. Turn it on (once), then this command again:"
  say "  sudo install -d -o root -g root -m 0755 /etc/sr-design-worker"
  say "  echo '{\"enabled\": true}' | sudo tee /etc/sr-design-worker/imagefirst-autostart.json >/dev/null && sudo chmod 0644 /etc/sr-design-worker/imagefirst-autostart.json"
  finish APPROVE_SWITCH_OFF 2
fi
owner_file "$SWITCH" || { say "APPROVE_SWITCH_UNSAFE: the switch must be a root-owned regular file nobody else can write"; finish APPROVE_SWITCH_UNSAFE 2; }
switch="$(python3 -I -c "$SWITCH_PY" "$SWITCH" 7>&- 8>&- 9>&-)" || switch=INVALID
case "$switch" in
  ON) ;;
  OFF) say "APPROVE_SWITCH_OFF: the switch says enabled:false, so the automatic run would do nothing (set {\"enabled\": true} first)"; finish APPROVE_SWITCH_OFF 2 ;;
  *) say "APPROVE_SWITCH_INVALID: expected exactly {\"enabled\": true|false}"; finish APPROVE_SWITCH_INVALID 2 ;;
esac
if [ -z "$R" ]; then trusted_path "$ETC" || { say "APPROVE_ETC_UNSAFE: $ETC must be root's and writable by nobody else, up to /"; finish APPROVE_ETC_UNSAFE 2; }; fi

# ---------------------------------------------------------------- 4. never with the old hourly automatic start
for u in sr-imagefirst-autostart.timer sr-imagefirst-autostart.service; do
  unit_off "$u" || { say "APPROVE_AUTOSTART_ENABLED: $UNIT_WHY (it reads the same marker and would run the worker without the pilot's audit: disable it first)"; finish APPROVE_AUTOSTART_ENABLED 2; }
done

# ---------------------------------------------------------------- 5. the automatic run's lock; one use per id; no other pending id
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 7>"$STATE/autorun.lock"
flock -n 7 || { say "an automatic run is in progress; nothing done"; finish APPROVE_LOCKED 11; }
WORK="$(mktemp -d "$STATE/approve.XXXXXX")"
if [ -e "$STATE/used/$APPROVAL" ] || [ -L "$STATE/used/$APPROVAL" ]; then
  say "APPROVE_USED: $APPROVAL was already used (root's used/$APPROVAL): it never runs again; a new packet and id are needed"
  finish APPROVE_USED 2
fi
if [ -e "$STATE/autorun/$APPROVAL" ] || [ -L "$STATE/autorun/$APPROVAL" ]; then
  say "APPROVE_ATTEMPTED: the automatic run already made its one attempt for $APPROVAL (root's autorun/$APPROVAL); it is never repeated"
  finish APPROVE_ATTEMPTED 2
fi
if [ -e "$MARKER" ] || [ -L "$MARKER" ]; then
  owner_file "$MARKER" || { say "APPROVE_MARKER_UNSAFE: the current run marker is not a root-owned regular file nobody else can write: look at it first"; finish APPROVE_MARKER_UNSAFE 2; }
  current="$(python3 -I -c "$MARKER_PY" "$MARKER" "$(now)" "$MAX_WINDOW" 7>&- 8>&- 9>&-)" || current=INVALID
  case "$current" in
    "OK $APPROVAL" | "TOO_FAR $APPROVAL" | "EXPIRED "*) ;;
    "OK "* | "TOO_FAR "*)
      other="${current#* }"
      if [ ! -e "$STATE/used/$other" ] && [ ! -L "$STATE/used/$other" ] && [ ! -e "$STATE/autorun/$other" ] && [ ! -L "$STATE/autorun/$other" ]; then
        say "APPROVE_OTHER_PENDING: the run marker names $other, not used or attempted yet: remove it first (sudo rm /etc/sr-design-worker/imagefirst-run.json) if it is no longer wanted"
        finish APPROVE_OTHER_PENDING 2
      fi ;;
    *) say "APPROVE_MARKER_INVALID: the current run marker is not in the expected form: look at it first"; finish APPROVE_MARKER_INVALID 2 ;;
  esac
fi

# ---------------------------------------------------------------- 6. the worker's own precheck, only when the worker user is idle
CODE=APPROVE_RECORDED_DEFERRED
EXPIRES=""
if busy; then
  say "the worker user is busy ($BUSY_WHY): nothing runs as the worker now; every check is made at run time, with Remote Control stopped"
  if [ -n "$PACKET_EXPIRES" ] && [ $((pexp_s - $(now))) -le "$MAX_WINDOW" ]; then
    EXPIRES="$PACKET_EXPIRES"
  else
    EXPIRES="$(date -u -d "@$(( $(now) + MAX_WINDOW ))" +%Y-%m-%dT%H:%M:%SZ)"
    say "note: the packet's expiry is ${PACKET_EXPIRES:-unreadable}${PACKET_EXPIRES:+ (more than 24 h ahead)}: the marker gets now + 24 h; the worker keeps the packet's own expiry"
  fi
else
  # the automatic start's and the pilot's locks: no poll, pilot or cycle uses the worker's clone meanwhile
  exec 9>"$STATE/autostart.lock"
  flock -n 9 || { say "busy: an automatic start poll or a pilot holds its lock"; finish APPROVE_LOCKED 11; }
  if [ -d "$CYCLE_STATE" ] && [ ! -L "$CYCLE_STATE" ]; then
    exec 8>>"$CYCLE_STATE/cycle.lock"
    flock -n 8 || { say "busy: a design cycle holds its lock"; finish APPROVE_LOCKED 11; }
  fi
  worker_uid="$(id -u "$WORKER_USER")" && worker_gid="$(id -g "$WORKER_USER")" || { say "APPROVE_STOP_NO_USER: $WORKER_USER"; finish APPROVE_STOP_NO_USER 20; }
  AS_WORKER=(setpriv --reuid="$worker_uid" --regid="$worker_gid" --init-groups --reset-env --no-new-privs -- env -i HOME="$WORKER_HOME" PATH="$WORKER_PATH" LANG=C.UTF-8)
  for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
    if [ -n "${!name+x}" ]; then AS_WORKER+=("$name=${!name}"); fi
  done
  AS_WORKER+=(bash -c 'cd -- "$1" || exit 97; shift; exec "$@"' _ "$CLONE")
  [ -d "$CLONE" ] || { say "APPROVE_STOP_NO_CLONE: $CLONE is missing"; finish APPROVE_STOP_NO_CLONE 20; }
  # the automatic start's step 5 (as the worker): fetch, clean, a fast-forward onto origin/develop, npm ci only for a new lock
  in_clone timeout --kill-after="$KILL_AFTER" "$FETCH_TIMEOUT" git fetch --quiet --no-tags origin "+refs/heads/develop:refs/remotes/origin/develop" >/dev/null 2>&1 ||
    { say "git fetch failed"; finish APPROVE_STOP_FETCH 20; }
  dirty="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git status --porcelain --untracked-files=all 2>/dev/null)" ||
    { say "git status failed"; finish APPROVE_STOP_GIT 20; }
  [ -z "$dirty" ] || { say "the worker's clone has changes (nothing is cleaned automatically)"; finish APPROVE_STOP_TREE_DIRTY 20; }
  in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git merge-base --is-ancestor HEAD origin/develop >/dev/null 2>&1 ||
    { say "HEAD is not an ancestor of origin/develop"; finish APPROVE_STOP_NOT_FAST_FORWARD 20; }
  in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git checkout --quiet --detach origin/develop >/dev/null 2>&1 ||
    { say "git checkout failed"; finish APPROVE_STOP_GIT 20; }
  head="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse HEAD 2>/dev/null)" || head=""
  base="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse origin/develop 2>/dev/null)" || base=""
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] && [ "$head" = "$base" ] || { say "HEAD is not origin/develop after the checkout"; finish APPROVE_STOP_GIT 20; }
  in_clone bash -c 'h="$(sha256sum package-lock.json | cut -d" " -f1)" || exit 1
  [ -f node_modules/tsx/package.json ] && [ "$(cat "$HOME/$1" 2>/dev/null || true)" = "$h" ] && exit 0
  timeout --kill-after="$2" "$3" npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || exit 1
  mkdir -p "$(dirname "$HOME/$1")" && printf "%s\n" "$h" >"$HOME/$1"' _ "$NPM_HASH_FILE" "$KILL_AFTER" "$NPM_TIMEOUT" ||
    { say "npm ci failed"; finish APPROVE_STOP_NPM 20; }
  set +e
  "${AS_WORKER[@]}" timeout --foreground --kill-after="$KILL_AFTER" "$PRECHECK_TIMEOUT" env "$GRANT_ENV=$APPROVAL" \
    node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --precheck >"$WORK/precheck" 2>/dev/null 7>&- 8>&- 9>&-
  prc=$?
  set -e
  pline="$(tail -n 1 "$WORK/precheck" | tr -d '\000-\037' | cut -c1-2000)"
  say "precheck: ${pline:-<no line>}"
  case "$prc" in
    0) ;;
    2 | 3) say "the worker would not run $APPROVAL now (not approved yet, expired, another approval id, a pin, the ledger, ...): no marker"
      finish APPROVE_NOT_RUNNABLE 10 ;;
    *) say "the precheck did not answer (exit $prc): no marker"; finish APPROVE_STOP_PRECHECK 20 ;;
  esac
  # exactly one line, exactly this shape and this id (the worker's own JSON.stringify order); the expiry then checked below
  lines="$(wc -l <"$WORK/precheck")"
  re='^\{"status":"would_run","code":null,"invoked":false,"approval_id":"(hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2})","expires_at":"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)"\}$'
  if [ "$lines" != 1 ] || ! [[ "$pline" =~ $re ]] || [ "${BASH_REMATCH[1]}" != "$APPROVAL" ]; then
    say "APPROVE_PRECHECK_UNEXPECTED: not exactly {\"status\":\"would_run\",...,\"approval_id\":\"$APPROVAL\",\"expires_at\":\"<UTC>Z\"}: no marker"
    finish APPROVE_PRECHECK_UNEXPECTED 2
  fi
  EXPIRES="${BASH_REMATCH[2]}"
  # the worker's answer must agree with the packet root read from its own clone
  if [ -n "$PACKET_EXPIRES" ] && [ "$EXPIRES" != "$PACKET_EXPIRES" ]; then
    say "APPROVE_PRECHECK_UNEXPECTED: the worker reports the expiry $EXPIRES, the packet at $admin_head says $PACKET_EXPIRES: no marker"
    finish APPROVE_PRECHECK_UNEXPECTED 2
  fi
  CODE=APPROVE_RECORDED
fi

# ---------------------------------------------------------------- 7. the marker, atomically (checked by the automatic start's own parser first)
TMP_MARKER="$(mktemp "$ETC/.imagefirst-run.json.XXXXXX")"
printf '{"approval_id": "%s", "expires_at": "%s"}\n' "$APPROVAL" "$EXPIRES" >"$TMP_MARKER"
checked="$(python3 -I -c "$MARKER_PY" "$TMP_MARKER" "$(now)" "$MAX_WINDOW" 7>&- 8>&- 9>&-)" || checked=INVALID
[ "$checked" = "OK $APPROVAL" ] || { say "APPROVE_EXPIRY_INVALID: the expiry $EXPIRES is past, unreadable or more than 24 h ahead: no marker"; finish APPROVE_EXPIRY_INVALID 2; }
exp_s="$(date -u -d "$EXPIRES" +%s)"
if [ $((exp_s - $(now))) -lt "$MIN_LEFT_SECONDS" ]; then
  say "APPROVE_TOO_LATE: under $((MIN_LEFT_SECONDS / 60)) min of the approval left (the pilot's preflight would refuse): no marker"
  finish APPROVE_TOO_LATE 2
fi
chmod 0644 "$TMP_MARKER"
mv -f -T -- "$TMP_MARKER" "$MARKER"
TMP_MARKER=""
say "the run marker is written: $APPROVAL until $EXPIRES (the automatic run picks it up within about 10 minutes, once)"
if [ "$CODE" = APPROVE_RECORDED_DEFERRED ]; then say "not checked by the worker now (Remote Control is up): the pilot's preflight checks it with Remote Control stopped"; fi
u=sr-imagefirst-autorun.timer
en="$(systemctl is-enabled "$u" 2>/dev/null)" || true
[ "$en" = enabled ] || say "note: $u is not enabled (${en:-no answer}): nothing runs until the owner installs and enables it (docs/operations/imagefirst-autorun.md)"
finish "$CODE" 0
}
