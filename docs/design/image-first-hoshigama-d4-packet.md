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
| plan SHA-256 | 383c0a25c774b4d88bfa34bd3d34bea7a74c4a63d4bc52dd78ca96fe114b3c58 |
| バッチ SHA-256 | 9babc0b16069fd472b1df44ed54fee282ee687688ff74b5d3b25d329a57fc753 |
| バッチの文字数 | 14438 |
| 方向性 SHA-256（`direction.json` の正規形） | ae61cfcc4e605bc096a74134ca14a8374dea85802be05e08fc8f78acb1f84008 |
| 方向性ファイル SHA-256（`direction-d4.json`） | 7490396ac73fbf73f75a1e9712d40cc81183669933d209395e143f88bdab84ea |
| facts SHA-256 | d46adc81bee7b7096e47f57091d88df348ac37cf389d7cce071a76f634fcf715 |
| 成功原理 SHA-256 | a7c9a3f467f46787520885edf67df692a23e4c37ac05934fcfabb67ea9c4bf6d |

| 画像 | プロンプト SHA-256 / 文字数 |
|---|---|
| pc-1 | `13947eed72a153032f73da74353f0bde9a31a3faf2dd3ff680b24c886c4c3395` / 2223 |
| pc-2 | `d0fb215a2c71a7dc22872cd3b0eef4c1d4c87a7418e30e518ad18853ca6a98d4` / 2433 |
| sp-1 | `bf2647857f05fb661cae3a71e0bd3695fd252e0a91fc1f3c5a4447fbf83f1925` / 1974 |
| sp-2 | `097e3933f37a8b1e58d5a3c47e0c81d73b08f14ae75200c2efb1720c917cf218` / 2088 |
| sp-3 | `73b4c5f7e2b9223f60ea074bb4e470a2b7938bf8fde1958ef2780f3fb12b1617` / 2271 |
| sp-4 | `92ccad9ae0c475e78d0a631f29dd497f628b049945c4f156424f6e51676c09db` / 2362 |

## 4. 実行の経路（この版の時点では **d4 を受け付ける入口はまだ無い**）

d3 の pilot・worker・自動起動・bundle・配送・監査は、方向性 `d3` と承認 ID の形式 `hoshigama-imagefirst-d3-…` を固定している
（`cycle.ts` の `IMAGEFIRST_ALLOWLIST`、`bundle.ts` の `APPROVAL_ID_RE`、`full-page-call.ts` の承認パケットの読み方、pilot・autostart の
シェルの正規表現）。d4 を 1 回実行するには、それらを方向性ごとの表にする**別の PR（root が動かすスクリプトを含むので OWNER MERGE ONLY）**が要る。
その PR がマージされるまで、このパケットを承認しても実行はできない（入口が d4 を拒否する）。

実行の条件は d3 と同じにする: Codex の画像ツールで 1 回・6 枚・15 分・再試行なし。止まったら新しいパケットと新しい承認 ID。
届いた画像は既存の受け渡し（review inbox・プレビュー・Claude CLI 監査）を通り、研究ログの `intake … --direction d4 --iteration 1 --parent hoshigama-imagefirst-d3-20261121-01` で記録する。

## 5. 除外（画像を作る側に見せない）

d3 と同じ: 入力は facts パック・方向性オブジェクト 1 つ・成功原理の記録の 3 つだけ。d4 の入力ファイルは `direction-d4.json`（店名を含まないパス）。
`LINEAGE_TOKENS` と `LINEAGE_PATTERNS` の語はプロンプトに入らない（入れば計画ごと拒否）。研究ログ・監査の所見・d3 の画像はプロンプトに入れない。

## 10. 承認欄（オーナーが記入する。**未記入 = 未承認**）

| 項目 | 値 |
|---|---|
| 状態（承認するなら `承認済み` と書く） | 未記入 |
| 承認する方向性 | 未記入 |
| d4 の承認 ID（1 回限り。形式 `hoshigama-imagefirst-d4-<YYYYMMDD>-<NN>`） | 未記入 |
| 期限（UTC、`YYYY-MM-DDTHH:MM:SSZ`。起動の時点から 24 時間以内） | 未記入 |
| 計画 ID | 未記入 |
| 承認日・承認者 | 未記入 |

- 承認するときは、表の「状態」と一緒に冒頭の状態の行も `**状態: 承認済み。**` に書き換える。両方がそろわなければ未承認として扱う。
- 使用済みの承認 ID（`hoshigama-imagefirst-d3-20261121-01` を含む）は使わない。
