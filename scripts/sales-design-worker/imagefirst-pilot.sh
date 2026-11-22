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
# --autorun <approval id> <commit> <origin URL> (docs/operations/imagefirst-autorun.md): the same run, started only by
#   imagefirst-autorun.sh inside sr-imagefirst-autorun.service (refused anywhere else: this process's own cgroup, read from
#   the kernel, must be that service's; PILOT_AUTORUN_REFUSED). The differences: <commit> is the one root chose (the
#   owner-pinned worker_commit of the standing policy, or without one the admin clone's HEAD = develop), fetched by its id
#   (no branch tip; the origin no longer having it: PILOT_STANDING_COMMIT_UNAVAILABLE, before the claim);
#   root's used/<approval id> must not exist (PILOT_MARKER_USED); the reused clone is never used: a fresh clone at a new
#   root-chosen path, from <origin URL> (root's: the standing policy's or the admin clone's), <commit> checked out, with no
#   user or system git config, status --ignored empty, then npm ci; the preflight, the worker run, the re-send and the audit
#   use it (the steps below); and right before the worker starts,
#   used/<approval id> is created (atomic mkdir in root's 0700 state, never
#   removed, as the automatic start's step 7), so the automatic run never starts the worker twice for one id. The
#   preflight sees the same cgroup and accepts exactly that service and its timer in its timers row. Every other step,
#   check, line and code is the manual run's.
# --autorun-request <request id> <commit> <origin URL> <request SHA-256> (DEV-303, the owner's standing pre-authorization):
#   the same as --autorun for a request root picked up: root's own copy (/var/lib/sr-imagefirst-autostart/requests/<id>.json)
#   must have exactly that SHA-256; the worker (as the worker) copies it into the run's private <fresh clone>.request/<id>.json
#   (0600) before the preflight; the preflight runs with --request <id>; the worker runs ONCE with
#   --request <id> --request-sha256 <hex> (and SR_IMAGEFIRST_REQUEST_FILE naming that private copy), no approval grant.
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
# --autorun: root's reviewed Codex config (scripts/sales-design-worker/codex-config.toml, installed by the owner); the
# run's CODEX_HOME holds only a copy of it. Its SHA-256 (the same constant in imagefirst-pilot-preflight.sh; a test pins
# both to the repository's file)
CODEX_CONFIG_SHA256=697ade397a322574f3b9693811ad257e6a6f1bb511bbed37626c849c7a53b9dd
CFG_BUILT=0
CFG=""
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
  # --autorun: the refreshed sign-in files back to ~/.codex and ~/.claude, then the run's config dir removed (as the worker)
  [ "$CFG_BUILT" != 1 ] || copy_back || true
  # --autorun: the same last line, also as root's result file in root's 0700 state (a temporary file, then a rename), which
  # the automatic run reads after it has reaped this process (stdout and the exit status through timeout(1) are not a
  # reliable hand-off: some timeout(1)s exit 143 after passing on a stop, whatever this script returns)
  if [ "$MODE" = autorun ] && [ -n "${STATE:-}" ] && [ -d "$STATE" ]; then
    printf 'IMAGEFIRST_PILOT %s phase=%s approval=%s exit=%s\n' "$code" "$PHASE" "$APPROVAL" "$rc" >"$STATE/.autorun-result.$$" 2>/dev/null &&
      mv -f -T -- "$STATE/.autorun-result.$$" "$STATE/autorun-result" 2>/dev/null || true
  fi
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
REQUEST=0
REQUEST_SHA=""
ORIGIN_URL=""
if [ "$#" -eq 1 ] && [ "$1" = --sync-clone ]; then
  MODE=sync
elif [ "$#" -eq 4 ] && [ "$1" = --autorun ]; then
  MODE=autorun
  [[ "$2" =~ ^hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}$ ]] || { say "PILOT_ID_INVALID: expected hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN"; finish PILOT_ID_INVALID 2; }
  APPROVAL="$2"
  [[ "$APPROVAL" != hoshigama-imagefirst-d[34]-00000000-* ]] || { say "PILOT_ID_RESERVED: the date 00000000 is the dummy PoC's, never a real run's"; finish PILOT_ID_RESERVED 2; }
  [[ "$3" =~ ^[0-9a-f]{40}$ ]] || { say "PILOT_SHA_INVALID: --autorun <approval id> <40-hex commit root pinned> <origin URL>"; finish PILOT_SHA_INVALID 2; }
  AUTORUN_SHA="$3"
  ORIGIN_URL="$4"
