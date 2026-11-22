#!/usr/bin/env bash
# Second Root IMAGE_FIRST automatic run (Issue #302, docs/operations/imagefirst-autorun.md): after the owner's one approval
# command (imagefirst-approve.sh <approval id>, which writes root's one-use run marker), ONE limited pilot for that id,
# unattended: Remote Control stopped, the EXISTING pilot once (preflight, one worker run, delivery, audit dry run, one audit,
# summary), Remote Control ALWAYS started again, and a review-ready file of the pilot's shareable lines for Claude. It has no
# runner, approval parser, retry or agent of its own: it starts admin.sh claude-stop / claude-start and imagefirst-pilot.sh
# (--autorun <id> <root-verified commit>), and nothing else.
#
#   run by sr-imagefirst-autorun.service only (its timer, every 10 minutes); refused anywhere else
#   ExecStopPost: imagefirst-autorun.sh --restore (Remote Control started again if a run could not do it itself)
#
# Run by root, only from the root-only admin clone (/root/sr-capture-admin), only inside sr-imagefirst-autorun.service (its
# own cgroup, read from the kernel). The unit and its timer are NOT installed or enabled by anything in this repository.
# Root never runs git, node or a parser on files the worker user controls: it parses only its own root-owned switch and
# marker (the automatic start's parsers, verbatim); the worker's clone is handled by the pilot (as the worker, outside the
# jail), and the review-ready file is written AS the worker user (setpriv), so root never follows a path the worker owns.
#
# One firing, in this order. Anything before step 6 ends quietly, Remote Control untouched:
#   1. the owner's switch /etc/sr-design-worker/imagefirst-autostart.json ({"enabled": true}); absent / false: OFF, exit 0,
#      nothing touched
#   2. inside sr-imagefirst-autorun.service (else refused, exit 2); this script's lock (another firing: exit 11)
#   3. the owner's one-use run marker /etc/sr-design-worker/imagefirst-run.json (the automatic start's rules: exactly
#      {"approval_id", "expires_at"}, the id form, not the reserved date, at most 24 h ahead): missing / expired: exit 10;
#      invalid / unsafe / too far: exit 2; root's used/<id> (the pilot's, the automatic start's) or attempt/<id> (this
#      script's) already there: exit 10
#   4. the old hourly automatic start's units neither active nor enabled (both reading one marker is refused, exit 2);
#      the design cycle's timer off and its service stopped, and no automatic start poll, pilot or cycle holding its lock
#      (else busy, exit 12)
#   5. the production copy: the scripts it runs root's and writable by nobody else up to /; root's admin clone clean and
#      its HEAD exactly origin's develop (git ls-remote of the admin clone's own configured URL; root's own clone only):
#      that commit is the one the run is pinned to (else refused, Remote Control untouched)
#   6. the intent recorded: attempt/<id> (atomic mkdir in root's 0700 state, never removed: ONE attempt per id, whatever
#      happens next); whether the jailed Claude is enabled; the restore flag (with that answer) and STOPPED_RC together;
#      then admin.sh claude-stop, then (bounded) until the automatic start's busy() says idle: the jailed Claude stopped
#      and disabled, the design cycle stopped, no process of the worker user
#   7. step 5's check again (the same commit, else no pilot), then imagefirst-pilot.sh --autorun <id> <commit>: the
#      worker's clone pinned to that commit (a fixed git config with root's origin URL, hooks / fsmonitor / credential
#      helpers off, npm ci always), then the manual pilot's every check, step and code, plus root's used/<id> created right
#      before the worker starts (the worker never starts twice for one id; its own claim and the entry's ledger as before)
#   8. always (an EXIT trap: success, failure, a stop signal): the review-ready file (only while no worker process runs),
#      then admin.sh claude-start if the jailed Claude was enabled before (else it is left stopped), then the restore flag
#      removed. If the worker user is still busy at that point, claude-start is left to the unit's ExecStopPost (after
#      systemd has ended what is left in this unit). A SIGKILL or a power loss skips the trap: the unit's ExecStopPost
#      (--restore) starts Remote Control when the flag is still there and says it was enabled; WSL stopping skips both.
# A stop signal during step 7 is passed on to the pilot, which passes it on to the worker or audit and waits for its record;
# then step 8. Nothing is ever retried: a second firing for the same id stops in step 3.
#
# The review-ready file: ~sr-designgen/sr-runs/review-inbox/runs/<id>.share.txt (0600, the worker's), written once by the
# worker user (never overwritten, no link followed in its directories): only the pilot's "share:" lines, its last line, and
# one result line of this script. Never a local-only line, a path, a SHA-256, an image, a prompt or a secret.
#
# Output (the journal): fixed lines, the pilot's output; the last line is machine-readable:
#   IMAGEFIRST_AUTORUN <CODE> approval=<id|none> pilot=<PILOT CODE|none> remote_control=<untouched|restored|left_stopped|deferred|not_restored> exit=<n>
# Exit: 0 off / the pilot done (PILOT_DONE) and Remote Control restored, 10 nothing due, 11 locked, 12 busy (Remote Control
#       untouched), 2 refused (switch / marker unsafe or invalid, not the service, the old automatic start enabled, usage,
#       untrusted / dirty admin clone or not at origin's develop), 20 origin not reachable (before anything), 1 attempted
#       and the pilot did not end PILOT_DONE (or the idle wait failed, or develop moved meanwhile),
#       3 Remote Control could not be started again (it overrides 0 / 1), 40 / 41 a signal / internal error before step 6.
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
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SR_IMAGEFIRST_AUTORUN_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec /usr/bin/env -i "${keep[@]}" /bin/bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
umask 077
cd /

