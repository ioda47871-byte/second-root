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
- 実店舗の AI 画像は、デザインの段の完成デザイン画像は**社内のデザインの参考だけ**（頁に入れない）。写真素材の段で作った画像素材だけは、MVP_SPEC §7.1 の「限定の改定」の 5 つの条件（「イメージ」の表示・店のものとして見せない・事実と分ける・「提案用デモ」の表示・差し替え可能）をすべて満たすときに限り、営業提案デモに使える（§2 C・D）。共有 URL での公開と送信は別のオーナー承認。

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

- 生成が届いたら、Claude がデザインの段の画像（PC/SP）を**参考に**、B 方式の頁（`comp/`）を書く。デザインの段の画像そのものは頁に入れない。
- 写真の枠には、素材の段（§2 D）の画像素材だけを置いてよい。Claude は inbox の `~/sr-runs/review-inbox/<素材の依頼 ID>/` で 1 枚ずつ自分で確かめ
  （文字・ロゴ・顔・店の物に見えるもの・値段やメニューが無いか）、通ったものだけを、manifest の SHA-256 と一致するファイルのまま頁の素材に置く。
  条件は MVP_SPEC §7.1 の限定の改定のとおり、すべて守る: (1) 写真の枠ごとに「イメージ」と表示する、(2) 実在しない店内・商品・建物を店の物として見せない、
  (3) AI の素材を確認済みの事実（facts pack の値）と別の枠に分ける、(4) 頁に「提案用デモ」と表示し公式サイトと取り違えさせない、
  (5) 写真の枠は単純な長方形・角丸にし、店の本物の写真や許可された素材に差し替えられるようにする。素材を使わない頁は今までどおり写真なし。
- `comp-lane.ts` で PC/SP を検査し、`comp-copy.ts` で文章を監査し、`package-local.ts` → `import-local.ts`。
- 管理画面で品質承認（オーナー）→ 営業文の下書き → 送信承認（オーナー）→ 手で送る。

### D. 二段の依頼: 写真素材 → デザイン（オーナー決定 2026-11-24。MVP_SPEC §7.1 の限定の改定）

1 店の計画は **2 回の実行・最大 12 枚**。どちらの段も 1 依頼 ID = 1 回の Codex 実行・最大 6 枚・再試行なし（root の上限・1 回限りの記録は今のまま）。

1. **素材の段** `stage: "photo_materials"`: 営業提案に置く写真風の**画像素材**を 1〜6 枚（店の記録ではない）。被写体は質感・道具・顔の写らない手元・光など。
   文字・ロゴ・人の顔・店の外観や店内・建物・その店の商品として見せる物・値段やメニューの表示は入れない。被写体 1 つにつき 1 枚、
   枠は画像ツールの寸法から Web 向けに 1〜2 枚目 横 3:2、3〜4 枚目 正方形、5〜6 枚目 縦 2:3。

   ```json
   { "schema": "sr_imagefirst_request_v1", "id": "req-<shop>-photos-1", "shop_id": "<shop_id>", "kind": "real_shop",
     "created_at": "YYYY-MM-DDTHH:MM:SSZ", "stage": "photo_materials",
     "photo_brief": { "subjects": ["<1〜6 個、各 200 字まで>"], "mood": "<300 字まで>", "avoid": "<300 字まで>" },
     "facts_ref": { "root": "second-root-shops", "shop_id": "<shop_id>" }, "facts_sha256": "<sha256>",
     "max_images": <subjects の数>, "codex_runs": 1 }
   ```

   brief は direction と同じ検査（URL・HTML・引用符・3 桁以上の数字・通貨記号・facts の値を含めない）。結果は private の
   `~/sr-runs/<依頼 ID>-<UTC>/parts/photo-N.png` に入り、デザインと同じ封印・検証で **review inbox `~/sr-runs/review-inbox/<依頼 ID>/`** に届く
   （`parts/photo-N.png`、receipt の `request_stage: "photo_materials"`・`images_total` = 枚数、manifest の `image_material: true`・
   `image_material_label: "イメージ素材"`・`photos: [{file, sha256, frame: "3:2"|"1:1"|"2:3"}]`、previews も同じ）。どちらの置き場も 6 枚まで
   （root の実行後の数え方と同じ）。研究ログには入れない（`PHOTO_MATERIALS_NOT_LOGGED`）。worker の結果の 1 行にも `photo_files` が出る。
