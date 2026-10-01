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
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 2; }
CMD="${1:-}"
HELPER=sr-igcapture
GROUP=sr-capture
HOME_DIR="/home/$HELPER"
REPO_URL="https://github.com/ioda47871-byte/second-root.git"
SPOOL=/srv/sr-capture
CONF="$HOME_DIR/.config/sr-capture"

# A system node >= 20 the helper user can run (an nvm node in another user's home is not readable).
find_node() {
  for d in /usr/local/bin /usr/bin /opt/node/bin; do
    if [ -x "$d/node" ] && [ -x "$d/npm" ]; then
      major="$("$d/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
      if [ "$major" -ge 20 ]; then echo "$d"; return 0; fi
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
  node_dir="$(find_node)" || { echo "NODE_MISSING: install Node 22 system-wide first (e.g. NodeSource: https://github.com/nodesource/distributions), then run again"; exit 2; }
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
    getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
    id "$HELPER" >/dev/null 2>&1 || adduser --disabled-password --comment "" "$HELPER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$HELPER" >/dev/null
    chmod 700 "$HOME_DIR"
    # The requester may ask; it never becomes a member of the helper's own group.
    # The helper reads requests through the spool group too (requests are 0640 requester:sr-capture).
    usermod -aG "$GROUP" "$REQUESTER"
    usermod -aG "$GROUP" "$HELPER"
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
    if pgrep -u "$REQUESTER" >/dev/null 2>&1; then
      echo "REQUESTER_RUNNING: stop every process of $REQUESTER first (Claude, the worker): they share the display."
      echo "  sudo pkill -u $REQUESTER   # then run this again"
      exit 3
    fi
    NODE_DIR="$(cat "$CONF/node-dir" 2>/dev/null || true)"
    [ -x "$NODE_DIR/node" ] || { echo "HELPER_NOT_INSTALLED"; exit 2; }
    sudo -u "$HELPER" -H env -i HOME="$HOME_DIR" PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 DISPLAY="${DISPLAY:-:0}" \
      bash -c 'cd ~/second-root && npm run -s sales:design-browser -- login'
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
