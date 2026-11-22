# DEV-302 approval relay design (PR #327) — Fresh Review

Independent reviewer (separate context, read-only). Document only; no boundary, script or setting changes.

## Round 1 — 101b7d8e — FAIL (C2 / H2 / M2 / L1)

- C: CODEOWNERS missed code root runs (`scripts/sales-design-capture/admin.sh` via autorun) → C: the worker's import
  closure, `package*.json` / `npm ci` and `tsconfig*` were unprotected. Fixed by making the owner's approval cover the
  whole tree of one commit C and having root run only C (same trust level as today's fetch + approve command).
- H: owner credentials beyond `gh` → inventory + canary test with the owner present. H: "last PR that changed the
  packet" fragile → squash only, up-to-date required, `review.commit_id = head`, head tree = `C^{tree}`.
- M: ruleset bypass → no bypass actors. M: TOCTOU / verifier self-update / burning an approval by moving develop →
  pin to C, verifier in a fixed root-owned place. L: TLS / proxy → `api.github.com` only, proxy variables ignored.

## Round 2 — 1609f2aa — PASS (M2 / L3)

- M: C had to be the develop tip → C = the approved packet PR's `merge_commit_sha`; T ancestor of C, C ancestor of
  develop, every commit in T..C has a PR. M: approving any packet PR meant "run" → only a PR whose own diff flips §10
  to approved for the ID counts; the doc says approving it authorises one run.
- L: compare-link base → root checks T is an ancestor of C; the owner compares with their own previous approval.
  L: latest owner review state (full list, no later CHANGES_REQUESTED / dismissal). L: marker names → `used/<ID>` and
  `autorun/<ID>/attempt` (the scripts' real names). Left Low: the rules API does not show bypass actors.

All fixed in fadf34b0. Implementation is a separate OWNER MERGE ONLY PR after the owner's decisions (§6).

## Owner update 2026-11-22 — dedicated approver account (iii) + protected approval branch `imagefirst/approved` (b)

## Round 3 — 9889a923 — FAIL (H1 / M3 / L5)

- H: the approver could be shown a different diff from the one root accepts (PR opened against develop then
  retargeted; approval branch moved during the review) → root refuses PRs with base change / force-push timeline
  events, requires via the activity API that the approval branch's only update since T is the merge to C, freezes
  otherwise; no verifier is built until the read-only token is confirmed to read these events.
- M: phone review is not realistic → the doc says plainly code approval equals today's level, the owner checks the
  packet. M: approver account recovery → separate mailbox, offline recovery codes. M: root/worker packet mismatch →
  direction→path map. L: exactly two parents, merge queue off, CODEOWNERS dropped (erased by develop merges),
  no LFS/submodules. (The `autorun/<ID>/attempt` Low was withdrawn: it is the scripts' real marker.)

## Round 4 — 746278a6 — PASS (L3)

- L: map path must match the verifier's own fixed pattern; freeze reason in root-only state with a worker-readable
  copy, cleared only by the owner's root command; expired activity records fail closed. All fixed in the next commit.
