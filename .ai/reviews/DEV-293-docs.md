# DEV-293 / PR #294 (docs) — Independent Fresh Review record

**Verdict: PASS** (Critical 0 / High 0 / Medium 2 / Low 5). Separate-context Fresh Reviewer, read-only review.

- Reviewed head: `f0898ee` (branch `feature/dev293-codex-image-first-contract`), base `develop` `492d1f4`.
- Change: `docs/design/design-first-workflow-decision.md` only (+31 lines, new section "2026-11-19 追補"). No code, tests, workflows, config or `.ai/` state changed.
- Merge check: `develop` has since advanced to `4744cfb` (PR #292 merge, d2-v3 assets/tests/review only; it does not touch this doc). `git merge-tree HEAD origin/develop` is clean.
- Lint: not run (no `node_modules` in the review worktree; ESLint does not cover Markdown). Docs-only, so no tests are required.

## Checks

| Check | Result |
|---|---|
| G2 = model-generated full-page PC1440/SP390 design images, distinct from HTML screenshots, photo-only and hero-only images | OK |
| PC1440 and SP390 are independent compositions; section-sequence spec fixed **before** generation if one long image is impossible | OK (matches Issue #293 P1.3) |
| Owner reviews the actual image and adopts it before Claude implements | OK |
| Visual gate: no hard fail, ≥22/25, every item ≥4 | OK — same thresholds as the G2 row and `design-image-eval-template.md`; not relaxed |
| d2-v3 (Issue #290 / PR #292) kept as a separate LAYOUT_FIRST comparison, not a Codex-image-first proof; original artifacts/SHAs unchanged | OK |
| d2-v3 visuals not shown to the image-first G2 designer | OK |
| No real model calls / image generation / billing / WSL without separate approval; individual approval packet listed | OK (packet items match Issue #293 P2) |
| Used approval IDs not reusable | Mostly OK — see L3 |
| Issue #180 blind X/Y/Z mapping not opened, guessed or published | No mapping revealed or speculated. Wording of the sealing condition — see M2 |
| Consistency with `quality-first-process.md` (owner judgment on PC/SP real images; success-DB only on owner adoption; real Codex needs separate approval) | OK, no contradiction |
| Protected Scope / gates / thresholds / Production / develop→main | No change; out-of-scope list is explicit |

## Findings

### Medium

**M1 — "事前に技術検証する" can be read as permission for a real Codex call.** Issue #293 P0 says the capability check is an audit of existing code / CLI spec / history, with no model calls, and must not assert capability or cost while unverified. Proposed text (G2 bullet 2):

> Codex CLI/モデル/画像ツールが実際にこの出力を返せるかは、まず既存コード・CLI仕様・実行履歴の**読み取り監査（モデル呼出なし）**で確認し、未確認のまま「生成できる」「費用はいくら」と断言しない。画像なし（CODEX_NO_IMAGE等）・HTML回答だけ・短尺のみ・出典不明・別店舗・プロンプト/SHA不一致は失敗扱いで停止する（fail closed）。

**M2 — Issue #180 sealing adds a release condition the Issue does not have.** "方式との紐付けをユーザーが明示要求するまで開示しない" says "do not disclose", not "do not open", and adds an unlock condition; Issue #293 says 「絶対に開かず、方式対応の推測・公開もしない」. Proposed text:

> 既存X/Y/Zの盲検対応表は未開封のまま封印する。**開封せず、方式との対応を推測・公開もしない**。

### Low

- **L1** The original policy (main path line, roles table) names ChatGPT as the image designer; the addendum says "Codex". This is consistent with the existing "G2の実行経路" paragraph (WSL Codex CLI, `sr-designgen` ChatGPT sign-in), but one clarifying clause would help: 「ここでのCodexは、上記『G2の実行経路』のWSL上Codex CLI経路を指す。別経路は取り込み設計と承認を先に決める」.
- **L2** The VISUAL_FIRST step "店独自のArt DirectionとPC/SP全ページ計画" does not mention G1's two different compositions. The section says it keeps the policy above, so this is not a relaxation; consider 「（G1の構図の異なる2案を経た）」.
- **L3** 「ほし窯で使用した一回限りの写真生成承認は使用済み。新しい承認IDでも再実行しない。」 could be read as also forbidding the P3 G2 full-page generation for the same ほし窯 facts. It also does not state the general rule. Proposed text: 「ほし窯d2-v3用の写真生成承認は使用済みで、**使用済み承認IDは再利用しない**。d2-v3用写真の生成は新しい承認IDでも再実行しない。P3のG2全ページ画像生成は、別の個別承認パケットでのみ扱う。」
- **L4** "正式な成功例への採用が確認されるまで" is passive. Issue #293 says registration happens only when the owner explicitly adopts it. Proposed text: 「オーナーが成功例として明示的に採用するまで」.
- **L5** Small omissions against Issue #293. The immutable record lacks the output type `MODEL_GENERATED_FULL_PAGE_COMP`, the image call ID and the generation time (P1.1). The out-of-scope list lacks "生成画像・写真をGitHubへpushしない" and "DM・メール送信". Reuse of the three approved photos "追加の権利条件に抵触しない範囲で" is not mentioned. Also, there are two blank lines before `---` (cosmetic).

## Conclusion

Critical/High = 0, so the docs PR passes Fresh Review. M1/M2 are wording fixes on safety boundaries and should be applied before merge. If they are applied as proposed (text-only), they do not change the verdict. A changed head still needs CI on the latest commit before feature→develop.

---

## Round 2 — reviewed head `d6a34e0`

**Verdict: PASS** (Critical 0 / High 0 / Medium 0 / Low 1). Same separate-context Fresh Reviewer, read-only.

- Range reviewed: `f0898ee..d6a34e0`. Commit `d6a34e0` touches only `docs/design/design-first-workflow-decision.md` (+7/−8). `ba67b9a` is this record. I also re-read the whole 2026-11-19 addendum against Issue #293.
- Merge check: `origin/develop` is still `4744cfb`, and `git merge-tree HEAD origin/develop` is clean.
- Lint and tests: not run. The change is docs-only, and there is no `node_modules` in the worktree.

### Resolution of round 1 findings

| ID | Status | Note |
|---|---|---|
| M1 | Resolved | The capability check is now a read-only audit of code, CLI spec and history, with no model call. It must not assert capability or cost while unverified, and fails closed. |
| M2 | Resolved | The mapping stays unopened and sealed: "開封せず、方式との対応を推測・公開もしない". The unlock condition is removed. No mapping is revealed or guessed anywhere in the doc. |
| L1 | Resolved | "Codex" is tied to the existing WSL Codex CLI path in "G2の実行経路". Any other path needs its intake design and approval first. |
| L2 | Resolved | The VISUAL_FIRST path now says "G1の構図の異なる2案を経る". |
| L3 | Resolved | Used approval IDs are never reused. The d2-v3 photos are not regenerated. G2 full-page generation needs a separate approval packet. |
| L4 | Resolved | The doc now says "オーナーが成功例として明示的に採用するまで". |
| L5 | Resolved | Added: `MODEL_GENERATED_FULL_PAGE_COMP`, image call ID, generation time, DM/email and GitHub push of images/photos as out of scope, and reuse of the three approved photos within their rights. The double blank line is removed. |

### Re-check vs Issue #293 and the rest of the policy

- Each G2 point is stated and matches the Issue:
  - full-page PC1440/SP390 model images, which are neither HTML screenshots nor photo-only images;
  - owner adoption before implementation;
  - visual gate of no hard fail, ≥22/25, each item ≥4, unchanged;
  - d2-v3 is a separate comparison, not a proof, and is hidden from the G2 designer;
  - no real calls, generation, billing or WSL work without a separate approval packet.
- None of the new text weakens any gate, threshold or Protected Scope item. There is no contradiction with the G0–G6 table, Identity Lock or `quality-first-process.md`.

### Findings

- Critical: none
- High: none
- Medium: none
- Low:
  - **R2-L1 (optional)**: "P3のG2全ページ画像生成" uses the Issue's phase label "P3", which this doc never defines. Suggested text: 「Issue #293 P3のG2全ページ画像生成」. Non-blocking.

### Conclusion

Critical/High/Medium are all 0, so PR #294 passes Fresh Review at `d6a34e0`. CI must still pass on the latest head before feature→develop. Changing R2-L1 alone (text-only) does not need another review round.

---

## Round 3 — reviewed head `b9d3b69`

**Verdict: PASS** (Critical 0 / High 0 / Medium 0 / Low 3). Same separate-context Fresh Reviewer, read-only. I did not open Issue #180's blind X/Y/Z mapping, and I did not open any Codex prototype output, `answer.json` or `quarantine/`.

### Commits reviewed since round 2 (`efd06c5`)

- `38d7844`: text now reads "Issue #293 P3のG2全ページ画像生成". This resolves R2-L1.
- `4afb6e3`: merge of `develop` `4744cfb`. `git diff origin/develop 4afb6e3` shows only this PR's two files (`docs/design/design-first-workflow-decision.md` and this record). The merge adds nothing beyond develop. `origin/develop` is still `4744cfb`.
- `b9d3b69`: docs-only (+2/−2 lines). It renames the main route to IMAGE_FIRST (output kind `MODEL_GENERATED_FULL_PAGE_COMP`) and adds a note on what the image tool can do.

### Claims verified against the repository (read-only)

| Claim in `b9d3b69` | Evidence | Result |
|---|---|---|
| Issue #180 "VISUAL_FIRST" means Codex's HTML prototype | `docs/design/three-methods-pilot-plan.md` §0: "VISUAL_FIRST — Route C (Codex の HTML 試作 + 画像ちょうど1枚)". `lib/design-agent/three-methods/visual-first.ts` header: "Codex's HTML prototype … is the design original" | Accurate. The route also has exactly one picture, which the doc leaves out; not misleading |
| DEV-139 `prepare-visual-first` is a different route (Claude comp + photos) | `scripts/sales/demo-version/prepare-visual-first.ts` is an offline handoff of the PC/SP and photo plan for the photo-integrated route; it generates no comp. `docs/operations/dev139-visual-first-photo-route.md` | Accurate in substance. Wording — see R3-L2 |
| `image-once.ts` cannot set size or quality | `lib/design-agent/design-image/image-once.ts` runs `codex exec … -c features.image_generation=true` and takes only `prompt`; there is no size or quality parameter. `docs/operations/design-image-poc.md` says "the image tool's sizes are limited" | Accurate. Size can only be asked for in the prompt text |
| Outputs so far reach about 1.5 aspect at most | Recorded outputs are 1024×1536 / 1536×1024 (`design-dna-foundation.md`, `design-image-assets.md`, `comp-to-site.md`, `hoshigama-one-time-run-sheet.md`) | Accurate. The doc also says it is unverified whether a newer CLI version changes this |
| A per-viewport, pre-defined section-image sequence with seam checks is the standard | Consistent with Issue #293 P1.3: define the sequence and its seam quality **before** generation; PC and SP are each full-page and independent | Consistent. Not a relaxation: still full-page, still no PC downscale used as SP |

### Consistency

- G2 must-have outputs, the 22/25 gate with every item ≥4, owner adoption before implementation, the fail-closed list, the approval packet and the out-of-scope list are all unchanged from round 2.
- No conflict with the G0–G6 table, Identity Lock or `quality-first-process.md`. No Protected Scope, gate or threshold change.

### Findings

- Critical: none
- High: none
- Medium: none
- Low:
  - **R3-L1 (naming, same problem the rename fixes)**: the comparison route is still called "LAYOUT_FIRST", which is also an Issue #180 method name (`claude_layout`). Suggested text: 「**比較経路 CLAUDE_COMP_FIRST**（Issue #180 の LAYOUT_FIRST とは別の実験）」, or add 「（Issue #180 の LAYOUT_FIRST とは別）」 after the current name. This does not touch the blind mapping.
  - **R3-L2**: "Claude の手書きカンプ＋写真" can be read as hand-drawn, and `prepare-visual-first` itself only prepares the brief. Suggested text: 「DEV-139 の `prepare-visual-first`（Claude が HTML/CSS で組むカンプ＋個別承認の写真の経路の、オフラインのブリーフ受渡し）」.
  - **R3-L3**: Now that section sequences are the standard, the immutable record still says "PC/SP画像SHA・自然サイズ", and "短尺のみ" in the fail-closed list is ambiguous. Suggested texts: 「PC/SP各セクション画像のSHA・自然サイズ・順序（結合する場合は結合画像のSHAも）」 and 「短尺のみ（事前に定義した全セクションがそろわない）」.

### Conclusion

Critical/High/Medium are all 0, so PR #294 passes Fresh Review at `b9d3b69`. The three Lows are optional, text-only clarifications. CI must still pass on the latest head before feature→develop.
