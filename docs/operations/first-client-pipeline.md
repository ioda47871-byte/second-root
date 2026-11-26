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

### D. 素材の段は承認したデザインの後（DEV-303 §6.1 の 6。最初はオーナー決定 2026-11-24。MVP_SPEC §7.1 の限定の改定）

**正式な順番は デザイン（§E）→ 審査とオーナーの承認（§G）→ 素材。** 素材を先に作ってデザインを合わせる古い順番（素材の段 → `photo_inputs` 付きのデザイン）は、
実店舗には使えない。各段とも 1 依頼 ID = 1 回の Codex 実行・最大 6 枚・再試行なし（root の上限・1 回限りの記録は今のまま）。

1. **素材の段** `stage: "photo_materials"`: **承認したデザインが必要とする**写真・背景・装飾の**画像素材**を 1〜6 枚（店の記録ではない）。
   依頼には `approved_design`（承認したデザインの run の bundle の ID と SHA-256、店の非公開の `design-reviews/` にある審査と承認の記録のファイル名）が必須
   （無ければ実店舗も架空・研究の依頼も `APPROVED_DESIGN_REQUIRED`）（オーナー決定 2026-11-25: 古い `photo_brief` の依頼は、すでに置いたものも `APPROVED_DESIGN_REQUIRED`。互換の道は作らない）。worker と `--validate-request` は `approvedDesignRun`（§G）でゲートの検査をし、
   どれかの `DESIGN_*` の停止・記録の欠け（`APPROVED_DESIGN_MISSING`）・link（`APPROVED_DESIGN_UNSAFE`）・別の run や店（`APPROVED_DESIGN_MISMATCH`）なら止まる。
   架空の店の依頼も同じ（記録はリポジトリの外に置くので、`facts_ref.root` は `second-root-shops`）。
   素材は自由な題材ではなく、**承認したデザインから決めた一覧** `materials`: 各素材 `{ id, kind: photo | background | decoration, aspect: landscape_3x2 |
   square_1x1 | portrait_2x3, placement（承認した PC/SP のデザインのどこに置くか、120 字まで）, note（200 字まで） }`。同じ枠は 2 つまで
   （`MATERIALS_ASPECT_FULL`。ファイルは枠ごとの場所: 横 3:2 は photo-1・2、正方形は photo-3・4、縦 2:3 は photo-5・6）。
   文字・ロゴ・人の顔・店の外観や店内・建物・その店の商品として見せる物・値段やメニューの表示は入れない（§7.1 の条件のとおり、頁では「イメージ」と表示し、差し替えられる枠に置く）。
   承認したデザインの PC/SP の画像（全部で 5 枚以内ならすべて、それより多い古い節ごとの分割のデザインでは PC と SP の最初の 1 枚ずつ。オーナー決定 2026-11-25。正式な制作は PC・SP のページ全体の 2 枚）を参照画像として添付し
   （§E と同じ印の仕組みで、Codex に渡す文だけ絶対パスに置き換える）、素材をデザインの色・光・質感に合わせる。

   ```json
   { "schema": "sr_imagefirst_request_v1", "id": "req-<shop>-materials-1", "shop_id": "<shop_id>", "kind": "real_shop",
     "created_at": "YYYY-MM-DDTHH:MM:SSZ", "stage": "photo_materials",
     "approved_design": { "bundle_id": "req-<shop>-design-1", "bundle_sha256": "<sha256>", "review_file": "req-<shop>-design-1.review.json", "approval_file": "req-<shop>-design-1.approval.json" },
     "materials": [ { "id": "hero-texture", "kind": "photo", "aspect": "landscape_3x2", "placement": "<どこに>", "note": "<何を>" } ],
     "mood": "<300 字まで>", "avoid": "<300 字まで>",
     "facts_ref": { "root": "second-root-shops", "shop_id": "<shop_id>" }, "facts_sha256": "<sha256>",
     "max_images": <materials の数>, "codex_runs": 1 }
   ```

   一覧の文は direction と同じ検査（URL・HTML・引用符・3 桁以上の数字・通貨記号・facts の値を含めない。`REQUEST_MATERIALS_UNSAFE` / `REQUEST_MATERIALS_HAS_FACT`）。
   記録: run の `materials.json`（一覧）と `approved-design-input.json`（承認したデザインの bundle の ID・SHA-256、審査と承認の記録の SHA-256、一覧の SHA-256）、
   receipt の `approved_design` と `materials_sha256`、実店舗の private な記録の同じ項目、`--validate-request` の結果の同じ項目（パスは残さない）。
   封印と review の受け渡しは receipt と `approved-design-input.json` を比べる（`APPROVED_DESIGN_INPUT_MISMATCH`）。
   この変更より前に封印した素材の bundle（`photo_brief` の古い receipt。例: 研究の run `req-vatten-photo-01`）は、もう `verifyBundleDir`・review の受け渡しを通らない。
   研究の記録として残すだけで（オーナー決定 2026-11-25: vatten の古い素材と過去の実験の記録は削除・移動しない）、正式なフローには使わない。結果は private の
   `~/sr-runs/<依頼 ID>-<UTC>/parts/photo-N.png` に入り、デザインと同じ封印・検証で **review inbox `~/sr-runs/review-inbox/<依頼 ID>/`** に届く
   （`parts/photo-N.png`、receipt の `request_stage: "photo_materials"`・`images_total` = 枚数、manifest の `image_material: true`・
   `image_material_label: "イメージ素材"`・`photos: [{file, sha256, frame: "3:2"|"1:1"|"2:3"}]`、previews も同じ）。どちらの置き場も 6 枚まで
   （root の実行後の数え方と同じ）。研究ログには入れない（`PHOTO_MATERIALS_NOT_LOGGED`）。worker の結果の 1 行にも `photo_files` が出る。
