#!/usr/bin/env bash
# Second Root IMAGE_FIRST automatic run (Issue #302, DEV-303, docs/operations/imagefirst-autorun.md): ONE limited pilot per
# firing, unattended, for either
#   (a) the owner's per-run approval: imagefirst-approve.sh <approval id> wrote root's one-use run marker (the manual
#       fallback, kept as it was), or
#   (b) the owner's ONE-TIME standing pre-authorization (owner decision 2026-11-23): root's policy
#       /etc/sr-design-worker/imagefirst-standing.json (written by imagefirst-autorun-setup.sh standing) and a request
#       file Claude (the worker user) drops in ~sr-designgen/sr-runs/requests/<id>.json, within root's limits (per day /
#       per week, rolling, counted from root's own attempt records; until the policy's not_after).
# Remote Control stopped, the EXISTING pilot once (preflight, one worker run, delivery, audit dry run, one audit, summary),
# Remote Control ALWAYS started again, and a review-ready file of the pilot's shareable lines for Claude. It has no runner,
# approval parser, retry or agent of its own: it starts admin.sh claude-stop / claude-start and imagefirst-pilot.sh, and
# nothing else.
#
#   run by sr-imagefirst-autorun.service only (its timer, every 10 minutes); refused anywhere else
#   ExecStopPost: imagefirst-autorun.sh --restore (Remote Control started again if a run could not do it itself)
#
# Run by root, only from the owner's INSTALLED copy (/usr/local/lib/sr-imagefirst, put there by the setup's apply: root's
# files, writable by nobody else up to /, each with the SHA-256 recorded in its SHA256SUMS), only inside
# sr-imagefirst-autorun.service (its own cgroup, read from the kernel). Root never runs scripts from the admin clone or the
# repository's develop; the worker's code is a fresh clone of the commit root pins (below), run as the worker by the pilot.
# Root never runs git, node or a parser on files the worker user controls: it parses only its own root-owned switch,
# marker and policy, and the bytes of a request that the WORKER read for it (setpriv, a pipe into root's own work file;
# root never opens a file of the worker). The review-ready file and a rejection notice are written AS the worker.
#
# One firing, in this order. Anything before step 6 ends quietly, Remote Control untouched:
#   1. the owner's switch /etc/sr-design-worker/imagefirst-autostart.json ({"enabled": true}); absent / false: OFF
#   2. inside sr-imagefirst-autorun.service (else refused, exit 2); this script's lock (another firing: exit 11)
#   3. the standing policy, when present, first (unsafe / invalid: refused, exit 2, nothing runs at all); then
#      (a) the owner's run marker /etc/sr-design-worker/imagefirst-run.json (the automatic start's rules: exactly
#      {"approval_id", "expires_at"}, the id form, not the reserved date, at most 24 h ahead): invalid / unsafe / too far:
#      exit 2; due, and root's used/<id> / autorun/<id> absent: this run is (a). Otherwise (absent, expired, used,
#      attempted):
#      (b) the standing policy: absent: nothing due (exit 10, the marker's own code); a link, not root's, writable by
#      others, or not exactly {"schema": "sr_imagefirst_standing_v1", "per_day" 1-4, "per_week" 1-20, "not_after",
#      "created_at" (UTC, at most 90 days apart), "worker_commit" (40 hex)[, "origin_url"]}: refused (exit 2), nothing
#      runs; expired: exit 10; root's freeze file (below) present: AUTORUN_STANDING_FROZEN, exit 2
#   4. the old hourly automatic start's units neither active nor enabled (exit 2); the design cycle's timer off and its
#      service stopped, and no automatic start poll, pilot or cycle holding its lock (else busy, exit 12)
#   5. the installed copy: this script, the pilot, its preflight, admin.sh (+ host-check.sh, jail files) and the memory
#      check root's, writable by nobody else up to /, and each the SHA-256 in root's SHA256SUMS (else refused, exit 2).
#      (b) only: the attempts root recorded (autorun/<id>/attempt, every one, failed or not; an unreadable one counts as
#      now) within the last 24 h below per_day and within the last 7 days below per_week (else exit 10, nothing read);
#      then the requests, read AS THE WORKER: names <id>.json (id ^req-[a-z0-9][a-z0-9-]{2,58}$), at most 16 KiB, a regular
#      file (no link, no FIFO; ids are ^req-[a-z0-9][a-z0-9-]{2,58}$, never an approval id's form); the envelope
#      {"schema": "sr_imagefirst_request_v1", "id" = the name, "shop_id",
#      "kind": "real_shop" | "fictional", "created_at" (UTC)}. An id root has seen (autorun/, rejected/, used/) is skipped;
#      an invalid request gets root's rejected/<id> with a reason code (never read again) and the worker's
#      ~/sr-runs/review-inbox/requests/<id>.rejected (written by the worker); the OLDEST valid one (created_at, then id)
#      is copied into root's requests/<id>.json (0600) and its SHA-256 recorded. None: exit 10.
#      Then the commit, the ONLY worker code the run executes outside the jail: while the policy is in force (request runs
#      and per-run approvals alike) its worker_commit, which the owner pinned with setup standing --expect <commit> (never
#      develop's tip; root first fetches exactly that commit into its own throw-away repository: the origin no longer having
#      it is AUTORUN_STANDING_COMMIT_UNAVAILABLE, nothing attempted). Without a policy (a per-run approval only, as before
#      DEV-303): root's admin clone clean with its HEAD = origin's develop, asked again after the idle wait (moved: no
#      pilot). Requests are data only: nothing in a request selects code, a commit or a limit
#   6. the intent recorded: autorun/<id>/attempt (atomic mkdir in root's 0700 state, never removed: ONE attempt per id,
#      whatever happens next; it counts against the limits); whether the jailed Claude is enabled; the restore flag and
#      STOPPED_RC together; then admin.sh claude-stop, then (bounded) until the automatic start's busy() says idle
#   7. imagefirst-pilot.sh --autorun <id> <commit> <origin URL> ((a)) or --autorun-request <id> <commit> <origin URL>
#      <request SHA-256> ((b)): a fresh clone of that URL with that commit checked out in a new root-chosen directory,
#      the manual pilot's every check, step and code, root's used/<id> created right before the worker starts; for (b)
#      the worker gets --request <id> --request-sha256 <hex> and a private copy of root's request file
#   7b. after the pilot, once the worker may have started: the run's images counted AS THE WORKER (its run dir's parts/
#      and the inbox copy of its bundle). More than 6 (or no count): AUTORUN_IMAGE_CAP_EXCEEDED, exit 1, and root's
#      /var/lib/sr-imagefirst-autostart/standing.frozen stops all standing pick-ups until setup standing --unfreeze --yes
#   8. always (an EXIT trap: success, failure, a stop signal): the review-ready file (only while no worker process runs),
#      then admin.sh claude-start if the jailed Claude was enabled before (else it is left stopped), then the restore flag
#      removed. If the worker user is still busy at that point, claude-start is left to the unit's ExecStopPost (after
#      systemd has ended what is left in this unit). A SIGKILL or a power loss skips the trap: the unit's ExecStopPost
#      (--restore) starts Remote Control when the flag is still there and says it was enabled; WSL stopping skips both.
# A stop signal during step 7 is passed on to the pilot, which passes it on to the worker or audit and waits for its record;
# then step 8. Nothing is ever retried: a second firing for the same id stops in step 3 / 5.
#
# The review-ready file: ~sr-designgen/sr-runs/review-inbox/runs/<id>.share.txt (0600, the worker's), written once by the
# worker user (never overwritten, no link followed in its directories): only the pilot's "share:" lines, its last line, and
# one result line of this script. Never a local-only line, a path, a SHA-256, an image, a prompt or a secret.
#
# Output (the journal): fixed lines, the pilot's output; the last line is machine-readable:
#   IMAGEFIRST_AUTORUN <CODE> approval=<id|none> pilot=<PILOT CODE|none> remote_control=<untouched|restored|left_stopped|deferred|not_restored> exit=<n>
#   (approval= is the approval id for (a), the request id for (b))
# Exit: 0 off / the pilot done (PILOT_DONE) and Remote Control restored, 10 nothing due (no marker / request, used,
#       attempted, expired, the limit reached), 11 locked, 12 busy (Remote Control untouched), 2 refused (switch / marker /
#       policy unsafe or invalid, not the service, the old automatic start enabled, usage, the installed copy untrusted or
#       not the one recorded, not the installed copy), 20 origin not reachable (before anything), 1 attempted and the
#       pilot did not end PILOT_DONE (or the idle wait failed), 3 Remote Control could not be started again (it overrides
#       0 / 1), 40 / 41 a signal / internal error before step 6.
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
# the pilot: the fresh clone (clone 630 s + git 4 x 90 s + npm ci, always, 930 s) + preflight (~15 min worst) + worker
# 1890 s + re-send 630 s + dry run 630 s + audit 2490 s
PILOT_TIMEOUT=9000
# a stopped pilot passes the stop on and waits for the worker (90 s) or the audit (90 s) to end
PILOT_KILL_AFTER=200
MAX_WINDOW=86400
# the standing pre-authorization (root's policy): its hard ceilings (the setup refuses more), the request files
MAX_PER_DAY=4
MAX_PER_WEEK=20
MAX_POLICY_DAYS=90
REQ_MAX_BYTES=16384
REQ_READ_TIMEOUT=10
# at most this many request names are looked at in one firing (sorted; the rest wait for the next firing)
REQ_MAX_NAMES=40
# at most this many rejection records are kept
REQ_MAX_REJECTED=200
# the per-run image ceiling root checks after a run (the worker's own limit is the owner-pinned worker code's)
MAX_IMAGES=6

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
PILOT_LINE=""
# a: the owner's per-run marker (approval id); b: the standing policy and a request (request id)
KIND=none
REQ_SHA=""
ORIGIN=""

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
# the owner's installed copy (imagefirst-autorun-setup.sh apply): the only place the production script runs from
INSTALL_DIR=/usr/local/lib/sr-imagefirst
TEST_ROOT="${SR_IMAGEFIRST_AUTORUN_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # root never runs the admin clone's scripts any more (DEV-303): the unit starts the installed copy
  say "AUTORUN_NOT_INSTALLED_COPY: runs only from the installed copy $INSTALL_DIR (imagefirst-autorun-setup.sh apply), not from $PROD_CLONE"
  printf 'IMAGEFIRST_AUTORUN AUTORUN_USAGE approval=none pilot=none remote_control=untouched exit=2\n'
  exit 2