# ---------------------------------------------------------------- limits (every step is cut by timeout(1))
KILL_AFTER=30
# admin.sh claude-stop / claude-start (claude-start waits 5 s for the unit)
ADMIN_TIMEOUT=120
# after claude-stop: until no process of the worker user is left
IDLE_WAIT=180
IDLE_STEP=3
# root's ls-remote of origin's develop (twice: before the attempt and after the idle wait)
ADMIN_FETCH_TIMEOUT=180
# the pilot: the clone pinned (fetch 210 s + git 6 x 90 s + npm ci, always, 930 s) + preflight (~15 min worst) + worker
# 1890 s + re-send + dry run 630 s + audit 2490 s
PILOT_TIMEOUT=8400
# a stopped pilot passes the stop on and waits for the worker (90 s) or the audit (90 s) to end
PILOT_KILL_AFTER=200
MAX_WINDOW=86400

MODE=run
PHASE=before_stop
APPROVAL=none
PILOT_CODE=none
RC_STATE=untouched
FINISHED=0
INTERRUPTED=0
CPID=""
WORK=""
STOPPED_RC=0
FLAG_WRITTEN=0
ADMIN_SHA=""

say() { printf 'imagefirst-autorun: %s\n' "$*"; }

# ---------------------------------------------------------------- the mode
if [ "$#" -eq 1 ] && [ "$1" = --restore ]; then
  MODE=restore
elif [ "$#" -ne 0 ]; then
  printf 'imagefirst-autorun: usage: imagefirst-autorun.sh (no arguments) | --restore\n'
  printf 'IMAGEFIRST_AUTORUN AUTORUN_USAGE approval=none pilot=none remote_control=untouched exit=2\n'
  exit 2
fi

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
TEST_ROOT="${SR_IMAGEFIRST_AUTORUN_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  if [ -n "$TEST_ROOT" ] || [ "$(id -u)" != 0 ]; then
    say "AUTORUN_TEST_HOOK_REFUSED / not root: runs as root from $PROD_CLONE inside sr-imagefirst-autorun.service only"
    printf 'IMAGEFIRST_AUTORUN AUTORUN_USAGE approval=none pilot=none remote_control=untouched exit=2\n'
    exit 2
  fi
  R=""
  WORKER_USER=sr-designgen
  FILE_ROOT=root
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  WORKER_PATH=/usr/local/bin:/usr/bin:/bin
  ADMIN="$REPO/scripts/sales-design-capture/admin.sh"
