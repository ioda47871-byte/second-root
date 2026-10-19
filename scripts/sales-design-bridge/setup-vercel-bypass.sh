#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2015,SC2329  # code for the bridge user is single-quoted on purpose; `|| finish` exits; on_exit is a trap
# Second Root design bridge: set up the bridge's own Vercel Protection Bypass with ONE paste (DEV-063).
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh [--replace] [--no-dry-run]
#
# Replaces the hand-pasted snippet of docs/operations/design-bridge-access.md §6 (DEV-059). Vercel
# Authentication stays ON. The person first creates a Protection Bypass for Automation secret in the
# Vercel UI (note "Second Root design bridge (WSL)", NOT as an environment variable), then runs this
# once and pastes the value at the hidden prompt. Run by root, only from the root-only admin clone.
#
#   1. restart with an allowlisted environment; resolve the bridge user (sr-designbridge) and its files
#   2. read-only checks: this script (and cycle.sh) root's and writable by nobody else; the bridge
#      user; its config directory; design-bridge.env (that user's 0600 file, one
#      SR_DESIGN_BRIDGE_API_URL=https://<one label>.vercel.app[/…] line); the token file (that user's
#      0600 file, never read here); the two bypass lines of the env file absent, or exactly ours
#   3. the value: a bypass file already there is kept (unless --replace) and checked; otherwise it is
#      read from the terminal without echo, checked (16–256 visible ASCII characters, not the bridge
#      token) and written AS the bridge user from stdin (never argv or an environment variable), to a
#      temporary 0600 file in the same directory, then linked (new) or renamed (--replace) into place
#   4. the two env lines SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE / _ORIGIN, appended when absent
#   5. a probe without the bridge token (nothing can be claimed): as the bridge user, POST {} to
#      <origin>/api/internal/sales-design/jobs without the header (Vercel must answer with its
#      protection 401) and with the header (it must reach the app: design_bridge_disabled or
#      unauthorized). The header goes to curl on stdin (-H @-), never on its command line
#   6. unless --no-dry-run: with /etc/second-root/design-cycle.conf present, its
#      SR_DESIGN_CYCLE_VERCEL_BYPASS=on (appended when absent, never changed when different), then
#      cycle.sh --dry-run; without that file nothing is created (CYCLE_CONF_ABSENT, HUMAN-010)
#
# Nothing here touches Vercel, Supabase, a flag, a systemd unit or a timer. Running it again after a
# success changes nothing and probes again. The value is never printed, logged, put on a command
# line or in an environment variable; output is fixed codes only. The last line is machine-readable:
#   BYPASS_SETUP_RESULT <CODE> step=<1-6>
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
    SSL_CERT_FILE CURL_CA_BUNDLE SR_BYPASS_SETUP_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec env -i "${keep[@]}" bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
export LC_ALL=C
umask 077
cd /

STEP=1
FINISHED=0
say() { printf 'bypass-setup: %s\n' "$*"; }

finish() {
  local code="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  unset BYPASS_VALUE
  printf 'BYPASS_SETUP_RESULT %s step=%s\n' "$code" "$STEP"
  exit "$rc"
}
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return
  say "stopped by an unexpected error (exit $rc)"
  finish BYPASS_SETUP_INTERNAL 41
}
trap on_exit EXIT
trap 'finish BYPASS_SETUP_SIGNAL 40' INT TERM HUP

usage() {
  say "$1"
  finish BYPASS_USAGE 2
}

REPLACE=0
DRY_RUN=1
for arg in "$@"; do
  case "$arg" in
    --replace) REPLACE=1 ;;
    --no-dry-run) DRY_RUN=0 ;;
    *) usage "usage: setup-vercel-bypass.sh [--replace] [--no-dry-run]" ;;
  esac
done

# ---------------------------------------------------------------- 1. where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
TEST_ROOT="${SR_BYPASS_SETUP_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || usage "BYPASS_TEST_HOOK_REFUSED: test hooks are refused in $PROD_CLONE"
  [ "$(id -u)" = 0 ] || usage "run as root: sudo bash $PROD_CLONE/scripts/sales-design-bridge/setup-vercel-bypass.sh"
  R=""
  BRIDGE_USER=sr-designbridge
  FILE_ROOT=root
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  BRIDGE_HOME="$(getent passwd "$BRIDGE_USER" | cut -d: -f6)" || BRIDGE_HOME=""
  # cycle.sh, run.sh's units and the docs all use /home/sr-designbridge; another home is refused at step 2.
  EXPECTED_HOME=/home/sr-designbridge
