# IMAGE_FIRST 承認パケット（d4）— 架空パン店 ほし窯 の全頁デザイン画像・d3 の改善版

2026-11-22 作成（Issue #302 P5、d3 へのオーナー判断 revise 2026-11-21 から）。**状態: 未承認。**

承認の状態を表すのは、すぐ上の「状態」の行と §10 の表だけである。両方が「承認済み」になるまで、この文書は Codex の実呼び出し・画像生成・
課金・WSL 操作のどれも認めない。**この版は下書きで、オーナーの承認とマージの前に何も実行しない（OWNER MERGE ONLY）。**

- 改善元: `hoshigama-imagefirst-d3-20261121-01`（研究ログ `design-library/research-log/entries/…`、判断 `decisions/…--1.json`、brief `briefs/hoshigama-d4.md`）。
- 方向性: `design-library/research/quality-pipeline/poc/bakery/direction-d4.json` の `d4-flour-crust-shelf`。d3 の承認済みピン（plan の SHA は
  `direction-set.json` のバイトを含む）を動かさないため、別のファイルに置いた。d1・d3 のプロンプトは 1 バイトも変わらない（テストで固定）。
- コード: `lib/design-agent/image-first/prompt.ts`（`DIRECTIONS.d4`・`SECTION_TEXT_KEYS.d4`・`SECTION_LABEL_KEYS`・`FOOTER_TEXT_KEYS`）、
  ピン表示 `scripts/design-artifact/image-first-prompt.ts --direction d4 --print-pin`。

## 1. d3 から何を変えるか

| 守る（d3 の長所） | 改善する（オーナー判断の改善点） |
|---|---|
| 二色にまたがる巨大な店名の Hero | 品を「棚」の章にし、石窯の 2 品を statement_3 と組にして最上段に（店の事実 F9・F12 が根拠） |
| 粉とパン皮の質感 | 店舗情報を 1 区画にまとめ、事実スキーマのラベル（営業時間・定休日・所在地・道順・電話）を小見出しに使えるようにする |
| 生成りと焼き色の二系統（焼き色の色相をそろえる） | 見開きごとに粉と焼き色の左右・上下・高さを入れ替え、同じ帯を続けない |
| SP の縦組み | 文字の下は平らな面、質感は文字の無い面で。SP のナビは 3 語・大きめ |

説明文・値段・商品写真・人物は作らない（事実に無い）。フッターは店名と店の説明の文（facts の `name` と `description`、架空店舗の注記を含む）をそのまま小さく置くだけ。
brief にあった「先頭へ戻る導線」は文字にしない（事実に無い語を作らない）。SP のナビは「営業時間」「所在地」「電話」の 3 語だけを許す（`NAV_KEYS_BY_VIEWPORT`、PC は 5 語のまま）。

## 2. 枚数とセクションの並び

PC 1440: 2 枚（`name`・`spread-flour`・`spread-fire` ／ `shelf`・`info`）。SP 390: 4 枚。区画は 5 つ: `name` → `spread-flour` → `spread-fire` → `shelf` → `info`。
継ぎ目はどれも区画の境（`section_break`）。合計 6 枚・1 バッチ（d3 と同じ）。
SP では分け方の都合で `shelf` は 3 枚目（`spread-fire` と同じ画像）、`info` が 4 枚目だけになる。SP の最後の画像は棚ではなく店舗情報で終わる（見るときの注意）。

## 3. プロンプトのピン（全文は `--print-pin` で表示する）

| 項目 | d4 |
|---|---|
| plan SHA-256 | 0c3849b2d2e22f65601c7c3515028a999eb1ef39256b2fe08681bd8f771338cd |
| バッチ SHA-256 | 993d938ab72df308fefef55f84d1fca0b197cb5f913273809dcd7ad464ae7e7e |
| バッチの文字数 | 14408 |
| 方向性 SHA-256（`direction.json` の正規形） | b3bee6b6b7f762917027480a88e700dec93fce136edc28fa7423a2541d5e1c1c |
| 方向性ファイル SHA-256（`direction-d4.json`） | 64c6deb72179889f201321d78aa883b85bbcc4438e4d2ce7f07d14ca460f1533 |
| facts SHA-256 | d46adc81bee7b7096e47f57091d88df348ac37cf389d7cce071a76f634fcf715 |
| 成功原理 SHA-256 | a7c9a3f467f46787520885edf67df692a23e4c37ac05934fcfabb67ea9c4bf6d |

