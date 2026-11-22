#!/usr/bin/env bash
# Second Root IMAGE_FIRST automatic run: the owner's ONE-TIME setup, bundled (Issue #302, docs/operations/imagefirst-autorun.md
# §2). It replaces the manual root commands of §2 (kept there as an appendix) with one reviewed script and three separate
# owner approvals: check (read-only) -> apply -> enable-timer. rollback undoes apply.
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh check --expect <sha>
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh apply --yes --expect <sha>
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh enable-timer --yes --expect <sha>
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh rollback --yes --expect <sha>
#
# Run by root, only from the root-only admin clone (/root/sr-capture-admin), by a person. Every mode first checks the admin
# clone: this script and every file it installs root's and writable by nobody else up to / (trusted_path); the clone clean;
# HEAD detached at exactly the commit the owner typed (--expect <40 hex>, required in every mode); and (check / apply /
# enable-timer) that commit is origin's develop (git ls-remote of the admin clone's own configured URL, nothing written).
# rollback does not ask for develop (it must work after develop moved on).
#
# Steps (check prints one line for each: SETUP_STEP <name> <DONE|TODO|BLOCKED> <reason>):
#   cli             claude and codex root-owned under /usr/local: @anthropic-ai/claude-code@2.1.295 and @openai/codex@0.159.0
#                   installed with /usr/bin/npm install -g --prefix /usr/local (env -i, HOME=/root, a fixed PATH, umask 022,
#                   --userconfig /dev/null --globalconfig /dev/null). Today /usr/local/bin/{claude,codex} are root's symlinks
#                   into the worker's home: apply records (setup.log) and removes ONLY such symlinks (a symlink whose target is
#                   inside /home/sr-designgen); anything else there is BLOCKED and nothing is touched. Afterwards each
#                   /usr/local/bin/<cli> must resolve (readlink -f) into its package, to a file root's and writable by nobody
#                   else up to /, and the package's package.json must carry the pinned name and version (read as JSON; the
#                   CLIs are never executed). node (as the worker's PATH /usr/local/bin:/usr/bin:/bin finds it) and
#                   /usr/bin/npm must be root-trusted too. The worker's own PATH (~/.npm-global/bin first) is not changed.
#   codex_config    the repository's codex-config.toml installed root 0644 to /etc/sr-design-worker/ (dir root 0755); its
#                   SHA-256 must be the pinned CODEX_CONFIG_SHA256 of imagefirst-pilot-preflight.sh and imagefirst-pilot.sh
#                   (read from those two files, which must agree; setup.test.ts pins all three to the repository's file)
#   units           the old hourly sr-imagefirst-autostart.timer disabled (if present); sr-imagefirst-autorun.{service,timer}
#                   installed 0644 (byte-identical to the repository's); daemon-reload; the owner's switch
#                   /etc/sr-design-worker/imagefirst-autostart.json written as {"enabled": true} ONLY if absent
#   hardening_check the doc's check 1: systemd-run with the unit's hardening running admin.sh status must print its status
#                   table (else SETUP_HARDENING_FAILED: nothing further, the timer stays off, the rollback line is printed).
#                   A pass is recorded (root's state, bound to the installed service file's and admin.sh's SHA-256).
# apply NEVER enables the timer. enable-timer is a separate owner approval and needs all four steps DONE.
# rollback: the timer disabled, the two unit files removed, daemon-reload, the two npm packages uninstalled, the two old
# symlinks restored exactly as setup.log recorded them (only if their targets still exist and the place is free), root's
# codex-config.toml and the recorded hardening pass removed. It NEVER removes used/, autorun/, the worker's claims, the
# entry's ledgers or the owner's switch.
#
# Every action of apply / enable-timer / rollback is appended to root's /var/lib/sr-imagefirst-autostart/setup.log (0600;
# the state dir 0700), including what the old symlinks pointed to. check writes nothing anywhere. Sign-in files stay in the
# worker's home: this script never reads them.
#
# Output: fixed lines; the last line is machine-readable:
#   IMAGEFIRST_SETUP <CODE> exit=<n>
# Exit: 0  CHECK_OK (nothing BLOCKED) / APPLY_OK / TIMER_ENABLED / ROLLBACK_DONE
#       2  refused: usage, no --yes, --expect missing or not 40 hex, not root / a test hook in the production copy, the admin
#          clone untrusted, dirty, not detached, not at --expect, or --expect not origin's develop
#       3  CHECK_BLOCKED / SETUP_BLOCKED: a step is BLOCKED (nothing changed by the mode that found it)
#       4  TIMER_NOT_READY: enable-timer with a step not DONE
#       11 SETUP_LOCKED: another setup run holds the lock
#       20 SETUP_ORIGIN_UNREACHABLE: origin's develop could not be read
#       30 SETUP_CLI_FAILED, 31 SETUP_CODEX_CONFIG_FAILED, 32 SETUP_UNITS_FAILED, 33 SETUP_HARDENING_FAILED,
#       34 TIMER_ENABLE_FAILED, 35 ROLLBACK_INCOMPLETE
#       40 / 41 signal / internal error
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
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SR_IMAGEFIRST_SETUP_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec /usr/bin/env -i "${keep[@]}" /bin/bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
umask 077
cd /

