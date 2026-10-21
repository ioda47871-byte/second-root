#!/usr/bin/env bash
# Second Root design worker cycle (DEV-052): ONE safe cycle of the design bridge and the worker.
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh             one cycle
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh --dry-run   preflight + read-only checks only
#
# Run by root, only from the root-only admin clone (/root/sr-capture-admin), by a person or from
# sr-design-cycle.service (not installed or enabled by anything in this repository:
# docs/operations/design-worker-cycle.md). It uses only the existing ways to run things:
#   bridge  scripts/sales-design-bridge/run.sh in sr-designbridge's own checkout, as sr-designbridge
#           (runuser, the root-only form of `sudo -u sr-designbridge`); this script never reads the token
#   worker  admin.sh run sr-designgen -- ... run.sh --max=1 (inside the requester jail, RuntimeMaxSec=3500)
#
# One cycle, in this order; any surprise is a STOP (never retried, never relaxed):
#   1. resource preflight (scripts/ops/wsl-resource-preflight.sh; STOP = do not start)
#   2. read-only checks: this clone, the bridge checkout at the approved commit and clean, the bridge /
#      worker units inactive, no bridge / worker process, env / token file owner and mode, the bridge
#      ledger with no open job, empty spool and worker queue; with SR_DESIGN_CYCLE_VERCEL_BYPASS=on
#      in the config (DEV-059, off by default), also the Vercel bypass file's owner and mode and its
#      origin (never its value)
#   3. an idle worker run (heartbeat; removes results of jobs the bridge has closed)
#   4. bridge --deliver-only: must deliver, supersede, refuse and expire nothing
#   5. time guard, then bridge --once: claims exactly one job, or nothing (CYCLE_IDLE)
#   6. time guard, then worker --max=1 (budget 3300 s); STOP codes in its output (login, jail, bridge, ...)
#   7. the worker must have imported, claimed and exported that job; then bridge --deliver-only must
#      deliver exactly that job
# The deadlines are fixed when the cycle starts and are never extended. Nothing here changes the
# database, Vercel, the jail, the helper, admin.sh, the bridge or any SR_DESIGN_* setting.
# After a claim, a STOP leaves the job `processing` in Staging: a person recovers it.
#
# Output: fixed lines, counts, job ids and codes only. Every line a child prints goes through
# redact() first. The last line is machine-readable:
#   CYCLE_RESULT <CODE> phase=<before_claim|claim_unknown|after_claim|done> job=<b-…|none> exit=<n>
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
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SR_DESIGN_CYCLE_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec env -i "${keep[@]}" bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi

# Where this copy lives, resolved before `cd /` so a relative invocation finds the same clone.
SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
umask 077
cd /

# ---------------------------------------------------------------- budget (R2, DEV-046)
CYCLE_BUDGET=4500          # the whole cycle; fixed at the start, never extended
BRIDGE_TIMEOUT=240         # bridge run.sh: timeout 240 on one pass (a pass that ends normally takes less)
BRIDGE_MAX=260             # one bridge pass at worst: this script's own timeout 250 + kill-after 5, rounded up
WORKER_BUDGET=3300         # SR_DESIGN_WORKER_BUDGET_SECONDS (run.sh's own cap)
WORKER_RUNTIME_MAX=3500    # admin.sh run: RuntimeMaxSec=3500 for the jailed worker
WORKER_STOP_GRACE=90       # systemd's default TimeoutStopSec after RuntimeMaxSec
CLAIM_MIN_LEFT=4220        # claim only with this much left: a claim pass at worst + the worker guard
WORKER_MIN_LEFT=3960       # start the worker only with this much left: the worker at worst + the last pass + margin
DELIVER_MIN_LEFT=$BRIDGE_MAX
WORKER_REF=develop

# ---------------------------------------------------------------- result
PHASE=before_claim
JOB=none
FINISHED=0
WORK=""

say() { printf 'cycle: %s\n' "$*"; }

