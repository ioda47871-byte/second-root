# DEV-139 — 「輪」型のビジュアル先行・写真統合ルート（実装開始）

2026-11-18。オーナー指示：「写真付きの『輪』と同じ品質を目指す工程を Second Root の自動営業デモ制作へ取り込む」。
この文書と `prepare-visual-first.ts` は **最初のオフライン接着**。実画像生成・実Codex・DB・公開・営業送信を許可したり、全工程を完成したりするものではない。

## なぜ別経路が必要か

- DEV-139 Stage 0〜1 で使った `B_html_prototype` は参照画像0・画像生成0の **文字・HTML/CSS比較用**。ほし窯 d1 で新しいHTML/CSSとPC1440/SP390の描画に成功したが、`COPY_UNSUPPORTED` で品質チェーンは停止、`SP_TEXT_TOO_SMALL` も記録された。
- 「輪」SR-001は、店固有の全ページ構造に写真の **5枠** を設け、**6枚**（作業台はPC用・SP用の別写真）を個別に計画・生成し、権利/実バイト/解像度/トリミングとPC/SP/タブレット実描画を確認した研究成功例。件数や画角を他店の固定テンプレートにしない。
- 既存の`art_direction_set_v0`には各区画の`image_slots`、`pc_plan`、`sp_plan`、`protect`があるのに、現在のB向け`phase2f_open_direction_v1`へ変換すると**それら全部は本文プロンプトに届かない**。そのため、デザイン構成を忠実に実装するためのPC/SP全頁仕様を別に受け渡す。
- 過去の「輪」の1回限りの画像生成承認、写真/プロンプト、画面・成功例原本は**別店舗へ再利用する権利でも無人実行許可でもない**。画像は研究用デモ限定で、私有WSLから出さない。

## 実装済みの入口（このPR）

```bash
# これだけではモデル・画像生成・外部通信は行われない。出力はrepo外の新規dir。
npx tsx scripts/sales/demo-version/prepare-visual-first.ts \
  --facts design-library/research/quality-pipeline/poc/bakery/facts-pack.json \
  --directions design-library/research/quality-pipeline/poc/bakery/direction-set.json \
  --direction-id d1-kiln-clock \
  --out "$HOME/sr-runs/visual-brief-hoshigama-d1"
```

- 既存 `runDirectionSetCheck`（C1〜C7）で `READY_FOR_COMPS`、店舗ID・**factsのバイトSHA**一致を必須とする。
- `visual-first-brief.json` に、中心モチーフ・コンセプト・構造8項目・**全区画/各写真枠**・PC全頁計画・SPの独立した計画・守る特徴・参考原理を欠けずに出す。
- `status.json` はデザイン・写真生成・忠実度・最終評価のどれも済んでいないと明記し、常に `sendable:false`。
- 写真枠0個の `d1-kiln-clock` は `PHOTO_SLOTS_REQUIRED` として明示。これは失敗を隠すためのダミー写真を追加せず、**写真込みの新しい方向案を設計するよう求める**状態。写真枠2個の `d2-hearth-floor` ではブリーフが作れるが、写真自体が作られたことにはならない。
- 原本の `d1`、実Codex受領・使用済み承認ID・prompt SHA/commitを**書き換えない**。d1に写真を追加するなら別の方向案/承認されたバージョンとして記録し、以前の1回の生成物との互換性を偽装しない。

## 完成版へ接続する最短のクリティカルパス（未実装は未実装と区別）

