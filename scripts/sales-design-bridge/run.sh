#!/usr/bin/env bash
# Second Root design bridge — the one supported entry point (DEV-030).
#
#   ./scripts/sales-design-bridge/run.sh --once           deliver, expire, claim one job
#   ./scripts/sales-design-bridge/run.sh --deliver-only   deliver and expire; never claim
#
# Run as the dedicated Linux user sr-designbridge (never sr-designgen), by
# hand or from sr-design-bridge.service (docs/operations/design-bridge.md).
# It
#   1. restarts itself with an allowlisted environment (no other secret, and
#      the bridge token is never an environment variable: it is read from a
#      0600 file by bridge.ts; the optional Vercel bypass of DEV-059 likewise:
#      only its file path and origin pass),
#   2. refuses to run as the worker user or as root,
#   3. allows one run at a time (flock),
#   4. runs one pass of the bridge with a time limit (bridge.ts checks the
#      mode and refuses anything else).
# It does not update its own checkout: a person checks out an approved commit.
{
set -euo pipefail

if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in HOME PATH USER LOGNAME LANG TZ XDG_STATE_HOME \
    HTTPS_PROXY https_proxy NO_PROXY no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE \
    SR_DESIGN_BRIDGE_API_URL SR_DESIGN_BRIDGE_TOKEN_FILE SR_DESIGN_BRIDGE_SPOOL \
    SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec env -i "${keep[@]}" bash "$0" --sr-clean-env "$@"
fi

case "$(id -un)" in
  root | sr-designgen | sr-igcapture)
    echo "stopped: BRIDGE_WRONG_USER"
    exit 3
    ;;
esac

umask 077
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# DEV-062: run from the checkout, not from wherever it was started. tsx finds
# tsconfig.json (the "@/..." import paths bridge.ts needs) from the current
# directory, so from anywhere else the bridge failed with MODULE_NOT_FOUND (this
# includes cycle.sh, which starts it from /); and esbuild is spawned in the
# current directory, so a Windows path under WSL (/mnt/c/...) the bridge user
# cannot use failed with EACCES. Relative paths in the settings would then point
# into the checkout, so they are refused, and so is a set but empty one (the
# bridge would treat "" as a path in the checkout too: a fresh ledger there).
for name in XDG_STATE_HOME SR_DESIGN_BRIDGE_SPOOL SR_DESIGN_BRIDGE_TOKEN_FILE SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE; do
  value="${!name:-}"
  if [ -n "${!name+x}" ] && [ "${value#/}" = "$value" ]; then
    echo "stopped: BRIDGE_PATH_NOT_ABSOLUTE ($name)"
    exit 3
  fi
done
cd "$REPO"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/sr-design-bridge"
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/run.lock"
if ! flock -n 9; then
  echo "another bridge run is active; nothing to do"
  exit 0
fi

timeout --kill-after=10 240 "$REPO/node_modules/.bin/tsx" "$REPO/scripts/sales-design-bridge/bridge.ts" "$@"
exit $?
}
