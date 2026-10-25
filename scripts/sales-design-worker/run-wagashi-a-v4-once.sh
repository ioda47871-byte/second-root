#!/usr/bin/env bash
# DEV-110: one-command entry point for the owner's already-approved single
# wagashi-A v4 local Codex image PoC. Run ONLY as sr-designgen inside admin.sh
# jail, as the existing sr-jail-claude.service's browser-controlled Claude.
# Not directly from ioda0, root, an unjailed shell, or an admin.sh run unit.
# This script deliberately has no dry-run that might silently use an approval.
set -euo pipefail
if [ "$#" -ne 1 ] || [ "$1" != "--human-approval-confirmed" ]; then
  echo "STOP: owner must explicitly invoke --human-approval-confirmed (one approved call only)."
  exit 2
fi
if [ "$(id -un)" != "sr-designgen" ] || [ "${HOME:-}" != "/home/sr-designgen" ]; then
  echo "STOP: sr-designgen user required inside the isolated Claude service."
  exit 2
fi
# This specific entrypoint is for the existing remote-controlled Claude session.
# The root-managed service must already have launched it with the installed
# cgroup/namespace restrictions; NEVER escalate uid or create another session.
if ! grep -qx '0::/system.slice/sr-jail-claude.service' /proc/self/cgroup; then
  echo "STOP: SR_CLAUDE_JAIL_REQUIRED; no Codex call was started."
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec env SR_DESIGN_WORKER_REF=develop SR_DESIGN_WORKER_NO_UPDATE=1 SR_DESIGN_IMAGE_POC_DIRECTION=v4 \
  bash "$HERE/design-image-poc.sh" \
  --human-approval-confirmed \
  --expected-prompt-sha256 4e34f760ccde3f28df58316e9b55e6d21d6ac78d397bf770f6295fb1699157d9 \
  --expected-prompt-chars 4714 \
  --expected-commit 9b79163825368d53bc066693b03cc21f7702b67d \
  --approval-id wagashi-a-v4-20261025-01
