#!/usr/bin/env bash
# Second Root IMAGE_FIRST pilot preflight (Issue #302): the READ-ONLY check before the owner's one limited ほし窯 d3 (or d4) pilot
# (scripts/sales-design-worker/imagefirst-pilot.sh, docs/operations/imagefirst-pilot.md). It changes nothing: no
# systemd unit, timer, switch, marker, claim, ledger or file of the worker is created, changed or removed. Its only
# writes are git's own refs/remotes/origin/develop in the worker's clone (the fetch, run as the worker) and a temporary
# directory of root's that it removes. It starts no generation and no model call.
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot-preflight.sh <approval id>
#
# Run by root, only from the root-only admin clone (/root/sr-capture-admin). Root never runs git, node or a parser on files
# the worker user controls: every command in the worker's clone runs as the worker user, with the automatic start's
# privilege drop (copied verbatim; a test pins it), outside the jail. Fail closed: any error, missing answer or
# unexpected state is FAIL. The checks, one row each:
#   resource     scripts/ops/wsl-resource-preflight.sh: OK or SERIAL (one heavy job) pass, STOP fails
#   disk         at least MIN_FREE_MIB free on the worker's home file system
#   exclusion    the automatic start's busy() (copied verbatim): sr-jail-claude inactive / failed AND disabled or masked,
#                sr-design-cycle inactive / failed, no process of the worker user
#   timers       sr-design-cycle.timer, sr-imagefirst-autostart.timer and .service, sr-imagefirst-autorun.timer and .service
#                neither active nor enabled (or not installed). Only when this process itself runs inside
#                sr-imagefirst-autorun.service (its own cgroup, read from the kernel: no argument or variable selects it;
#                docs/operations/imagefirst-autorun.md) are exactly that service (activating / active: this run) and its timer
#                accepted; every other unit is checked the same way
#   clone        as the worker: git fetch origin develop (the automatic start's line), the tree clean, HEAD = origin/develop
#   no_prior_run as the worker: no claim, receipt, run, delivery job, inbox copy or audit for this approval id
#   rubric       the clone's audit is rubric v2 (AUDIT_RUBRIC_VERSION if-claude-audit-v2, schema imagefirst_claude_audit_v2)
#   approval     the worker's own --precheck (the automatic start's line, with this approval id as the grant): "would_run"
#                for exactly this id (the packet at HEAD approved for it, inside its window, the pins, never claimed,
#                unused in the ledger), and at least MIN_LEFT_SECONDS (20 min) before the expiry it reports. It writes nothing
#   codex        as the worker: the codex binary on its PATH, ~/.codex/auth.json present (never read or printed), no
#                ~/.codex/.env in any form, then imagefirst-worker.ts --check-codex-auth-only (the generation path's own
#                sandbox and one sandboxed sign-in status read: an API-key login or a broken sandbox fails here, before
#                any approval is used; no model call)
# The production copy also refuses (exit 2) unless root's admin clone is clean and this script and the memory check it runs
# are root's and writable by nobody else up to / (the automatic start's trusted_path).
#   claude_bin   as the worker: claude on its PATH outside the jail
#   claude_auth  as the worker: imagefirst-audit.ts --check-auth-only (claude-cli.ts's `auth status` check: the
#                claude.ai subscription, first party, no API key). No model call
# After a FAIL in exclusion or timers nothing runs as the worker (the later rows FAIL as "skipped").
#
# Output: one table row per check (name, PASS / FAIL, a short reason; never a secret, a file's contents or a prompt). The
# last line is machine-readable:
#   IMAGEFIRST_PILOT_PREFLIGHT <PASS|FAIL|USAGE> approval=<id|none> failed=<n> exit=<n>
# Exit: 0 every row PASS, 20 any FAIL, 2 usage.
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
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SR_IMAGEFIRST_PILOT_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec /usr/bin/env -i "${keep[@]}" /bin/bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
umask 077
cd /

KILL_AFTER=30
FETCH_TIMEOUT=180
GIT_TIMEOUT=60
PRECHECK_TIMEOUT=300
AUTH_TIMEOUT=120
# the run writes six pictures, previews, a bundle and its inbox copy (tens of MiB); a wide margin
MIN_FREE_MIB=4096
# the pilot starts only with at least 20 min of the approval left (the worker's own precheck asks for 5)
MIN_LEFT_SECONDS=1200
GRANT_ENV=SR_IMAGEFIRST_EXPECT_APPROVAL_ID

APPROVAL=none
FINISHED=0
FAILS=0
WORK=""

