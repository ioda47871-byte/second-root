#!/usr/bin/env bash
# DEV-029 photo PoC — one fictional bakery job with person-made concept photos
# through the normal design worker (real Codex, inside the jail).
#
#   ./scripts/sales-design-worker/photo-poc.sh --job-id poc-photo-001 \
#     --created-by <your handle> --created-at <ISO time the images were made> \
#     --image <concept-1.png|jpg|webp> [--image <concept-2> --image <concept-3>]
#
# Run as the worker user (sr-designgen) inside the jail, e.g.
#   sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- \
#     /home/sr-designgen/work/second-root/scripts/sales-design-worker/photo-poc.sh …
# See docs/operations/design-photo-poc.md. Steps, each stopping on failure:
#   1. pin this checkout to origin/$SR_DESIGN_WORKER_REF (default: the DEV-029 branch) and install
#   2. write the fictional facts (no real shop) outside the repository
#   3. intake the images as generated_concept, people none (refused if the job already has photos)
#   4. poc-preflight (job id unused, queue idle, photos verified, sandbox with the store hidden, ChatGPT sign-in)
#   5. enqueue (reference: https://example.com/, the IANA documentation domain — no shop, no Instagram)
#   6. run.sh --max=1 (the supported entry point; its own budget and timeouts, unchanged)
#   7. poc-report → ~/sr-design-poc/<job>.json (codes, counts and milliseconds only)
# Never run a job id twice: step 3 and step 4 refuse a used id.
{
set -euo pipefail
umask 077

JOB=""
BY=""
AT=""
IMAGES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --job-id) JOB="${2:-}"; shift 2 ;;
    --created-by) BY="${2:-}"; shift 2 ;;
    --created-at) AT="${2:-}"; shift 2 ;;
    --image) IMAGES+=("${2:-}"); shift 2 ;;
    *) echo "usage: --job-id poc-photo-<n> --created-by <handle> --created-at <ISO time> --image <file> [--image …]"; exit 2 ;;
  esac
done
# A generic PoC id only: never a shop's name.
[[ "$JOB" =~ ^poc-photo-[a-z0-9-]{1,40}$ ]] || { echo "--job-id: poc-photo-<lowercase letters, digits, ->"; exit 2; }
[[ "$BY" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || { echo "--created-by: a handle (letters, digits, . _ @ -)"; exit 2; }
[ -n "$AT" ] || { echo "--created-at: when the images were made (ISO time, e.g. 2026-10-02T09:00:00+09:00)"; exit 2; }
[ "${#IMAGES[@]}" -ge 1 ] && [ "${#IMAGES[@]}" -le 3 ] || { echo "--image: 1 to 3 images"; exit 2; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REF="${SR_DESIGN_WORKER_REF:-feature/dev-029-photo-art-direction}"
[[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { echo "SR_DESIGN_WORKER_REF: not a branch name"; exit 2; }
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/sr-design-worker"
INPUT="$HOME/sr-design-input/$JOB"
OUT="$HOME/sr-design-poc"
cd "$REPO"

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

echo "== 3. intake (generated_concept, people none)"
EXISTING="$(npm run -s sales:design-assets -- list --job-id "$JOB" 2>/dev/null || true)"
if grep -q '^asset-' <<<"$EXISTING"; then
  echo "STOP: $JOB already has photos. Use a new --job-id (a PoC job is never run twice)."
  exit 2
fi
for img in "${IMAGES[@]}"; do
  npm run -s sales:design-assets -- add --job-id "$JOB" --file "$img" --people none \
    --source generated_concept --created-by "$BY" --created-at "$AT"
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

echo "== 7. report"
npm run -s sales:design-worker -- poc-report --job-id "$JOB" > "$OUT/$JOB.json" || true
cat "$OUT/$JOB.json"
echo "saved: $OUT/$JOB.json"
exit "$RUN"
}