else
  # Any other copy runs only the unit tests' fake world (tests/unit/design-bridge-bypass-setup.test.ts).
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || usage "run from the root-only clone: sudo bash $PROD_CLONE/scripts/sales-design-bridge/setup-vercel-bypass.sh"
  R="$TEST_ROOT"
  BRIDGE_USER="$(id -un)"
  FILE_ROOT="$(id -un)"
  BRIDGE_HOME="$R/home/sr-designbridge"
  EXPECTED_HOME="$BRIDGE_HOME"
fi
CONF_DIR="$BRIDGE_HOME/.config/second-root"
BRIDGE_ENV="$CONF_DIR/design-bridge.env"
BYPASS_FILE="$CONF_DIR/design-bridge.vercel-bypass"
CYCLE="$R$PROD_CLONE/scripts/sales-design-worker/cycle.sh"
CYCLE_CONF="$R/etc/second-root/design-cycle.conf"

# The bridge user's own commands, with a minimal environment (never the value: it is a shell
# variable, never exported, and reaches the bridge user's shell on stdin only).
bridge_env=(HOME="$BRIDGE_HOME" PATH="$PATH" LC_ALL=C)
for name in HTTPS_PROXY https_proxy NO_PROXY no_proxy SSL_CERT_FILE CURL_CA_BUNDLE; do
  if [ -n "${!name+x}" ]; then bridge_env+=("$name=${!name}"); fi
done
as_bridge() {
  runuser -u "$BRIDGE_USER" -- env -i "${bridge_env[@]}" "$@"
}

# The file and every directory above it owned by root and writable by nobody else (as cycle.sh).
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

# A private file of one user: a regular file (not a link), that owner, mode 0600 (as cycle.sh).
private_file() {
  [ ! -L "$1" ] && [ -f "$1" ] && [ "$(stat -c '%U %a' "$1")" = "$2 600" ]
}

# The bridge's rule for the bypass file (lib/design-agent/bridge/vercel-bypass.ts): a regular file,
# one link, the bridge user's, mode exactly 0600, at most 512 bytes. Checked by name, not read.
bypass_file_ok() {
  local info
  [ ! -L "$1" ] && [ -f "$1" ] || return 1
  info="$(stat -c '%h %U %a %s' "$1")" || return 1
  read -r links owner mode size <<<"$info"
  [ "$links" = 1 ] && [ "$owner" = "$BRIDGE_USER" ] && [ "$mode" = 600 ] && [ "$size" -le 512 ]
}

