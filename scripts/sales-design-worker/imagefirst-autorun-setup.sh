#!/usr/bin/env bash
# Second Root IMAGE_FIRST automatic run: the owner's ONE-TIME setup, bundled (Issue #302, docs/operations/imagefirst-autorun.md
# §2). It replaces the manual root commands of §2 (kept there as an appendix) with one reviewed script and three separate
# owner approvals: check (read-only) -> apply -> enable-timer. rollback undoes what apply recorded.
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh check --expect <sha>
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh apply --yes --expect <sha>
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh enable-timer --yes --expect <sha>
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh rollback --yes --expect <sha>
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh standing --yes --expect <sha> \
#        --per-day <N 1-4> --per-week <M 1-20, at least N> --days <D 1-90>
#   sudo bash /usr/local/lib/sr-imagefirst/scripts/sales-design-worker/imagefirst-autorun-setup.sh standing --revoke --yes
#   sudo bash /usr/local/lib/sr-imagefirst/scripts/sales-design-worker/imagefirst-autorun-setup.sh standing --unfreeze --yes
#
# standing (DEV-303, owner decision 2026-11-23): the owner's ONE-TIME standing pre-authorization of image generation. It
# writes root's /etc/sr-design-worker/imagefirst-standing.json (0644, root's; a temporary file renamed over the old one) as
#   {"schema": "sr_imagefirst_standing_v1", "per_day": N, "per_week": M, "not_after": "<now + D days, UTC>",
#    "created_at": "<now, UTC>", "worker_commit": "<--expect>", "origin_url": "<the admin clone's configured origin URL>"}
# and nothing else (separate from apply and enable-timer; it neither installs nor enables anything). From then on the
# automatic run (imagefirst-autorun.sh) picks up Claude's request files one at a time within those limits until not_after,
# with no per-run command. worker_commit is the commit the owner typed (--expect, verified as the admin clone's clean,
# detached HEAD and origin's develop at that moment): every run under the policy executes THAT worker code and nothing
# else (never develop's tip); running standing again with a newer --expect is the only way newer worker code reaches runs.
# standing --unfreeze --yes removes root's freeze (written by the automatic run when a run broke a per-run limit, e.g.
# more than 6 images); look at the run first. Anything outside 1 <= N <= 4, 1 <= M <= 20, M >= N, 1 <= D <= 90 is refused (STANDING_INVALID).
# standing --revoke --yes removes the policy (needs no --expect and no admin clone: it must always work). Both are logged in
# setup.log. Changing the limits is running standing again (the new file replaces the old one).
#
# Run by root, only from the root-only admin clone (/root/sr-capture-admin), by a person. Every mode first checks the admin
# clone: this script and every file it installs root's and writable by nobody else up to / (trusted_path); the clone clean;
# HEAD detached at exactly the commit the owner typed (--expect <40 hex>, required in every mode); and (check / apply /
# enable-timer) that commit is origin's develop (git ls-remote of the admin clone's own configured URL, nothing written).
# rollback does not ask for develop (it must work after develop moved on).
#
# Steps (check prints one line for each: SETUP_STEP <name> <DONE|TODO|BLOCKED> <reason>; scripts is DEV-303's):
#   cli             claude and codex root-owned under /usr/local, from FOUR registry tarballs pinned by their sha512 integrity
#                   (the npm registry's dist.integrity): @anthropic-ai/claude-code@2.1.295, its native
#                   @anthropic-ai/claude-code-linux-x64@2.1.295, @openai/codex@0.159.0 and its native
#                   @openai/codex@0.159.0-linux-x64. apply checks the free space of the state dir's filesystem (1024 MiB,
#                   else BLOCKED), downloads them (curl -q, https only, env -i, each capped at its pinned size + 4 KiB) into
#                   a root-only directory, verifies every sha512 BEFORE anything changes, checks their members (only plain
#                   files and directories under package/, no setuid / setgid / sticky bit), then installs the two wrapper
#                   packages FROM THOSE LOCAL FILES with
#                   /usr/bin/npm install -g --prefix /usr/local --ignore-scripts --omit=optional --os=sr-none --cpu=sr-none
#                   --no-update-notifier (env -i: HOME=/root, a fixed PATH, LANG; no proxy, CA or npm-config variable;
#                   --userconfig / --globalconfig two distinct empty root-only files made fresh in the state dir for each
#                   npm call and removed after it: npm 11 refuses one file, /dev/null too, loaded as both; umask 022). In
#                   a global install --omit=optional does not stop npm fetching the optional natives from the registry:
#                   --os/--cpu name a platform no native matches, so npm skips them and this script places the verified
#                   natives itself. npm's output goes to a root-only file; on a failure its last lines (token-like
#                   strings masked) are printed and logged. Then apply
#                   checks the installed package dirs hold exactly the verified tarballs' files (same bytes, nothing extra);
#                   after placing the natives, chmod -R u-s,g-s,-t on both packages. No vendor code runs as root: claude-code's only
#                   lifecycle script (postinstall: node install.cjs, which copies the native binary over the bin/claude.exe
#                   placeholder) is skipped, and this script does that itself (install -m 0755 of the verified native
#                   `claude`); codex has no lifecycle script, and its native package is placed where npm would put the
#                   optional dependency (@openai/codex/node_modules/@openai/codex-linux-x64), where bin/codex.js looks.
#                   Today /usr/local/bin/{claude,codex} are root's symlinks into the worker's home: apply records (setup.log)
#                   and removes ONLY such symlinks (after the downloads are verified); anything else there is BLOCKED and
#                   nothing is touched. DONE: each /usr/local/bin/<cli> resolves (readlink -f) to its package's entry, root's
#                   and writable by nobody else up to /; package.json carries the pinned name and version (read as JSON);
#                   the native binaries are ELF files of more than 1 MiB with the pinned SHA-256 (never executed). node (as the
#                   worker's PATH /usr/local/bin:/usr/bin:/bin finds it) and /usr/bin/npm root-trusted; the machine x86_64.
#                   The worker's own PATH (~/.npm-global/bin first) is not changed.
#   codex_config    the repository's codex-config.toml installed root 0644 to /etc/sr-design-worker/ (dir root 0755); its
#                   SHA-256 must be the pinned CODEX_CONFIG_SHA256 of imagefirst-pilot-preflight.sh and imagefirst-pilot.sh
#                   (read from those two files, which must agree; setup.test.ts pins all three to the repository's file)
#   scripts         every script root runs (the automatic run, the pilot, its preflight, the approval command, this setup,
#                   the re-send wrapper, admin.sh with host-check.sh and its jail files, the memory check) installed from the
#                   admin clone into /usr/local/lib/sr-imagefirst/<the same path> (files root 0755 / 0644 data, directories
#                   0755, byte-identical to the admin clone's), and their SHA-256 in /usr/local/lib/sr-imagefirst/SHA256SUMS
#                   (0644; also in setup.log). The units start ONLY that copy, and the automatic run refuses unless each file
#                   is root's, writable by nobody else up to /, with the recorded SHA-256. Root never runs the admin clone's
#                   or develop's scripts; a newer develop reaches root only through check -> apply again
#   units           the old hourly sr-imagefirst-autostart.timer disabled (if present); sr-imagefirst-autorun.{service,timer}
#                   installed 0644 (byte-identical to the repository's); daemon-reload; the owner's switch
#                   /etc/sr-design-worker/imagefirst-autostart.json written as {"enabled": true} ONLY if absent
#   hardening_check the doc's check 1 with the unit's FULL hardening (every [Service] property of sr-imagefirst-autorun.service
#                   but the lifecycle ones, setup.test.ts pins both directions): systemd-run running admin.sh status must
#                   print its status table (else SETUP_HARDENING_FAILED: nothing further, the timer stays off, the rollback
#                   line is printed). A pass is recorded (root's state, bound to the service file's and admin.sh's SHA-256).
#                   It runs the INSTALLED admin.sh (the one the unit runs).
# apply NEVER enables the timer. enable-timer is a separate owner approval and needs all five steps DONE.
# rollback undoes ONLY what setup.log says apply changed (since the last complete rollback): the timer disabled and the two
# unit files removed (units), daemon-reload, the two npm packages uninstalled and the two old symlinks restored exactly as
# recorded, only if their targets still exist and the place is free (cli), root's codex-config.toml (codex_config), the
# installed copy /usr/local/lib/sr-imagefirst (scripts), the recorded hardening pass. The old sr-imagefirst-autostart.timer
# stays disabled. It NEVER removes used/, autorun/, rejected/, requests/, the worker's claims, the entry's ledgers, the
# owner's switch or the standing policy (standing --revoke does that).
#
# Every action of apply / enable-timer / rollback is appended to root's /var/lib/sr-imagefirst-autostart/setup.log (0600;
# the state dir 0700), including what the old symlinks pointed to. check writes nothing anywhere. Sign-in files stay in the
# worker's home: this script never reads them.
#
# Output: fixed lines; the last line is machine-readable:
#   IMAGEFIRST_SETUP <CODE> exit=<n>
# Exit: 0  CHECK_OK (nothing BLOCKED) / APPLY_OK / TIMER_ENABLED / ROLLBACK_DONE / STANDING_WRITTEN / STANDING_REVOKED /
#          STANDING_UNFROZEN
#       2  refused: usage, no --yes, --expect missing or not 40 hex, not root / a test hook in the production copy / root in
#          a test copy, the admin clone untrusted, dirty, not detached, not at --expect, or --expect not origin's develop
#       3  CHECK_BLOCKED / SETUP_BLOCKED: a step is BLOCKED (nothing changed by the mode that found it); rollback during a run
#       4  TIMER_NOT_READY: enable-timer with a step not DONE
#       11 SETUP_LOCKED: another setup run holds the lock
#       20 SETUP_ORIGIN_UNREACHABLE: origin's develop could not be read
#       30 SETUP_CLI_FAILED (a download, a sha512, a member, npm, a compared file, a native binary), 31 SETUP_CODEX_CONFIG_FAILED,
#       32 SETUP_UNITS_FAILED, 33 SETUP_HARDENING_FAILED, 34 TIMER_ENABLE_FAILED, 35 ROLLBACK_INCOMPLETE, 36 SETUP_SCRIPTS_FAILED
#       (standing) 2 STANDING_INVALID: a limit outside the ceilings
#       40 / 41 signal / internal error
#
# The whole script is one { ... } block, so bash has read all of it before it starts.
{
set -euo pipefail

# Restart with an allowlisted environment (marked by an argument, not a variable). No proxy, CA or npm variable passes.
if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in PATH LANG TZ SR_IMAGEFIRST_SETUP_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec /usr/bin/env -i "${keep[@]}" /bin/bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
umask 077
cd /

# ---------------------------------------------------------------- pinned versions and tarballs, limits
CLI_NAMES=(claude codex)
declare -A CLI_PKG=([claude]=@anthropic-ai/claude-code [codex]=@openai/codex)
declare -A CLI_VER=([claude]=2.1.295 [codex]=0.159.0)
# the npm registry's dist.tarball and dist.integrity of every tarball used (npm view <spec> dist.tarball dist.integrity)
TGZS=(claude claude_native codex codex_native)
declare -A TGZ_URL=(
  [claude]=https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.295.tgz
  [claude_native]=https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.295.tgz
  [codex]=https://registry.npmjs.org/@openai/codex/-/codex-0.159.0.tgz
  [codex_native]=https://registry.npmjs.org/@openai/codex/-/codex-0.159.0-linux-x64.tgz
)
declare -A TGZ_SRI=(
  [claude]=sha512-PTdE5NdqwwyCmtbX/0WAuosyip8DkwC6M5mAJv+b9KGuxMFnkTJbc2b3EY6FYdo5ZTWkm6MN8reA9YWWMrLR+g==
  [claude_native]=sha512-nC9RZ6ZArEavyAiFdEtGK6/XPhjfE79tP2tCh+PjmRUxSO/6W3IuXv/rmo8c6u2UzHyvgKodRj1z6UcBGlbnyA==
  [codex]=sha512-nQWxAkzn+Rhr8TgtIhVhSlqvCytrMoqe+P8xoo4xxhCIBnzOfRs6SEmkMJfTPjkU3BYlsplwDOY2dbSp4+514g==
  [codex_native]=sha512-7ks+EeQjX33wfJXbggseyF0CJRFVgzDHA6BzC7mJjFsJKmdAuOFWMFeMeZe8vL/G6xEpL29wOdwR85sK49F0iA==
)
# the native binaries inside the two native tarballs (package/claude; package/vendor/x86_64-unknown-linux-musl/bin/codex)
declare -A BIN_SHA256=(
  [claude]=4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358
  [codex]=d2752c52353401f7f6efbfcea68796f4f7a3d3e4769f5d1da53fa49d4856b72f
)
CODEX_NATIVE_PKG=@openai/codex-linux-x64
CODEX_NATIVE_ID="@openai/codex 0.159.0-linux-x64"
CODEX_TRIPLE=x86_64-unknown-linux-musl
# the tarballs' sizes in bytes (curl --max-filesize: the size + 4 KiB)
declare -A TGZ_SIZE=([claude]=28892 [claude_native]=114433914 [codex]=4902 [codex_native]=162481799)
SIZE_MARGIN=4096
# free space the download and its unpacking need in the state dir's filesystem (~280 MB + ~700 MB)
NEED_FREE_MIB=1024
MIN_NATIVE_BYTES=1048576
KILL_AFTER=30
LS_REMOTE_TIMEOUT=180
FETCH_TIMEOUT=1800
NPM_TIMEOUT=900
SYSTEMCTL_TIMEOUT=150
HARDENING_TIMEOUT=300
# The doc's check 1: EVERY [Service] property of sr-imagefirst-autorun.service except the lifecycle ones (Type, ExecStart,
# ExecStopPost, TimeoutStartSec, TimeoutStopSec, KillMode, SuccessExitStatus: they describe the real run, and ExecStopPost
# would start Remote Control). One property per line; setup.test.ts pins script = unit in both directions.
HARDENING=(
  -p "WorkingDirectory=/"
  -p "StateDirectory=sr-imagefirst-autostart"
  -p "StateDirectoryMode=0700"
  -p "UMask=0077"
  -p "NoNewPrivileges=yes"
  -p "ProtectSystem=strict"
  -p "ProtectHome=read-only"
  -p "ReadWritePaths=/home/sr-designgen -/var/lib/sr-design-cycle"
  -p "PrivateTmp=yes"
  -p "ProtectKernelTunables=yes"
  -p "ProtectKernelModules=yes"
  -p "ProtectKernelLogs=yes"
  -p "ProtectControlGroups=yes"
  -p "RestrictSUIDSGID=yes"
  -p "LockPersonality=yes"
  -p "RestrictRealtime=yes"
  -p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK"
  -p "Nice=10"
  -p "CPUWeight=20"
  -p "IOSchedulingClass=best-effort"
  -p "IOSchedulingPriority=7"
  -p "MemoryHigh=3G"
  -p "MemoryMax=4G"
  -p "TasksMax=512"
)

FINISHED=0
WORK=""
say() { printf 'imagefirst-autorun-setup: %s\n' "$*"; }
finish() {
  local code="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  [ -z "$WORK" ] || rm -rf -- "$WORK"
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
USAGE="usage: imagefirst-autorun-setup.sh [check|apply|enable-timer|rollback] [--yes] --expect <40-hex commit> | standing --yes --expect <40-hex commit> --per-day <1-4> --per-week <1-20> --days <1-90> | standing --revoke --yes | standing --unfreeze --yes"
MODE=check
YES=0
EXPECT=""
REVOKE=0
UNFREEZE=0
PER_DAY=""
PER_WEEK=""
DAYS=""
if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then MODE="$1"; shift; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --expect) [ "$#" -ge 2 ] || { say "$USAGE"; finish SETUP_USAGE 2; }; EXPECT="$2"; shift 2 ;;
    --revoke) REVOKE=1; shift ;;
    --unfreeze) UNFREEZE=1; shift ;;
    --per-day) [ "$#" -ge 2 ] || { say "$USAGE"; finish SETUP_USAGE 2; }; PER_DAY="$2"; shift 2 ;;
    --per-week) [ "$#" -ge 2 ] || { say "$USAGE"; finish SETUP_USAGE 2; }; PER_WEEK="$2"; shift 2 ;;
    --days) [ "$#" -ge 2 ] || { say "$USAGE"; finish SETUP_USAGE 2; }; DAYS="$2"; shift 2 ;;
    *) say "$USAGE"; finish SETUP_USAGE 2 ;;
  esac