2. **（架空・研究の依頼だけ）節ごとの分割のデザインの段**に、任意で `photo_inputs` を足す（その素材の run も、上のとおり承認したデザインの後でしか作れない）:

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
- (b) 素材の一覧の `note` が商品らしいものでも、止めるのはプロンプトだけ（一覧の検査は URL・数字・facts の値などの形の検査）。
  依頼を置く前に、Claude が一覧を独立に確かめる（商品・店内・建物・人の顔を題材にしない）。

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

### F. オーナーが承認した日本語訳（DEV-303 §6.1 の 4）

事実パックに英語など別の言葉でしかない事実（例: 英語の紹介文）は、**オーナーが承認した日本語訳**としてだけ、自然な日本語で頁と依頼に出せる。

- **記録**: 店ごとの非公開の `sr_ja_renderings_v1`（例: `~/second-root-shops/<shop_id>/ja-renderings.json`。リポジトリの外、事実パックの隣）。
  `{ schema, shop_id, entries: [{ fact_key, source_text, ja_text, note? }], owner_confirmation?: { confirmed: true, confirmed_at, entries_sha256 } }`。
  `source_text` は事実パックのその key の値と**完全に同じ**文字列。`ja_text` は 1 行・300 字まで・URL や HTML なし。1 つの key に 1 つの訳。
- **訳は事実を足さない**: 原文に無い数字（算用数字・漢数字の並び「三十」「十数」「〇三」・助数詞つきの漢数字「七時」「三種」）、値段・メニュー、日付・時間、歴史、人物、
  素材・産地、受賞・掲載、評判、お客様の声、効能・保証、予約・在庫・限定の印、漢字・ひらがな・カタカナ・ローマ字以外の文字（`script`）、原文の単語に無いローマ字の語
  （`proper_noun`。語ごとに比べる）があれば `JA_RENDERING_ADDS_FACT`（区分・項目・key だけを出し、文は出さない）。原文の数字に 年・時・月・日 を付けるのはよい。
  算用数字以外の数字（アラビア・インドの数字、〇 など）と大字（壱・弐・参・拾・廿 など）も数字として扱う。原文の単語にある語（例 Café）なら、ローマ字以外の文字を含む語も使える。
  **厳しめに作ってある**: 「一つ」「一番」「一人」「十分」「八百屋」のような日常の語も止まる。原文が数を言葉で書いている（例 twelve seats）とき、訳で数字（12席・十二席）にはできない。
  **この検査は数字・事実らしい印・日本語以外の文字・ローマ字の語だけを見る仕掛け（tripwire）**で、印の無い名前・地名・営業の言い方
  （例「東京都渋谷区」「ジョン・スミス」「週末だけ営業」）は止まらない。それらはオーナーの確認で見る。
