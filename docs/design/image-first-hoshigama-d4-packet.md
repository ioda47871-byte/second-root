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