finish() {
  local code="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  if [ "$PHASE" = after_claim ] || [ "$PHASE" = claim_unknown ]; then
    if [ "$code" != CYCLE_OK ]; then
      say "job $JOB may stay 'processing' in Staging. Nothing is changed automatically and nothing is retried."
      say "A person investigates read-only, then recovers it with a job-id-guarded step (docs/operations/design-worker-cycle.md §6)."
      say "The next cycle stops at CHECK_LEDGER_OPEN until then."
    fi
  fi
  [ -z "$WORK" ] || rm -rf "$WORK"
  printf 'CYCLE_RESULT %s phase=%s job=%s exit=%s\n' "$code" "$PHASE" "$JOB" "$rc"
  exit "$rc"
}
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return
  say "stopped by an unexpected error (exit $rc)"
  finish CYCLE_STOP_INTERNAL 41
}
trap on_exit EXIT
trap 'finish CYCLE_STOP_SIGNAL 40' INT TERM HUP

usage() {
  say "$1"
  finish CYCLE_USAGE 2
}

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) usage "usage: cycle.sh [--dry-run]" ;;
esac

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
TEST_ROOT="${SR_DESIGN_CYCLE_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || usage "CYCLE_TEST_HOOK_REFUSED: test hooks are refused in $PROD_CLONE"
  [ "$(id -u)" = 0 ] || usage "run as root: sudo bash $PROD_CLONE/scripts/sales-design-worker/cycle.sh"
  R=""
  BRIDGE_USER=sr-designbridge
  WORKER_USER=sr-designgen
  FILE_ROOT=root
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
else
  # Any other copy runs only the unit tests' fake world (tests/unit/design-worker-cycle.test.ts).
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || usage "run from the root-only clone: sudo bash $PROD_CLONE/scripts/sales-design-worker/cycle.sh"
  R="$TEST_ROOT"
  BRIDGE_USER="$(id -un)"
  WORKER_USER="$(id -un)"
  FILE_ROOT="$(id -un)"
fi
ROOT_CLONE="$R$PROD_CLONE"
ADMIN="$ROOT_CLONE/scripts/sales-design-capture/admin.sh"
PREFLIGHT="$ROOT_CLONE/scripts/ops/wsl-resource-preflight.sh"
CONF="$R/etc/second-root/design-cycle.conf"
STATE="$R/var/lib/sr-design-cycle"
SPOOL="$R/srv/sr-design-bridge"
BRIDGE_HOME="$R/home/sr-designbridge"
BRIDGE_REPO="$BRIDGE_HOME/second-root"
BRIDGE_RUN="$BRIDGE_REPO/scripts/sales-design-bridge/run.sh"
BRIDGE_ENV="$BRIDGE_HOME/.config/second-root/design-bridge.env"
BRIDGE_LEDGER="$BRIDGE_HOME/.local/state/sr-design-bridge/ledger.json"
WORKER_HOME="$R/home/sr-designgen"
WORKER_RUN="$WORKER_HOME/work/second-root/scripts/sales-design-worker/run.sh"
WORKER_QUEUE="$WORKER_HOME/sr-design-jobs"

now() {
  if [ -n "$R" ] && [ -f "$R/clock" ]; then cat "$R/clock"; else date +%s; fi
}

# The bridge user's own commands. Root never runs git, node or a JSON parser on files that user
# controls (a .git/config or a link could make root run or read something).
as_bridge() {
  if [ -n "$R" ]; then
    env HOME="$BRIDGE_HOME" "$@" 9>&-
  else
    runuser -u "$BRIDGE_USER" -- env HOME="$BRIDGE_HOME" "$@" 9>&-
  fi
}