2. **デザインの段**（今の依頼、`stage: "design"` または省略）に、任意で `photo_inputs` を足す:

   ```json
   "photo_inputs": { "request_id": "req-<shop>-photos-1", "files": [ { "name": "photo-1.png", "sha256": "<sha256>" } ] }
   ```

   files は 1〜6 個（名前と SHA-256 は inbox の manifest の `photos` か結果の `photo_files` から写す）。worker は、その素材の段の run の
   private な出力（inbox の写しではなく、`~/sr-runs/<依頼 ID>-<UTC>/` の中だけ。link なし・通常のファイル・20 MiB まで・
   SHA-256 一致・成功した receipt で kind と shop_id が同じ）からだけ読み、1 回の Codex 実行に `--image` で添付する（Codex の一時作業 dir に写すだけ）。
   **添付した画像をデザインの run の `parts/` や inbox の bundle に写さない**（root は実行後に両方の画像を数え、6 枚を超えると止める）。
   プロンプト: 添付の写真だけをページの写真に使う。写真の枠ごとに小さく「イメージ」、ヘッダーとフッターの隅に小さく「提案用デモ」。
   文字は今までどおり facts pack の値と決まったラベルだけ。写真と店の事実は別の枠に分け、写真の枠は差し替えられる単純な長方形・角丸にする。
3. `--validate-request` は新しい項目も確かめる。`photo_inputs` は形を offline で確かめ、ファイルの検査は素材の段の run があるときだけ
   （結果の `photo_inputs`: `checked` / `unchecked` / `null`）。`unchecked` の依頼は実行では断られる（`PHOTO_INPUT_RUN_MISSING`）。

4. 素材の段の run は inbox に届いたものだけが使える: `photo_inputs` は、その run の receipt が成功（`stop_code` なし・`interrupted: false`・検証済み）で、
   inbox の写しが封印・検証を通り（`image_material: true`、その receipt から封印、各ファイルの SHA-256 が manifest の `photos` と一致）、
   はじめて解決される（そうでなければ `PHOTO_INPUT_RUN_NOT_SUCCEEDED` / `PHOTO_INPUT_NOT_DELIVERED`）。
5. 監査: `imagefirst-audit.ts` は素材の段の bundle（`image_material`）を監査しない（`--dry-run` は `"status":"planned"`、本番は `"status":"completed"`、
   どちらも `"audit":"skipped"`・`"skipped":"image materials are reviewed by Claude, no audit call"`・`calls: 0`、exit 0。Claude を呼ばず、監査を書かない）。
   素材は Claude が自分で 1 枚ずつ確かめる。デザインの段は今までどおり監査する。
6. 実店舗の private な記録の `use`: 素材の段 `sales_proposal_image_material`、写真入りのデザイン `proposal_demo_design`、写真なしのデザインは今までどおり `internal_design_reference_only`。

**DEV-303 §6.1 の 3（[正式な制作フロー](../design/image-first-production-flow.md) §1 段 2・§3.2）以降**: 実店舗のデザインの段は
§E の whole_page だけ。whole_page の依頼に `photo_inputs` は付けられない（`WHOLE_PAGE_PHOTO_INPUTS_REFUSED`。正式な順番はデザイン → 承認 → 素材で、
素材の段の作り直しは §6.1 の 6）。上の 2〜6 の `photo_inputs` は、架空・研究の依頼（節ごとの分割）にだけ残る。

残る危険（受け入れ済み、オーナー決定 2026-11-24 の review）:

- (a) worker と同じ uid なら、`~/sr-runs` に手作りの素材の run（receipt と inbox の写し）を置けば、uid と mode の検査は通りうる。これは、
  実装する Claude がもともと HTML に置けるもの以上を足さない。関門は、完成した頁とスクリーンショットのオーナーの最終確認であり、
  頁に置く素材は、inbox に receipt 付きで届いた run のものに限る。
- (b) `photo_brief` の被写体が商品らしいものでも、止めるのはプロンプトだけ（brief の検査は URL・数字・facts の値などの形の検査）。
  依頼を置く前に、Claude が brief を独立に確かめる（商品・店内・建物・人の顔を被写体にしない）。

### E. デザインの段はページ全体の画像（whole_page。DEV-303 §6.1 の 3）

