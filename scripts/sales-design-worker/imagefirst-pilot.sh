#!/usr/bin/env bash
# Second Root IMAGE_FIRST limited pilot (Issue #302, owner pre-approval 2026-11-21): ONE ほし窯 d3 generation by the
# EXISTING worker, its delivery to the private review inbox, an audit dry run and ONE Claude CLI audit, started once by
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
# A stop signal while the worker or the audit runs is passed on and waited for (the worker writes its receipt, the audit
# its stopped record); a stop before the worker starts ends the pilot there.
#
# Output: the preflight's table, fixed lines, the workers' one JSON lines, the summary. The last line is machine-readable:
#   IMAGEFIRST_PILOT <CODE> phase=<before_claim|after_claim> approval=<id|none> exit=<n>
# Exit: 0 done (or synced), 20 preflight FAIL / clone (nothing started), 12 busy before the worker, 2 usage / refused,
#       1 stopped after the worker started (worker stopped, not delivered, busy, dry run or audit not as expected),
#       40/41 signal / internal.
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
  # while the worker or the audit runs: pass the stop on and wait for it (below); before the worker: stop here
  if [ -n "$WPID" ]; then
    INTERRUPTED=1
    kill -TERM "$WPID" 2>/dev/null || true
    return 0
  fi
  finish PILOT_STOP_SIGNAL 40
}
trap on_exit EXIT
trap on_signal INT TERM HUP

# ---------------------------------------------------------------- the mode
MODE=run
if [ "$#" -eq 1 ] && [ "$1" = --sync-clone ]; then
  MODE=sync
else
  [ "$#" -eq 1 ] || { say "usage: imagefirst-pilot.sh <approval id> | --sync-clone"; finish PILOT_USAGE 2; }
  [[ "$1" =~ ^hoshigama-imagefirst-d3-[0-9]{8}-[0-9]{2}$ ]] || { say "PILOT_ID_INVALID: expected hoshigama-imagefirst-d3-YYYYMMDD-NN"; finish PILOT_ID_INVALID 2; }
  APPROVAL="$1"
  [[ "$APPROVAL" != hoshigama-imagefirst-d3-00000000-* ]] || { say "PILOT_ID_RESERVED: the date 00000000 is the dummy PoC's, never a real run's"; finish PILOT_ID_RESERVED 2; }
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