done
case "$MODE" in check | apply | enable-timer | rollback | standing) ;; *) say "$USAGE"; finish SETUP_USAGE 2 ;; esac
if [ "$MODE" != standing ] && { [ "$REVOKE" = 1 ] || [ "$UNFREEZE" = 1 ] || [ -n "$PER_DAY$PER_WEEK$DAYS" ]; }; then say "$USAGE"; finish SETUP_USAGE 2; fi
[ "$REVOKE" = 0 ] || [ "$UNFREEZE" = 0 ] || { say "$USAGE"; finish SETUP_USAGE 2; }
# --unfreeze is handled as --revoke is (no --expect, no admin clone)
OWNER_ONLY=0
if [ "$MODE" = standing ] && { [ "$REVOKE" = 1 ] || [ "$UNFREEZE" = 1 ]; }; then OWNER_ONLY=1; fi
# the standing policy's ceilings (imagefirst-autorun.sh refuses a policy above them too)
MAX_PER_DAY=4
MAX_PER_WEEK=20
MAX_POLICY_DAYS=90
if [ "$OWNER_ONLY" = 1 ]; then
  [ -z "$PER_DAY$PER_WEEK$DAYS$EXPECT" ] || { say "standing --revoke --yes / --unfreeze --yes take nothing else"; finish SETUP_USAGE 2; }
