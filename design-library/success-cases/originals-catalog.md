# 承認された成功例の全件一覧と原本の所在（2026-11-25）

正式な制作フロー（[`docs/design/image-first-production-flow.md`](../../docs/design/image-first-production-flow.md) 段 1）で、どの成功例の**原本を実際に見られるか**を分けた一覧。
この一覧は所在の記録だけで、件数の台帳（`manifest.json` の 30 件、`second-root-research-successes.json`）は変えない。
**オーナーの採用記録（Issue #193・ChatGPT ライブラリ）では、重複を除いて 37 件**（2026-11-10 の CP-037 採用時点）。GitHub の台帳に入っているのはそのうち 31 件で、差は §「台帳との照合」にまとめた。
**一覧を作っただけでは「成功例をすべて見られる」状態ではない。** 閲覧ページの整備と原本の復元は Issue #336 で続ける。
受け渡すファイルの名前と記録の SHA-256 は [`originals-handover.json`](originals-handover.json)、オーナーの受け渡しの手順と、照合の道具・全件の非公開の閲覧ページは [`docs/design/success-originals-handover.md`](../../docs/design/success-originals-handover.md)（2026-11-26 の棚卸しでは、この機械に新しい原本は見つからなかった）。

区分:
- **A 原本あり**: Claude が原本（または登録済みの閲覧用プレビュー・頁）を開け、記録の SHA-256 と照合できる。置き場はこのリポジトリ、またはリポジトリ外の非公開の置き場（リポジトリは公開のため、復元した原本は非公開の置き場に置く）。段 1 の「原本で確認した成功例」に数えられるのはこの区分だけ。ただし SR-001 は除く（下記）。
- **B 文章のみ・未取り込み（所在は記録済み）**: 研究記録または採用記録と、原本のファイル名・保管先・SHA-256 の記録がある。原本のバイトはリポジトリにも Claude の読める非公開の置き場にも無く（ChatGPT の会話またはライブラリ）、Claude は見られない。取り込んで SHA-256 と目視を確かめるまでは原本確認済みと扱わず、参照に使わない。
- **C 所在不明**: 原本の候補のファイル名しか無く、SHA-256 も保管の照合も無い。

## A 原本あり（4 件。他店の参照に数えられるのは 3 件）

機械が読む索引は [`originals-index.json`](originals-index.json)（id・種類・リポジトリのパス・SHA-256・`counts_as_reference`。SR-001 は `false`）。店ごとの分析の記録（`case-study.json`、リポジトリの外）の検査 `scripts/design-artifact/case-study-check.ts` は、この索引で「参照に数える原本」を決める。B の id は索引の `private_original_ids` にあり、原本を非公開の置き場に取り込み、見たファイル（または原本の ZIP と中の見た画像）の SHA-256 がその例の記録の値（`manifest.json` の欄、または索引の `expected_sha256` の採用記録の値）と一致した場合だけ、記録の中で `private_verified` として数えられる。C の id（`unavailable_ids`）は数えない（手順は `.claude/skills/second-root-design-director/references/evidence-and-cases.md`）。

| ID | 事例 | 開く | 注 |
|---|---|---|---|
| CP-001 | Mond — The Living Archive | [画像](assets/CP-001_Mond.webp)・[記録](CP-001-Mond.md) | 閲覧用 WebP（元 PNG の SHA-256 は記録のみ）。コンセプト画像 |
| CP-002 | Sissi — Flower is Art | [画像](assets/CP-002_Sissi.webp)・[記録](CP-002-Sissi.md) | 閲覧用 WebP。コンセプト画像 |
| CP-003 | なごやビーンズ — Editorial Roast Atlas v4 | [PC](assets/CP-003_NagoyaBeans_v4_desktop.webp)・[SP](assets/CP-003_NagoyaBeans_v4_mobile.webp)・[記録](CP-003-NagoyaBeans-v4.md) | PoC の画面写し。画像で PC と SP がそろう唯一の例 |
| SR-001 | 輪（架空の自転車修理店）d1-v9 | [頁](../research/quality-pipeline/poc/bicycle/fidelity/d1-v9/index.html)・[README](../research/quality-pipeline/poc/bicycle/fidelity/d1-v9/README.md) | 頁（HTML/CSS）を描画して確認する。リポジトリの頁の写真は仮の板で、採用された完成版（AI 写真 6 枚入り、2026-11-07 採用）の写真は WSL の非公開の保存物にある（この機械に存在を確認。記録の SHA-256 との照合と閲覧ページへの組み込みは Issue #336）。**閲覧はできるが、他店の参照には数えない**（架空の店の Second Root 自身の頁。`second-root-research-successes.json` の方針「他店の参照ではない」） |

