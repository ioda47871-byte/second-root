#!/usr/bin/env bash
# Second Root IMAGE_FIRST automatic start (Issue #302 P1): pull model, OFF by default, at most ONE owner-approved
# ほし窯 d3 (or d4, with its own packet) run per root-owned one-use marker. It starts the EXISTING worker (scripts/sales-design-worker/imagefirst-worker.ts)
# once; it has no runner, approval parser or retry of its own.
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autostart.sh
#
# Run by root, only from the root-only admin clone (/root/sr-capture-admin, the same clone as cycle.sh), by a person
# or from sr-imagefirst-autostart.service. That unit and its timer are NOT installed or enabled by anything in this
# repository (docs/operations/imagefirst-worker-port.md §7). Root never runs git, node or a parser on files the worker
# user controls: every command in the worker's clone runs as the worker user, as in cycle.sh. The privileges are dropped
# with setpriv, which execs the command (no supervising parent, unlike runuser, which SIGKILLs its child 2 s after
# passing on a SIGTERM): a stop signal reaches timeout(1) and the worker directly, and the worker has its full 50 s
# + 10 s to write its receipt.
#
# One poll, in this order; anything unexpected stops it before the marker is used (never retried, never relaxed):
#   1. the owner's switch /etc/sr-design-worker/imagefirst-autostart.json (root's, {"enabled": true}). Absent or
#      {"enabled": false}: OFF, exit 0, nothing touched (not even this script's state directory)
#   2. this script's lock (one poll at a time; a second one: exit 11)
#   3. the owner's one-use run marker /etc/sr-design-worker/imagefirst-run.json (root's,
#      {"approval_id": "hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN", "expires_at": "<UTC>Z"}, at most 24 h ahead; the id's
#      direction selects the worker's allowlist row and packet, run-directions.ts); missing,
#      expired or already used (root's state used/<approval id>, never removed): idle, exit 10
#   4. mutual exclusion: sr-jail-claude.service and sr-design-cycle.service stopped (inactive / failed; anything else,
#      an error included, is busy), sr-jail-claude.service also disabled or masked (as cycle.sh's DEV-187 grant: when it
#      is enabled, sr-jail-net starts it again), no process of the worker user, and cycle.sh's own lock held by this poll:
#      else exit 12
#   5. as the worker: git fetch origin develop in the dedicated clone (failure: stop, exit 20), the tree clean, HEAD an
#      ancestor of origin/develop, detach onto origin/develop (a fast-forward; never --force, never clean), npm ci only
#      when package-lock.json changed (as run.sh)
#   6. the worker's own precheck (imagefirst-worker.ts --precheck, as the worker, with the marker's approval id): every
#      check of its cycle up to, not including, the claim, writing nothing. Not "would run" (not approved, expired, a pin
#      mismatch, another approval id, used in the ledger, ...): idle, exit 10, the marker unused. No parser of its own
#   7. mutual exclusion again, then the marker is used up (atomic mkdir in root's 0700 state; the worker user can
#      neither create nor remove it), then the worker runs ONCE as the worker user with the marker's approval id in
#      SR_IMAGEFIRST_EXPECT_APPROVAL_ID (the worker refuses any other approval: APPROVAL_NOT_GRANTED)
# A stop signal after step 7 is passed on to the worker and the poll waits for it: the worker ends with its receipt
# (WORKER_INTERRUPTED) and audit line. Whatever the worker returns, the marker stays used and nothing is retried.
#
# Output: fixed lines and codes; the worker's one JSON line. The last line is machine-readable:
#   IMAGEFIRST_AUTOSTART <CODE> phase=<before_claim|after_claim> approval=<id|none> exit=<n>
# Exit: 0 off / ran (see the worker line), 10 idle (also a worker no_job after the marker: AUTOSTART_USED_NO_JOB),
#       11 locked, 12 busy, 20 stopped before the marker (environment),
#       2 refused (unsafe or invalid switch / marker, usage) or the worker refused, 1 the worker stopped, 40/41 signal / internal.
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
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SR_IMAGEFIRST_AUTOSTART_TEST_ROOT; do
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
# the worker's precheck: git reads, the plan rebuilt, the ledger read; no call
PRECHECK_TIMEOUT=300
NPM_TIMEOUT=900
# the worker: the entry's 20 min watchdog + 2 min margin + 35 s grace + the receipt (imagefirst-worker.ts)
WORKER_TIMEOUT=1800
# a stopped worker gets more than its own 50 s hard stop + 10 s receipt (cycle.ts WORKER_STOP) before SIGKILL
WORKER_KILL_AFTER=90
MAX_WINDOW=86400
# No packet path here: the worker picks the packet from the approval id's direction (run-directions.ts: d3 → the p3
# packet, d4 → the d4 packet). Do not wire a fixed packet path into this script (PR #320 review L1).
GRANT_ENV=SR_IMAGEFIRST_EXPECT_APPROVAL_ID