elif [ "$REPO" = "$INSTALL_DIR" ]; then
  # The production copy never takes a test hook, and runs only as root.
  if [ -n "$TEST_ROOT" ] || [ "$(id -u)" != 0 ]; then
    say "AUTORUN_TEST_HOOK_REFUSED / not root: runs as root from $INSTALL_DIR inside sr-imagefirst-autorun.service only"
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
    say "runs only from the installed copy $INSTALL_DIR, inside sr-imagefirst-autorun.service"
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
# the test world only (R is empty in the production copy): a stand-in pilot that ends in a given way (exit 137, SIGKILL)
if [ -n "$R" ] && [ -f "$R/pilot-stand-in.sh" ]; then PILOT="$R/pilot-stand-in.sh"; fi
# root's admin clone: only its configured origin URL is read (the test world: its stand-in under the test root)
ADMIN_GIT="$R$PROD_CLONE"
SWITCH="$R/etc/sr-design-worker/imagefirst-autostart.json"
MARKER="$R/etc/sr-design-worker/imagefirst-run.json"
STANDING="$R/etc/sr-design-worker/imagefirst-standing.json"
# root's freeze of standing pickups (a run broke a per-run limit); only the owner's setup standing --unfreeze removes it
FREEZE="$R/var/lib/sr-imagefirst-autostart/standing.frozen"
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

