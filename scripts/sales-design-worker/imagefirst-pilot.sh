#!/usr/bin/env bash
# Second Root IMAGE_FIRST limited pilot (Issue #302, owner pre-approval 2026-11-21): ONE ほし窯 d3 generation by the
# EXISTING worker (or d4: the approval id names the direction, and only d4's own packet approves it), its delivery to the private review inbox, an audit dry run and ONE Claude CLI audit, started once by
# root by hand (docs/operations/imagefirst-pilot.md). It has no runner, approval parser, retry or agent of its own: it
# runs the read-only preflight (imagefirst-pilot-preflight.sh), then the existing pieces in order, and stops at the
# first thing that is not exactly as expected.
#
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot.sh --sync-clone
#   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot.sh <approval id>
#
# --sync-clone: only the automatic start's step 5 (copied line for line; a test pins it): as the worker, git fetch origin
#   develop, the tree clean, HEAD an ancestor of origin/develop, detach onto origin/develop (a fast-forward; never --force,
#   never clean), npm ci only when package-lock.json changed. Nothing else: no precheck, no worker, no audit.
#
# <approval id>, in this order (anything unexpected stops it; nothing is ever retried):
#   1. the automatic start's lock and cycle.sh's lock, held for the run (released only around step 4's re-send, which
#      takes them itself), then the preflight (every row PASS, else stop, exit 20: nothing was started or spent)
#   2. busy() again (the automatic start's, verbatim), then the EXISTING worker ONCE as the worker user outside the jail,
#      with the automatic start's own setpriv line, timeout and grant (SR_IMAGEFIRST_EXPECT_APPROVAL_ID = this id). This
#      is the one generation: the worker claims the approval (one use), the entry makes one Codex run (15 min, PC 2 +
#      SP 4, no retry), and the worker writes the receipt, seals the bundle and hands it to the review inbox (PR #310).
#      Anything but "succeeded": stop, no delivery and no audit
#   3. busy() again (a jailed Claude that started meanwhile stops the pilot here)
#   4. the worker's own hand-off result; if it did not deliver, root's existing re-send wrapper ONCE
#      (imagefirst-deliver-review.sh: the same sealed bundle only, never a new generation). Not delivered: stop, no audit
#   5. busy() again, then imagefirst-audit.ts <id> --dry-run as the worker (it refuses over the 20 images / 18 MiB cap):
#      anything but "planned": stop, no audit
#   6. busy() again, then imagefirst-audit.ts <id> ONCE as the worker (its own one-use marker per bundle and rubric)
#   7. a summary of codes and hashes only (read by the worker user from its own files; never an image, a prompt, the
#      findings text or a secret): approval, commit, generation runs, image SHAs and sizes, receipt SHA, bundle SHA,
#      delivery state, audit status, rubric SHA, scores, verdict
# A second pilot for the same approval stops in step 1: the preflight's no_prior_run row and the worker's own precheck
# (the claim, APPROVAL_ALREADY_CLAIMED) fail, and the audit's marker would refuse too. It never installs, enables,
# starts or stops a systemd unit or timer, and never creates the automatic start's switch or marker.
#
# A stop signal (as the automatic start's handler, keyed on PHASE): before the worker starts it ends the pilot there
# (PILOT_STOP_SIGNAL, exit 40, phase=before_claim: nothing used). From the worker's start on it is passed on to the running
# worker or audit and waited for (the worker writes its receipt, the audit its stopped record), and the pilot ends at the
# next step boundary: PILOT_INTERRUPTED, exit 1, phase=after_claim (the approval may be spent: read the receipt). Press
# Ctrl-C once and wait (a second one within the worker's grace is a hard stop by design).
#
# --autorun <approval id> <commit> (docs/operations/imagefirst-autorun.md): the same run, started only by imagefirst-autorun.sh
#   inside sr-imagefirst-autorun.service (refused anywhere else: this process's own cgroup, read from the kernel, must be that
#   service's; PILOT_AUTORUN_REFUSED). The differences: root's admin clone must be clean at exactly <commit> (the commit the
#   automatic run verified against origin); root's used/<approval id> must not exist (PILOT_MARKER_USED); the reused clone
#   is never used: a fresh clone at a new root-chosen path, from root's origin URL, at exactly <commit>, with no user or
#   system git config, status --ignored empty, then npm ci; the preflight, the worker run, the re-send and the audit use
#   it (the steps below); and right before the worker starts,
#   used/<approval id> is created (atomic mkdir in root's 0700 state, never
#   removed, as the automatic start's step 7), so the automatic run never starts the worker twice for one id. The
#   preflight sees the same cgroup and accepts exactly that service and its timer in its timers row. Every other step,
#   check, line and code is the manual run's.
#
# Output: the preflight's table, fixed lines, the workers' one JSON lines with local paths replaced by <local>, then the
# summary in two parts: "share:" lines (codes, counts, yes/no only: what may go to Issue #302) and "local-only:" lines
# (SHA-256s, raw stderr: keep them on the machine). The last line is machine-readable and shareable:
#   IMAGEFIRST_PILOT <CODE> phase=<before_claim|after_claim> approval=<id|none> exit=<n>
# Exit: 0 done (or synced), 20 preflight FAIL / clone (nothing started), 12 busy before the worker, 2 usage / refused,
#       1 stopped after the worker started (worker stopped, not delivered, busy, interrupted, dry run or audit not as
#       expected), 40 a signal before the worker (nothing used), 41 an internal error (with phase=after_claim the approval
#       may be spent: read the receipt and the summary).
#
# The whole script is one { ... } block, so bash has read all of it before it starts.
{
set -euo pipefail

# Restart with an allowlisted environment (marked by an argument, not a variable).
if [ "${1:-}" = "--sr-clean-env" ]; then
  shift
else
  keep=()
  for name in PATH LANG TZ HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy \
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SR_IMAGEFIRST_PILOT_TEST_ROOT; do
    if [ -n "${!name+x}" ]; then keep+=("$name=${!name}"); fi
  done
  exec /usr/bin/env -i "${keep[@]}" /bin/bash "${BASH_SOURCE[0]}" --sr-clean-env "$@"
fi

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
umask 077
cd /

# ---------------------------------------------------------------- limits (every step is cut by timeout(1))
KILL_AFTER=30
FETCH_TIMEOUT=180
GIT_TIMEOUT=60
NPM_TIMEOUT=900
# the worker: the entry's 20 min watchdog + 2 min margin + 35 s grace + the receipt (as the automatic start)
WORKER_TIMEOUT=1800
WORKER_KILL_AFTER=90
# the audit dry run: verify and plan only
DRY_RUN_TIMEOUT=600
# --autorun: the fresh clone of the whole repository (more than a fetch)
CLONE_TIMEOUT=600
# the audit: at most 3 calls of 10 min each, plus the checks and the record
AUDIT_TIMEOUT=2400
AUDIT_KILL_AFTER=90
GRANT_ENV=SR_IMAGEFIRST_EXPECT_APPROVAL_ID

PHASE=before_claim
APPROVAL=none
FINISHED=0
INTERRUPTED=0
WPID=""
WORK=""
RECEIPT=""
DELIVERY="unknown"
AUDIT_LINE=""

say() { printf 'imagefirst-pilot: %s\n' "$*"; }
finish() {
  local code="$1" rc="$2"
  FINISHED=1
  trap - EXIT INT TERM HUP
  [ "$PHASE" != after_claim ] || summary || true
  [ -z "$WORK" ] || rm -rf "$WORK"
  printf 'IMAGEFIRST_PILOT %s phase=%s approval=%s exit=%s\n' "$code" "$PHASE" "$APPROVAL" "$rc"
  exit "$rc"
}
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return
  say "stopped by an unexpected error (exit $rc)"
  finish PILOT_STOP_INTERNAL 41
}
on_signal() {
  # after the marker: pass the stop on to the worker and wait for its receipt (below); before it: stop here
  # (the automatic start's handler, keyed on PHASE, review M2: a stop between the fork and WPID=$! is passed on right after
  # the fork; a stop during a later step ends the pilot at the next step boundary: PILOT_INTERRUPTED)
  if [ "$PHASE" = after_claim ]; then
    INTERRUPTED=1
    [ -z "$WPID" ] || kill -TERM "$WPID" 2>/dev/null || true
    return 0
  fi
  finish PILOT_STOP_SIGNAL 40
}
# a stop already requested ends the pilot at a step boundary (after the worker started: the approval may be spent)
stop_if_interrupted() { if [ "$INTERRUPTED" = 1 ]; then finish PILOT_INTERRUPTED 1; fi; }
trap on_exit EXIT
trap on_signal INT TERM HUP