else
  # Any other copy runs only the unit tests' fake WSL (tests/unit/design-agent/imagefirst-worker/autorun.test.ts).
  if [ -z "$TEST_ROOT" ] || [ ! -d "$TEST_ROOT" ]; then
    say "runs only from the root-only clone $PROD_CLONE, inside sr-imagefirst-autorun.service"
    printf 'IMAGEFIRST_AUTORUN AUTORUN_USAGE approval=none pilot=none remote_control=untouched exit=2\n'
    exit 2
  fi
  R="$TEST_ROOT"
  WORKER_USER="$(id -un)"
  FILE_ROOT="$(id -un)"
  WORKER_PATH="$PATH"
  # the test world's stand-in for admin.sh (it records claude-stop / claude-start), and a shorter idle wait
  ADMIN="$R/admin.sh"
  if [ -f "$R/idle-wait" ]; then IDLE_WAIT="$(cat "$R/idle-wait")"; IDLE_STEP=1; fi
fi
PILOT="$REPO/scripts/sales-design-worker/imagefirst-pilot.sh"
# root's admin clone: this copy itself (the test world: its stand-in under the test root)
if [ -n "$R" ]; then ADMIN_GIT="$R$PROD_CLONE"; else ADMIN_GIT="$REPO"; fi
SWITCH="$R/etc/sr-design-worker/imagefirst-autostart.json"
MARKER="$R/etc/sr-design-worker/imagefirst-run.json"
STATE="$R/var/lib/sr-imagefirst-autostart"
CYCLE_STATE="$R/var/lib/sr-design-cycle"
RESTORE_FLAG="$STATE/autorun.restore-pending"
WORKER_HOME="$R/home/sr-designgen"

now() {
  if [ -n "$R" ] && [ -f "$R/clock" ]; then cat "$R/clock"; else date +%s; fi
}

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
# (Verbatim from the automatic start; autorun.test.ts pins that the two stay identical.)
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

# Whether this process runs inside sr-imagefirst-autorun.service: its own cgroup v2 line (the pilot's and preflight's rule).
in_autorun_unit() {
  local cg
  if [ -n "$R" ]; then cg="$(cat -- "$R/proc/self/cgroup" 2>/dev/null || true)"; else cg="$(cat /proc/self/cgroup 2>/dev/null || true)"; fi
  [[ $'\n'"$cg"$'\n' == *$'\n'"0::/system.slice/sr-imagefirst-autorun.service"$'\n'* ]]
}

# Remote Control started again (admin.sh claude-start, the existing command). Only when this script stopped it (the root
# flag says so) AND the jailed Claude was enabled before that (the flag's was_enabled=yes, written by this script before
# claude-stop): an owner who had stopped Remote Control finds it still stopped. The flag goes once claude-start says
# CLAUDE_STARTED (or when nothing is to be started). Never fails the caller.
restore_rc() {
  [ -e "$RESTORE_FLAG" ] || return 0
  if ! grep -qx 'was_enabled=yes' -- "$RESTORE_FLAG" 2>/dev/null; then
    rm -f -- "$RESTORE_FLAG"
    RC_STATE=left_stopped
    say "Remote Control was not enabled before this run: left stopped (as the owner had it)"
    return 0
  fi
  local out rc=0
  out="$(timeout --kill-after="$KILL_AFTER" "$ADMIN_TIMEOUT" bash "$ADMIN" claude-start 2>&1 7>&- 8>&- 9>&-)" || rc=$?
  printf '%s\n' "$out" | tr -d '\000-\010\013-\037' | tail -n 5 | cut -c1-300 | sed 's/^/imagefirst-autorun: claude-start: /'
  if [ "$rc" -eq 0 ] && [[ $'\n'"$out"$'\n' == *$'\n'"CLAUDE_STARTED (jailed)"$'\n'* ]]; then
    rm -f -- "$RESTORE_FLAG"
    RC_STATE=restored
  else
    RC_STATE=not_restored
    say "Remote Control was NOT started again (exit $rc): sudo bash $PROD_CLONE/scripts/sales-design-capture/admin.sh status, then claude-start once"
  fi
}

