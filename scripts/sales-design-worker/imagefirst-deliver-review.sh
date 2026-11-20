#!/usr/bin/env bash
# Second Root IMAGE_FIRST review re-send (Issue #302 P3 follow-up, PR #310 review H1 / M3): root's wrapper that re-sends
# the SAME sealed private bundle of ONE finished run to the local review inbox (~/sr-runs/review-inbox) after the
# automatic hand-off at the end of the worker run failed. It starts the EXISTING worker CLI once in its re-send mode
# (imagefirst-worker.ts --deliver-review <approval id>: no cycle, no claim, no ledger, no Codex; packs only the first time when nothing was sealed or sent, never a second time).
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-deliver-review.sh <approval id>
#
# Why a root wrapper: `admin.sh run` executes inside the jail (no /run, its own network namespace), where systemctl
# cannot see systemd, and the worker user has no login shell. So root checks the mutual exclusion here, with the
# automatic start's own busy() (copied verbatim; a test pins that it stays identical), and then drops to the worker
# user OUTSIDE the jail with the same setpriv command as the automatic start (no supervising parent).
#
# Run by root, only from the root-only admin clone (/root/sr-capture-admin), by a person. Nothing installs, enables or
# schedules it (no unit, no timer). Root never runs git, node or a parser on files the worker user controls: every
# command in the worker's clone runs as the worker user. In this order; anything unexpected stops it, nothing is retried:
#   1. exactly one argument, a ほし窯 d3 approval id (hoshigama-imagefirst-d3-YYYYMMDD-NN), never the dummy PoC's
#      reserved date 00000000
#   2. the automatic start's lock and cycle.sh's lock, both held for the whole re-send (no poll or cycle starts meanwhile)
#   3. busy() (as the automatic start): sr-jail-claude.service and sr-design-cycle.service inactive / failed,
#      sr-jail-claude.service disabled or masked, and no process of the worker user, which also means nobody holds the
#      worker's own lock (a lock left by a killed worker is stale; the worker clears it when it takes the lock itself)
#   4. as the worker: its dedicated clone (~/imagefirst/second-root, the one the worker runs from) clean, and HEAD =
#      origin/develop (read only: no fetch, no checkout; run the automatic start's step 5 or update it by hand first)
#   5. busy() again, then the worker CLI ONCE as the worker user: --deliver-review <approval id> (it checks everything
#      again itself: HEAD and a clean tree, the jail state, the receipt against the packet at its commit, the commit on
#      origin/develop, its own claim marker, the sealed bundle. It packs only the first time, when the automatic hand-off
#      stopped before sealing and nothing was ever sealed or sent for the approval; otherwise never: SEALED_BUNDLE_MISSING)
#
# Output: fixed lines; the worker's one JSON line. The last line is machine-readable:
#   IMAGEFIRST_DELIVER_REVIEW <CODE> approval=<id|none> exit=<n>
# Exit: 0 delivered (or already there: duplicate), 1 not delivered (the bundle stays sealed: run it again later), the
#       worker stopped / timed out, or interrupted by a stop signal (DELIVER_INTERRUPTED), 2 usage / refused (by this script or the worker), 12 busy, 20 stopped (environment,
#       clone), 40/41 signal / internal.
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
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SR_IMAGEFIRST_DELIVER_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec /usr/bin/env -i "${keep[@]}" /bin/bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
umask 077
cd /

KILL_AFTER=30
GIT_TIMEOUT=60
# the re-send: verify the sealed bundle, copy it into the inbox, build the previews (seconds); a generous bound
DELIVER_TIMEOUT=600
DELIVER_KILL_AFTER=90

APPROVAL=none
FINISHED=0
STARTED=0
INTERRUPTED=0
WPID=""
WORK=""

say() { printf 'imagefirst-deliver-review: %s\n' "$*"; }
finish() {
  local code="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  [ -z "$WORK" ] || rm -rf "$WORK"
  printf 'IMAGEFIRST_DELIVER_REVIEW %s approval=%s exit=%s\n' "$code" "$APPROVAL" "$rc"
  exit "$rc"
}
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return
  say "stopped by an unexpected error (exit $rc)"
  finish DELIVER_STOP_INTERNAL 41
}
on_signal() {
  # while the worker runs: pass the stop on and wait for it (it aborts the delivery attempt; the bundle stays sealed)
  if [ "$STARTED" = 1 ]; then
    INTERRUPTED=1
    [ -z "$WPID" ] || kill -TERM "$WPID" 2>/dev/null || true
    return 0
  fi
  finish DELIVER_STOP_SIGNAL 40
}
trap on_exit EXIT
trap on_signal INT TERM HUP

# ---------------------------------------------------------------- 1. the approval id
[ "$#" -eq 1 ] || { say "usage: imagefirst-deliver-review.sh <approval id>"; finish DELIVER_USAGE 2; }
[[ "$1" =~ ^hoshigama-imagefirst-d3-[0-9]{8}-[0-9]{2}$ ]] || { say "DELIVER_ID_INVALID: expected hoshigama-imagefirst-d3-YYYYMMDD-NN"; finish DELIVER_ID_INVALID 2; }
APPROVAL="$1"
[[ "$APPROVAL" != hoshigama-imagefirst-d3-00000000-* ]] || { say "DELIVER_ID_RESERVED: the date 00000000 is the dummy PoC's, never a real run's"; finish DELIVER_ID_RESERVED 2; }

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
TEST_ROOT="${SR_IMAGEFIRST_DELIVER_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || { say "DELIVER_TEST_HOOK_REFUSED: test hooks are refused in $PROD_CLONE"; finish DELIVER_USAGE 2; }
  [ "$(id -u)" = 0 ] || { say "run as root: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-deliver-review.sh <approval id>"; finish DELIVER_USAGE 2; }
  R=""
  WORKER_USER=sr-designgen
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  WORKER_PATH=/usr/local/bin:/usr/bin:/bin
else
  # Any other copy runs only the unit tests' fake WSL (tests/unit/design-agent/imagefirst-worker/deliver-review-wrapper.test.ts).
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || { say "run from the root-only clone: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-deliver-review.sh <approval id>"; finish DELIVER_USAGE 2; }
  R="$TEST_ROOT"
  WORKER_USER="$(id -un)"
  WORKER_PATH="$PATH"