# ---------------------------------------------------------------- the mode
MODE=run
if [ "$#" -eq 1 ] && [ "$1" = --sync-clone ]; then
  MODE=sync
elif [ "$#" -eq 3 ] && [ "$1" = --autorun ]; then
  MODE=autorun
  [[ "$2" =~ ^hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}$ ]] || { say "PILOT_ID_INVALID: expected hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN"; finish PILOT_ID_INVALID 2; }
  APPROVAL="$2"
  [[ "$APPROVAL" != hoshigama-imagefirst-d[34]-00000000-* ]] || { say "PILOT_ID_RESERVED: the date 00000000 is the dummy PoC's, never a real run's"; finish PILOT_ID_RESERVED 2; }
  [[ "$3" =~ ^[0-9a-f]{40}$ ]] || { say "PILOT_SHA_INVALID: --autorun <approval id> <40-hex commit of the root-verified admin clone>"; finish PILOT_SHA_INVALID 2; }
  AUTORUN_SHA="$3"
else
  [ "$#" -eq 1 ] || { say "usage: imagefirst-pilot.sh <approval id> | --sync-clone"; finish PILOT_USAGE 2; }
  [[ "$1" =~ ^hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}$ ]] || { say "PILOT_ID_INVALID: expected hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN"; finish PILOT_ID_INVALID 2; }
  APPROVAL="$1"
  [[ "$APPROVAL" != hoshigama-imagefirst-d[34]-00000000-* ]] || { say "PILOT_ID_RESERVED: the date 00000000 is the dummy PoC's, never a real run's"; finish PILOT_ID_RESERVED 2; }