elif [ "$MODE" = standing ]; then
  if ! [[ "$PER_DAY" =~ ^[1-9][0-9]{0,2}$ ]] || ! [[ "$PER_WEEK" =~ ^[1-9][0-9]{0,2}$ ]] || ! [[ "$DAYS" =~ ^[1-9][0-9]{0,2}$ ]] ||
    [ "$PER_DAY" -gt "$MAX_PER_DAY" ] || [ "$PER_WEEK" -gt "$MAX_PER_WEEK" ] || [ "$PER_WEEK" -lt "$PER_DAY" ] || [ "$DAYS" -gt "$MAX_POLICY_DAYS" ]; then
    say "STANDING_INVALID: --per-day 1-$MAX_PER_DAY, --per-week 1-$MAX_PER_WEEK (at least --per-day), --days 1-$MAX_POLICY_DAYS (whole numbers): nothing written"
    finish STANDING_INVALID 2
  fi
fi
if [ "$OWNER_ONLY" = 0 ]; then
  [[ "$EXPECT" =~ ^[0-9a-f]{40}$ ]] || { say "SETUP_EXPECT_REQUIRED: --expect <the 40-hex commit the admin clone is checked out at> is required in every mode"; finish SETUP_EXPECT_REQUIRED 2; }
fi
if [ "$MODE" = check ]; then
  [ "$YES" = 0 ] || { say "check is read-only and takes no --yes"; finish SETUP_USAGE 2; }
else
  [ "$YES" = 1 ] || { say "SETUP_NEEDS_YES: $MODE changes the system: it needs the owner's --yes (run check first and read it)"; finish SETUP_NEEDS_YES 2; }
fi

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
# the installed copy of root's scripts (the scripts step): a production copy of this script too
INSTALL_DIR=/usr/local/lib/sr-imagefirst
TEST_ROOT="${SR_IMAGEFIRST_SETUP_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ] || [ "$REPO" = "$INSTALL_DIR" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || { say "SETUP_TEST_HOOK_REFUSED: test hooks are refused in $PROD_CLONE"; finish SETUP_USAGE 2; }
  [ "$(id -u)" = 0 ] || { say "run as root: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-autorun-setup.sh $MODE ..."; finish SETUP_USAGE 2; }
  R=""
  FILE_ROOT=root
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  NPM_PATH=/usr/local/bin:/usr/bin:/bin
  CURL_PATH=/usr/bin:/bin
  INSTALL_OWNER=(-o root -g root)
  ADMIN_GIT="$PROD_CLONE"