# ---------------------------------------------------------------- output
# Fixed codes stay; URLs, e-mail addresses, bearer values, every value of a Cookie / Set-Cookie
# line, key=value and "key": "value" secrets, `x-api-key <value>`, JWTs, known key prefixes, long
# hex strings (job ids b-<uuid> and UUIDs have no 32-hex run, so they stay) and long
# random-looking strings become [url] / [email] / [redacted]. Control characters go, lines are
# cut at 300 characters, and only the last 200 lines are shown.
REDACT_PY='
import re, sys
name = sys.argv[1]
pair = re.compile(r"([^=;,\s]+)=[^;,\s]*")
rules = [
    (re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://\S+"), "[url]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+"), "[email]"),
    (re.compile(r"(?i)\b(set-cookie|cookie)([\"\x27]?\s*[=:]\s*)(.*)"), lambda m: m.group(1) + m.group(2) + (pair.sub(r"\1=[redacted]", m.group(3)) if "=" in m.group(3) else "[redacted]")),
    (re.compile(r"(?i)\b(bearer|basic)\s+\S+"), r"\1 [redacted]"),
    (re.compile(r"(?i)\b([A-Za-z0-9_.-]*(token|secret|password|passwd|cookie|api[_-]?key|authorization|credential|sessionid|bypass)[A-Za-z0-9_.-]*)([\"\x27]?\s*[=:]\s*)(?![^\s=]*=\[redacted\])(\"[^\"]*\"?|\x27[^\x27]*\x27?|\S+)"), r"\1\3[redacted]"),
    (re.compile(r"(?i)\b(x-api-key|api[_-]?key)\s+(?![=:\s])\S+"), r"\1 [redacted]"),
    (re.compile(r"(?<![A-Za-z0-9_])[0-9A-Fa-f]{32,}(?![A-Za-z0-9_])"), "[redacted]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9_-]*)*"), "[redacted]"),
    (re.compile(r"\b(sk-|gh[pousr]_|github_pat_|sb_secret_|sbp_|vercel_)[A-Za-z0-9_-]{8,}"), "[redacted]"),
    (re.compile(r"(?<![A-Za-z0-9+/=_-])(?=[A-Za-z0-9+/=_-]*[0-9])(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[A-Z])[A-Za-z0-9+/=_-]{32,}"), "[redacted]"),
]
lines = sys.stdin.buffer.read().decode("utf-8", "replace").splitlines()
if len(lines) > 200:
    print("  %s| (%d earlier lines not shown)" % (name, len(lines) - 200))
    lines = lines[-200:]
