#!/usr/bin/env bash
# Set up / update / sign in the Instagram capture helper (DEV-028 Phase 3).
# Run by a PERSON as root (sudo), never by the worker, Claude or Codex.
#
#   sudo bash admin.sh install <commit-sha> [requester-user]   # once
#   sudo bash admin.sh approve <commit-sha>                     # each new helper version
#   sudo bash admin.sh login                                    # headed Instagram sign-in (a person types)
#   sudo bash admin.sh jail-check                               # prove the requester jail on this machine
#   sudo bash admin.sh shell                                    # a jailed shell as the requester
#   sudo bash admin.sh claude-start | claude-stop               # Claude Remote Control, jailed
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
# The only checkout root runs admin.sh from and installs units / jail files from (root:root, /root 0700).
ROOT_CLONE=/root/sr-capture-admin
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

# The file and every directory above it owned by root and writable by nobody else: neither the
# requester nor the helper (it renders Instagram pages) can have changed what root runs or installs.
# A guard against mistakes (a copy that was changed would not keep this check), not a security check.
trusted_path() {
  local p owner
  p="$(readlink -f "$1")" || return 1
  while :; do
    owner="$(stat -c %u "$p")" || return 1
    [ "$owner" = 0 ] || return 1
    [ $(( 0$(stat -c %a "$p") & 022 )) -eq 0 ] || return 1
    [ "$p" = / ] && return 0
    p="$(dirname "$p")"
  done
}
for f in "$SELF_DIR/admin.sh" "$SELF_DIR/host-check.sh" "$SELF_DIR/jail/jail.properties" "$SELF_DIR/jail/probe.py"; do
  trusted_path "$f" || { echo "ADMIN_SCRIPT_UNTRUSTED: $f can be changed by a user other than root. Run admin.sh from the root-only clone $ROOT_CLONE (design-capture-helper.md §1)."; exit 2; }
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

# ---- the requester jail (docs/operations/design-wsl-isolation.md)
# In WSL2 every Linux process can reach Windows (the /run/WSL interop sockets
# are root:root 0777 even with interop off; vsock), and Windows is root of every
# distro. So no process of the requester may run outside the jail: its login
# shell is nologin, and it runs only as sr-jail-*.service units (Claude Remote
# Control, a person's jailed shell), whose settings hide those ways and whose
# probe proves it before each start.
JAIL_LIB=/usr/local/lib/sr-jail
JAIL_CLAUDE=sr-jail-claude.service
JAIL_NET=sr-jail-net.service
# The only DNS server the jail knows: pasta answers it on UDP/53 only (Ubuntu 24.04's passt
# forwards DNS over UDP, not TCP) with the host's resolver. DNS in the jail is UDP-only, by design:
# TCP to this address is refused at once inside the jail's namespace (an ip rule in sr-jail-net), so a
# truncated answer fails the lookup instead of hanging ~2 minutes on a TCP connect nobody answers.
JAIL_DNS=198.51.100.53
# Every jail unit needs the jail's network namespace and goes away with it.
JAIL_UNIT_DEPS=("Requires=$JAIL_NET" "BindsTo=$JAIL_NET" "After=$JAIL_NET")

jail_python() {
  local py
  py="$(readlink -f "$(command -v python3 2>/dev/null)" 2>/dev/null)" || return 1
  [ -x "$py" ] && root_owned "$py" && echo "$py"
}

# The jail settings for one requester: the shared list, then who / where, the
# default gateway (the Windows host in WSL's NAT) refused by address, and the probe.
jail_props() {
  local req="$1" home py gw
  home="$(getent passwd "$req" | cut -d: -f6)"
  [ -n "$home" ] && [ -d "$home" ] || return 1
  py="$(jail_python)" || return 1
  [ -f "$JAIL_LIB/jail.properties" ] || return 1
  grep -Ev '^[[:space:]]*(#|$)' "$JAIL_LIB/jail.properties" || return 1
  echo "User=$req"
  echo "BindPaths=$home"
  echo "WorkingDirectory=$home"
  echo "Environment=PATH=$home/.npm-global/bin:$home/.local/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 SHELL=/bin/bash"
  for gw in $(awk 'NR > 1 && $2 == "00000000" { print $3 }' /proc/net/route); do
    [[ "$gw" =~ ^[0-9A-Fa-f]{8}$ ]] || continue
    printf 'IPAddressDeny=%d.%d.%d.%d/32\n' "0x${gw:6:2}" "0x${gw:4:2}" "0x${gw:2:2}" "0x${gw:0:2}"
  done
  echo "ExecStartPre=$py -I $JAIL_LIB/probe.py $req"
}

