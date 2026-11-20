# DEV-293 Fresh Review — PR #299 (approval-packet tests independent of the real packet's state)

独立 Fresh Reviewer (別コンテキスト)、読み取りのみ。判定: PASS at 52a7a46c250473f5ac9626c78c9b03ab3d8ea7a5 (C0/H0/M0/L3)。tests/ の4ファイルだけ。

# Fresh review — PR #299 (feature/dev293-packet-tests-state-independent)

- HEAD confirmed: `52a7a46c250473f5ac9626c78c9b03ab3d8ea7a5` (1 commit on base develop `6dbcff8a`)
- Diff scope: 4 files, all under `tests/` (2 new fixture files, 2 test files). No gate code, parser, ledger, CLI, docs or production change.

## Verdict: PASS (Critical 0 / High 0 / Medium 0 / Low 3)

## Checks

### Tests-only, nothing deleted or skipped
- `git diff --stat`: only `tests/unit/design-agent/image-first/{prompt.test.ts,fixtures/unapproved-packet.ts,fixtures/image-first-packet-unapproved.md}` and `tests/unit/design-agent/phase2f-live/full-page-call.test.ts`.
- The 4 removed `it(...)`/`describe(...)` lines are renames. No `.skip` or `.only` added.
- Every removed `expect` has a replacement that is as strict or stricter:
  - prompt.test.ts: "real packet header contains 未承認" → the fixture keeps the exact check and adds `headerStatuses == ["未承認"]` and `§10 状態 == 未記入`. The real packet now must have exactly one header status, and the header and §10 must agree (未承認 means §10 未記入; 承認済み means §10 承認済み). The used-approval and no-prompt-text checks are still applied to the real packet.
  - full-page-call: `REAL_PACKET → PACKET_NOT_APPROVED` → the same check against the fixture. `readApprovalPacket(REAL_PACKET) null` → the same check against the fixture, and still asserted on the real packet in its draft branch.
  - The two "real packet filled for d1 / d3" tests → the same fill logic (now `fillUnapproved`) with the same row-regex assertions. It runs on the fixture, and the `toEqual` and invalid-direction asserts are unchanged.
- New: a d3-only fixture is filled in memory and run with a stub batch. The run succeeds once with 1 call. A d1 run is refused `PACKET_APPROVAL_MISMATCH` at precheck, with no call and no ledger entry. A second run is refused `APPROVAL_ALREADY_USED`.

### Unapproved fixture
- It is byte-identical to develop's `docs/design/image-first-hoshigama-p3-packet.md` (`cmp` passes). Its SHA-256 `d26a807f…622e` matches the pin.
- Appending one byte to the fixture makes 2 tests fail, so the pin works.
- The real entry cannot use it. `runFullPageCall` refuses any path other than `APPROVAL_PACKET_PATH` (`lib/design-agent/phase2f-live/full-page-call.ts:196`). It reads the packet bytes only through `packetAt(commit, APPROVAL_PACKET_PATH)` (`:210`).

### Real-packet invariants (full-page-call.test.ts:390-430, prompt.test.ts:215-228)
- Mutation results, each run on top of the d3 fill:
  - M1, approved for `d1,d3`: 1 test fails.
  - M2, approved for `d1` only: 1 fails.
  - M3, header 承認済み with §10 unfilled: 2 fail.
  - M4, header 未承認 with §10 filled: 2 fail.
  - M5, §10 状態 row 未記入 with the rest filled: 2 fail.
- The "no .md under tests reads as approved" guard works. With an approved packet placed at `tests/tmpx/deep/x.md`, the guard test fails and names the file.

## Findings

- **Low-1**, full-page-call.test.ts:342-343. The no-approved-packet guard only scans `*.md` under `tests/`. An approved packet saved as `.txt`, or under `docs/` at a path other than the real one, would not be caught. Impact: none on the gate, because the entry pins the path and reads the bytes from git at the approved commit. The guard is extra protection only. Fix (optional): also scan `.txt` files, or scan every tracked `*.md` except `APPROVAL_PACKET_PATH`.
- **Low-2**, full-page-call.test.ts:369-388. The d3-only fixture test covers d1 refusal, success and used ID. For expiry (`APPROVAL_EXPIRED` / `APPROVAL_EXPIRY_*`), packet/prompt/plan SHA mismatch, `COMMIT_PIN_MISMATCH` and retry, it relies on the existing tests built on the synthetic d1 `PACKET`. The gate code does not depend on direction, so the coverage is equivalent. Fix (optional): add an `it.each` of the d3 run with a past expiry, a different `packetSha256`, a different commit, and `d3` with the d1 ID.
- **Low-3**, full-page-call.test.ts:404-429. In the draft branch, the real packet is checked only for its row labels, each row containing 未記入, and the header. It is no longer filled by the row regex the way the old test did. If the draft's row formatting drifted from the fixture, nobody would notice until the owner fills it in. At that point the approved branch catches it, because `readApprovalPacket` must be non-null. Fix (optional): in the draft branch, also run the `fillUnapproved` regexes against the real text.

## Tests run
- vitest `tests/unit/design-agent/image-first` and `tests/unit/design-agent/phase2f-live`:
  - (a) As-is: 14 files, 290/290 passed.
  - (b) With `d3-packet-fill.diff` applied: 290/290 passed. Reverted afterwards.
  - Control: develop's test files with the fill applied: 5 failed, which confirms the PR fixes the problem.
- Mutations M1-M5, the fixture byte flip and the tests/ approved-.md plant all fail as expected. Everything was reverted, and `git status` was clean.
- `npm run typecheck`: exit 0.
- `npm run lint`: 0 errors, 1 warning. The warning predates this PR and is not in the diff (`tests/unit/sales/visual-first-brief.test.ts:5`).
- `npm run check:secrets`: no secrets found (1877 files).