# The review-ready file, written AS the worker user (setpriv, as the pilot's privilege drop) from root's work file on stdin:
# never overwritten, no link followed in its directories (they must be real directories of the worker), 0600. Only while
# no process of the worker user runs (before claude-start), as every other command root runs as the worker.
write_review() {
  local lines="$1"
  [ -n "$APPROVAL" ] && [ "$APPROVAL" != none ] || return 0
  if busy; then say "the review-ready file is not written (busy: $BUSY_WHY)"; return 0; fi
  local uid gid
  uid="$(id -u "$WORKER_USER" 2>/dev/null)" && gid="$(id -g "$WORKER_USER" 2>/dev/null)" || { say "the review-ready file is not written (no user $WORKER_USER)"; return 0; }
  local as_worker=(setpriv --reuid="$uid" --regid="$gid" --init-groups --reset-env --no-new-privs -- env -i HOME="$WORKER_HOME" PATH="$WORKER_PATH" LANG=C.UTF-8)
  # shellcheck disable=SC2016
  if "${as_worker[@]}" bash -c 'set -u; umask 077; id="$1"; r="$HOME/sr-runs"; d="$r/review-inbox/runs"
    for p in "$r" "$r/review-inbox" "$d"; do
      if [ ! -e "$p" ] && [ ! -L "$p" ] && [ "$p" != "$r" ]; then mkdir -m 700 -- "$p" || exit 3; fi
      [ -d "$p" ] && [ ! -L "$p" ] || exit 3
    done
    f="$d/$id.share.txt"
    if [ -e "$f" ] || [ -L "$f" ]; then exit 4; fi
    t="$(mktemp -- "$d/.share.XXXXXX")" || exit 3
    cat >>"$t" || { rm -f -- "$t"; exit 3; }
    chmod 600 -- "$t" && ln -- "$t" "$f"; rc=$?; rm -f -- "$t"; exit "$rc"' _ "$APPROVAL" <"$lines" 7>&- 8>&- 9>&-; then
    say "the review-ready file is written: ~$WORKER_USER/sr-runs/review-inbox/runs/$APPROVAL.share.txt"
  else
    say "the review-ready file is not written (no ~/sr-runs, a link, or it exists already)"
  fi
}

finish() {
  local code="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  if [ "$STOPPED_RC" = 1 ]; then
    # the review-ready file first (no worker process yet), then Remote Control back
    if [ -n "$WORK" ] && [ -d "$WORK" ]; then
      {
        if [ -f "$WORK/pilot" ]; then
          tr -d '\000-\010\013-\037' <"$WORK/pilot" | grep -a '^imagefirst-pilot: share: ' | cut -c1-400 || true
          tr -d '\000-\010\013-\037' <"$WORK/pilot" | grep -a '^IMAGEFIRST_PILOT ' | tail -n 1 | cut -c1-200 || true
        fi
        printf 'IMAGEFIRST_AUTORUN_RESULT %s approval=%s pilot=%s exit=%s\n' "$code" "$APPROVAL" "$PILOT_CODE" "$rc"
      } >"$WORK/review" 2>/dev/null || true
      write_review "$WORK/review" || true
    fi
    if busy; then
      # something of the worker user (or the jail) is still there, e.g. a worker the pilot's timeout left behind: it is in
      # this unit's cgroup, and systemd ends it when this script exits (KillMode=mixed). Remote Control is then started by
      # the unit's ExecStopPost (--restore), from the flag left in place
      RC_STATE=deferred
      say "not idle at the end ($BUSY_WHY): Remote Control is left to the unit's ExecStopPost (--restore); the flag stays"
    else
      restore_rc || true
    fi
    if [ "$RC_STATE" = not_restored ]; then code=AUTORUN_RC_NOT_RESTORED; rc=3; fi
  fi
  [ -z "$WORK" ] || rm -rf "$WORK"
  printf 'IMAGEFIRST_AUTORUN %s approval=%s pilot=%s remote_control=%s exit=%s\n' "$code" "$APPROVAL" "$PILOT_CODE" "$RC_STATE" "$rc"
  exit "$rc"
}
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return
  say "stopped by an unexpected error (exit $rc)"
  if [ "$STOPPED_RC" = 1 ]; then finish AUTORUN_STOP_INTERNAL 1; fi
  finish AUTORUN_STOP_INTERNAL 41
}
on_signal() {
  # before Remote Control is stopped: end here (nothing touched). After it: never end inside the handler (claude-stop or a
  # pilot may still be running): pass the stop on to a running pilot and end at the next step boundary, where the EXIT path
  # writes the review-ready file and starts Remote Control again
  if [ "$STOPPED_RC" != 1 ]; then
    # the flag may have been written in the instant before STOPPED_RC=1: claude-stop has not run, nothing to restore
    if [ "$FLAG_WRITTEN" = 1 ]; then rm -f -- "$RESTORE_FLAG"; fi
    finish AUTORUN_STOP_SIGNAL 40
  fi
  INTERRUPTED=1
  [ -z "$CPID" ] || kill -TERM "$CPID" 2>/dev/null || true
  return 0
}
trap on_exit EXIT
trap on_signal INT TERM HUP