実店舗のデザインの依頼は `"layout": "whole_page"` だけ（無い・`"section_sequence"` は `REAL_SHOP_WHOLE_PAGE_REQUIRED`）。節ごとの分割（PC 2 + SP 4）は
架空・研究の依頼にだけ残り、その依頼とプロンプトは今までと 1 バイトも変わらない。

```json
{ "schema": "sr_imagefirst_request_v1", "id": "req-<shop>-design-1", "shop_id": "<shop_id>", "kind": "real_shop",
  "created_at": "YYYY-MM-DDTHH:MM:SSZ", "layout": "whole_page", "direction": { … },
  "case_study": { "path": "case-study.json", "sha256": "<記録の SHA-256>" },
  "facts_ref": { "root": "second-root-shops", "shop_id": "<shop_id>" }, "facts_sha256": "<sha256>",
  "max_images": 2, "codex_runs": 1 }
```

- **枚数と枠**: 1 回の Codex 実行で PC 1 枚 + SP 1 枚（`max_images: 2`）。どちらも画像ツールの縦長 2:3（1024x1536。ツールが作れるいちばん縦長の枠）に、
  ページ全体（ヘッダーからフッターまで）を縮めて 1 つの構図で描く。PC と SP は同じ方針の、それぞれ独立した構図。細部が要るときも節ごとに分けない
  （承認した全体の画像を参照する追加の画像で補う。§3.2）。計画（`image_first_request_plan_v0`、`prompt_version: if-req-whole-v0`）は
  `layout: "whole_page"`、各表示 `mode: "whole_page"`・1 枚（節 `page` = 枠全体）・`frame: "portrait_2x3"` を記録する。
- **プロンプト**: 節の順・数をコードで決めない（モデルが原理から決める）。載せる情報の一覧（facts pack の値。順不同。一字一句そのまま）、
  使ってよいラベル、事例分析の `shop_specific_principles` と、数えた例ごとの `principles_to_bring` / `do_not_copy`、PC/SP の独立、
  日本語が情報の中心であること、写真の場所は単純な長方形・角丸の差し替え枠に「イメージ」と書くこと（写真そのもの・商品・料理・店内・建物・人物は描かない）、
  Identity Lock の行（事実を作らない）。
- **成功例の参照画像**: ゲートを通った事例分析の、数えた例の原本（オーナーが選んだ順に、各例の**その例を数えさせた原本**（索引の path と SHA-256、
  または非公開の原本として記録された SHA-256）のうち最初の PNG / JPEG / WebP。例の下に並べた他の画像・頁の HTML・GIF・ZIP は使わない。
  前の例で選んだ画像と同じ SHA-256 は飛ばし、その例の次の原本にする）を最大 5 枚（画像ツールの上限 `IMAGE_TOOL_MAX_REFS`）。
  実店舗では、添付できる原本のある数えた例の数を n として、min(3, n) 枚以上が要る（0 枚は `REFERENCE_IMAGES_MISSING`、足りなければ
  `REFERENCE_IMAGES_TOO_FEW`）。実店舗では、プロンプトに入る原理・写さないことの文に、数字・通貨・値段・年・歴史・人物・受賞・予約などの
  事実らしい印や facts pack の値があれば止まる（`CASE_STUDY_TEXT_HAS_FACT`。写さないことは否定の文なので数字・お金・年・受賞と facts の値だけを見る。区分の一覧は design-director スキルの `references/evidence-and-cases.md`、`--validate-request` は `detail` に区分・項目・例の id を出す）。Codex の一時作業 dir の `inputs/ref-N.<ext>` に写し、`--image` で添付する。
  ツールの `referenced_image_paths` は**絶対パスだけ**を受けるので、計画のプロンプトは各参照を `@@SR_REFERENCE_DIR@@/ref-N.<ext>` と書き、
  実行の直前に image-once.ts がこの印を写した先の絶対パスに置き換える（置き換えるのは Codex に渡す文だけ。計画・その SHA-256・run の
  `prompts/batch.txt` は印のまま。パスはどの記録にも残らない）。印と参照画像が一致しない、または合わせて 6 枚以上の実行は、写す前に止まる。