# Shell code run AS the bridge user. Values travel on stdin or stay in that shell's own unexported
# variables, and only builtins (printf, read, [[ ]], $(<file)) ever hold them; only paths are
# arguments. Whitespace around a value is trimmed (as the bridge does), and the value rule is the
# bridge's: 16-256 visible ASCII characters (C locale: [:graph:] = 0x21-0x7e), no NUL byte.
VALUE_FUNCS='
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; printf "%s" "${s%"${s##*[![:space:]]}"}"; }
valid() { [ "${#1}" -ge 16 ] && [ "${#1}" -le 256 ] && [[ "$1" != *[![:graph:]]* ]]; }
no_nul() { [ "$(tr -d "\000" <"$1" | wc -c)" = "$(wc -c <"$1")" ]; }
is_token() { local t=""; [ -f "$2" ] && [ ! -L "$2" ] || return 1; t="$(trim "$(<"$2")")"; [ "$1" = "$t" ]; }
'
# exit 0 ok, 3 not a valid value, 4 the bridge token
CHECK_EXISTING="$VALUE_FUNCS"'
no_nul "$1" || exit 3
v="$(trim "$(<"$1")")" || exit 3
valid "$v" || { v=; exit 3; }
if is_token "$v" "$2"; then v=; exit 4; fi
v=
'
# Removes temporary files a killed earlier run may have left (each holds a value); prints how many.
CLEAN_TEMP='
shopt -s nullglob
n=0
for f in "$1"/.design-bridge.vercel-bypass.?*; do
  shred -u -- "$f" 2>/dev/null || rm -f -- "$f"
  n=$((n + 1))
done
printf "%s\n" "$n"
'
# exit 0 written, 3 not a valid value, 4 the bridge token, 5 a file appeared meanwhile (not replaced), 6 not written
WRITE_VALUE="$VALUE_FUNCS"'
umask 077
dir="$1" file="$2" token="$3" how="$4" v="" tmp=""
IFS= read -r -d "" v || true
valid "$v" || { v=; exit 3; }
if is_token "$v" "$token"; then v=; exit 4; fi
trap '\''[ -z "$tmp" ] || rm -f "$tmp"'\'' EXIT
trap '\''exit 129'\'' HUP
trap '\''exit 130'\'' INT
trap '\''exit 143'\'' TERM
tmp="$(mktemp "$dir/.design-bridge.vercel-bypass.XXXXXX")" || { v=; exit 6; }
printf "%s" "$v" >"$tmp" || { v=; exit 6; }
v=
chmod 600 "$tmp" || exit 6
if [ "$how" = replace ]; then
  mv -fT "$tmp" "$file" || exit 6
elif ! ln -T "$tmp" "$file" 2>/dev/null; then
  if [ -e "$file" ] || [ -L "$file" ]; then exit 5; fi
  exit 6
fi
'
# Prints the response body, a newline and the HTTP status (000 when there was none). curl starts
# with -q, so the bridge user's ~/.curlrc is never read (it could add a trace, a proxy or a header).
# The bypass header, when asked for, is built by the printf builtin and handed to curl on stdin.
PROBE='
url="$1" file="$2" how="$3"
args=(-q -sS --max-redirs 0 --max-time 20 -o - -w "\n%{http_code}" -X POST -H "content-type: application/json" --data "{}")
if [ "$how" = with ]; then
  [ "$(tr -d "\000" <"$file" | wc -c)" = "$(wc -c <"$file")" ] || exit 0
  v="$(<"$file")"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  printf "x-vercel-protection-bypass: %s\n" "$v" | curl "${args[@]}" -H @- "$url" 2>/dev/null || true
  v=
else
  curl "${args[@]}" "$url" </dev/null 2>/dev/null || true
fi
'
# Classifies a probe from that output; prints one code only (never the body).
#   without the header: Vercel's protection 401 = PROTECTION_ON; the app's own JSON error (it was
#     reached without a bypass) = PROTECTION_NOT_ON; anything else (404, 429, 5xx, HTML) = PROBE_FAILED
#   with the header: the app's expected answers = REACHED_APP; Vercel's protection 401 =
#     BYPASS_REJECTED; anything else = PROBE_FAILED
CLASSIFY_PY='
import json, sys
how = sys.argv[1]
data = sys.stdin.buffer.read(1 << 20).decode("utf-8", "replace")
body, sep, status = data.rpartition("\n")
status = status.strip()
if not sep or len(status) != 3 or not status.isdigit() or status == "000":
    print("PROBE_FAILED")
    sys.exit(0)
try:
    doc = json.loads(body)
except Exception:
    doc = None
protection = isinstance(doc, dict) and "protection" in doc
error = doc.get("error") if isinstance(doc, dict) and not protection else None
vercel_401 = status == "401" and protection
if how == "without":
    if vercel_401:
        print("PROTECTION_ON")
    elif isinstance(error, str) and error in ("design_bridge_disabled", "unauthorized", "invalid_json", "payload_too_large", "invalid_request"):
        print("PROTECTION_NOT_ON")
    else:
        print("PROBE_FAILED")
elif vercel_401:
    print("BYPASS_REJECTED")
elif (status, error) in (("503", "design_bridge_disabled"), ("401", "unauthorized")):
    print("REACHED_APP " + error)
else:
    print("PROBE_FAILED")
'

say "step 1: bridge user $BRIDGE_USER; replace: $([ "$REPLACE" = 1 ] && echo yes || echo no); cycle dry run: $([ "$DRY_RUN" = 1 ] && echo yes || echo no)"

# ---------------------------------------------------------------- 2. read-only checks
STEP=2
check_fail() {
  say "check: $1"
  finish "${1%%:*}" 3
}
if [ -z "$R" ]; then
  trusted_path "$SELF" || check_fail "BYPASS_SCRIPT_UNTRUSTED: this script or a directory above it can be changed by a user other than root"
  if [ "$DRY_RUN" = 1 ]; then
    trusted_path "$CYCLE" || check_fail "BYPASS_SCRIPT_UNTRUSTED: cycle.sh or a directory above it can be changed by a user other than root"
  fi
  getent passwd "$BRIDGE_USER" >/dev/null 2>&1 && [ "$(id -u "$BRIDGE_USER" 2>/dev/null || echo 0)" != 0 ] ||
    check_fail "BYPASS_BRIDGE_USER_MISSING: no user $BRIDGE_USER (design-bridge.md §3)"
fi
[ "${BRIDGE_HOME#/}" != "$BRIDGE_HOME" ] && [ -d "$BRIDGE_HOME" ] ||
  check_fail "BYPASS_BRIDGE_USER_MISSING: $BRIDGE_USER has no home directory"
[ "$BRIDGE_HOME" = "$EXPECTED_HOME" ] ||
  check_fail "BRIDGE_HOME_UNEXPECTED: $BRIDGE_USER's home is not /home/sr-designbridge (cycle.sh and the units expect it there)"
[ -d "$CONF_DIR" ] && [ ! -L "$CONF_DIR" ] && [ "$(stat -c %U "$CONF_DIR")" = "$BRIDGE_USER" ] &&
  [ $(( 0$(stat -c %a "$CONF_DIR") & 022 )) -eq 0 ] ||
  check_fail "BYPASS_CONFIG_DIR_UNSAFE: ~$BRIDGE_USER/.config/second-root must be $BRIDGE_USER's directory, writable by nobody else"
private_file "$BRIDGE_ENV" "$BRIDGE_USER" ||
  check_fail "BYPASS_ENV_FILE_UNSAFE: design-bridge.env must be $BRIDGE_USER's regular 0600 file"
env_text="$(as_bridge cat "$BRIDGE_ENV" 2>/dev/null)" || check_fail "BYPASS_ENV_FILE_UNSAFE: design-bridge.env cannot be read"
mapfile -t url_lines < <(grep -E '^SR_DESIGN_BRIDGE_API_URL=' <<<"$env_text" || true)
url_re='^SR_DESIGN_BRIDGE_API_URL=(https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\.vercel\.app)(/[^[:space:]?#"'\''\]*)?$'
[ "${#url_lines[@]}" = 1 ] && [[ "${url_lines[0]}" =~ $url_re ]] ||
  check_fail "BYPASS_API_URL_INVALID: design-bridge.env needs one line SR_DESIGN_BRIDGE_API_URL=https://<one label>.vercel.app (value not shown)"