# A step run in the background so a stop signal is passed on to it; its output to a work file. Sets STEP_RC.
STEP_RC=0
step() {
  local out="$1" limit="$2"; shift 2
  set +e
  timeout --foreground --kill-after="$PILOT_KILL_AFTER" "$limit" "$@" >"$out" 2>&1 7>&- 8>&- 9>&- &
  CPID=$!
  if [ "$INTERRUPTED" = 1 ]; then kill -TERM "$CPID" 2>/dev/null || true; fi
  wait "$CPID"
  STEP_RC=$?
  while [ "$STEP_RC" -gt 128 ] && kill -0 "$CPID" 2>/dev/null; do
    wait "$CPID"
    STEP_RC=$?
  done
  set -e
  CPID=""
  tr -d '\000-\010\013-\037' <"$out" | cut -c1-400
}

# ---------------------------------------------------------------- --restore (the unit's ExecStopPost)
if [ "$MODE" = restore ]; then
  in_autorun_unit || { say "AUTORUN_NOT_SERVICE: --restore runs only as sr-imagefirst-autorun.service's ExecStopPost"; finish AUTORUN_NOT_SERVICE 2; }
  if [ -z "$R" ]; then trusted_path "$ADMIN" || { say "AUTORUN_ADMIN_CLONE_UNTRUSTED: $ADMIN"; finish AUTORUN_ADMIN_CLONE_UNTRUSTED 2; }; fi
  if [ ! -e "$RESTORE_FLAG" ]; then finish AUTORUN_RESTORE_NOTHING 0; fi
  say "a run ended without starting Remote Control again: claude-start once"
  restore_rc || true
  # one attempt only (the next firing's ExecStopPost must not retry it every 10 minutes)
  rm -f -- "$RESTORE_FLAG"
  if [ "$RC_STATE" = restored ]; then finish AUTORUN_RESTORED 0; fi
  if [ "$RC_STATE" = left_stopped ]; then finish AUTORUN_RESTORE_LEFT_STOPPED 0; fi
  finish AUTORUN_RC_NOT_RESTORED 3
fi

# ---------------------------------------------------------------- 1. the owner's switch (absent = OFF: nothing touched)
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
if [ ! -e "$SWITCH" ] && [ ! -L "$SWITCH" ]; then
  say "the switch is absent: OFF"
  finish AUTORUN_OFF 0
fi
owner_file "$SWITCH" || { say "AUTORUN_SWITCH_UNSAFE: the switch must be a root-owned regular file nobody else can write"; finish AUTORUN_SWITCH_UNSAFE 2; }
switch="$(python3 -I -c "$SWITCH_PY" "$SWITCH" 8>&- 9>&-)" || switch=INVALID
case "$switch" in
  ON) ;;
  OFF) say "the switch says enabled:false: OFF"; finish AUTORUN_OFF 0 ;;
  *) say "AUTORUN_SWITCH_INVALID: expected exactly {\"enabled\": true|false}"; finish AUTORUN_SWITCH_INVALID 2 ;;