else
  # Any other copy runs only the unit tests' fake WSL (tests/unit/design-agent/imagefirst-worker/setup.test.ts):
  # every path under the test root, npm / curl / systemctl / systemd-run as the test's stubs, "root" is this user.
  # Never as root: a test copy must not change a real system.
  [ "$(id -u)" != 0 ] || { say "SETUP_TEST_COPY_AS_ROOT: a copy outside $PROD_CLONE never runs as root"; finish SETUP_USAGE 2; }
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || { say "run from the root-only clone: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-autorun-setup.sh $MODE ..."; finish SETUP_USAGE 2; }
  R="$TEST_ROOT"
  FILE_ROOT="$(id -un)"
  NPM_PATH="$PATH"
  CURL_PATH="$PATH"
  INSTALL_OWNER=()
  ADMIN_GIT="$R$PROD_CLONE"
  # the test world's own tarballs carry their own pins (the production copy can never read this file: R is empty there)
  if [ -f "$R/test-pins" ]; then
    while IFS= read -r l; do
      if [[ "$l" =~ ^SRI_(claude|claude_native|codex|codex_native)=(sha512-[A-Za-z0-9+/=]+)$ ]]; then TGZ_SRI[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
      elif [[ "$l" =~ ^BIN_(claude|codex)=([0-9a-f]{64})$ ]]; then BIN_SHA256[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
      elif [[ "$l" =~ ^SIZE_(claude|claude_native|codex|codex_native)=([0-9]+)$ ]]; then TGZ_SIZE[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
      fi
    done <"$R/test-pins"
  fi
fi
# where the files to install come from: this copy's repository, or (run from the installed copy) root's admin clone
SRC="$REPO"
if [ "$REPO" = "$R$INSTALL_DIR" ]; then SRC="$ADMIN_GIT"; fi
INST="$R$INSTALL_DIR"
MANIFEST="$INST/SHA256SUMS"
# every script root runs (and what admin.sh sources or installs from its own directory): installed into INST, same paths
INSTALL_FILES=(
  scripts/sales-design-worker/imagefirst-autorun.sh
  scripts/sales-design-worker/imagefirst-pilot.sh
  scripts/sales-design-worker/imagefirst-pilot-preflight.sh
  scripts/sales-design-worker/imagefirst-approve.sh
  scripts/sales-design-worker/imagefirst-autorun-setup.sh
  scripts/sales-design-worker/imagefirst-deliver-review.sh
  scripts/sales-design-capture/admin.sh
  scripts/sales-design-capture/host-check.sh
  scripts/sales-design-capture/jail/jail.properties
  scripts/sales-design-capture/jail/probe.py
  scripts/ops/wsl-resource-preflight.sh
)
WORKER_HOME="$R/home/sr-designgen"
PREFIX="$R/usr/local"
NPM="$R/usr/bin/npm"
NPM_HOME="$R/root"
ETC="$R/etc/sr-design-worker"
CODEX_CONFIG="$ETC/codex-config.toml"
SWITCH="$ETC/imagefirst-autostart.json"
STANDING="$ETC/imagefirst-standing.json"
FREEZE="$R/var/lib/sr-imagefirst-autostart/standing.frozen"
UNIT_DIR="$R/etc/systemd/system"
STATE="$R/var/lib/sr-imagefirst-autostart"
LOG="$STATE/setup.log"
HARDENING_OK="$STATE/setup-hardening.ok"
SRC_CONFIG="$SRC/scripts/sales-design-worker/codex-config.toml"
SRC_UNITS="$SRC/scripts/sales-design-worker/systemd"
UNITS=(sr-imagefirst-autorun.service sr-imagefirst-autorun.timer)
TIMER=sr-imagefirst-autorun.timer
LEGACY_TIMER=sr-imagefirst-autostart.timer
# check 1 runs the installed admin.sh (the one the unit's script runs)
ADMIN_SH="$INST/scripts/sales-design-capture/admin.sh"
PKG_DIR_claude="$PREFIX/lib/node_modules/${CLI_PKG[claude]}"
PKG_DIR_codex="$PREFIX/lib/node_modules/${CLI_PKG[codex]}"
CLAUDE_ENTRY="$PKG_DIR_claude/bin/claude.exe"
CODEX_ENTRY="$PKG_DIR_codex/bin/codex.js"
CODEX_NATIVE_DIR="$PKG_DIR_codex/node_modules/$CODEX_NATIVE_PKG"
CODEX_NATIVE_BIN="$CODEX_NATIVE_DIR/vendor/$CODEX_TRIPLE/bin/codex"
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
# A native binary as placed: root's regular file, an ELF of more than 1 MiB, the pinned SHA-256. Never executed.
native_ok() {
  root_file "$1" || return 1
  [ "$(head -c 4 -- "$1" | od -An -tx1 | tr -d ' \n')" = 7f454c46 ] || return 1
  [ "$(stat -c %s -- "$1")" -gt "$MIN_NATIVE_BYTES" ] || return 1
  [ "$(sha_of "$1")" = "$2" ]
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

# Root's state dir (0700), this script's lock and its log (0600), for every changing mode.
open_state() {
  if absent "$STATE"; then install -d "${INSTALL_OWNER[@]}" -m 0700 "$STATE"; fi
  [ -d "$STATE" ] && [ ! -L "$STATE" ] && root_path "$STATE" || { say "SETUP_STATE_UNSAFE: $STATE is not root's directory"; finish SETUP_STATE_UNSAFE 2; }
  if [ -L "$LOG" ] || { [ -e "$LOG" ] && ! root_file "$LOG"; }; then say "SETUP_STATE_UNSAFE: $LOG is not root's regular file"; finish SETUP_STATE_UNSAFE 2; fi
  exec 9>"$STATE/setup.lock"
  flock -n 9 || { say "another setup run holds the lock"; finish SETUP_LOCKED 11; }
  touch -- "$LOG" && chmod 0600 -- "$LOG"
}

# ---------------------------------------------------------------- standing --revoke: always possible (no admin clone, no --expect)
if [ "$MODE" = standing ] && [ "$REVOKE" = 1 ]; then
  open_state
  if absent "$STANDING"; then
    say "no standing pre-authorization to revoke ($STANDING absent)"
    log "standing revoke: nothing there"
  else
    # removed whatever it is (a link is removed, never followed)
    rm -f -- "$STANDING"
    log "standing revoked: rm $STANDING"
    say "the standing pre-authorization is revoked: the automatic run picks up no request any more (a run already started finishes)"
  fi
  finish STANDING_REVOKED 0
fi
if [ "$MODE" = standing ] && [ "$UNFREEZE" = 1 ]; then
  open_state
  if absent "$FREEZE"; then
    say "standing pick-ups are not frozen"
    log "standing unfreeze: nothing there"
  else
    log "standing unfrozen: $(head -c 300 -- "$FREEZE" 2>/dev/null | tr '\n' ' ' | tr -d '\000-\037')"
    rm -f -- "$FREEZE"
    say "standing pick-ups are unfrozen (the automatic run picks up requests again within the limits)"
  fi
  finish STANDING_UNFROZEN 0
fi

# The pinned SHA-256 of the reviewed Codex config: the very constant the pilot and its preflight check (both must agree).
PINNED_SHA=""
for f in imagefirst-pilot-preflight.sh imagefirst-pilot.sh; do
  v="$(sed -n 's/^CODEX_CONFIG_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$SRC/scripts/sales-design-worker/$f")"
  [[ "$v" =~ ^[0-9a-f]{64}$ ]] && { [ -z "$PINNED_SHA" ] || [ "$PINNED_SHA" = "$v" ]; } ||
    { say "SETUP_PIN_UNREADABLE: CODEX_CONFIG_SHA256 is missing, repeated or different in $f"; finish SETUP_STOP_INTERNAL 41; }
  PINNED_SHA="$v"
done

# ---------------------------------------------------------------- the admin clone: trusted, clean, detached at --expect (= develop)
if [ -z "$R" ]; then
  for f in "$SELF" "$SRC_CONFIG" "$SRC_UNITS/${UNITS[0]}" "$SRC_UNITS/${UNITS[1]}"; do
    trusted_path "$f" || { say "SETUP_ADMIN_CLONE_UNTRUSTED: $f must be root's and writable by nobody else, up to /"; finish SETUP_ADMIN_CLONE_UNTRUSTED 2; }
  done
  for rel in "${INSTALL_FILES[@]}"; do
    trusted_path "$SRC/$rel" || { say "SETUP_ADMIN_CLONE_UNTRUSTED: $SRC/$rel must be root's and writable by nobody else, up to /"; finish SETUP_ADMIN_CLONE_UNTRUSTED 2; }
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
  [[ "$url" =~ ^[A-Za-z0-9._:/@+][A-Za-z0-9._:/@+-]*$ ]] || { say "SETUP_ADMIN_CLONE_UNREADABLE: no plain origin URL in $PROD_CLONE (none, an unusual character, or a leading -)"; finish SETUP_ADMIN_CLONE_UNREADABLE 2; }
  remote="$(timeout --kill-after="$KILL_AFTER" "$LS_REMOTE_TIMEOUT" git -C "$ADMIN_GIT" -c protocol.ext.allow=never ls-remote "$url" refs/heads/develop 2>/dev/null)" || remote=""
  develop="${remote%%[[:space:]]*}"
  [[ "$develop" =~ ^[0-9a-f]{40}$ ]] || { say "origin's develop could not be read from the admin clone's URL: nothing done"; finish SETUP_ORIGIN_UNREACHABLE 20; }
  [ "$develop" = "$EXPECT" ] || { say "SETUP_EXPECT_NOT_DEVELOP: origin's develop is $develop, not $EXPECT (fetch, check out that commit, and run check again)"; finish SETUP_EXPECT_NOT_DEVELOP 2; }
  say "admin clone $PROD_CLONE at $EXPECT (clean, detached, = origin's develop)"
else
  say "admin clone $PROD_CLONE at $EXPECT (clean, detached)"
fi

# ---------------------------------------------------------------- standing: the owner's one-time standing pre-authorization
if [ "$MODE" = standing ]; then
  if [ -e "$ETC" ] || [ -L "$ETC" ]; then
    [ -d "$ETC" ] && [ ! -L "$ETC" ] && root_path "$ETC" || { say "SETUP_STATE_UNSAFE: $ETC is not a root-owned directory nobody else can write"; finish SETUP_STATE_UNSAFE 2; }
  fi
  open_state
  now_s="$(date -u +%s)"
  created="$(date -u -d "@$now_s" +%Y-%m-%dT%H:%M:%SZ)"
  until_at="$(date -u -d "@$((now_s + DAYS * 86400))" +%Y-%m-%dT%H:%M:%SZ)"
  if absent "$ETC"; then install -d "${INSTALL_OWNER[@]}" -m 0755 "$ETC"; log "install -d -m 0755 $ETC"; fi
  tmp_policy="$(mktemp "$ETC/.imagefirst-standing.json.XXXXXX")"
  # worker_commit: the commit the owner typed, verified above as the admin clone's clean detached HEAD and origin's develop
  printf '{"schema": "sr_imagefirst_standing_v1", "per_day": %d, "per_week": %d, "not_after": "%s", "created_at": "%s", "worker_commit": "%s", "origin_url": "%s"}\n' \
    "$PER_DAY" "$PER_WEEK" "$until_at" "$created" "$EXPECT" "$url" >"$tmp_policy"
  chmod 0644 -- "$tmp_policy"
  mv -f -T -- "$tmp_policy" "$STANDING"
  log "standing written: per_day=$PER_DAY per_week=$PER_WEEK not_after=$until_at created_at=$created worker_commit=$EXPECT origin_url=$url"
  say "the standing pre-authorization is written: at most $PER_DAY run(s) a day and $PER_WEEK a week (rolling), until $until_at (UTC)"
  say "every run executes the worker code of commit $EXPECT only (to move it: standing --yes --expect <newer commit> ... again)"
  say "root enforces the run count, one attempt per request id, the pinned commit, the timeout and (after each run) at most 6 images"
  say "to revoke it: sudo bash $INSTALL_DIR/scripts/sales-design-worker/imagefirst-autorun-setup.sh standing --revoke --yes"
  en="$(systemctl is-enabled "$TIMER" 2>/dev/null)" || true
  [ "$en" = enabled ] || say "note: $TIMER is not enabled (${en:-not installed}): nothing runs until apply and enable-timer"
  finish STANDING_WRITTEN 0
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
# The package's entry and its native binary as apply leaves them (empty: DONE; else why not).
cli_installed_why() {
  local name="$1" pkgdir entry id
  pkgdir="$PREFIX/lib/node_modules/${CLI_PKG[$name]}"
  root_file "$pkgdir/package.json" && id="$(pkg_id "$pkgdir/package.json")" || id=INVALID
  [ "$id" = "${CLI_PKG[$name]} ${CLI_VER[$name]}" ] || { echo "installed ${id#* } is not the pinned ${CLI_VER[$name]}"; return; }
  if [ "$name" = claude ]; then
    native_ok "$CLAUDE_ENTRY" "${BIN_SHA256[claude]}" || { echo "bin/claude.exe is not the pinned native binary (an ELF over 1 MiB with the pinned SHA-256)"; return; }
  else
    root_file "$CODEX_NATIVE_DIR/package.json" && id="$(pkg_id "$CODEX_NATIVE_DIR/package.json")" || id=INVALID
    [ "$id" = "$CODEX_NATIVE_ID" ] || { echo "the native package $CODEX_NATIVE_PKG is not $CODEX_NATIVE_ID"; return; }
    native_ok "$CODEX_NATIVE_BIN" "${BIN_SHA256[codex]}" || { echo "the native codex is not the pinned binary (an ELF over 1 MiB with the pinned SHA-256)"; return; }
  fi
}
check_cli() {
  local name pkg slot pkgdir entry real t why_not state=DONE why="" todo="" node="" d n
  [ "$(uname -m)" = x86_64 ] || { STEP[cli]=BLOCKED; WHY[cli]="the pinned native packages are linux-x64; this machine is $(uname -m)"; return; }
  for d in "$R/usr/bin" "$PREFIX" "$PREFIX/bin"; do
    root_path "$d" || { STEP[cli]=BLOCKED; WHY[cli]="$d is missing or not root's only up to /"; return; }
  done
  [ -f "$NPM" ] && root_path "$NPM" || { STEP[cli]=BLOCKED; WHY[cli]="/usr/bin/npm is missing or not root's only up to /"; return; }
  for n in "$PREFIX/bin/node" "$R/usr/bin/node" "$R/bin/node"; do if [ -e "$n" ]; then node="$n"; break; fi; done
  [ -n "$node" ] && root_path "$node" || { STEP[cli]=BLOCKED; WHY[cli]="node (as the worker's PATH finds it) is missing or not root's only up to /"; return; }
  for name in "${CLI_NAMES[@]}"; do
    pkg="${CLI_PKG[$name]}"
    slot="$PREFIX/bin/$name"; pkgdir="$PREFIX/lib/node_modules/$pkg"
    if [ "$name" = claude ]; then entry="$CLAUDE_ENTRY"; else entry="$CODEX_ENTRY"; fi
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
      if [ "$real" = "$entry" ] && [ -f "$real" ] && root_path "$real"; then
        why_not="$(cli_installed_why "$name")"
        if [ -z "$why_not" ]; then why+="$name ${CLI_VER[$name]} root-owned with the pinned native binary; "
        else todo+="$name: $why_not; "
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
# The installed copy of root's scripts: what SHA256SUMS must say (the admin clone's files, in INSTALL_FILES order)
manifest_text() {
  local rel
  for rel in "${INSTALL_FILES[@]}"; do printf '%s  %s\n' "$(sha_of "$SRC/$rel")" "$rel"; done
}
file_mode() { case "$1" in *.sh) echo 755 ;; *) echo 644 ;; esac; }
check_scripts() {
  local rel f todo=""
  for rel in "${INSTALL_FILES[@]}"; do
    [ -f "$SRC/$rel" ] && [ ! -L "$SRC/$rel" ] || { STEP[scripts]=BLOCKED; WHY[scripts]="$SRC/$rel is missing in the admin clone"; return; }
  done
  if [ -e "$INST" ] || [ -L "$INST" ]; then
    [ -d "$INST" ] && [ ! -L "$INST" ] && root_path "$INST" || { STEP[scripts]=BLOCKED; WHY[scripts]="$INST is not a root-owned directory nobody else can write: look at it first"; return; }
  else
    STEP[scripts]=TODO; WHY[scripts]="$INSTALL_DIR absent (${#INSTALL_FILES[@]} files to install)"; return
  fi
  for rel in "${INSTALL_FILES[@]}"; do
    f="$INST/$rel"
    if absent "$f"; then todo+="$rel not installed; "; continue; fi
    root_file "$f" || { STEP[scripts]=BLOCKED; WHY[scripts]="$f is not a root-owned regular file nobody else can write: look at it first"; return; }
    if ! cmp -s -- "$f" "$SRC/$rel" || [ "$(stat -c %a -- "$f")" != "$(file_mode "$rel")" ]; then todo+="$rel differs from the admin clone's (or its mode); "; fi
  done
  if absent "$MANIFEST"; then todo+="SHA256SUMS absent; "
  elif ! root_file "$MANIFEST"; then STEP[scripts]=BLOCKED; WHY[scripts]="$MANIFEST is not a root-owned regular file nobody else can write"; return
  elif [ "$(cat -- "$MANIFEST")" != "$(manifest_text)" ]; then todo+="SHA256SUMS is not the admin clone's files; "
  fi
  if [ -n "$todo" ]; then STEP[scripts]=TODO; WHY[scripts]="${todo%; }"
  else STEP[scripts]=DONE; WHY[scripts]="${#INSTALL_FILES[@]} files root-owned in $INSTALL_DIR, SHA256SUMS recorded"
  fi
}
hardening_key() { printf '%s %s\n' "$(sha_of "$UNIT_DIR/${UNITS[0]}")" "$(sha_of "$ADMIN_SH")"; }
check_hardening() {
  if [ "${STEP[units]}" != DONE ] || [ "${STEP[scripts]}" != DONE ]; then STEP[hardening_check]=TODO; WHY[hardening_check]="after the scripts and the units"; return; fi
  if [ -f "$HARDENING_OK" ] && [ ! -L "$HARDENING_OK" ] && [ "$(cat -- "$HARDENING_OK")" = "$(hardening_key)" ]; then
    STEP[hardening_check]=DONE; WHY[hardening_check]="admin.sh status passed under the unit's hardening (this service file and admin.sh)"
  else
    STEP[hardening_check]=TODO; WHY[hardening_check]="admin.sh status under the unit's hardening not run for this service file and admin.sh"
  fi
}
STEP_NAMES=(cli codex_config scripts units hardening_check)
run_checks() {
  local s
  check_cli
  check_codex_config
  check_scripts
  check_units
  check_hardening
  BLOCKED=0; TODO=0
  for s in "${STEP_NAMES[@]}"; do
    printf 'SETUP_STEP %s %s %s\n' "$s" "${STEP[$s]}" "${WHY[$s]}"
    case "${STEP[$s]}" in BLOCKED) BLOCKED=$((BLOCKED + 1)) ;; TODO) TODO=$((TODO + 1)) ;; esac
  done
  en="$(systemctl is-enabled "$TIMER" 2>/dev/null)" || true
  say "timer $TIMER: ${en:-not installed} (only enable-timer enables it)"
  if absent "$STANDING"; then say "standing pre-authorization: none (standing --yes writes it; per-run approvals still work)"
  elif root_file "$STANDING" && [ "$(stat -c %s -- "$STANDING")" -le 4096 ]; then say "standing pre-authorization: $(tr -d '\000-\037' <"$STANDING" | cut -c1-300)"
  else say "standing pre-authorization: $STANDING is not root's regular file (the automatic run refuses it)"
  fi
}