## B 文章のみ・未取り込み、所在は記録済み（26 件）

| ID | 事例 | 記録 | 原本の保管先（記録の通り） |
|---|---|---|---|
| CP-004 | harebare | [記録](CP-004-Harebare.md) | ChatGPT の会話（PNG・PoC の ZIP、SHA-256 あり） |
| CP-005 | Hamsa | [記録](CP-005-Hamsa.md) | ChatGPT の会話 |
| CP-006 | Melon de Mille | [記録](CP-006-Melon-de-Mille.md) | ChatGPT の会話 |
| CP-007 | ORGN. | [記録](CP-007-ORGN-SEAM-CUT.md) | ChatGPT の会話 |
| CP-008 | 整体院 Go. | [記録](CP-008-Seitai-Go-PAUSE.md) | ChatGPT の会話 |
| CP-009 | 豆＊豆 | [記録](CP-009-MameMame-STITCH.md) | ChatGPT の会話 |
| CP-010 | ぺいぱばっくらいたー | [記録](CP-010-PaperTheater-PT02.md) | ChatGPT の会話 |
| CP-011 | BAR N | [記録](CP-011-BAR-N-GLASS-SILENCE.md) | ChatGPT の会話 |
| CP-012 | Admy | [記録](CP-012-Admy-ONE-OF-A-KIND.md) | ChatGPT の会話 |
| CP-013 | スペースたのしい | [記録](CP-013-SpaceTanoshii-TOY-PACKAGING.md) | ChatGPT の会話 |
| CP-015 | imairo. | [記録](CP-015-imairo-TABLE-JOURNAL-v2.md) | ChatGPT の会話 |
| CP-016 | ズールー工作所 | [記録](CP-016-Zulu-COUNTERWEIGHT-ZK01.md) | ChatGPT の会話 |
| CP-017 | Rurikoyarn | [記録](CP-017-Rurikoyarn-UNWIND-v1.1.md) | ChatGPT の会話 |
| CP-018 | MOLE FACTORY | [記録](CP-018-MOLE-FACTORY-OVERPRINT-v1.md) | ChatGPT の会話 |
| CP-019 | 浦田杏梨 | [記録](CP-019-Anna-Urata-WAX-TIME-v1.md) | ChatGPT の会話 |
| CP-020 | 喫茶 ITALICO | [記録](CP-020-Kissa-ITALICO-SHOWCASE-v1.md) | ChatGPT の会話 |
| CP-021 | TERACE | [記録](CP-021-TERACE-PICK-COMPOSE-v1.md) | ChatGPT の会話 |
| CP-022 | Harissy | [記録](CP-022-Harissy-CRUMB-FRACTURE-v1.md) | ChatGPT の会話 |
| CP-023 | BURGERS,INC | [記録](CP-023-BURGERS-INC-NEON-FLIP-v4.md) | ChatGPT の会話 |
| CP-024 | Boheme. 全ページ v2 | [記録](CP-024-Boheme-FLORAL-FITTING-FullPage-v2.md) | ChatGPT の会話（リポジトリの疑似復元 v3 は採用原本ではない） |
| SR-002 | 金時湯（PR #237、未マージ） | [PR #237](https://github.com/ioda47871-byte/second-root/pull/237) | ChatGPT ライブラリ `/セカンドルート/` の ZIP。照合する値は承認 PNG の SHA-256（PR #237。`金時湯_地下水の物語.png`、`originals-index.json` の `expected_sha256`） |
| CP-033（= SR-003） | MARTELLI B v4（PR #240、未マージ） | [PR #240](https://github.com/ioda47871-byte/second-root/pull/240) | ChatGPT ライブラリ `/セカンドルート/` の ZIP（SHA-256 は PR #240 に記録） |
| CP-034（= SR-004） | 中善提灯店 v12-B FULL「折り型」（2026-11-09 採用） | Issue #193 の採用記録 | ChatGPT ライブラリ `/セカンドルート/SecondRoot_CP034_v12B_FullWeb_20261109.zip`、SHA-256 `6f4fea138de381b2bca2d0d687f6ac821f897a0ee5e0079ffa97ba61632e51a1`。採用記録 `SecondRoot_CP034_v12B_Approved_Research_Record_20261109.md`。GitHub に研究記録なし |
| CP-035（= SR-005） | 昭雲堂印店 A-v2 OneSheet（2026-11-10 採用） | Issue #193 の採用記録 | ChatGPT ライブラリ `/セカンドルート/SecondRoot_CP035_A_OneSheet_v2_20261110.zip`、SHA-256 `81ad1b3f1351bc843ac97ca6aed761353e00f5ddc25715dc2a46da90051a5382`。採用記録 `SecondRoot_CP035_A_v2_Owner_Approved_20261110.md`。GitHub に研究記録なし |
| CP-036（= SR-006） | 丸五庖丁店 D Photo Polish（2026-11-10 採用） | Issue #193 の採用記録 | ChatGPT ライブラリ `/セカンドルート/SecondRoot_CP036_Marugo_D_PhotoPolish_20261110.zip`、SHA-256 `1527f51c1dc3109682e65c4192a46c7c07e02cbe47bea91af321cbeecdd74f61`。採用記録 `CP036_Marugo_D_PhotoPolish_Owner_Approved_20261110.md`。GitHub に研究記録なし |
| CP-037（= SR-007） | 大観堂書店 C×A Message Clarity v2（2026-11-10 採用） | Issue #193 の採用記録 | ChatGPT ライブラリ `/セカンドルート/SecondRoot_CP037_CA_MessageClarity_v2_20261110.zip`、SHA-256 `4c4202266eb6b3814b012ea3c237feffc38428327f7fc27d64087b69105260eb`。採用記録 `SecondRoot_CP037_Owner_Adoption_20261110.md`。GitHub に研究記録なし |