elif [ "$#" -eq 5 ] && [ "$1" = --autorun-request ]; then
  MODE=autorun
  REQUEST=1
  [[ "$2" =~ ^req-[a-z0-9][a-z0-9-]{2,58}$ ]] || { say "PILOT_ID_INVALID: a request id is ^req-[a-z0-9][a-z0-9-]{2,58}\$"; finish PILOT_ID_INVALID 2; }
  APPROVAL="$2"
  [[ "$3" =~ ^[0-9a-f]{40}$ ]] || { say "PILOT_SHA_INVALID: --autorun-request <request id> <40-hex commit root pinned> <origin URL> <request SHA-256>"; finish PILOT_SHA_INVALID 2; }
  AUTORUN_SHA="$3"
  ORIGIN_URL="$4"
  [[ "$5" =~ ^[0-9a-f]{64}$ ]] || { say "PILOT_REQUEST_SHA_INVALID: the request's SHA-256 is 64 hex"; finish PILOT_REQUEST_SHA_INVALID 2; }
  REQUEST_SHA="$5"
else
  [ "$#" -eq 1 ] || { say "usage: imagefirst-pilot.sh <approval id> | --sync-clone"; finish PILOT_USAGE 2; }
  [[ "$1" =~ ^hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}$ ]] || { say "PILOT_ID_INVALID: expected hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN"; finish PILOT_ID_INVALID 2; }
  APPROVAL="$1"
  [[ "$APPROVAL" != hoshigama-imagefirst-d[34]-00000000-* ]] || { say "PILOT_ID_RESERVED: the date 00000000 is the dummy PoC's, never a real run's"; finish PILOT_ID_RESERVED 2; }
fi

# ---------------------------------------------------------------- where things are
REPO="$(dirname "$(dirname "$(dirname "$SELF")")")"
PROD_CLONE=/root/sr-capture-admin
# the owner's installed copy (imagefirst-autorun-setup.sh apply: root's, writable by nobody else) is a production copy too;
# the automatic run starts only that one
INSTALL_DIR=/usr/local/lib/sr-imagefirst
TEST_ROOT="${SR_IMAGEFIRST_PILOT_TEST_ROOT:-}"
if [ "$REPO" = "$PROD_CLONE" ] || [ "$REPO" = "$INSTALL_DIR" ]; then
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
CODEX_CONFIG="$R/etc/sr-design-worker/codex-config.toml"
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
# The production copy: every script root runs from it trusted (review M1); run from the admin clone (the manual pilot),
# that clone clean too. The automatic run uses only the installed copy.
if [ -z "$R" ]; then
  for f in "$SELF" "$PREFLIGHT" "$DELIVER"; do
    trusted_path "$f" || { say "PILOT_ADMIN_CLONE_UNTRUSTED: $f must be root's and writable by nobody else, up to /"; finish PILOT_USAGE 2; }
  done
  if [ "$REPO" = "$PROD_CLONE" ]; then
    [ "$MODE" != autorun ] || { say "PILOT_AUTORUN_REFUSED: the automatic run starts the installed copy $INSTALL_DIR only"; finish PILOT_AUTORUN_REFUSED 2; }
    admin_dirty="$(git -C "$REPO" status --porcelain --untracked-files=normal 2>/dev/null)" || admin_dirty="unreadable"
    [ -z "$admin_dirty" ] || { say "PILOT_ADMIN_CLONE_DIRTY: $REPO has changes (check it out detached at the approved commit first)"; finish PILOT_USAGE 2; }
    say "admin clone $REPO at $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown) (clean)"
  fi
