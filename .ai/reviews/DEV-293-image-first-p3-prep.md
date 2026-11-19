# DEV-293 Fresh Review — PR #296 (IMAGE_FIRST P3 準備)

独立 Fresh Reviewer (別コンテキスト)、読み取りのみ・モデル呼び出しなし。最終判定: Round 4 PASS at 4adae44617a281890e377ba8610dd736a2a68852 (C0/H0/M0)。残り Low: S3 (§10 を誰が埋めたかはコードで判定できない — §10 を埋める変更はオーナーだけが merge する運用)、S4 (fence の長さ)、T1 (runBounded の UTF-8 分割、fail closed)。PR はオーナーの明示承認まで Draft・未統合。

# Fresh review: PR #296 (feature/dev293-image-first-p3-prep @ 0cf96804, base develop 31f09ce9)

## Verdict: FAIL

Critical 0 / High 0 / Medium 1 / Low 5

I found no path that reaches the generator before every pre-approval check has run. I also found no way to reuse an approval or retry a call. The one Medium finding: the approval packet is pinned by its bytes, but the code never reads it. So the "approved packet" and "expiry" checks do not show that the owner approved anything.

## How a run gets from argv to the generator call

`scripts/design-artifact/image-first-generate.ts` main() does these steps in order:

1. `parseArgs`. A duplicate or unknown flag is refused. All 11 values and `--direction d1|d3` are required, and `--expected-prompt-chars` must be an integer. Otherwise it refuses with USAGE (exit 2).
2. `loadPromptInputs` and `buildPromptPlan`. It reads only the 3 pinned inputs, and every path goes through the EXCLUDED_READS check before it is read.
3. The packet must be a file tracked in the repo (`trackedInRepo`), or its bytes are treated as null.
4. `liveContext`: `--out` must be absolute, outside the repo (realpath), with a safe parent, and the out dir is rebased onto the parent's realpath.
5. `runFullPageCall` checks, in order: absolute outDir, RUN_DIR_IN_REPO, the approval ID format and its direction, the expiry, the plan SHA, the batch self-consistency, the packet SHA, the facts and direction SHAs, and the image count (2 to 6). Then `checkBeforeApproval` checks: the human flag, the prompt SHA and length, that the out dir does not exist, that its parent is a real directory, the commit pin (HEAD = origin/develop = expected, clean tree), the abort signal, the preflight (.env check and sandbox), and the ledger precheck.
6. `ledger.reserve`, which takes the approval with an atomic mkdir, then `mkdir` 0700 and the input and prompt writes.
7. One `d.batch` call, which runs `generateImagesInOneRun` in the prepared sandbox.

What I confirmed:
- **Every exit before the reserve returns `stage: "precheck"`.** Nothing is created and nothing is called; the unit tests check this for 17 cases.
- **An approval is used once.** `precheck` refuses an approval it has already seen, and the atomic mkdir in `reserve` stops a second run from using an approval that passed precheck.
- **There is no retry.** `retryOf: null` is hard-coded, and there is no loop around `d.batch`. Every failure ends the run with the approval marked used, and anything other than a complete batch is a hard stop. The batch prompt also tells the model not to retry.
- **The out-dir checks are sound.** A symlinked out dir already exists, so it is refused with OUT_DIR_EXISTS. A symlinked parent is resolved by liveContext, and then `lstat` refuses it if it is a link. A relative path is refused with USAGE or OUT_DIR_INVALID. If the directory appears between the check and the `mkdir`, the run fails closed with OUT_DIR_UNWRITABLE.
- **The packet bytes cannot drift.** The packet is read from the working tree before the commit check, but the clean-tree check that follows means the bytes are HEAD's.

## Findings

### Medium