| 画像 | プロンプト SHA-256 / 文字数 |
|---|---|
| pc-1 | `ca6a53e75a3f66d7c6be9a1fffcb6b870fcd3f423a9f102461de74abfa9b1c00` / 2218 |
| pc-2 | `bcaa76644a4f414a2a2dfde1f6085cb5c599c4d264483236f65d6d3ed2bfe235` / 2428 |
| sp-1 | `9350da6837135b0ffc105e4f1d64c1d6ef5f1733eae6f1f0ed8e9eb4a0da1297` / 1969 |
| sp-2 | `d8b96ee4fefca93166841b993b991b7cba1a34ce691e1a80c541c316f338f1d7` / 2083 |
| sp-3 | `cbc28fa7da57d595a1832a28a0a00f3b3eb53e322eb5c87de8803aa0fcb352d5` / 2266 |
| sp-4 | `cce2773590310f500f136ffa29044e80724638752ce8a73c91d4c22dd894de6b` / 2357 |

## 4. 実行の経路

d4 は d3 と同じ一回限りの経路（pilot・worker・自動起動・bundle・配送・監査）を通る。経路は方向性ごとの表で d3 と d4 を分ける
（`lib/design-agent/imagefirst-worker/run-directions.ts` の `IMAGEFIRST_RUNS`、`lib/design-agent/phase2f-live/approval-packets.ts`）:

- d4 を承認するのは**このパケットだけ**（d3 の P3 パケットは d4 を承認できず、このパケットは d1・d3 を承認できない）。
- 承認 ID は `hoshigama-imagefirst-d4-<YYYYMMDD>-<NN>`、計画 ID は `hoshigama-imagefirst-p4-<YYYYMMDD>`。ID が方向性を名指すので、
  d3 の ID で d4 は動かず、d4 の ID で d3 は動かない。日付 `00000000` は使えない。
- worker は root の一回限りのマーカー（`SR_IMAGEFIRST_EXPECT_APPROVAL_ID`）が d4 の ID を名指したときだけ d4 の行を使う。
  マーカーが無い手動の実行は従来どおり d3 だけ。
- worker を通さない手動の入口 `scripts/design-artifact/image-first-generate.ts --direction d4` も、d3 と同じく使える。こちらも
  承認済みのこのパケット・一致する承認 ID と計画 ID・ピン・`--expected-commit`・台帳がそろわなければ何も使わずに止まる。
- §3 の 3 行（plan SHA-256・バッチ SHA-256・バッチの文字数）がコードの表の値と一致しなければ止まる。

この経路の変更は root が動かすスクリプトを含むので **OWNER MERGE ONLY**。その変更がマージされるまで、このパケットを承認しても実行はできない。

実行の条件は d3 と同じにする: Codex の画像ツールで 1 回・6 枚・15 分・再試行なし。止まったら新しいパケットと新しい承認 ID。
届いた画像は既存の受け渡し（review inbox・プレビュー・Claude CLI 監査）を通り、研究ログの `intake … --direction d4 --iteration 1 --parent hoshigama-imagefirst-d3-20261121-01` で記録する。

## 5. 除外（画像を作る側に見せない）

d3 と同じ: 入力は facts パック・方向性オブジェクト 1 つ・成功原理の記録の 3 つだけ。d4 の入力ファイルは `direction-d4.json`（店名を含まないパス）。
`LINEAGE_TOKENS` と `LINEAGE_PATTERNS` の語はプロンプトに入らない（入れば計画ごと拒否）。研究ログ・監査の所見・d3 の画像はプロンプトに入れない。

## 6. 画像 6 枚の内訳（区画と枠の割合）

| 表示 | 画像 | 区画（上から。枠の高さに対する割合） |
|---|---|---|
| PC 1440 | pc-1 | name 0–41% / spread-flour 41–71% / spread-fire 71–100% |
| PC 1440 | pc-2 | shelf 0–50% / info 50–100%（最下部に小さなフッター） |
| SP 390 | sp-1 | name 0–100%（1 画面目は店名だけ。ヘッダーのナビは 3 語） |
| SP 390 | sp-2 | spread-flour 0–100% |
| SP 390 | sp-3 | spread-fire 0–50% / shelf 50–100% |
| SP 390 | sp-4 | info 0–100%（最下部に小さなフッター） |

