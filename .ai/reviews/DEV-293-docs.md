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
