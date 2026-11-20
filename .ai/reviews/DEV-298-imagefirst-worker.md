# DEV-298 Fresh Review — PR #301 (IMAGE_FIRST worker adapter)

独立 Fresh Reviewer (別コンテキスト)、読み取りのみ・実 Codex なし。判定: PASS at 2498b685a0de0b22b629c9e25a6cf8a8ceca7274 (C0/H0/M0/L5)。L1〜L5 は後続の小 PR 候補（L4: 計画 ID の形式検査、L1: Ctrl-C 時の receipt）。

# Fresh Review: PR #301 (Issue #298 P1, IMAGE_FIRST worker adapter)

- Branch `feature/dev298-imagefirst-worker-adapter`, head `2498b685a0de0b22b629c9e25a6cf8a8ceca7274` (confirmed), base develop `ab543bdb28975fc067c233a5e2b0d3e2173d9203`
- Reviewed: `git diff ab543bdb...HEAD`, 7 files, +899/-9. There are no changes to `.github`, `package.json` or the lockfile. No secrets or model names were added (the only "model" strings are fake-session fixtures in the test).

## Verdict: PASS

Critical 0 / High 0 / Medium 0 / Low 5

## What was checked

**Invocation scope.** The adapter starts the entry only after it has all of the following:
- the lock;
- HEAD == origin/develop with a clean tree (`--untracked-files=all`);
- the packet read with `git show` at HEAD, never from the working tree;
- `readApprovalPacket` approved, with directions exactly `d3`;
- an approval id matching `^hoshigama-imagefirst-d3-\d{8}-\d{2}$`;
- an expiry in the past 0 to 24 h window;
- the §3 d3 pins equal to the fixed constants, and the plan rebuilt from the inputs at HEAD equal to the same constants (shop_id `fictional-bakery-hoshigama`, 6 images);
- no existing worker claim, and the entry ledger precheck passing;
- a private runs dir.

The argv contains only allowlist constants or values taken from the packet at the commit. It is passed as an array to `spawn` without a shell, so there is no shell injection. The entry independently re-checks the commit pin, the packet bytes at the commit against `--expected-packet-sha256`, §10, expiry, the ledger, the sandbox, and the 15 min limit. If HEAD moves between the two checks, the entry refuses and the claim stays burned, so the failure is closed.

**Claim before run.** The claim is made with O_EXCL|O_NOFOLLOW right before the invoke and is never removed. There is no retry loop anywhere. I verified that deleting `claims/` still ends in refusal, because the entry ledger reports `APPROVAL_ALREADY_USED`.

**Environment.** The child receives `childEnvironment` (an allowlist) and `codexEnvironment`, which strips the OpenAI/Codex keys. The ledger dir is computed from the same filtered env the entry sees, so the two use the same ledger.

**Paths.** stateDir, runsDir and ledgerDir must all be outside the repo (`PLACE_INSIDE_REPO`). runsDir must be a real directory, owned by the user, with no group or other permission bits (`RUNS_DIR_UNSAFE`). I checked locally that a 0755 runs dir and a symlinked runs dir are both refused with nothing invoked and no claim. The receipt is written with O_EXCL|O_NOFOLLOW and mode 0600. The run dir is created by the entry, which applies its own checks through `liveContext`.

**Isolation tests.** The change is a narrow, documented exception. Import allowlists were added only for the two new files, with no change to existing entries. New pins:
- only `cycle.ts` may name `image-first-generate` in lib, app, components, scripts, .github or package.json;
- nothing may start `imagefirst-worker.ts` (`ExecStart` included);
- the adapter must not contain `generateImage`, `image-once`, sandbox, Codex, fetch, http, `child_process`, anthropic or openai.

No existing expectation was removed. The pre-existing "nothing starts image-first-generate" grep still passes unchanged.

**bounded-process.** `setEncoding("utf8")` uses the stream's StringDecoder. I verified a split multibyte write: `あいう`×3 written in two pipe chunks decodes correctly. For binary output the behaviour is the same as before: it was already decoded lossily to a utf8 string, and no caller reads binary through it. `MAX_CAPTURE` keeps its string-length semantics, `onStdout` still gets strings, and timeout and process-group kill are unchanged (verified that a timeout still kills: timedOut=true, SIGTERM).