esac

# ---------------------------------------------------------------- 2. inside the service; one firing at a time
in_autorun_unit || { say "AUTORUN_NOT_SERVICE: runs only inside sr-imagefirst-autorun.service (started by its timer)"; finish AUTORUN_NOT_SERVICE 2; }
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 7>"$STATE/autorun.lock"
flock -n 7 || { say "another firing is running; nothing done"; finish AUTORUN_LOCKED 11; }
WORK="$(mktemp -d "$STATE/autorun.XXXXXX")"

# ---------------------------------------------------------------- 3. the owner's one-use run marker
if [ ! -e "$MARKER" ] && [ ! -L "$MARKER" ]; then
  finish AUTORUN_IDLE_NO_MARKER 10
fi
owner_file "$MARKER" || { say "AUTORUN_MARKER_UNSAFE: the run marker must be a root-owned regular file nobody else can write"; finish AUTORUN_MARKER_UNSAFE 2; }
marker="$(python3 -I -c "$MARKER_PY" "$MARKER" "$(now)" "$MAX_WINDOW" 7>&- 8>&- 9>&-)" || marker=INVALID
case "$marker" in
  "OK "*) APPROVAL="${marker#OK }" ;;
  "EXPIRED "*) APPROVAL="${marker#EXPIRED }"; finish AUTORUN_IDLE_MARKER_EXPIRED 10 ;;
  "TOO_FAR "*) APPROVAL="${marker#TOO_FAR }"; say "AUTORUN_MARKER_TOO_FAR: expires_at more than 24 h ahead"; finish AUTORUN_MARKER_INVALID 2 ;;
  *) say "AUTORUN_MARKER_INVALID: expected exactly {\"approval_id\": \"hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN\", \"expires_at\": \"<UTC>Z\"}"; finish AUTORUN_MARKER_INVALID 2 ;;
esac
if [ -e "$STATE/used/$APPROVAL" ] || [ -L "$STATE/used/$APPROVAL" ]; then
  finish AUTORUN_IDLE_MARKER_USED 10
fi
if [ -e "$STATE/autorun/$APPROVAL" ] || [ -L "$STATE/autorun/$APPROVAL" ]; then
  finish AUTORUN_IDLE_ATTEMPTED 10
fi

# ---------------------------------------------------------------- 4. never with the old automatic start; nothing else running
for u in sr-imagefirst-autostart.timer sr-imagefirst-autostart.service; do
  unit_off "$u" || { say "AUTORUN_AUTOSTART_ENABLED: $UNIT_WHY (the hourly automatic start reads the same marker: disable it first)"; finish AUTORUN_AUTOSTART_ENABLED 2; }
done
unit_off sr-design-cycle.timer || { say "busy: $UNIT_WHY"; finish AUTORUN_BUSY 12; }
st="$(systemctl show -p ActiveState --value sr-design-cycle.service 2>/dev/null)" || st=error
[[ "$st" =~ ^(inactive|failed)$ ]] || { say "busy: sr-design-cycle.service is ${st:-unknown}"; finish AUTORUN_BUSY 12; }
# no automatic start poll or pilot (their lock) and no design cycle (its lock): probed, then released for the pilot
if ! ( exec 9>"$STATE/autostart.lock" && flock -n 9 ); then say "busy: an automatic start poll or a pilot holds its lock"; finish AUTORUN_BUSY 12; fi
if [ -d "$CYCLE_STATE" ] && [ ! -L "$CYCLE_STATE" ] && ! ( exec 8>>"$CYCLE_STATE/cycle.lock" && flock -n 8 ); then say "busy: a design cycle holds its lock"; finish AUTORUN_BUSY 12; fi