fi
STATE="$R/var/lib/sr-imagefirst-autostart"
CYCLE_STATE="$R/var/lib/sr-design-cycle"
WORKER_HOME="$R/home/sr-designgen"
CLONE="$WORKER_HOME/imagefirst/second-root"

in_clone() { "${AS_WORKER[@]}" "$@" 8>&- 9>&-; }

# Busy unless both units are stopped and the worker user runs nothing. Fail closed: an error or any other state is busy.
# (Verbatim from imagefirst-autostart.sh; deliver-review-wrapper.test.ts pins that the two stay identical.)
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

# ---------------------------------------------------------------- 2. no automatic start poll and no design cycle meanwhile
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/autostart.lock"
flock -n 9 || { say "busy: an automatic start poll is running"; finish DELIVER_BUSY 12; }
if [ -d "$CYCLE_STATE" ] && [ ! -L "$CYCLE_STATE" ]; then
  exec 8>>"$CYCLE_STATE/cycle.lock"
  flock -n 8 || { say "busy: a design cycle holds its lock"; finish DELIVER_BUSY 12; }
fi
WORK="$(mktemp -d "$STATE/deliver.XXXXXX")"

# ---------------------------------------------------------------- 3. mutual exclusion
if busy; then say "busy: $BUSY_WHY"; finish DELIVER_BUSY 12; fi

# ---------------------------------------------------------------- 4. the worker's clone: clean, on origin/develop (read only)
worker_uid="$(id -u "$WORKER_USER")" && worker_gid="$(id -g "$WORKER_USER")" || { say "DELIVER_STOP_NO_USER: $WORKER_USER"; finish DELIVER_STOP_NO_USER 20; }
AS_WORKER=(setpriv --reuid="$worker_uid" --regid="$worker_gid" --init-groups --reset-env --no-new-privs -- env -i HOME="$WORKER_HOME" PATH="$WORKER_PATH" LANG=C.UTF-8)
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
  if [ -n "${!name+x}" ]; then AS_WORKER+=("$name=${!name}"); fi
done
AS_WORKER+=(bash -c 'cd -- "$1" || exit 97; shift; exec "$@"' _ "$CLONE")
[ -d "$CLONE" ] || { say "DELIVER_STOP_NO_CLONE: $CLONE is missing"; finish DELIVER_STOP_NO_CLONE 20; }
dirty="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git status --porcelain --untracked-files=all 2>/dev/null)" ||
  { say "git status failed"; finish DELIVER_STOP_GIT 20; }
[ -z "$dirty" ] || { say "the clone has changes: stopped (nothing is cleaned automatically)"; finish DELIVER_STOP_TREE_DIRTY 20; }
head="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse HEAD 2>/dev/null)" || head=""
base="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse origin/develop 2>/dev/null)" || base=""
[[ "$head" =~ ^[0-9a-f]{40}$ ]] && [ "$head" = "$base" ] || { say "HEAD is not origin/develop in the worker's clone: stopped"; finish DELIVER_STOP_NOT_ON_ORIGIN_DEVELOP 20; }

# ---------------------------------------------------------------- 5. the re-send, ONCE, as the worker outside the jail
if busy; then say "busy: $BUSY_WHY"; finish DELIVER_BUSY 12; fi
say "re-sending the sealed bundle of $APPROVAL (commit $head)"
STARTED=1
set +e
"${AS_WORKER[@]}" timeout --foreground --kill-after="$DELIVER_KILL_AFTER" "$DELIVER_TIMEOUT" \
  node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --deliver-review "$APPROVAL" >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &
WPID=$!
wait "$WPID"
rc=$?
while [ "$rc" -gt 128 ] && kill -0 "$WPID" 2>/dev/null; do
  wait "$WPID"
  rc=$?
done
set -e
WPID=""
line="$(tail -n 1 "$WORK/out" | tr -d '\000-\037' | cut -c1-2000)"
say "worker: ${line:-<no line>}"
if [ "$rc" -ne 0 ]; then
  tail -n 20 "$WORK/err" | tr -d '\000-\010\013-\037' | cut -c1-300 | sed 's/^/imagefirst-deliver-review: worker stderr: /'
fi
# a stop during the re-send is an interruption, never a refusal (the bundle stays sealed or unsealed: run it again later)
if [ "$INTERRUPTED" = 1 ]; then finish DELIVER_INTERRUPTED 1; fi
case "$rc" in
  0) finish DELIVER_DONE 0 ;;
  1) finish DELIVER_NOT_DELIVERED 1 ;;
  2) finish DELIVER_WORKER_REFUSED 2 ;;
  124 | 137) finish DELIVER_TIMEOUT 1 ;;
  *) finish DELIVER_WORKER_STOPPED 1 ;;
esac
}
