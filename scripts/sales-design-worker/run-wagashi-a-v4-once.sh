#!/usr/bin/env bash
# DEV-110: one-command entry point for the owner's already-approved single
# wagashi-A v4 local Codex image PoC. Run ONLY as sr-designgen inside admin.sh
# jail ("admin.sh run sr-designgen -- /bin/bash <this file> --human-approval-confirmed").
# This script deliberately has no dry-run that might silently use an approval.
set -euo pipefail
if [ "$#" -ne 1 ] || [ "$1" != "--human-approval-confirmed" ]; then
  echo "STOP: owner must explicitly invoke --human-approval-confirmed (one approved call only)."
  exit 2
fi
if [ "$(id -un)" != "sr-designgen" ] || [ "${HOME:-}" != "/home/sr-designgen" ]; then
  echo "STOP: sr-designgen jail required; do not run this directly as root."
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec env SR_DESIGN_WORKER_REF=develop SR_DESIGN_WORKER_NO_UPDATE=0 SR_DESIGN_IMAGE_POC_DIRECTION=v4 \
  bash "$HERE/design-image-poc.sh" \
  --human-approval-confirmed \
  --expected-prompt-sha256 4e34f760ccde3f28df58316e9b55e6d21d6ac78d397bf770f6295fb1699157d9 \
  --expected-prompt-chars 4714 \
  --approval-id wagashi-a-v4-20261025-01