# After a pilot that was killed (its finish, with the copy-back, never ran): the run's config dir, named by the pilot's
# root-owned state file (checked: exactly ~/imagefirst/autorun-<this id>-<UTC>, plus .cfg), handled AS the worker as the
# pilot's stale-dir cleanup does: each sign-in copy newer than its own place goes back (regular files, no link, size), then
# the dir is removed. Only while no process of the worker user runs; otherwise the next run's start does it.
recover_signins() {
  local f="$STATE/autorun-clone" fresh="" stamp cfg uid gid
  [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %s -- "$f")" -le 512 ] || return 0
  fresh="$(head -n 1 -- "$f" | tr -d '\000-\037')"
  stamp="${fresh#"$WORKER_HOME/imagefirst/autorun-$APPROVAL-"}"
  [ -n "$fresh" ] && [ "$stamp" != "$fresh" ] && [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 0
  cfg="$fresh.cfg"
  if busy; then say "the run's sign-in copies are left for the next run's start (busy: $BUSY_WHY)"; return 0; fi
  uid="$(id -u "$WORKER_USER" 2>/dev/null)" && gid="$(id -g "$WORKER_USER" 2>/dev/null)" || return 0
  # shellcheck disable=SC2016
  setpriv --reuid="$uid" --regid="$gid" --init-groups --reset-env --no-new-privs -- env -i HOME="$WORKER_HOME" PATH="$WORKER_PATH" LANG=C.UTF-8 \
    bash -c 'set -u; umask 077; c="$1"
    [ -d "$c" ] && [ ! -L "$c" ] && [ "$(dirname -- "$c")" = "$HOME/imagefirst" ] || exit 0
    back_newer() {
      local s="$1" d="$HOME/$2" dd t
      dd="$(dirname -- "$d")"
      [ -f "$s" ] && [ ! -L "$s" ] && [ "$(stat -c %s -- "$s")" -le 1048576 ] || return 0
      [ -d "$dd" ] && [ ! -L "$dd" ] && [ ! -L "$d" ] || return 0
      [ "$s" -nt "$d" ] || return 0
      if [ -f "$d" ] && cmp -s -- "$s" "$d"; then return 0; fi
      t="$(mktemp -- "$dd/.sr-copyback.XXXXXX")" || return 0
      cat -- "$s" >"$t" && chmod 600 -- "$t" && mv -f -T -- "$t" "$d" || rm -f -- "$t"
    }
    if [ -d "$c/codex" ] && [ ! -L "$c/codex" ]; then back_newer "$c/codex/auth.json" .codex/auth.json; fi
    if [ -d "$c/claude" ] && [ ! -L "$c/claude" ]; then back_newer "$c/claude/.credentials.json" .claude/.credentials.json; fi
    rm -rf -- "$c"' _ "$cfg" 7>&- 8>&- 9>&- && say "the killed pilot's sign-in copies were handled (newer ones copied back; its config dir removed)"
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
        fi
        # the pilot's last line: from its result file (checked above), not from its stdout
        [ -z "$PILOT_LINE" ] || printf '%s\n' "$PILOT_LINE"
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
  # a stop signal interrupts wait (> 128) while the pilot still finishes: wait while it runs, then once more, which returns
  # the child's own saved exit status (bash keeps it for every later wait), never the interrupted wait's. The pilot's
  # last line must match its exit code; a real status above 128 (137, 143) ends the loop at once
  while kill -0 "$CPID" 2>/dev/null; do
    wait "$CPID"
    STEP_RC=$?
  done
  wait "$CPID"
  STEP_RC=$?
  set -e
  CPID=""
  tr -d '\000-\010\013-\037' <"$out" | cut -c1-400
}

# ---------------------------------------------------------------- the installed copy (DEV-303)
# A file of the installed copy: root's and writable by nobody else up to / (trusted_path). The test world: every component
# up to the test root this user's and writable by nobody else.
install_path_ok() {
  local p
  if [ -z "$R" ]; then trusted_path "$1"; return; fi
  p="$(readlink -f -- "$1")" || return 1
  case "$p" in "$R"/*) ;; *) return 1 ;; esac
  while [ "$p" != "$R" ]; do
    [ "$(stat -c %U -- "$p")" = "$FILE_ROOT" ] || return 1
    [ $(( 0$(stat -c %a -- "$p") & 022 )) -eq 0 ] || return 1
    p="$(dirname -- "$p")"
  done
}
# This copy is the installed one, and every file the setup recorded in root's SHA256SUMS (this script, the pilot, its
# preflight, admin.sh and what it sources, the memory check, ...) is a regular file there, trusted, with that SHA-256.
# Sets INSTALL_WHY. The test world checks it only when the script runs from its own installed copy under the test root.
INSTALL_WHY=""
installed_ok() {
  local base="$R$INSTALL_DIR" sums line rel f n=0 need
  sums="$base/SHA256SUMS"
  [ "$REPO" = "$base" ] || { INSTALL_WHY="this copy is not $INSTALL_DIR"; return 1; }
  [ -f "$sums" ] && [ ! -L "$sums" ] && [ "$(stat -c %s -- "$sums")" -le 65536 ] && install_path_ok "$sums" || { INSTALL_WHY="$INSTALL_DIR/SHA256SUMS is missing or not root's only"; return 1; }
  while IFS= read -r line; do
    [[ "$line" =~ ^([0-9a-f]{64})\ \ ([A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*)$ ]] || { INSTALL_WHY="SHA256SUMS has a line not in the form <sha256>  <path>"; return 1; }
    rel="${BASH_REMATCH[2]}"
    case "/$rel/" in */../* | */./*) INSTALL_WHY="SHA256SUMS names $rel"; return 1 ;; esac
    f="$base/$rel"
    [ -f "$f" ] && [ ! -L "$f" ] && install_path_ok "$f" || { INSTALL_WHY="$INSTALL_DIR/$rel is missing, a link, or not root's only up to /"; return 1; }
    [ "$(sha256sum <"$f" | cut -d" " -f1)" = "${BASH_REMATCH[1]}" ] || { INSTALL_WHY="$INSTALL_DIR/$rel is not the copy the setup recorded (SHA-256)"; return 1; }
    n=$((n + 1))
  done <"$sums"
  for need in scripts/sales-design-worker/imagefirst-autorun.sh scripts/sales-design-worker/imagefirst-pilot.sh \
    scripts/sales-design-worker/imagefirst-pilot-preflight.sh scripts/sales-design-capture/admin.sh \
    scripts/sales-design-capture/host-check.sh scripts/ops/wsl-resource-preflight.sh; do
    grep -qE "^[0-9a-f]{64}  ${need//./\\.}\$" -- "$sums" || { INSTALL_WHY="SHA256SUMS does not record $need"; return 1; }
  done
  [ "$n" -gt 0 ]
}

# ---------------------------------------------------------------- the standing pre-authorization (DEV-303)
# Root's policy (root's own file): exactly the keys below, the limits within the setup's ceilings, UTC times at most 90
# days apart, created_at not ahead of now (5 min of clock slack), worker_commit the 40-hex commit the owner pinned. Prints
# OK <per_day> <per_week> <origin|-> <worker_commit>, EXPIRED, or INVALID.
STANDING_PY='
import datetime, json, re, sys
path, now, max_day, max_week, max_days = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
TS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z", re.ASCII)
def bad():
    print("INVALID"); sys.exit(0)
def ts(v):
    if not isinstance(v, str) or not TS.match(v): bad()
    try:
        return int(datetime.datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp())
    except ValueError:
        bad()
def lim(v, top):
    if not isinstance(v, int) or isinstance(v, bool) or v < 1 or v > top: bad()
    return v
try:
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
except Exception:
    bad()
need = {"schema", "per_day", "per_week", "not_after", "created_at", "worker_commit"}
if not isinstance(d, dict) or not need <= set(d) or not set(d) <= need | {"origin_url"}: bad()
if d["schema"] != "sr_imagefirst_standing_v1": bad()
day, week = lim(d["per_day"], max_day), lim(d["per_week"], max_week)
if week < day: bad()
created, until = ts(d["created_at"]), ts(d["not_after"])
if until <= created or until - created > max_days * 86400 or created > now + 300 or until - now > max_days * 86400: bad()
commit = d["worker_commit"]
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit, re.ASCII): bad()
origin = d.get("origin_url", "-")
if origin != "-" and (not isinstance(origin, str) or not re.fullmatch(r"[A-Za-z0-9._:/@+][A-Za-z0-9._:/@+-]*", origin, re.ASCII) or len(origin) > 300): bad()
print("EXPIRED" if until <= now else "OK %d %d %s %s" % (day, week, origin, commit))
'
# A request's envelope, from the bytes the WORKER read for root (root's own work file): only these fields are root's
# business (the rest is the worker's). Prints OK <created_at epoch> or REJECT <reason code>.
REQUEST_PY='
import datetime, json, re, sys
path, rid, cap = sys.argv[1], sys.argv[2], int(sys.argv[3])
def rej(code):
    print("REJECT " + code); sys.exit(0)
try:
    with open(path, "rb") as f:
        b = f.read(cap + 1)
except Exception:
    rej("REQ_UNREADABLE")
if len(b) > cap: rej("REQ_TOO_LARGE")
try:
    d = json.loads(b.decode("utf-8"))
except Exception:
    rej("REQ_NOT_JSON")
if not isinstance(d, dict): rej("REQ_NOT_JSON")
if d.get("schema") != "sr_imagefirst_request_v1": rej("REQ_SCHEMA")
if d.get("id") != rid: rej("REQ_ID_MISMATCH")
s = d.get("shop_id")
if not isinstance(s, str) or not re.fullmatch(r"[a-z0-9_-]{2,41}", s, re.ASCII): rej("REQ_SHOP_ID")
if d.get("kind") not in ("real_shop", "fictional"): rej("REQ_KIND")
c = d.get("created_at")
if not isinstance(c, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", c, re.ASCII): rej("REQ_CREATED_AT")
try:
    t = int(datetime.datetime.strptime(c, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp())
except ValueError:
    rej("REQ_CREATED_AT")
print("OK %d" % t)
'
# a request id always starts with req- (an approval id, hoshigama-imagefirst-..., never does)
REQ_ID_RE='^req-[a-z0-9][a-z0-9-]{2,58}$'
# The worker user's privilege drop for root's reads and notices (as write_review's); never with a file descriptor of root's
as_worker_cmd() {
  local uid gid
  uid="$(id -u "$WORKER_USER" 2>/dev/null)" && gid="$(id -g "$WORKER_USER" 2>/dev/null)" || return 1
  AS_W=(setpriv --reuid="$uid" --regid="$gid" --init-groups --reset-env --no-new-privs -- env -i HOME="$WORKER_HOME" PATH="$WORKER_PATH" LANG=C.UTF-8)
}
# Root's attempts within the last 24 h and 7 days (rolling): every autorun/<id> (the per-run approvals' too), failed or
# not; a record without a readable attempted_at counts at its directory's time (unreadable too: now). Sets DAY_N, WEEK_N.
count_attempts() {
  local d t n age
  DAY_N=0
  WEEK_N=0
  n="$(now)"
  [ -d "$STATE/autorun" ] || return 0
  for d in "$STATE"/autorun/*; do
    [ -e "$d" ] || [ -L "$d" ] || continue
    t=""
    if [ -f "$d/attempt" ] && [ ! -L "$d/attempt" ]; then t="$(sed -n 's/^attempted_at=\([0-9]\{1,12\}\)$/\1/p' -- "$d/attempt" | head -n 1)"; fi
    if [ -z "$t" ]; then
      t="$(stat -c %Y -- "$d" 2>/dev/null)" || t=""
      [[ "$t" =~ ^[0-9]+$ ]] || t="$n"
      say "the attempt record ${d##*/} has no readable attempted_at: its directory's time is counted"
    fi
    age=$((n - t))
    if [ "$age" -lt 604800 ]; then WEEK_N=$((WEEK_N + 1)); fi
    if [ "$age" -lt 86400 ]; then DAY_N=$((DAY_N + 1)); fi
  done
}
seen_id() {
  local x
  for x in autorun rejected used; do
    if [ -e "$STATE/$x/$1" ] || [ -L "$STATE/$x/$1" ]; then return 0; fi
  done
  return 1
}
# An invalid request: root's rejected/<id> (with its reason code; never read again), then the worker's notice
# ~/sr-runs/review-inbox/requests/<id>.rejected, written AS the worker (no link followed, never overwritten, 0600).
reject_request() {
  local id="$1" why="$2"
  mkdir -p -m 0700 "$STATE/rejected"
  # bounded: past REQ_MAX_REJECTED records nothing more is recorded (an unrecorded bad request is skipped again next time)
  if [ "$(find "$STATE/rejected" -mindepth 1 -maxdepth 1 | wc -l)" -ge "$REQ_MAX_REJECTED" ]; then
    say "request $id is invalid ($why), but rejected/ holds $REQ_MAX_REJECTED records already: not recorded (skipped)"
    return 0
  fi
  mkdir -m 0700 "$STATE/rejected/$id" 2>/dev/null || return 0
  printf 'request_id=%s\nreason=%s\nrejected_at=%s\n' "$id" "$why" "$(now)" >"$STATE/rejected/$id/reason"
  say "request $id rejected: $why (never read again)"
  # shellcheck disable=SC2016
  timeout --kill-after=5 "$REQ_READ_TIMEOUT" "${AS_W[@]}" bash -c 'set -u; umask 077; r="$HOME/sr-runs"; d="$r/review-inbox/requests"
    for p in "$r" "$r/review-inbox" "$d"; do
      if [ ! -e "$p" ] && [ ! -L "$p" ] && [ "$p" != "$r" ]; then mkdir -m 700 -- "$p" || exit 3; fi
      [ -d "$p" ] && [ ! -L "$p" ] || exit 3
    done
    f="$d/$1.rejected"
    if [ -e "$f" ] || [ -L "$f" ]; then exit 4; fi
    t="$(mktemp -- "$d/.rejected.XXXXXX")" || exit 3
    printf "IMAGEFIRST_REQUEST_REJECTED id=%s reason=%s\n" "$1" "$2" >"$t" && chmod 600 -- "$t" && ln -- "$t" "$f"; rc=$?; rm -f -- "$t"; exit "$rc"' _ "$id" "$why" </dev/null 7>&- 8>&- 9>&- ||
    say "the worker's notice for $id is not written (no ~/sr-runs, a link, or it exists already)"
}
# The requests, read AS THE WORKER (a pipe into root's own work files; root opens no file of the worker): the names, then
# each unseen one (a regular file, no link, at most REQ_MAX_BYTES), its envelope checked. The oldest valid one (created_at,
# then id) is copied into root's requests/<id>.json (0600). Sets APPROVAL (the request id) and REQ_SHA; returns 1 if none.
pick_request() {
  local names="$WORK/req-names" valid="$WORK/req-valid" n=0 id f rc got chosen
  : >"$valid"
  # shellcheck disable=SC2016
  timeout --kill-after=5 "$REQ_READ_TIMEOUT" "${AS_W[@]}" bash -c 'set -u; r="$HOME/sr-runs"; d="$r/requests"
    for p in "$r" "$d"; do [ -d "$p" ] && [ ! -L "$p" ] || exit 3; done
    cd -- "$d" || exit 3
    for f in *.json; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\0" "$f"; fi; done' </dev/null >"$names" 2>/dev/null 7>&- 8>&- 9>&- || return 1
  while IFS= read -r -d '' f; do
    id="${f%.json}"
    [[ "$f" == *.json ]] && [[ "$id" =~ $REQ_ID_RE ]] || continue
    seen_id "$id" && continue
    n=$((n + 1))
    [ "$n" -le "$REQ_MAX_NAMES" ] || break
    rc=0
    # shellcheck disable=SC2016
    timeout --kill-after=5 "$REQ_READ_TIMEOUT" "${AS_W[@]}" bash -c 'set -u; f="$HOME/sr-runs/requests/$1.json"
      [ -f "$f" ] && [ ! -L "$f" ] || exit 3
      exec head -c "$2" -- "$f"' _ "$id" "$((REQ_MAX_BYTES + 1))" </dev/null >"$WORK/req.$id" 2>/dev/null 7>&- 8>&- 9>&- || rc=$?
    case "$rc" in
      0) ;;
      3) reject_request "$id" REQ_NOT_REGULAR; continue ;;
      *) reject_request "$id" REQ_UNREADABLE; continue ;;
    esac
    if [ "$(stat -c %s -- "$WORK/req.$id")" -gt "$REQ_MAX_BYTES" ]; then reject_request "$id" REQ_TOO_LARGE; continue; fi
    got="$(python3 -I -c "$REQUEST_PY" "$WORK/req.$id" "$id" "$REQ_MAX_BYTES" 7>&- 8>&- 9>&-)" || got="REJECT REQ_UNREADABLE"
    case "$got" in
      "OK "*) printf '%s %s\n' "${got#OK }" "$id" >>"$valid" ;;
      "REJECT "*) reject_request "$id" "${got#REJECT }" ;;
      *) reject_request "$id" REQ_UNREADABLE ;;
    esac
  done <"$names"
  chosen="$(LC_ALL=C sort -k1,1n -k2,2 -- "$valid" | head -n 1)"
  [ -n "$chosen" ] || return 1
  APPROVAL="${chosen#* }"
  mkdir -p -m 0700 "$STATE/requests"
  cp -- "$WORK/req.$APPROVAL" "$STATE/requests/.$APPROVAL.json.tmp"
  chmod 0600 -- "$STATE/requests/.$APPROVAL.json.tmp"
  mv -f -T -- "$STATE/requests/.$APPROVAL.json.tmp" "$STATE/requests/$APPROVAL.json"
  REQ_SHA="$(sha256sum <"$STATE/requests/$APPROVAL.json" | cut -d" " -f1)"
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

