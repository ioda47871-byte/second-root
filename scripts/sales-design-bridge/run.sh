#!/usr/bin/env bash
# Second Root design bridge — the one supported entry point (DEV-030).
#
#   ./scripts/sales-design-bridge/run.sh --once
#
# Run as the dedicated Linux user sr-designbridge (never sr-designgen), by
# hand or from sr-design-bridge.service (docs/operations/design-bridge.md).
# It
#   1. restarts itself with an allowlisted environment (no other secret, and
#      the bridge token is never an environment variable: it is read from a
#      0600 file by bridge.ts),
#   2. refuses to run as the worker user or as root,
#   3. allows one run at a time (flock),
#   4. runs one pass of the bridge with a time limit.
# It does not update its own checkout: a person checks out an approved commit.
{
set -euo pipefail

if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in HOME PATH USER LOGNAME LANG TZ XDG_STATE_HOME \
    HTTPS_PROXY https_proxy NO_PROXY no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE \
    SR_DESIGN_BRIDGE_API_URL SR_DESIGN_BRIDGE_TOKEN_FILE SR_DESIGN_BRIDGE_SPOOL; do
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