fi

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
TEST_ROOT="${SR_IMAGEFIRST_PILOT_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ]; then
  # The production copy never takes a test hook, and runs only as root.
  [ -z "$TEST_ROOT" ] || { say "PILOT_TEST_HOOK_REFUSED: test hooks are refused in $PROD_CLONE"; finish PILOT_USAGE 2; }
  [ "$(id -u)" = 0 ] || { say "run as root: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-pilot.sh <approval id>"; finish PILOT_USAGE 2; }
  R=""
  WORKER_USER=sr-designgen
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  WORKER_PATH=/usr/local/bin:/usr/bin:/bin
else
  # Any other copy runs only the unit tests' fake WSL (tests/unit/design-agent/imagefirst-worker/pilot.test.ts).
  [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT" ] || { say "run from the root-only clone: sudo bash $PROD_CLONE/scripts/sales-design-worker/imagefirst-pilot.sh <approval id>"; finish PILOT_USAGE 2; }
  R="$TEST_ROOT"
  WORKER_USER="$(id -un)"
  WORKER_PATH="$PATH"
fi
PREFLIGHT="$REPO/scripts/sales-design-worker/imagefirst-pilot-preflight.sh"
DELIVER="$REPO/scripts/sales-design-worker/imagefirst-deliver-review.sh"
STATE="$R/var/lib/sr-imagefirst-autostart"
CYCLE_STATE="$R/var/lib/sr-design-cycle"
WORKER_HOME="$R/home/sr-designgen"
CLONE="$WORKER_HOME/imagefirst/second-root"
NPM_HASH_FILE=.local/state/sr-design-worker/imagefirst-autostart.npm-lock.sha256

in_clone() { "${AS_WORKER[@]}" "$@" 8>&- 9>&-; }

# The file and every directory above it owned by root and writable by nobody else (as cycle.sh / admin.sh).
# (Verbatim from imagefirst-autostart.sh.)
trusted_path() {
  local p
  p="$(readlink -f "$1")" || return 1
  while :; do
    [ "$(stat -c %u "$p")" = 0 ] || return 1
    [ $(( 0$(stat -c %a "$p") & 022 )) -eq 0 ] || return 1
    [ "$p" = / ] && return 0
    p="$(dirname "$p")"
  done
}
# The production copy: root's admin clone clean, and every script root runs from it trusted (review M1).
if [ -z "$R" ]; then
  for f in "$SELF" "$PREFLIGHT" "$DELIVER"; do
    trusted_path "$f" || { say "PILOT_ADMIN_CLONE_UNTRUSTED: $f must be root's and writable by nobody else, up to /"; finish PILOT_USAGE 2; }
  done
  admin_dirty="$(git -C "$REPO" status --porcelain --untracked-files=normal 2>/dev/null)" || admin_dirty="unreadable"
  [ -z "$admin_dirty" ] || { say "PILOT_ADMIN_CLONE_DIRTY: $REPO has changes (check it out detached at the approved commit first)"; finish PILOT_USAGE 2; }
  say "admin clone $REPO at $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown) (clean)"
fi
# --autorun only inside sr-imagefirst-autorun.service: this process's own cgroup v2 line, read from the kernel (the test
# world: a file under its root). The same line the preflight reads.
if [ "$MODE" = autorun ]; then
  if [ -n "$R" ]; then own_cgroup="$(cat -- "$R/proc/self/cgroup" 2>/dev/null || true)"; else own_cgroup="$(cat /proc/self/cgroup 2>/dev/null || true)"; fi
  [[ $'\n'"$own_cgroup"$'\n' == *$'\n'"0::/system.slice/sr-imagefirst-autorun.service"$'\n'* ]] ||
    { say "PILOT_AUTORUN_REFUSED: --autorun runs only inside sr-imagefirst-autorun.service (imagefirst-autorun.sh)"; finish PILOT_AUTORUN_REFUSED 2; }
  # the commit is root's: the root-owned admin clone (the test world: its stand-in) must be clean and at exactly that
  # commit, and its configured origin URL (root's, never the worker clone's .git/config) is the one fetched from
  if [ -n "$R" ]; then ADMIN_GIT="$R$PROD_CLONE"; else ADMIN_GIT="$REPO"; fi
  admin_head="$(git -C "$ADMIN_GIT" rev-parse HEAD 2>/dev/null)" || admin_head=""
  admin_dirty="$(git -C "$ADMIN_GIT" --no-optional-locks status --porcelain --untracked-files=normal 2>/dev/null)" || admin_dirty="unreadable"
  [ "$admin_head" = "$AUTORUN_SHA" ] && [ -z "$admin_dirty" ] ||
    { say "PILOT_AUTORUN_SHA_MISMATCH: the admin clone is not clean at $AUTORUN_SHA"; finish PILOT_AUTORUN_SHA_MISMATCH 2; }
  ORIGIN_URL="$(git -C "$ADMIN_GIT" config --get remote.origin.url 2>/dev/null)" || ORIGIN_URL=""
  [[ "$ORIGIN_URL" =~ ^[A-Za-z0-9._:/@+-]+$ ]] || { say "PILOT_AUTORUN_ORIGIN_INVALID: the admin clone's origin URL is missing or unusual"; finish PILOT_AUTORUN_ORIGIN_INVALID 2; }
fi

# Busy unless both units are stopped and the worker user runs nothing. Fail closed: an error or any other state is busy.
# (Verbatim from imagefirst-autostart.sh; pilot.test.ts pins that the two stay identical.)
BUSY_WHY=""
busy() {
  local unit st pg_real=0 pg_eff=0
  for unit in sr-jail-claude.service sr-design-cycle.service; do
    st="$(systemctl show -p ActiveState --value "$unit" 2>/dev/null)" || st=error
    if ! [[ "$st" =~ ^(inactive|failed)$ ]]; then BUSY_WHY="$unit is ${st:-unknown}"; return 0; fi
  done
  # as cycle.sh's DEV-187 grant: the jailed Claude must also be disabled or masked (sr-jail-net's ExecStartPost starts
  # it again while it is enabled). Any other answer, an error or no answer (not-found included) is busy.
  st="$(systemctl is-enabled sr-jail-claude.service 2>/dev/null)" || true
  if ! [[ "$st" =~ ^(disabled|masked)$ ]]; then BUSY_WHY="sr-jail-claude.service is not disabled or masked (${st:-no answer})"; return 0; fi
  # pgrep: 0 = a process (busy), 1 = none, 2+ = error (cannot tell: busy). Only "1" from both checks is idle.
  pgrep -U "$WORKER_USER" >/dev/null 2>&1 || pg_real=$?
  pgrep -u "$WORKER_USER" >/dev/null 2>&1 || pg_eff=$?
  if [ "$pg_real" -ne 1 ] || [ "$pg_eff" -ne 1 ]; then BUSY_WHY="a process of $WORKER_USER is running (or pgrep could not tell)"; return 0; fi
  return 1
}
# busy() at a step boundary: before the worker started it ends the pilot as busy (12); after it, as stopped (1).
idle_or_stop() {
  if busy; then
    say "busy: $BUSY_WHY ($1)"
    if [ "$PHASE" = after_claim ]; then finish PILOT_BUSY 1; fi
    finish PILOT_BUSY 12
  fi
}

# The summary (step 7): read by the worker user from its own files, every value checked against a fixed shape. Two kinds of
# line (review L1 / L2): "S" = shareable (codes, counts, sizes, yes/no only: what may go to Issue #302), "L" = local only
# (SHA-256s of the receipt, the pictures, the bundle and the pins: keep them on the machine). No path is printed. Root
# parses none of the worker's files.
SUMMARY_PY='
import hashlib, json, os, re, struct, sys
aid, receipt_path = sys.argv[1], sys.argv[2]
HEX = re.compile(r"[0-9a-f]{64}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
WORD = re.compile(r"[A-Za-z0-9_.:-]{1,64}\Z")
AID = re.compile(r"hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}\Z")
home = os.path.realpath(os.path.expanduser("~"))
runs = os.path.join(home, "sr-runs")
state = os.path.join(home, ".local", "state", "sr-design-worker", "imagefirst-worker")
inbox = os.path.join(runs, "review-inbox")
def share(k, v): print("S " + k + "=" + v)
def local(k, v): print("L " + k + "=" + v)
def s(v, rx): return v if isinstance(v, str) and rx.match(v) else "invalid"
def n(v): return str(v) if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 10 ** 9 else "invalid"
def d(v): return v if isinstance(v, dict) else {}
def code(v): return s(v, WORD) if v is not None else "none"
def load(p):
    try:
        if os.path.islink(p) or not os.path.isfile(p): return None
        with open(p, "rb") as f: b = f.read(1 << 20)
        j = json.loads(b)
        return (b, j) if isinstance(j, dict) else None
    except Exception:
        return None
def under(p, root):
    p = os.path.realpath(p)
    return p.startswith(root + os.sep)
r = load(receipt_path) if under(receipt_path, runs) else None
bundle = None
if r:
    b, j = r
    share("approval_id", s(j.get("approval_id"), AID))
    share("commit", s(j.get("commit"), COMMIT) + " (the approved develop commit)")
    share("receipt", "status=" + code(j.get("status")) + " stop_code=" + code(j.get("stop_code")))
    c = d(j.get("counts"))
    share("images", "pc=" + n(c.get("pc")) + " sp=" + n(c.get("sp")) + " total=" + n(c.get("total")) + " verified=" + str(j.get("verified") is True).lower())
    local("receipt_sha256", hashlib.sha256(b).hexdigest())
    local("packet_sha256", s(j.get("packet_sha256"), HEX))
    local("plan_sha256", s(j.get("plan_sha256"), HEX))
    local("prompt_sha256", s(j.get("prompt_sha256"), HEX))
    run_dir = j.get("run_dir") if isinstance(j.get("run_dir"), str) and under(j.get("run_dir"), runs) else None
    for im in j.get("images") if isinstance(j.get("images"), list) else []:
        im = d(im)
        f = im.get("file")
        if not isinstance(f, str) or not re.match(r"parts/(pc|sp)-[0-9]\.png\Z", f):
            share("image", "invalid"); continue
        size, match = "unreadable", "no"
        try:
            p = os.path.join(run_dir, f) if run_dir else None
            if p and not os.path.islink(p):
                with open(p, "rb") as fh: data = fh.read(64 * 1024 * 1024)
                if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
                    w, h = struct.unpack(">II", data[16:24]); size = str(w) + "x" + str(h)
                match = "yes" if hashlib.sha256(data).hexdigest() == im.get("sha256") else "no"
        except Exception:
            pass
        share("image", f[6:-4] + " size=" + size + " sha_matched=" + match)
        local("image_sha256", f[6:-4] + " " + s(im.get("sha256"), HEX))
else:
    share("receipt", "unreadable")
job = load(os.path.join(state, "deliveries", aid + ".json"))
if job:
    bundle = job[1].get("bundle_sha256")
    share("delivery", "state=" + code(job[1].get("state")))
    local("bundle_sha256", s(bundle, HEX))
else:
    share("delivery", "none")
a = load(os.path.join(inbox, "audits", aid, "audit.json"))
if a:
    j = a[1]
    bnd, der, vps = d(j.get("binding")), d(j.get("derived")), d(j.get("viewports"))
    share("audit", "status=" + code(j.get("status")) + " stop_code=" + code(j.get("stop_code")) + " rubric=" + s(bnd.get("rubric_version"), WORD) + " bundle_sha_matched=" + ("yes" if isinstance(bundle, str) and bnd.get("bundle_sha256") == bundle else "no"))
    local("rubric_sha256", s(bnd.get("rubric_sha256"), HEX))
    for vp in ("desktop_1440", "mobile_390"):
        dv = d(der.get(vp))
        sc = d(d(vps.get(vp)).get("scores"))
        parts = [k + "=" + n(d(v).get("score")) for k, v in sorted(sc.items()) if isinstance(k, str) and WORD.match(k)]
        hits = dv.get("hard_fail_hits")
        share("scores_" + vp, " ".join(["total=" + n(dv.get("total")), "lowest=" + n(dv.get("lowest")), "verdict=" + s(dv.get("verdict"), WORD), "hard_fails=" + (str(len(hits)) if isinstance(hits, list) else "invalid")] + parts))
    share("verdict", s(der.get("verdict"), WORD) + " (advisory only; the owner decides)")
else:
    share("audit", "none")
'
SUMMARIZED=0
summary() {
  [ "$SUMMARIZED" = 0 ] || return 0
  SUMMARIZED=1
  say "share: approval=$APPROVAL codex_runs=1 (one worker run; never retried) delivery=$DELIVERY"
  [ -n "$RECEIPT" ] || { say "share: receipt=none (the worker reported no receipt)"; return 0; }
  in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" python3 -I -c "$SUMMARY_PY" "$APPROVAL" "$RECEIPT" 2>/dev/null |
    tr -d '\000-\010\013-\037' | cut -c1-400 | sed -n -e 's/^S /imagefirst-pilot: share: /p' -e 's/^L /imagefirst-pilot: local-only: /p' || say "share: summary=unreadable"
}
# A worker, hand-off or audit JSON line with its local places (every "...dir" key and "receipt") and the bundle SHA replaced by <local> (review L2, round 2 L1).
redact() { sed -E -e 's/"([a-z_]*dir|receipt)":"[^"]*"/"\1":"<local>"/g' -e 's/"(bundle_sha256)":"[0-9a-f]{64}"/"\1":"<local>"/g'; }

# ---------------------------------------------------------------- 1. the locks (no automatic start poll, no design cycle meanwhile)
mkdir -p "$STATE"
chmod 700 "$STATE"
take_locks() {
  exec 9>"$STATE/autostart.lock"
  flock -n 9 || return 1
  if [ -d "$CYCLE_STATE" ] && [ ! -L "$CYCLE_STATE" ]; then
    exec 8>>"$CYCLE_STATE/cycle.lock"
    flock -n 8 || return 1
  fi
  return 0
}
release_locks() { exec 9>&- 8>&-; }
take_locks || { say "busy: an automatic start poll or a design cycle holds its lock"; finish PILOT_BUSY 12; }
WORK="$(mktemp -d "$STATE/pilot.XXXXXX")"

worker_uid="$(id -u "$WORKER_USER")" && worker_gid="$(id -g "$WORKER_USER")" || { say "PILOT_STOP_NO_USER: $WORKER_USER"; finish PILOT_STOP_NO_USER 20; }
AS_WORKER=(setpriv --reuid="$worker_uid" --regid="$worker_gid" --init-groups --reset-env --no-new-privs -- env -i HOME="$WORKER_HOME" PATH="$WORKER_PATH" LANG=C.UTF-8)
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
  if [ -n "${!name+x}" ]; then AS_WORKER+=("$name=${!name}"); fi
done
# --autorun: never the reused clone (its index, objects, ignored files and the worker's own git config may have been planted
# while Remote Control ran): a fresh clone at a root-chosen new path, and every git of the worker without the user's or
# the system's git config (the worker's own git, started by node, gets the same variables: worker/env.ts passes them on)
if [ "$MODE" = autorun ]; then
  AS_WORKER+=(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1)
  AS_HOME=("${AS_WORKER[@]}" bash -c 'cd -- "$1" || exit 97; shift; exec "$@"' _ "$WORKER_HOME")
  FRESH="$WORKER_HOME/imagefirst/autorun-$APPROVAL-$(date -u +%Y%m%dT%H%M%SZ)"
  CLONE="$FRESH"
fi
AS_WORKER+=(bash -c 'cd -- "$1" || exit 97; shift; exec "$@"' _ "$CLONE")
[ "$MODE" = autorun ] || [ -d "$CLONE" ] || { say "PILOT_STOP_NO_CLONE: $CLONE is missing"; finish PILOT_STOP_NO_CLONE 20; }

# ---------------------------------------------------------------- --sync-clone: the automatic start's step 5, nothing else
if [ "$MODE" = sync ]; then
  idle_or_stop "before the clone is updated"
  in_clone timeout --kill-after="$KILL_AFTER" "$FETCH_TIMEOUT" git fetch --quiet --no-tags origin "+refs/heads/develop:refs/remotes/origin/develop" >/dev/null 2>&1 ||
    { say "git fetch failed"; finish PILOT_SYNC_FETCH 20; }
  dirty="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git status --porcelain --untracked-files=all 2>/dev/null)" ||
    { say "git status failed"; finish PILOT_SYNC_GIT 20; }
  [ -z "$dirty" ] || { say "the clone has changes: stopped (nothing is cleaned automatically)"; finish PILOT_SYNC_TREE_DIRTY 20; }
  in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git merge-base --is-ancestor HEAD origin/develop >/dev/null 2>&1 ||
    { say "HEAD is not an ancestor of origin/develop: stopped"; finish PILOT_SYNC_NOT_FAST_FORWARD 20; }
  in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git checkout --quiet --detach origin/develop >/dev/null 2>&1 ||
    { say "git checkout failed"; finish PILOT_SYNC_GIT 20; }
  head="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse HEAD 2>/dev/null)" || head=""
  base="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" git rev-parse origin/develop 2>/dev/null)" || base=""
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] && [ "$head" = "$base" ] || { say "HEAD is not origin/develop after the checkout"; finish PILOT_SYNC_GIT 20; }
  in_clone bash -c 'h="$(sha256sum package-lock.json | cut -d" " -f1)" || exit 1
  [ -f node_modules/tsx/package.json ] && [ "$(cat "$HOME/$1" 2>/dev/null || true)" = "$h" ] && exit 0
  timeout --kill-after="$2" "$3" npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || exit 1
  mkdir -p "$(dirname "$HOME/$1")" && printf "%s\n" "$h" >"$HOME/$1"' _ "$NPM_HASH_FILE" "$KILL_AFTER" "$NPM_TIMEOUT" ||
    { say "npm ci failed"; finish PILOT_SYNC_NPM 20; }
  say "the worker's clone is on origin/develop $head"
  finish PILOT_SYNCED 0