# ---------------------------------------------------------------- 3. the standing policy (if any), then (a) the run marker, else (b) a request
# The policy first: while one is present it must be safe and valid (else nothing runs at all, the marker's run neither),
# and while it is in force its owner-pinned worker_commit is the ONLY worker code any run executes.
STANDING_OK=0
POLICY_STATE=absent
POLICY_ORIGIN=-
WORKER_COMMIT=""
if [ -e "$STANDING" ] || [ -L "$STANDING" ]; then
  owner_file "$STANDING" || { say "AUTORUN_STANDING_UNSAFE: the standing policy must be a root-owned regular file nobody else can write: nothing runs"; finish AUTORUN_STANDING_UNSAFE 2; }
  policy="$(python3 -I -c "$STANDING_PY" "$STANDING" "$(now)" "$MAX_PER_DAY" "$MAX_PER_WEEK" "$MAX_POLICY_DAYS" 7>&- 8>&- 9>&-)" || policy=INVALID
  case "$policy" in
    "OK "*) read -r PER_DAY PER_WEEK POLICY_ORIGIN WORKER_COMMIT <<<"${policy#OK }"; STANDING_OK=1; POLICY_STATE=ok ;;
    EXPIRED) POLICY_STATE=expired ;;
    *) say "AUTORUN_STANDING_INVALID: expected exactly {\"schema\": \"sr_imagefirst_standing_v1\", \"per_day\": 1-$MAX_PER_DAY, \"per_week\": 1-$MAX_PER_WEEK, \"not_after\", \"created_at\", \"worker_commit\"[, \"origin_url\"]} (at most $MAX_POLICY_DAYS days): nothing runs"; finish AUTORUN_STANDING_INVALID 2 ;;
  esac