ORIGIN="${BASH_REMATCH[1]}"
say "api origin: *.vercel.app ok"
TOKEN_FILE="$CONF_DIR/design-bridge.token"
mapfile -t token_lines < <(grep -E '^SR_DESIGN_BRIDGE_TOKEN_FILE=' <<<"$env_text" || true)
if [ "${#token_lines[@]}" -gt 0 ]; then
  path_re='^SR_DESIGN_BRIDGE_TOKEN_FILE=(/[^[:space:]"'\''\]+)$'
  [ "${#token_lines[@]}" = 1 ] && [[ "${token_lines[0]}" =~ $path_re ]] ||
    check_fail "BYPASS_ENV_FILE_UNSAFE: SR_DESIGN_BRIDGE_TOKEN_FILE must be one absolute path"
  TOKEN_FILE="${BASH_REMATCH[1]}"
fi
private_file "$TOKEN_FILE" "$BRIDGE_USER" ||
  check_fail "BYPASS_TOKEN_FILE_UNSAFE: the token file must be $BRIDGE_USER's regular 0600 file (not read here; design-bridge.md §2)"
mapfile -t file_lines < <(grep -E '^SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=' <<<"$env_text" || true)
mapfile -t origin_lines < <(grep -E '^SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=' <<<"$env_text" || true)
unset env_text url_lines token_lines
if [ "${#file_lines[@]}" = 0 ] && [ "${#origin_lines[@]}" = 0 ]; then
  ENV_LINES=absent
