# 営業B-routeデモ：オフライン接続部と未接続工程（Issue #139 / #263）

更新日：2026-11-17。調査基準：`develop` の `e5b4e0dda5899331c94e564e7345ea100a5fcf4a`。

## 何を実装したか

`scripts/sales/demo-version/prepare-offline.mjs` は、**すでに制作済みの写真なしB-route全ページカンプ**を受け取り、既存の品質審査・v2パッケージ化を順番につなぐ最小のオフラインadapterである。候補収集・アートディレクション・HTML生成・DB import・管理画面表示は行わない。これだけで自動営業が完成したとは見なさない。

実店舗データ・画像・非公開ページ・出典内容は公開GitHubへ入れない。原本はリポジトリ外の私有ディレクトリ（従来の無追跡 `.local-shops/` でも可）に保管し、**この実行の出力先は必ずリポジトリ外、かつ入力のカンプ・factsのディレクトリの外**とする。

```bash
mkdir -p "$HOME/second-root-runs"
node scripts/sales/demo-version/prepare-offline.mjs \
  --facts "$HOME/second-root-shops/<shop-id>/facts-pack.json" \
  --comp "$HOME/second-root-shops/<shop-id>/comps/<direction-id>" \
  --out "$HOME/second-root-runs/<new-run-id>"
```

**`--comp` のディレクトリ名は方向ID（例 `d1-wheel-hub-v6`）そのもの**であること。`comp-lane.ts` は方向IDをディレクトリ名から読み、`review.json` の `direction_id` と違えば `REVIEW_OF_ANOTHER_DIRECTION` で拒否するため、adapterは私有出力先の `comp/<direction-id>/` に同じ名前で複製する。名前は英数字で始まり英数字・`.`・`_`・`-` だけ（100文字まで）で、それ以外は `COMP_NAME_UNSAFE`。`comp` のような汎用名のディレクトリを渡すと、正しい `show_owner` レビューでも視覚レビュー検査で止まる。

`--out` は存在していないディレクトリであること。カンプやfactsファイルのあるディレクトリの中（またはそれらを含む場所）は `OUTPUT_OVERLAPS_INPUT` で拒否する。実行前の `npm ci` と既存Playwright Chromiumの準備は実機で必要。これは本番サービス・タイマーの起動手順ではない。

既存の各工程を再実装せず、そのまま利用する：

開始時にfactsファイルを `input/facts-pack.json` へ、カンプを `comp/<direction-id>/` へ複製し、両方のSHAを照合する。以下の全工程はこの複製だけを読む。原本（factsとカンプ）は開始時にadapterが読むだけで、工程には渡さない（工程が原本へ書き込まない保証はコードの経路とSHA再照合による検出であり、OSの書込み禁止ではない）。

1. `comp-copy.ts --audit` の文章監査。複製したカンプへ `copy-review.json` を書き込む（変わってよいのはこのファイルだけ。監査後に複製全体を再ハッシュし、他のファイルの変化・追加は `STAGED_COMP_MUTATED`）。HOLD・REVISE・FAILは停止。**描画レーンが`show_owner`のときcopy監査済みを要求するため、必ず先に実行する。**
2. `comp-lane.ts` のPC1440/SP390描画・安全・表示文字チェック（出力先 `renders/`）。
3. `comp-lane.ts --check-review --facts` の既存の視覚レビュー検査。レビューがない場合、および`review.json`の判定が`revise`や`drop`の場合は停止。機械的なPASSを美観合格とは扱わない。
4. `package-local.ts --copy --facts` のv2パッケージ生成と再検証（出力先 `package/`）。写真・外部送信・DBアクセスなし。

開始前に `shop_id` と factsのバイト列SHAが `copy.json` と一致することを検査する。原本・factsの複製・カンプの複製のSHAを各工程の前後に再照合し、原本の改変（`INPUT_MUTATED`）、複製の改変（`STAGED_FACTS_MUTATED` / `STAGED_COMP_MUTATED`）、別バージョンの混入を拒否する。シンボリックリンク、未知の素材ファイル、出力の上書きも拒否する。各工程は独自のプロセスグループで実行し、180秒を超えたらグループごと（ブラウザを含む）停止して `STEP_TIMEOUT` とする。

私有の `status.json` は実行ID・方向ID・facts SHA・各入力ファイルSHA・文章監査後の複製のSHA・工程ごとの経過時間／終了コード／検出コード（最大40件、`A-Z0-9_` のコードだけ）・stderr先頭のコード（本文は記録しない）・停止理由・描画工程の `review.renders_match_here`（`render_review`）・package SHAを保持する。複製の途中で失敗しても `status.json` は書く（`stage` 工程で停止）。標準出力はステータスとハッシュのみで、店舗固有文言や実店舗連絡先を出力しない。成功時も `package_prepared_owner_review_required` であり、営業送信できる意味ではない。