1. **G0 店舗事実**：`verified-generation-facts.ts`（ローカルDB実経路は別承認）でfactsと業種/写真権利を確認。実店舗の写真や商品をAIで本物と偽らない。
2. **G1 店舗固有の3方向**：C1〜C7を既存ルールで検査。写真必須は写真表現が店舗らしさ・来店判断に実質寄与する案だけにする。写真枚数を固定しない。
3. **G2 完全なデザインビジュアル**：このブリーフの `sections / pc_1440_full_page_plan / sp_390_full_page_plan / protect / photo_slots` を、別々のPC1440・SP390全ページ**静的カンプ**に変換。ツール実行は個別承認。Heroだけ・PC縮小だけを完成扱いしない。元の静的画像とSHAを保持。ユーザーの採否まで次の段へ進めない。
4. **G3 写真の入手と差し替え**：写真枠を先に実測（`photo-slots.ts`、幅/最低解像度/焦点/ブレークポイント端）。オーナーまたは店が提供する権利確認済み写真、あるいは**架空店に限り別途承認されたAIデモ画像**を非公開で生成。写真の真実性・権利/生成出所/プロンプトSHA/一回限り承認IDを記録し、`photo-rights.ts`・`photo-swap.ts`相当の検証でPC/SP/タブレットへ組み込む。`photo-swap.ts`の店別実装は現在 `tsugute` / `bicycle` に限定されている。**ほし窯等へ自動的に適用できる状態ではない**ので、一般化は別のコード変更・レビューを要する。画像が無ければ`placeholder_limited`で止める。
5. **G4 元デザインに忠実な実装**：写真入りデザインカンプを真実の文言元にせず、factsだけを文言根拠にしてClaude/CodexがHTML/CSSを実装。 `impl-compare.ts` でPC/SPの全頁および区画の差を報告（report-only）。最初のHTMLが通っても見た目の比較を省略しない。ページ実装の許可範囲と生成コマンドの承認を再利用しない。
6. **G5 品質と営業パッケージ**：`from-generation.mjs`/copy audit/owner visual review/安全性/権利審査/実画像を含んだv2 packageで合格後にだけローカルadminへ。誤事実、文字サイズ、横溢れ、コピー不一致、写真が本物に見える問題はHOLD。`COPY_UNSUPPORTED`は別タスクで根因を特定し、監査の閾値を緩めない。
7. **G6 最終オーナー承認**：生成と検査の成功は美観の成功ではない。オーナー本人がPC・SP実画像を見て明示承認したものだけ研究成功例。公開/送信・mainは別承認。

## Claudeへ続行してほしい実装（優先度順）

- P1: 「輪」の非公開成功原本の**所在/ハッシュを閲覧のみで確認**、写真/全頁構図の成功要因を抽出。原本をrepoにコピーしない。
- P2: この新ブリーフを **PC/SP静的デザイン生成のジョブ入力**へつなぐ。`sections`、`pc_plan`、`sp_plan`、`protect`をモデルに渡さず消すことは禁止。**静的画像生成時の個別承認が必須**。実Codex生成と別カウント。
- P3: 写真枠を測る仕組みと、私有manifest・権利審査・写真差し替えを**任意の架空店舗**に対応させる。既存`tsugute`/`bicycle`の契約を壊さず、権限・容量・範囲を勝手に拡張しない。PC/SP別写真は必要なときのみ。
- P4: 画像込みデザイン原本・承認済みfacts→実装→`impl-compare`→コピー監査→PC/SP owner review→管理画面へのデモを**1件だけ実CLIで縦断**。写真とデザイン画像は非公開保管、recorded/stub成果と実生成成果を区別する。実店舗への自動営業はまだ行わない。
- P5: 1店が実画面でオーナー評価を通ってからパン屋・喫茶・菓子店へ拡張。写真の有無を品質比較の交絡因子として記録する。

## 既存の実装/正本

- `docs/design/design-first-workflow-decision.md`: デザイン先行の正式方針とG0〜G6。
- `docs/design/quality-first-process.md`: 店固有モチーフ→3方向→全ページカンプ→比較。
- `docs/design/bicycle-ai-photo-brief.md`, `scripts/design-artifact/bicycle-ai-intake.ts`, `scripts/design-artifact/photo-swap.ts`, `lib/design-agent/quality-pipeline/{photo-slots,photo-rights}.ts`: 「輪」の6写真・5枠・権利・寸法・差し替え。
- `docs/design/impl-compare.md`: 実装忠実度のreport-only比較。
- `docs/operations/s0-generation-glue.md`: これまでのBルートを破壊せず残す。

## リリース制限

このPRは**オフラインのブリーフ出力とテストだけ**。Live Codex/画像生成0・PhotoSwap0・Supabase/DB書込0・worker/timer変更0・公開/DM/メール0。CIと**別コンテキストFresh Review**がPASSするまでdevelopにマージしない。
