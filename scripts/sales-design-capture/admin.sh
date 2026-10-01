#!/usr/bin/env bash
# Set up / update / sign in the Instagram capture helper (DEV-028 Phase 3).
# Run by a PERSON as root (sudo), never by the worker, Claude or Codex.
#
#   sudo bash admin.sh install <commit-sha> [requester-user]   # once
#   sudo bash admin.sh approve <commit-sha>                     # each new helper version
#   sudo bash admin.sh login                                    # headed Instagram sign-in (a person types)
#   sudo bash admin.sh status
#
# install: creates the user sr-igcapture (owns the Instagram browser profile;
# home 0700) and the group sr-capture, adds the requester (default
# sr-designgen) and the helper to that group, creates the spool
# /srv/sr-capture, then does `approve`.
# approve: shows what changed since the approved commit (the WHOLE tree:
# package.json, the lockfile and tsconfig.json matter as much as the code),
# asks you to confirm, then checks out exactly <commit-sha> in
# ~sr-igcapture/second-root, installs dependencies WITHOUT install scripts,
# records the commit and the node to use, and installs the systemd units
# FROM THAT CHECKOUT.
# login: opens the headed sign-in window as sr-igcapture. It refuses while
# any process of the requester user runs (Claude, the worker): they share
# the X display and could read the window.
#
# install and login refuse on a machine where the requester could become
# root or the helper user (host-check.sh: WSL interop on, an admin group, a
# sudo rule, the WSL default user, writable Windows Startup folders).
#
# This script runs as root: it refuses to run from a copy the requester could
# have changed (e.g. its ~/work checkout). Install from a root-owned clone,
# later use the helper's own checkout (design-capture-helper.md).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 2; }
CMD="${1:-}"
HELPER=sr-igcapture
GROUP=sr-capture
HOME_DIR="/home/$HELPER"
REPO_URL="https://github.com/ioda47871-byte/second-root.git"
SPOOL=/srv/sr-capture
CONF="$HOME_DIR/.config/sr-capture"
SELF_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"

# Every directory from / down to the file, and the file, owned by root and
# writable by nobody else (a node the requester could rewrite would run as
# the helper, with the profile).
root_owned() {
  local p
  p="$(readlink -f "$1")" || return 1
  while :; do
    [ "$(stat -c %u "$p")" = 0 ] || return 1
    [ $(( 0$(stat -c %a "$p") & 022 )) -eq 0 ] || return 1
    [ "$p" = / ] && return 0
    p="$(dirname "$p")"
  done
}

# The file and every directory above it owned by root or the helper user, and
# writable by nobody else: the requester cannot have changed what root runs.
trusted_path() {
  local p owner helper_uid
  helper_uid="$(id -u "$HELPER" 2>/dev/null || echo -1)"
  p="$(readlink -f "$1")" || return 1
  while :; do
    owner="$(stat -c %u "$p")" || return 1
    [ "$owner" = 0 ] || [ "$owner" = "$helper_uid" ] || return 1
    [ $(( 0$(stat -c %a "$p") & 022 )) -eq 0 ] || return 1
    [ "$p" = / ] && return 0
    p="$(dirname "$p")"
  done
}
for f in "$SELF_DIR/admin.sh" "$SELF_DIR/host-check.sh"; do
  trusted_path "$f" || { echo "ADMIN_SCRIPT_UNTRUSTED: $f can be changed by a user other than root / $HELPER. Run admin.sh from a root-owned clone (design-capture-helper.md §1) or from $HOME_DIR/second-root."; exit 2; }
done
# shellcheck source=host-check.sh
. "$SELF_DIR/host-check.sh"

# Every check that keeps the requester from becoming root or the helper; all are printed.
host_safe() {
  local req="$1" ok=0
  sr_check_wsl_interop || ok=1
  sr_check_requester "$req" || ok=1
  sr_check_requester_root "$req" || ok=1
  return $ok
}

