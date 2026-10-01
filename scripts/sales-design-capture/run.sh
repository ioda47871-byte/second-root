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
#      `sudo bash scripts/sales-design-capture/admin.sh approve <sha>`, by a person.
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
# The node admin.sh pinned (the worker user's nvm is not readable here).
NODE_DIR="$(cat "$HOME/.config/sr-capture/node-dir" 2>/dev/null || true)"
[ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/node" ] || { echo "HELPER_NOT_INSTALLED (no node; sudo bash admin.sh approve <sha>)"; exit 2; }
export PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
STATE="$HOME/.local/state/sr-capture"
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/run.lock"
if ! flock -n 9; then
  echo "HELPER_BUSY"
  exit 0
fi

# Nothing to do: no request waiting and no result older than a day (the timer calls this often).
if [ -z "$(find /srv/sr-capture/requests -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ] \
  && [ -z "$(find /srv/sr-capture/results -mindepth 1 -maxdepth 1 -mmin +1440 -print -quit 2>/dev/null)" ]; then
  exit 0
fi

cd "$REPO"
APPROVED="$(cat "$HOME/.config/sr-capture/approved-sha" 2>/dev/null || true)"
[[ "$APPROVED" =~ ^[0-9a-f]{40}$ ]] || { echo "HELPER_NOT_APPROVED (no approved commit)"; exit 2; }
[ "$(git rev-parse HEAD)" = "$APPROVED" ] || { echo "HELPER_NOT_APPROVED (checkout is not the approved commit)"; exit 2; }
[ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo "HELPER_TREE_DIRTY"; exit 2; }
# A real env file (secrets) — not the tracked .env.local.example.
for f in .env .env.*; do
  case "$f" in *.example|'.env.*') ;; *) if [ -e "$f" ]; then echo "HELPER_ENV_FILE_PRESENT"; exit 2; fi ;; esac
done
[ -x node_modules/.bin/tsx ] || { echo "HELPER_NOT_INSTALLED (npm ci as sr-igcapture)"; exit 2; }

# Every run: if the machine now lets a requester become root or this user (WSL interop turned back
# on, an admin group added), requests are answered HELPER_ERROR and the browser profile stays closed.
# shellcheck source=host-check.sh
. "$REPO/scripts/sales-design-capture/host-check.sh"
UNSAFE=""
sr_check_wsl_interop >/dev/null || UNSAFE=WSL_INTEROP_ON
# with hidepid this user cannot see the requester's processes (sr_check_requester_processes): unknown is unsafe
awk '$2 == "/proc" && $4 ~ /hidepid=([12]|invisible|noaccess)/ { found = 1 } END { exit !found }' /proc/mounts && UNSAFE=PROC_HIDDEN
# members by the group list and by primary group
SPOOL_GID="$(getent group sr-capture | cut -d: -f3)"
for req in $(getent group sr-capture | cut -d: -f4 | tr ',' ' ') $(getent passwd | awk -F: -v g="$SPOOL_GID" '$4 == g { print $1 }'); do
  [ "$req" = sr-igcapture ] && continue
  sr_check_requester "$req" >/dev/null || UNSAFE=REQUESTER_PRIVILEGED
done
if [ -n "$UNSAFE" ]; then
  echo "HOST_UNSAFE ($UNSAFE): answering requests without opening the profile"
  export SR_CAPTURE_HOST_UNSAFE="$UNSAFE"
fi

timeout --kill-after=30 1700 "$REPO/node_modules/.bin/tsx" "$REPO/scripts/sales-design-capture/helper.ts" "$@"
exit $?
}