say() { printf 'imagefirst-pilot-preflight: %s\n' "$*"; }
finish() {
  local verdict="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  [ -z "$WORK" ] || rm -rf "$WORK"
  printf 'IMAGEFIRST_PILOT_PREFLIGHT %s approval=%s failed=%s exit=%s\n' "$verdict" "$APPROVAL" "$FAILS" "$rc"
  exit "$rc"
}
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return
  say "stopped by an unexpected error (exit $rc)"
  FAILS=$((FAILS + 1))
  finish FAIL 20
}
on_signal() {
  say "stopped by a signal before every check had run (nothing was started)"
  FAILS=$((FAILS + 1))
  finish FAIL 20
}
trap on_exit EXIT
trap on_signal INT TERM HUP
# One row: name, PASS or FAIL, a short reason (control characters removed, cut).
row() {
  local why
  why="$(printf '%s' "$3" | tr -d '\000-\037' | cut -c1-240)"
  printf 'imagefirst-pilot-preflight: | %-12s | %-4s | %s\n' "$1" "$2" "$why"
  [ "$2" = PASS ] || FAILS=$((FAILS + 1))
}

# ---------------------------------------------------------------- the approval id
[ "$#" -eq 1 ] || { say "usage: imagefirst-pilot-preflight.sh <approval id>"; finish USAGE 2; }
[[ "$1" =~ ^hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}$ ]] || { say "PREFLIGHT_ID_INVALID: expected hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN"; finish USAGE 2; }
APPROVAL="$1"
[[ "$APPROVAL" != hoshigama-imagefirst-d[34]-00000000-* ]] || { say "PREFLIGHT_ID_RESERVED: the date 00000000 is the dummy PoC's, never a real run's"; finish USAGE 2; }

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
TEST_ROOT="${SR_IMAGEFIRST_PILOT_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || { say "PREFLIGHT_TEST_HOOK_REFUSED: test hooks are refused in $PROD_CLONE"; finish USAGE 2; }
  [ "$(id -u)" = 0 ] || { say "run as root: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-pilot-preflight.sh <approval id>"; finish USAGE 2; }
  R=""
  WORKER_USER=sr-designgen
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  WORKER_PATH=/usr/local/bin:/usr/bin:/bin
else
  # Any other copy runs only the unit tests' fake WSL (tests/unit/design-agent/imagefirst-worker/pilot.test.ts).
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || { say "run from the root-only clone: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-pilot-preflight.sh <approval id>"; finish USAGE 2; }
  R="$TEST_ROOT"
  WORKER_USER="$(id -un)"
  WORKER_PATH="$PATH"
  # the test world's memory and free-space figures
  if [ -f "$R/proc/meminfo" ]; then export SR_PREFLIGHT_MEMINFO="$R/proc/meminfo"; fi
  if [ -f "$R/min-free-mib" ]; then MIN_FREE_MIB="$(cat "$R/min-free-mib")"; fi
fi
WORKER_HOME="$R/home/sr-designgen"
CLONE="$WORKER_HOME/imagefirst/second-root"
WORK="$(mktemp -d)"

in_clone() { "${AS_WORKER[@]}" "$@" 8>&- 9>&-; }
now() {
  if [ -n "$R" ] && [ -f "$R/clock" ]; then cat "$R/clock"; else date +%s; fi
}

# The file and every directory above it owned by root and writable by nobody else (as cycle.sh / admin.sh).
# (Verbatim from imagefirst-autostart.sh.)
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
# The production copy: root's admin clone must be root's own, clean, and the files root runs from it trusted (review M1).
if [ -z "$R" ]; then
  for f in "$SELF" "$REPO/scripts/ops/wsl-resource-preflight.sh"; do
    trusted_path "$f" || { say "PREFLIGHT_ADMIN_CLONE_UNTRUSTED: $f must be root's and writable by nobody else, up to /"; finish USAGE 2; }
  done
  admin_dirty="$(git -C "$REPO" status --porcelain --untracked-files=normal 2>/dev/null)" || admin_dirty="unreadable"
  [ -z "$admin_dirty" ] || { say "PREFLIGHT_ADMIN_CLONE_DIRTY: $REPO has changes (check it out detached at the approved commit first)"; finish USAGE 2; }
  say "admin clone $REPO at $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown) (clean)"
fi

# Busy unless both units are stopped and the worker user runs nothing. Fail closed: an error or any other state is busy.
# (Verbatim from imagefirst-autostart.sh; pilot.test.ts pins that the two stay identical.)
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

# A unit that must not start on its own during the pilot: not active, and not enabled (or not installed at all). Read only.
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