fi
IDLE_CODE=AUTORUN_IDLE_NO_MARKER
if [ -e "$MARKER" ] || [ -L "$MARKER" ]; then
  owner_file "$MARKER" || { say "AUTORUN_MARKER_UNSAFE: the run marker must be a root-owned regular file nobody else can write"; finish AUTORUN_MARKER_UNSAFE 2; }
  marker="$(python3 -I -c "$MARKER_PY" "$MARKER" "$(now)" "$MAX_WINDOW" 7>&- 8>&- 9>&-)" || marker=INVALID
  case "$marker" in
    "OK "*) APPROVAL="${marker#OK }"
      if [ -e "$STATE/used/$APPROVAL" ] || [ -L "$STATE/used/$APPROVAL" ]; then IDLE_CODE=AUTORUN_IDLE_MARKER_USED
      elif [ -e "$STATE/autorun/$APPROVAL" ] || [ -L "$STATE/autorun/$APPROVAL" ]; then IDLE_CODE=AUTORUN_IDLE_ATTEMPTED
      else KIND=approval
      fi ;;
    "EXPIRED "*) APPROVAL="${marker#EXPIRED }"; IDLE_CODE=AUTORUN_IDLE_MARKER_EXPIRED ;;
    "TOO_FAR "*) APPROVAL="${marker#TOO_FAR }"; say "AUTORUN_MARKER_TOO_FAR: expires_at more than 24 h ahead"; finish AUTORUN_MARKER_INVALID 2 ;;
    *) say "AUTORUN_MARKER_INVALID: expected exactly {\"approval_id\": \"hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN\", \"expires_at\": \"<UTC>Z\"}"; finish AUTORUN_MARKER_INVALID 2 ;;
  esac
