#!/usr/bin/env bash
# DEV-073 local 3-shop comparison — the fictional shops of
# scripts/sales-design-worker/compare/shops/ through the design worker's own
# pipeline (real Codex, inside the jail), plus the baseline (today's page).
#
#   ./scripts/sales-design-worker/compare-local.sh --compare-id cmp-001 --mode design --human-approval-confirmed
#   ./scripts/sales-design-worker/compare-local.sh --compare-id cmp-002 --mode baseline --human-approval-confirmed
#
# Running it is the human's operation and needs the human's explicit approval
# of this run first (HUMAN-017 in .ai/blockers.md); --human-approval-confirmed
# states that this approval was given. Without it nothing starts.
#
# Run as the worker user (sr-designgen) inside the jail, e.g.
#   sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- \
#     /home/sr-designgen/work/second-root/scripts/sales-design-worker/compare-local.sh …
# See docs/operations/design-compare-local.md. Steps, each stopping on failure:
#   0. the approval flag and the arguments (STOP: nothing is started)
#   1. restart with an allowlisted environment (as run.sh: no API key, token or database credential)
#   2. resource preflight (STOP: nothing is started)
#   3. the worker's run lock (run.sh's flock): no worker run at the same time
#   4. pin this checkout to origin/$SR_DESIGN_WORKER_REF (default: develop) and install
#   5. compare.ts with the time budget (its own per-shop budget = the worker's 50 minutes)
# Never touches the worker's queue, results or ledger, the database, the bridge,
# Staging, Production, the timer or any shop's real data. Never run a comparison id twice.
{
set -euo pipefail

if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in HOME PATH USER LOGNAME SHELL LANG LANGUAGE TZ TERM XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_CACHE_HOME \
    XDG_DATA_HOME XDG_STATE_HOME CODEX_HOME PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_CHROMIUM_EXECUTABLE \
    HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE \
    SR_DESIGN_WORKER_REF SR_DESIGN_WORKER_NO_UPDATE SR_DESIGN_JOBS SR_DESIGN_COMPARE_ROOT SR_DESIGN_COMPARE_BUDGET_SECONDS; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec env -i "${keep[@]}" bash "$0" --sr-clean-env "$@"
fi

umask 077
COMPARE=""
MODE="design"
APPROVED=""
USAGE="usage: --compare-id cmp-<n> [--mode design|baseline|hand_written] --human-approval-confirmed"
while [ $# -gt 0 ]; do
  case "$1" in
    --compare-id) COMPARE="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --human-approval-confirmed) APPROVED=1; shift ;;
    *) echo "$USAGE"; exit 2 ;;
  esac
done
[ -n "$APPROVED" ] || { echo "STOP: --human-approval-confirmed is missing. The comparison runs real Codex (design mode) and next build + Chromium on this machine, and needs the human's explicit approval of this run (HUMAN-017). Nothing was started."; exit 2; }
# A generic id only: never a shop's name.
[[ "$COMPARE" =~ ^cmp-[a-z0-9-]{1,30}$ ]] || { echo "--compare-id: cmp-<lowercase letters, digits, ->"; exit 2; }
case "$MODE" in design|baseline|hand_written) ;; *) echo "--mode: design | baseline | hand_written"; exit 2 ;; esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REF="${SR_DESIGN_WORKER_REF:-develop}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/sr-design-worker"
# design: three shops × the worker's 50-minute job budget, and the build; the other modes need no Codex
if [ "$MODE" = design ]; then BUDGET="${SR_DESIGN_COMPARE_BUDGET_SECONDS:-10800}"; else BUDGET="${SR_DESIGN_COMPARE_BUDGET_SECONDS:-2400}"; fi
[[ "$BUDGET" =~ ^[1-9][0-9]{2,4}$ ]] || { echo "SR_DESIGN_COMPARE_BUDGET_SECONDS: 100-99999"; exit 2; }
[ "$BUDGET" -le 10800 ] || BUDGET=10800
KILL_AFTER=30
cd "$REPO"

echo "== 1. resource preflight (docs/operations/wsl-resource-preflight.md)"
set +e
bash "$REPO/scripts/ops/wsl-resource-preflight.sh"
PRE=$?
set -e
if [ "$PRE" -eq 20 ]; then
  echo "STOP: not enough memory for build + Chromium + Codex. Nothing was started."
  exit 20
fi

echo "== 2. the worker's run lock"
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/run.lock"
if ! flock -n 9; then
  echo "STOP: a design worker run (run.sh) is in progress. Nothing was started; try again after it ends."
  exit 3
fi

START=$SECONDS
if [ "${SR_DESIGN_WORKER_NO_UPDATE:-0}" != "1" ]; then
  echo "== 3. checkout origin/$REF"
  [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { echo "SR_DESIGN_WORKER_REF: not a branch name"; exit 2; }
  timeout --kill-after="$KILL_AFTER" 180 git fetch --quiet --no-tags origin "+refs/heads/$REF:refs/remotes/origin/$REF"
  timeout --kill-after="$KILL_AFTER" 60 git checkout --quiet --force --detach "origin/$REF"
  timeout --kill-after="$KILL_AFTER" 60 git clean -q -f -d
  LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"
  if [ ! -x node_modules/.bin/tsx ] || [ "$(cat "$STATE/npm-lock.sha256" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
    timeout --kill-after="$KILL_AFTER" 900 npm ci --no-audit --no-fund --loglevel=error
    echo "$LOCK_HASH" > "$STATE/npm-lock.sha256"
  fi
fi
echo "commit $(git rev-parse --short=12 HEAD)"

echo "== 4. comparison $COMPARE ($MODE)"
REMAINING=$((BUDGET - (SECONDS - START)))
set +e
timeout --kill-after="$KILL_AFTER" "$REMAINING" \
  "$REPO/node_modules/.bin/tsx" "$REPO/scripts/sales-design-worker/compare.ts" \
  --compare-id "$COMPARE" --mode "$MODE" --human-approval-confirmed --budget-seconds="$((REMAINING - 120))"
RUN=$?
set -e
echo "compare.ts exit $RUN"
if [ "$RUN" -eq 137 ] || [ "$RUN" -eq 124 ]; then
  echo "compare.ts was killed or timed out: check for an OOM kill before treating it as a bug:"
  bash "$REPO/scripts/ops/wsl-resource-preflight.sh" --oom-check --since "4 hours ago" || true
fi
exit "$RUN"
}