# Whether this process runs inside sr-imagefirst-autorun.service: its own cgroup v2 line, read from the kernel (the test
# world: a file under its root; test hooks are refused in the production copy). Nothing the caller passes selects it.
AUTORUN_CGROUP="0::/system.slice/sr-imagefirst-autorun.service"
own_cgroup() {
  if [ -n "$R" ]; then cat -- "$R/proc/self/cgroup" 2>/dev/null || true; else cat /proc/self/cgroup 2>/dev/null || true; fi
}
IN_AUTORUN=0
if [[ $'\n'"$(own_cgroup)"$'\n' == *$'\n'"$AUTORUN_CGROUP"$'\n'* ]]; then IN_AUTORUN=1; fi

say "approval $APPROVAL; read only: nothing is installed, enabled, started, claimed or generated"

# ---------------------------------------------------------------- resource (the WSL memory check)
set +e
res="$(bash "$REPO/scripts/ops/wsl-resource-preflight.sh" 2>&1 8>&- 9>&-)"
rrc=$?
set -e
# the first line, without a pipe (head closing early would SIGPIPE the writer, a failure under pipefail)
mem="${res%%$'\n'*}"
case "$rrc" in
  0) row resource PASS "OK: $mem" ;;
  10) row resource PASS "SERIAL (one heavy job at a time; the pilot is one): $mem" ;;
  *) row resource FAIL "exit $rrc (STOP: do not start): $mem" ;;
esac

# ---------------------------------------------------------------- disk
free_kib="$(df -Pk -- "$WORKER_HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')" || free_kib=""
if [[ "$free_kib" =~ ^[0-9]+$ ]] && [[ "$MIN_FREE_MIB" =~ ^[0-9]+$ ]] && [ $((free_kib / 1024)) -ge "$MIN_FREE_MIB" ]; then
  row disk PASS "$((free_kib / 1024)) MiB free (at least $MIN_FREE_MIB)"
else
  row disk FAIL "free space unreadable or under $MIN_FREE_MIB MiB (${free_kib:-?} KiB)"
fi

# ---------------------------------------------------------------- mutual exclusion and the timers
IDLE=1
if busy; then row exclusion FAIL "$BUSY_WHY"; IDLE=0; else row exclusion PASS "sr-jail-claude stopped and disabled/masked, sr-design-cycle stopped, no $WORKER_USER process"; fi
UNITS_OK=1
for u in sr-design-cycle.timer sr-imagefirst-autostart.timer sr-imagefirst-autostart.service; do
  if ! unit_off "$u"; then UNITS_OK=0; break; fi
done
if [ "$UNITS_OK" = 1 ] && [ "$IN_AUTORUN" = 1 ]; then
  # inside the automatic run: its own service must be this run (a oneshot is "activating" while it runs); its timer fired it
  st="$(systemctl show -p ActiveState --value sr-imagefirst-autorun.service 2>/dev/null)" || st=error
  if [[ "$st" =~ ^(activating|active)$ ]]; then
    row timers PASS "sr-design-cycle.timer, sr-imagefirst-autostart.timer/.service off; inside sr-imagefirst-autorun.service ($st)"
  else
    row timers FAIL "the cgroup says sr-imagefirst-autorun.service, but the service is ${st:-unknown}"; IDLE=0
  fi
elif [ "$UNITS_OK" = 1 ]; then
  for u in sr-imagefirst-autorun.timer sr-imagefirst-autorun.service; do
    if ! unit_off "$u"; then UNITS_OK=0; break; fi
  done
  if [ "$UNITS_OK" = 1 ]; then row timers PASS "sr-design-cycle.timer, sr-imagefirst-autostart.timer/.service, sr-imagefirst-autorun.timer/.service off"; else row timers FAIL "$UNIT_WHY"; IDLE=0; fi
else
  row timers FAIL "$UNIT_WHY"; IDLE=0
fi

skip_rest() {
  local n
  for n in clone no_prior_run rubric approval codex claude_bin claude_auth; do row "$n" FAIL "skipped: $1"; done
  finish FAIL 20
}
[ "$IDLE" = 1 ] || skip_rest "not idle (nothing is run as the worker)"

# ---------------------------------------------------------------- the worker's clone (as the worker)
worker_uid="$(id -u "$WORKER_USER" 2>/dev/null)" && worker_gid="$(id -g "$WORKER_USER" 2>/dev/null)" || skip_rest "no user $WORKER_USER"
AS_WORKER=(setpriv --reuid="$worker_uid" --regid="$worker_gid" --init-groups --reset-env --no-new-privs -- env -i HOME="$WORKER_HOME" PATH="$WORKER_PATH" LANG=C.UTF-8)
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
  if [ -n "${!name+x}" ]; then AS_WORKER+=("$name=${!name}"); fi