fi
if [ "$KIND" = none ]; then
  # no per-run approval due: the owner's standing pre-authorization, if there is one (absent: nothing due, as before)
  [ "$POLICY_STATE" != absent ] || finish "$IDLE_CODE" 10
  APPROVAL=none
  if [ "$POLICY_STATE" = expired ]; then say "the standing pre-authorization has expired (not_after): nothing runs until the owner sets a new one"; finish AUTORUN_IDLE_STANDING_EXPIRED 10; fi
  # frozen by root after a run broke a per-run limit: only the owner clears it (setup standing --unfreeze --yes)
  if [ -e "$FREEZE" ] || [ -L "$FREEZE" ]; then say "AUTORUN_STANDING_FROZEN: a run broke a per-run limit ($(head -c 200 -- "$FREEZE" 2>/dev/null | tr -d '\000-\037')): no request is picked up until the owner runs standing --unfreeze --yes"; finish AUTORUN_STANDING_FROZEN 2; fi
  KIND=request
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

# ---------------------------------------------------------------- 5. the installed copy; (b) the limits and a request; the commit pinned
# The production copy: always its own installed copy, each file the one the setup recorded. The test world checks it only
# when it runs from its own installed copy under the test root.
if [ -z "$R" ] || [ "$REPO" = "$R$INSTALL_DIR" ]; then
  installed_ok || { say "AUTORUN_INSTALL_UNTRUSTED: $INSTALL_WHY (run the setup's check, then apply)"; finish AUTORUN_INSTALL_UNTRUSTED 2; }
fi
if [ "$KIND" = request ]; then
  count_attempts
  if [ "$DAY_N" -ge "$PER_DAY" ] || [ "$WEEK_N" -ge "$PER_WEEK" ]; then
    say "the standing limit is reached ($DAY_N in 24 h of $PER_DAY, $WEEK_N in 7 days of $PER_WEEK): nothing read, nothing runs"
    finish AUTORUN_IDLE_QUOTA 10
  fi
  as_worker_cmd || { say "AUTORUN_NO_WORKER_USER: $WORKER_USER"; finish AUTORUN_NO_WORKER_USER 2; }
  if ! pick_request; then APPROVAL=none; finish AUTORUN_IDLE_NO_REQUEST 10; fi
  say "request $APPROVAL is the oldest valid one (root's copy, SHA-256 recorded; $DAY_N in 24 h of $PER_DAY, $WEEK_N in 7 days of $PER_WEEK)"
