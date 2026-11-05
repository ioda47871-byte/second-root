#!/usr/bin/env bash
# DEV-185: the gate of the つぐ手 (fictional) AI demo photos — ONE Codex run, at most 6 image calls, for the owner's
# single approval tsugute-photos-20261106-01. Started ONLY by run-tsugute-photos-once.sh (user, HOME, cgroup checked
# there). The same steps as design-image-poc.sh's pinned v4 path (copied, not shared, so the wagashi gate is unchanged):
#   0. the pins (prompt SHA-256 + length, approval id, reviewed commit) and the canonical identity
#   1. restart with an allowlisted environment (no API key, token or database credential)
#   2. resource preflight (STOP: nothing is started)
#   3. the worker's run lock (flock -n on the shared run.lock): no worker run at the same time
#   4. no fetch/checkout/clean/npm ci: HEAD == origin/develop == the reviewed commit, clean tree
#   5. the prompt pin, offline, under the lock (tsugute-photos.ts --check-pin-only)
#   6. the one-use approval marker (atomic mkdir; already there: STOP). From here on: never retried.
#   7. tsugute-photos.ts with the whole budget (3300 s; the one Codex run at most 15 minutes)
# Never touches the worker's queue, results, ledger or timer, the database, Staging, Production or Vercel.
{
set -euo pipefail

if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in HOME PATH USER LOGNAME SHELL LANG LANGUAGE TZ TERM XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_CACHE_HOME \
    XDG_DATA_HOME XDG_STATE_HOME CODEX_HOME \
    HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE \
    SR_DESIGN_WORKER_NO_UPDATE SR_DESIGN_IMAGE_POC_BUDGET_SECONDS; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec env -i "${keep[@]}" bash "$0" --sr-clean-env "$@"
fi

umask 077
readonly PIN_SHA="dab7f2603c7495c4381035391a24ae98cc8bd07064295233fab034964ec33ed0"
readonly PIN_CHARS="4133"
readonly PIN_ID="tsugute-photos-20261106-01"
APPROVED=""
EXPECTED_SHA=""
EXPECTED_CHARS=""
EXPECTED_COMMIT=""
APPROVAL_ID=""
USAGE="usage: tsugute-photos-gate.sh --human-approval-confirmed --expected-prompt-sha256 HEX --expected-prompt-chars N --expected-commit SHA --approval-id ID"
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
[ -n "$APPROVED" ] || { echo "STOP: --human-approval-confirmed is missing. Nothing was started."; exit 2; }
[[ "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "STOP: POC_APPROVAL_PIN_REQUIRED. No Codex call was started."; exit 2; }
if [ "$EXPECTED_SHA" != "$PIN_SHA" ] || [ "$EXPECTED_CHARS" != "$PIN_CHARS" ] || [ "$APPROVAL_ID" != "$PIN_ID" ]; then
  echo "STOP: POC_TSUGUTE_APPROVAL_SCOPE_MISMATCH. No Codex call was started."
  exit 2
fi
if [ "${SR_DESIGN_WORKER_NO_UPDATE:-0}" != "1" ]; then
  echo "STOP: POC_NO_UPDATE_REQUIRED. No checkout or approval was changed."
  exit 26
fi
PASSWD_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
if [ "$(id -un)" != "sr-designgen" ] ||
   [ -z "$PASSWD_HOME" ] ||
   [ "${HOME:-}" != "$PASSWD_HOME" ] ||
   { [ -n "${XDG_STATE_HOME:-}" ] && [ "$XDG_STATE_HOME" != "$HOME/.local/state" ]; }; then
  echo "STOP: POC_TSUGUTE_CANONICAL_IDENTITY_REQUIRED. No approval consumed."
  exit 27
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
STATE="$HOME/.local/state/sr-design-worker"
BUDGET="${SR_DESIGN_IMAGE_POC_BUDGET_SECONDS:-3300}"
[[ "$BUDGET" =~ ^[1-9][0-9]{2,4}$ ]] || { echo "SR_DESIGN_IMAGE_POC_BUDGET_SECONDS: 100-99999"; exit 2; }
[ "$BUDGET" -le 3300 ] || BUDGET=3300
# the one Codex run (15 min) + the sign-in check and the sandbox probes, as the PoC
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

echo "commit $(git rev-parse --short=12 HEAD)"
[ "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT" ] &&
[ "$(git rev-parse origin/develop)" = "$EXPECTED_COMMIT" ] &&
[ -z "$(git status --porcelain --untracked-files=all)" ] ||
  { echo "STOP: POC_COMMIT_PIN_MISMATCH. The authorization was NOT consumed."; exit 26; }
[ -f "$REPO/scripts/sales-design-worker/tsugute-photos.ts" ] || { echo "STOP: POC_NOT_ON_REF"; exit 2; }

echo "== 3. check the tsugute prompt pin under the worker lock (no Codex)"
export SR_TSUGUTE_EXPECTED_SHA="$EXPECTED_SHA" SR_TSUGUTE_EXPECTED_CHARS="$EXPECTED_CHARS"
SR_TSUGUTE_PHOTOS_LOCKED=run.lock timeout 120 "$REPO/node_modules/.bin/tsx" --no-cache \
  "$REPO/scripts/sales-design-worker/tsugute-photos.ts" --check-pin-only ||
  { echo "STOP: POC_PIN_MISMATCH_OR_CHECK_ERROR. Approval not consumed."; exit 23; }

REMAINING=$((BUDGET - (SECONDS - START)))
if [ "$REMAINING" -lt "$MIN_POC_SECONDS" ]; then
  echo "STOP: POC_RUN_TIME_BUDGET. Approval not consumed."
  exit 1
fi
# Same-user deletion remains possible; this is replay protection against an accidental second run, not a boundary
# against a malicious same-uid process (as the v4 marker).
LEDGER="$STATE/poc-approval-used"
[ ! -L "$STATE" ] && [ ! -L "$LEDGER" ] || { echo "STOP: POC_APPROVAL_LEDGER_INVALID"; exit 24; }
mkdir -p -m 0700 "$LEDGER"
if ! mkdir -m 0700 "$LEDGER/$APPROVAL_ID" 2>/dev/null; then
  echo "STOP: POC_APPROVAL_ALREADY_USED; no Codex call was started."
  exit 25
fi
printf 'direction=%s\nsha256=%s\ncommit=%s\n' "tsugute-photos" "$EXPECTED_SHA" "$(git rev-parse HEAD)" > "$LEDGER/$APPROVAL_ID/receipt"
echo "POC_APPROVAL_RESERVED id=$APPROVAL_ID (no retry even if result is uncertain)"

REMAINING=$((BUDGET - (SECONDS - START)))
if [ "$REMAINING" -lt "$MIN_POC_SECONDS" ]; then
  echo "STOP: POC_RUN_TIME_BUDGET; no Codex call started (approval consumed: do not retry)."
  exit 1
fi

echo "== 4. tsugute photos (one Codex run, at most 6 image calls)"
set +e
SR_TSUGUTE_PHOTOS_LOCKED=run.lock timeout --kill-after="$KILL_AFTER" "$REMAINING" \
  "$REPO/node_modules/.bin/tsx" "$REPO/scripts/sales-design-worker/tsugute-photos.ts" \
  --human-approval-confirmed --budget-seconds="$((REMAINING - 120))"
RUN=$?
set -e
echo "tsugute-photos.ts exit $RUN"
if [ "$RUN" -eq 137 ] || [ "$RUN" -eq 124 ]; then
  echo "STOP: POC_KILLED_OR_TIMED_OUT. Check for an OOM kill before treating it as a bug:"
  bash "$REPO/scripts/ops/wsl-resource-preflight.sh" --oom-check --since "2 hours ago" || true
fi
exit "$RUN"
}