PHASE=before_claim
APPROVAL=none
FINISHED=0
LOCKED=0
INTERRUPTED=0
WPID=""
WORK=""

say() { printf 'imagefirst-autostart: %s\n' "$*"; }
finish() {
  local code="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  [ -z "$WORK" ] || rm -rf "$WORK"
  printf 'IMAGEFIRST_AUTOSTART %s phase=%s approval=%s exit=%s\n' "$code" "$PHASE" "$APPROVAL" "$rc"
  exit "$rc"
}
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return
  say "stopped by an unexpected error (exit $rc)"
  finish AUTOSTART_STOP_INTERNAL 41
}
on_signal() {
  # after the marker: pass the stop on to the worker and wait for its receipt (below); before it: stop here
  if [ "$PHASE" = after_claim ]; then
    INTERRUPTED=1
    [ -z "$WPID" ] || kill -TERM "$WPID" 2>/dev/null || true
    return 0
  fi
  finish AUTOSTART_STOP_SIGNAL 40
}
trap on_exit EXIT
trap on_signal INT TERM HUP

[ "$#" -eq 0 ] || { say "usage: imagefirst-autostart.sh (no arguments)"; finish AUTOSTART_USAGE 2; }

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
TEST_ROOT="${SR_IMAGEFIRST_AUTOSTART_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || { say "AUTOSTART_TEST_HOOK_REFUSED: test hooks are refused in $PROD_CLONE"; finish AUTOSTART_USAGE 2; }
  [ "$(id -u)" = 0 ] || { say "run as root: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-autostart.sh"; finish AUTOSTART_USAGE 2; }
  R=""
  WORKER_USER=sr-designgen
  FILE_ROOT=root
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  WORKER_PATH=/usr/local/bin:/usr/bin:/bin
else
  # Any other copy runs only the unit tests' fake WSL (tests/unit/design-agent/imagefirst-worker/autostart.test.ts).
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || { say "run from the root-only clone: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-autostart.sh"; finish AUTOSTART_USAGE 2; }
  R="$TEST_ROOT"
  WORKER_USER="$(id -un)"
  FILE_ROOT="$(id -un)"
  WORKER_PATH="$PATH"
fi
SWITCH="$R/etc/sr-design-worker/imagefirst-autostart.json"
MARKER="$R/etc/sr-design-worker/imagefirst-run.json"
STATE="$R/var/lib/sr-imagefirst-autostart"
CYCLE_STATE="$R/var/lib/sr-design-cycle"
WORKER_HOME="$R/home/sr-designgen"
CLONE="$WORKER_HOME/imagefirst/second-root"
NPM_HASH_FILE=.local/state/sr-design-worker/imagefirst-autostart.npm-lock.sha256

now() {
  if [ -n "$R" ] && [ -f "$R/clock" ]; then cat "$R/clock"; else date +%s; fi
}