fi

# ---------------------------------------------------------------- --autorun: root's used/<approval id> not there yet
if [ "$MODE" = autorun ] && { [ -e "$STATE/used/$APPROVAL" ] || [ -L "$STATE/used/$APPROVAL" ]; }; then
  say "the automatic run's marker for $APPROVAL was already used: nothing is started"
  finish PILOT_MARKER_USED 2
fi

# ---------------------------------------------------------------- --autorun: a fresh clone at root's commit
# While Remote Control ran, the jailed Claude (the same user) could plant state in the reused clone (its .git config,
# hooks, index flags such as skip-worktree, forged objects or alternates, ignored files, node_modules) and in the worker's
# home (~/.gitconfig and its includes, ~/.config/git/config and attributes). So the automatic run never uses the reused
# clone: with Remote Control stopped and no process of the worker user left, as the worker, a NEW directory at a path root
# chose (~/imagefirst/autorun-<id>-<UTC>, created with mkdir: never a link, never one that exists), `git clone --no-local
# --no-checkout` from root's origin URL (every object received and checked by git, nothing shared), origin/develop must be
# exactly root's commit, `checkout --detach` it, HEAD = it, and `git status --ignored` prints nothing; then npm ci (no user or
# global npm config). Every git runs with GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 (in AS_WORKER) and the -c settings
# below. Old fresh clones: only real directories named autorun-hoshigama-imagefirst-* directly under ~/imagefirst; the
# newest one is kept (for a look afterwards), the older ones are removed, by the worker, while this run holds the locks
# with Remote Control stopped (no run can be using them). Nothing else is ever removed. The worker run, the re-send and
# the audit below all use the fresh clone; the manual pilot keeps ~/imagefirst/second-root.
if [ "$MODE" = autorun ]; then
  idle_or_stop "before the fresh clone"
  GH=(git -c core.attributesFile=/dev/null -c core.excludesFile=/dev/null -c core.hooksPath=/dev/null -c core.fsmonitor=false -c credential.helper= -c protocol.ext.allow=never -c core.sshCommand=ssh)
  "${AS_HOME[@]}" bash -c 'base="$HOME/imagefirst"; p="$1"
    [ -d "$base" ] && [ ! -L "$base" ] || exit 3
    case "$p" in "$base"/autorun-hoshigama-imagefirst-d[34]-*) ;; *) exit 3 ;; esac
    find "$base" -mindepth 1 -maxdepth 1 -type d -name "autorun-hoshigama-imagefirst-d[34]-*" -printf "%T@ %p\n" | sort -rn | tail -n +2 | cut -d" " -f2- |
      while IFS= read -r d; do rm -rf -- "$d"; done
    if [ -e "$p" ] || [ -L "$p" ]; then exit 4; fi
    mkdir -m 700 -- "$p"' _ "$FRESH" 8>&- 9>&- ||
    { say "the fresh clone's directory could not be made (no ~/imagefirst directory, a link, or it exists)"; finish PILOT_AUTORUN_CLONE 20; }
  "${AS_HOME[@]}" timeout --kill-after="$KILL_AFTER" "$CLONE_TIMEOUT" "${GH[@]}" clone --quiet --no-local --no-checkout --no-tags --single-branch --branch develop -- "$ORIGIN_URL" "$FRESH" >/dev/null 2>&1 8>&- 9>&- ||
    { say "git clone from root's origin URL failed"; finish PILOT_AUTORUN_FETCH 20; }
  base="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" rev-parse refs/remotes/origin/develop 2>/dev/null)" || base=""
  [ "$base" = "$AUTORUN_SHA" ] || { say "origin/develop (${base:-?}) is not root's verified commit $AUTORUN_SHA: stopped"; finish PILOT_AUTORUN_DEVELOP_MOVED 20; }
  in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" checkout --quiet --detach "$AUTORUN_SHA" >/dev/null 2>&1 ||
    { say "git checkout failed"; finish PILOT_AUTORUN_CLONE 20; }
  head="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" rev-parse HEAD 2>/dev/null)" || head=""
  [ "$head" = "$AUTORUN_SHA" ] || { say "HEAD is not $AUTORUN_SHA after the checkout"; finish PILOT_AUTORUN_CLONE 20; }
  extra="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" status --porcelain --ignored --untracked-files=all 2>/dev/null)" ||
    { say "git status failed"; finish PILOT_AUTORUN_CLONE 20; }
  [ -z "$extra" ] || { say "the fresh clone is not exactly the commit (changed, untracked or ignored files): stopped"; finish PILOT_AUTORUN_TREE_DIRTY 20; }
  in_clone env npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null timeout --kill-after="$KILL_AFTER" "$NPM_TIMEOUT" npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 ||
    { say "npm ci failed"; finish PILOT_AUTORUN_NPM 20; }
  # where the preflight finds it (root's own file in root's 0700 state; the preflight checks its form)
  printf '%s\n' "$FRESH" >"$STATE/autorun-clone"
  say "a fresh clone at root's verified commit $AUTORUN_SHA (no user git config, status --ignored empty, npm ci)"