# ---------------------------------------------------------------- 5. the production copy: trusted scripts, a clean admin clone
if [ -z "$R" ]; then
  for f in "$SELF" "$PILOT" "$REPO/scripts/sales-design-worker/imagefirst-pilot-preflight.sh" "$REPO/scripts/sales-design-worker/imagefirst-deliver-review.sh" "$ADMIN"; do
    trusted_path "$f" || { say "AUTORUN_ADMIN_CLONE_UNTRUSTED: $f must be root's and writable by nobody else, up to /"; finish AUTORUN_ADMIN_CLONE_UNTRUSTED 2; }
  done
fi
# root's admin clone: clean, and its HEAD exactly origin's develop (asked with ls-remote from the admin clone's own
# configured URL: nothing is written, so it also works under the unit's read-only /root). Sets ADMIN_NOW. Returns
# 1 unreadable, 2 dirty, 3 origin not reachable, 4 HEAD is not origin's develop (ADMIN_REMOTE says what is).
ADMIN_NOW=""
ADMIN_REMOTE=""
admin_commit() {
  local head dirty url remote
  head="$(git -C "$ADMIN_GIT" rev-parse HEAD 2>/dev/null)" || return 1
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || return 1
  dirty="$(git -C "$ADMIN_GIT" --no-optional-locks status --porcelain --untracked-files=normal 2>/dev/null)" || return 1
  [ -z "$dirty" ] || return 2
  url="$(git -C "$ADMIN_GIT" config --get remote.origin.url 2>/dev/null)" || return 1
  [[ "$url" =~ ^[A-Za-z0-9._:/@+-]+$ ]] || return 1
  remote="$(timeout --kill-after="$KILL_AFTER" "$ADMIN_FETCH_TIMEOUT" git -C "$ADMIN_GIT" -c protocol.ext.allow=never ls-remote "$url" refs/heads/develop 2>/dev/null 7>&- 8>&- 9>&-)" || return 3
  ADMIN_REMOTE="${remote%%[[:space:]]*}"
  [[ "$ADMIN_REMOTE" =~ ^[0-9a-f]{40}$ ]] || return 3
  [ "$head" = "$ADMIN_REMOTE" ] || return 4
  ADMIN_NOW="$head"
}
arc=0
admin_commit || arc=$?
case "$arc" in
  0) ADMIN_SHA="$ADMIN_NOW" ;;
  2) say "AUTORUN_ADMIN_CLONE_DIRTY: $PROD_CLONE has changes"; finish AUTORUN_ADMIN_CLONE_DIRTY 2 ;;
  3) say "origin's develop could not be read from the admin clone's URL: nothing done (Remote Control untouched)"; finish AUTORUN_STOP_ADMIN_FETCH 20 ;;
  4) say "AUTORUN_ADMIN_NOT_DEVELOP: the admin clone is not at origin's develop $ADMIN_REMOTE (Remote Control untouched). Run: sudo git -C $PROD_CLONE fetch -q origin && sudo git -C $PROD_CLONE checkout -q --detach origin/develop"
    finish AUTORUN_ADMIN_NOT_DEVELOP 2 ;;
  *) say "AUTORUN_ADMIN_CLONE_UNREADABLE: $PROD_CLONE"; finish AUTORUN_ADMIN_CLONE_UNREADABLE 2 ;;
esac

# ---------------------------------------------------------------- 6. the intent, then Remote Control stopped
mkdir -p -m 0700 "$STATE/autorun"
if ! mkdir -m 0700 "$STATE/autorun/$APPROVAL" 2>/dev/null; then finish AUTORUN_IDLE_ATTEMPTED 10; fi
printf 'approval_id=%s\nattempted_at=%s\ncommit=%s\n' "$APPROVAL" "$(now)" "$ADMIN_SHA" >"$STATE/autorun/$APPROVAL/attempt"
# whether the jailed Claude was enabled before: only then is it started again afterwards
was="$(systemctl is-enabled sr-jail-claude.service 2>/dev/null)" || true
if [ "$was" = enabled ]; then was_enabled=yes; else was_enabled=no; fi
# the restore flag and STOPPED_RC together, right before claude-stop (a stop signal in between removes the flag again)
FLAG_WRITTEN=1
printf 'was_enabled=%s\napproval_id=%s\n' "$was_enabled" "$APPROVAL" >"$RESTORE_FLAG"
STOPPED_RC=1
RC_STATE=stopping
if [ -n "$R" ] && [ -f "$R/hold-before-stop" ]; then
  # the test world only: hold in the signal window between the flag and claude-stop
  : >"$R/holding-before-stop"
  while [ -f "$R/hold-before-stop" ]; do sleep 0.1; done