# The worker user's own commands, in its clone, with an allowlisted environment (root never runs git or node there).
# AS_WORKER is a plain command prefix of programs that each exec the next (setpriv → env → bash → the command): no
# function, no subshell and no supervising parent, so the worker run below, started in the background, IS the timeout(1)
# process, and a stop signal sent to it reaches the worker. (The test world's PATH carries a stand-in setpriv.)
in_clone() { "${AS_WORKER[@]}" "$@" 8>&- 9>&-; }

# The file and every directory above it owned by root and writable by nobody else (as cycle.sh / admin.sh).
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
owner_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %s "$1")" -le 4096 ] || return 1
  if [ -z "$R" ]; then trusted_path "$1"; else
    [ "$(stat -c %U "$1")" = "$FILE_ROOT" ] && [ $(( 0$(stat -c %a "$1") & 022 )) -eq 0 ]
  fi
}

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

# Busy unless both units are stopped and the worker user runs nothing. Fail closed: an error or any other state is busy.
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

# ---------------------------------------------------------------- 1. the owner's switch (absent = OFF: nothing touched)
if [ ! -e "$SWITCH" ] && [ ! -L "$SWITCH" ]; then
  say "the switch is absent: OFF"
  finish AUTOSTART_OFF 0
fi
owner_file "$SWITCH" || { say "AUTOSTART_SWITCH_UNSAFE: the switch must be a root-owned regular file nobody else can write"; finish AUTOSTART_SWITCH_UNSAFE 2; }
switch="$(python3 -I -c "$SWITCH_PY" "$SWITCH" 8>&- 9>&-)" || switch=INVALID
case "$switch" in
  ON) ;;
  OFF) say "the switch says enabled:false: OFF"; finish AUTOSTART_OFF 0 ;;
  *) say "AUTOSTART_SWITCH_INVALID: expected exactly {\"enabled\": true|false}"; finish AUTOSTART_SWITCH_INVALID 2 ;;
esac

# ---------------------------------------------------------------- 2. one poll at a time
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/autostart.lock"
if ! flock -n 9; then
  say "another poll is running; nothing done"
  finish AUTOSTART_LOCKED 11
fi
LOCKED=1
WORK="$(mktemp -d "$STATE/run.XXXXXX")"

# ---------------------------------------------------------------- 3. the owner's one-use run marker
if [ ! -e "$MARKER" ] && [ ! -L "$MARKER" ]; then
  say "no run marker: nothing to do"
  finish AUTOSTART_IDLE_NO_MARKER 10
fi
owner_file "$MARKER" || { say "AUTOSTART_MARKER_UNSAFE: the run marker must be a root-owned regular file nobody else can write"; finish AUTOSTART_MARKER_UNSAFE 2; }
marker="$(python3 -I -c "$MARKER_PY" "$MARKER" "$(now)" "$MAX_WINDOW" 8>&- 9>&-)" || marker=INVALID
case "$marker" in
  "OK "*) APPROVAL="${marker#OK }" ;;
  "EXPIRED "*) APPROVAL="${marker#EXPIRED }"; say "the run marker has expired: nothing to do"; finish AUTOSTART_IDLE_MARKER_EXPIRED 10 ;;
  "TOO_FAR "*) APPROVAL="${marker#TOO_FAR }"; say "AUTOSTART_MARKER_TOO_FAR: expires_at more than 24 h ahead"; finish AUTOSTART_MARKER_INVALID 2 ;;
  *) say "AUTOSTART_MARKER_INVALID: expected exactly {\"approval_id\": \"hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN\", \"expires_at\": \"<UTC>Z\"}"; finish AUTOSTART_MARKER_INVALID 2 ;;
esac
if [ -e "$STATE/used/$APPROVAL" ] || [ -L "$STATE/used/$APPROVAL" ]; then
  say "the run marker was already used: nothing to do"
  finish AUTOSTART_IDLE_MARKER_USED 10