- **検査**: `npx tsx scripts/design-artifact/ja-renderings-check.ts --check <ja-renderings.json> --facts <facts-pack.json> [--draft]`。
  `--draft` はオーナーの確認の前。既定（ゲート）は `owner_confirmation.entries_sha256` が表示される `entries_sha256`（entries の正規化した JSON の SHA-256）と一致することを求める。
  **`owner_confirmation` を書くのは Claude で、オーナーが訳を確認したと言ったときだけ**。これは「Claude が、オーナーがこの訳を確認したと記録した」証拠であって、**オーナー本人の署名ではない**。
  確認の後に訳を直せば `JA_RENDERINGS_SHA_MISMATCH` になり、確認はやり直し。
- **依頼**: 実店舗の whole_page のデザインの依頼に `"ja_renderings": { "path": "ja-renderings.json", "sha256": "<記録の SHA-256>" }` を入れられる
  （whole_page 以外は `JA_RENDERINGS_NOT_WHOLE_PAGE`）。worker と `--validate-request` がゲートの検査を行う（`--validate-request` の結果に `ja_renderings: {sha256, keys}`、
  拒否では `detail` に区分・項目・key）。プロンプトの載せる情報の一覧では、訳のある事実を「訳（オーナーが承認した日本語訳）」とだけ出し、原文は画像のプロンプトに入れない
  （書く文字の一覧に原文を混ぜない。原文との結びつきは計画の SHA-256 とゲートの検査が持つ）。
  訳の無い事実は今までどおり原文。計画・receipt・実店舗の private な記録には `ja_renderings_sha256` だけを残す（パスは残さない）。節ごとの分割の依頼とその固定値は変わらない。
- **実装（文章の監査）**: `comp-copy.ts --audit|--gate|--revise <comp> --facts <facts-pack.json> --ja-renderings <ja-renderings.json>`。copy.json の項目
  `claim_type: "approved_rendering"`（`source_fact_ids` はその事実 1 つ）は、文がその key の承認済みの `ja_text` と同じときだけ通る（`RENDERING_NOT_APPROVED` / `RENDERING_WITHOUT_ONE_FACT`）。
  それ以外の文は今までどおりの検査。監査の記録は訳の記録の SHA-256（`ja_renderings_sha256`）に結びつき、訳が変われば古くなる（`REVIEW_STALE_JA_RENDERINGS`）。

### G. デザイン審査とオーナーの承認（段 3。DEV-303 §6.1 の 5）

**生成の成功（画像が保存された）だけでは次の段（素材の生成・本実装）へ進まない。** review inbox に届いたデザインの run
（`~/sr-runs/review-inbox/<依頼 ID>/`、封印された bundle。中にファイルを足さない）ごとに、審査の記録とオーナーの承認の記録を、
リポジトリの外の非公開の置き場（実店舗は `~/second-root-shops/<shop_id>/design-reviews/<依頼 ID>.review.json` と `.approval.json`）に置く。

- **審査の記録** `sr_design_review_v1`: `request_id`、`bundle_sha256`（bundle の SHA-256）、`images`（bundle の `parts/pc-*.png`・`parts/sp-*.png` と SHA-256。
  bundle の manifest と完全に同じ）、5 つの観点（§3.3）`originality`（独自性）・`shop_specificity`（店舗固有性）・`information_design`（情報設計）・
  `japanese`（日本語）・`pc_sp_completeness`（PC/SP の完成度）。各観点は `verdict`（`pass` 合格 / `revise` 要修正 / `fail` 不合格）と、
  1 件以上の根拠 `evidence: [{ image: "pc" | "sp", region（画像のどこか、80 字まで）, note（1 行、300 字まで） }]`。`reviewer`（例 `independent-subagent`。
  Claude の別の文脈）、`reviewed_at`。**審査は助言**で、判定はオーナーが下す。