fi
# --autorun only inside sr-imagefirst-autorun.service: this process's own cgroup v2 line, read from the kernel (the test
# world: a file under its root). The same line the preflight reads.
if [ "$MODE" = autorun ]; then
  if [ -n "$R" ]; then own_cgroup="$(cat -- "$R/proc/self/cgroup" 2>/dev/null || true)"; else own_cgroup="$(cat /proc/self/cgroup 2>/dev/null || true)"; fi
  [[ $'\n'"$own_cgroup"$'\n' == *$'\n'"0::/system.slice/sr-imagefirst-autorun.service"$'\n'* ]] ||
    { say "PILOT_AUTORUN_REFUSED: --autorun runs only inside sr-imagefirst-autorun.service (imagefirst-autorun.sh)"; finish PILOT_AUTORUN_REFUSED 2; }
  # the commit and the origin URL are root's (the automatic run pinned them; never the worker clone's .git/config)
  [[ "$ORIGIN_URL" =~ ^[A-Za-z0-9._:/@+][A-Za-z0-9._:/@+-]*$ ]] || { say "PILOT_AUTORUN_ORIGIN_INVALID: the origin URL is missing or unusual"; finish PILOT_AUTORUN_ORIGIN_INVALID 2; }
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
AID = re.compile(r"(hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}|req-[a-z0-9][a-z0-9-]{2,58})\Z")
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
    share("approval_id", s(j.get("approval_id", j.get("request_id")), AID))
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
  # ... and core.attributesFile=/dev/null for every git, the worker's own included (git's GIT_CONFIG_COUNT variables)
  AS_WORKER+=(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.attributesFile GIT_CONFIG_VALUE_0=/dev/null)
  AS_HOME=("${AS_WORKER[@]}" bash -c 'cd -- "$1" || exit 97; shift; exec "$@"' _ "$WORKER_HOME")
  FRESH="$WORKER_HOME/imagefirst/autorun-$APPROVAL-$(date -u +%Y%m%dT%H%M%SZ)"
  CLONE="$FRESH"
  # the run's own model-CLI config dirs (docs/operations/imagefirst-autorun.md, config trust): CODEX_HOME holds only root's
  # reviewed config.toml and a copy of the Codex sign-in; CLAUDE_CONFIG_DIR only a copy of the Claude sign-in. Nothing
  # the jailed Claude can write in ~/.codex or ~/.claude is visible to the CLIs the worker and the audit start
  CFG="$FRESH.cfg"
  AS_WORKER+=(CODEX_HOME="$CFG/codex" CLAUDE_CONFIG_DIR="$CFG/claude")
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
  # Node looks for modules (and package.json "type" / "imports") in every parent directory of the clone and in the global
  # folders: none of them may exist (lstat: links count), here and again after npm ci. NODE_PATH never reaches the worker
  # (env -i; worker/env.ts does not pass it on)
  node_paths_clean() {
    "${AS_HOME[@]}" bash -c 'for p in "$HOME/node_modules" "$HOME/.node_modules" "$HOME/.node_libraries" "$HOME/imagefirst/node_modules" "$HOME/package.json" "$HOME/imagefirst/package.json"; do
        if [ -e "$p" ] || [ -L "$p" ]; then exit 5; fi
      done' 8>&- 9>&-
  }
  node_paths_clean || { say "a node_modules / .node_modules / .node_libraries / package.json is in the worker's home or ~/imagefirst (Node would load it): stopped"; finish PILOT_AUTORUN_NODE_PATHS 20; }
  # After the run (from finish, when every worker process has ended): as the worker, each sign-in copy the CLIs may have
  # refreshed goes back to its own place only when it changed (a temporary file in that directory, then a rename; never
  # through a link: a linked target or directory is left alone), then the run's config dir is removed with the copies
  copy_back() {
    "${AS_HOME[@]}" bash -c 'set -u; umask 077; c="$1"; max=1048576
      [ -d "$c" ] && [ ! -L "$c" ] || exit 0
      back() {
        local s="$c/$1" d="$HOME/$2" dd t
        dd="$(dirname -- "$d")"
        [ -f "$s" ] && [ ! -L "$s" ] && [ "$(stat -c %s -- "$s")" -le "$max" ] || return 0
        [ -d "$dd" ] && [ ! -L "$dd" ] && [ ! -L "$d" ] || return 0
        if [ -f "$d" ] && cmp -s -- "$s" "$d"; then return 0; fi
        t="$(mktemp -- "$dd/.sr-copyback.XXXXXX")" || return 0
        cat -- "$s" >"$t" && chmod 600 -- "$t" && mv -f -T -- "$t" "$d" || rm -f -- "$t"
      }
      back codex/auth.json .codex/auth.json
      back claude/.credentials.json .claude/.credentials.json
      rm -rf -- "$c"' _ "$CFG" 8>&- 9>&-
  }
  # old fresh clones, NUL-safe: only real directories directly under ~/imagefirst whose whole name is a fresh clone's
  # (autorun-<id>-<UTC>); the newest of them is kept, the older ones removed. Any other name is never touched
  "${AS_HOME[@]}" bash -c 'base="$HOME/imagefirst"; p="$1"
    re="^autorun-[a-z0-9][a-z0-9-]{2,62}-[0-9]{8}T[0-9]{6}Z$"
    [ -d "$base" ] && [ ! -L "$base" ] || exit 3
    case "$p" in "$base"/autorun-[a-z0-9]*) ;; *) exit 3 ;; esac
    valid=()
    while IFS= read -r -d "" d; do
      n="${d##*/}"
      if [ "${d%/*}" = "$base" ] && [[ "$n" =~ $re ]] && [ -d "$d" ] && [ ! -L "$d" ]; then valid+=("$(stat -c %Y -- "$d") $n"); fi
    done < <(find "$base" -mindepth 1 -maxdepth 1 -type d -name "autorun-*" -print0)
    if [ "${#valid[@]}" -gt 1 ]; then
      printf "%s\n" "${valid[@]}" | sort -rn | tail -n +2 | while read -r _ n; do
        [[ "$n" =~ $re ]] && [ -d "$base/$n" ] && [ ! -L "$base/$n" ] && rm -rf -- "${base:?}/$n"
      done
    fi
    # a run'"'"'s config dir left by an earlier run that could not end (a SIGKILL skips its copy-back): each sign-in copy that
    # is newer than its own place goes back first (a refreshed OAuth token must not be lost; the same checks as the
    # copy-back: regular files, no link, size), then the dir is removed
    cre="^autorun-[a-z0-9][a-z0-9-]{2,62}-[0-9]{8}T[0-9]{6}Z\\.cfg$"
    qre="^autorun-[a-z0-9][a-z0-9-]{2,62}-[0-9]{8}T[0-9]{6}Z\\.request$"
    back_newer() {
      local s="$1" d="$HOME/$2" dd t
      dd="$(dirname -- "$d")"
      [ -f "$s" ] && [ ! -L "$s" ] && [ "$(stat -c %s -- "$s")" -le 1048576 ] || return 0
      [ -d "$dd" ] && [ ! -L "$dd" ] && [ ! -L "$d" ] || return 0
      [ "$s" -nt "$d" ] || return 0
      if [ -f "$d" ] && cmp -s -- "$s" "$d"; then return 0; fi
      t="$(mktemp -- "$dd/.sr-copyback.XXXXXX")" || return 0
      cat -- "$s" >"$t" && chmod 600 -- "$t" && mv -f -T -- "$t" "$d" || rm -f -- "$t"
    }
    while IFS= read -r -d "" d; do
      n="${d##*/}"
      if [ "${d%/*}" = "$base" ] && [[ "$n" =~ $cre ]] && [ -d "$d" ] && [ ! -L "$d" ]; then
        if [ -d "$d/codex" ] && [ ! -L "$d/codex" ]; then back_newer "$d/codex/auth.json" .codex/auth.json; fi
        if [ -d "$d/claude" ] && [ ! -L "$d/claude" ]; then back_newer "$d/claude/.credentials.json" .claude/.credentials.json; fi
        rm -rf -- "${base:?}/$n"
      fi
    done < <(find "$base" -mindepth 1 -maxdepth 1 -type d -name "autorun-*.cfg" -print0)
    # an earlier run'"'"'s private request copy (a copy of root'"'"'s; root keeps its own): removed
    while IFS= read -r -d "" d; do
      n="${d##*/}"
      if [ "${d%/*}" = "$base" ] && [[ "$n" =~ $qre ]] && [ -d "$d" ] && [ ! -L "$d" ]; then rm -rf -- "${base:?}/$n"; fi
    done < <(find "$base" -mindepth 1 -maxdepth 1 -type d -name "autorun-*.request" -print0)
    if [ -e "$p" ] || [ -L "$p" ]; then exit 4; fi
    mkdir -m 700 -- "$p"' _ "$FRESH" 8>&- 9>&- ||
    { say "the fresh clone's directory could not be made (no ~/imagefirst directory, a link, or it exists)"; finish PILOT_AUTORUN_CLONE 20; }
  # exactly root's commit, fetched by its id (never a branch tip, never another commit): git init in the new directory, origin
  # = root's URL, then a fetch of that one commit into refs/remotes/origin/develop (the worker checks HEAD = origin/develop
  # in its own clone: here both are the commit root chose). The origin no longer having it: stopped, nothing spent
  "${AS_HOME[@]}" timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" init --quiet -- "$FRESH" >/dev/null 2>&1 8>&- 9>&- ||
    { say "git init of the fresh clone failed"; finish PILOT_AUTORUN_CLONE 20; }
  in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" remote add origin -- "$ORIGIN_URL" >/dev/null 2>&1 ||
    { say "git remote add failed"; finish PILOT_AUTORUN_CLONE 20; }
  in_clone timeout --kill-after="$KILL_AFTER" "$CLONE_TIMEOUT" "${GH[@]}" fetch --quiet --no-tags origin "+$AUTORUN_SHA:refs/remotes/origin/develop" >/dev/null 2>&1 ||
    { say "STANDING_COMMIT_UNAVAILABLE: the origin does not give root's commit $AUTORUN_SHA (or is unreachable): stopped, nothing spent"; finish PILOT_STANDING_COMMIT_UNAVAILABLE 20; }
  base="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" rev-parse --verify --quiet "refs/remotes/origin/develop^{commit}" 2>/dev/null)" || base=""
  [ "$base" = "$AUTORUN_SHA" ] || { say "the fetched commit (${base:-?}) is not root's $AUTORUN_SHA: stopped"; finish PILOT_STANDING_COMMIT_UNAVAILABLE 20; }
  in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" checkout --quiet --detach "$AUTORUN_SHA" >/dev/null 2>&1 ||
    { say "git checkout failed"; finish PILOT_AUTORUN_CLONE 20; }
  head="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" rev-parse HEAD 2>/dev/null)" || head=""
  [ "$head" = "$AUTORUN_SHA" ] || { say "HEAD is not $AUTORUN_SHA after the checkout"; finish PILOT_AUTORUN_CLONE 20; }
  extra="$(in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" "${GH[@]}" status --porcelain --ignored --untracked-files=all 2>/dev/null)" ||
    { say "git status failed"; finish PILOT_AUTORUN_CLONE 20; }
  [ -z "$extra" ] || { say "the fresh clone is not exactly the commit (changed, untracked or ignored files): stopped"; finish PILOT_AUTORUN_TREE_DIRTY 20; }
  in_clone env npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null timeout --kill-after="$KILL_AFTER" "$NPM_TIMEOUT" npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 ||
    { say "npm ci failed"; finish PILOT_AUTORUN_NPM 20; }
  node_paths_clean || { say "a node_modules / package.json appeared in the worker's home or ~/imagefirst during npm ci: stopped"; finish PILOT_AUTORUN_NODE_PATHS 20; }
  # where the preflight finds it and the commit it must be at (root's own files in root's 0700 state; the preflight checks
  # their form)
  printf '%s\n' "$FRESH" >"$STATE/autorun-clone"
  printf '%s\n' "$AUTORUN_SHA" >"$STATE/autorun-commit"
  say "a fresh clone at root's verified commit $AUTORUN_SHA (no user git config, status --ignored empty, npm ci)"

  # ---- --autorun-request: root's copy of the request (root's own file, the SHA-256 the automatic run recorded) handed to
  # the run: the worker copies it from stdin into the run's private <fresh>.request/<id>.json (0600; a new directory)
  if [ "$REQUEST" = 1 ]; then
    REQ_ROOT="$STATE/requests/$APPROVAL.json"
    [ -f "$REQ_ROOT" ] && [ ! -L "$REQ_ROOT" ] && [ "$(sha256sum <"$REQ_ROOT" | cut -d" " -f1)" = "$REQUEST_SHA" ] ||
      { say "root's copy of request $APPROVAL is missing or not the SHA-256 the automatic run recorded: stopped"; finish PILOT_REQUEST_MISMATCH 20; }
    REQ_FILE="$FRESH.request/$APPROVAL.json"
    "${AS_HOME[@]}" bash -c 'set -u; umask 077; d="$1"
      [ ! -e "$d" ] && [ ! -L "$d" ] || exit 4
      mkdir -m 700 -- "$d" || exit 3
      cat >"$d/$2.json" && chmod 600 -- "$d/$2.json"' _ "$FRESH.request" "$APPROVAL" <"$REQ_ROOT" 8>&- 9>&- ||
      { say "the run's private copy of the request could not be made"; finish PILOT_REQUEST_COPY 20; }
    say "request $APPROVAL handed to the run (a private copy of root's, SHA-256 checked)"
  fi

  # ---- the run's isolated model-CLI config (docs/operations/imagefirst-autorun.md, config trust). Built only from root's
  # reviewed config (root-owned, nobody else can write it, its SHA-256 the one pinned here) and copies of the two sign-in
  # files (regular files, not links, small; copied by the worker, never read by root). When anything is not exactly so,
  # nothing is built and the preflight's config_trust row fails: the run stops before the claim
  cfg_sha=""
  if [ -f "$CODEX_CONFIG" ] && [ ! -L "$CODEX_CONFIG" ] && [ "$(stat -c %s -- "$CODEX_CONFIG")" -le 4096 ]; then
    if [ -z "$R" ]; then trusted_path "$CODEX_CONFIG" && cfg_sha="$(sha256sum <"$CODEX_CONFIG" | cut -d" " -f1)"
    elif [ "$(stat -c %U -- "$CODEX_CONFIG")" = "$(id -un)" ] && [ $(( 0$(stat -c %a -- "$CODEX_CONFIG") & 022 )) -eq 0 ]; then cfg_sha="$(sha256sum <"$CODEX_CONFIG" | cut -d" " -f1)"
    fi
  fi
  if [ "$cfg_sha" = "$CODEX_CONFIG_SHA256" ]; then
    if "${AS_HOME[@]}" bash -c 'set -u; umask 077; c="$1"; max=1048576
      [ ! -e "$c" ] && [ ! -L "$c" ] || exit 4
      for d in "$HOME/.codex" "$HOME/.claude"; do [ -d "$d" ] && [ ! -L "$d" ] || exit 6; done
      for f in "$HOME/.codex/auth.json" "$HOME/.claude/.credentials.json"; do
        [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %s -- "$f")" -le "$max" ] || exit 6
      done
      mkdir -m 700 -- "$c" || exit 3
      fail() { rm -rf -- "$c"; exit 3; }
      mkdir -m 700 -- "$c/codex" "$c/claude" || fail
      cat >"$c/codex/config.toml" || fail
      cat -- "$HOME/.codex/auth.json" >"$c/codex/auth.json" || fail
      cat -- "$HOME/.claude/.credentials.json" >"$c/claude/.credentials.json" || fail
      chmod 600 -- "$c/codex/config.toml" "$c/codex/auth.json" "$c/claude/.credentials.json" || fail' _ "$CFG" <"$CODEX_CONFIG" 8>&- 9>&-; then
      CFG_BUILT=1
      say "the run's own CODEX_HOME and CLAUDE_CONFIG_DIR are built (root's reviewed config.toml, sign-in copies only)"
    else
      say "the run's own config dirs could not be built (a sign-in file missing, a link, too large, or the path exists): the preflight's config_trust row fails"
    fi
  else
    say "root's Codex config ($CODEX_CONFIG) is missing, not root's only, or not the reviewed one (SHA-256): the preflight's config_trust row fails"
  fi
fi

# ---------------------------------------------------------------- 1. the preflight (read only; every row PASS)
set +e
if [ "$REQUEST" = 0 ]; then
  bash "$PREFLIGHT" "$APPROVAL" >"$WORK/preflight" 2>&1 8>&- 9>&-
else
  bash "$PREFLIGHT" --request "$APPROVAL" >"$WORK/preflight" 2>&1 8>&- 9>&-
fi
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
if [ "$REQUEST" = 0 ]; then
  "${AS_WORKER[@]}" timeout --foreground --kill-after="$WORKER_KILL_AFTER" "$WORKER_TIMEOUT" env "$GRANT_ENV=$APPROVAL" \
    node --import tsx scripts/sales-design-worker/imagefirst-worker.ts >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &
else
  # a standing request: no approval grant; the request id, root's SHA-256 of it, and the run's private copy
  "${AS_WORKER[@]}" timeout --foreground --kill-after="$WORKER_KILL_AFTER" "$WORKER_TIMEOUT" env "SR_IMAGEFIRST_REQUEST_FILE=$REQ_FILE" \
    node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --request "$APPROVAL" --request-sha256 "$REQUEST_SHA" >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &
fi
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