fi

# ---------------------------------------------------------------- 1. the preflight (read only; every row PASS)
set +e
bash "$PREFLIGHT" "$APPROVAL" >"$WORK/preflight" 2>&1 8>&- 9>&-
frc=$?
set -e
tr -d '\000-\010\013-\037' <"$WORK/preflight" | cut -c1-400
fline="$(tail -n 1 "$WORK/preflight" | tr -d '\000-\037')"
if [ "$frc" -ne 0 ] || [[ "$fline" != "IMAGEFIRST_PILOT_PREFLIGHT PASS approval=$APPROVAL failed=0 exit=0" ]]; then
  say "the preflight did not pass: nothing was started or spent"
  finish PILOT_PREFLIGHT_FAILED 20
fi

# ---------------------------------------------------------------- 2. the ONE generation: the existing worker, once
idle_or_stop "before the worker"
# --autorun: root's marker for this id is used up BEFORE the worker starts (atomic mkdir, never removed; the worker user can
# neither create nor remove it), as the automatic start's step 7: whatever happens next, the automatic run never starts the
# worker again for this id (a stop before the worker starts still ends as PILOT_STOP_SIGNAL, the marker then used)
if [ "$MODE" = autorun ]; then
  mkdir -p -m 0700 "$STATE/used"
  if ! mkdir -m 0700 "$STATE/used/$APPROVAL" 2>/dev/null; then
    say "the automatic run's marker for $APPROVAL was already used: nothing is started"
    finish PILOT_MARKER_USED 2
  fi
  printf 'approval_id=%s\nused_by=imagefirst-autorun\nused_at=%s\n' "$APPROVAL" "$(date +%s)" >"$STATE/used/$APPROVAL/used"
