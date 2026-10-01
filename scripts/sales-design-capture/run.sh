#!/usr/bin/env bash
# Second Root Instagram capture helper — entry point (DEV-028 Phase 3).
#
# Started by systemd (sr-capture.service) as the user sr-igcapture, the ONLY
# user that can read the signed-in Instagram browser profile. It
#   1. restarts itself with an allowlisted environment,
#   2. allows one run at a time (flock),
#   3. refuses to run unless this checkout is exactly the commit a person
#      approved (~/.config/sr-capture/approved-sha, owned by sr-igcapture,
#      written by hand), unchanged, without a .env file. It never fetches or
#      updates itself: the worker / Claude user cannot change the code that
#      holds the session. A new version is approved with
#      scripts/sales-design-capture/approve.sh, by a person, as root.
#   4. runs the helper (scripts/sales-design-capture/helper.ts).
{
set -euo pipefail

if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in HOME PATH USER LOGNAME LANG LANGUAGE TZ PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_CHROMIUM_EXECUTABLE \
    HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec env -i "${keep[@]}" bash "$0" --sr-clean-env "$@"
fi

umask 027
[ "$(id -un)" = "sr-igcapture" ] || { echo "WRONG_USER (run as sr-igcapture)"; exit 2; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
STATE="$HOME/.local/state/sr-capture"
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/run.lock"
if ! flock -n 9; then
  echo "HELPER_BUSY"
  exit 0
fi

cd "$REPO"
APPROVED="$(cat "$HOME/.config/sr-capture/approved-sha" 2>/dev/null || true)"
[[ "$APPROVED" =~ ^[0-9a-f]{40}$ ]] || { echo "HELPER_NOT_APPROVED (no approved commit)"; exit 2; }
[ "$(git rev-parse HEAD)" = "$APPROVED" ] || { echo "HELPER_NOT_APPROVED (checkout is not the approved commit)"; exit 2; }
[ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo "HELPER_TREE_DIRTY"; exit 2; }
if ls -A | grep -q '^\.env' ; then echo "HELPER_ENV_FILE_PRESENT"; exit 2; fi
[ -x node_modules/.bin/tsx ] || { echo "HELPER_NOT_INSTALLED (npm ci as sr-igcapture)"; exit 2; }

timeout --kill-after=30 1700 "$REPO/node_modules/.bin/tsx" "$REPO/scripts/sales-design-capture/helper.ts" "$@"
exit $?
}
