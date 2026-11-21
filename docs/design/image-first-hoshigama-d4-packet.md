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

説明文・値段・商品写真・人物は作らない（事実に無い）。フッターは店名と架空店舗の注記（facts の `name` と `description`）だけ。

## 2. 枚数とセクションの並び

PC 1440: 2 枚（`name`・`spread-flour`・`spread-fire` ／ `shelf`・`info`）。SP 390: 4 枚。区画は 5 つ: `name` → `spread-flour` → `spread-fire` → `shelf` → `info`。
継ぎ目はどれも区画の境（`section_break`）。合計 6 枚・1 バッチ（d3 と同じ）。

## 3. プロンプトのピン（全文は `--print-pin` で表示する）

| 項目 | d4 |
|---|---|
| plan SHA-256 | 290f0f7f921146aea6bc5333785d21b11411a54f06e83b1663b879f9442fc830 |
| バッチ SHA-256 | 770eed5d1922f254c7a79bcfaeccecc6a9aa7648404116b2f152cbb0f6a8ce64 |
| バッチの文字数 | 14821 |
| 方向性 SHA-256（`direction.json` の正規形） | 02118ed83819146e21fc1ba6711ce93aa075146cc443b1c9b80384793fb59fa3 |
| 方向性ファイル SHA-256（`direction-d4.json`） | cc1eb7d38e0ed557e115fa28f2a9d4832508ac94dd8739235d55bd044e64b923 |
| facts SHA-256 | d46adc81bee7b7096e47f57091d88df348ac37cf389d7cce071a76f634fcf715 |
| 成功原理 SHA-256 | a7c9a3f467f46787520885edf67df692a23e4c37ac05934fcfabb67ea9c4bf6d |

| 画像 | プロンプト SHA-256 / 文字数 |
|---|---|
| pc-1 | `9487584dc424ab61fba434ed9db76ee24187534ad37c79614ee9ca728a8e98f5` / 2287 |
| pc-2 | `627041f4f827ea2f311d6fe10f76576755ed32ec701d90636bc2ae0a04542ca6` / 2491 |
| sp-1 | `09a255983f60685f152af3ad861f992889f36b5e1bcb5f3193ab578377608ec0` / 2049 |
| sp-2 | `40a5fbbef4cc5f7f1963f49577a38ff767980d29d1e2dea1dc81e0a959edf0b0` / 2152 |
| sp-3 | `03059db57c80ea95e253862e49426a11c21a897f2b235a1abc41872fd01e4722` / 2335 |
| sp-4 | `b2f8f84a1e6fb7c31daf2cfa0af242b5d52148f495c211dee5275d6af7574160` / 2420 |

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