fi
PHASE=after_claim
say "starting the worker once (approval $APPROVAL): one claim, one generation, never retried"
# a stop that came during the last checks or since PHASE changed: nothing has started yet, so end as a stop before the
# worker (round 2 review L3; the post-fork forwarding below covers only the fork itself)
if [ "$INTERRUPTED" = 1 ]; then PHASE=before_claim; finish PILOT_STOP_SIGNAL 40; fi
set +e
# node with the tsx loader is timeout's direct child, and timeout --foreground signals only that child: one stop is one
# SIGTERM to the worker (the tsx CLI would relay it again within 30 ms, and the worker would take it as a hard stop).
# The worker starts the entry in its own process group and stops it itself.
"${AS_WORKER[@]}" timeout --foreground --kill-after="$WORKER_KILL_AFTER" "$WORKER_TIMEOUT" env "$GRANT_ENV=$APPROVAL" \
  node --import tsx scripts/sales-design-worker/imagefirst-worker.ts >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &
WPID=$!
# a stop that came between PHASE=after_claim and here is passed on now (review M2)
if [ "$INTERRUPTED" = 1 ]; then kill -TERM "$WPID" 2>/dev/null || true; fi
wait "$WPID"
rc=$?
# a stop signal interrupts wait (rc > 128) while the worker still writes its receipt: wait for it to end
while [ "$rc" -gt 128 ] && kill -0 "$WPID" 2>/dev/null; do
  wait "$WPID"
  rc=$?