say "pinned: ${CLI_PKG[claude]}@${CLI_VER[claude]} ${CLI_PKG[codex]}@${CLI_VER[codex]} (tarballs by sha512, natives by SHA-256); codex-config.toml SHA-256 $PINNED_SHA"
run_checks
if [ "$MODE" = check ]; then
  say "$TODO step(s) TODO, $BLOCKED BLOCKED (nothing was changed)"
  if [ "$BLOCKED" -gt 0 ]; then finish CHECK_BLOCKED 3; fi
  finish CHECK_OK 0
fi
if [ "$MODE" != rollback ] && [ "$BLOCKED" -gt 0 ]; then say "SETUP_BLOCKED: a step is BLOCKED: nothing changed"; finish SETUP_BLOCKED 3; fi

# ---------------------------------------------------------------- the changing modes: root's state dir, the lock, the log
open_state
log "start expect=$EXPECT steps: cli=${STEP[cli]} codex_config=${STEP[codex_config]} scripts=${STEP[scripts]} units=${STEP[units]} hardening_check=${STEP[hardening_check]}"
# npm's whole environment: nothing else (no proxy, CA, npm-config or NODE variable), no user / global npm config: two
# distinct empty files (npm 11 exits "double-loading config" when one file, /dev/null too, is both), 0600 in a fresh 0700
# dir of the state dir, removed after the call. --os/--cpu: no optional native matches, so npm fetches none (in a global
# install --omit=optional alone does not stop that); this script places the verified natives itself. npm's stdout and
# stderr go to NPM_OUT (root-only), never to the terminal; npm_report prints its masked tail after a failure.
NPM_OUT="$STATE/setup-npm.out"
npm_g() {
  local cfg rc=0
  rm -f -- "$NPM_OUT"
  cfg="$(mktemp -d "$STATE/setup-npmrc.XXXXXX")" || return 1
  ( umask 077; set -C; : >"$cfg/userconfig" && : >"$cfg/globalconfig" ) || { rm -rf -- "$cfg"; return 1; }
  ( umask 077
    exec >"$NPM_OUT" 2>&1
    umask 022
    env -i HOME="$NPM_HOME" PATH="$NPM_PATH" LANG=C.UTF-8 timeout --kill-after="$KILL_AFTER" "$NPM_TIMEOUT" \
      "$NPM" "$1" -g --prefix "$PREFIX" --userconfig "$cfg/userconfig" --globalconfig "$cfg/globalconfig" \
      --no-audit --no-fund --no-update-notifier --loglevel=error --os=sr-none --cpu=sr-none "${@:2}" 9>&- ) || rc=$?
  rm -rf -- "$cfg"
  [ "$rc" != 0 ] || rm -f -- "$NPM_OUT"
  return "$rc"
}
# token-like strings out of npm's output (an auth token, a bearer / basic credential, a user:password@ in a URL)
npm_mask() {
  sed -E 's/(_authToken|_auth|_password|password|token)([[:space:]]*[=:][[:space:]]*)[^[:space:]"'"'"',]+/\1\2***/Ig;
    s/(Bearer|Basic)[[:space:]]+[^[:space:]"'"'"',]+/\1 ***/Ig; s#//[^/@[:space:]]+@#//***@#g'
}
# After a failed npm call: its last 20 lines (masked, control characters removed) printed and logged; NPM_FIRST is the
# first "npm error" / "code E..." line (masked), for the failure's reason.
NPM_FIRST=""
npm_report() {
  local l
  NPM_FIRST=""
  [ -f "$NPM_OUT" ] && [ ! -L "$NPM_OUT" ] || return 0
  NPM_FIRST="$(grep -m 1 -E 'npm (error|ERR!)|code E[A-Z0-9]+' -- "$NPM_OUT" | tr -d '\000-\037' | npm_mask | cut -c1-200)" || NPM_FIRST=""
  while IFS= read -r l; do say "  npm| $l"; log "npm| $l"; done < <(tail -n 20 -- "$NPM_OUT" | tr -d '\000-\010\013-\037' | npm_mask | cut -c1-300)
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

# ---------------------------------------------------------------- rollback (only what setup.log says apply changed)
if [ "$MODE" = rollback ]; then
  ok=1
  st="$(unit_state ActiveState sr-imagefirst-autorun.service)"
  [[ "$st" =~ ^(inactive|failed)$ ]] || { say "sr-imagefirst-autorun.service is ${st:-unknown}: stop the run first (sudo systemctl stop sr-imagefirst-autorun.service)"; log "refused: the service is $st"; finish SETUP_BLOCKED 3; }
  # apply's records since the last complete rollback
  RECORDS="$(awk '/^[0-9TZ:-]+ rollback done ok=1$/ { buf = ""; next } { buf = buf $0 "\n" } END { printf "%s", buf }' "$LOG")"
  applied() { grep -qE "^[0-9TZ:-]+ apply APPLIED $1\$" <<<"$RECORDS"; }
  if ! applied cli && ! applied codex_config && ! applied scripts && ! applied units && ! applied hardening_check; then say "setup.log records no change by apply: nothing to undo"; fi
  if applied units; then
    if [ "$(unit_state LoadState "$TIMER")" != not-found ]; then
      log "systemctl disable --now $TIMER"
      sc disable --now "$TIMER" >/dev/null 2>&1 || { say "systemctl disable --now $TIMER failed: nothing else removed"; log "disable failed"; finish ROLLBACK_INCOMPLETE 35; }
    fi
    for u in "${UNITS[@]}"; do
      if ! absent "$UNIT_DIR/$u"; then log "rm $UNIT_DIR/$u"; rm -f -- "$UNIT_DIR/$u"; fi
    done
    log "systemctl daemon-reload"
    sc daemon-reload >/dev/null 2>&1 || { say "daemon-reload failed"; log "daemon-reload failed"; ok=0; }
    say "the old $LEGACY_TIMER stays disabled (it is never enabled again by this script)"
  fi
  if applied cli; then
    pkgs=()
    for name in "${CLI_NAMES[@]}"; do if [ -d "$PREFIX/lib/node_modules/${CLI_PKG[$name]}" ]; then pkgs+=("${CLI_PKG[$name]}"); fi; done
    if [ "${#pkgs[@]}" -gt 0 ]; then
      log "npm uninstall -g --prefix /usr/local ${pkgs[*]}"
      npm_g uninstall "${pkgs[@]}" || { npm_report; say "npm uninstall failed${NPM_FIRST:+: $NPM_FIRST}"; log "npm uninstall failed${NPM_FIRST:+: $NPM_FIRST}"; ok=0; }
    fi
    for name in "${CLI_NAMES[@]}"; do
      target="$(sed -n "s|^[0-9TZ:-]* apply OLD_LINK $name -> \\(.*\\)\$|\\1|p" <<<"$RECORDS" | tail -n 1)"
      [ -n "$target" ] || continue
      slot="$PREFIX/bin/$name"
      if ! legacy_target "$target"; then say "the recorded old link for $name is not inside /home/sr-designgen: not restored"; log "not restored $name: bad record"; ok=0
      elif [ -L "$slot" ] && [ "$(readlink -- "$slot")" = "$target" ]; then say "/usr/local/bin/$name already points to $target (restored earlier)"; log "already restored $slot -> $target"
      elif [ ! -e "$target" ]; then say "the old target of $name ($target) no longer exists: not restored"; log "not restored $name: $target gone"
      elif ! absent "$slot"; then say "/usr/local/bin/$name is not free: not restored (look at it)"; log "not restored $name: slot taken"; ok=0
      else ln -s -- "$target" "$slot"; log "restored $slot -> $target"; say "restored /usr/local/bin/$name -> $target (into the worker's home: root must not run claude / codex)"
      fi
    done
  fi
  if applied codex_config && ! absent "$CODEX_CONFIG"; then log "rm $CODEX_CONFIG"; rm -f -- "$CODEX_CONFIG"; fi
  if applied hardening_check && ! absent "$HARDENING_OK"; then log "rm $HARDENING_OK"; rm -f -- "$HARDENING_OK"; fi
  if applied scripts && [ -d "$INST" ] && [ ! -L "$INST" ]; then log "rm -r $INST"; rm -rf -- "$INST"; fi
  say "used/, autorun/, rejected/, requests/, the worker's claims, the ledgers, the switch and the standing policy are kept"
  log "done ok=$ok"
  [ "$ok" = 1 ] || finish ROLLBACK_INCOMPLETE 35
  finish ROLLBACK_DONE 0
fi

# ---------------------------------------------------------------- apply (never enables the timer)
if [ "$TODO" = 0 ]; then say "every step is already DONE: nothing to do"; log "nothing to do"; finish APPLY_OK 0; fi

cli_fail() { say "SETUP_CLI_FAILED: $1; $ROLLBACK_HINT"; log "cli failed: $1"; finish SETUP_CLI_FAILED 30; }
sri_of() {
  python3 -I -c 'import base64, hashlib, sys
h = hashlib.sha512()
with open(sys.argv[1], "rb") as f:
    for c in iter(lambda: f.read(1 << 20), b""):
        h.update(c)
print("sha512-" + base64.b64encode(h.digest()).decode())' "$1"
}
# only plain files and directories without setuid / setgid / sticky bits, every name under package/ without ".."
members_ok() {
  local types modes names
  types="$(tar -tzvf "$1" | cut -c1 | sort -u | tr -d '\n')" || return 1
  [[ "$types" =~ ^[-d]+$ ]] || return 1
  modes="$(tar -tzvf "$1" | cut -c2-10)" || return 1
  ! grep -q '[sStT]' <<<"$modes" || return 1
  names="$(tar -tzf "$1")" || return 1
  ! grep -qvE '^package/([A-Za-z0-9._@+-]+/)*[A-Za-z0-9._@+-]*$' <<<"$names" || return 1
  ! grep -qE '(^|/)\.\.(/|$)' <<<"$names"
}
extract() { ( umask 022; mkdir -p -- "$2" && tar -xzf "$1" -C "$2" --no-same-owner --no-same-permissions ); }

if [ "${STEP[cli]}" = TODO ]; then
  # 0. room for the downloads and their unpacking in the state dir's filesystem
  free_mib="$(df -Pm -- "$STATE" 2>/dev/null | awk 'NR == 2 { print $4 }')" || free_mib=""
  if ! [[ "$free_mib" =~ ^[0-9]+$ ]] || [ "$free_mib" -lt "$NEED_FREE_MIB" ]; then
    say "SETUP_BLOCKED: ${free_mib:-unknown} MiB free in $STATE's filesystem; the download and its unpacking need $NEED_FREE_MIB MiB (nothing changed)"
    log "refused: ${free_mib:-unknown} MiB free, $NEED_FREE_MIB needed"
    finish SETUP_BLOCKED 3
  fi
  # 1. the four tarballs, downloaded (each capped at its pinned size) and verified before anything changes
  WORK="$(mktemp -d "$STATE/setup-download.XXXXXX")"
  for t in "${TGZS[@]}"; do
    f="$WORK/$t.tgz"
    log "fetch ${TGZ_URL[$t]}"
    env -i HOME="$NPM_HOME" PATH="$CURL_PATH" LANG=C.UTF-8 timeout --kill-after="$KILL_AFTER" "$FETCH_TIMEOUT" \
      curl -q -fsSL --proto =https --proto-redir =https --max-filesize "$((TGZ_SIZE[$t] + SIZE_MARGIN))" -o "$f" "${TGZ_URL[$t]}" 9>&- ||
      cli_fail "the download of ${TGZ_URL[$t]} failed or was larger than the pinned ${TGZ_SIZE[$t]} bytes (nothing changed)"
    [ "$(stat -c %s -- "$f")" -le "$((TGZ_SIZE[$t] + SIZE_MARGIN))" ] || cli_fail "${TGZ_URL[$t]} is larger than the pinned ${TGZ_SIZE[$t]} bytes (nothing changed)"
    got="$(sri_of "$f")" || got=""
    [ "$got" = "${TGZ_SRI[$t]}" ] || cli_fail "${TGZ_URL[$t]} is not the pinned tarball (sha512 ${got:-unreadable}; nothing changed)"
    members_ok "$f" || cli_fail "${TGZ_URL[$t]} holds a member that is not a plain file or directory under package/ or has a setuid / setgid / sticky bit (nothing changed)"
    extract "$f" "$WORK/$t" || cli_fail "$t could not be unpacked (nothing changed)"
    log "verified $t ${TGZ_SRI[$t]}"
  done
  native_ok_tmp() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %s -- "$1")" -gt "$MIN_NATIVE_BYTES" ] && [ "$(sha_of "$1")" = "$2" ]; }
  native_ok_tmp "$WORK/claude_native/package/claude" "${BIN_SHA256[claude]}" || cli_fail "the native claude in the verified tarball is not the pinned binary (nothing changed)"
  native_ok_tmp "$WORK/codex_native/package/vendor/$CODEX_TRIPLE/bin/codex" "${BIN_SHA256[codex]}" || cli_fail "the native codex in the verified tarball is not the pinned binary (nothing changed)"
  [ "$(pkg_id "$WORK/codex_native/package/package.json")" = "$CODEX_NATIVE_ID" ] || cli_fail "the native codex package is not $CODEX_NATIVE_ID (nothing changed)"
  log "APPLIED cli"
  # 2. only the two symlinks into the worker's home, recorded first
  for name in "${CLI_NAMES[@]}"; do
    old_var="CLI_OLD_$name"
    old="${!old_var}"
    [ -n "$old" ] || continue
    slot="$PREFIX/bin/$name"
    [ -L "$slot" ] && [ "$(readlink -- "$slot")" = "$old" ] || cli_fail "/usr/local/bin/$name changed since the check: nothing removed"
    log "OLD_LINK $name -> $old"
    rm -f -- "$slot"
    log "removed $slot"
    say "recorded and removed /usr/local/bin/$name -> $old"
  done
  # 3. the two wrapper packages from the verified local tarballs: no lifecycle script, no optional dependency fetched
  log "npm install -g --prefix /usr/local --ignore-scripts --omit=optional --os=sr-none --cpu=sr-none $WORK/claude.tgz $WORK/codex.tgz"
  say "npm install -g --prefix /usr/local --ignore-scripts --omit=optional --os=sr-none --cpu=sr-none (the verified local tarballs; as root, HOME=/root, empty npm config files)"
  npm_g install --ignore-scripts --omit=optional "$WORK/claude.tgz" "$WORK/codex.tgz" || { npm_report; cli_fail "npm install failed${NPM_FIRST:+: $NPM_FIRST}"; }
  # 4. every installed file of the two packages is the verified tarball's
  for name in "${CLI_NAMES[@]}"; do
    pkgdir="$PREFIX/lib/node_modules/${CLI_PKG[$name]}"
    while IFS= read -r m; do
      rel="${m#package/}"
      [ -n "$rel" ] && [ -f "$WORK/$name/$m" ] || continue
      cmp -s -- "$WORK/$name/$m" "$pkgdir/$rel" || cli_fail "$pkgdir/$rel is not the verified tarball's"
    done < <(tar -tzf "$WORK/$name.tgz")
    # and nothing else: every entry of the installed package dir (before the natives are placed) is a regular file or a
    # directory of its tarball
    extra="$(cd -- "$pkgdir" && find . -mindepth 1 \( -type d -o -type f \) -printf '%P\n' | LC_ALL=C sort | comm -23 - <(tar -tzf "$WORK/$name.tgz" | sed 's|^package/||; s|/$||' |
      awk -F/ 'NF { p = ""; for (i = 1; i <= NF; i++) { p = (i == 1 ? $i : p "/" $i); print p } }' | LC_ALL=C sort -u))" || extra="unreadable"
    other="$(cd -- "$pkgdir" && find . -mindepth 1 ! -type d ! -type f -printf '%P\n')" || other="unreadable"
    [ -z "$extra" ] && [ -z "$other" ] || cli_fail "$pkgdir holds entries that are not in the verified tarball: $(printf '%s ' $extra $other | cut -c1-300)"
  done
  log "installed files compared with the verified tarballs (nothing more, nothing less)"
  # 5. what claude-code's skipped postinstall did (install.cjs): the native binary over the bin/claude.exe placeholder
  ( umask 022; install "${INSTALL_OWNER[@]}" -m 0755 -- "$WORK/claude_native/package/claude" "$CLAUDE_ENTRY" ) || cli_fail "the native claude could not be placed"
  log "placed the native claude at $CLAUDE_ENTRY sha256=${BIN_SHA256[claude]}"
  # 6. codex's native package where npm puts the optional dependency (bin/codex.js resolves $CODEX_NATIVE_PKG from there)
  ( umask 022
    install -d "${INSTALL_OWNER[@]}" -m 0755 "$PKG_DIR_codex/node_modules" "$PKG_DIR_codex/node_modules/@openai"
    rm -rf -- "$CODEX_NATIVE_DIR"
    cp -R -- "$WORK/codex_native/package" "$CODEX_NATIVE_DIR" ) || cli_fail "the native codex package could not be placed"
  log "placed the native codex package at $CODEX_NATIVE_DIR sha256=${BIN_SHA256[codex]}"
  # a second guard behind the member check: no setuid / setgid / sticky bit anywhere in the two packages
  chmod -R u-s,g-s,-t -- "$PKG_DIR_claude" "$PKG_DIR_codex" || cli_fail "the special mode bits could not be cleared"
  log "chmod -R u-s,g-s,-t $PKG_DIR_claude $PKG_DIR_codex"
  rm -rf -- "$WORK"
  WORK=""
  check_cli
  [ "${STEP[cli]}" = DONE ] || cli_fail "after the install: ${WHY[cli]}"
  log "cli DONE: ${WHY[cli]}"