elif [ "${#file_lines[@]}" = 1 ] && [ "${#origin_lines[@]}" = 1 ] &&
  [ "${file_lines[0]}" = "SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=$BYPASS_FILE" ] &&
  [ "${origin_lines[0]}" = "SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=$ORIGIN" ]; then
  ENV_LINES=present
else
  # Nothing has been written yet: a person decides which lines are right.
  say "check: design-bridge.env has SR_DESIGN_BRIDGE_VERCEL_BYPASS_* lines that are not exactly this file and the API URL's origin (values not shown); nothing changed"
  finish BYPASS_ENV_CONFLICT 3
fi
unset file_lines origin_lines
say "checks: OK"

# ---------------------------------------------------------------- 3. the value
STEP=3
left="$(as_bridge bash -c "$CLEAN_TEMP" _ "$CONF_DIR" </dev/null 2>/dev/null)" || left=error
case "$left" in
  0) ;;
  [1-9]*) say "BYPASS_TEMP_REMOVED: $left leftover temporary file(s) of an interrupted run removed (as $BRIDGE_USER)" ;;
  *) say "leftover temporary files could not be checked"; finish BYPASS_WRITE_FAILED 4 ;;
esac
if [ -e "$BYPASS_FILE" ] || [ -L "$BYPASS_FILE" ]; then EXISTS=1; else EXISTS=0; fi
if [ "$EXISTS" = 1 ] && [ "$REPLACE" = 0 ]; then
  say "BYPASS_FILE_PRESENT: kept, not read into this shell (use --replace to put a new value)"
  bypass_file_ok "$BYPASS_FILE" || {
    say "the bypass file is not $BRIDGE_USER's regular 0600 file with one link and at most 512 bytes"
    finish BYPASS_FILE_UNSAFE 4
  }
  rc=0
  as_bridge bash -c "$CHECK_EXISTING" _ "$BYPASS_FILE" "$TOKEN_FILE" </dev/null >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) say "bypass file: $BRIDGE_USER 600, value of the bridge's form (not shown)" ;;
    4) say "the bypass file holds the bridge token, not a Vercel bypass value"; finish BYPASS_EQUALS_TOKEN 4 ;;
    *) say "the bypass file does not hold one value of 16-256 visible ASCII characters (not shown)"; finish BYPASS_VALUE_INVALID 4 ;;
  esac