# A system node >= 20 the helper user can run (an nvm node in another user's home is not readable),
# resolved to its real directory and owned by root all the way up.
find_node() {
  for d in /usr/local/bin /usr/bin /opt/node/bin; do
    if [ -x "$d/node" ] && [ -x "$d/npm" ] && root_owned "$d/node" && root_owned "$d/npm"; then
      real="$(dirname "$(readlink -f "$d/node")")"
      major="$("$real/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
      if [ "$major" -ge 20 ] && [ -x "$real/npm" ] && root_owned "$real/npm"; then echo "$real"; return 0; fi
    fi
  done
  return 1
}

as_helper() {
  local node_dir="$1"; shift
  local keep=()
  for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  sudo -u "$HELPER" -H env -i HOME="$HOME_DIR" PATH="$node_dir:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 "${keep[@]}" bash -c "$1"
}

approve() {
  local sha="$1" confirm="${2:-ask}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "give the full 40-character commit sha"; exit 2; }
  local node_dir
  node_dir="$(find_node)" || {
    echo "NODE_MISSING: no root-owned Node >= 20 with npm in /usr/local/bin, /usr/bin or /opt/node/bin."
    echo "  Install Node 22 system-wide (e.g. NodeSource: https://github.com/nodesource/distributions). A tarball unpacked with"
    echo "  sudo tar keeps the archive's owner: sudo chown -R root:root <node dir>, then run again."
    exit 2
  }
  as_helper "$node_dir" "set -e; cd ~; [ -d second-root/.git ] || git clone --quiet --no-checkout '$REPO_URL' second-root
    cd second-root; git fetch --quiet origin; git cat-file -e '$sha^{commit}'"
  local old
  old="$(cat "$CONF/approved-sha" 2>/dev/null || true)"
  if [ "$confirm" = ask ]; then
    if [[ "$old" =~ ^[0-9a-f]{40}$ ]]; then
      echo "Changes since the approved commit ${old:0:12} (review ALL of them, not only lib/ and scripts/):"
      as_helper "$node_dir" "cd ~/second-root && git --no-pager diff --stat '$old' '$sha'"
      echo "Full diff: sudo -u $HELPER git -C $HOME_DIR/second-root diff $old $sha"
    else
      echo "First approval of the helper code at ${sha:0:12}."
    fi
    read -r -p "Type the first 12 characters of the commit to approve it: " typed
    [ "$typed" = "${sha:0:12}" ] || { echo "NOT_APPROVED"; exit 2; }
  fi
  as_helper "$node_dir" "set -e; cd ~/second-root
    git checkout --quiet --force --detach '$sha'; git clean -q -f -d -x -e node_modules
    npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
    npx playwright install chromium >/dev/null
    mkdir -p -m 700 ~/.config/sr-capture
    printf '%s\n' '$sha' > ~/.config/sr-capture/approved-sha; chmod 600 ~/.config/sr-capture/approved-sha
    printf '%s\n' '$node_dir' > ~/.config/sr-capture/node-dir; chmod 600 ~/.config/sr-capture/node-dir"
  install -m 0644 "$HOME_DIR/second-root/scripts/sales-design-capture/systemd/sr-capture.service" /etc/systemd/system/sr-capture.service
  install -m 0644 "$HOME_DIR/second-root/scripts/sales-design-capture/systemd/sr-capture.path" /etc/systemd/system/sr-capture.path
  install -m 0644 "$HOME_DIR/second-root/scripts/sales-design-capture/systemd/sr-capture.timer" /etc/systemd/system/sr-capture.timer
  systemctl daemon-reload
  systemctl enable --now sr-capture.path sr-capture.timer >/dev/null
  echo "APPROVED $sha"
}