fi
# The commit the run executes (the only worker code it runs outside the jail):
#   - while the standing policy is in force (request runs AND per-run approvals): the policy's worker_commit, which the owner
#     pinned with setup standing --expect <commit> (never develop's tip, never another commit). Root first checks the origin
#     still has it (a fetch of exactly that commit into root's own throw-away repository, as root, nothing run): if not,
#     AUTORUN_STANDING_COMMIT_UNAVAILABLE and nothing is attempted or spent;
#   - without a standing policy (a per-run approval only, as before DEV-303): root's admin clone, clean, with its HEAD exactly
#     origin's develop (the commit the owner checked out), asked again after the idle wait (moved: no pilot).
# The origin URL: the policy's origin_url (when it names one), else root's admin clone's configured URL (only that value).
ADMIN_NOW=""
ADMIN_REMOTE=""
admin_commit() {
  local head dirty url remote
  head="$(git -C "$ADMIN_GIT" rev-parse HEAD 2>/dev/null)" || return 1
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || return 1
  dirty="$(git -C "$ADMIN_GIT" --no-optional-locks status --porcelain --untracked-files=normal 2>/dev/null)" || return 1
  [ -z "$dirty" ] || return 2
  url="$(git -C "$ADMIN_GIT" config --get remote.origin.url 2>/dev/null)" || return 1
  [[ "$url" =~ ^[A-Za-z0-9._:/@+][A-Za-z0-9._:/@+-]*$ ]] || return 1
  remote="$(timeout --kill-after="$KILL_AFTER" "$ADMIN_FETCH_TIMEOUT" git -C "$ADMIN_GIT" -c protocol.ext.allow=never ls-remote "$url" refs/heads/develop 2>/dev/null 7>&- 8>&- 9>&-)" || return 3
  ADMIN_REMOTE="${remote%%[[:space:]]*}"
  [[ "$ADMIN_REMOTE" =~ ^[0-9a-f]{40}$ ]] || return 3
  [ "$head" = "$ADMIN_REMOTE" ] || return 4
  ADMIN_NOW="$head"
}
if [ "$STANDING_OK" = 1 ] && [ "$POLICY_ORIGIN" != - ]; then ORIGIN="$POLICY_ORIGIN"
else ORIGIN="$(git -C "$ADMIN_GIT" config --get remote.origin.url 2>/dev/null)" || ORIGIN=""
fi
if ! [[ "$ORIGIN" =~ ^[A-Za-z0-9._:/@+][A-Za-z0-9._:/@+-]*$ ]]; then say "AUTORUN_ORIGIN_UNREADABLE: no plain origin URL (the policy's origin_url or $PROD_CLONE's)"; finish AUTORUN_ORIGIN_UNREADABLE 2; fi
RECHECK_ADMIN=0
if [ "$STANDING_OK" = 1 ]; then
  ADMIN_SHA="$WORKER_COMMIT"
  probe="$WORK/commit-probe"
  if ! { git init -q --bare -- "$probe" >/dev/null 2>&1 7>&- 8>&- 9>&- &&
    timeout --kill-after="$KILL_AFTER" "$ADMIN_FETCH_TIMEOUT" git -C "$probe" -c protocol.ext.allow=never fetch -q --no-tags --depth=1 "$ORIGIN" "$ADMIN_SHA" >/dev/null 2>&1 7>&- 8>&- 9>&- &&
    git -C "$probe" cat-file -e "$ADMIN_SHA^{commit}" 2>/dev/null; }; then
    say "AUTORUN_STANDING_COMMIT_UNAVAILABLE: the origin does not have the owner-pinned worker commit $ADMIN_SHA (or is unreachable): nothing attempted. The owner pins another with setup standing --yes --expect <commit> ..."
    finish AUTORUN_STANDING_COMMIT_UNAVAILABLE 20
  fi
  rm -rf -- "$probe"
else
  arc=0
  admin_commit || arc=$?
  case "$arc" in
    0) ADMIN_SHA="$ADMIN_NOW"; RECHECK_ADMIN=1 ;;
    2) say "AUTORUN_ADMIN_CLONE_DIRTY: $PROD_CLONE has changes"; finish AUTORUN_ADMIN_CLONE_DIRTY 2 ;;
    3) say "origin's develop could not be read from the admin clone's URL: nothing done (Remote Control untouched)"; finish AUTORUN_STOP_ADMIN_FETCH 20 ;;
    4) say "AUTORUN_ADMIN_NOT_DEVELOP: the admin clone is not at origin's develop $ADMIN_REMOTE (Remote Control untouched). Run: sudo git -C $PROD_CLONE fetch -q origin && sudo git -C $PROD_CLONE checkout -q --detach origin/develop"
      finish AUTORUN_ADMIN_NOT_DEVELOP 2 ;;
    *) say "AUTORUN_ADMIN_CLONE_UNREADABLE: $PROD_CLONE"; finish AUTORUN_ADMIN_CLONE_UNREADABLE 2 ;;
  esac
fi

# ---------------------------------------------------------------- 6. the intent, then Remote Control stopped
mkdir -p -m 0700 "$STATE/autorun"
if ! mkdir -m 0700 "$STATE/autorun/$APPROVAL" 2>/dev/null; then finish AUTORUN_IDLE_ATTEMPTED 10; fi
if [ "$KIND" = request ]; then
  printf 'request_id=%s\nkind=standing\nattempted_at=%s\ncommit=%s\nrequest_sha256=%s\n' "$APPROVAL" "$(now)" "$ADMIN_SHA" "$REQ_SHA" >"$STATE/autorun/$APPROVAL/attempt"