fi
if [ "$INTERRUPTED" = 1 ]; then
  # a stop that came after the flag and before claude-stop: nothing was stopped, so nothing is to be restored
  rm -f -- "$RESTORE_FLAG"
  STOPPED_RC=0
  RC_STATE=untouched
  finish AUTORUN_STOP_SIGNAL 40
fi
PHASE=after_stop
say "approval $APPROVAL is due (admin clone $ADMIN_SHA): one attempt (recorded); stopping Remote Control (admin.sh claude-stop; was enabled: $was_enabled)"
set +e
out="$(timeout --kill-after="$KILL_AFTER" "$ADMIN_TIMEOUT" bash "$ADMIN" claude-stop 2>&1 7>&- 8>&- 9>&-)"
src=$?
set -e
printf '%s\n' "$out" | tr -d '\000-\010\013-\037' | tail -n 5 | cut -c1-300 | sed 's/^/imagefirst-autorun: claude-stop: /'
if [ "$INTERRUPTED" = 1 ]; then finish AUTORUN_INTERRUPTED 1; fi
[ "$src" -eq 0 ] || { say "claude-stop failed (exit $src): no pilot"; finish AUTORUN_STOP_CLAUDE_STOP 1; }
waited=0
while busy; do
  if [ "$INTERRUPTED" = 1 ]; then finish AUTORUN_INTERRUPTED 1; fi
  if [ "$waited" -ge "$IDLE_WAIT" ]; then say "still busy after ${IDLE_WAIT} s ($BUSY_WHY): no pilot"; finish AUTORUN_STOP_NOT_IDLE 1; fi
  sleep "$IDLE_STEP"
  waited=$((waited + IDLE_STEP))
done
say "idle: the jailed Claude stopped and disabled, no process of $WORKER_USER"

# ---------------------------------------------------------------- 7. root's commit again, then the existing pilot once, pinned to it
arc=0
admin_commit || arc=$?
if [ "$arc" -ne 0 ] || [ "$ADMIN_NOW" != "$ADMIN_SHA" ]; then
  say "the admin clone or origin's develop changed since the check (was $ADMIN_SHA): no pilot (nothing used)"
  finish AUTORUN_STOP_DEVELOP_MOVED 1
fi
PILOT_ENV=(env)
if [ -n "$R" ]; then PILOT_ENV+=("SR_IMAGEFIRST_PILOT_TEST_ROOT=$R"); fi
step "$WORK/pilot" "$PILOT_TIMEOUT" "${PILOT_ENV[@]}" bash "$PILOT" --autorun "$APPROVAL" "$ADMIN_SHA"
pline="$(grep -a '^IMAGEFIRST_PILOT ' "$WORK/pilot" | tail -n 1 | tr -d '\000-\037')" || pline=""
if [[ "$pline" =~ ^IMAGEFIRST_PILOT\ ([A-Z_]+)\ phase=(before_claim|after_claim)\ approval=$APPROVAL\ exit=([0-9]+)$ ]] && [ "${BASH_REMATCH[3]}" = "$STEP_RC" ]; then
  PILOT_CODE="${BASH_REMATCH[1]}"
else
  PILOT_CODE=PILOT_NO_RESULT
fi
if [ "$INTERRUPTED" = 1 ]; then finish AUTORUN_INTERRUPTED 1; fi
if [ "$STEP_RC" -eq 0 ] && [ "$PILOT_CODE" = PILOT_DONE ]; then finish AUTORUN_DONE 0; fi
say "the pilot ended $PILOT_CODE (exit $STEP_RC): never retried"
finish AUTORUN_PILOT_STOPPED 1
}