**M1. The packet's content is never checked, so the packet and expiry checks prove nothing about owner approval.** Files: `lib/design-agent/phase2f-live/full-page-call.ts:91-97` and `scripts/design-artifact/image-first-generate.ts:51-65`.
- **What the code checks:** only that `sha256(packetBytes) === --expected-packet-sha256`. Both values come from the same command line. The approval ID (checked only for format and direction), `--approval-expires`, and `--plan-id` are never compared with the packet's §10 table.
- **Failure scenario:**
  1. The draft packet in this PR is merged as it is, with §10 still "未記入" and the status "未承認".
  2. Someone runs the entry with `--expected-packet-sha256 $(sha256sum docs/design/image-first-hoshigama-p3-packet.md)`, an invented `xx-imagefirst-d1-20261120-01`, `--approval-expires 9999-12-31`, and `--human-approval-confirmed`.
  3. Every pre-approval check passes, and a real Codex image run starts.
- **Consequences:**
  - APPROVAL_EXPIRED only compares the expiry date the caller typed with the clock. It is not checked against the packet, and the date has no upper limit.
  - The header says "the approval packet's bytes are the approved ones", but nothing checks that the packet is approved.
  - The test fixture `PACKET` is arbitrary text, which confirms the content is never parsed.
- **Fix:**
  - Parse the packet's §10 and refuse if any field is still "未記入".
  - Require the approval ID, the expiry, the plan ID and the direction in the packet to match argv.
  - Cap the expiry relative to the date in the approval ID (for example, at most 14 days).
  - Refuse an expiry that is not a real calendar date (see L2).
  - Add tests: the draft packet as it is should be refused, and so should a packet whose ID or expiry does not match argv.

### Low

