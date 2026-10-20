#!/usr/bin/env bash
# DEV-029 photo PoC — one fictional bakery job with approved real photos
# through the normal design worker (real Codex, inside the jail).
#
# DEV-070 (2026-10-20): the photos are approved_real only — photos a shop
# provided or allowed, with your own consent record whose permission covers
# this local preview use. No AI-generated or made-up photo, no Instagram /
# website image without the shop's permission (未承認の画像利用は禁止).
# Running this needs the human's explicit approval for these specific photos
# first; --human-approval-confirmed states that this approval was given.
#
#   ./scripts/sales-design-worker/photo-poc.sh --job-id poc-photo-006 \
#     --consent-id <id of your own consent record> --approved-by <your handle> \
#     --approved-at <ISO time of the permission> --human-approval-confirmed \
#     --image <photo-1.png|jpg|webp> [--image <photo-2> --image <photo-3>]
#
# Run as the worker user (sr-designgen) inside the jail, e.g.
#   sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- \
#     /home/sr-designgen/work/second-root/scripts/sales-design-worker/photo-poc.sh …
# See docs/operations/design-photo-poc.md. Steps, each stopping on failure:
#   0. resource preflight (STOP: nothing is started)
#   1. pin this checkout to origin/$SR_DESIGN_WORKER_REF (default: develop) and install
#   2. write the fictional facts (no real shop) outside the repository
#   3. intake the images as approved_real, scope local_preview only, people none (refused if the job already has photos)
#   4. poc-preflight (job id unused, queue idle, photos verified and approved for local_preview, sandbox with the store hidden, ChatGPT sign-in)
#   5. enqueue (reference: https://example.com/, the IANA documentation domain — no shop, no Instagram)
#   6. run.sh --max=1 (the supported entry point; its own budget and timeouts, unchanged)
#   7. poc-report → ~/sr-design-poc/<job>.json (codes, counts and milliseconds only)
# Never run a job id twice: step 3 and step 4 refuse a used id.
{
set -euo pipefail
umask 077

JOB=""
CONSENT=""
BY=""
AT=""
APPROVED=""
IMAGES=()
USAGE="usage: --job-id poc-photo-<n> --consent-id <id> --approved-by <handle> --approved-at <ISO time> --human-approval-confirmed --image <file> [--image …]"
while [ $# -gt 0 ]; do
  case "$1" in
    --job-id) JOB="${2:-}"; shift 2 ;;
    --consent-id) CONSENT="${2:-}"; shift 2 ;;
    --approved-by) BY="${2:-}"; shift 2 ;;
    --approved-at) AT="${2:-}"; shift 2 ;;
    --human-approval-confirmed) APPROVED=1; shift ;;
    --image) IMAGES+=("${2:-}"); shift 2 ;;
    *) echo "$USAGE"; exit 2 ;;
  esac
done
# A generic PoC id only: never a shop's name.
[[ "$JOB" =~ ^poc-photo-[a-z0-9-]{1,40}$ ]] || { echo "--job-id: poc-photo-<lowercase letters, digits, ->"; exit 2; }
[[ "$CONSENT" =~ ^[A-Za-z0-9_-]{3,64}$ ]] || { echo "--consent-id: the id of your own record of the shop's permission (letters, digits, _ -)"; exit 2; }
[[ "$BY" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || { echo "--approved-by: a handle (letters, digits, . _ @ -)"; exit 2; }
[ -n "$AT" ] || { echo "--approved-at: when the permission was given (ISO time, e.g. 2026-10-02T09:00:00+09:00)"; exit 2; }
[ -n "$APPROVED" ] || { echo "STOP: --human-approval-confirmed is missing. Running the photo PoC needs the human's explicit approval for these specific photos (未承認の画像利用は禁止). Nothing was started."; exit 2; }
[ "${#IMAGES[@]}" -ge 1 ] && [ "${#IMAGES[@]}" -le 3 ] || { echo "--image: 1 to 3 images"; exit 2; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REF="${SR_DESIGN_WORKER_REF:-develop}"
[[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { echo "SR_DESIGN_WORKER_REF: not a branch name"; exit 2; }
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/sr-design-worker"
INPUT="$HOME/sr-design-input/$JOB"
OUT="$HOME/sr-design-poc"
cd "$REPO"

echo "== 0. resource preflight (docs/operations/wsl-resource-preflight.md)"
set +e
bash "$REPO/scripts/ops/wsl-resource-preflight.sh"
PRE=$?
set -e
if [ "$PRE" -eq 20 ]; then
  echo "STOP: not enough memory for build + Chromium + Codex. Nothing was started (no intake, no job)."
  exit 20
fi

echo "== 1. checkout origin/$REF"
timeout 180 git fetch --quiet --no-tags origin "+refs/heads/$REF:refs/remotes/origin/$REF"
timeout 60 git checkout --quiet --force --detach "origin/$REF"
timeout 60 git clean -q -f -d
mkdir -p "$STATE" && chmod 700 "$STATE"
LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -x node_modules/.bin/tsx ] || [ "$(cat "$STATE/npm-lock.sha256" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  timeout 900 npm ci --no-audit --no-fund --loglevel=error
  echo "$LOCK_HASH" > "$STATE/npm-lock.sha256"
fi
echo "commit $(git rev-parse --short=12 HEAD)"

echo "== 2. fictional facts"
mkdir -p "$INPUT" "$OUT"
cat > "$INPUT/facts.json" <<'FACTS'
{
  "name": "POC SAMPLE BAKERY",
  "category": "baked_goods",
  "ward": "北区",
  "address": "名古屋市北区テスト町1-2-3",
  "description": "写真 PoC 用の架空のパン屋です。実在の店舗ではありません。",
  "hours": "10:00-17:00",
  "closed_days": "月曜"
}
FACTS

echo "== 3. intake (approved_real, scope local_preview, people none)"
EXISTING="$(npm run -s sales:design-assets -- list --job-id "$JOB" 2>/dev/null || true)"
if grep -q '^asset-' <<<"$EXISTING"; then
  echo "STOP: $JOB already has photos. Use a new --job-id (a PoC job is never run twice)."
  exit 2
fi
for img in "${IMAGES[@]}"; do
  npm run -s sales:design-assets -- add --job-id "$JOB" --file "$img" --people none \
    --source approved_real --consent-id "$CONSENT" --approved-by "$BY" --approved-at "$AT" --scope local_preview
done
npm run -s sales:design-assets -- list --job-id "$JOB"

echo "== 4. preflight"
npm run -s sales:design-worker -- poc-preflight --job-id "$JOB"

echo "== 5. enqueue"
npm run -s sales:design-worker -- enqueue --job-id "$JOB" --facts "$INPUT/facts.json" --website https://example.com/

echo "== 6. worker (run.sh --max=1)"
set +e
SR_DESIGN_WORKER_REF="$REF" ./scripts/sales-design-worker/run.sh --max=1
RUN=$?
set -e
echo "run.sh exit $RUN"
if [ "$RUN" -eq 137 ] || [ "$RUN" -eq 124 ]; then
  echo "run.sh was killed or timed out: check for an OOM kill before treating it as a bug:"
  bash "$REPO/scripts/ops/wsl-resource-preflight.sh" --oom-check --since "2 hours ago" || true
fi

echo "== 7. report"
npm run -s sales:design-worker -- poc-report --job-id "$JOB" > "$OUT/$JOB.json" || true
cat "$OUT/$JOB.json"
echo "saved: $OUT/$JOB.json"
exit "$RUN"
}