- **確認ページ**: `npx tsx scripts/design-artifact/design-approval-check.ts --page --bundle <review-inbox/<依頼 ID>> --review <review.json> --out <非公開の空の出力先>`。
  静的な HTML（script なし・通信なし・CSP。画像は横に写す。文はすべて escape）。表示される `page_sha256` と `review_sha256` を承認の記録に使う。
- **承認の記録** `sr_design_approval_v1`: `request_id`、`bundle_sha256`、`approved_images`（審査と同じ画像と SHA-256）、`review_sha256`（審査の記録のファイルの SHA-256）、
  `page_sha256`（オーナーが見たページ）、`decision`（`approve` / `revise` / `reject`）、`decided_at`、`note`（任意）。
  **承認の記録を書くのは Claude で、オーナーが決めたと言ったときだけ**。これは「Claude が、オーナーがこの審査とページを見てこう決めたと記録した」証拠であって、
  **オーナー本人の署名ではない**。審査を後で直せば `review_sha256` が合わなくなり、承認はやり直し。
- **検査**: `design-approval-check.ts --check --bundle <dir> --review <review.json> --approval <approval.json>`（既定はゲート）。bundle の検証、画像と SHA-256 の一致、
  5 観点と根拠、承認が同じ審査・ページ・画像に結びつくこと、`decision: approve` を確かめる。**どれか 1 つの観点が `fail` なら承認は通らない**
  （`DESIGN_REVIEW_HAS_FAIL`。オーナーが通したいときは、新しい審査か新しいデザインにする）。`revise` は助言なので、オーナーは承認できる。
  `--draft` は承認の前（審査だけ）。止まったときは `DESIGN_*` の決まった名前だけを出す。承認の `decided_at` は審査の `reviewed_at` より前にできない（`DESIGN_APPROVAL_BEFORE_REVIEW`）。
  `page_sha256` は検査のたびに審査と run からページを描き直して計算するので、ページのひな形や escape の仕方が変われば、それより前の承認は通らなくなる（安全側。オーナーは新しいページを見直す）。
- **後の段**: 素材の段（§D、§6.1 の 6）はこの承認を前提にする（`lib/design-agent/imagefirst-worker/design-approval.ts` の `approvedDesignRun` が、
  承認された run の画像と SHA-256 を返すか止まる）。素材の依頼の `approved_design` が、この審査と承認の記録のファイル名を名指しする。

### H. 素材の審査とオーナーの承認、実装で使える素材の検査（段 4 → 段 5。DEV-303 §6.1 の 7）

**段 5 の実装で頁に置ける画像は、オーナーが承認した素材のファイルそのもの（SHA-256 で照合）だけ。** 素材の生成の成功だけでは使えない。

- **前提**: 素材の run（`~/sr-runs/review-inbox/<素材の依頼 ID>/`、`image_material` の封印された bundle）は、承認したデザイン（§G）のために作ったもの。
  bundle の receipt の `approved_design`（デザインの run の ID と bundle・審査・承認の SHA-256、§D）が、検査で渡すデザインの記録と一致し、
  そのデザインが §G のゲートを今も通ること（同じ店・同じ種類）。違えば `MATERIALS_DESIGN_MISMATCH`、デザインのゲートの停止は `DESIGN_*` のまま出す。
- **審査の記録** `sr_materials_review_v1`（`~/second-root-shops/<shop_id>/design-reviews/<素材の依頼 ID>.materials-review.json`。リポジトリの外）:
  `request_id`、`bundle_sha256`、`materials`（bundle の全部の画像を順に: `id`（素材の一覧の ID）・`file`（`parts/photo-N.png`）・`sha256`（bundle のもの）・
  `verdict`（`pass` / `revise` / `fail`）・`note`（1 行、300 字まで））、`reviewer`（Claude の別の文脈）、`reviewed_at`。**審査は助言**。
  見る観点は §2a の 9 と MVP_SPEC §7.1 の 5 条件（文字・ロゴ・人の顔・店の物に見える物が無いか、承認したデザインから写した文字や構図が無いか）。
  審査の `id` は素材の依頼の一覧の ID と**照合しない**（bundle には一覧の SHA-256 `materials_sha256` しか無いため）。審査する Claude が依頼の一覧を見て正しく書く。
