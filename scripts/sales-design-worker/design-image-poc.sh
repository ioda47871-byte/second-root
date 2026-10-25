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
    SR_DESIGN_IMAGE_POC_ROOT SR_DESIGN_IMAGE_POC_BUDGET_SECONDS SR_DESIGN_IMAGE_POC_DIRECTION \
    SR_POC_EXPECTED_SHA SR_POC_EXPECTED_CHARS; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec env -i "${keep[@]}" bash "$0" --sr-clean-env "$@"
fi

umask 077
APPROVED=""
EXPECTED_SHA=""
EXPECTED_CHARS=""
EXPECTED_COMMIT=""
APPROVAL_ID=""
USAGE="usage: design-image-poc.sh --human-approval-confirmed [--expected-prompt-sha256 HEX --expected-prompt-chars N --expected-commit SHA --approval-id ID]"
while [ $# -gt 0 ]; do
  case "$1" in
    --human-approval-confirmed) APPROVED=1; shift ;;
    --expected-prompt-sha256) [ $# -ge 2 ] || { echo "$USAGE"; exit 2; }; EXPECTED_SHA="$2"; shift 2 ;;
    --expected-prompt-chars) [ $# -ge 2 ] || { echo "$USAGE"; exit 2; }; EXPECTED_CHARS="$2"; shift 2 ;;
    --expected-commit) [ $# -ge 2 ] || { echo "$USAGE"; exit 2; }; EXPECTED_COMMIT="$2"; shift 2 ;;
    --approval-id) [ $# -ge 2 ] || { echo "$USAGE"; exit 2; }; APPROVAL_ID="$2"; shift 2 ;;
    *) echo "$USAGE"; exit 2 ;;
  esac
done
[ -n "$APPROVED" ] || { echo "STOP: --human-approval-confirmed is missing. The PoC runs one real Codex image call (ChatGPT plan usage) on this machine and needs the human's explicit approval of this run (HUMAN-018 / HUMAN-019). Nothing was started."; exit 2; }
# An id identifies a particular owner approval, never a blanket permission.
# v4 requires the new pinned, one-use gate. Older directions keep their historical entrypoints.
if [ "${SR_DESIGN_IMAGE_POC_DIRECTION:-v2}" = "v4" ] || [ -n "$EXPECTED_SHA$EXPECTED_CHARS$EXPECTED_COMMIT$APPROVAL_ID" ]; then
  [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]] &&
  [[ "$EXPECTED_CHARS" =~ ^[1-9][0-9]{0,5}$ ]] &&
  [[ "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]] &&
  [[ "$APPROVAL_ID" =~ ^[a-z0-9][a-z0-9._-]{3,95}$ ]] ||
    { echo "STOP: POC_APPROVAL_PIN_REQUIRED. No Codex call was started."; exit 2; }
fi
# This approval covers exactly one fixed v4 image prompt and one fixed
# one-use ID. An arbitrary second --approval-id may not bypass the receipt.
if [ "${SR_DESIGN_IMAGE_POC_DIRECTION:-v2}" = "v4" ] && {
     [ "$EXPECTED_SHA" != "4e34f760ccde3f28df58316e9b55e6d21d6ac78d397bf770f6295fb1699157d9" ] ||
     [ "$EXPECTED_CHARS" != "4714" ] ||
     [ "$APPROVAL_ID" != "wagashi-a-v4-20261025-01" ];
   }; then
  echo "STOP: POC_V4_APPROVAL_SCOPE_MISMATCH. No Codex call was started."
  exit 2
fi
# A reviewed one-use pin must NEVER run the checkout-mutating update path.
if [ -n "$EXPECTED_SHA" ] && [ "${SR_DESIGN_WORKER_NO_UPDATE:-0}" != "1" ]; then
  echo "STOP: POC_NO_UPDATE_REQUIRED. No checkout or approval was changed."
  exit 26
fi
case "${SR_DESIGN_IMAGE_POC_DIRECTION:-}" in
  "" | v1 | v2 | v3 | v4) ;;
  *) echo "STOP: POC_DIRECTION_INVALID (SR_DESIGN_IMAGE_POC_DIRECTION: v1, v2, v3 or v4; unset means v2). Nothing was started."; exit 2 ;;