## C 所在不明（7 件）

| ID | 事例 | 記録 | 状態 |
|---|---|---|---|
| CP-026 | Sawaddee Chao | [記録](CP-026-Sawaddee-Chao-Shop-Note-v5.md) | 原本の ZIP 名の候補だけ。SHA-256 も実体も未照合 |
| CP-027 | MATO OBJECTS STORE | [記録](CP-027-MATO-Between-Floors-v2.md) | 同上 |
| CP-028 | ユメツナベース | [記録](CP-028-Yumetuna-One-Sheet-v1.md) | 同上 |
| CP-029 | SNOWMY | [記録](CP-029-SNOWMY-Soft-Pop-v4.md) | 同上 |
| CP-030 | 高田時計店 | [記録](CP-030-Takada-Service-Counter-v2.md) | 同上 |
| CP-031 | リフォーム 中村 | [記録](CP-031-Reform-Nakamura-Hybrid-v3.md) | 同上 |
| CP-032 | 幸せを呼ぶ玉虫屋 | [記録](CP-032-Tamamushiya-Iridescent-Light-v1.md) | 同上 |

## 台帳との照合（2026-11-25）

| 記録 | 件数 | 入っているもの |
|---|---|---|
| GitHub `manifest.json` | 30 | CP-001〜013・015〜024・026〜032 |
| GitHub `second-root-research-successes.json` | 1（正式） | SR-001（SR-C01 は候補で数えない） |
| オーナーの採用記録（Issue #193、ChatGPT ライブラリ） | 37（重複除外） | 上の 31 件 ＋ SR-002・CP-033（SR-003）・CP-034（SR-004）・CP-035（SR-005）・CP-036（SR-006）・CP-037（SR-007） |

- CP-034 の採用記録の時点（2026-11-09）では 34 件。その後 CP-035・CP-036・CP-037 が採用され 37 件になった（Issue #193 の 2026-11-10 の記録）。
- 6 件の差（SR-002、CP-033〜037）は GitHub の台帳に未登録（SR-002 は PR #237、CP-033 は PR #240 が未マージ、CP-034〜037 は PR なし）。台帳への登録は、この一覧では行わない（`manifest.json` は変えない）。
- 2026-11-10 より後の採用は、Issue の検索では見つからなかった（ChatGPT ライブラリは Claude が読めないため、オーナーに確かめる）。
- CP-034〜037 の原本の実体は Claude が確かめていないので、原本確認済みとは扱わず B（未取り込み）に入れた。SHA-256 は Issue #193 の採用記録の値。

## 一覧に入れないもの

- SR-C01（つぐ手）: 成功例の**候補**で、正式な成功例ではない（頁は `../research/quality-pipeline/poc/tsugute/fidelity/d1-v10/`）。
- CP-014: 採用保留。CP-025: 登録に含めない（README の記録の通り）。

## 原本を増やす順番（Issue #336）

1. B のうち、ChatGPT ライブラリに ZIP と記録した SHA-256（SR-002 は承認 PNG の SHA-256（PR #237））がそろう SR-002・CP-033〜037 を、オーナーが受け渡し、SHA-256 と目視を確かめて非公開の置き場に置く（CP-034〜037 は PC/SP 全ページの Web サイトで、全ページの参照に向く）。
2. B の CP-004〜024 は、PC と SP がそろう HTML の PoC（CP-024・CP-009・CP-015 など）を先に。
3. C は原本の所在をオーナーに確かめてから。見つからなければ C のまま残し、参照に使わない。