- **whole_page は事例分析が必須**（架空の依頼でも。`CASE_STUDY_REQUIRED`）。`photo_inputs` は付けられない（`WHOLE_PAGE_PHOTO_INPUTS_REFUSED`）。
- **記録**: run の `reference-inputs.json`（`id`・`case_id`・`sha256` だけ）、receipt の `design_layout: "whole_page"` と `reference_images`
  （同じ 3 項目）、実店舗の private な記録の `design_layout`・`reference_images`。`--validate-request` の結果にも `layout`・`reference_images` が出る。
  封印・検証（bundle.ts）と review の受け渡しは whole_page の run を PC 1 + SP 1 として数える。`image-first-check` の検査は whole_page の表示を
  1 枚の全体画像として扱う（節の宣言は `page` だけ。画面の高さの下限は当てはめず、全体であることはヘッダーとフッターと複数の節の読み取りで確かめる）。

## 2a. Claude の手順（1 店。既存の `real-shop-demo-workflow.md` に画像の段を足しただけ）

1. 候補を選ぶ（営業エージェントの run で登録済みの候補。新しく作らない）。
2. `~/second-root-shops/<shop_id>/facts-pack.json` を書き、**オーナーに値を 1 つずつ確認してもらう**（workflow §2）。
3. `second-root-design-director` スキルで店に固有の方向性を決め、依頼 `~/sr-runs/requests/<依頼 ID>.json` を作る
   （`schema: sr_imagefirst_request_v1`、ID は `req-…`（"imagefirst" を含まない）、`created_at` は `YYYY-MM-DDTHH:MM:SSZ`、`kind: real_shop`、
   方向性、`facts_ref.root: second-root-shops` と facts の SHA-256、`layout: "whole_page"`、`max_images: 2`、`codex_runs: 1`、
   オーナーが確認した事例分析の `case_study`。§E）。置く前に
   `node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --validate-request <file>` で確かめる（root は拾った依頼を断られても回数に数える）。
   依頼 ID は二度と使えない。あとは root の timer が上限の中で動かす（A）。
4. 届いたら `~/sr-runs/review-inbox/<依頼 ID>` を見る（実店舗の記録は `~/second-root-shops/<shop_id>/runs/` に入り、研究ログには書かない）。PC と SP の画像を**参考として**見て、頁 `comp/` を書く（workflow §3。
   写真の枠に置けるのは §C の条件を満たす素材の段の画像だけ。デザインの段の画像そのものを頁に入れない。画像に描かれた商品・店内・人を事実として書かない。文字は facts pack の値だけ）。
5. `comp-lane.ts` で PC1440 / SP390 を描画し、全頁を最後まで見る。`comp-copy.ts --audit` が `owner_review` に届くまで直す。
6. `package-local.ts` → 事実の登録（workflow §5）→ `import-local.ts --facts-from-store`（ローカル）。hosted は runbook B-5a の後だけ。
7. 営業文の下書きを用意し、管理画面でオーナーの品質承認・送信承認を待つ。**送信はオーナーが手で行う。**
8. 生成が要件を満たさなければ、同じ依頼 ID は使わず、方向性を直した新しい依頼にする（上限の中で。自動の再試行はしない）。
9. 写真素材を使う場合（§2 D。架空・研究の依頼だけ。実店舗の whole_page のデザインには `photo_inputs` を付けられない）: 3 の前に素材の段の依頼を置き、inbox に届いた素材を確かめてから、manifest の `photos`（または結果の `photo_files`）をデザインの段の `photo_inputs` に写す。
   素材を頁に使うときは MVP_SPEC §7.1 の限定の改定の 5 条件（「イメージ」の表示・店の物として見せない・事実と分ける・「提案用デモ」の表示・差し替えられる）をすべて守る。

## 3. オーナーの判断・承認が要るもの

1. **A の設置**（一度だけ）: #326 → #328 → A の PR のマージ、`check` → `apply` → `standing`（上限の値）→ `enable-timer`。
2. **店ごとの事実の確認**（facts pack の値を 1 つずつ）。
3. **デモの品質承認と送信承認**（今のまま。自動送信なし）。
4. **共有 URL を出すための本番の設定**（`docs/operations/sales-mvp-runbook.md` の B-1〜B-6: migration・bucket・成果物の origin・環境変数・共有の切り替え）。
   これが無いと、相手に送れるデモの URL ができない。最初の案件のためには、どこかの時点で必要。
   なお、この WSL の jail では Docker が動いていない（2026-11-23 に確認）ため、ローカルの Supabase は使えない。jail の中でできるのは
   `package-local.ts` の包みまで。デモの保存（事実の登録・取り込み）は、hosted（Staging）の B-5a の承認の後か、Docker が動く別の環境で行う。
