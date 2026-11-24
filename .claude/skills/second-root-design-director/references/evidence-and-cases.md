# 成功例30件の読み方

正本は次の3つである。この表は道案内であり、食い違ったら正本が正しい。

- `design-library/success-cases/manifest.json` — 30件の登録 (`registered_case_count: 30`)、証拠の種類、方針
- `design-library/success-cases/CP-*.md` — 1件ずつの記録
- `design-library/intelligence/v01/success-patterns.json` — 1件ずつの `shop_motifs` /
  `structural_translation` / `visual_mechanisms` / `known_failure_modes` / `not_to_copy`
  (scope は `research_only_not_auto_prompt_input`。研究資料であり、そのまま prompt に入れない)

## 証拠の強さ (混ぜない)

| 印 | 意味 | 該当 | 書き方 |
| --- | --- | --- | --- |
| **画像** | リポジトリに画像の実物がある | CP-001、CP-002 (concept)、CP-003 (PC と SP の HTML 試作の画面) | 見て学べる。見たなら「画像で確認」と書く |
| **承認済み参照** | 画像があり、生成への参照として承認され SHA で固定されている | CP-003-pc、CP-003-sp だけ (`design-library/phase2f/references/success-references-v1.json`、1呼び出し2枚まで) | Codex への指示文に渡してよいのはこれだけ |
| **文章** | 記録と分析の文章だけ。画像の原本はリポジトリに無い | CP-004〜013、CP-015〜023 | 「記録によれば」と書く。見た目を想像で補わない |
| **疑似復元** | 原本の代わりに作り直したもの | CP-024 の v3 (承認されたのは v2。v3 はリポジトリにも無い) | 承認された意匠として扱わない |
| **原本なし** | 原本が手に入らず、所有者の採用は集団での報告 | CP-026〜032 (`original_unavailable`) | 「原本未確認の記録によれば」と書く |
| **成功ではない** | 研究の対象だが成功例ではない | CP-014、CP-025 | 失敗の教訓として読む (`failure-patterns.md`) |

**欠けている画像を、あるものとして扱わない。**「CP-017 の画像を見ると」のような書き方は誤りである。

## 30件の早見表

「翻訳」は、店の世界の何をページ構造へ移したか (記録の要約。正本で確かめる)。

| id | 店 (業種) | 実装の形 | 証拠 | 翻訳 |
| --- | --- | --- | --- | --- |
| CP-001 | Mond (喫茶) | concept | 画像 | 大きなセリフの店名が、幅の違う写真の面をまたぐ |
| CP-002 | Sissi (花屋) | concept | 画像 | 枝の分かれ方が読む向きと余白を決める |
| CP-003 | なごやビーンズ v4 (焙煎) | HTML 試作 | 画像 (PC・SP、承認済み参照) | 焙煎9段の地図。節ごとに律動を変える。SP は組み直し |
| CP-004 | harebare (焼き菓子) | HTML 試作 | 文章 | 独楽の回る軌道 |
| CP-005 | Hamsa (パン) | concept + 試作 | 文章 | パンの断面の窓で節を移る |
| CP-006 | Melon de Mille (タルト) | concept | 文章 | 斜めに切って重ねた面 |
| CP-007 | ORGN. (古着リメイク) | HTML 試作 | 文章 | 裁ち線と縫い目で写真をつなぐ |
| CP-008 | 整体院 Go. (整体) | concept (PC/SP) | 文章 | 巨大な GO. と黄色の道筋、密から疎へ |
| CP-009 | 豆＊豆 (布小物) | HTML 試作 | 文章 | ヨーヨーキルトの星座と赤い扉 |
| CP-010 | PT-02 (本屋・紙芝居) | HTML 試作 | 文章 | 本棚を目次にする |
| CP-011 | BAR N (バー) | HTML 試作 | 文章 | 大きなグラス、暗と明をまたぐ屈折 |
| CP-012 | Admy (石の装身具) | 全頁 concept | 文章 | 鉱物標本の札 |
| CP-013 | スペースたのしい (玩具) | concept | 文章 | ブリスターパックの Hero |
| CP-015 | imairo. (スパイス喫茶) | 試作 | 文章 | 卓を地図に、紙の覚え書き |
| CP-016 | ズールー工作所 (モビール) | SVG 試作 | 文章 | 支点と釣り合いをレイアウトに |
| CP-017 | Rurikoyarn (毛糸) | concept | 文章 | 暗地に大きな糸の輪 |
| CP-018 | MOLE FACTORY (版画) | concept | 文章 | ずれた版の重なり |
| CP-019 | 浦田杏梨 (蝋の作家) | concept | 文章 | BEFORE / MELTING / AFTER |
| CP-020 | 喫茶 ITALICO | concept | 文章 | ガラスケースを格子に |
| CP-021 | TERACE (アクリル) | concept (条件付き) | 文章 | 選んで組む作業台 |
| CP-022 | Harissy (ドーナツ) | concept | 文章 | 崩れ・割れの読む道 |
| CP-023 | BURGERS,INC (バーガー / 夜のバー) | concept | 文章 | 裏返る看板 |
| CP-024 | Boheme. v2 (花) | 全頁試作 | 文章 (v3 は疑似復元) | 鏡の試着室と LOOK の切替 |
| CP-026 | Sawaddee Chao (タイ喫茶・雑貨) | 全頁試作 | 原本なし | 店の手帖・案内書 |
| CP-027 | MATO (2階建ての店) | 全頁試作 | 原本なし | 階と階のあいだ |
| CP-028 | ユメツナベース (ZINE の場) | 全頁試作 | 原本なし | 8頁の折り ZINE |
| CP-029 | SNOWMY (かき氷) | 全頁試作 | 原本なし | 柔らかいポップ、土台と具の選択 |
| CP-030 | 高田時計店 (時計修理) | 全頁試作 | 原本なし | 通り → 陳列 → 相談票 |
| CP-031 | リフォーム中村 (着物リメイク) | 全頁試作 | 原本なし | 裁断台 |
| CP-032 | 玉虫屋 (玉虫の装身具) | 全頁試作 | 原本なし | 見る角度で色が変わる |