- **確認ページ**（オーナー承認 2026-11-26）: `npx tsx scripts/design-artifact/materials-impl-check.ts --page --design-bundle <dir> --design-review <file> --design-approval <file> --materials-bundle <dir> --materials-review <file> --out <非公開の空の出力先>`。
  §G と同じ形の静的な HTML（script なし・通信なし・CSP。素材の画像は検証した bundle から横に写す。各素材の審査の判定と所見を並べる。文はすべて escape。承認は載せない）。
  出力先はリポジトリの外で、空か無い場所（作ると 0700、ファイルは 0600）。表示される `page_sha256` と `review_sha256` を承認の記録に使う。
- **承認の記録** `sr_materials_approval_v1`（同じ置き場の `.materials-approval.json`）: `request_id`、`bundle_sha256`、`review_sha256`（審査の記録のファイルの SHA-256）、
  `page_sha256`（オーナーが見た確認ページ。検査のたびに審査と run から描き直して照合するので、審査やページのひな形が変われば承認はやり直し）、`approved_materials`（使ってよい画像の `file` と `sha256`。審査した画像だけ、審査の順で 1〜6 枚。外した画像は使えない）、`decision`（`approve` / `revise` / `reject`）、
  `decided_at`（審査より前にできない）、`note`（任意）。**承認の記録を書くのは Claude で、オーナーが確認ページを見て、承認と使ってよい素材をはっきり決めたと言ったときだけ**
  （Claude が自分の判断で素材を承認済みにすることはない）。これは記録であって**オーナー本人の署名ではない**。
  `fail` の画像は承認できない（`MATERIALS_APPROVAL_HAS_FAIL`。新しい審査か新しい素材にする）。`revise` はオーナーが決めれば承認できる。
  承認がページと違えば `MATERIALS_APPROVAL_PAGE_MISMATCH`。
- **検査（ゲート）**: `npx tsx scripts/design-artifact/materials-impl-check.ts --design-bundle <dir> --design-review <file> --design-approval <file> --materials-bundle <dir> --materials-review <file> --materials-approval <file>`。
  `--materials-approval` を省くと審査だけの確認（承認の前）。`lib/design-agent/imagefirst-worker/materials-approval.ts` の `approvedMaterials` が、承認された画像と SHA-256 を返すか、
  `MATERIALS_*` の決まった名前で止まる。
- **段 5 の実装の検査**: 上に `--site <頁の置き場>` を足す（頁はリポジトリの外。例 `~/second-root-shops/<shop_id>/site-<n>/`。何も書かない・ブラウザも通信も使わない）。
  - 頁の中の画像のファイル（拡張子か先頭のバイトで判定）は `assets/` の直下だけ（`MATERIALS_IMPL_IMAGE_OUTSIDE_ASSETS`）で、SHA-256 が承認した素材のものだけ（`MATERIALS_IMPL_IMAGE_NOT_APPROVED`）。
    縮小・変換・再圧縮したものは別の画像として断られるので、**承認したファイルをそのまま使う**（大きさは CSS で合わせる）。
  - `<img src>`・`srcset`・`<source srcset>`・CSS の `url()` は承認した素材の `assets/` のファイルだけ（`MATERIALS_IMPL_IMAGE_REF_NOT_APPROVED`）。外部の URL は `MATERIALS_IMPL_EXTERNAL_IMAGE`。
    それ以外の属性の `url()`（SVG の `mask`・`fill` など）は `MATERIALS_IMPL_IMAGE_IN_ATTRIBUTE`（使った素材を数え漏らさないため）。
  - 店舗の版のデモの HTML/CSS の検査（`checkArtifactHtml`）も通す。どれか 1 つでも見つかれば `MATERIALS_IMPL_HTML_UNSAFE`（安全側。`<style>` や script で画像を持ち込めないように）。
  - 「イメージ」の表示: 承認した素材を出す `<img>` は、`<figcaption>` に「イメージ」を含む `<figure>` の中に置く（`MATERIALS_IMPL_LABEL_MISSING`）。`figcaption`・`figure`・その祖先に `hidden` か `aria-hidden="true"` があれば表示なしとみなし、`figcaption` の中の隠した要素の文字も数えない（CSS で隠すことは確かめない）。
    **確かめないもの**: CSS の背景・装飾として使った素材の表示（結果に `label: "not_checked"`。写真の枠なら審査で見る）、枠が差し替えられる単純な長方形か（§7.1 の 5）、
    「提案用デモ」の表示（§7.1 の 4）、画像に何が写っているか（素材の審査）。
  - 結果は使った素材（`used`: どのファイルを `img` か `css` で）と使わなかった素材、見つかった問題の一覧。問題が 1 つでもあれば `refused`（終了コード 1）。