done
AS_WORKER+=(bash -c 'cd -- "$1" || exit 97; shift; exec "$@"' _ "$CLONE")
CLONE_OK=0
if [ ! -d "$CLONE" ]; then
  row clone FAIL "$CLONE is missing"
elif ! in_clone timeout --kill-after="$KILL_AFTER" "$FETCH_TIMEOUT" git fetch --quiet --no-tags origin "+refs/heads/develop:refs/remotes/origin/develop" >/dev/null 2>&1; then
  row clone FAIL "git fetch failed (as $WORKER_USER)"
elif ! dirty="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git status --porcelain --untracked-files=all 2>/dev/null)"; then
  row clone FAIL "git status failed"
elif [ -n "$dirty" ]; then
  row clone FAIL "the clone has changes (nothing is cleaned automatically)"
else
  head="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse HEAD 2>/dev/null)" || head=""
  base="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse origin/develop 2>/dev/null)" || base=""
  if [[ "$head" =~ ^[0-9a-f]{40}$ ]] && [ "$head" = "$base" ]; then
    row clone PASS "clean, HEAD = origin/develop = $head"
    CLONE_OK=1
  elif [[ "$head" =~ ^[0-9a-f]{40}$ ]] && in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git merge-base --is-ancestor HEAD origin/develop >/dev/null 2>&1; then
    row clone FAIL "HEAD $head is behind origin/develop ${base:-?}: run imagefirst-pilot.sh --sync-clone first"
  else
    row clone FAIL "HEAD ${head:-?} is not origin/develop ${base:-?} and not a fast-forward"
  fi
fi

# ---------------------------------------------------------------- nothing spent for this approval yet (as the worker)
if in_clone bash -c 'id="$1"; s="$HOME/.local/state/sr-design-worker/imagefirst-worker"; r="$HOME/sr-runs"
  for p in "$s/claims/$id.used" "$s/deliveries/$id.json" "$r/review-inbox/$id" "$r/review-inbox/.records/$id.json" "$r/review-inbox/audits/$id"; do
    if [ -e "$p" ] || [ -L "$p" ]; then exit 1; fi
  done
  if compgen -G "$r/$id-*" >/dev/null; then exit 1; fi
  exit 0' _ "$APPROVAL"; then
  row no_prior_run PASS "no claim, run, receipt, delivery, inbox copy or audit for $APPROVAL"
else
  row no_prior_run FAIL "something already exists for $APPROVAL (a claim, run, receipt, delivery or audit): it is never run twice"
fi

# ---------------------------------------------------------------- the audit rubric v2 in the clone (PR #314; the audit records its version)
if [ "$CLONE_OK" = 1 ] && in_clone grep -qxF 'export const AUDIT_RUBRIC_VERSION = "if-claude-audit-v2";' lib/design-agent/imagefirst-worker/audit-rubric.ts 2>/dev/null &&
  in_clone grep -qxF 'export const AUDIT_SCHEMA = "imagefirst_claude_audit_v2";' lib/design-agent/imagefirst-worker/audit-schema.ts 2>/dev/null; then
  row rubric PASS "the clone's audit is rubric if-claude-audit-v2 (schema imagefirst_claude_audit_v2)"
elif [ "$CLONE_OK" = 1 ]; then
  row rubric FAIL "the clone's audit is not rubric if-claude-audit-v2 / schema imagefirst_claude_audit_v2"
else
  row rubric FAIL "skipped: the clone is not on origin/develop"
fi