jail_args() {
  local line props
  JAIL_ARGS=()
  props="$(jail_props "$1")" || return 1
  grep -qx "NoNewPrivileges=yes" <<<"$props" && grep -q "^ExecStartPre=.*probe.py" <<<"$props" || return 1
  while IFS= read -r line; do JAIL_ARGS+=(-p "$line"); done <<<"$props"
  for line in "${JAIL_UNIT_DEPS[@]}"; do JAIL_ARGS+=(-p "$line"); done
  systemctl start "$JAIL_NET"
}

jail_install() {
  local req="$1" home tmux_bin pasta_bin ip_bin systemctl_bin dep net_unit claude_unit props
  home="$(getent passwd "$req" | cut -d: -f6)"
  jail_python >/dev/null || { echo "PYTHON_MISSING: a root-owned python3 is needed for the jail probe (sudo apt install -y python3)"; exit 2; }
  tmux_bin="$(command -v tmux)" && root_owned "$tmux_bin" || { echo "TMUX_MISSING: sudo apt install -y tmux"; exit 2; }
  pasta_bin="$(command -v pasta)" && root_owned "$pasta_bin" || { echo "PASTA_MISSING: sudo apt install -y passt"; exit 2; }
  ip_bin="$(command -v ip)" && root_owned "$ip_bin" || { echo "IPROUTE_MISSING: sudo apt install -y iproute2"; exit 2; }
  systemctl_bin="$(command -v systemctl)" && root_owned "$systemctl_bin" || { echo "SYSTEMD_MISSING"; exit 2; }
  command -v systemd-run >/dev/null || { echo "SYSTEMD_MISSING: WSL needs [boot] systemd=true"; exit 2; }
  install -d -o root -g root -m 0755 "$JAIL_LIB"
  install -o root -g root -m 0644 "$SELF_DIR/jail/jail.properties" "$SELF_DIR/jail/probe.py" "$JAIL_LIB/"
  # The jail settings first, on their own: a unit without them must never be written.
  props="$(jail_props "$req")" || { echo "JAIL_PROPS_FAILED: no home or no python3 for $req"; exit 2; }
  grep -qx "NoNewPrivileges=yes" <<<"$props" && grep -q "^ExecStartPre=.*probe.py" <<<"$props" || { echo "JAIL_PROPS_FAILED"; exit 2; }
  # Nothing of the requester outside the jail: no login shell (su, wsl.exe -u, ssh), no cron / at / linger.
  usermod -s /usr/sbin/nologin "$req"
  # The jail's own network namespace, and pasta (root, a user-space NAT) as its only way out:
  # no port forwarding in either direction, the gateway not mapped to the host.
  # Both units are put together first and written only when that worked (no half-written unit).
  net_unit="$(
    echo "# Written by admin.sh (DEV-028). The requester jail's own network namespace."
    echo "[Unit]"
    echo "Description=Requester jail network (pasta)"
    echo "Wants=network-online.target"
    echo "After=network-online.target"
    echo "[Service]"
    echo "Type=simple"
    echo "RuntimeDirectory=sr-jail"
    echo "RuntimeDirectoryMode=0755"
    echo "ExecStartPre=-$ip_bin netns delete srjail"
    echo "ExecStartPre=$ip_bin netns add srjail"
    # inside the jail's namespace only, before pasta and any jail unit: TCP to the DNS address is refused (EACCES)
    echo "ExecStartPre=$ip_bin -n srjail rule add to $JAIL_DNS/32 ipproto tcp prohibit priority 100"
    echo "ExecStartPre=/bin/sh -c 'stat -L -c %%i /run/netns/srjail > /run/sr-jail/netns-id && printf \"nameserver $JAIL_DNS\\\\noptions edns0\\\\n\" > /run/sr-jail/resolv.conf && chmod 0644 /run/sr-jail/netns-id /run/sr-jail/resolv.conf'"
    echo "ExecStart=$pasta_bin -f -q --runas 0 --config-net --no-map-gw -t none -u none -T none -U none --dns-forward $JAIL_DNS --netns /run/netns/srjail"
    # pasta's own sockets: the same private ranges refused (only the WSL DNS tunnel, for the forwarded UDP queries)
    echo "IPAddressAllow=10.255.255.254/32"
    echo "IPAddressDeny=10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 ::1/128 fc00::/7 fe80::/10"
    # After pasta crashed or the boot raced it (the bound Claude unit stopped or its start failed),
    # bring Claude back when it is enabled (claude-stop disables it, so a stopped Claude stays stopped).
    echo "ExecStartPost=-/bin/sh -c '$systemctl_bin -q is-enabled $JAIL_CLAUDE && $systemctl_bin --no-block start $JAIL_CLAUDE || true'"
    echo "ExecStopPost=-$ip_bin netns delete srjail"
    echo "Restart=always"
    echo "RestartSec=5"
    echo "[Install]"
    echo "WantedBy=multi-user.target"
  )"
  claude_unit="$(
    echo "# Written by admin.sh (DEV-028). Claude Code Remote Control as $req, in the requester jail."
    echo "[Unit]"
    echo "Description=Claude Code Remote Control ($req, jailed)"
    for dep in "${JAIL_UNIT_DEPS[@]}"; do echo "$dep"; done
    echo "StartLimitIntervalSec=1h"
    echo "StartLimitBurst=10"
    echo "[Service]"
    echo "Type=forking"
    printf '%s\n' "$props"
    echo "ExecStart=$tmux_bin -S $home/.sr-claude.tmux new-session -d -s claude \"cd ~/work/second-root && exec claude remote-control\""
    echo "ExecStop=$tmux_bin -S $home/.sr-claude.tmux kill-server"
    # Claude exiting ends the tmux server cleanly: start it again either way.
    echo "Restart=always"
    echo "RestartSec=60"
    echo "[Install]"
    echo "WantedBy=multi-user.target"
  )"
  printf '%s\n' "$net_unit" > "/etc/systemd/system/$JAIL_NET.tmp"
  printf '%s\n' "$claude_unit" > "/etc/systemd/system/$JAIL_CLAUDE.tmp"
  chmod 0644 "/etc/systemd/system/$JAIL_NET.tmp" "/etc/systemd/system/$JAIL_CLAUDE.tmp"
  mv -f "/etc/systemd/system/$JAIL_NET.tmp" "/etc/systemd/system/$JAIL_NET"
  mv -f "/etc/systemd/system/$JAIL_CLAUDE.tmp" "/etc/systemd/system/$JAIL_CLAUDE"
  systemctl daemon-reload
  # A unit file ignores a setting it cannot parse (an older systemd, a typo) and starts anyway:
  # every jail setting must be accepted, and the loaded unit must carry the key ones.
  local verify
  verify="$(systemd-analyze verify "/etc/systemd/system/$JAIL_CLAUDE" 2>&1 | grep -E "sr-jail-claude.*(Unknown|Failed to parse|ignoring|Invalid)" || true)"
  [ -z "$verify" ] || { printf '%s\n' "$verify"; echo "JAIL_UNIT_REJECTED: this systemd does not take every jail setting"; rm -f "/etc/systemd/system/$JAIL_CLAUDE"; systemctl daemon-reload; exit 3; }
  local loaded want
  loaded="$(systemctl show "$JAIL_CLAUDE" -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateDevices -p ProtectProc -p NetworkNamespacePath -p RestrictSUIDSGID)"
  for want in NoNewPrivileges=yes ProtectSystem=strict ProtectHome=tmpfs PrivateDevices=yes ProtectProc=invisible NetworkNamespacePath=/run/netns/srjail RestrictSUIDSGID=yes; do
    grep -qx "$want" <<<"$loaded" || { echo "JAIL_UNIT_REJECTED: the loaded unit lacks $want"; rm -f "/etc/systemd/system/$JAIL_CLAUDE"; systemctl daemon-reload; exit 3; }
  done
  systemctl enable "$JAIL_NET" >/dev/null 2>&1
  # a (re-)install takes effect now: a new namespace, and the jail units bound to it start again in it
  systemctl restart "$JAIL_NET"
}

