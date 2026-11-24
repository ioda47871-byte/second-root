# 承認された成功例の全件一覧と原本の所在（2026-11-25）

正式な制作フロー（[`docs/design/image-first-production-flow.md`](../../docs/design/image-first-production-flow.md) 段 1）で、どの成功例の**原本を実際に見られるか**を分けた一覧。
この一覧は所在の記録だけで、件数の台帳（`manifest.json` の 30 件、`second-root-research-successes.json`）は変えない。原本の復元は Issue #336 で続ける。

区分:
- **A 原本あり**: 画像または頁がこのリポジトリにあり、下のリンクから開ける。段 1 の「原本で確認した成功例」に数えられるのはこの区分だけ。
- **B 文章のみ（所在は記録済み）**: 研究記録と、原本のファイル名・保管先・SHA-256 の記録がある。原本のバイトはリポジトリに無く（ChatGPT の会話またはライブラリ）、Claude は見られない。取り込んで SHA-256 と目視を確かめるまでは参照に使わない。
- **C 所在不明**: 原本の候補のファイル名しか無く、SHA-256 も保管の照合も無い。

## A 原本あり（4 件）

| ID | 事例 | 開く | 注 |
|---|---|---|---|
| CP-001 | Mond — The Living Archive | [画像](assets/CP-001_Mond.webp)・[記録](CP-001-Mond.md) | 閲覧用 WebP（元 PNG の SHA-256 は記録のみ）。コンセプト画像 |
| CP-002 | Sissi — Flower is Art | [画像](assets/CP-002_Sissi.webp)・[記録](CP-002-Sissi.md) | 閲覧用 WebP。コンセプト画像 |
| CP-003 | なごやビーンズ — Editorial Roast Atlas v4 | [PC](assets/CP-003_NagoyaBeans_v4_desktop.webp)・[SP](assets/CP-003_NagoyaBeans_v4_mobile.webp)・[記録](CP-003-NagoyaBeans-v4.md) | PoC の画面写し。PC と SP がそろう唯一の例 |
| SR-001 | 輪（架空の自転車修理店）d1-v9 | [頁](../research/quality-pipeline/poc/bicycle/fidelity/d1-v9/index.html)・[README](../research/quality-pipeline/poc/bicycle/fidelity/d1-v9/README.md) | 頁（HTML/CSS）を描画して確認する。写真は仮の板 |

## B 文章のみ・所在は記録済み（22 件）

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
| SR-002 | 金時湯（PR #237、未マージ） | PR #237 | ChatGPT ライブラリ `/セカンドルート/` の ZIP（SHA-256 は PR #237 に記録） |
| CP-033 | MARTELLI B v4（PR #240、未マージ） | PR #240 | ChatGPT ライブラリ `/セカンドルート/` の ZIP（SHA-256 は PR #240 に記録） |

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

## 一覧に入れないもの

- SR-C01（つぐ手）: 成功例の**候補**で、正式な成功例ではない（頁は `../research/quality-pipeline/poc/tsugute/fidelity/d1-v10/`）。
- CP-014: 採用保留。CP-025: 登録に含めない（README の記録の通り）。

## 原本を増やす順番（Issue #336）

1. B のうち、ChatGPT ライブラリに ZIP と SHA-256 がそろう SR-002・CP-033 を、オーナーが受け渡し、SHA-256 と目視を確かめて非公開の置き場に置く。
2. B の CP-004〜024 は、PC と SP がそろう HTML の PoC（CP-024・CP-009・CP-015 など）を先に。
3. C は原本の所在をオーナーに確かめてから。見つからなければ C のまま残し、参照に使わない。
