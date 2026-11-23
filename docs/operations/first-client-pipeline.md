# 最初の外部案件までの最小構成（オーナー方針 2026-11-23）

最優先は、**店舗専用の高品質なデモを作って営業し、最初の外部案件を取る**こと。画像生成の安全の仕組みをこれ以上作り込まない
（専用の承認アカウント・電子署名・複雑な本人認証は作らない。PR #327 は閉じた）。

## 0. 維持すること（緩めない）

- root の分離: Claude（jail の sr-designgen）は root にならず、root の設定・timer・状態・上限に書けない。
- 認証情報の保護: Codex / Claude のサインインは実行ごとの隔離した設定ディレクトリの写しだけ（#326）。root は読まない。
- 生成の上限と無限の再試行の防止: 1 回 = Codex 1 回・画像 6 枚まで・15 分、再試行なし、同じ依頼 ID は二度と動かない、1 日・1 週の回数の上限。
- 実行コードの保護: root が動かすスクリプトは、オーナーの設置のときに入れた root の持ち物の写しだけ（リポジトリの develop を root で動かさない）。
- **本番公開と営業送信は当面オーナーの確認が必須**。自動送信は作らない（今の「承認 → 送信画面を開く → 手で送る → 手動で送信済み」のまま）。
- 実店舗のデータ（事実・頁・画像）は git に入れない（リポジトリは公開）。事実はオーナーが確認したものだけ（Identity Lock）。
- 実店舗の AI 画像は**社内のデザインの参考だけ**。相手に見せる頁・共有 URL には出さない（MVP_SPEC §7.1）。相手に見せるデモは写真なしの HTML。

## 1. 工程と、今あるもの

| 工程 | 今あるもの | 足すもの |
|---|---|---|
| 1. 営業候補 | ingest API と候補の検査（名古屋・3 業種・1 日 5 件・DNC・除外）、`ops/sales-agent/RUN_PROMPT.md` | なし |
| 2. 事実 | `facts-pack.json`（`docs/operations/real-shop-demo-workflow.md` §2）。**オーナーが値を確認** | なし（ここはオーナーの確認が要る） |
| 3. 画像生成（デザインの参考） | IMAGE_FIRST の worker・autorun（#325）・設定の信頼境界（#326）・一度だけの設置（#328）。ただし架空の店（ほし窯）だけ・1 回ごとの承認 | **A. 包括的な事前許可**（#330）、**B. 実店舗の事実から依頼を作る**（#331）。どちらも実装済み・実機は未導入 |
| 4. サイトの実装 | 写真なしの B 方式の頁（Claude がセッションで書く、`second-root-design-director` スキル） | **C. 画像を参考にした実装の手順**（Claude のセッションで行う） |
| 5. PC/SP の検査 | `comp-lane.ts`（PC1440・SP390、JS なし・通信なし）、文章の監査 `comp-copy.ts` | なし |
| 6. デモの保存 | `package-local.ts` → `import-local.ts`、管理画面の品質承認 | なし（ローカル）。共有 URL は §3 のオーナーの承認 |
| 7. 営業文の準備 | 下書き（`lib/sales/prepare.ts`）、管理画面の送信承認と手動送信 | なし |

## 2. 足すもの（必要最小限）

### A. 画像生成の包括的な事前許可（OWNER MERGE ONLY・root。#325 / #326 / #328 を再利用。PR #330 で実装）

- オーナーが**最初に一度だけ**、root で上限つきの許可を書く（#328 の設置スクリプトに `standing` を足す）。
  `standing --yes --expect <commit> --per-day N --per-week M --days D`（上限: N 1〜4・M 1〜20・D 1〜90）。例: 1 日 2 回・1 週 8 回・30 日。
  1 回の中身は今と同じ（Codex 1 回・6 枚・worker の見張り 15 分・pilot の外側の上限 30 分・再試行なし）。取り消しは `standing --revoke --yes`。
- 以後は毎回の承認コマンド・パケットの承認は要らない。Claude が依頼のファイル（`~/sr-runs/requests/<依頼 ID>.json`）を置くと、
  root の timer が上限の中で 1 件ずつ拾い、今の autorun の流れ（claude-stop → 生成 1 回 → 監査 → claude-start）で動かす。
- root が守るもの: 上限の数え（root の状態）、依頼 ID の使用済みの印（消さない）、依頼のファイルの形の検査（worker として読む）、
  1 度に 1 件、期限。実行の後に root が画像の数を worker として数え、6 枚を超える・数えられないときは凍結し、オーナーの
  `standing --unfreeze --yes` まで拾わない。上限・期限を変えられるのはオーナーの root の操作だけ。