case "$CMD" in
  install)
    SHA="${2:-}"
    REQUESTER="${3:-sr-designgen}"
    id "$REQUESTER" >/dev/null 2>&1 || { echo "no such user: $REQUESTER"; exit 2; }
    host_safe "$REQUESTER" || { echo "HOST_UNSAFE: fix the lines above, then run install again"; exit 3; }
    getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
    id "$HELPER" >/dev/null 2>&1 || adduser --disabled-password --comment "" "$HELPER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$HELPER" >/dev/null
    chmod 700 "$HOME_DIR"
    # The requester may ask; it never becomes a member of the helper's own group.
    # The helper reads requests through the spool group too (requests are 0640 requester:sr-capture).
    usermod -aG "$GROUP" "$REQUESTER"
    usermod -aG "$GROUP" "$HELPER"
    # Nothing of the requester may start on its own later (e.g. during a login): no cron, no at, no lingering user services.
    for f in /etc/cron.deny /etc/at.deny; do grep -qx "$REQUESTER" "$f" 2>/dev/null || echo "$REQUESTER" >> "$f"; done
    loginctl disable-linger "$REQUESTER" >/dev/null 2>&1 || true
    install -d -o root -g root -m 0755 "$SPOOL"
    install -d -o "$HELPER" -g "$GROUP" -m 3730 "$SPOOL/requests"
    install -d -o "$HELPER" -g "$GROUP" -m 2750 "$SPOOL/results"
    chmod 3730 "$SPOOL/requests"; chmod 2750 "$SPOOL/results"
    approve "$SHA" "${SR_CAPTURE_CONFIRM:-ask}"
    echo "INSTALLED. $REQUESTER must start a new login for the group (WSL: wsl --shutdown, then open again)."
    ;;
  approve)
    approve "${2:-}"
    ;;
  login)
    REQUESTER="${2:-sr-designgen}"
    host_safe "$REQUESTER" || { echo "HOST_UNSAFE: fix the lines above, then run login again"; exit 3; }
    if pgrep -u "$REQUESTER" >/dev/null 2>&1; then
      echo "REQUESTER_RUNNING: stop every process of $REQUESTER first (Claude, the worker): they share the display."
      echo "  sudo pkill -u $REQUESTER   # then run this again"
      exit 3
    fi
    NODE_DIR="$(cat "$CONF/node-dir" 2>/dev/null || true)"
    [ -x "$NODE_DIR/node" ] && root_owned "$NODE_DIR/node" || { echo "HELPER_NOT_INSTALLED"; exit 2; }
    # The helper does not capture while a person signs in (a run in progress is stopped too).
    systemctl stop sr-capture.path sr-capture.timer sr-capture.service >/dev/null 2>&1 || true
    # Whatever happens (Ctrl-C, a closed terminal, an error): the window goes and the helper comes back.
    restore() {
      pkill -KILL -u "$HELPER" >/dev/null 2>&1 || true
      systemctl start sr-capture.path sr-capture.timer >/dev/null 2>&1 || true
    }
    trap restore EXIT
    trap 'exit 130' INT TERM HUP
    sudo -u "$HELPER" -H env -i HOME="$HOME_DIR" PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 DISPLAY="${DISPLAY:-:0}" \
      bash -c 'cd ~/second-root && npm run -s sales:design-browser -- login' &
    LOGIN_PID=$!
    RC=0
    # Watch the whole time: if anything of the requester starts, the window goes away at once.
    while kill -0 "$LOGIN_PID" 2>/dev/null; do
      if pgrep -u "$REQUESTER" >/dev/null 2>&1; then
        pkill -KILL -u "$HELPER" || true
        echo "LOGIN_ABORTED: a process of $REQUESTER started during the sign-in"
        RC=3
        break
      fi
      sleep 0.5
    done
    LOGIN_RC=0
    wait "$LOGIN_PID" 2>/dev/null || LOGIN_RC=$?
    [ "$RC" != 0 ] || RC=$LOGIN_RC
    exit "$RC"
    ;;
  status)
    stat -c '%A %U:%G %n' "$HOME_DIR" "$SPOOL" "$SPOOL/requests" "$SPOOL/results"
    echo "approved: $(cat "$CONF/approved-sha" 2>/dev/null || echo none)"
    echo "node: $(cat "$CONF/node-dir" 2>/dev/null || echo none)"
    systemctl is-enabled sr-capture.path sr-capture.timer || true
    ;;
  *)
    echo "usage: sudo bash admin.sh install <sha> [requester] | approve <sha> | login | status"; exit 2 ;;
esac