**Mapping doc.** I spot-checked it against curiosity-media at 2e7a673 and it matches:
- `claimBodyImageApproval` with O_EXCL and `EEXIST` → USED;
- `assertOnOriginMain` called after `acquireLock` in `runImageWorker`;
- `CODEX_BLOCKED_ENV`, `codexEnvironment` and `assertChatGptSignIn` in `codex-image.ts`, with the same list in Second Root's `codex.ts`;
- `WorkerDeadline` and `killAllBoundedChildren` in `bounded-process.ts`.

**Runbook.** It does not create or enable a timer or unit, and it does not touch root-owned grants or `cycle.sh`. It does not push to GitHub. The rollback section says not to delete `claims/` or the ledger.

## Findings

### Low

**L1. The worker's own 20 s hard stop pre-empts the entry's grace.** `scripts/sales-design-worker/imagefirst-worker.ts:27-29,45`
- `stopSignals()` in the worker calls `killAllBoundedChildren` and `process.exit(1)` 20 s after the first signal. That contradicts the comment ("25 s for the entry to record the stop") and the `graceMs: 25_000` setting.
- Scenario: Ctrl-C while the entry's Codex child is slow to stop. The worker SIGKILLs the entry's group at 20 s, which is the same moment the entry begins its own 10 s cleanup (`cleanupActiveImageCalls`). The worker then writes no receipt and no audit line.
- Impact is limited: Codex's own grace is 5 s, so the normal abort finishes well before 20 s, and the claim and ledger stay used, so the failure is closed.
- Fix: give the worker a longer hard-exit delay (for example 20 s + 10 s + margin), or fix the comment. Optionally write a minimal "aborted" audit line before exiting.

**L2. Test gaps.** `tests/unit/design-agent/imagefirst-worker/cycle.test.ts`
- Receipt SHA verification is only tested on the success path. There is no test for:
  - a tampered or missing picture, or a count mismatch (`BUNDLE_VERIFY_FAILED`);
  - `RUNS_DIR_UNSAFE`, `PLACE_INSIDE_REPO` or `CLAIM_FAILED`;
  - the CLI process itself, including spawn and env (the E2E replays the entry in-process).
- There is no regression test for the bounded-process UTF-8 split fix.
- I ran throwaway tests for `BUNDLE_VERIFY_FAILED`, `RUNS_DIR_UNSAFE` (0755 and symlink) and claim deletion → `APPROVAL_ALREADY_USED`. All behaved correctly. Fix: add those tests to the PR.

**L3. The state and claims directory is not checked for privacy or links.** `lib/design-agent/imagefirst-worker/cycle.ts:155-170`
- `O_NOFOLLOW` covers only the final path component. A pre-existing loose or linked `claims/` directory is accepted.
- The entry ledger is the backstop, so this cannot lead to a double run. At worst it allows a denial of service or an off-tree marker.
- Fix: apply `privateDir()` to `stateDir` and `stateDir/claims` before claiming.

**L4. `planId` is not format-checked before it goes into argv.** `cycle.ts:281`
- A packet whose plan id starts with `--` makes the entry's `parseArgs` return USAGE after the claim, which burns the approval. This fails closed, but the claim is wasted.
- Fix: validate the plan id (for example `^hoshigama-imagefirst-p3-\d{8}$`) before claiming.

**L5. `packetPins` handles code fences differently from `readApprovalPacket`.** `cycle.ts:118`
- `packetPins` toggles on any fence marker. `readApprovalPacket` matches the fence character.
- The pins are only a cross-check against the independently rebuilt plan and against the entry's own checks, so a desync can only cause a refusal.
- Fix: reuse the same fence logic.

## Tests run (in the review clone, node_modules symlinked)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | 0 errors, 1 warning, which predates this PR (`tests/unit/sales/visual-first-brief.test.ts`) |
| `npm run check:secrets` | 1882 files scanned, no secrets |
| vitest: `imagefirst-worker`, `image-first`, `phase2f-live`, `abort-signal`, `image-autorun`, `design-worker-cycle`, `three-methods/isolation`, `design-image-poc` | 20 files, 590 tests, all pass |
| Manual run: `bounded-process` split-UTF-8 decode | correct |
| Manual run: `bounded-process` timeout kill | still works |
| Manual run: worker CLI in a sandboxed HOME | `NOT_ON_ORIGIN_DEVELOP`, exit 2; with an extra arg, `USAGE`, exit 2; audit file mode 0600; nothing invoked |
| Throwaway extra tests (L2), deleted afterwards | 4/4 pass |