各画像は縦長 2:3 の枠 1 枚。プロンプトの全文は `node --import tsx scripts/design-artifact/image-first-prompt.ts --direction d4 --print-pin` で表示できる
（読むだけ。何も書かず、何も呼ばない）。各画像のプロンプトが必ず言うこと（d3 と同じ）: Web サイトの平面のデザインカンプで写真・ポスター・端末の見本ではない／
PC か SP か（SP は PC の縮小でない別の設計）／全頁の何枚目か・区画と割合・上下の隣の区画／方向性の考え・組み方・守る核／成功原理 5 つ／
**書いてよい文字は facts の値そのものだけ**（区画ごとの facts、ナビは PC 5 語・SP 3 語、info の小見出しは事実スキーマのラベル、フッターは店名と説明の文）／
価格・受賞・歴史・人物・評判・お客様の声・メニュー・予約・限定を作らない。

## 7. モデル・CLI・利用枠（分かっていること／分かっていないこと）

- 呼び出し: WSL 上の Codex CLI の `codex exec` を **1 回**（jail 内、読み取り専用、ChatGPT サインインだけ、`.env` なし、画像機能を明示的に有効）。
  その 1 回の中で画像ツール `image_gen.imagegen` を**最大 6 回**呼ぶ（`lib/design-agent/design-image/image-once.ts` の `generateImagesInOneRun`）。
- 画像モデル: P3 パケット §4 と同じ前提（CLI のソースを読んだ限りでは `gpt-image-2`、`size: auto`、`quality: auto`、`background: opaque`）。
  実行の記録に画像モデル名は出ないので、記録では「不明」（警告）になる。モデルが大きさを指定する手段はない。
- セッションのモデル（Codex の会話モデル）と CLI の版: 事前には分からない。preflight と実行の記録で確かめる。
- d3 の実績（2026-11-21、承認 ID `hoshigama-imagefirst-d3-20261121-01`）: 同じ経路・同じ 6 枚の構成で 1 回成功（6 枚そろって保存、`IMAGE_SAVED`）。
  d4 でも 6 枚そろうか・縦長 2:3 で返るかは**保証されない**（そろわなければ §9 のとおり止まる）。
- 利用枠と金額: **金額は不明**（記録がない）。ChatGPT のプランの利用枠と、別枠の `image_gen` の利用上限に対して、6 枚ぶんを消費する。
  金額の上限は数字で言えないので、回数（`codex exec` 1 回・画像 6 枚まで）と時間（15 分）で上限を決める。

## 8. 呼び出し回数と時間の上限

| 項目 | 値 |
|---|---|
| 実行回数 | この承認 ID で **`codex exec` 1 回だけ**（その中で画像ツール最大 6 回）。同じ ID は二度と使えない（claim と台帳の両方で 1 回限り） |
| 再試行 | **しない**。止まった・足りなかった・気に入らなかった、のどれでも同じ ID で作り直さない |
| 時間 | 1 回 15 分まで（`LIVE_LIMITS.callTimeoutMs`）。超えたら止める |
| 台帳 | `phase2f-live` の台帳（種類 `full_page_comp`、経路 `image_first`）。この ID の受領記録を 1 つだけ書く |
| 後続 | 届いた画像は非公開の review inbox・プレビュー・Claude CLI の監査（助言のみ）へ。GitHub には画像・プロンプト・manifest を出さない |

## 9. 失敗時の扱い（停止条件。再試行しない）

- 承認を使う前に止まる（何も使わない。同じ ID で直して再実行できる）: パケットが未承認・パケットの値と起動の値の不一致
  （`PACKET_NOT_APPROVED`・`PACKET_APPROVAL_MISMATCH`）、パケットのパスやピンの不一致（`PACKET_PATH_NOT_ALLOWED`・`PACKET_PIN_MISMATCH`・
  `PLAN_PIN_MISMATCH`・`PROMPT_PIN_MISMATCH`・`COMMIT_PIN_MISMATCH`）、承認 ID と方向性の不一致（`APPROVAL_ID_DIRECTION_MISMATCH`）、
  期限（`APPROVAL_EXPIRY_INVALID`・`APPROVAL_EXPIRED`・`APPROVAL_EXPIRY_TOO_FAR`）、出力先の不正（`RUN_DIR_IN_REPO`・`OUT_DIR_*`）、
  使用済みの ID（`APPROVAL_ALREADY_USED`）、preflight の停止（Codex 未サインイン・`.env` あり・サンドボックス不可・資源不足）。