fi

# ---------------------------------------------------------------- 4. mutual exclusion
if busy; then say "busy: $BUSY_WHY"; finish AUTOSTART_BUSY 12; fi
# cycle.sh's own lock, held for the whole poll (a cycle started by hand meanwhile stops at CYCLE_LOCKED)
if [ -d "$CYCLE_STATE" ] && [ ! -L "$CYCLE_STATE" ]; then
  exec 8>>"$CYCLE_STATE/cycle.lock"
  flock -n 8 || { say "busy: a design cycle holds its lock"; finish AUTOSTART_BUSY 12; }
fi

# ---------------------------------------------------------------- 5. the dedicated clone on origin/develop (as the worker)
worker_uid="$(id -u "$WORKER_USER")" && worker_gid="$(id -g "$WORKER_USER")" || { say "AUTOSTART_STOP_NO_USER: $WORKER_USER"; finish AUTOSTART_STOP_NO_USER 20; }
AS_WORKER=(setpriv --reuid="$worker_uid" --regid="$worker_gid" --init-groups --reset-env --no-new-privs -- env -i HOME="$WORKER_HOME" PATH="$WORKER_PATH" LANG=C.UTF-8)
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
  if [ -n "${!name+x}" ]; then AS_WORKER+=("$name=${!name}"); fi
done
AS_WORKER+=(bash -c 'cd -- "$1" || exit 97; shift; exec "$@"' _ "$CLONE")
[ -d "$CLONE" ] || { say "AUTOSTART_STOP_NO_CLONE: $CLONE is missing"; finish AUTOSTART_STOP_NO_CLONE 20; }
in_clone timeout --kill-after="$KILL_AFTER" "$FETCH_TIMEOUT" git fetch --quiet --no-tags origin "+refs/heads/develop:refs/remotes/origin/develop" >/dev/null 2>&1 ||
  { say "git fetch failed: stopped before the marker"; finish AUTOSTART_STOP_FETCH 20; }
dirty="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git status --porcelain --untracked-files=all 2>/dev/null)" ||
  { say "git status failed: stopped before the marker"; finish AUTOSTART_STOP_GIT 20; }
[ -z "$dirty" ] || { say "the clone has changes: stopped before the marker (nothing is cleaned automatically)"; finish AUTOSTART_STOP_TREE_DIRTY 20; }
in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git merge-base --is-ancestor HEAD origin/develop >/dev/null 2>&1 ||
  { say "HEAD is not an ancestor of origin/develop: stopped before the marker"; finish AUTOSTART_STOP_NOT_FAST_FORWARD 20; }
in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git checkout --quiet --detach origin/develop >/dev/null 2>&1 ||
  { say "git checkout failed: stopped before the marker"; finish AUTOSTART_STOP_GIT 20; }
head="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse HEAD 2>/dev/null)" || head=""
base="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse origin/develop 2>/dev/null)" || base=""
[[ "$head" =~ ^[0-9a-f]{40}$ ]] && [ "$head" = "$base" ] || { say "HEAD is not origin/develop after the checkout: stopped before the marker"; finish AUTOSTART_STOP_GIT 20; }
# npm ci only when package-lock.json changed (as run.sh; the hash is the worker's own state)
in_clone bash -c 'h="$(sha256sum package-lock.json | cut -d" " -f1)" || exit 1
  [ -f node_modules/tsx/package.json ] && [ "$(cat "$HOME/$1" 2>/dev/null || true)" = "$h" ] && exit 0
  timeout --kill-after="$2" "$3" npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || exit 1
  mkdir -p "$(dirname "$HOME/$1")" && printf "%s\n" "$h" >"$HOME/$1"' _ "$NPM_HASH_FILE" "$KILL_AFTER" "$NPM_TIMEOUT" ||
  { say "npm ci failed: stopped before the marker"; finish AUTOSTART_STOP_NPM 20; }