# ---------------------------------------------------------------- pinned versions, limits
CLI_NAMES=(claude codex)
declare -A CLI_PKG=([claude]=@anthropic-ai/claude-code [codex]=@openai/codex)
declare -A CLI_VER=([claude]=2.1.295 [codex]=0.159.0)
KILL_AFTER=30
LS_REMOTE_TIMEOUT=180
NPM_TIMEOUT=900
SYSTEMCTL_TIMEOUT=150
HARDENING_TIMEOUT=300
# the doc's check 1: the unit's hardening (setup.test.ts pins every property against sr-imagefirst-autorun.service)
HARDENING=(-p ProtectSystem=strict -p ProtectHome=read-only -p ReadWritePaths=/home/sr-designgen -p PrivateTmp=yes
  -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes
  -p RestrictSUIDSGID=yes -p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK")

FINISHED=0
say() { printf 'imagefirst-autorun-setup: %s\n' "$*"; }
finish() {
  local code="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  printf 'IMAGEFIRST_SETUP %s exit=%s\n' "$code" "$rc"
  exit "$rc"
}
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return
  say "stopped by an unexpected error (exit $rc); see setup.log for what was done"
  finish SETUP_STOP_INTERNAL 41
}
on_signal() { finish SETUP_STOP_SIGNAL 40; }
trap on_exit EXIT
trap on_signal INT TERM HUP

# ---------------------------------------------------------------- arguments
USAGE="usage: imagefirst-autorun-setup.sh [check|apply|enable-timer|rollback] [--yes] --expect <40-hex commit>"
MODE=check
YES=0
EXPECT=""
if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then MODE="$1"; shift; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --expect) [ "$#" -ge 2 ] || { say "$USAGE"; finish SETUP_USAGE 2; }; EXPECT="$2"; shift 2 ;;
    *) say "$USAGE"; finish SETUP_USAGE 2 ;;
  esac
done
case "$MODE" in check | apply | enable-timer | rollback) ;; *) say "$USAGE"; finish SETUP_USAGE 2 ;; esac
[[ "$EXPECT" =~ ^[0-9a-f]{40}$ ]] || { say "SETUP_EXPECT_REQUIRED: --expect <the 40-hex commit the admin clone is checked out at> is required in every mode"; finish SETUP_EXPECT_REQUIRED 2; }
if [ "$MODE" = check ]; then
  [ "$YES" = 0 ] || { say "check is read-only and takes no --yes"; finish SETUP_USAGE 2; }
else
  [ "$YES" = 1 ] || { say "SETUP_NEEDS_YES: $MODE changes the system: it needs the owner's --yes (run check first and read it)"; finish SETUP_NEEDS_YES 2; }
fi

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
TEST_ROOT="${SR_IMAGEFIRST_SETUP_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || { say "SETUP_TEST_HOOK_REFUSED: test hooks are refused in $PROD_CLONE"; finish SETUP_USAGE 2; }
  [ "$(id -u)" = 0 ] || { say "run as root: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-autorun-setup.sh $MODE ..."; finish SETUP_USAGE 2; }
  R=""
  FILE_ROOT=root
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  NPM_PATH=/usr/local/bin:/usr/bin:/bin
  INSTALL_OWNER=(-o root -g root)
  ADMIN_GIT="$REPO"
else
  # Any other copy runs only the unit tests' fake WSL (tests/unit/design-agent/imagefirst-worker/setup.test.ts):
  # every path under the test root, npm / systemctl / systemd-run as the test's stubs, "root" is this user.
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || { say "run from the root-only clone: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-autorun-setup.sh $MODE ..."; finish SETUP_USAGE 2; }
  R="$TEST_ROOT"
  FILE_ROOT="$(id -un)"
  NPM_PATH="$PATH"
  INSTALL_OWNER=()
  ADMIN_GIT="$R$PROD_CLONE"