fi

if [ "${STEP[codex_config]}" = TODO ]; then
  log "APPLIED codex_config"
  if absent "$ETC"; then install -d "${INSTALL_OWNER[@]}" -m 0755 "$ETC"; log "install -d -m 0755 $ETC"; fi
  install "${INSTALL_OWNER[@]}" -m 0644 -- "$SRC_CONFIG" "$CODEX_CONFIG"
  log "install -m 0644 $CODEX_CONFIG"
  check_codex_config
  [ "${STEP[codex_config]}" = DONE ] || { say "SETUP_CODEX_CONFIG_FAILED: ${WHY[codex_config]}; $ROLLBACK_HINT"; log "codex_config not DONE"; finish SETUP_CODEX_CONFIG_FAILED 31; }
  log "codex_config DONE sha256=$PINNED_SHA"
fi

if [ "${STEP[scripts]}" = TODO ]; then
  log "APPLIED scripts"
  scripts_fail() { say "SETUP_SCRIPTS_FAILED: $1; $ROLLBACK_HINT"; log "scripts failed: $1"; finish SETUP_SCRIPTS_FAILED 36; }
  for rel in "${INSTALL_FILES[@]}"; do
    ( umask 022
      install -d "${INSTALL_OWNER[@]}" -m 0755 "$INST" "$(dirname -- "$INST/$rel")"
      install "${INSTALL_OWNER[@]}" -m "0$(file_mode "$rel")" -- "$SRC/$rel" "$INST/$rel" ) || scripts_fail "$rel could not be installed"
    log "installed $INSTALL_DIR/$rel sha256=$(sha_of "$INST/$rel")"
  done
  tmp_sums="$(mktemp "$INST/.SHA256SUMS.XXXXXX")"
  manifest_text >"$tmp_sums"
  chmod 0644 -- "$tmp_sums"
  mv -f -T -- "$tmp_sums" "$MANIFEST"
  log "wrote $MANIFEST sha256=$(sha_of "$MANIFEST")"
  check_scripts
  [ "${STEP[scripts]}" = DONE ] || scripts_fail "after the install: ${WHY[scripts]}"
  log "scripts DONE"
fi

if [ "${STEP[units]}" = TODO ]; then
  log "APPLIED units"
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
  log "APPLIED hardening_check"
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