テスト：`node --test tests/node/sales-demo-prep.test.mjs`。既存Vitest unit suiteからも `tests/unit/sales/offline-demo-prep.test.ts` が実行する。内容は、制御ロジック、全停止コードの表、タイムアウト時のプロセスツリー停止、そして**コミット済みの架空カンプをリポジトリ外へ複製した本物のCLI**（`comp-copy.ts --audit`、`comp-lane.ts --check-review`、`package-local.ts` の拒否経路）の契約テスト。`PLAYWRIGHT_CHROMIUM_EXECUTABLE` があれば、架空の送付用ページで本物の描画とv2パッケージ化も通す。コミット済みのカンプに「文章監査がowner_review」かつ「`show_owner` の視覚レビュー」を両方満たすものはないため、4工程すべてを本物で通した証拠はまだない。DB E2Eも対象外。

## 接続監査：すでにあるものとない矢印

| 区間 | 既存コード・記録 | 評価 |
| --- | --- | --- |
| 探索→verify→persist | `ops/sales-agent/RUN_PROMPT.md`、`lib/sales/ingest.ts::handleIngest` / `persist`、`sales_persist_candidate` | 実装あり。ただしClaude Cloudの定期実行や日次候補数はGitHubだけでは未確認 |
| 候補→旧DesignProfileデモ | `lib/sales/ingest.ts::persist` がフラグON時のみ `p_design` を渡す。既存Bridge、`scripts/sales-design-worker/worker.ts`、`lib/design-agent/pipeline.ts` | 旧Reactテンプレ／DesignProfileの経路。**高品質B-route全ページ自動生成とは別** |
| オーナー確認済みfacts→デモ内容 | `lib/sales/facts-onboarding.ts::createDemoFromFactsAsAdmin` / `sales_create_demo_from_facts` | 既存機能。候補の収集情報から未検証の属性を無断で「確認済みfacts」にする矢印はない |
| 店舗固有の3方向→B-route HTML/CSS+copy.json | `lib/design-agent/phase2f/runner.ts` ほかの研究CLI／成功例資料 | 部品は存在するが、日々の候補から完成する**無人の生成ポートは未接続**。旧ワーカーのテンプレfallbackを高品質成功と呼ばない |
| B-routeカンプ→描画・文章・レビュー→v2 | `comp-lane.ts`、`comp-copy.ts`、`package-local.ts`、今回の `prepare-offline.mjs` | ローカルの直列制御・入力SHA・停止理由を追加。制作自体と人のレビューは依然必要 |
| v2→DB版→管理画面→営業文・手動送信 | `import-local.ts`、`app/admin/sales/demos/[prospectId]`、`app/admin/sales/_actions/send.ts`、`tests/e2e/sales-mvp-flow.spec.ts` | 既存の架空fixtureを使ったローカルE2Eあり。**新生成カンプ→同じfacts SHAのDB版→管理画面**は未検証 |

## 次のP0開発（依存順）

1. **候補IDと確認済みfactsの引き渡し**：既存prospect／facts storeを読取側として用い、出典・承認状態・facts SHAを明示。未確認の営業時間、住所、商品、権利はHOLD。オーナー承認を代行しない。
2. **店舗固有の制作ポート**：既存の研究成功例と採否記録を参照し、複数方向を比較して一店舗に固有のB-route全ページHTML/CSS+copy.jsonを作る。テンプレ固定・存在しない事実・無許可の実Codex/画像コールは禁止。生成ポートがなければ止まる。
3. **新生成カンプを今回のadapterへ接続**し、原本/出典/facts SHA/デザインrun/監査/パッケージを一つのrun IDで追う。
4. **同一facts SHAでローカル取り込みと管理画面への表示をE2E実証**。まず架空1件、次にパン屋・カフェ・焼菓子店3件。品質/文章/権利/送信承認は既存ルールのまま。
5. 稼働状況（Claude Routine、WSL timer、hosted Supabase migration、Vercel設定）を**読み取り専用で確認**。起動・Staging/Production変更・DNS/Storage・本番送信・実Codex/画像生成は別承認。

## 継承した制約

- Harissy個別v13の反復修正をP0に戻さない。営業時間・オーナー文章承認のHOLDを維持し、非公開データはGitHubに移さない。
- 盲検X/Y/Zの対応表を本人の明示要求なしに開示しない。選好 `Y > Z > X` を「成功例達成」と解釈しない。
- `.ai/tasks.json` の2026-11-17時点の履歴不一致は**既存Draft PR #274**で処理し、競合する台帳更新を増やさない。
- CI greenだけでFresh Review完了とは呼ばない。PRは小さく保ち、必要な独立レビューとオーナー承認なしにdevelop/main/公開環境へ反映しない。

関連：Issue #139、#263、`docs/operations/real-shop-demo-workflow.md`、`docs/operations/sales-mvp-runbook.md`、`docs/design/comp-lane.md`。