else
  # The terminal, never an argument or a variable. Only the unit tests' fake world may use stdin.
  if [ -n "$R" ] && [ -f "$R/tty-is-stdin" ]; then
    exec 3<&0
    exec 4>&2
  elif ! { exec 3</dev/tty 4>/dev/tty; } 2>/dev/null; then
    say "no terminal to read the value from; run it in an interactive shell"
    finish BYPASS_NO_TTY 4
  fi
  printf 'Paste the Vercel bypass value for the design bridge (not shown), then Enter: ' >&4
  BYPASS_VALUE=""
  READ_TIMEOUT=600
  if [ -n "$R" ] && [ -f "$R/read-timeout" ]; then READ_TIMEOUT="$(cat "$R/read-timeout")"; fi
  rc=0
  IFS= read -r -s -t "$READ_TIMEOUT" BYPASS_VALUE <&3 || rc=$?
  if [ "$rc" -gt 128 ]; then
    # Timed out: whatever was typed without Enter is discarded.
    printf '\n' >&4
    unset BYPASS_VALUE
    say "no value within $READ_TIMEOUT s; nothing written"
    finish BYPASS_INPUT_TIMEOUT 4
  fi
  [ "$rc" = 0 ] || [ -n "$BYPASS_VALUE" ] || { printf '\n' >&4; unset BYPASS_VALUE; finish BYPASS_VALUE_INVALID 4; }
  printf '\n' >&4
  exec 3<&- 4>&-
  # Trim the whitespace a paste may carry, then the bridge's rule. No regex: BASH_REMATCH would keep a copy.
  BYPASS_VALUE="${BYPASS_VALUE#"${BYPASS_VALUE%%[![:space:]]*}"}"
  BYPASS_VALUE="${BYPASS_VALUE%"${BYPASS_VALUE##*[![:space:]]}"}"
  if ! { [ "${#BYPASS_VALUE}" -ge 16 ] && [ "${#BYPASS_VALUE}" -le 256 ] && [[ "$BYPASS_VALUE" != *[![:graph:]]* ]]; }; then
    unset BYPASS_VALUE
    say "the value is empty or not 16-256 visible ASCII characters (not shown); nothing written"
    finish BYPASS_VALUE_INVALID 4
  fi
  how=new
  [ "$EXISTS" = 0 ] || how=replace
  rc=0
  printf '%s' "$BYPASS_VALUE" | as_bridge bash -c "$WRITE_VALUE" _ "$CONF_DIR" "$BYPASS_FILE" "$TOKEN_FILE" "$how" >/dev/null 2>&1 || rc=$?
  unset BYPASS_VALUE
  case "$rc" in
    0) ;;
    3) say "the value is not 16-256 visible ASCII characters (not shown); nothing written"; finish BYPASS_VALUE_INVALID 4 ;;
    4) say "the value is the bridge token: the bypass must be its own Vercel secret; nothing written"; finish BYPASS_EQUALS_TOKEN 4 ;;
    5) say "a bypass file appeared meanwhile; not replaced (run again)"; finish BYPASS_FILE_PRESENT_RACE 4 ;;
    *) say "the bypass file could not be written (nothing replaced)"; finish BYPASS_WRITE_FAILED 4 ;;
  esac
  bypass_file_ok "$BYPASS_FILE" || { say "the written file is not $BRIDGE_USER's 0600 file"; finish BYPASS_FILE_UNSAFE 4; }
  if [ "$how" = replace ]; then say "BYPASS_FILE_REPLACED: $BRIDGE_USER 600 (value not shown)"; else say "BYPASS_FILE_WRITTEN: $BRIDGE_USER 600 (value not shown)"; fi
fi

# ---------------------------------------------------------------- 4. the env lines
STEP=4
if [ "$ENV_LINES" = present ]; then
  say "BYPASS_ENV_PRESENT: design-bridge.env already has the two lines"
else
  rc=0
  as_bridge bash -c '
e="$1"
if [ -s "$e" ] && [ -n "$(tail -c 1 "$e")" ]; then printf "\n" >>"$e"; fi
printf "SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=%s\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=%s\n" "$2" "$3" >>"$e"
' _ "$BRIDGE_ENV" "$BYPASS_FILE" "$ORIGIN" </dev/null >/dev/null 2>&1 || rc=$?
  [ "$rc" = 0 ] && private_file "$BRIDGE_ENV" "$BRIDGE_USER" || { say "design-bridge.env could not be appended to"; finish BYPASS_ENV_WRITE_FAILED 5; }
  say "BYPASS_ENV_APPENDED: SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE / _ORIGIN (design-bridge.env stays 0600)"
fi

# ---------------------------------------------------------------- 5. the probe (no bridge token, no claim)
STEP=5
probe() { # <without|with>
  { as_bridge bash -c "$PROBE" _ "$ORIGIN/api/internal/sales-design/jobs" "$BYPASS_FILE" "$1" </dev/null 2>/dev/null || true; } |
    python3 -I -c "$CLASSIFY_PY" "$1"
}
without="$(probe without)"
case "$without" in
  PROTECTION_ON) say "probe without the bypass: PROTECTION_ON (Vercel Authentication answers)" ;;
  PROTECTION_NOT_ON)
    say "probe without the bypass: PROTECTION_NOT_ON"
    say "WARNING: the request reached past Vercel without the bypass. Vercel Authentication may be OFF."
    say "WARNING: a person checks Settings -> Deployment Protection now (npm run staging:bypass-status)."
    finish PROTECTION_NOT_ON 6
    ;;
  *) say "probe without the bypass: PROBE_FAILED (network, timeout or an unexpected answer)"; finish PROBE_FAILED 6 ;;