# The summary (step 7): read by the worker user from its own files, every value checked against a fixed shape and
# printed as code / hash / number only. Root parses none of the worker's files.
SUMMARY_PY='
import hashlib, json, os, re, struct, sys
aid, receipt_path = sys.argv[1], sys.argv[2]
HEX = re.compile(r"[0-9a-f]{64}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
WORD = re.compile(r"[A-Za-z0-9_.:-]{1,64}\Z")
AID = re.compile(r"hoshigama-imagefirst-d3-[0-9]{8}-[0-9]{2}\Z")
home = os.path.realpath(os.path.expanduser("~"))
runs = os.path.join(home, "sr-runs")
state = os.path.join(home, ".local", "state", "sr-design-worker", "imagefirst-worker")
inbox = os.path.join(runs, "review-inbox")
def out(k, v): print(k + "=" + v)
def s(v, rx): return v if isinstance(v, str) and rx.match(v) else "invalid"
def n(v): return str(v) if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 10 ** 9 else "invalid"
def d(v): return v if isinstance(v, dict) else {}
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
if r:
    b, j = r
    out("approval_id", s(j.get("approval_id"), AID))
    out("commit", s(j.get("commit"), COMMIT))
    out("receipt_status", s(j.get("status"), WORD) + " stop_code=" + (s(j.get("stop_code"), WORD) if j.get("stop_code") is not None else "none"))
    out("receipt_sha256", hashlib.sha256(b).hexdigest())
    out("packet_sha256", s(j.get("packet_sha256"), HEX))
    out("plan_sha256", s(j.get("plan_sha256"), HEX))
    out("prompt_sha256", s(j.get("prompt_sha256"), HEX))
    c = d(j.get("counts"))
    out("images", "pc=" + n(c.get("pc")) + " sp=" + n(c.get("sp")) + " total=" + n(c.get("total")) + " verified=" + str(j.get("verified") is True).lower())
    run_dir = j.get("run_dir") if isinstance(j.get("run_dir"), str) and under(j.get("run_dir"), runs) else None
    for im in j.get("images") if isinstance(j.get("images"), list) else []:
        im = d(im)
        f = im.get("file")
        if not isinstance(f, str) or not re.match(r"parts/(pc|sp)-[0-9]\.png\Z", f):
            out("image", "invalid"); continue
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
        out("image", f + " sha256=" + s(im.get("sha256"), HEX) + " size=" + size + " sha_matches_file=" + match)
else:
    out("receipt", "unreadable")
job = load(os.path.join(state, "deliveries", aid + ".json"))
out("delivery", ("state=" + s(job[1].get("state"), WORD) + " bundle_sha256=" + s(job[1].get("bundle_sha256"), HEX)) if job else "none")
a = load(os.path.join(inbox, "audits", aid, "audit.json"))
if a:
    j = a[1]
    bnd, der, vps = d(j.get("binding")), d(j.get("derived")), d(j.get("viewports"))
    out("audit_status", s(j.get("status"), WORD) + " stop_code=" + (s(j.get("stop_code"), WORD) if j.get("stop_code") is not None else "none"))
    out("audit_bundle_sha256", s(bnd.get("bundle_sha256"), HEX))
    out("rubric", "version=" + s(bnd.get("rubric_version"), WORD) + " sha256=" + s(bnd.get("rubric_sha256"), HEX))
    for vp in ("desktop_1440", "mobile_390"):
        dv = d(der.get(vp))
        sc = d(d(vps.get(vp)).get("scores"))
        parts = [k + "=" + n(d(v).get("score")) for k, v in sorted(sc.items()) if isinstance(k, str) and WORD.match(k)]
        hits = dv.get("hard_fail_hits")
        out("scores_" + vp, " ".join(["total=" + n(dv.get("total")), "lowest=" + n(dv.get("lowest")), "verdict=" + s(dv.get("verdict"), WORD), "hard_fails=" + (str(len(hits)) if isinstance(hits, list) else "invalid")] + parts))
    out("verdict", s(der.get("verdict"), WORD) + " (advisory only; the owner decides)")
else:
    out("audit", "none")
'
SUMMARIZED=0
summary() {
  [ "$SUMMARIZED" = 0 ] || return 0
  SUMMARIZED=1
  say "summary: approval=$APPROVAL codex_runs=1 (one worker run; never retried) delivery=$DELIVERY"
  [ -n "$RECEIPT" ] || { say "summary: no receipt reported by the worker"; return 0; }
  in_clone timeout --kill-after="$KILL_AFTER" "$GIT_TIMEOUT" python3 -I -c "$SUMMARY_PY" "$APPROVAL" "$RECEIPT" 2>/dev/null |
    tr -d '\000-\010\013-\037' | cut -c1-400 | sed 's/^/imagefirst-pilot: summary: /' || say "summary: unreadable"
  [ -z "$AUDIT_LINE" ] || say "summary: audit line: $AUDIT_LINE"
}

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
AS_WORKER+=(bash -c 'cd -- "$1" || exit 97; shift; exec "$@"' _ "$CLONE")
[ -d "$CLONE" ] || { say "PILOT_STOP_NO_CLONE: $CLONE is missing"; finish PILOT_STOP_NO_CLONE 20; }

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
PHASE=after_claim
say "starting the worker once (approval $APPROVAL): one claim, one generation, never retried"
set +e
# node with the tsx loader is timeout's direct child, and timeout --foreground signals only that child: one stop is one
# SIGTERM to the worker (the tsx CLI would relay it again within 30 ms, and the worker would take it as a hard stop).
# The worker starts the entry in its own process group and stops it itself.
"${AS_WORKER[@]}" timeout --foreground --kill-after="$WORKER_KILL_AFTER" "$WORKER_TIMEOUT" env "$GRANT_ENV=$APPROVAL" \
  node --import tsx scripts/sales-design-worker/imagefirst-worker.ts >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &
WPID=$!
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
say "worker: ${line:-<no line>}"
# the receipt the worker reported, only in its own place (<worker home>/sr-runs/<approval>-<UTC>.receipt.json)
if [[ "$line" =~ \"receipt\":\"([^\"]+)\" ]]; then
  cand="${BASH_REMATCH[1]}"
  if [[ "$cand" =~ ^"$WORKER_HOME"/sr-runs/"$APPROVAL"-[0-9]{8}T[0-9]{6}Z\.receipt\.json$ ]]; then RECEIPT="$cand"; fi
fi
if [ "$rc" -ne 0 ]; then
  tail -n 20 "$WORK/err" | tr -d '\000-\010\013-\037' | cut -c1-300 | sed 's/^/imagefirst-pilot: worker stderr: /'
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
idle_or_stop "after the worker"

# ---------------------------------------------------------------- 4. the delivery: the worker's own hand-off, else ONE re-send
review="$(grep -a '^imagefirst-worker: review ' "$WORK/err" | tail -n 1 | tr -d '\000-\037' | cut -c1-400)" || review=""
say "hand-off: ${review:-<no line>}"
if [[ "$review" == *'"status":"delivered"'* ]] || [[ "$review" == *'"status":"duplicate"'* ]]; then
  DELIVERY=delivered
else
  say "the hand-off did not deliver: re-sending the SAME sealed bundle once (imagefirst-deliver-review.sh; no generation)"
  release_locks
  set +e
  env ${R:+"SR_IMAGEFIRST_DELIVER_TEST_ROOT=$R"} bash "$DELIVER" "$APPROVAL" >"$WORK/deliver" 2>&1
  drc=$?
  set -e
  tr -d '\000-\010\013-\037' <"$WORK/deliver" | cut -c1-400
  dline="$(tail -n 1 "$WORK/deliver" | tr -d '\000-\037')"
  take_locks || { say "busy: the locks were taken while the re-send ran"; finish PILOT_BUSY 1; }
  if [ "$drc" -eq 0 ] && [[ "$dline" == "IMAGEFIRST_DELIVER_REVIEW DELIVER_DONE approval=$APPROVAL exit=0" ]]; then
    DELIVERY=delivered_by_resend
  else
    DELIVERY=not_delivered
    say "not delivered: no audit (the bundle stays sealed; re-send it later with imagefirst-deliver-review.sh)"
    finish PILOT_NOT_DELIVERED 1
  fi
fi

# ---------------------------------------------------------------- 5. the audit dry run (verify and plan; the size caps)
idle_or_stop "before the audit dry run"
set +e
"${AS_WORKER[@]}" timeout --foreground --kill-after="$KILL_AFTER" "$DRY_RUN_TIMEOUT" \
  node --import tsx scripts/sales-design-worker/imagefirst-audit.ts "$APPROVAL" --dry-run >"$WORK/dry" 2>/dev/null 8>&- 9>&-
yrc=$?
set -e
yline="$(tail -n 1 "$WORK/dry" | tr -d '\000-\037' | cut -c1-2000)"
say "audit dry run: ${yline:-<no line>}"
if [ "$yrc" -ne 0 ] || [[ "$yline" != *'"status":"planned"'* ]]; then
  say "the dry run did not plan (over the caps, not delivered, jail, ...): no audit"
  finish PILOT_AUDIT_DRY_RUN_FAILED 1
fi

# ---------------------------------------------------------------- 6. the ONE audit
idle_or_stop "before the audit"
say "starting the audit once (approval $APPROVAL)"
set +e
"${AS_WORKER[@]}" timeout --foreground --kill-after="$AUDIT_KILL_AFTER" "$AUDIT_TIMEOUT" \
  node --import tsx scripts/sales-design-worker/imagefirst-audit.ts "$APPROVAL" >"$WORK/audit" 2>/dev/null 8>&- 9>&- &
WPID=$!
wait "$WPID"
rc=$?
while [ "$rc" -gt 128 ] && kill -0 "$WPID" 2>/dev/null; do
  wait "$WPID"
  rc=$?
done
set -e
WPID=""
AUDIT_LINE="$(tail -n 1 "$WORK/audit" | tr -d '\000-\037' | cut -c1-2000)"
say "audit: ${AUDIT_LINE:-<no line>}"
if [ "$INTERRUPTED" = 1 ]; then finish PILOT_INTERRUPTED 1; fi
if [ "$rc" -ne 0 ] || [[ "$AUDIT_LINE" != *'"status":"completed"'* ]]; then
  say "the audit did not complete (it is not retried)"
  finish PILOT_AUDIT_STOPPED 1
fi

# ---------------------------------------------------------------- 7. done
finish PILOT_DONE 0
}
