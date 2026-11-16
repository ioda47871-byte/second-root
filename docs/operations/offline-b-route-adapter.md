# 営業B-routeデモ：オフライン接続部と未接続工程（Issue #139 / #263）

更新日：2026-11-17。調査基準：`develop` の `e5b4e0dda5899331c94e564e7345ea100a5fcf4a`。

## 何を実装したか

`scripts/sales/demo-version/prepare-offline.mjs` は、**すでに制作済みの写真なしB-route全ページカンプ**を受け取り、既存の品質審査・v2パッケージ化を順番につなぐ最小のオフラインadapterである。候補収集・アートディレクション・HTML生成・DB import・管理画面表示は行わない。これだけで自動営業が完成したとは見なさない。

実店舗データ・画像・非公開ページ・出典内容は公開GitHubへ入れない。原本はリポジトリ外の私有ディレクトリ（従来の無追跡 `.local-shops/` でも可）に保管し、**この実行の出力先は必ずリポジトリ外**とする。

```bash
mkdir -p "$HOME/second-root-runs"
node scripts/sales/demo-version/prepare-offline.mjs \
  --facts "$HOME/second-root-shops/<shop-id>/facts-pack.json" \
  --comp "$HOME/second-root-shops/<shop-id>/comp" \
  --out "$HOME/second-root-runs/<new-run-id>"
```

`--out` は存在していないディレクトリであること。実行前の `npm ci` と既存Playwright Chromiumの準備は実機で必要。これは本番サービス・タイマーの起動手順ではない。

既存の各工程を再実装せず、そのまま利用する：

1. `comp-copy.ts --audit` の文章監査。元のカンプへ書き込まず、私有出力先 `comp/` に限定したコピーへ監査結果を書き込む。HOLD・REVISE・FAILは停止。**描画レーンが`show_owner`のときcopy監査済みを要求するため、必ず先に実行する。**
2. `comp-lane.ts` のPC1440/SP390描画・安全・表示文字チェック（出力先 `renders/`）。
3. `comp-lane.ts --check-review --facts` の既存の視覚レビュー検査。レビューがない場合、および`review.json`の判定が`revise`や`drop`の場合は停止。機械的なPASSを美観合格とは扱わない。
4. `package-local.ts --copy --facts` のv2パッケージ生成と再検証（出力先 `package/`）。写真・外部送信・DBアクセスなし。

開始前に `shop_id` と factsのバイト列SHAが `copy.json` と一致することを検査する。入力ファイルのSHAを各工程の前後に再照合し、原本の改変・別バージョンの混入を拒否する。シンボリックリンク、未知の素材ファイル、出力の上書きも拒否する。

私有の `status.json` は実行ID・facts SHA・各入力ファイルSHA・工程ごとの経過時間・停止理由・package SHAを保持する。標準出力はステータスとハッシュのみで、店舗固有文言や実店舗連絡先を出力しない。成功時も `package_prepared_owner_review_required` であり、営業送信できる意味ではない。

テスト：`node --test tests/node/sales-demo-prep.test.mjs`（9テスト）。既存Vitest unit suiteからも `tests/unit/sales/offline-demo-prep.test.ts` が実行する。これらは**制御ロジックのモックテスト**であり、本物のChromium/DB E2Eを通った証拠ではない。

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