done
set -e
WPID=""
line="$(tail -n 1 "$WORK/out" | tr -d '\000-\037' | cut -c1-2000)"
say "worker: $(printf '%s' "${line:-<no line>}" | redact)"
# the receipt the worker reported, only in its own place (<worker home>/sr-runs/<approval>-<UTC>.receipt.json)
if [[ "$line" =~ \"receipt\":\"([^\"]+)\" ]]; then
  cand="${BASH_REMATCH[1]}"
  if [[ "$cand" =~ ^"$WORKER_HOME"/sr-runs/"$APPROVAL"-[0-9]{8}T[0-9]{6}Z\.receipt\.json$ ]]; then RECEIPT="$cand"; fi
fi
if [ "$rc" -ne 0 ]; then
  tail -n 20 "$WORK/err" | tr -d '\000-\010\013-\037' | cut -c1-300 | sed 's/^/imagefirst-pilot: local-only: worker stderr: /'
fi
if [ "$INTERRUPTED" = 1 ]; then finish PILOT_INTERRUPTED 1; fi
case "$rc" in
  0) [[ "$line" == *'"status":"succeeded"'* ]] && [[ "$line" == *'"invoked":true'* ]] || { say "the worker did not run the job (no_job / locked): nothing generated"; finish PILOT_WORKER_NOT_RUN 2; } ;;
  2) finish PILOT_WORKER_REFUSED 2 ;;
  124 | 137) finish PILOT_WORKER_TIMEOUT 1 ;;
  *) finish PILOT_WORKER_STOPPED 1 ;;
esac
[ -n "$RECEIPT" ] || { say "the worker reported no receipt in its place"; finish PILOT_RECEIPT_MISSING 1; }

# ---------------------------------------------------------------- 3. the jail must not have started meanwhile
stop_if_interrupted
idle_or_stop "after the worker"