esac
# A one-shot approval is bound to the installed sr-designgen identity and
# canonical state directory. An attacker must not redirect the one-use marker
# by selecting a new HOME or XDG_STATE_HOME while retaining the same worker.
if [ "${SR_DESIGN_IMAGE_POC_DIRECTION:-v2}" = "v4" ]; then
  PASSWD_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
  if [ "$(id -un)" != "sr-designgen" ] ||
     [ -z "$PASSWD_HOME" ] ||
     [ "${HOME:-}" != "$PASSWD_HOME" ] ||
     { [ -n "${XDG_STATE_HOME:-}" ] && [ "$XDG_STATE_HOME" != "$HOME/.local/state" ]; }; then
    echo "STOP: POC_V4_CANONICAL_IDENTITY_REQUIRED. No approval consumed."
    exit 27
  fi
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REF="${SR_DESIGN_WORKER_REF:-develop}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/sr-design-worker"
if [ "${SR_DESIGN_IMAGE_POC_DIRECTION:-v2}" = "v4" ]; then
  # Also anchors run.lock and the approval ledger to the same directory.
  STATE="$HOME/.local/state/sr-design-worker"
fi
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
if [ -n "$EXPECTED_COMMIT" ]; then
  # The approved one-use call must use the EXACT reviewed code commit. No
  # fetch/checkout/clean/npm ci, including if develop moved on the remote.
  [ "${SR_DESIGN_WORKER_NO_UPDATE:-0}" = "1" ] &&
  [ "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT" ] &&
  [ "$(git rev-parse origin/develop)" = "$EXPECTED_COMMIT" ] &&
  [ -z "$(git status --porcelain --untracked-files=all)" ] ||
    { echo "STOP: POC_COMMIT_PIN_MISMATCH. The authorization was NOT consumed."; exit 26; }
fi
[ -f "$REPO/scripts/sales-design-worker/design-image-poc.ts" ] || { echo "STOP: POC_NOT_ON_REF (design-image-poc.ts is not on origin/$REF yet; it runs only after the PR is merged)"; exit 2; }

echo "== 4. design-image PoC (one Codex image call, direction ${SR_DESIGN_IMAGE_POC_DIRECTION:-v2})"
REMAINING=$((BUDGET - (SECONDS - START)))
if [ "$REMAINING" -lt "$MIN_POC_SECONDS" ]; then
  echo "STOP: POC_RUN_TIME_BUDGET (only ${REMAINING}s left after the checkout; Codex was not started)"
  exit 1
fi

if [ -n "$EXPECTED_SHA" ]; then
  # Use the *existing* PoC entrypoint for offline pin checks, so the
  # isolation contract has only design-image-poc.ts importing design-image.
  export SR_POC_EXPECTED_SHA="$EXPECTED_SHA" SR_POC_EXPECTED_CHARS="$EXPECTED_CHARS"
  echo "== 4a. check v4 prompt pin under the worker lock (no Codex)"
  SR_DESIGN_IMAGE_POC_LOCKED=run.lock timeout 120 "$REPO/node_modules/.bin/tsx" --no-cache \
    "$REPO/scripts/sales-design-worker/design-image-poc.ts" --check-pin-only ||
    { echo "STOP: POC_PIN_MISMATCH_OR_CHECK_ERROR. Approval not consumed."; exit 23; }

  # Never consume an approval when the remaining budget is already unsafe.
  REMAINING=$((BUDGET - (SECONDS - START)))
  if [ "$REMAINING" -lt "$MIN_POC_SECONDS" ]; then
    echo "STOP: POC_RUN_TIME_BUDGET. Approval not consumed."
    exit 1
  fi
  # The lock and approval must reside together in a fixed private state dir.
  # Same-user deletion remains possible; this is replay protection for
  # accidental duplicate calls, not a malicious-user security boundary.
  LEDGER="$STATE/poc-approval-used"
  [ ! -L "$STATE" ] && [ ! -L "$LEDGER" ] ||
    { echo "STOP: POC_APPROVAL_LEDGER_INVALID"; exit 24; }
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

# Include prompt preflight in the total time budget, to preserve 18min for
# the sign-in check, sandbox verification, and bounded Codex call.
REMAINING=$((BUDGET - (SECONDS - START)))
if [ "$REMAINING" -lt "$MIN_POC_SECONDS" ]; then
  echo "STOP: POC_RUN_TIME_BUDGET; no Codex call started."
  exit 1
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
