独立 Fresh Review PASS at 08983f99 (C0/H0/M0/L3)

# Fresh review: PR #303 (fix/imagefirst-worker-preclaim-guards)

Head `08983f996435943d61075c3a5dc183b16c53f620`, base develop `cca37636`. Read-only review: no push, no comments, no model calls.

## Verdict: PASS (C0 / H0 / M0 / L3)

Diff: `lib/design-agent/imagefirst-worker/cycle.ts` (+5) and `tests/unit/design-agent/imagefirst-worker/cycle.test.ts` (+22/-1, which only extends the import line). No `.github`, package or lockfile change. No test deleted, skipped or `.only`'d. No secrets.

## Plan ID check (cycle.ts:53, 244)

- The new rule is `PLAN_ID = /^hoshigama-imagefirst-p3-\d{8}$/`.
- It is strictly tighter than every rule the plan ID meets later:
  - the ledger rule `^[a-z0-9][a-z0-9._-]{3,63}$`, at ledger.ts:41, which `precheck` uses and which `reserve` uses again in the entry;
  - `parseArgs` refusing values that start with `--` (phase2f-live-cli.ts:65);
  - the record rule `^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$` (image-first/record.ts:104);
  - the entry's `packet.planId === --plan-id` equality (full-page-call.ts:216), which holds because both sides come from the same packet bytes.
- Nothing that passes here can fail the entry's format or argv checks later. The rule matches the packet's documented example (`docs/design/image-first-hoshigama-p3-packet.md:182`).
- Note: before this PR, the cycle's own `ledger.precheck` (cycle.ts:269) already rejected `--…` plan IDs before the claim. The new check adds earlier, stricter scoping. It loosens nothing.

## Claims directory check (cycle.ts:274)

- `privateDir` (cycle.ts:175-179) runs `mkdir -p 0700`, then `lstat`. It requires a real directory, not a link, owned by our uid, with mode `& 077 === 0`.
- It now covers both `stateDir` and `stateDir/claims`, before `claim()` makes the O_EXCL+O_NOFOLLOW marker.
- Using `lstat` (not `stat`) is correct. A symlinked `claims` survives the recursive mkdir (EEXIST), is then caught as a link, and nothing is written outside. The test checks this.
- The worker CLI sets `umask 077` and `acquireLock` creates `stateDir` as 0700. Normal installs therefore pass, so this is no functional regression.

## Findings (all Low)

**L1. The parent chain is not checked, and there is a TOCTOU window.** cycle.ts:274, 157-161
- Only the leaf `stateDir` and `claims` are checked. An ancestor such as `~/.local/state/sr-design-worker` is followed by `lstat` if it is a link.
- Between the `privateDir` check and `mkdir`/`open` in `claim()`, the path is re-resolved. Only the same uid (or root) could swap it, because the checked dirs are 0700 and ours.
- Impact is low: the entry ledger's own `approvals/<id>` mkdir is still the one-use backstop. The ledger's `ownDir` has the same leaf-only pattern.
- Optional fix: open `claims` once with O_DIRECTORY|O_NOFOLLOW and create the marker relative to it. Or `fstat` the opened marker's parent before writing.

**L2. Test gaps.** cycle.test.ts:304-315
- The loose-claims case does not assert that no marker was created (`readdirSync(claims)` should equal `[]`).
- There is no case for a loose or symlinked `stateDir` itself, even though cycle.ts:274 checks it.
- Fix: add those two assertions or cases.

**L3. One refusal code for two different failures.** cycle.ts:244 and ledger.ts:160
- The cycle's new `PLAN_ID_INVALID` and the ledger precheck's `PLAN_ID_INVALID` are the same code.
- Two of the four test inputs (`--other-flag`, `../wrong-plan`) would also have been refused by the ledger before this PR. The other two (`hoshigama-imagefirst-p3-wrong`, `other-imagefirst-p3-20261120`) do prove the new line.
- A mutation run confirms this: deleting the new line makes the test fail.

## Do the tests prove the refusals happen before the claim and the image call?

Yes. `refusedWith` asserts all of the following:
- `invoked === false`;
- the invoke stub recorded no call;
- fake Codex `execs === 0`;
- no ledger `approvals/`;
- an empty `runsDir`.

The plan ID test also asserts that no `claims/` directory exists. The symlink case asserts the outside target stays empty.

Mutation check: I deleted the two new guard lines from cycle.ts and re-ran the two new tests. Both FAILED. I then restored the file, and the tree is clean.

## Tests run (review clone, node_modules symlinked)

| Command | Result |
|---|---|
| `npm run typecheck` (+ `tsc --noEmit`) | pass |
| `npm run lint` | 0 errors, 1 warning that predates this PR (`tests/unit/sales/visual-first-brief.test.ts`) |
| `npm run check:secrets` | 1883 files scanned, no secrets |
| vitest: `imagefirst-worker`, `image-first`, `phase2f-live` | 15 files, 307 tests, all pass |
| Mutation: new guards removed | both new tests fail, as expected |