## 2a. Claude の手順（1 店。既存の `real-shop-demo-workflow.md` に画像の段を足しただけ）

1. 候補を選ぶ（営業エージェントの run で登録済みの候補。新しく作らない）。
2. `~/second-root-shops/<shop_id>/facts-pack.json` を書き、**オーナーに値を 1 つずつ確認してもらう**（workflow §2）。
3. `second-root-design-director` スキルで店に固有の方向性を決め、依頼 `~/sr-runs/requests/<依頼 ID>.json` を作る
   （`schema: sr_imagefirst_request_v1`、ID は `req-…`（"imagefirst" を含まない）、`created_at` は `YYYY-MM-DDTHH:MM:SSZ`、`kind: real_shop`、
   方向性、`facts_ref.root: second-root-shops` と facts の SHA-256、`layout: "whole_page"`、`max_images: 2`、`codex_runs: 1`、
   オーナーが確認した事例分析の `case_study`。§E）。置く前に
   `node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --validate-request <file>` で確かめる（root は拾った依頼を断られても回数に数える）。
   オーナーが送る中身を見るときは、同じ CLI の `--print-plan <file>`（DEV-303、2026-11-26。offline・読むだけ・jail の中でも動く・Codex を呼ばない）で、
   1 回の Codex の run に渡すバッチの prompt（`sent.prompt`。参照の画像は `@@SR_REFERENCE_DIR@@/ref-N.<ext>` と書かれ、実行の直前に一時作業 dir の `inputs` の絶対パスに置き換わる）、
   添付の順・参照の id と事例・SHA-256・置かれるパス（`sent.attachments`）、entry に渡す固定値（`entry_pins`）、plan の全体と `plan_sha256`（`--validate-request`・worker・entry と同じ値）を出す。
   出力には prompt が引く facts の値が入る（オーナーの確認用。リポジトリに置かない）。
   依頼 ID は二度と使えない。あとは root の timer が上限の中で動かす（A）。
4. 届いたら `~/sr-runs/review-inbox/<依頼 ID>` を見る（実店舗の記録は `~/second-root-shops/<shop_id>/runs/` に入り、研究ログには書かない）。PC と SP の画像を**参考として**見て、頁 `comp/` を書く（workflow §3。
   写真の枠に置けるのは §C の条件を満たす素材の段の画像だけ。デザインの段の画像そのものを頁に入れない。画像に描かれた商品・店内・人を事実として書かない。文字は facts pack の値だけ）。
5. `comp-lane.ts` で PC1440 / SP390 を描画し、全頁を最後まで見る。`comp-copy.ts --audit` が `owner_review` に届くまで直す。
6. `package-local.ts` → 事実の登録（workflow §5）→ `import-local.ts --facts-from-store`（ローカル）。hosted は runbook B-5a の後だけ。
7. 営業文の下書きを用意し、管理画面でオーナーの品質承認・送信承認を待つ。**送信はオーナーが手で行う。**
8. 生成が要件を満たさなければ、同じ依頼 ID は使わず、方向性を直した新しい依頼にする（上限の中で。自動の再試行はしない）。
9. 写真素材を使う場合（§2 D）: デザインが届いたら §G の審査とオーナーの承認を記録し、**その後で**、承認したデザインから決めた `materials` と `approved_design` を持つ素材の段の依頼を置く。
   inbox に届いた素材は Claude が 1 枚ずつ確かめ（§C の項目に加えて、参照に渡した承認済みのデザインから写した文字・店名・構図が入っていないか）、§H の審査とオーナーの承認の後、承認した素材だけを本実装（§C）に使い、§H の `--site` の検査を通す。（架空・研究の依頼だけは、届いた素材を節ごとの分割のデザインの `photo_inputs` に写してもよい。実店舗の whole_page のデザインには付けられない。）
   素材を頁に使うときは MVP_SPEC §7.1 の限定の改定の 5 条件（「イメージ」の表示・店の物として見せない・事実と分ける・「提案用デモ」の表示・差し替えられる）をすべて守る。