for line in lines:
    line = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]|\x1b\[[0-9;]*[A-Za-z]", "", line)
    for pattern, repl in rules:
        line = pattern.sub(repl, line)
    print("  %s| %s" % (name, line[:300]))
'
show() { python3 -I -c "$REDACT_PY" "$1" <"$2" 9>&-; }

# Codes in a child's output that stop the cycle (whole words: JAIL_OK and the like never match).
STOP_CODES='LOGIN_REQUIRED|LOGIN_WALL|LOGIN_ABORTED|INSTAGRAM_CHALLENGE|INSTAGRAM_CAPTCHA|CHALLENGE|CAPTCHA|WAITING_FOR_PERSON|SKIPPED_NO_TIME|RATE_CAPPED|RATE_LIMITED|JAIL_UNSAFE|JAIL_NOT_INSTALLED|JAIL_PROPS_FAILED|JAIL_UNIT_REJECTED|HOST_UNSAFE|ADMIN_SCRIPT_UNTRUSTED|REQUESTER_[A-Z_]+|WSL_INTEROP_[A-Z_]+|BRIDGE_[A-Z_]+|CODEX_SANDBOX_[A-Z_]+|CODEX_API_KEY_AUTH|CODEX_NOT_SIGNED_IN|CODEX_NOT_INSTALLED|CODEX_QUOTA|CODEX_DOTENV_PRESENT|SPOOL_UNSAFE|WORKER_NOT_ON_REF|WORKER_TREE_DIRTY|WORKER_ENV_FILE_PRESENT|WORKER_LOCK_FAILED|WORKER_RUN_TIME_BUDGET|RUN_TIME_BUDGET|WORKER_STOPPED_BY_SIGNAL|WORKER_UNEXPECTED|WORKER_SYSTEM_ERROR|OOM|Killed'
stop_codes_in() {
  grep -oE "(^|[^A-Za-z0-9_])($STOP_CODES)([^A-Za-z0-9_]|$)" "$1" | grep -oE "$STOP_CODES" | sort -u | tr '\n' ' ' || true
}

# The capture helper gave no answer (busy, timed out, not reachable, its own error, an unusable
# result). The worker then falls back to the public capture; if that ends the job
# PUBLIC_SOURCE_UNAVAILABLE, the result is not about the shop but about the helper, and delivering
# it closes the demo as blocked. Such a job is a stop. A helper answer (CAPTURED, LOGIN_REQUIRED,
# INSTAGRAM_*, its own PUBLIC_SOURCE_UNAVAILABLE) is handled by STOP_CODES or delivered as it is.
HELPER_NO_ANSWER='BROWSER_BUSY|HELPER_BUSY|HELPER_ERROR|CAPTURE_FAILED|CAPTURE_HELPER_TIMEOUT|CAPTURE_HELPER_UNAVAILABLE|CAPTURE_RESULT_INVALID|CAPTURE_REQUEST_INVALID|REQUEST_INVALID'
helper_no_answer_in() { # <file> <job>
  grep -Eq "(^|[[:space:]])job $2: PUBLIC_SOURCE_UNAVAILABLE([^A-Za-z0-9_]|\$)" "$1" || return 0
  grep -oE "(^|[[:space:]])job $2: signed-in capture ($HELPER_NO_ANSWER)([^A-Za-z0-9_]|\$)" "$1" |
    grep -oE "capture ($HELPER_NO_ANSWER)" | sed 's/^capture //' | sort -u | tr '\n' ' ' || true
}

# Open (not closed) job ids in the bridge ledger, one per line; exit 2 when it cannot be read.
LEDGER_PY='
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        ledger = json.load(f)
except FileNotFoundError:
    sys.exit(0)
except Exception:
    sys.exit(2)
jobs = ledger.get("jobs") if isinstance(ledger, dict) and ledger.get("version") == 1 else None
if not isinstance(jobs, dict):
    sys.exit(2)
for key, entry in jobs.items():
    if not re.fullmatch(r"b-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", key) or not isinstance(entry, dict):
        sys.exit(2)
    if not entry.get("closed"):
        print(key)
'
LEDGER_OPEN=""
read_ledger() {
  LEDGER_OPEN="$(as_bridge python3 -I -c "$LEDGER_PY" "$BRIDGE_LEDGER")" || return 1
}

# The file and every directory above it owned by root and writable by nobody else (as admin.sh).
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

# A private file of one user: a regular file (not a link), that owner, mode 0600.
private_file() {
  [ ! -L "$1" ] && [ -f "$1" ] && [ "$(stat -c '%U %a' "$1")" = "$2 600" ]
}

# ---------------------------------------------------------------- the budget is consistent
budget_ok() {
  [ "$WORKER_BUDGET" -lt "$WORKER_RUNTIME_MAX" ] &&
    [ "$WORKER_MIN_LEFT" -ge $((WORKER_RUNTIME_MAX + WORKER_STOP_GRACE + DELIVER_MIN_LEFT)) ] &&
    [ "$CLAIM_MIN_LEFT" -ge $((WORKER_MIN_LEFT + BRIDGE_MAX)) ] &&
    [ "$CYCLE_BUDGET" -ge "$CLAIM_MIN_LEFT" ]
}
budget_ok || usage "CYCLE_BUDGET_INVALID: the budget constants do not add up"

# ---------------------------------------------------------------- one cycle at a time
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/cycle.lock"
if ! flock -n 9; then
  say "another cycle is running; nothing done"
  finish CYCLE_LOCKED 11
fi
WORK="$(mktemp -d "$STATE/run.XXXXXX")"

START="$(now)"
END=$((START + CYCLE_BUDGET))
left() { echo $((END - $(now))); }
say "budget ${CYCLE_BUDGET} s: the claim starts within $((CYCLE_BUDGET - CLAIM_MIN_LEFT)) s, the worker within $((CYCLE_BUDGET - WORKER_MIN_LEFT)) s"

# ---------------------------------------------------------------- 1. resource preflight
rc=0
timeout 60 bash "$PREFLIGHT" </dev/null >"$WORK/preflight.out" 2>&1 9>&- || rc=$?
show preflight "$WORK/preflight.out"
case "$rc" in
  0 | 10) ;; # OK / SERIAL: this cycle is one heavy job
  *)
    say "resource preflight: not OK (exit $rc); nothing started"
    finish CYCLE_STOP_PREFLIGHT 20
    ;;
esac

# ---------------------------------------------------------------- 2. read-only checks
check_fail() {
  say "check: $1"
  finish CYCLE_STOP_CHECK 21
}

if [ -z "$R" ]; then
  for f in "$REPO/scripts/sales-design-worker/cycle.sh" "$PREFLIGHT" "$ADMIN" "$CONF"; do
    trusted_path "$f" || check_fail "CHECK_SCRIPT_UNTRUSTED: ${f#"$REPO"/} can be changed by a user other than root"
  done