- 承認を使った後に止まる（**この ID は使用済みになる**。続けるには新しいパケットと新しい承認 ID）: `CODEX_NO_IMAGE`・`CODEX_IMAGE_INVALID`・
  `CODEX_IMAGE_UNSUPPORTED_FORMAT`・`CODEX_QUOTA`（利用枠の上限）・`CODEX_IMAGE_TOOL_FAILED`・`CODEX_TIMEOUT`（15 分）・`CODEX_EXEC_FAILED`・
  `CODEX_NOT_SIGNED_IN`・`CODEX_IMAGE_CALLS_EXCEEDED`・`CODEX_IMAGE_COUNT_MISMATCH`（6 枚そろわない）・`CODEX_ABORTED`（中断）など。
  止まった実行は停止コードを記録し、返ってきた画像があれば `stopped/` に置く（部品にもレビューにも使わない）。中断・停止でも受領記録は必ず残る。
- 6 枚そろっても、オーナーの評価の前に Claude が成功・採用と判断することはない。監査は助言だけで、採否はオーナーが Claude アプリで決める
  （「改善して」「成功例として保存」「不採用」）。

## 9a. 提案値と起動の手順（**提案。承認ではない**）

オーナーが確認してから §10 と冒頭の状態の行に書き入れる（このままでは何も動かない）。

| 項目 | 提案値 | 根拠 |
|---|---|---|
| 提案する方向性 | `d4` | このパケットが承認できるのは d4 だけ |
| 提案する d4 の承認 ID | `hoshigama-imagefirst-d4-20261122-01` | 形式 `hoshigama-imagefirst-d4-<YYYYMMDD>-<NN>`。作成日・この日の 1 番目。未使用（使用済みは d3 の `…-d3-20261121-01` だけ） |
| 提案する計画 ID | `hoshigama-imagefirst-p4-20261122` | 形式 `hoshigama-imagefirst-p4-<YYYYMMDD>` |
| 提案する期限 | `2026-11-23T03:00:00Z`（日本時間 11 月 23 日 12:00） | 入口は起動の時点から 24 時間以内の期限だけを受け付けるので、起動できるのは `2026-11-22T03:00:00Z`〜`2026-11-23T03:00:00Z`（日本時間 11/22 12:00〜11/23 12:00）。過ぎたら期限を書き直して新しい版として承認し直す |

起動の手順（承認とマージの後だけ。root の端末で。値は §10）:

1. root の clone を承認コミット（develop）にそろえる。
2. `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot-preflight.sh <§10 の d4 の承認 ID>` — 最後の行が
   `IMAGEFIRST_PILOT_PREFLIGHT PASS … failed=0 exit=0` でなければ止める（何も使っていない）。
3. `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot.sh <§10 の d4 の承認 ID>` — 1 回だけ。成功なら
   `IMAGEFIRST_PILOT PILOT_DONE … exit=0`。手順の詳細と出力の見本は `docs/operations/imagefirst-pilot.md`（冒頭の d4 の注記）。
4. 届いた後は Claude が研究ログに `intake … --direction d4 --iteration 1 --parent hoshigama-imagefirst-d3-20261121-01` で記録し、
   非公開のレビュー画面を Claude アプリに出す。

## 10. 承認欄（オーナーが記入する。**未記入 = 未承認**）

| 項目 | 値 |
|---|---|
| 状態（承認するなら `承認済み` と書く） | 未記入 |
| 承認する方向性（`d4` のみ） | 未記入 |
| d4 の承認 ID（1 回限り。形式 `hoshigama-imagefirst-d4-<YYYYMMDD>-<NN>`） | 未記入 |
| 期限（UTC、`YYYY-MM-DDTHH:MM:SSZ`。起動の時点から 24 時間以内） | 未記入 |
| 計画 ID（形式 `hoshigama-imagefirst-p4-<YYYYMMDD>`） | 未記入 |
| 承認日・承認者 | 未記入 |

- 承認するときは、表の「状態」と一緒に冒頭の状態の行も `**状態: 承認済み。**` に書き換える。両方がそろわなければ未承認として扱う。
- 使用済みの承認 ID（`hoshigama-imagefirst-d3-20261121-01` を含む）は使わない。