fi
WORKER_HOME="$R/home/sr-designgen"
PREFIX="$R/usr/local"
NPM="$R/usr/bin/npm"
NPM_HOME="$R/root"
ETC="$R/etc/sr-design-worker"
CODEX_CONFIG="$ETC/codex-config.toml"
SWITCH="$ETC/imagefirst-autostart.json"
UNIT_DIR="$R/etc/systemd/system"
STATE="$R/var/lib/sr-imagefirst-autostart"
LOG="$STATE/setup.log"
HARDENING_OK="$STATE/setup-hardening.ok"
SRC_CONFIG="$REPO/scripts/sales-design-worker/codex-config.toml"
SRC_UNITS="$REPO/scripts/sales-design-worker/systemd"
UNITS=(sr-imagefirst-autorun.service sr-imagefirst-autorun.timer)
TIMER=sr-imagefirst-autorun.timer
LEGACY_TIMER=sr-imagefirst-autostart.timer
ADMIN_SH="$REPO/scripts/sales-design-capture/admin.sh"
ROLLBACK_HINT="to undo: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-autorun-setup.sh rollback --yes --expect $EXPECT"

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
# trusted_path, and never inside the worker's home. The test world: links followed, the file exists, and every directory up
# to the test root is this user's and writable by nobody else.
root_path() {
  local p
  p="$(readlink -f -- "$1")" || return 1
  [ -e "$p" ] || return 1
  case "$p" in "$WORKER_HOME" | "$WORKER_HOME"/*) return 1 ;; esac
  if [ -z "$R" ]; then trusted_path "$p"; return; fi
  case "$p" in "$R"/*) ;; *) return 1 ;; esac
  while [ "$p" != "$R" ]; do
    [ "$(stat -c %U -- "$p")" = "$FILE_ROOT" ] || return 1
    [ $(( 0$(stat -c %a -- "$p") & 022 )) -eq 0 ] || return 1
    p="$(dirname -- "$p")"
  done
}
# A root file of this setup: a regular file (not a link), root's, writable by nobody else, in a root-trusted directory.
root_file() { [ -f "$1" ] && [ ! -L "$1" ] && root_path "$1"; }
absent() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
sha_of() { sha256sum <"$1" | cut -d" " -f1; }
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s %s\n' "$(utc)" "$MODE" "$*" >>"$LOG"; }
sc() { timeout --kill-after="$KILL_AFTER" "$SYSTEMCTL_TIMEOUT" systemctl "$@"; }
unit_state() { sc show -p "$1" --value "$2" 2>/dev/null || echo error; }

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

# The pinned SHA-256 of the reviewed Codex config: the very constant the pilot and its preflight check (both must agree).
PINNED_SHA=""
for f in imagefirst-pilot-preflight.sh imagefirst-pilot.sh; do
  v="$(sed -n 's/^CODEX_CONFIG_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$REPO/scripts/sales-design-worker/$f")"
  [[ "$v" =~ ^[0-9a-f]{64}$ ]] && { [ -z "$PINNED_SHA" ] || [ "$PINNED_SHA" = "$v" ]; } ||
    { say "SETUP_PIN_UNREADABLE: CODEX_CONFIG_SHA256 is missing, repeated or different in $f"; finish SETUP_STOP_INTERNAL 41; }
  PINNED_SHA="$v"
done

# ---------------------------------------------------------------- the admin clone: trusted, clean, detached at --expect (= develop)
if [ -z "$R" ]; then
  for f in "$SELF" "$SRC_CONFIG" "$SRC_UNITS/${UNITS[0]}" "$SRC_UNITS/${UNITS[1]}" "$ADMIN_SH" \
    "$REPO/scripts/sales-design-worker/imagefirst-pilot-preflight.sh" "$REPO/scripts/sales-design-worker/imagefirst-pilot.sh"; do
    trusted_path "$f" || { say "SETUP_ADMIN_CLONE_UNTRUSTED: $f must be root's and writable by nobody else, up to /"; finish SETUP_ADMIN_CLONE_UNTRUSTED 2; }
  done
fi
[ -d "$ADMIN_GIT/.git" ] || { say "SETUP_ADMIN_CLONE_MISSING: $ADMIN_GIT"; finish SETUP_ADMIN_CLONE_MISSING 2; }
# --no-optional-locks: status must not refresh the index (check writes nothing)
admin_dirty="$(git -C "$ADMIN_GIT" --no-optional-locks status --porcelain --untracked-files=normal 2>/dev/null)" || admin_dirty=unreadable
[ -z "$admin_dirty" ] || { say "SETUP_ADMIN_CLONE_DIRTY: $PROD_CLONE has changes (nothing is cleaned automatically)"; finish SETUP_ADMIN_CLONE_DIRTY 2; }
if git -C "$ADMIN_GIT" symbolic-ref -q HEAD >/dev/null 2>&1; then
  say "SETUP_ADMIN_NOT_DETACHED: $PROD_CLONE is on a branch. Run: sudo git -C $PROD_CLONE fetch -q origin && sudo git -C $PROD_CLONE checkout -q --detach $EXPECT"
  finish SETUP_ADMIN_NOT_DETACHED 2
fi
admin_head="$(git -C "$ADMIN_GIT" rev-parse HEAD 2>/dev/null)" || admin_head=""
if [ "$admin_head" != "$EXPECT" ]; then
  say "SETUP_ADMIN_NOT_EXPECTED: $PROD_CLONE is at ${admin_head:-?}, not $EXPECT. Run: sudo git -C $PROD_CLONE fetch -q origin && sudo git -C $PROD_CLONE checkout -q --detach $EXPECT"
  finish SETUP_ADMIN_NOT_EXPECTED 2
fi
if [ "$MODE" != rollback ]; then
  url="$(git -C "$ADMIN_GIT" config --get remote.origin.url 2>/dev/null)" || url=""
  [[ "$url" =~ ^[A-Za-z0-9._:/@+-]+$ ]] || { say "SETUP_ADMIN_CLONE_UNREADABLE: no plain origin URL in $PROD_CLONE"; finish SETUP_ADMIN_CLONE_UNREADABLE 2; }
  remote="$(timeout --kill-after="$KILL_AFTER" "$LS_REMOTE_TIMEOUT" git -C "$ADMIN_GIT" -c protocol.ext.allow=never ls-remote "$url" refs/heads/develop 2>/dev/null)" || remote=""
  develop="${remote%%[[:space:]]*}"
  [[ "$develop" =~ ^[0-9a-f]{40}$ ]] || { say "origin's develop could not be read from the admin clone's URL: nothing done"; finish SETUP_ORIGIN_UNREACHABLE 20; }
  [ "$develop" = "$EXPECT" ] || { say "SETUP_EXPECT_NOT_DEVELOP: origin's develop is $develop, not $EXPECT (fetch, check out that commit, and run check again)"; finish SETUP_EXPECT_NOT_DEVELOP 2; }
  say "admin clone $PROD_CLONE at $EXPECT (clean, detached, = origin's develop)"
else
  say "admin clone $PROD_CLONE at $EXPECT (clean, detached)"
fi

# ---------------------------------------------------------------- the steps (read only)
declare -A STEP WHY
CLI_OLD_claude=""
CLI_OLD_codex=""
legacy_target() {
  [[ "$1" == "$WORKER_HOME"/* ]] && [[ "$1" =~ ^/[A-Za-z0-9._/@+-]+$ ]] && [[ "$1" != *"/../"* ]] && [[ "$1" != */.. ]]
}
pkg_id() {
  python3 -I -c 'import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("INVALID"); sys.exit(0)
n, v = (d.get("name"), d.get("version")) if isinstance(d, dict) else (None, None)
print(n + " " + v if isinstance(n, str) and isinstance(v, str) else "INVALID")' "$1" 2>/dev/null || echo INVALID
}
check_cli() {
  local name pkg ver slot pkgdir real t id state=DONE why="" todo="" node=""
  for d in "$R/usr/bin" "$PREFIX" "$PREFIX/bin"; do
    root_path "$d" || { STEP[cli]=BLOCKED; WHY[cli]="$d is missing or not root's only up to /"; return; }
  done
  [ -f "$NPM" ] && root_path "$NPM" || { STEP[cli]=BLOCKED; WHY[cli]="/usr/bin/npm is missing or not root's only up to /"; return; }
  for n in "$PREFIX/bin/node" "$R/usr/bin/node" "$R/bin/node"; do if [ -e "$n" ]; then node="$n"; break; fi; done
  [ -n "$node" ] && root_path "$node" || { STEP[cli]=BLOCKED; WHY[cli]="node (as the worker's PATH finds it) is missing or not root's only up to /"; return; }
  for name in "${CLI_NAMES[@]}"; do
    pkg="${CLI_PKG[$name]}"; ver="${CLI_VER[$name]}"
    slot="$PREFIX/bin/$name"; pkgdir="$PREFIX/lib/node_modules/$pkg"
    if [ -e "$pkgdir" ] || [ -L "$pkgdir" ]; then
      root_path "$pkgdir" && [ ! -L "$pkgdir" ] || { STEP[cli]=BLOCKED; WHY[cli]="$pkgdir exists and is not root's only"; return; }
    fi
    if absent "$slot"; then
      todo+="$name: not installed; "
    elif [ -L "$slot" ] && t="$(readlink -- "$slot")" && legacy_target "$t"; then
      printf -v "CLI_OLD_$name" '%s' "$t"
      todo+="$name: /usr/local/bin/$name -> $t (the worker's home) to be replaced; "
    else
      real="$(readlink -f -- "$slot" 2>/dev/null)" || real=""
      if [[ "$real" == "$pkgdir"/* ]] && [ -f "$real" ] && root_path "$real"; then
        root_file "$pkgdir/package.json" && id="$(pkg_id "$pkgdir/package.json")" || id=INVALID
        if [ "$id" = "$pkg $ver" ]; then why+="$name $ver root-owned; "
        else todo+="$name: installed ${id#* } is not the pinned $ver; "
        fi
      else
        STEP[cli]=BLOCKED; WHY[cli]="/usr/local/bin/$name is neither absent, a symlink into /home/sr-designgen, nor the npm package's root-owned entry (${real:-unresolvable}): nothing is touched"
        return
      fi
    fi
  done
  if [ -n "$todo" ]; then state=TODO; why="$todo"; fi
  STEP[cli]="$state"; WHY[cli]="${why%; }"
}
check_codex_config() {
  [ "$(sha_of "$SRC_CONFIG")" = "$PINNED_SHA" ] || { STEP[codex_config]=BLOCKED; WHY[codex_config]="the repository's codex-config.toml is not the pinned $PINNED_SHA"; return; }
  if [ -e "$ETC" ] || [ -L "$ETC" ]; then
    [ -d "$ETC" ] && [ ! -L "$ETC" ] && root_path "$ETC" || { STEP[codex_config]=BLOCKED; WHY[codex_config]="$ETC is not a root-owned directory nobody else can write"; return; }
  fi
  if absent "$CODEX_CONFIG"; then STEP[codex_config]=TODO; WHY[codex_config]="/etc/sr-design-worker/codex-config.toml absent"; return; fi
  root_file "$CODEX_CONFIG" || { STEP[codex_config]=BLOCKED; WHY[codex_config]="$CODEX_CONFIG is not a root-owned regular file nobody else can write: look at it first"; return; }
  if [ "$(sha_of "$CODEX_CONFIG")" = "$PINNED_SHA" ]; then STEP[codex_config]=DONE; WHY[codex_config]="root's codex-config.toml, SHA-256 $PINNED_SHA"
  else STEP[codex_config]=TODO; WHY[codex_config]="root's codex-config.toml is not the pinned content (it is replaced)"
  fi
}
check_units() {
  local u st todo=""
  [ -d "$UNIT_DIR" ] && [ ! -L "$UNIT_DIR" ] && root_path "$UNIT_DIR" || { STEP[units]=BLOCKED; WHY[units]="$UNIT_DIR is not a root-owned directory"; return; }
  st="$(unit_state ActiveState sr-imagefirst-autostart.service)"
  [[ "$st" =~ ^(inactive|failed)$ ]] || { STEP[units]=BLOCKED; WHY[units]="the old sr-imagefirst-autostart.service is ${st:-unknown} (a worker may run): wait for it to end"; return; }
  st="$(unit_state ActiveState sr-imagefirst-autorun.service)"
  [[ "$st" =~ ^(inactive|failed)$ ]] || { STEP[units]=BLOCKED; WHY[units]="sr-imagefirst-autorun.service is ${st:-unknown} (a run is in progress)"; return; }
  unit_off "$LEGACY_TIMER" || todo+="the old $LEGACY_TIMER to be disabled ($UNIT_WHY); "
  for u in "${UNITS[@]}"; do
    if absent "$UNIT_DIR/$u"; then todo+="$u not installed; "; continue; fi
    root_file "$UNIT_DIR/$u" || { STEP[units]=BLOCKED; WHY[units]="$UNIT_DIR/$u is not a root-owned regular file nobody else can write: look at it first"; return; }
    if ! cmp -s "$UNIT_DIR/$u" "$SRC_UNITS/$u" || [ "$(stat -c %a -- "$UNIT_DIR/$u")" != 644 ]; then todo+="$u differs from the repository's (or is not 0644); "; continue; fi
    [ "$(unit_state LoadState "$u")" = loaded ] && [ "$(unit_state NeedDaemonReload "$u")" = no ] || todo+="$u needs a daemon-reload; "
  done
  if absent "$SWITCH"; then todo+="the switch imagefirst-autostart.json absent; "
  elif ! root_file "$SWITCH"; then STEP[units]=BLOCKED; WHY[units]="the switch $SWITCH is not a root-owned regular file nobody else can write"; return
  fi
  if [ -n "$todo" ]; then STEP[units]=TODO; WHY[units]="${todo%; }"
  else STEP[units]=DONE; WHY[units]="${UNITS[*]} installed and loaded; $LEGACY_TIMER off; the switch present"
  fi
}
hardening_key() { printf '%s %s\n' "$(sha_of "$UNIT_DIR/${UNITS[0]}")" "$(sha_of "$ADMIN_SH")"; }
check_hardening() {
  if [ "${STEP[units]}" != DONE ]; then STEP[hardening_check]=TODO; WHY[hardening_check]="after the units"; return; fi
  if [ -f "$HARDENING_OK" ] && [ ! -L "$HARDENING_OK" ] && [ "$(cat -- "$HARDENING_OK")" = "$(hardening_key)" ]; then
    STEP[hardening_check]=DONE; WHY[hardening_check]="admin.sh status passed under the unit's hardening (this service file and admin.sh)"
  else
    STEP[hardening_check]=TODO; WHY[hardening_check]="admin.sh status under the unit's hardening not run for this service file and admin.sh"
  fi
}
STEP_NAMES=(cli codex_config units hardening_check)
run_checks() {
  local s
  check_cli
  check_codex_config
  check_units
  check_hardening
  BLOCKED=0; TODO=0
  for s in "${STEP_NAMES[@]}"; do
    printf 'SETUP_STEP %s %s %s\n' "$s" "${STEP[$s]}" "${WHY[$s]}"
    case "${STEP[$s]}" in BLOCKED) BLOCKED=$((BLOCKED + 1)) ;; TODO) TODO=$((TODO + 1)) ;; esac
  done
  en="$(systemctl is-enabled "$TIMER" 2>/dev/null)" || true
  say "timer $TIMER: ${en:-not installed} (only enable-timer enables it)"
}

say "pinned: ${CLI_PKG[claude]}@${CLI_VER[claude]} ${CLI_PKG[codex]}@${CLI_VER[codex]}; codex-config.toml SHA-256 $PINNED_SHA"
run_checks
if [ "$MODE" = check ]; then
  say "$TODO step(s) TODO, $BLOCKED BLOCKED (nothing was changed)"
  if [ "$BLOCKED" -gt 0 ]; then finish CHECK_BLOCKED 3; fi
  finish CHECK_OK 0
fi
if [ "$MODE" != rollback ] && [ "$BLOCKED" -gt 0 ]; then say "a step is BLOCKED: nothing changed"; finish SETUP_BLOCKED 3; fi

# ---------------------------------------------------------------- the changing modes: root's state dir, the lock, the log
if absent "$STATE"; then install -d "${INSTALL_OWNER[@]}" -m 0700 "$STATE"; fi
[ -d "$STATE" ] && [ ! -L "$STATE" ] && root_path "$STATE" || { say "SETUP_STATE_UNSAFE: $STATE is not root's directory"; finish SETUP_STATE_UNSAFE 2; }
if [ -L "$LOG" ] || { [ -e "$LOG" ] && ! root_file "$LOG"; }; then say "SETUP_STATE_UNSAFE: $LOG is not root's regular file"; finish SETUP_STATE_UNSAFE 2; fi
exec 9>"$STATE/setup.lock"
flock -n 9 || { say "another setup run holds the lock"; finish SETUP_LOCKED 11; }
touch -- "$LOG" && chmod 0600 -- "$LOG"
log "start expect=$EXPECT steps: cli=${STEP[cli]} codex_config=${STEP[codex_config]} units=${STEP[units]} hardening_check=${STEP[hardening_check]}"
NPM_ENV=(HOME="$NPM_HOME" PATH="$NPM_PATH" LANG=C.UTF-8)
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
  if [ -n "${!name+x}" ]; then NPM_ENV+=("$name=${!name}"); fi
done
npm_g() {
  ( umask 022
    env -i "${NPM_ENV[@]}" timeout --kill-after="$KILL_AFTER" "$NPM_TIMEOUT" "$NPM" "$1" -g --prefix "$PREFIX" --userconfig /dev/null --globalconfig /dev/null \
      --no-audit --no-fund --loglevel=error "${@:2}" 9>&- )
}

# ---------------------------------------------------------------- enable-timer
if [ "$MODE" = enable-timer ]; then
  if [ "$TODO" -gt 0 ]; then say "TIMER_NOT_READY: every step must be DONE first (apply --yes): the timer stays off"; log "refused: steps not DONE"; finish TIMER_NOT_READY 4; fi
  log "systemctl enable --now $TIMER"
  sc enable --now "$TIMER" >/dev/null 2>&1 || { say "systemctl enable --now $TIMER failed"; log "enable failed"; finish TIMER_ENABLE_FAILED 34; }
  line="$(sc list-timers --all --no-pager "$TIMER" 2>/dev/null | grep -F "$TIMER" | head -n 1)" || line=""
  say "list-timers: ${line:-<no line>}"
  log "enabled: ${line:-<no line>}"
  finish TIMER_ENABLED 0
fi

# ---------------------------------------------------------------- rollback
if [ "$MODE" = rollback ]; then
  ok=1
  st="$(unit_state ActiveState sr-imagefirst-autorun.service)"
  [[ "$st" =~ ^(inactive|failed)$ ]] || { say "sr-imagefirst-autorun.service is ${st:-unknown}: stop the run first (sudo systemctl stop sr-imagefirst-autorun.service)"; log "refused: the service is $st"; finish SETUP_BLOCKED 3; }
  if [ "$(unit_state LoadState "$TIMER")" != not-found ]; then
    log "systemctl disable --now $TIMER"
    sc disable --now "$TIMER" >/dev/null 2>&1 || { say "systemctl disable --now $TIMER failed: nothing else removed"; log "disable failed"; finish ROLLBACK_INCOMPLETE 35; }
  fi
  for u in "${UNITS[@]}"; do
    if ! absent "$UNIT_DIR/$u"; then log "rm $UNIT_DIR/$u"; rm -f -- "$UNIT_DIR/$u"; fi
  done
  log "systemctl daemon-reload"
  sc daemon-reload >/dev/null 2>&1 || { say "daemon-reload failed"; log "daemon-reload failed"; ok=0; }
  pkgs=()
  for name in "${CLI_NAMES[@]}"; do if [ -d "$PREFIX/lib/node_modules/${CLI_PKG[$name]}" ]; then pkgs+=("${CLI_PKG[$name]}"); fi; done
  if [ "${#pkgs[@]}" -gt 0 ]; then
    log "npm uninstall -g --prefix /usr/local ${pkgs[*]}"
    npm_g uninstall "${pkgs[@]}" >/dev/null 2>&1 || { say "npm uninstall failed"; log "npm uninstall failed"; ok=0; }
  fi
  for name in "${CLI_NAMES[@]}"; do
    target="$(sed -n "s|^[0-9TZ:-]* apply OLD_LINK $name -> \\(.*\\)\$|\\1|p" "$LOG" | tail -n 1)"
    [ -n "$target" ] || continue
    slot="$PREFIX/bin/$name"
    if ! legacy_target "$target"; then say "the recorded old link for $name is not inside /home/sr-designgen: not restored"; log "not restored $name: bad record"; ok=0
    elif [ ! -e "$target" ]; then say "the old target of $name ($target) no longer exists: not restored"; log "not restored $name: $target gone"
    elif ! absent "$slot"; then say "/usr/local/bin/$name is not free: not restored (look at it)"; log "not restored $name: slot taken"; ok=0
    else ln -s -- "$target" "$slot"; log "restored $slot -> $target"; say "restored /usr/local/bin/$name -> $target"
    fi
  done
  for f in "$CODEX_CONFIG" "$HARDENING_OK"; do
    if ! absent "$f"; then log "rm $f"; rm -f -- "$f"; fi
  done
  say "used/, autorun/, the worker's claims, the ledgers and the switch are kept"
  log "done ok=$ok"
  [ "$ok" = 1 ] || finish ROLLBACK_INCOMPLETE 35
  finish ROLLBACK_DONE 0
fi

# ---------------------------------------------------------------- apply (never enables the timer)
if [ "$TODO" = 0 ]; then say "every step is already DONE: nothing to do"; log "nothing to do"; finish APPLY_OK 0; fi

if [ "${STEP[cli]}" = TODO ]; then
  for name in "${CLI_NAMES[@]}"; do
    old_var="CLI_OLD_$name"
    old="${!old_var}"
    [ -n "$old" ] || continue
    slot="$PREFIX/bin/$name"
    # the very link check saw, and nothing else
    [ -L "$slot" ] && [ "$(readlink -- "$slot")" = "$old" ] || { say "/usr/local/bin/$name changed since the check: nothing removed"; log "cli: $slot changed"; finish SETUP_CLI_FAILED 30; }
    log "OLD_LINK $name -> $old"
    rm -f -- "$slot"
    log "removed $slot"
    say "recorded and removed /usr/local/bin/$name -> $old"
  done
  specs=()
  for name in "${CLI_NAMES[@]}"; do specs+=("${CLI_PKG[$name]}@${CLI_VER[$name]}"); done
  log "npm install -g --prefix /usr/local ${specs[*]}"
  say "npm install -g --prefix /usr/local ${specs[*]} (as root, HOME=/root, no user / global npm config)"
  if ! npm_g install "${specs[@]}" >/dev/null 2>&1; then
    say "SETUP_CLI_FAILED: npm install failed; $ROLLBACK_HINT"; log "npm install failed"; finish SETUP_CLI_FAILED 30
  fi
  check_cli
  [ "${STEP[cli]}" = DONE ] || { say "SETUP_CLI_FAILED: after npm install: ${WHY[cli]}; $ROLLBACK_HINT"; log "cli not DONE: ${WHY[cli]}"; finish SETUP_CLI_FAILED 30; }
  log "cli DONE: ${WHY[cli]}"
fi

if [ "${STEP[codex_config]}" = TODO ]; then
  if absent "$ETC"; then install -d "${INSTALL_OWNER[@]}" -m 0755 "$ETC"; log "install -d -m 0755 $ETC"; fi
  install "${INSTALL_OWNER[@]}" -m 0644 -- "$SRC_CONFIG" "$CODEX_CONFIG"
  log "install -m 0644 $CODEX_CONFIG"
  check_codex_config
  [ "${STEP[codex_config]}" = DONE ] || { say "SETUP_CODEX_CONFIG_FAILED: ${WHY[codex_config]}; $ROLLBACK_HINT"; log "codex_config not DONE"; finish SETUP_CODEX_CONFIG_FAILED 31; }
  log "codex_config DONE sha256=$PINNED_SHA"
fi

if [ "${STEP[units]}" = TODO ]; then
  if ! unit_off "$LEGACY_TIMER"; then
    log "systemctl disable --now $LEGACY_TIMER"
    sc disable --now "$LEGACY_TIMER" >/dev/null 2>&1 || { say "SETUP_UNITS_FAILED: could not disable $LEGACY_TIMER"; log "legacy disable failed"; finish SETUP_UNITS_FAILED 32; }
  fi
  for u in "${UNITS[@]}"; do
    install "${INSTALL_OWNER[@]}" -m 0644 -- "$SRC_UNITS/$u" "$UNIT_DIR/$u"
    log "install -m 0644 $UNIT_DIR/$u"
  done
  log "systemctl daemon-reload"
  sc daemon-reload >/dev/null 2>&1 || { say "SETUP_UNITS_FAILED: daemon-reload failed; $ROLLBACK_HINT"; log "daemon-reload failed"; finish SETUP_UNITS_FAILED 32; }
  if absent "$SWITCH"; then
    if absent "$ETC"; then install -d "${INSTALL_OWNER[@]}" -m 0755 "$ETC"; log "install -d -m 0755 $ETC"; fi
    tmp_switch="$(mktemp "$ETC/.imagefirst-autostart.json.XXXXXX")"
    printf '{"enabled": true}\n' >"$tmp_switch"
    chmod 0644 -- "$tmp_switch"
    mv -n -T -- "$tmp_switch" "$SWITCH"
    rm -f -- "$tmp_switch"
    log "wrote $SWITCH {\"enabled\": true}"
  fi
  check_units
  [ "${STEP[units]}" = DONE ] || { say "SETUP_UNITS_FAILED: ${WHY[units]}; $ROLLBACK_HINT"; log "units not DONE: ${WHY[units]}"; finish SETUP_UNITS_FAILED 32; }
  log "units DONE"
fi

check_hardening
if [ "${STEP[hardening_check]}" = TODO ]; then
  log "systemd-run (the unit's hardening) admin.sh status"
  say "check 1: admin.sh status under the unit's hardening (Remote Control is not stopped)"
  set +e
  out="$(timeout --kill-after="$KILL_AFTER" "$HARDENING_TIMEOUT" systemd-run --wait --pipe --collect "${HARDENING[@]}" /usr/bin/bash "$ADMIN_SH" status 2>&1 9>&-)"
  hrc=$?
  set -e
  while IFS= read -r l; do say "  | $l"; done <<<"$(printf '%s' "$out" | tr -d '\000-\010\013-\037' | head -n 60)"
  if [ "$hrc" != 0 ] || ! grep -q '^approved: ' <<<"$out" || ! grep -q '^jail: ' <<<"$out" || grep -qiE 'permission denied|read-only file system' <<<"$out"; then
    say "SETUP_HARDENING_FAILED: admin.sh status did not print its table under the unit's hardening (exit $hrc). The timer stays off;"
    say "show these lines to Claude (adjusting the hardening is a separate approval); $ROLLBACK_HINT"
    log "hardening failed exit=$hrc"
    finish SETUP_HARDENING_FAILED 33
  fi
  hardening_key >"$HARDENING_OK"
  chmod 0600 -- "$HARDENING_OK"
  log "hardening_check DONE"
fi

say "after apply:"
run_checks
[ "$TODO" = 0 ] && [ "$BLOCKED" = 0 ] || { say "a step is not DONE after apply"; log "not all DONE"; finish SETUP_UNITS_FAILED 32; }
log "apply done (the timer was not enabled)"
say "every step DONE. The timer is NOT enabled: that is the separate step enable-timer --yes --expect $EXPECT"
finish APPLY_OK 0
}