# ---------------------------------------------------------------- 6. the worker's own precheck (nothing used, nothing written)
set +e
"${AS_WORKER[@]}" timeout --foreground --kill-after="$KILL_AFTER" "$PRECHECK_TIMEOUT" env "$GRANT_ENV=$APPROVAL" \
  node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --precheck >"$WORK/precheck" 2>/dev/null 8>&- 9>&-
prc=$?
set -e
pline="$(tail -n 1 "$WORK/precheck" | tr -d '\000-\037' | cut -c1-2000)"
say "precheck: ${pline:-<no line>}"
case "$prc" in
  0) ;;
  2 | 3) say "the worker would not run now (not approved yet, expired, another approval id, a pin, the ledger, ...): nothing to do, the marker stays unused"
    finish AUTOSTART_IDLE_NOT_RUNNABLE 10 ;;
  *) say "the precheck did not answer (exit $prc): stopped before the marker"; finish AUTOSTART_STOP_PRECHECK 20 ;;
esac

# ---------------------------------------------------------------- 7. the marker is used up, then ONE worker run
if busy; then say "busy: $BUSY_WHY"; finish AUTOSTART_BUSY 12; fi
mkdir -p -m 0700 "$STATE/used"
if ! mkdir -m 0700 "$STATE/used/$APPROVAL" 2>/dev/null; then
  say "the run marker was already used: nothing to do"
  finish AUTOSTART_IDLE_MARKER_USED 10
fi
printf 'approval_id=%s\ncommit=%s\nused_at=%s\n' "$APPROVAL" "$head" "$(now)" >"$STATE/used/$APPROVAL/used"
PHASE=after_claim
say "the run marker is used up (approval $APPROVAL, commit $head); starting the worker once"

set +e
# node with the tsx loader is timeout's direct child, and timeout --foreground signals only that child: one stop is one
# SIGTERM to the worker (the tsx CLI would relay it again within 30 ms, and the worker would take it as a hard stop).
# The worker starts the entry in its own process group and stops it itself.
"${AS_WORKER[@]}" timeout --foreground --kill-after="$WORKER_KILL_AFTER" "$WORKER_TIMEOUT" env "$GRANT_ENV=$APPROVAL" \
  node --import tsx scripts/sales-design-worker/imagefirst-worker.ts >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &
WPID=$!
wait "$WPID"
rc=$?
# a stop signal interrupts wait (rc > 128) while the worker still writes its receipt: wait for it to end
while [ "$rc" -gt 128 ] && kill -0 "$WPID" 2>/dev/null; do
  wait "$WPID"
  rc=$?
done
set -e
WPID=""
line="$(tail -n 1 "$WORK/out" | tr -d '\000-\037' | cut -c1-2000)"
say "worker: ${line:-<no line>}"
if [ "$rc" -ne 0 ]; then
  tail -n 20 "$WORK/err" | tr -d '\000-\010\013-\037' | cut -c1-300 | sed 's/^/imagefirst-autostart: worker stderr: /'
fi
if [ "$INTERRUPTED" = 1 ]; then finish AUTOSTART_INTERRUPTED 1; fi
case "$rc" in
  0) if [[ "$line" == *'"status":"no_job"'* ]]; then
       say "the worker found no job after the marker was used (the packet changed in between?); the marker stays used"
       finish AUTOSTART_USED_NO_JOB 10
     fi
     if [[ "$line" == *'"status":"locked"'* ]]; then
       say "the worker's own lock was held after the marker was used (a run by hand?); nothing was called, the marker stays used"
       finish AUTOSTART_USED_LOCKED 10
     fi
     finish AUTOSTART_RAN 0 ;;
  2) finish AUTOSTART_WORKER_REFUSED 2 ;;
  124 | 137) finish AUTOSTART_WORKER_TIMEOUT 1 ;;
  *) finish AUTOSTART_WORKER_STOPPED 1 ;;
esac
}
