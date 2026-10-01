#!/usr/bin/env bash
# Set up / update the Instagram capture helper (DEV-028 Phase 3). Run by a
# PERSON as root (sudo), never by the worker, Claude or Codex.
#
#   sudo bash admin.sh install <commit-sha> [requester-user]   # once
#   sudo bash admin.sh approve <commit-sha>                     # each new helper version
#   sudo bash admin.sh status
#
# install: creates the user sr-igcapture (owns the Instagram browser profile;
# home 0700) and the group sr-capture (requesters), adds the requester
# (default sr-designgen) to that group, creates the spool /srv/sr-capture,
# then does `approve`.
# approve: checks out exactly <commit-sha> in ~sr-igcapture/second-root,
# installs its dependencies, records the commit as approved and installs the
# systemd units FROM THAT CHECKOUT. Review the change between the old and
# the new approved commit before approving (git diff <old> <new> --
# lib/design-agent scripts/sales-design-capture).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 2; }
CMD="${1:-}"
HELPER=sr-igcapture
GROUP=sr-capture
HOME_DIR="/home/$HELPER"
REPO_URL="https://github.com/ioda47871-byte/second-root.git"
SPOOL=/srv/sr-capture

as_helper() { sudo -u "$HELPER" -H env -i HOME="$HOME_DIR" PATH="$PATH" LANG=C.UTF-8 bash -c "$1"; }

approve() {
  local sha="$1"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "give the full 40-character commit sha"; exit 2; }
  as_helper "set -e; cd ~; [ -d second-root/.git ] || git clone --quiet --no-checkout '$REPO_URL' second-root
    cd second-root; git fetch --quiet origin; git cat-file -e '$sha^{commit}'
    git checkout --quiet --force --detach '$sha'; git clean -q -f -d -x -e node_modules
    npm ci --no-audit --no-fund --loglevel=error
    npx playwright install chromium >/dev/null
    mkdir -p -m 700 ~/.config/sr-capture; printf '%s\n' '$sha' > ~/.config/sr-capture/approved-sha; chmod 600 ~/.config/sr-capture/approved-sha"
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
    id "$HELPER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$HELPER" >/dev/null
    chmod 700 "$HOME_DIR"
    # The requester may ask; it never becomes a member of the helper's own group.
    # The helper reads requests through the spool group too (requests are 0640 requester:sr-capture).
    usermod -aG "$GROUP" "$REQUESTER"
    usermod -aG "$GROUP" "$HELPER"
    install -d -o root -g root -m 0755 "$SPOOL"
    install -d -o "$HELPER" -g "$GROUP" -m 3730 "$SPOOL/requests"
    install -d -o "$HELPER" -g "$GROUP" -m 2750 "$SPOOL/results"
    chmod 3730 "$SPOOL/requests"; chmod 2750 "$SPOOL/results"
    approve "$SHA"
    echo "INSTALLED (the requester must log in again for the new group)"
    ;;
  approve)
    approve "${2:-}"
    ;;
  status)
    stat -c '%A %U:%G %n' "$HOME_DIR" "$SPOOL" "$SPOOL/requests" "$SPOOL/results"
    echo "approved: $(cat "$HOME_DIR/.config/sr-capture/approved-sha" 2>/dev/null || echo none)"
    systemctl is-enabled sr-capture.path sr-capture.timer || true
    ;;
  *)
    echo "usage: sudo bash admin.sh install <sha> [requester] | approve <sha> | status"; exit 2 ;;
esac
