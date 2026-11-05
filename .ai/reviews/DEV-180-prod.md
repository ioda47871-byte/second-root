# DEV-180 本番の差分 (draft) — gradient_ground の門の強化と承認の一覧 (**オーナーの明示の承認まで merge しない**)

- **branch:** `feature/dev-180-prod-gradient-ground`。研究の branch `feature/dev-180-capability-readiness` (`f5abc2a`) から切り、後で研究の branch の `5bf759d` を merge した。
- **PR:** このセッションは開かない。親のセッションが draft で開く。ready にする・merge するのはオーナーの明示の承認の後だけ (台帳の DEV-180 の human_approval_triggers)。
- 承認資料: `docs/design/capability-approval-gradient-ground.md`。

## commit

1. `f0f0425` **門の強化 (能力は OFF のまま)。** `lib/design-agent/comp-impl/phase-b.ts`: `PAINT_SCANNER` に研究の候補と同じ置き換え (止めの規則を内側の箱で測る、幅のある枠の辺が不透明な実線でない地・1つの箱でない地は `GRADIENT_PAINT_BOX`)。`GRADIENT_CODES` に `GRADIENT_PAINT_BOX`。守りを足すだけで、通るページは増えない。
   - テスト: `gradient-ground.test.ts` の M1 の「known gap」のテストを、4つの再現が `GRADIENT_PAINT_BOX` (と止めのコード) で落ちることを求める形に強めた。`gradient-paint-box.test.ts` は「本番 = 候補」を求める形に (本番の script が置き換えをちょうど1つ持ち、元の文字列を持たないこと。M1 の再現で本番の答え = 候補の答え。幅で折れるインラインで本番の掃引も同じ幅だけ落ちる)。`gradient-box-harness.ts` は、本番がすでに置き換えを持つとき候補 = 本番とする。
2. `c2fda8e` **能力の ON (承認が要る)。** `spec.ts` の `APPROVED_CAPABILITIES = ["gradient_ground"]`。`colour_syntax` ほかは足さない。
   - テスト: 承認の一覧を `[]` に固定していた 12 か所を `["gradient_ground"]` に (消した・skip したテストは無い)。`phase-b.test.ts` はほかの段 B の 4 つを今どおり拒み、gradient_ground だけの spec を通すこと、gradient_ground + colour_syntax の spec は `SPEC_CAPABILITY_NOT_APPROVED` であることを足した。`gradient-ground.test.ts` は、旗が gradient_ground を宣言した spec にだけ立ち、colour_syntax・translucent_decoration の旗は立たないことを固定する。
3. `18f1a76` 研究の branch の merge (記録と、留めの角の例を確かにした直し)。

## lib の差 (develop から)

```
 lib/design-agent/comp-impl/phase-b.ts | 20 ++++++++++++++++++--
 lib/design-agent/comp-impl/spec.ts    |  9 ++++++---
 2 files changed, 24 insertions(+), 5 deletions(-)
```

`page-css.ts` は変えていない。旗を下ろしたページの静的な文法は develop と同じ (判断シート §8 の 6 は、文法の差が 0 なので自明に満たす)。巻き戻しは `APPROVED_CAPABILITIES` から名前を外すこと (門の強化は残してよい)。

## 実行したテスト (この branch、1ファイルずつ、Chromium 1194、この容器の書体)

| ファイル | 終了の値 | 件数 |
|---|---|---|
| bundle.test.ts | 0 | 51 |
| checks.test.ts | 0 | 166 |
| display-nowrap.test.ts | 0 | 47 |
| display-scale.test.ts | 0 | 53 |
| e2e.test.tsx | 0 | 87 |
| fingerprints.test.tsx | 0 | 2 |
| gradient-ground.test.ts | 0 | 58 |
| gradient-paint-box.test.ts | 0 | 18 |
| isolation.test.ts | 0 | 4 |
| phase-a.test.ts | 0 | 68 |
| phase-b-baseline.test.ts | 0 | 37 |
| phase-b.test.ts | 0 | 187 |
| phase-c-overlap.test.ts | 0 | 79 |
| phase-c-reach.test.ts | 0 | 100 |
| phase-d.test.ts | 0 | 22 |
| section-guard.test.ts | 0 | 1 |
| sections.test.ts | 0 | 14 |
| spec.test.ts | 0 | 19 |
| ai-tasks.test.ts | 0 | 193 |
| n1-owner-review.test.ts | 0 | 51 |
| n1-phase-c-join.test.ts | 0 | 19 |

- 走らせ方: `scratchpad/dev180/scripts/suite.sh` (リポジトリの外)。結果は `scratchpad/dev180/logs/prod.jsonl`。
- `npx tsc --noEmit` の誤りは `app/**` の既存の 8 件だけ。`npx eslint` (変えた ts) 0 件。

## まだのこと

- CI (必須の全部) と独立の Fresh Review (C/H/M = 0)。
- WebKit・Firefox・実機 (承認資料 §6)。
- オーナーの明示の承認 (能力の ON、本番の描画の門の変更)。