esac
with="$(probe with)"
case "$with" in
  "REACHED_APP design_bridge_disabled" | "REACHED_APP unauthorized")
    say "probe with the bypass: $with"
    say "BYPASS_OK: Vercel lets the bridge's bypass through; the bridge API still needs the bridge token"
    ;;
  BYPASS_REJECTED)
    say "probe with the bypass: BYPASS_REJECTED (Vercel refused the value: wrong, or revoked). Run again with --replace and the right value"
    finish BYPASS_REJECTED 6
    ;;
  *) say "probe with the bypass: PROBE_FAILED (network, timeout or an unexpected answer)"; finish PROBE_FAILED 6 ;;
esac

# ---------------------------------------------------------------- 6. the cycle's switch and dry run
STEP=6
if [ "$DRY_RUN" = 0 ]; then
  say "cycle: not checked (--no-dry-run)"
  finish BYPASS_SETUP_OK 0
fi
if [ ! -e "$CYCLE_CONF" ] && [ ! -L "$CYCLE_CONF" ]; then
  say "CYCLE_CONF_ABSENT: /etc/second-root/design-cycle.conf does not exist; not created (the cycle install is HUMAN-010). Dry run skipped"
  finish BYPASS_SETUP_OK 0
fi
[ -f "$CYCLE_CONF" ] && [ ! -L "$CYCLE_CONF" ] && [ "$(stat -c %U "$CYCLE_CONF")" = "$FILE_ROOT" ] &&
  [ $(( 0$(stat -c %a "$CYCLE_CONF") & 022 )) -eq 0 ] && { [ -n "$R" ] || trusted_path "$CYCLE_CONF"; } || {
  say "the cycle config must be root's regular file, writable by nobody else; not changed"
  finish CYCLE_CONF_UNSAFE 7
}
mapfile -t switch_lines < <(grep -E '^SR_DESIGN_CYCLE_VERCEL_BYPASS=' "$CYCLE_CONF" || true)
if [ "${#switch_lines[@]}" = 0 ]; then
  if [ -s "$CYCLE_CONF" ] && [ -n "$(tail -c 1 "$CYCLE_CONF")" ]; then printf '\n' >>"$CYCLE_CONF"; fi
  printf 'SR_DESIGN_CYCLE_VERCEL_BYPASS=on\n' >>"$CYCLE_CONF"
  say "CYCLE_SWITCH_APPENDED: SR_DESIGN_CYCLE_VERCEL_BYPASS=on"
elif [ "${#switch_lines[@]}" = 1 ] && [ "${switch_lines[0]}" = SR_DESIGN_CYCLE_VERCEL_BYPASS=on ]; then
  say "CYCLE_SWITCH_ON: SR_DESIGN_CYCLE_VERCEL_BYPASS=on already"
else
  say "the cycle config already sets SR_DESIGN_CYCLE_VERCEL_BYPASS to something other than one line =on; not changed (a person decides: design-bridge-access.md §8)"
  finish CYCLE_SWITCH_NOT_ON 7
fi
[ -f "$CYCLE" ] || { say "no cycle.sh in this clone"; finish CYCLE_DRY_RUN_NOT_OK 7; }
rc=0
cycle_out="$(bash "$CYCLE" --dry-run </dev/null 2>&1)" || rc=$?
# cycle.sh prints fixed, redacted lines; relay only its bypass line, its check line and its result.
grep -E '^(cycle: vercel bypass: (on|off)|cycle: check: [A-Z_]+|cycle: checks: OK)' <<<"$cycle_out" | cut -c1-200 | sed 's/^/  /' || true
result="$(grep -E '^CYCLE_RESULT [A-Z_]+ ' <<<"$cycle_out" | tail -n 1 | cut -c1-200 || true)"
unset cycle_out
say "relayed: ${result:-no CYCLE_RESULT line} (exit $rc)"
case "$result" in
  "CYCLE_RESULT CYCLE_DRY_RUN_OK "*) finish BYPASS_SETUP_OK 0 ;;
  *) finish CYCLE_DRY_RUN_NOT_OK 7 ;;
esac
}