fi
[ -z "$(git -C "$ROOT_CLONE" status --porcelain --untracked-files=normal 2>/dev/null 9>&- || echo error)" ] ||
  check_fail "CHECK_ROOT_CLONE_DIRTY: $PROD_CLONE has local changes"

[ -f "$CONF" ] && [ ! -L "$CONF" ] || check_fail "CHECK_CONFIG_MISSING: /etc/second-root/design-cycle.conf (the approved bridge commit)"
[ "$(stat -c %U "$CONF")" = "$FILE_ROOT" ] && [ $(( 0$(stat -c %a "$CONF") & 022 )) -eq 0 ] ||
  check_fail "CHECK_CONFIG_UNSAFE: the config must be root's and writable by nobody else"
mapfile -t sha_lines < <(grep -E '^SR_DESIGN_CYCLE_BRIDGE_SHA=' "$CONF" || true)
[ "${#sha_lines[@]}" = 1 ] && [[ "${sha_lines[0]}" =~ ^SR_DESIGN_CYCLE_BRIDGE_SHA=([0-9a-f]{40})$ ]] ||
  check_fail "CHECK_CONFIG_INVALID: one line SR_DESIGN_CYCLE_BRIDGE_SHA=<40 hex>"
BRIDGE_SHA="${BASH_REMATCH[1]}"
# DEV-059: the Vercel Protection Bypass for the bridge. Off unless root's config says on; the cycle then
# passes only the file path and the origin to the bridge (it never reads the value).
mapfile -t bypass_conf < <(grep -E '^SR_DESIGN_CYCLE_VERCEL_BYPASS=' "$CONF" || true)
BYPASS=off
if [ "${#bypass_conf[@]}" -gt 0 ]; then
  [ "${#bypass_conf[@]}" = 1 ] && [[ "${bypass_conf[0]}" =~ ^SR_DESIGN_CYCLE_VERCEL_BYPASS=(on|off)$ ]] ||
    check_fail "CHECK_CONFIG_INVALID: at most one line SR_DESIGN_CYCLE_VERCEL_BYPASS=on|off"
  BYPASS="${BASH_REMATCH[1]}"
fi
unset bypass_conf

for unit in sr-design-bridge.timer sr-design-bridge.service sr-design-worker.timer sr-design-worker.service; do
  if systemctl is-active --quiet "$unit" 2>/dev/null; then check_fail "CHECK_UNIT_ACTIVE: $unit"; fi
done
for unit in sr-design-bridge.timer sr-design-worker.timer; do
  if systemctl is-enabled --quiet "$unit" 2>/dev/null; then check_fail "CHECK_UNIT_ENABLED: $unit (the cycle does the bridge's claims itself)"; fi
done
if pgrep -u "$BRIDGE_USER" >/dev/null 2>&1; then check_fail "CHECK_BRIDGE_RUNNING: a process of $BRIDGE_USER is running"; fi
if pgrep -u "$WORKER_USER" -f 'scripts/sales-design-worker/|sales-design-bridge/' >/dev/null 2>&1; then
  check_fail "CHECK_WORKER_RUNNING: a worker of $WORKER_USER is running"
fi

head_sha="$(as_bridge git -C "$BRIDGE_REPO" rev-parse HEAD 2>/dev/null)" || head_sha=""
[ "$head_sha" = "$BRIDGE_SHA" ] || check_fail "CHECK_BRIDGE_NOT_AT_SHA: the bridge checkout is not at the approved commit ${BRIDGE_SHA:0:12}"
[ -z "$(as_bridge git -C "$BRIDGE_REPO" status --porcelain --untracked-files=normal 2>/dev/null || echo error)" ] ||
  check_fail "CHECK_BRIDGE_DIRTY: the bridge checkout has local changes"
[ -x "$BRIDGE_RUN" ] || check_fail "CHECK_BRIDGE_MISSING: no scripts/sales-design-bridge/run.sh in the bridge checkout"

