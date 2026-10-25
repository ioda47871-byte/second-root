#!/usr/bin/env bash
# DEV-074 design-image PoC — ONE Codex image call (ChatGPT sign-in, inside the
# worker's bubblewrap jail) for one original web-design mockup PNG of the
# fictional wagashi shop 架空菓庵 (DEV-073 fixture), from a curated art
# direction: v2 by default (第2案, DEV-075: design-library/poc/
# wagashi-art-direction-v2.json, AI concept visuals of the wagashi allowed),
# or v1 (the first PoC, design-library/poc/wagashi-art-direction.json).
#
#   ./scripts/sales-design-worker/design-image-poc.sh --human-approval-confirmed
#   SR_DESIGN_IMAGE_POC_DIRECTION=v1 ./scripts/sales-design-worker/design-image-poc.sh --human-approval-confirmed
#
# SR_DESIGN_IMAGE_POC_DIRECTION: unset / v2 / v1 / v3 only; anything else stops (v3: the DEV-102 research experiment)
# (POC_DIRECTION_INVALID, exit 2) before the preflight, the lock or git.
#
# Running it is the human's operation and needs the human's explicit approval
# of this run first (HUMAN-018 in .ai/blockers.md); --human-approval-confirmed
# states that this approval was given. Without it nothing starts.
#
# Run as the worker user (sr-designgen) inside the jail, from develop (after
# the PR is merged), e.g.
#   sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- \
#     /home/sr-designgen/work/second-root/scripts/sales-design-worker/design-image-poc.sh --human-approval-confirmed
# See docs/operations/design-image-poc.md. Steps, each stopping on failure:
#   0. the approval flag (STOP: nothing is started)
#   1. restart with an allowlisted environment (as run.sh: no API key, token or database credential)
#   2. resource preflight (STOP: nothing is started)
#   3. the worker's run lock (run.sh's flock -n): no worker run at the same time
#   4. pin this checkout to origin/$SR_DESIGN_WORKER_REF (default: develop); npm ci only when package-lock.json changed
#   5. design-image-poc.ts with the time budget: at most 3300 s in all, as run.sh, so it ends inside
#      the jail's one run (admin.sh run: RuntimeMaxSec=3500); the one Codex call has at most 15 minutes
# Never touches the worker's queue, results or ledger, the database, the bridge,
# Staging, Production, Vercel, the flag or the worker's timer: a timer-fired
# run.sh finds the lock taken and exits 0. Never publishes or commits anything.
{
set -euo pipefail

if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in HOME PATH USER LOGNAME SHELL LANG LANGUAGE TZ TERM XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_CACHE_HOME \
    XDG_DATA_HOME XDG_STATE_HOME CODEX_HOME \
    HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE \
    SR_DESIGN_WORKER_REF SR_DESIGN_WORKER_NO_UPDATE SR_DESIGN_JOBS SR_DESIGN_ASSETS_ROOT \
    SR_DESIGN_IMAGE_POC_ROOT SR_DESIGN_IMAGE_POC_BUDGET_SECONDS SR_DESIGN_IMAGE_POC_DIRECTION; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec env -i "${keep[@]}" bash "$0" --sr-clean-env "$@"
fi

umask 077
APPROVED=""
EXPECTED_SHA=""
EXPECTED_CHARS=""
APPROVAL_ID=""
USAGE="usage: design-image-poc.sh --human-approval-confirmed [--expected-prompt-sha256 HEX --expected-prompt-chars N --approval-id ID]"
while [ $# -gt 0 ]; do
  case "$1" in
    --human-approval-confirmed) APPROVED=1; shift ;;
    --expected-prompt-sha256) [ $# -ge 2 ] || { echo "$USAGE"; exit 2; }; EXPECTED_SHA="$2"; shift 2 ;;
    --expected-prompt-chars) [ $# -ge 2 ] || { echo "$USAGE"; exit 2; }; EXPECTED_CHARS="$2"; shift 2 ;;
    --approval-id) [ $# -ge 2 ] || { echo "$USAGE"; exit 2; }; APPROVAL_ID="$2"; shift 2 ;;
    *) echo "$USAGE"; exit 2 ;;
  esac
done
[ -n "$APPROVED" ] || { echo "STOP: --human-approval-confirmed is missing. The PoC runs one real Codex image call (ChatGPT plan usage) on this machine and needs the human's explicit approval of this run (HUMAN-018 / HUMAN-019). Nothing was started."; exit 2; }
# An id identifies a particular owner approval, never a blanket permission.
# v4 requires the new pinned, one-use gate. Older directions keep their historical entrypoints.
if [ "${SR_DESIGN_IMAGE_POC_DIRECTION:-v2}" = "v4" ] || [ -n "$EXPECTED_SHA$EXPECTED_CHARS$APPROVAL_ID" ]; then
  [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]] &&
  [[ "$EXPECTED_CHARS" =~ ^[1-9][0-9]{0,5}$ ]] &&
  [[ "$APPROVAL_ID" =~ ^[a-z0-9][a-z0-9._-]{3,95}$ ]] ||
    { echo "STOP: POC_APPROVAL_PIN_REQUIRED. No Codex call was started."; exit 2; }
