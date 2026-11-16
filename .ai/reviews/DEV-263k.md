# DEV-263k / PR #277 — Independent Fresh Review record

Latest independently reviewed code status: **PASS on R4's pinned commit `634438b658afd3830d81b79bdef9262f6935468a` (C0/H0/M0/L2)**. GitHub CI for that same reviewed commit: **completed/success**, run **`43815976366`**, all ten jobs succeeded. **DO NOT MERGE yet:** post-R4 UI and documentation changes require CI and an independent review of their resulting commit; separate merge authorization is not included in the owner's scope approval.

## Review history

| Round | Reviewed HEAD | Verdict | Findings | Explanation |
|---|---|---|---|---|
| R1 | `1397a6c1cd1df47349417f932ec843c334fcdabb` | INCOMPLETE | C0 H0 M1 L4 | Missing dependencies, tests not run; fixes committed later |
| R2 | `389b2e9308a35f259b4d10cd47d97b23b7e57311` | INCOMPLETE | C0 H0 M0 L4 | Claude could not inspect CI or external runner files; fixes committed later |
| R3 | `ae232f21cd5c6f8c40b2a8595654229acc9aa254` | INCOMPLETE | C0 H0 M0 L2 | CI unavailable to Claude; review entry not yet committed; one owner-approval-negative test omitted |
| R4 | `634438b658afd3830d81b79bdef9262f6935468a` | PASS (independent code review) | C0 H0 M0 L2 | External GitHub CI subsequently independently verified success; two Low items addressed after R4 in later commits |

R3 reviewer: independent local Claude Code `2.1.295`, read-only instructions. Worktree and report retained only under `<private-review-dir>/R3/` (not copied into the repository). Runner reported `npm ci` exit 0 and relevant unit tests exit 0; review subprocess exited 0. R3's conclusion remains INCOMPLETE, not PASS.

## External corroboration of the *R3* commit

- Independent GitHub connector metadata: PR #277 HEAD `ae232f21cd5c6f8c40b2a8595654229acc9aa254` at verification; base `360a04d97c7c1d2d09e1177c2e2f9be50a64324c`.
- GitHub Actions CI run **`43785760982`** on this exact SHA completed with **success**. Every listed job succeeded: unit (1/2), unit (2/2), unit aggregate, integration against CI disposable Supabase, static, shop-css (1/2), shop-css (2/2), build, e2e, e2e-sales.
- This is an independently corroborated CI result, **not a substitute for a reviewer-issued PASS**.
- Following R3, the additional null-approval copy-gate regression assertion was added in the feature branch. **CI of the later HEAD must be checked separately.**

## Independent R4 PASS and CI (same reviewed SHA)

- Independent reviewer: new, read-only Claude Code context on pinned `634438b658afd3830d81b79bdef9262f6935468a`; verdict **PASS, Critical 0 / High 0 / Medium 0 / Low 2**. Local runner reported `npm ci` exit 0, 251/251 bounded unit tests passed; Claude process exit 0. The review report is retained privately under `<private-review-dir>/R4/`.
- Low L1: the earlier review log contained private local paths; corrected to non-identifying placeholders in this record. Earlier R1/R2/R3 INCOMPLETE verdicts are preserved as historical observations, **not presented as PASS**.
- Low L2: component's missing-optional-fields notice previously showed the hours-HOLD explanation even if only another optional field was absent; fixed and covered by unit tests in post-R4 commits. Missing actual hours still causes the same copy quality HOLD in the unchanged gate.
- GitHub Actions **run `43815976366`** for the *R4 reviewed SHA* was independently checked after it completed: **success**, all ten jobs success (build, static, unit 1/2 + 2/2 + aggregate, shop-css 1/2 + 2/2, integration with disposable Supabase, e2e, e2e-sales). The Claude review itself saw an older `in_progress` snapshot; that is not a failed CI result.
- **Post-review code edits changed the PR SHA**; obtain both successful CI and another independent code review on the exact final commit before treating the PR as merge-ready. R4's PASS is not transferable to later code changes.

## Protected Scope owner decision (2026-11-16)

The owner explicitly approved reducing required **facts pack intake for demo creation only** from 10 to 4 keys: `name`, `category`, `address`, `description`; the other six become optional and are omitted when unverified (no fabricated placeholders). Evidence: PR #277 conversation comment `6908926087` recording the user's explicit confirmation.

The owner did **not** approve weakening `facts_missing_hours` HOLD, waiving owner copy approval, sending outreach, hosted migration/rollback, publishing unapproved real shop content, or merging this PR to develop/main. Those remain separately gated.

## Completion gate

A new independent reviewer must issue **PASS** (C/H/M=0) against the **final updated code HEAD**; R4 already passed on its specifically pinned earlier commit. Validate all CI jobs and the actual reviewed SHA via GitHub metadata; record independent review and verified findings here. Adding/changing this evidence-only file after PASS does not authorize code changes or merge. Until then status remains INCOMPLETE; no hosted DB writes, migration, deploy, send or merge.