private_file "$BRIDGE_ENV" "$BRIDGE_USER" || check_fail "CHECK_ENV_FILE_UNSAFE: design-bridge.env must be $BRIDGE_USER's regular 0600 file"
env_text="$(as_bridge cat "$BRIDGE_ENV" 2>/dev/null)" || check_fail "CHECK_ENV_FILE_UNSAFE: design-bridge.env cannot be read"
mapfile -t url_lines < <(grep -E '^SR_DESIGN_BRIDGE_API_URL=' <<<"$env_text" || true)
url_re='^SR_DESIGN_BRIDGE_API_URL=(https://[^[:space:]"'\''\]+)$'
[ "${#url_lines[@]}" = 1 ] && [[ "${url_lines[0]}" =~ $url_re ]] ||
  check_fail "CHECK_ENV_INVALID: design-bridge.env needs one line SR_DESIGN_BRIDGE_API_URL=https://… (value not shown)"
API_URL="${BASH_REMATCH[1]}"
TOKEN_FILE="$BRIDGE_HOME/.config/second-root/design-bridge.token"
mapfile -t token_lines < <(grep -E '^SR_DESIGN_BRIDGE_TOKEN_FILE=' <<<"$env_text" || true)
if [ "${#token_lines[@]}" -gt 0 ]; then
  path_re='^SR_DESIGN_BRIDGE_TOKEN_FILE=(/[^[:space:]"'\''\]+)$'
  [ "${#token_lines[@]}" = 1 ] && [[ "${token_lines[0]}" =~ $path_re ]] ||
    check_fail "CHECK_ENV_INVALID: SR_DESIGN_BRIDGE_TOKEN_FILE must be one absolute path"
  TOKEN_FILE="${BASH_REMATCH[1]}"
