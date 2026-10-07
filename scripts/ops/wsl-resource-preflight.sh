#!/usr/bin/env bash
# 実機 resource preflight (WSL). Read-only: it never changes .wslconfig, limits or processes.
#
#   scripts/ops/wsl-resource-preflight.sh             memory check before heavy local work
#   scripts/ops/wsl-resource-preflight.sh --oom-check [--since "2 hours ago"]
#                                                     was a sudden "Killed" an OOM kill?
#
# Heavy = full unit suite, Chromium / Playwright, the design worker (next build + Chromium + Codex), Codex.
# See docs/operations/wsl-resource-preflight.md.
#
# check exit:     0 OK (parallel up to 2) / 10 SERIAL (one heavy job, 1 test worker) / 20 STOP (do not start)
# --oom-check:    0 no OOM kill found / 1 OOM kill found / 3 unknown (kernel log not readable here)
set -euo pipefail

MEMINFO="${SR_PREFLIGHT_MEMINFO:-/proc/meminfo}"   # tests only
STOP_MIB=3072      # below 3 GiB available: a full suite + runner was OOM-killed at ~2.8 GiB
SERIAL_MIB=6144    # below 6 GiB available: one heavy job at a time, 1 test worker

kib() { awk -v k="$1:" '$1 == k { print $2; found=1 } END { if (!found) print 0 }' "$MEMINFO"; }

if [ "${1:-}" = "--oom-check" ]; then
  SINCE="1 hour ago"
  [ "${2:-}" = "--since" ] && SINCE="${3:-1 hour ago}"
  PATTERN='out of memory|oom-kill|oom_reaper|killed process'
  LOG=""
  if [ -n "${SR_PREFLIGHT_KLOG:-}" ]; then
    LOG="$(cat "$SR_PREFLIGHT_KLOG")"                                  # tests only
  elif LOG="$(journalctl -k --no-pager --since "$SINCE" 2>/dev/null)" && [ -n "$LOG" ]; then
    :
  elif LOG="$(dmesg 2>/dev/null)" && [ -n "$LOG" ]; then
    :
  else
    echo "OOM_UNKNOWN: the kernel log is not readable here (jail / no permission)."
    echo "Ask the person to run outside the jail: sudo journalctl -k --since \"$SINCE\" | grep -iE '$PATTERN'"
    exit 3
  fi
  HITS="$(grep -iE "$PATTERN" <<<"$LOG" || true)"
  if [ -n "$HITS" ]; then
    echo "OOM_KILL_FOUND (resource failure, not a code bug: stop, do not start a fix loop)"
    echo "$HITS" | tail -n 20
    exit 1
  fi
  echo "NO_OOM_KILL in the kernel log (since: $SINCE)"
  exit 0
fi

TOTAL=$(( $(kib MemTotal) / 1024 ))
AVAIL=$(( $(kib MemAvailable) / 1024 ))
SWAP_TOTAL=$(( $(kib SwapTotal) / 1024 ))
SWAP_FREE=$(( $(kib SwapFree) / 1024 ))
echo "MemTotal ${TOTAL} MiB / MemAvailable ${AVAIL} MiB / SwapTotal ${SWAP_TOTAL} MiB / SwapFree ${SWAP_FREE} MiB"
[ "$SWAP_TOTAL" -eq 0 ] && echo "WARN: no swap: a memory peak kills a process at once"

if [ "$AVAIL" -lt "$STOP_MIB" ]; then
  echo "STOP: less than $((STOP_MIB / 1024)) GiB available. Do not start the full unit suite, Chromium, the worker or Codex."
  echo "Report the numbers to the person (and the .wslconfig / Windows RAM check in docs/operations/wsl-resource-preflight.md)."
  exit 20
fi
if [ "$AVAIL" -lt "$SERIAL_MIB" ]; then
  echo "SERIAL: one heavy job at a time. Tests: npx vitest run --maxWorkers=1 --no-file-parallelism"
  exit 10
fi
echo "OK: at most 2 heavy jobs at a time. Tests: npx vitest run --maxWorkers=2"
exit 0