# ---------------------------------------------------------------- 4. the delivery: the worker's own hand-off, else ONE re-send
review="$(grep -a '^imagefirst-worker: review ' "$WORK/err" | tail -n 1 | tr -d '\000-\037' | cut -c1-400)" || review=""
say "hand-off: $(printf '%s' "${review:-<no line>}" | redact)"
if [[ "$review" == *'"status":"delivered"'* ]] || [[ "$review" == *'"status":"duplicate"'* ]]; then
  DELIVERY=delivered
elif [ "$MODE" = autorun ]; then
  # --autorun: the same re-send (the worker's --deliver-review: the SAME sealed bundle, no generation), but from the fresh
  # clone, as the worker, with the locks kept (the wrapper would use the reused clone)
  say "the hand-off did not deliver: re-sending the SAME sealed bundle once from the fresh clone (--deliver-review; no generation)"
  idle_or_stop "before the re-send"
  set +e
  "${AS_WORKER[@]}" timeout --foreground --kill-after="$KILL_AFTER" "$DRY_RUN_TIMEOUT" node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --deliver-review "$APPROVAL" >"$WORK/deliver" 2>/dev/null 8>&- 9>&-
  drc=$?
  set -e
  dline="$(tail -n 1 "$WORK/deliver" | tr -d '\000-\037' | cut -c1-2000)"
  say "re-send: $(printf '%s' "${dline:-<no line>}" | redact)"
  stop_if_interrupted
  if [ "$drc" -eq 0 ] && { [[ "$dline" == '{"status":"delivered"'* ]] || [[ "$dline" == '{"status":"duplicate"'* ]]; }; then
    DELIVERY=delivered_by_resend
  else
    DELIVERY=not_delivered
    say "not delivered: no audit (the bundle stays sealed; re-send it later with imagefirst-deliver-review.sh)"
    finish PILOT_NOT_DELIVERED 1
  fi
else
  say "the hand-off did not deliver: re-sending the SAME sealed bundle once (imagefirst-deliver-review.sh; no generation)"
  release_locks
  set +e
  env ${R:+"SR_IMAGEFIRST_DELIVER_TEST_ROOT=$R"} bash "$DELIVER" "$APPROVAL" >"$WORK/deliver" 2>&1
  drc=$?
  set -e
  tr -d '\000-\010\013-\037' <"$WORK/deliver" | redact | cut -c1-400
  dline="$(tail -n 1 "$WORK/deliver" | tr -d '\000-\037')"
  take_locks || { say "busy: the locks were taken while the re-send ran"; finish PILOT_BUSY 1; }
  stop_if_interrupted
  if [ "$drc" -eq 0 ] && [[ "$dline" == "IMAGEFIRST_DELIVER_REVIEW DELIVER_DONE approval=$APPROVAL exit=0" ]]; then
    DELIVERY=delivered_by_resend
  else
    DELIVERY=not_delivered
    say "not delivered: no audit (the bundle stays sealed; re-send it later with imagefirst-deliver-review.sh)"
    finish PILOT_NOT_DELIVERED 1
  fi
fi

# ---------------------------------------------------------------- 5. the audit dry run (verify and plan; the size caps)
stop_if_interrupted
idle_or_stop "before the audit dry run"
# a stop during the idle check: the dry run is not started (round 2 review L3)
stop_if_interrupted
set +e
"${AS_WORKER[@]}" timeout --foreground --kill-after="$KILL_AFTER" "$DRY_RUN_TIMEOUT" \
  node --import tsx scripts/sales-design-worker/imagefirst-audit.ts "$APPROVAL" --dry-run >"$WORK/dry" 2>/dev/null 8>&- 9>&-
yrc=$?
set -e
yline="$(tail -n 1 "$WORK/dry" | tr -d '\000-\037' | cut -c1-2000)"
say "audit dry run: $(printf '%s' "${yline:-<no line>}" | redact)"
if [ "$yrc" -ne 0 ] || [[ "$yline" != *'"status":"planned"'* ]]; then
  say "the dry run did not plan (over the caps, not delivered, jail, ...): no audit"
  finish PILOT_AUDIT_DRY_RUN_FAILED 1
fi

# ---------------------------------------------------------------- 6. the ONE audit
stop_if_interrupted
idle_or_stop "before the audit"
say "starting the audit once (approval $APPROVAL)"
# a stop during the idle check: the audit is not started (round 2 review L3)
stop_if_interrupted
set +e
"${AS_WORKER[@]}" timeout --foreground --kill-after="$AUDIT_KILL_AFTER" "$AUDIT_TIMEOUT" \
  node --import tsx scripts/sales-design-worker/imagefirst-audit.ts "$APPROVAL" >"$WORK/audit" 2>/dev/null 8>&- 9>&- &
WPID=$!
if [ "$INTERRUPTED" = 1 ]; then kill -TERM "$WPID" 2>/dev/null || true; fi
wait "$WPID"
rc=$?
while [ "$rc" -gt 128 ] && kill -0 "$WPID" 2>/dev/null; do
  wait "$WPID"
  rc=$?
done
set -e
WPID=""
AUDIT_LINE="$(tail -n 1 "$WORK/audit" | tr -d '\000-\037' | cut -c1-2000)"
say "audit: $(printf '%s' "${AUDIT_LINE:-<no line>}" | redact)"
if [ "$INTERRUPTED" = 1 ]; then finish PILOT_INTERRUPTED 1; fi
if [ "$rc" -ne 0 ] || [[ "$AUDIT_LINE" != *'"status":"completed"'* ]]; then
  say "the audit did not complete (it is not retried)"
  finish PILOT_AUDIT_STOPPED 1
fi

# ---------------------------------------------------------------- 7. done
finish PILOT_DONE 0
}