**L1. The lineage-token check misses the wording d2 itself uses, and the d1 hero asks for a kiln-mouth drawing.** File: `lib/design-agent/image-first/prompt.ts:68,379`.
- `LINEAGE_TOKENS` holds `窯口` and `窯の床`. d2's own text says `窯の口`, which `窯口` does not match.
- The d1 prompts that are sent say "石窯の口の線画" (a line drawing of the stone kiln's mouth) in the hero section (PC pc-1 and the concept text). This is d1's own direction-set text, not d2 material. Because only the chosen object is extracted by id, no d2 text can reach a prompt.
- But the d2 lineage has the same signature motif: its hero is the kiln mouth (`mouth` / ph-mouth). The guard cannot catch paraphrases of it.
- **Fix:** add `窯の口` and `mouth` to the token list, or have the owner explicitly accept the kiln-mouth hero for d1 in the packet.

**L2. The expiry accepts impossible dates and has no limit.** File: `full-page-call.ts:93`.
- `Date.parse("2026-02-31T23:59:59+09:00")` rolls over to March 3, so an impossible date is accepted.
- There is no upper bound on the expiry.
- **Fix:** round-trip the parsed Y/M/D to confirm the date is real, and add a bound (see M1).

**L3. Packet §10 asks for the approved commit, which the packet cannot contain.** File: `docs/design/image-first-hoshigama-p3-packet.md:171`.
- The entry requires the packet to be tracked at HEAD, and HEAD must equal the approved commit.
- So the packet cannot hold that commit's own SHA: filling the field in creates a new commit with a different SHA.
- **Fix:** say that the commit is given only by `--expected-commit`, or record it outside the pinned file.

**L4. The packet doc names an image model.** File: `docs/design/image-first-hoshigama-p3-packet.md:104`.
- §4 names the image model (gpt-image-…). The same name is already in `image-first-handoff.md`, `record.ts` and the imagegen investigation doc, so this follows existing practice.
- I am listing it only because the review brief says "no model names in repo files".

**L5. Results from an aborted batch are discarded and not kept under stopped/.** File: `full-page-call.ts:137-138`.
- If the batch returns and the signal has also fired, the returned pictures and their call facts are thrown away and are not recorded under stopped/. This is conservative (fail closed).
- **Fix (optional):** record the returned facts in call.json.

## Other checks (no finding)

- **Prompt determinism:** the builder is pure apart from the injected reader, and the plan SHA uses canonical sorted JSON. I ran `--print-pin` and got exactly the values in packet §3: plan, batch and direction SHAs, the batch character counts (11943 and 12338), and all 12 per-image SHAs and lengths.
- **d2 exclusion:**
  - The only paths read are facts-pack.json, principles-v1.json and direction-set.json. The full direction set, which does contain d2-hearth-floor, is parsed in memory, but only the chosen object (by id, pinned by SHA) is used, and only for its SHA. No other direction reaches a prompt or the run directory.
  - The EXCLUDED_READS check (fidelity, comps, photo-slots, three-methods pilot-1, s0 selection, `mapping`, the shop name) runs before every read.
  - The Codex sandbox hides the out-dir parent and the ledger.
- **No invented facts:** every quoted string in the prompts is a facts-pack value. The section words come from the d1/d3 direction text, and the "2時間半" (two and a half hours) is derived from the facts (4:30 to 7:00). The prompts forbid prices, awards, history, people and menus.
- **Packet numbers match the code:** 6 images = PC 2 + SP 4 (MAX_BATCH_IMAGES = 6), the section percentages (1.4 weight → 41/71%), the limits (4 first calls, 2 retries, 15 min per call, 2 h per plan), and 1688 = 2 × 844. The packet says "未承認" (not approved) throughout and claims no execution.
- **Changes to existing tests only add exact paths:** the generateImagesInOneRun allow-lists and the phase2f-live and image-first import lists each gain `scripts/design-artifact/image-first-generate.ts` and/or `full-page-call.ts` and `image-first-prompt.ts`. lane.test now splits off the full_page_comp pair and checks the rest exactly. The exemption from the `/design-image/` check is for one exact file and has a named-import check.
- **Forbidden files and test changes:** no `.skip`, `.only` or `.todo`, and no tests deleted. No `.github/`, package.json or lockfile changes, and no secrets.
- **image-once.ts:** an additive optional field `imageCallIds`; no behaviour change.
- **ledger.ts:** an additive kind/route pair. LIVE_LIMITS and the ID rules are unchanged.

## Tests run (scratch clone at 0cf96804, node_modules symlinked)

- `npm run typecheck` (next typegen + tsc --noEmit): exit 0. A bare `tsc --noEmit` without typegen shows the existing PageProps/LayoutProps errors, which are unrelated.
- `npx eslint` on the 14 changed .ts files: exit 0, no output.
- `npx vitest run tests/unit/design-agent/image-first tests/unit/design-agent/phase2f-live` plus every changed test file: 19 files, 521 tests passed (134 s).
- `npx tsx scripts/design-artifact/image-first-prompt.ts --direction d1|d3 --print-pin`: exit 0, and the values match packet §3.
- No network, no model or Codex call, no push, no GitHub comment.

# Round 2 (head 88a2a58c, diff 0cf96804..HEAD)

## Verdict: FAIL

Critical 0 / High 0 / Medium 1 (new) / Low 4

## Round 1 findings

- **M1: resolved.**
  - `readApprovalPacket` now parses §10. A packet that is missing a row, has a repeated row, has an extra row, has a cell still "未記入", or has a status other than `承認済み` is refused with PACKET_NOT_APPROVED.
  - The direction, approval ID, expiry and plan ID in the packet must equal argv exactly, or the run is refused with PACKET_APPROVAL_MISMATCH.
  - I probed the real draft packet: it reads as null, so it is refused. A unit test covers this too.
  - All the new checks sit before `checkBeforeApproval` and `ledger.reserve`, so no new refusal happens after the approval is used.
- **L2: resolved.** `parseUtcInstant` round-trips the date and time: `2026-02-31T00:00:00Z` and `T24:00:00Z` both give null. An expiry more than 24 h ahead of now is refused with APPROVAL_EXPIRY_TOO_FAR (`MAX_APPROVAL_WINDOW_MS` = 24 h).
  - Residual (Low R3 below): the 24 h is measured from *now*, not from when the approval was given. A packet with a far-future expiry simply becomes usable during the last 24 h before it, and is never refused for being old.
- **L3: resolved.** The approved-commit row was removed. §6 and §10 now say the commit is passed only with `--expected-commit`.
- **L5: resolved.** When the batch returns after the stop signal, the run is recorded as aborted, the returned pictures and facts are kept under stopped/, and the result is never a success.
- **L1: resolved, adequately.**
  - `LINEAGE_PATTERNS = /(?<!石)窯の口/` blocks d2's own phrasings ("窯の口から…", "窯の口の弧"), and the `窯口` token stays.
  - Only a "石窯の口" phrasing gets through, which is how d1 itself writes it. No d2 text can reach a prompt anyway, because only the chosen object is used, by id and pinned by SHA. So this guard is a second layer, and it is enough for that.
  - The overlapping kiln-mouth motif is now written in packet §8 as a decision for the owner, which is the right place for it.
- **The prompt pins did not change:** d1 is `3b7fd160…` / `dff5edbf…` / 11943 and d3 is `a19b6896…` / `291475d9…` / 12338, the same as packet §3.

## New findings

### Medium

**M2. A test fixture in the repo is a valid approval packet for the real entry.** Files: `tests/unit/design-agent/phase2f-live/fixtures/image-first-packet-approved.md`, with `scripts/design-artifact/image-first-generate.ts:53-54`.
- **Why it passes:**
  - The entry accepts any `--packet` that is a file tracked in the repo.
  - The fixture is tracked. Its §10 is fully filled in: status `承認済み`, `d1`, `test-imagefirst-d1-20261120-01` (matches APPROVAL_FORMAT), `test-imagefirst-plan-01` (matches PLAN_ID), and expiry `2026-11-20T12:00:00Z`.
  - That expiry is within 24 h of today (2026-11-19), so the expiry checks pass until it lapses.
- **Failure scenario:**
  1. This PR is merged to develop before 2026-11-20T12:00Z.
  2. Someone runs `image-first-generate.ts --packet tests/unit/design-agent/phase2f-live/fixtures/image-first-packet-approved.md` with the fixture's ID, expiry and plan ID, its SHA, the §3 prompt and plan pins, the develop HEAD, and `--human-approval-confirmed`.
  3. Every check before the approval passes, and a real Codex image batch starts with no owner approval.
- **Ongoing risk:** any later edit to the fixture that moves its expiry (for example to keep tests working) opens the same hole again. The fix for M1 is bypassed by pointing at a different file.
- **Fix:**
  - Allow only an exact list of packet paths, for example `docs/design/image-first-*-packet.md` (or exactly `docs/design/image-first-hoshigama-p3-packet.md`), refuse anything under `tests/`, and add a test for this.
  - Or keep the "approved" fixture untracked: build it in a temp dir inside the test.
  - Also make the fixture's values impossible to use for real, for example an approval ID the CLI refuses, or an expiry already in the past with the test's NOW moved to match.

### Low

**R1. The parser takes only the first `## 10.` heading, including one inside a code fence.**
- I probed this. A fake §10 inside an earlier fenced block is read instead of the real one: when the fake is unfilled, the packet is refused, which fails closed. But an earlier fenced *example* filled with approved values would be accepted even if the real §10 is still 未記入.
- A second §10 after the first is ignored.
- The packet is written by the owner and pinned by SHA, so this would take a mistake by the owner.
- **Fix:** skip lines inside fences, and refuse a packet with more than one `## 10.` heading.

**R2. The header can still say 未承認 while §10 says 承認済み.**
- The header line "**状態: 未承認。**" is not checked, so a packet whose §10 says `承認済み` passes while its header still says "未承認" (not approved).
- **Fix (optional):** refuse a packet whose header still says 未承認, or tell the owner to change the header too.

**R3. The expiry window does not limit the approval's age.**
- The 24 h is measured from now, and the expiry is not tied to the date in the approval ID.
- **Fix:** also require the expiry to fall within N days of the approval ID's YYYYMMDD.

**R4. `--print-pin` output is cut off when piped.**
- `image-first-prompt.ts --print-pin | python3 -c json.load` failed with an unterminated JSON string at about 16 KB, for both d1 and d3. Redirecting to a file works.
- The likely cause is `process.exit` before stdout drains to a pipe.
- The packet tells the owner to read the prompts from this output, so piping it into `less` or `jq` would show a cut-off prompt.
- **Fix:** set `process.exitCode` instead of calling exit, or write with a callback before exiting.

## Checks with no problem

- **Parser input variants:**
  - A full-width space after the status is trimmed, which is harmless.
  - A status in backticks is accepted.
  - A label with a half-width paren, or a value containing `|`, fails closed because the row goes missing.
  - Extra rows from a `###` subsection fail closed through the row-count check.
  - Approval IDs in the packet are compared exactly with argv, and argv is format-checked.
- **No refusal after the reservation:** every new check comes before it.
- **The tests stay stub-only:** no `skip` or `only`, and no workflow, package.json or lockfile changes.

## Tests (round 2)

- `npm run typecheck`: exit 0.
- `npx eslint` on the changed .ts files: exit 0.
- `npx vitest run tests/unit/design-agent/image-first tests/unit/design-agent/phase2f-live` plus every changed test file: 19 files, 540 tests passed.
- The `--print-pin` pins match packet §3 (written to a file).
- Probes of `readApprovalPacket` and `parseUtcInstant` on the real packet, the fixture and edited variants, run as a temporary script that I deleted afterwards. The working tree is clean.

# Round 3 (head 16e036bd, diff 88a2a58c..HEAD)

## Verdict: PASS

Critical 0 / High 0 / Medium 0 / Low 4. One of the Lows (S1) should be fixed before the owner fills in the packet.

## Earlier findings

- **M2: resolved.**
  - The tracked "approved" fixture is deleted. The test now builds its packet in a temp dir, and a test asserts the fixtures dir is gone.
  - `runFullPageCall` now runs `realpath(packetPath)` and requires `relative(realpath(repoRoot), packetReal) === "docs/design/image-first-hoshigama-p3-packet.md"`, or it refuses with PACKET_PATH_NOT_ALLOWED. This check runs before `checkBeforeApproval` and the reserve, so nothing is used.
  - Tests cover a file under tests/, another doc, a copy outside the repo, and a missing path.
  - Later edits to test fixtures can no longer open the hole, because only that one path is accepted.
- **Ways around the path check, and why each fails:**
  - **A symlink placed at the allowed path:** realpath resolves to the target, so the run is refused. And if it is not committed, the tree is dirty, which fails the commit pin.
  - **A symlink elsewhere pointing to the allowed file:** realpath gives the allowed file, and the bytes are read through the link from that same file. That is fine.
  - **A symlinked repo directory:** handled, because `repo` is realpath'd too.
  - **A hard link elsewhere:** its own path does not match, so it is refused. A hard link at the allowed path must still hold HEAD's content, or the clean-tree check fails.
  - **The `packetBytes` seam:** `runFullPageCall` is imported only by the CLI (isolation test). The CLI reads the bytes from the same resolved `--packet` path it passes as `packetPath`, and a test checks that wiring.
- **R1: resolved.** The parser ignores fenced lines, refuses an unclosed fence, and requires exactly one `## 10.` heading outside fences. I probed it: a filled example in a fence does not stand in for an unfilled §10, and a second §10 is refused.
- **R2: resolved.** The header must not contain 未承認 anywhere, and must say "状態: 承認済み" exactly once. But see S1.
- **R3: documented, not changed.** §10 now says the 24 h is counted from launch and that the owner re-approves after a gap. That is acceptable.
- **R4: resolved.** It now sets `process.exitCode`. `--print-pin | python json.load` parses in full (d1 plan `3b7fd160…`, unchanged).
- **The real packet is still refused** (`readApprovalPacket` returns null).

## New findings (Low)

**S1. Following the packet's own instructions still leaves it refused; fails closed, but blocks the real approval.** File: `docs/design/image-first-hoshigama-p3-packet.md:5`.
- §10 tells the owner to change the title and line 3 ("状態: 未承認") to 承認済み.
- But line 5 also contains 未承認, in explanatory prose: "§10 が未記入・未承認なら、…". It is above the first `## ` heading, so it counts as header.
- I probed the real packet with the title, line 3 and every §10 row filled in exactly as instructed. It still returns null (PACKET_NOT_APPROVED). Once line 5 was reworded as well, it parsed correctly.
- Nothing is used, because this is a pre-approval refusal. But the owner would hit a misleading refusal on the real run.
- **Fix:** move that sentence below the first `##` heading, or reword it so it does not contain 未承認. Add a test that fills in the real packet as instructed and expects it to parse.

**S2. The packet bytes are read from the working tree before the commit and clean-tree check.** File: `scripts/design-artifact/image-first-generate.ts:53-54`.
- A process of the same user that rewrites the file between the CLI's read and the `git status` in `checkBeforeApproval`, then restores it, could feed in bytes that are not HEAD's.
- This needs a deliberate race. It fits the ledger's stated "accident prevention" threat model.
- **Fix:** after the commit pin passes, read the packet with `git show <expected-commit>:docs/design/image-first-hoshigama-p3-packet.md`, or re-read the file and compare the bytes.

**S3. Process gap: the code cannot tell who filled in §10.**
- Any merge to develop that fills in §10 counts as approval. Under CLAUDE.md, Development Claude merges feature → develop on its own.
- The run itself still needs the owner's WSL (Codex sign-in) and `--human-approval-confirmed`, so the practical risk is low.
- **Recommendation:** treat any change that fills in §10 as Protected Scope that only a human merges, for example with CODEOWNERS or a CI check that refuses 承認済み in a PR not by the owner.

**S4. Fence parsing nit.**
- A closing fence is matched by character only, not by length (CommonMark needs the closing fence to be at least as long as the opening one).
- A ```` opening fence closed early by ``` would make the parser read lines that are meant to be fenced. Combined with the single-§10 and row-count rules, this fails closed in practice.

## End-to-end re-read (argv → generator)

1. **Argument parsing:** USAGE.
2. **Prompt inputs and plan:** PromptStop.
3. **Packet:** must be tracked, then the bytes are read.
4. **liveContext:** the out dir must be outside the repo, with a safe parent.
5. **runFullPageCall checks:** the out-dir checks, the approval ID's direction, the expiry (valid date, not past, at most 24 h ahead), the plan pin, the packet path allowlist, the packet SHA, the parsed header and §10 (approved, and matching the direction, approval ID, expiry and plan ID), the facts and direction pins, the image count.
6. **checkBeforeApproval:** the human flag, the prompt pin, the out dir, the commit pin (HEAD = origin/develop = expected, clean), abort, preflight, ledger precheck.
7. **Reserve:** an atomic one-use mkdir.
8. **One batch:** no retry.

I found no path that skips a check. Every refusal comes before the reserve. The only remaining way to start a run without the owner's approval is the S3 process gap (§10 filled in by someone other than the owner and merged to develop), plus the S2 race. Neither can be closed in code here without signing the approval.

## Tests (round 3)

- `npm run typecheck`: exit 0.
- `npx eslint` on the changed .ts files: exit 0.
- `npx vitest run tests/unit/design-agent/image-first tests/unit/design-agent/phase2f-live` plus the changed test files: 19 files, 547 tests passed.
- `--print-pin` piped into a JSON parser works, and the pins are unchanged.
- Probes of `readApprovalPacket` on the real packet, the real packet filled in as instructed, and fence variants, run as a temporary script that I deleted afterwards. The working tree is clean.

# Round 4 (head 4adae446, diff 16e036bd..HEAD; scope: the changes plus regressions)

## Verdict: PASS

Critical 0 / High 0 / Medium 0 / Low 1 (new) + S3/S4 carried over from round 3 (unchanged; one process gap, one nit).

## S1 and S2

- **S1: resolved.**
  - The draft-status prose is gone from the title and the explanatory text. The only place left that says 未承認 above the first `##` heading is the line `**状態: 未承認。**`, so the real draft is still refused.
  - A new test fills in the real packet exactly as §10 says (rewrite the status line, then fill each row) and gets the expected `ApprovalPacket`.
- **S2: resolved.**
  - `packetBytes` is removed from the input. The packet is now read through `deps.packetAt(i.expected.commit, APPROVAL_PACKET_PATH)`, called only after `checkBeforeApproval` succeeds: HEAD = origin/develop = expected, and the tree is clean.
  - The path read is the constant, never the argv path. `--packet` is only checked by realpath against that constant.
  - The CLI wires `packetAt` to `fileAtCommit`. A test shows that a clean-tree or commit-pin failure means `packetAt` is never asked. A source test shows the CLI no longer calls `readFile(packet)`, `packetBytes` or `trackedInRepo`.
- **No refusal moved after the reservation.**
  - The PACKET_PIN_MISMATCH, PACKET_NOT_APPROVED and PACKET_APPROVAL_MISMATCH checks now sit between `checkBeforeApproval` and `ledger.reserve`. They still return `stage: "precheck"` and use nothing.
  - `checkBeforeApproval` writes nothing: the ledger precheck is read-only, and the preflight only prepares the sandbox. So moving these checks later uses no approval.
  - PACKET_PATH_NOT_ALLOWED is still checked early.

## fileAtCommit (scripts/design-artifact/phase2f-live-cli.ts:260-264)

- **No shell injection:** it calls `spawn("git", [...])` with an argv array, and no shell option is set (`bounded-process.ts:84`).
- **Commit validation:** the commit must be 40 lowercase hex characters, so `HEAD` and ref names return null.
- **Path validation:** the path must match `[A-Za-z0-9._/-]+`, must not start with `-`, and must have no `..` segment.
- **Argument form:** the argument is `<sha>:<path>`, which starts with hex, so git cannot take it as an option. I probed `--output=x`, `a/../b` and a directory path: each returned null.
- **No conversion filters:** it uses `--no-textconv`.
- **Environment:** it uses `childEnvironment`, an allowlist that passes no GIT_DIR or other GIT_* variables.
- **Timeout:** 60 s, as runBounded is called with timeoutMs: 60_000.
- **Callers:** `packetAt` is always called with the constant path and the commit already checked against HEAD.
- **Correctness:** it returns the exact committed bytes. I probed the real packet at HEAD and got the same SHA as the file. A test also shows it reads the committed bytes rather than the working tree, and refuses `HEAD`, `../x` and a missing path.

## Changed assertion (prompt.test.ts:210)

- The old check was `toContain("**未承認**")` on the whole text. The new one is `toContain("**状態: 未承認。**")`, limited to the text before the first `\n## `.
- That is narrower and closer to what the parser actually reads (the header). It still fails if the draft's status line is changed or removed.
- **Meaningful:** yes.

## New finding (Low)

**T1. `fileAtCommit` rebuilds the bytes from a string that was decoded one chunk at a time.**
- `runBounded` decodes each stdout chunk with `chunk.toString("utf8")` separately (`bounded-process.ts:155`), and `fileAtCommit` re-encodes the result with `Buffer.from(r.stdout, "utf8")`.
- If a 3-byte Japanese character is split across two pipe reads, it decodes to U+FFFD. The SHA then differs, and the run is refused with PACKET_PIN_MISMATCH even though the packet is correct.
- This fails closed and uses nothing. It did not happen in my probes: the 19 KB packet, a 23 KB and a 46 KB Japanese doc all round-tripped with matching SHAs. But it is not guaranteed.
- **Fix:** collect stdout as Buffers for this call, or have git write to a temp file (for example `git cat-file blob <sha>:<path>` with output captured as a Buffer).

## Tests (round 4)

- `npm run typecheck`: exit 0.
- `npx eslint` on the changed .ts files: exit 0.
- `npx vitest run tests/unit/design-agent/image-first tests/unit/design-agent/phase2f-live` plus the changed test files: 19 files, 550 tests passed.
- Probes of `fileAtCommit` on the real packet at HEAD, inputs shaped like options, and larger Japanese files, run as a temporary script that I deleted afterwards. The working tree is clean.