- 実行コードの保護: unit と root が動かすスクリプト（autorun・pilot・preflight・admin.sh）は、設置のときに
  `/usr/local/lib/sr-imagefirst/` へ入れた root の持ち物の写しから動かす。worker は sr-designgen として、オーナーが `standing --expect <sha>` で
  固定した `worker_commit` だけを新しい clone に fetch して動く（develop の先頭ではない。新しい worker のコードは `standing` をやり直したときだけ入る）。
- MVP_SPEC §7.1 の「画像の生成そのものは 1 回ごとのオーナーの承認」を、この事前許可に置き換える（オーナー決定 2026-11-23 として記録）。

### B. 実店舗の事実から画像の依頼を作る（worker 側。PR #331 で実装）

- 今の worker は架空のほし窯の固定のプロンプトだけ。これを、リポジトリの外の `facts-pack.json`（オーナー確認済み）と、
  Claude が店ごとに決める方向性から、プロンプトを組み立てて動かせるようにする。
- 店のデータは git に入れない。プロンプト・画像・監査は private の置き場（`~/sr-runs`・`~/second-root-shops`）だけ。
- 画像に描いてよい文字は facts pack の値だけ（Identity Lock）。写っている商品・店内・人を事実として扱わない。

### C. 画像を参考にしたサイトの実装の手順（Claude のセッション）

- 生成が届いたら、Claude が画像を参考に、写真なしの B 方式の頁（`comp/`）を書く。画像そのものは頁に入れない。
- `comp-lane.ts` で PC/SP を検査し、`comp-copy.ts` で文章を監査し、`package-local.ts` → `import-local.ts`。
- 管理画面で品質承認（オーナー）→ 営業文の下書き → 送信承認（オーナー）→ 手で送る。

## 2a. Claude の手順（1 店。既存の `real-shop-demo-workflow.md` に画像の段を足しただけ）

1. 候補を選ぶ（営業エージェントの run で登録済みの候補。新しく作らない）。
2. `~/second-root-shops/<shop_id>/facts-pack.json` を書き、**オーナーに値を 1 つずつ確認してもらう**（workflow §2）。
3. `second-root-design-director` スキルで店に固有の方向性を決め、依頼 `~/sr-runs/requests/<依頼 ID>.json` を作る
   （`schema: sr_imagefirst_request_v1`、ID は `req-…`（"imagefirst" を含まない）、`created_at` は `YYYY-MM-DDTHH:MM:SSZ`、`kind: real_shop`、
   方向性、`facts_ref.root: second-root-shops` と facts の SHA-256、`max_images: 6`、`codex_runs: 1`）。置く前に
   `node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --validate-request <file>` で確かめる（root は拾った依頼を断られても回数に数える）。
   依頼 ID は二度と使えない。あとは root の timer が上限の中で動かす（A）。
4. 届いたら `~/sr-runs/review-inbox/<依頼 ID>` を見る（実店舗の記録は `~/second-root-shops/<shop_id>/runs/` に入り、研究ログには書かない）。PC と SP の画像を**参考として**見て、写真なしの頁 `comp/` を書く（workflow §3。
   画像そのものを頁に入れない。画像に描かれた商品・店内・人を事実として書かない。文字は facts pack の値だけ）。
5. `comp-lane.ts` で PC1440 / SP390 を描画し、全頁を最後まで見る。`comp-copy.ts --audit` が `owner_review` に届くまで直す。
6. `package-local.ts` → 事実の登録（workflow §5）→ `import-local.ts --facts-from-store`（ローカル）。hosted は runbook B-5a の後だけ。
7. 営業文の下書きを用意し、管理画面でオーナーの品質承認・送信承認を待つ。**送信はオーナーが手で行う。**
8. 生成が要件を満たさなければ、同じ依頼 ID は使わず、方向性を直した新しい依頼にする（上限の中で。自動の再試行はしない）。

## 3. オーナーの判断・承認が要るもの

1. **A の設置**（一度だけ）: #326 → #328 → A の PR のマージ、`check` → `apply` → `standing`（上限の値）→ `enable-timer`。
2. **店ごとの事実の確認**（facts pack の値を 1 つずつ）。
3. **デモの品質承認と送信承認**（今のまま。自動送信なし）。
4. **共有 URL を出すための本番の設定**（`docs/operations/sales-mvp-runbook.md` の B-1〜B-6: migration・bucket・成果物の origin・環境変数・共有の切り替え）。
   これが無いと、相手に送れるデモの URL ができない。最初の案件のためには、どこかの時点で必要。
   なお、この WSL の jail では Docker が動いていない（2026-11-23 に確認）ため、ローカルの Supabase は使えない。jail の中でできるのは
   `package-local.ts` の包みまで。デモの保存（事実の登録・取り込み）は、hosted（Staging）の B-5a の承認の後か、Docker が動く別の環境で行う。
