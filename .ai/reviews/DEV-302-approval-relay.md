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