# The probe, run in a throw-away unit with exactly the jail's settings.
jail_check() {
  local req="$1" py
  py="$(jail_python)" || { echo "PYTHON_MISSING"; return 1; }
  jail_args "$req" || { echo "JAIL_NOT_INSTALLED"; return 1; }
  # The probe as the unit's own command, with the same settings: systemd-run --pipe does not pass on
  # an ExecStartPre's output, and the person must see which JAIL_UNSAFE code failed.
  local args=() i
  for ((i = 0; i < ${#JAIL_ARGS[@]}; i++)); do
    if [ "${JAIL_ARGS[$i]}" = -p ] && [[ "${JAIL_ARGS[$((i + 1))]}" == ExecStartPre=* ]]; then
      i=$((i + 1))
      continue
    fi
    args+=("${JAIL_ARGS[$i]}")
  done
  systemd-run --quiet --wait --collect --pipe --unit="sr-jail-check-$$" "${args[@]}" -- "$py" -I "$JAIL_LIB/probe.py" "$req"
}

# Every requester process (the network namespace stays: it holds no process of the requester).
stop_jail_units() {
  local u
  for u in $(systemctl list-units --all --plain --no-legend 'sr-jail-*.service' 2>/dev/null | awk '{ print ($1 == "●" ? $2 : $1) }'); do
    [ "$u" = "$JAIL_NET" ] || systemctl stop "$u" >/dev/null 2>&1 || true
  done
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
  # admin.sh, the units and the jail files come from this root-only clone, at exactly this commit
  [ "$(git -C "$SELF_DIR" rev-parse HEAD 2>/dev/null)" = "$sha" ] && [ -z "$(git -C "$SELF_DIR" status --porcelain --untracked-files=normal 2>/dev/null)" ] || {
    echo "ROOT_CLONE_NOT_AT_SHA: first: sudo git -C $ROOT_CLONE fetch -q origin && sudo git -C $ROOT_CLONE checkout -q --detach $sha"
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
  install -m 0644 "$SELF_DIR/systemd/sr-capture.service" /etc/systemd/system/sr-capture.service
  install -m 0644 "$SELF_DIR/systemd/sr-capture.path" /etc/systemd/system/sr-capture.path
  install -m 0644 "$SELF_DIR/systemd/sr-capture.timer" /etc/systemd/system/sr-capture.timer
  systemctl daemon-reload
  systemctl enable --now sr-capture.path sr-capture.timer >/dev/null
  # the jail settings and probe come from the same root-only clone
  if [ -f "/etc/systemd/system/$JAIL_CLAUDE" ]; then
    local req
    req="$(awk -F= '/^User=/ { print $2; exit }' "/etc/systemd/system/$JAIL_CLAUDE")"
    [ -n "$req" ] && jail_install "$req"
  fi
  echo "APPROVED $sha"
}

case "$CMD" in
  install)
    SHA="${2:-}"
    REQUESTER="${3:-sr-designgen}"
    id "$REQUESTER" >/dev/null 2>&1 || { echo "no such user: $REQUESTER"; exit 2; }
    # From now on the requester runs only inside the jail: nothing of it may run outside (an old
    # Claude / worker of Phase 2), and it gets no login shell. Then the same checks as every run.
    if pgrep -u "$REQUESTER" >/dev/null 2>&1; then
      echo "REQUESTER_RUNNING: stop every process of $REQUESTER first (an old Claude Remote Control, the worker):"
      echo "  sudo pkill -u $REQUESTER   # then run install again"
      exit 3
    fi
    usermod -s /usr/sbin/nologin "$REQUESTER"
    # Anything the requester left to run later outside the jail: crontab, queued at jobs, ssh forwarding.
    crontab -r -u "$REQUESTER" >/dev/null 2>&1 || true
    if command -v atq >/dev/null 2>&1; then
      for job in $(atq 2>/dev/null | awk -v u="$REQUESTER" '$NF == u { print $1 }'); do atrm "$job" 2>/dev/null || true; done
    fi
    if [ -d /etc/ssh/sshd_config.d ]; then
      printf '# DEV-028: the requester runs only inside its jail\nDenyUsers %s\n' "$REQUESTER" > /etc/ssh/sshd_config.d/sr-requester.conf
      systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true
    fi
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
    jail_install "$REQUESTER"
    jail_check "$REQUESTER" || { echo "JAIL_UNSAFE: the jail does not hold on this machine (lines above). Claude is not started."; exit 3; }
    echo "INSTALLED. Next: sudo bash $HOME_DIR/second-root/scripts/sales-design-capture/admin.sh shell   (a jailed shell for $REQUESTER: install / sign in Claude Code)"
    ;;
  approve)
    approve "${2:-}"
    ;;
  login)
    REQUESTER="${2:-sr-designgen}"
    # The requester's jail (Claude) is stopped while a person signs in, and started again after.
    CLAUDE_WAS_ACTIVE=0
    systemctl is-active --quiet "$JAIL_CLAUDE" 2>/dev/null && CLAUDE_WAS_ACTIVE=1
    systemctl is-enabled --quiet "$JAIL_CLAUDE" 2>/dev/null && CLAUDE_WAS_ACTIVE=1
    HELPER_WAS_ACTIVE=0
    systemctl is-active --quiet sr-capture.path 2>/dev/null && HELPER_WAS_ACTIVE=1
    LOGIN_DROPIN="/run/systemd/system/$JAIL_CLAUDE.d/sr-login.conf"
    # Whatever happens from here (a refusal, Ctrl-C, a closed terminal, an error): the window goes,
    # the helper and Claude come back.
    restore() {
      pkill -KILL -u "$HELPER" >/dev/null 2>&1 || true
      rm -f "$LOGIN_DROPIN"
      systemctl daemon-reload >/dev/null 2>&1 || true
      [ "$HELPER_WAS_ACTIVE" = 1 ] && systemctl start sr-capture.path sr-capture.timer >/dev/null 2>&1 || true
      [ "$CLAUDE_WAS_ACTIVE" = 1 ] && systemctl start "$JAIL_CLAUDE" >/dev/null 2>&1 || true
    }
    trap restore EXIT
    trap 'exit 130' INT TERM HUP
    # Nothing may start Claude during the sign-in (e.g. the net unit after a pasta crash). A runtime mask
    # would lose to the unit file in /etc; a runtime drop-in is merged, and its condition never holds.
    mkdir -p "$(dirname "$LOGIN_DROPIN")"
    printf '[Unit]\nConditionPathExists=/nonexistent/sr-login-in-progress\n' > "$LOGIN_DROPIN"
    systemctl daemon-reload
    stop_jail_units
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
  jail-check)
    REQUESTER="${2:-sr-designgen}"
    jail_check "$REQUESTER"
    ;;
  jail-install)
    # Re-writes the jail unit from this (approved) checkout, e.g. after the default gateway changed.
    REQUESTER="${2:-sr-designgen}"
    jail_install "$REQUESTER"
    jail_check "$REQUESTER" || { echo "JAIL_UNSAFE: the jail does not hold on this machine (lines above)"; exit 3; }
    ;;
  shell)
    # A person's shell AS the requester, inside the jail (install Claude Code, claude /login, look around).
    REQUESTER="${2:-sr-designgen}"
    host_safe "$REQUESTER" || { echo "HOST_UNSAFE: fix the lines above first"; exit 3; }
    jail_args "$REQUESTER" || { echo "JAIL_NOT_INSTALLED: run install first"; exit 2; }
    systemd-run --quiet --pty --wait --collect --unit="sr-jail-shell-$$" "${JAIL_ARGS[@]}" -- /bin/bash -l
    ;;
  run)
    # One command as the requester, inside the jail, without a terminal: admin.sh run sr-designgen -- npm test
    REQUESTER="${2:-}"
    [ "${3:-}" = "--" ] && [ $# -ge 4 ] || { echo "usage: admin.sh run <requester> -- <command...>"; exit 2; }
    host_safe "$REQUESTER" || { echo "HOST_UNSAFE: fix the lines above first"; exit 3; }
    jail_args "$REQUESTER" || { echo "JAIL_NOT_INSTALLED: run install first"; exit 2; }
    shift 3
    systemd-run --quiet --wait --collect --pipe --unit="sr-jail-run-$$-$RANDOM" -p RuntimeMaxSec=3500 "${JAIL_ARGS[@]}" -- "$@"
    ;;
  claude-start)
    REQUESTER="${2:-sr-designgen}"
    host_safe "$REQUESTER" || { echo "HOST_UNSAFE: fix the lines above first"; exit 3; }
    systemctl enable --now "$JAIL_CLAUDE" >/dev/null 2>&1 || true
    sleep 5
    systemctl is-active --quiet "$JAIL_CLAUDE" && echo "CLAUDE_STARTED (jailed)" || { echo "CLAUDE_NOT_STARTED: journalctl -u $JAIL_CLAUDE"; exit 3; }
    ;;
  claude-stop)
    systemctl disable --now "$JAIL_CLAUDE" >/dev/null 2>&1 || true
    stop_jail_units
    echo "CLAUDE_STOPPED"
    ;;
  status)
    stat -c '%A %U:%G %n' "$HOME_DIR" "$SPOOL" "$SPOOL/requests" "$SPOOL/results"
    echo "approved: $(cat "$CONF/approved-sha" 2>/dev/null || echo none)"
    echo "node: $(cat "$CONF/node-dir" 2>/dev/null || echo none)"
    systemctl is-enabled sr-capture.path sr-capture.timer || true
    echo "jail: $(systemctl is-enabled "$JAIL_CLAUDE" 2>/dev/null || echo none) / $(systemctl is-active "$JAIL_CLAUDE" 2>/dev/null || echo inactive)"
    echo "jail network rules:"; ip -n srjail rule show 2>/dev/null || echo "  (no jail network namespace)"
    ;;
  *)
    echo "usage: sudo bash admin.sh install <sha> [requester] | approve <sha> | login | jail-check | jail-install | shell | run <requester> -- <cmd> | claude-start | claude-stop | status"; exit 2 ;;
esac