else
  printf 'approval_id=%s\nattempted_at=%s\ncommit=%s\n' "$APPROVAL" "$(now)" "$ADMIN_SHA" >"$STATE/autorun/$APPROVAL/attempt"
fi
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
say "$KIND $APPROVAL is due (commit $ADMIN_SHA pinned): one attempt (recorded); stopping Remote Control (admin.sh claude-stop; was enabled: $was_enabled)"
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

# ---------------------------------------------------------------- 7. the existing pilot once, pinned to root's commit (never re-compared with develop)
# without a standing policy (as before DEV-303): root's admin clone and origin's develop again; moved: no pilot
if [ "$RECHECK_ADMIN" = 1 ]; then
  arc=0
  admin_commit || arc=$?
  if [ "$arc" -ne 0 ] || [ "$ADMIN_NOW" != "$ADMIN_SHA" ]; then
    say "the admin clone or origin's develop changed since the check (was $ADMIN_SHA): no pilot (nothing used)"
    finish AUTORUN_STOP_DEVELOP_MOVED 1
  fi
fi
say "the pilot: $PILOT"
PILOT_ENV=(env)
if [ -n "$R" ]; then PILOT_ENV+=("SR_IMAGEFIRST_PILOT_TEST_ROOT=$R"); fi
# The pilot's result: its own result file (root's, in root's 0700 state, written by the pilot as its last act with a
# temporary file and a rename), read only after the pilot has been reaped. Not its stdout or the exit status that comes
# back through timeout(1): some timeout(1)s exit 143 after passing on a stop, whatever the pilot returned (PR #325 CI)
RESULT="$STATE/autorun-result"
rm -f -- "$RESULT" "$STATE"/.autorun-result.* "$STATE/autorun-clone" "$STATE/autorun-commit"
if [ "$KIND" = request ]; then
  step "$WORK/pilot" "$PILOT_TIMEOUT" "${PILOT_ENV[@]}" bash "$PILOT" --autorun-request "$APPROVAL" "$ADMIN_SHA" "$ORIGIN" "$REQ_SHA"
else
  step "$WORK/pilot" "$PILOT_TIMEOUT" "${PILOT_ENV[@]}" bash "$PILOT" --autorun "$APPROVAL" "$ADMIN_SHA" "$ORIGIN"
fi
pline=""
PILOT_RC=none
if [ -f "$RESULT" ] && [ ! -L "$RESULT" ] && [ "$(stat -c %s -- "$RESULT")" -le 512 ]; then pline="$(head -n 1 -- "$RESULT" | tr -d '\000-\037')"; fi
if [[ "$pline" =~ ^IMAGEFIRST_PILOT\ ([A-Z_]+)\ phase=(before_claim|after_claim)\ approval=$APPROVAL\ exit=([0-9]+)$ ]]; then
  PILOT_CODE="${BASH_REMATCH[1]}"
  PILOT_RC="${BASH_REMATCH[3]}"
  PILOT_LINE="$pline"
else
  PILOT_CODE=PILOT_NO_RESULT
fi
# a pilot that was killed (no result, or the step ended by a signal) never ran its copy-back: the run's sign-in copies the
# CLIs may have refreshed go back now (before Remote Control returns), else the next run's start does it
if [ "$PILOT_CODE" = PILOT_NO_RESULT ] || [ "$STEP_RC" -ge 128 ]; then recover_signins || true; fi
# The per-run image ceiling, checked by root after the run (the worker's own limits are the owner-pinned worker code's):
# once the worker may have started, the run's pictures are counted AS THE WORKER (its run directory's parts/ and the
# inbox copy of its bundle; image files only). More than MAX_IMAGES, or no count: AUTORUN_IMAGE_CAP_EXCEEDED, and root's
# freeze file stops every further standing pick-up until the owner's setup standing --unfreeze --yes.
if [[ "$pline" == *" phase=after_claim "* ]] || [ "$PILOT_CODE" = PILOT_NO_RESULT ]; then
  IMG_N=""
  if ! busy && as_worker_cmd; then
    # shellcheck disable=SC2016
    IMG_N="$(timeout --kill-after=5 30 "${AS_W[@]}" bash -c 'set -u; id="$1"; r="$HOME/sr-runs"; n=0
      [ -d "$r" ] && [ ! -L "$r" ] || { echo 0; exit 0; }
      for d in "$r/$id"-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z/parts "$r/review-inbox/$id"; do
        [ -d "$d" ] && [ ! -L "$d" ] || continue
        c="$(find "$d" -type f \( -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.webp" -o -iname "*.gif" \) | wc -l)" || exit 3
        if [ "$c" -gt "$n" ]; then n="$c"; fi
      done
      echo "$n"' _ "$APPROVAL" </dev/null 2>/dev/null 7>&- 8>&- 9>&-)" || IMG_N=""
  fi
  if ! [[ "$IMG_N" =~ ^[0-9]+$ ]] || [ "$IMG_N" -gt "$MAX_IMAGES" ]; then
    why="${IMG_N:-uncountable} images (at most $MAX_IMAGES)"
    printf 'frozen_at=%s\nid=%s\nreason=AUTORUN_IMAGE_CAP_EXCEEDED %s\n' "$(now)" "$APPROVAL" "$why" >"$FREEZE"
    say "AUTORUN_IMAGE_CAP_EXCEEDED: the run of $APPROVAL left $why: standing pick-ups are FROZEN until the owner runs standing --unfreeze --yes"
    finish AUTORUN_IMAGE_CAP_EXCEEDED 1
  fi
  say "images of this run: $IMG_N (at most $MAX_IMAGES)"
fi
if [ "$INTERRUPTED" = 1 ]; then finish AUTORUN_INTERRUPTED 1; fi
if [ "$PILOT_RC" = 0 ] && [ "$PILOT_CODE" = PILOT_DONE ]; then finish AUTORUN_DONE 0; fi
say "the pilot ended $PILOT_CODE (its exit $PILOT_RC; the step returned $STEP_RC): never retried"
finish AUTORUN_PILOT_STOPPED 1
}