fi
private_file "$TOKEN_FILE" "$BRIDGE_USER" || check_fail "CHECK_TOKEN_FILE_UNSAFE: the token file must be $BRIDGE_USER's regular 0600 file (not read here)"
BYPASS_FILE=""
BYPASS_ORIGIN=""
if [ "$BYPASS" = on ]; then
  mapfile -t bypass_file_lines < <(grep -E '^SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=' <<<"$env_text" || true)
  mapfile -t bypass_origin_lines < <(grep -E '^SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=' <<<"$env_text" || true)
  path_re='^SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=(/[^[:space:]"'\''\]+)$'
  [ "${#bypass_file_lines[@]}" = 1 ] && [[ "${bypass_file_lines[0]}" =~ $path_re ]] ||
    check_fail "CHECK_BYPASS_INVALID: design-bridge.env needs one line SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=<absolute path>"
  BYPASS_FILE="${BASH_REMATCH[1]}"
  origin_re='^SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=(https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\.vercel\.app)$'
  [ "${#bypass_origin_lines[@]}" = 1 ] && [[ "${bypass_origin_lines[0]}" =~ $origin_re ]] ||
    check_fail "CHECK_BYPASS_INVALID: design-bridge.env needs one line SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=https://<name>.vercel.app"
  BYPASS_ORIGIN="${BASH_REMATCH[1]}"
  [[ "$API_URL" =~ ^(https://[^/]+) ]] && [ "${BASH_REMATCH[1]}" = "$BYPASS_ORIGIN" ] ||
    check_fail "CHECK_BYPASS_INVALID: the bypass origin is not the bridge API URL's origin (values not shown)"
  private_file "$BYPASS_FILE" "$BRIDGE_USER" || check_fail "CHECK_BYPASS_FILE_UNSAFE: the bypass file must be $BRIDGE_USER's regular 0600 file (not read here)"
  unset bypass_file_lines bypass_origin_lines
fi
unset env_text url_lines token_lines
say "vercel bypass: $BYPASS"

read_ledger || check_fail "CHECK_LEDGER_INVALID: the bridge ledger cannot be read"
[ -z "$LEDGER_OPEN" ] || check_fail "CHECK_LEDGER_OPEN: the bridge holds $(grep -c . <<<"$LEDGER_OPEN") open job(s) (a stopped cycle; §6)"

[ -d "$SPOOL/to-worker" ] && [ -d "$SPOOL/from-worker" ] || check_fail "CHECK_SPOOL_MISSING: $SPOOL/to-worker and from-worker"
[ -z "$(find "$SPOOL/to-worker" -maxdepth 1 -name '*.json' -print -quit)" ] || check_fail "CHECK_SPOOL_PENDING: a job file is waiting in to-worker"
for d in inbox processing; do
  if [ -d "$WORKER_QUEUE/$d" ] && [ -n "$(find "$WORKER_QUEUE/$d" -maxdepth 1 -name '[!.]*.json' -print -quit)" ]; then
    check_fail "CHECK_WORKER_QUEUE_BUSY: the worker's $d is not empty"
  fi
done
[ -x "$WORKER_RUN" ] || check_fail "CHECK_WORKER_MISSING: no scripts/sales-design-worker/run.sh in the worker checkout"
say "checks: OK"

if [ "$DRY_RUN" = 1 ]; then
  say "dry run: preflight and checks only; no worker, no bridge pass, nothing changed"
  finish CYCLE_DRY_RUN_OK 0
fi

# ---------------------------------------------------------------- steps
bridge_pass() { # <mode> <name>
  local rc=0
  (
    export SR_DESIGN_BRIDGE_API_URL="$API_URL" SR_DESIGN_BRIDGE_SPOOL="$SPOOL"
    [ "$TOKEN_FILE" = "$BRIDGE_HOME/.config/second-root/design-bridge.token" ] || export SR_DESIGN_BRIDGE_TOKEN_FILE="$TOKEN_FILE"
    if [ "$BYPASS" = on ]; then export SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE="$BYPASS_FILE" SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN="$BYPASS_ORIGIN"; fi
    as_bridge timeout --kill-after=5 $((BRIDGE_TIMEOUT + 10)) "$BRIDGE_RUN" "--$1"
  ) </dev/null >"$WORK/$2.out" 2>&1 || rc=$?
  show "$2" "$WORK/$2.out"
  return "$rc"
}
summary_of() { grep -E '^bridge: ' "$1" || true; }

worker_run() { # <name>
  local rc=0
  bash "$ADMIN" run "$WORKER_USER" -- /usr/bin/env SR_DESIGN_WORKER_REF="$WORKER_REF" SR_DESIGN_BRIDGE_SPOOL="$SPOOL" \
    SR_DESIGN_WORKER_BUDGET_SECONDS="$WORKER_BUDGET" "$WORKER_RUN" --max=1 </dev/null >"$WORK/$1.out" 2>&1 9>&- || rc=$?
  show "$1" "$WORK/$1.out"
  return "$rc"
}
has_line() { grep -Eq "(^|[[:space:]])$2\$" "$1"; }

guard_claim() {
  local l
  l="$(left)"
  [ "$l" -ge "$CLAIM_MIN_LEFT" ] || {
    say "time: ${l} s left, the claim needs ${CLAIM_MIN_LEFT} s; no claim"
    finish CYCLE_STOP_TIME_BEFORE_CLAIM 24
  }
}

# ---------------------------------------------------------------- 3. idle worker run
guard_claim
rc=0
worker_run idle-worker || rc=$?
codes="$(stop_codes_in "$WORK/idle-worker.out")"
[ -z "$codes" ] || { say "idle worker: stop codes: $codes"; finish CYCLE_STOP_IDLE_RUN 22; }
[ "$rc" = 0 ] || { say "idle worker: exit $rc"; finish CYCLE_STOP_IDLE_RUN 22; }
has_line "$WORK/idle-worker.out" 'bridge: imported 0' && has_line "$WORK/idle-worker.out" 'no jobs in the inbox' &&
  has_line "$WORK/idle-worker.out" 'bridge: exported 0(, removed [0-9]+)?' ||
  { say "idle worker: not an idle run (imported 0 / no jobs / exported 0 expected)"; finish CYCLE_STOP_IDLE_RUN 22; }
[ -z "$(find "$SPOOL/from-worker" -maxdepth 1 -name '*.json' ! -name worker-heartbeat.json ! -name '*.review.json' -print -quit)" ] ||
  { say "idle worker: a result file is left in from-worker"; finish CYCLE_STOP_IDLE_RUN 22; }

# ---------------------------------------------------------------- 4. deliver-only: nothing to deliver
rc=0
bridge_pass deliver-only bridge-deliver-before || rc=$?
[ "$rc" = 0 ] && [ "$(summary_of "$WORK/bridge-deliver-before.out")" = "bridge: delivered 0, superseded 0, refused 0, expired 0, claimed none (BRIDGE_DELIVER_ONLY)" ] ||
  { say "bridge --deliver-only: exit $rc, or not all 0 (superseded 0 expected)"; finish CYCLE_STOP_DELIVER_BEFORE 23; }

# ---------------------------------------------------------------- 5. claim one job
guard_claim
rc=0
PHASE=claim_unknown
bridge_pass once bridge-claim || rc=$?
summary="$(summary_of "$WORK/bridge-claim.out")"
claim_re='^bridge: delivered 0, superseded 0, refused 0, expired 0, claimed (b-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
if [ "$rc" = 0 ] && [[ "$summary" =~ $claim_re ]]; then
  JOB="${BASH_REMATCH[1]}"
  PHASE=after_claim
  read_ledger && [ "$LEDGER_OPEN" = "$JOB" ] || { say "bridge --once: the ledger does not hold exactly $JOB"; finish CYCLE_STOP_CLAIM 25; }
  say "claimed $JOB"
elif [ "$rc" = 0 ] && [ "$summary" = "bridge: delivered 0, superseded 0, refused 0, expired 0, claimed none" ] && read_ledger && [ -z "$LEDGER_OPEN" ]; then
  PHASE=before_claim
  say "nothing to claim"
  finish CYCLE_IDLE 10
else
  if read_ledger; then
    if [ -z "$LEDGER_OPEN" ]; then PHASE=before_claim; elif [ "$(grep -c . <<<"$LEDGER_OPEN")" = 1 ]; then JOB="$LEDGER_OPEN"; PHASE=after_claim; fi
  fi
  say "bridge --once: exit $rc, or not exactly one claim"
  finish CYCLE_STOP_CLAIM 25
fi

# ---------------------------------------------------------------- 6. the worker, once
l="$(left)"
[ "$l" -ge "$WORKER_MIN_LEFT" ] || { say "time: ${l} s left, the worker needs ${WORKER_MIN_LEFT} s; the worker is not started"; finish CYCLE_STOP_TIME_BEFORE_WORKER 30; }
rc=0
worker_run worker || rc=$?
codes="$(stop_codes_in "$WORK/worker.out")"
[ -z "$codes" ] || { say "worker: stop codes: $codes"; finish CYCLE_STOP_WORKER_SIGNAL 31; }
codes="$(helper_no_answer_in "$WORK/worker.out" "$JOB")"
[ -z "$codes" ] || { say "worker: PUBLIC_SOURCE_UNAVAILABLE after the capture helper gave no answer: $codes"; finish CYCLE_STOP_WORKER_SIGNAL 31; }
if [ "$rc" != 0 ]; then
  say "worker: exit $rc"
  if [ "$rc" = 137 ]; then
    timeout 60 bash "$PREFLIGHT" --oom-check --since "2 hours ago" </dev/null >"$WORK/oom.out" 2>&1 9>&- || true
    show oom-check "$WORK/oom.out"
  fi
  finish CYCLE_STOP_WORKER_EXIT 32
fi
has_line "$WORK/worker.out" 'bridge: imported 1' && has_line "$WORK/worker.out" "job $JOB: claimed" &&
  has_line "$WORK/worker.out" 'bridge: exported 1(, removed [0-9]+)?' ||
  { say "worker: $JOB was not imported, run and exported exactly once"; finish CYCLE_STOP_WORKER_RESULT 33; }

# ---------------------------------------------------------------- 7. deliver exactly that job
l="$(left)"
[ "$l" -ge "$DELIVER_MIN_LEFT" ] || { say "time: ${l} s left, the last bridge pass needs ${DELIVER_MIN_LEFT} s"; finish CYCLE_STOP_TIME_BEFORE_DELIVER 35; }
rc=0
bridge_pass deliver-only bridge-deliver-after || rc=$?
[ "$rc" = 0 ] && [ "$(summary_of "$WORK/bridge-deliver-after.out")" = "bridge: delivered 1, superseded 0, refused 0, expired 0, claimed none (BRIDGE_DELIVER_ONLY)" ] &&
  grep -Eq "^result $JOB: delivered \(" "$WORK/bridge-deliver-after.out" ||
  { say "bridge --deliver-only: $JOB was not the one job delivered"; finish CYCLE_STOP_DELIVER_AFTER 34; }
PHASE=done
say "delivered $JOB"
finish CYCLE_OK 0
}