# ---------------------------------------------------------------- the worker's own precheck (the packet at HEAD, the window, the pins, unused)
if [ "$CLONE_OK" = 1 ]; then
  set +e
  "${AS_WORKER[@]}" timeout --foreground --kill-after="$KILL_AFTER" "$PRECHECK_TIMEOUT" env "$GRANT_ENV=$APPROVAL" \
    node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --precheck >"$WORK/precheck" 2>/dev/null 8>&- 9>&-
  prc=$?
  set -e
  pline="$(tail -n 1 "$WORK/precheck" | tr -d '\000-\037' | cut -c1-400)"
  # the expiry the worker just checked (its own report of the packet at HEAD); the pilot needs MIN_LEFT_SECONDS of it
  left=-1
  if [[ "$pline" =~ \"expires_at\":\"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)\" ]]; then
    exp_s="$(date -u -d "${BASH_REMATCH[1]}" +%s 2>/dev/null)" || exp_s=""
    if [[ "$exp_s" =~ ^[0-9]+$ ]]; then left=$((exp_s - $(now))); fi
  fi
  if [ "$prc" -ne 0 ] || [[ "$pline" != *'"status":"would_run"'* ]] || [[ "$pline" != *"\"approval_id\":\"$APPROVAL\""* ]]; then
    row approval FAIL "precheck exit $prc: ${pline:-<no line>}"
  elif [ "$left" -lt "$MIN_LEFT_SECONDS" ]; then
    row approval FAIL "under $((MIN_LEFT_SECONDS / 60)) min of the approval left ($((left < 0 ? 0 : left / 60)) min, or the expiry unreadable): start with at least $((MIN_LEFT_SECONDS / 60)) min left"
  else
    row approval PASS "the worker would run now, $((left / 60)) min of the approval left: $pline"
  fi
else
  row approval FAIL "skipped: the clone is not on origin/develop"
fi

# ---------------------------------------------------------------- codex: present, no .env, signed in with ChatGPT (checked in the sandbox)
if ! in_clone bash -c 'command -v codex' >/dev/null 2>&1; then
  row codex FAIL "the codex binary is not on $WORKER_USER's PATH ($WORKER_PATH)"
elif ! in_clone bash -c 'f="$HOME/.codex/auth.json"; [ -f "$f" ] && [ ! -L "$f" ] && [ -s "$f" ]'; then
  row codex FAIL "no sign-in (~/.codex/auth.json missing or empty)"
elif ! in_clone bash -c 'f="$HOME/.codex/.env"; [ ! -e "$f" ] && [ ! -L "$f" ]'; then
  row codex FAIL "~/.codex/.env exists (CODEX_DOTENV_PRESENT): remove it first"
elif [ "$CLONE_OK" != 1 ]; then
  row codex FAIL "skipped: the clone is not on origin/develop"
else
  # the worker's own read-only check (review H1): the generation path's .env rule and sandbox, then one sandboxed sign-in
  # status read; an API-key login or a broken sandbox fails HERE, before any approval is used. No model call
  set +e
  "${AS_WORKER[@]}" timeout --foreground --kill-after="$KILL_AFTER" "$AUTH_TIMEOUT" \
    node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --check-codex-auth-only >"$WORK/codex" 2>/dev/null 8>&- 9>&-
  crc=$?
  set -e
  cline="$(tail -n 1 "$WORK/codex" | tr -d '\000-\037' | cut -c1-400)"
  if [ "$crc" -eq 0 ] && [[ "$cline" == *'"status":"codex_auth_ok"'* ]]; then
    row codex PASS "on PATH, no .env, signed in with ChatGPT (sandboxed check; an expired sign-in cannot be seen here)"
  elif [[ "$cline" == *'"code":"OUT_DIR_PARENT_MISSING"'* ]]; then
    # the check uses the generation run's own places: ~/sr-runs must exist first (the precheck alone accepts it missing)
    row codex FAIL "OUT_DIR_PARENT_MISSING: create ~sr-designgen/sr-runs first (owned by $WORKER_USER, mode 700), then run the preflight again"
  else
    row codex FAIL "exit $crc: ${cline:-<no line>}"
  fi
fi

# ---------------------------------------------------------------- claude: on PATH outside the jail, the subscription login
if in_clone bash -c 'command -v claude' >/dev/null 2>&1; then
  row claude_bin PASS "on $WORKER_USER's PATH outside the jail"
  if [ "$CLONE_OK" = 1 ]; then
    set +e
    "${AS_WORKER[@]}" timeout --foreground --kill-after="$KILL_AFTER" "$AUTH_TIMEOUT" \
      node --import tsx scripts/sales-design-worker/imagefirst-audit.ts --check-auth-only >"$WORK/auth" 2>/dev/null 8>&- 9>&-
    arc=$?
    set -e
    aline="$(tail -n 1 "$WORK/auth" | tr -d '\000-\037' | cut -c1-400)"
    if [ "$arc" -eq 0 ] && [[ "$aline" == *'"status":"auth_ok"'* ]]; then row claude_auth PASS "claude.ai subscription, first party, no API key"; else row claude_auth FAIL "exit $arc: ${aline:-<no line>}"; fi
  else
    row claude_auth FAIL "skipped: the clone is not on origin/develop"
  fi
else
  row claude_bin FAIL "claude is not on $WORKER_USER's PATH ($WORKER_PATH)"
  row claude_auth FAIL "skipped: no claude binary"
fi

if [ "$FAILS" -eq 0 ]; then finish PASS 0; fi
finish FAIL 20
}