## 3. オーナーの判断・承認が要るもの

1. **A の設置**（一度だけ）: #326 → #328 → A の PR のマージ、`check` → `apply` → `standing`（上限の値）→ `enable-timer`。
2. **店ごとの事実の確認**（facts pack の値を 1 つずつ）。
3. **デモの品質承認と送信承認**（今のまま。自動送信なし）。
4. **共有 URL を出すための本番の設定**（`docs/operations/sales-mvp-runbook.md` の B-1〜B-6: migration・bucket・成果物の origin・環境変数・共有の切り替え）。
   これが無いと、相手に送れるデモの URL ができない。最初の案件のためには、どこかの時点で必要。
   なお、この WSL の jail では Docker が動いていない（2026-11-23 に確認）ため、ローカルの Supabase は使えない。jail の中でできるのは
   `package-local.ts` の包みまで。デモの保存（事実の登録・取り込み）は、hosted（Staging）の B-5a の承認の後か、Docker が動く別の環境で行う。

## 4. 段 6: 実装と承認したデザインの比較（DEV-303 §6.1 の 8）

[正式な制作フロー](../design/image-first-production-flow.md) §1 段 6。承認したデザイン（§G）の run と、Claude が実装した静的な頁を比べる。

- **実行**: `npx tsx scripts/design-artifact/impl-compare-approved.ts --bundle <review-inbox/<依頼 ID>> --review <審査の記録> --approval <承認の記録> --site <頁の置き場> --out <非公開の空の出力先>`。
  先に承認のゲートの検査（`approvedDesignRun`）を行い、`DESIGN_*` で止まればそこで終わる。比べるのは PC・SP のページ全体の画像が 1 枚ずつの run だけ（`IMPL_DESIGN_NOT_WHOLE_PAGE`）。
- **頁**: リポジトリの外（例 `~/second-root-shops/<shop_id>/site-<n>/`）の `index.html`・`style.css`・`assets/*.png` だけを読み、Chromium で JS なし・通信なしに PC 1440 と SP 390 の全体を撮る。
  リポジトリの中・link・足りないファイルは止まる（`IMPL_SITE_*`）。ファイルごとの上限は実装レーンの比較と同じ、全部で 64 MiB まで（`IMPL_SITE_TOTAL_TOO_LARGE`）。撮影の失敗は止まる（`IMPL_CAPTURE_FAILED`）。横のはみ出しと、読み込めなかった画像などの要求は**所見**として記録する。
- **比べ方**: 承認した画像を同じ幅に拡大縮小し、既存の比較（実装レーンの比較、DEV-131 の暫定の閾値）でページ全体の配置（SSIM）・色の塊・線の密度・高さの比を測る。
  ページ全体の画像は縮めた全体像なので、高さの比と `PAGE_HEIGHT` は違って当然。ページ全体の数値は撮影をデザインの縦横比に縮めて測るので、頁の本当の縦横比は測らない（高さはそのまま記録する）。節の宣言が無いので、節ごとの順・位置・色・大きさは測らない。文章は文章の監査（§F・`comp-copy.ts`）とオーナーが見る。
- **記録**: `--out` に `record.json`（`sr_impl_compare_v1`: 承認の bundle・審査・承認の SHA-256、頁のファイルと撮影の SHA-256、表示ごとの数値・違い・所見、道具の版）、
  `images/`（拡大縮小したデザインと撮影）、`index.html`（静的な確認ページ。script なし・通信なし・CSP）。リポジトリの中には書かない。
- **扱い**: 数値は**オーナーの確認のための助言**で、それだけで合否を決めない（`passing` は常に false）。段 6 から先へ進むのは、再現性の審査（§3.3 の観点で見る）と Q1 の合格をオーナーが確かめたときだけ。