## 選び方

1. 店の世界の棚卸しで出た「中心の比喩」の候補と、翻訳の型が近い例を2〜3件選ぶ
   (例: 道具や台がある店 → CP-016、CP-021、CP-031。工程や時間がある店 → CP-003、CP-019)
2. 同じ業種の例を選ぶときは、写す危険が高いことを自覚する。翻訳の型が違う例も1件入れる
3. 各例の `known_failure_modes` と `not_to_copy` を読み、方向案に持ち込まない

## デザイン着手前の分析の記録と確認ページ (必須、Issue #336)

正式な制作フロー (`docs/design/image-first-production-flow.md` 段 1、§3.1) では、店のデザイン
(方向案・指示文・依頼・実装) に入る前に、**原本を実際に見た成功例を 3 件以上**記録し、
**オーナーが原本の選定と採用する原理を確認**していなければならない。見ていない例を「参照した」と書けないよう、
記録と検査で止める。

1. **原本を開く。**原本を開ける成功例 (区分 A) は `design-library/success-cases/originals-index.json` にある
   (id・パス・SHA-256・`counts_as_reference`)。他店の参照に数えられるのは CP-001・CP-002・CP-003 だけで、
   SR-001 は頁を描画して見てよいが**数えない** (台帳の方針)。区分 B・C の原本は、オーナーから受け取り
   非公開の置き場 (リポジトリの外) に置いて SHA-256 を確かめたときだけ使える
2. **記録を書く。**店ごとの `case-study.json` (`sr_case_study_v1`) を、リポジトリの外の非公開の置き場
   (例: `~/second-root-shops/<shop_id>/case-study.json`、事実パックの隣) に書く。各例に
   - `id`、`evidence_kind` (`image` 画像で確認 / `page_render` 頁を描画して確認 / `text_only` 文章だけ)
   - `files` — **実際に開いた**ファイルの `path` と `sha256` (リポジトリの原本はリポジトリからの相対パス、
     非公開の原本は絶対パスで `private_verified: true` を付ける)
   - `observations` — 構図 (`composition`)・情報設計 (`information_design`)・店らしさ (`shop_character`)・
     PC/SP (`pc_sp`)
   - `principles_to_bring` (持ち込む原理。構図そのものではない) と `do_not_copy` (写さないこと)

   と、その店の事実から導いた `shop_specific_principles` (成功例の足し合わせではない) を書く。文はすべて
   1 行の平文 (HTML・URL・改行なし、長さの上限あり)。`text_only` は記録に残してよいが**参照の 3 件に数えない**
3. **検査する。**`npx tsx scripts/design-artifact/case-study-check.ts --check <case-study.json> --draft`。
   ファイルが無い・SHA-256 が違う・数える原本が 3 件未満なら止まる (`CASE_STUDY_FILE_MISSING`、
   `CASE_STUDY_SHA_MISMATCH`、`CASE_STUDY_TOO_FEW_ORIGINALS` など)。足りなければ足りないと報告して止まる。
   別の例で数を埋めない
4. **確認ページを作り、オーナーに見せる。**
   `npx tsx scripts/design-artifact/case-study-check.ts --page <case-study.json> --out <非公開の空の出力先>`。
   原本の画像を隣に写した静的な HTML (スクリプト・通信・外部の書体なし) ができる。リポジトリの中には書かない。
   オーナーが選定と原理を確認し、違えば選び直す
5. **オーナーの確認を記録する。**オーナーが確認したら `owner_confirmation`
   (`confirmed: true`、`confirmed_at`、`selected_ids` = 数えた例の id と完全に一致、`note` は任意) を記録し、
   `--check` (ゲートの検査。`--draft` なし) が通ることを確かめる
6. **依頼に結びつける。**実店舗のデザインの依頼 (IMAGE_FIRST の依頼モード、`kind: "real_shop"`) には
   `case_study: { "path": "case-study.json", "sha256": "<記録の SHA-256>" }` を入れる (path は事実パックと
   同じ店の置き場の中のファイル名)。`--validate-request` と worker が同じゲートの検査を行い、無い・未確認・
   3 件未満なら `CASE_STUDY_REQUIRED` や `CASE_STUDY_NOT_OWNER_CONFIRMED` などで拒否する。記録は Codex に渡さない

この記録の文面 (店の事実を含みうる) と確認ページは、リポジトリ・試験・Issue に入れない。