fi
case "${SR_DESIGN_IMAGE_POC_DIRECTION:-}" in
  "" | v1 | v2 | v3 | v4) ;;
  *) echo "STOP: POC_DIRECTION_INVALID (SR_DESIGN_IMAGE_POC_DIRECTION: v1, v2, v3 or v4; unset means v2). Nothing was started."; exit 2 ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REF="${SR_DESIGN_WORKER_REF:-develop}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/sr-design-worker"
# The jail's one run (admin.sh run) ends at RuntimeMaxSec=3500: the whole PoC fits in 3300 s, as run.sh.
BUDGET="${SR_DESIGN_IMAGE_POC_BUDGET_SECONDS:-3300}"
[[ "$BUDGET" =~ ^[1-9][0-9]{2,4}$ ]] || { echo "SR_DESIGN_IMAGE_POC_BUDGET_SECONDS: 100-99999"; exit 2; }
[ "$BUDGET" -le 3300 ] || BUDGET=3300
# the one Codex call (15 min) + the sign-in check and the sandbox probes
MIN_POC_SECONDS=1080
KILL_AFTER=30
cd "$REPO"

echo "== 1. resource preflight (docs/operations/wsl-resource-preflight.md)"
set +e
bash "$REPO/scripts/ops/wsl-resource-preflight.sh"
PRE=$?
set -e
if [ "$PRE" -eq 20 ]; then
  echo "STOP: not enough memory for Codex. Nothing was started."
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
[ -f "$REPO/scripts/sales-design-worker/design-image-poc.ts" ] || { echo "STOP: POC_NOT_ON_REF (design-image-poc.ts is not on origin/$REF yet; it runs only after the PR is merged)"; exit 2; }

echo "== 4. design-image PoC (one Codex image call, direction ${SR_DESIGN_IMAGE_POC_DIRECTION:-v2})"
REMAINING=$((BUDGET - (SECONDS - START)))
if [ "$REMAINING" -lt "$MIN_POC_SECONDS" ]; then
  echo "STOP: POC_RUN_TIME_BUDGET (only ${REMAINING}s left after the checkout; Codex was not started)"
  exit 1
fi

if [ -n "$EXPECTED_SHA" ]; then
  # Check after checkout and while holding this SAME run.lock. A previous SHA check
  # in a separate jail run is insufficient because develop may have changed.
  echo "== 4a. verify owner-approved prompt pin under run.lock"
  timeout 120 "$REPO/node_modules/.bin/tsx" --no-cache \
    "$REPO/scripts/sales-design-worker/check-image-prompt-pin.ts" \
    "${SR_DESIGN_IMAGE_POC_DIRECTION:-v2}" "$EXPECTED_SHA" "$EXPECTED_CHARS" ||
    { echo "STOP: POC_PIN_MISMATCH. The authorization was NOT consumed."; exit 23; }

  # Atomic marker in the worker's private state, outside git/output. This is
  # intentionally consumed BEFORE Codex may start, including uncertain failure
  # after this point. Never auto-clear or reuse an authorization ID.
  LEDGER="$HOME/.local/state/sr-design-worker/poc-approval-used"
  [ ! -L "$LEDGER" ] || { echo "STOP: POC_APPROVAL_LEDGER_INVALID"; exit 24; }
  mkdir -p -m 0700 "$LEDGER"
  if ! mkdir -m 0700 "$LEDGER/$APPROVAL_ID" 2>/dev/null; then
    echo "STOP: POC_APPROVAL_ALREADY_USED; no Codex call was started."
    exit 25
  fi
  printf 'direction=%s\nsha256=%s\ncommit=%s\n' \
    "${SR_DESIGN_IMAGE_POC_DIRECTION:-v2}" "$EXPECTED_SHA" "$(git rev-parse HEAD)" \
    > "$LEDGER/$APPROVAL_ID/receipt"
  echo "POC_APPROVAL_RESERVED id=$APPROVAL_ID (no retry even if result is uncertain)"
fi

set +e
# SR_DESIGN_IMAGE_POC_LOCKED: design-image-poc.ts runs only under this script (the lock above is held)
SR_DESIGN_IMAGE_POC_LOCKED=run.lock timeout --kill-after="$KILL_AFTER" "$REMAINING" \
  "$REPO/node_modules/.bin/tsx" "$REPO/scripts/sales-design-worker/design-image-poc.ts" \
  --human-approval-confirmed --budget-seconds="$((REMAINING - 120))"
RUN=$?
set -e
echo "design-image-poc.ts exit $RUN"
if [ "$RUN" -eq 137 ] || [ "$RUN" -eq 124 ]; then
  echo "STOP: POC_KILLED_OR_TIMED_OUT. Check for an OOM kill before treating it as a bug:"
  bash "$REPO/scripts/ops/wsl-resource-preflight.sh" --oom-check --since "2 hours ago" || true
fi
exit "$RUN"
}
