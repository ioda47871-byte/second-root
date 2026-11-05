#!/usr/bin/env bash
# DEV-185: one-command entry point for the owner's single approval of the つぐ手 (fictional kintsugi shop) AI demo
# photos: ONE real Codex run, at most 6 image calls, approval id tsugute-photos-20261106-01. Run ONLY as sr-designgen
# inside the existing sr-jail-claude.service (the browser-controlled Claude). Not from ioda0, root, an unjailed shell
# or an admin.sh run unit. No dry-run that might silently use the approval. See docs/operations/design-image-one-command.md §6.
set -euo pipefail
if [ "$#" -ne 3 ] || [ "$1" != "--human-approval-confirmed" ] || [ "$2" != "--expected-commit" ] || ! [[ "$3" =~ ^[a-f0-9]{40}$ ]]; then
  echo "STOP: one approved run needs --human-approval-confirmed --expected-commit <reviewed 40-character commit SHA>."
  exit 2
fi
REVIEWED_COMMIT="$3"
if [ "$(id -un)" != "sr-designgen" ] || [ "${HOME:-}" != "/home/sr-designgen" ]; then
  echo "STOP: sr-designgen user required inside the isolated Claude service."
  exit 2
fi
if ! grep -qx '0::/system.slice/sr-jail-claude.service' /proc/self/cgroup; then
  echo "STOP: SR_CLAUDE_JAIL_REQUIRED; no Codex call was started."
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec env SR_DESIGN_WORKER_NO_UPDATE=1 \
  bash "$HERE/tsugute-photos-gate.sh" \
  --human-approval-confirmed \
  --expected-prompt-sha256 dab7f2603c7495c4381035391a24ae98cc8bd07064295233fab034964ec33ed0 \
  --expected-prompt-chars 4133 \
  --expected-commit "$REVIEWED_COMMIT" \
  --approval-id tsugute-photos-20261106-01
