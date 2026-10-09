#!/usr/bin/env bash
# Second Root design worker — the one supported entry point (DEV-028 worker).
#
#   ./scripts/sales-design-worker/run.sh [--max=1]
#
# Run as the dedicated WSL user (sr-designgen), by hand or from the systemd
# user service in docs/operations/design-worker-wsl.md. It
#   1. restarts itself with an allowlisted environment (no API key, token or
#      database credential reaches git, npm, next, Playwright or Codex),
#   2. allows one run at a time (flock),
#   3. pins this checkout to origin/$SR_DESIGN_WORKER_REF (default develop):
#      fetch, detach, clean; npm ci when package-lock.json changed,
#   4. starts the worker with the time that is left (--budget-seconds).
# Every step has its own timeout(1); the whole run ends before systemd's
# TimeoutStartSec=3600.
#
# The whole script is one { ... } block, so bash has read all of it before
# the checkout below can change this file.
{
set -euo pipefail

# The restart is marked by an argument, not a variable, so a variable set
# in the caller's environment cannot skip it.
if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in HOME PATH USER LOGNAME SHELL LANG LANGUAGE TZ TERM XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_CACHE_HOME \
    XDG_DATA_HOME XDG_STATE_HOME CODEX_HOME PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_CHROMIUM_EXECUTABLE \
    HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE \
    SR_DESIGN_WORKER_REF SR_DESIGN_WORKER_NO_UPDATE SR_DESIGN_WORKER_BUDGET_SECONDS SR_DESIGN_JOBS SR_DESIGN_EXPORT_DIR \
    SR_DESIGN_BRIDGE_SPOOL; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec env -i "${keep[@]}" bash "$0" --sr-clean-env "$@"
fi

umask 077
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/sr-design-worker"
REF="${SR_DESIGN_WORKER_REF:-develop}"
# systemd: TimeoutStartSec=3600. This budget (55 min) covers fetch, npm ci and the worker.
BUDGET="${SR_DESIGN_WORKER_BUDGET_SECONDS:-3300}"
KILL_AFTER=30
MIN_WORKER_SECONDS=900

mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/run.lock"
if ! flock -n 9; then
  echo "another run.sh is running; nothing to do"
  exit 0
fi

[[ "$BUDGET" =~ ^[1-9][0-9]{2,4}$ ]] || { echo "SR_DESIGN_WORKER_BUDGET_SECONDS: 100-99999"; exit 2; }
[ "$BUDGET" -le 3300 ] || BUDGET=3300
START=$SECONDS
cd "$REPO"

if [ "${SR_DESIGN_WORKER_NO_UPDATE:-0}" != "1" ]; then
  [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { echo "SR_DESIGN_WORKER_REF: not a branch name"; exit 2; }
  timeout --kill-after="$KILL_AFTER" 180 git fetch --quiet --no-tags origin "+refs/heads/$REF:refs/remotes/origin/$REF"
  timeout --kill-after="$KILL_AFTER" 60 git checkout --quiet --force --detach "origin/$REF"
  timeout --kill-after="$KILL_AFTER" 60 git clean -q -f -d
  LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"
  if [ ! -x node_modules/.bin/tsx ] || [ "$(cat "$STATE/npm-lock.sha256" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
    timeout --kill-after="$KILL_AFTER" 900 npm ci --no-audit --no-fund --loglevel=error
    echo "$LOCK_HASH" > "$STATE/npm-lock.sha256"
  fi
  export SR_DESIGN_WORKER_REF="$REF"
else
  unset SR_DESIGN_WORKER_REF
fi

REMAINING=$((BUDGET - (SECONDS - START)))
if [ "$REMAINING" -lt "$MIN_WORKER_SECONDS" ]; then
  echo "not enough time left for the worker; nothing to do"
  exit 0
fi
timeout --kill-after="$KILL_AFTER" "$REMAINING" \
  "$REPO/node_modules/.bin/tsx" "$REPO/scripts/sales-design-worker/worker.ts" "$@" --budget-seconds="$((REMAINING - 120))"
exit $?
}
