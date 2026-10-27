# Second Root | 成功デザイン研究事例

**2026-10-27 JST / v1 catalog** — Mond / Sissi / なごやビーンズv4 の3例を登録しました。

> **画像をテンプレートとして使い回さない。** 学習対象は、各店舗の特徴を視覚構造へ変換する考え方、画像・文字・余白・重なりの分析と実装・レビュー手順です。

| ID | 研究事例 | 承認の範囲 | 画像 |
| --- | --- | --- | --- |
| [CP-001](CP-001-Mond.md) | Mond / The Living Archive | チャットで高評価だった成功参考案。実装承認ではない | [WebP](assets/CP-001_Mond.webp) |
| [CP-002](CP-002-Sissi.md) | Sissi / Flower is Art | A案が好評価だった成功参考案。実装承認ではない | [WebP](assets/CP-002_Sissi.webp) |
| [CP-003](CP-003-NagoyaBeans-v4.md) | なごやビーンズ / Editorial Roast Atlas v4 | **2026-10-27にデザインv4を承認**。公開・店舗承認ではない | [PC](assets/CP-003_NagoyaBeans_v4_desktop.webp) / [スマホ](assets/CP-003_NagoyaBeans_v4_mobile.webp) |

## 境界と検証
- このフォルダは**研究事例（採用済みの構図研究）**。既存の `design-library/research/v02`（40件）や `v03`（40候補）は変更せず、80件の参考候補件数にも足さない。
- ここに置くのは**GitHubで閲覧するための圧縮WebP画像**。元のPNG、v4ソースZIPのSHA-256とファイル名は `manifest.json` に記載し、元データと縮小プレビューを混同しない。
- Mond/Sissiはコンセプト画像。なごやビーンズv4はHTML/CSS/JSのPoCを以前制作したが、**Next.js移植、実公開、実店舗による許諾は未実施**。
- 実店舗の商標、写真、営業時間、価格などの事実が正しいか、公開前に確認すること。
- 他店へ写真・ロゴ・文章・具体的な構図を転用しない。使用する技法は、その店の特徴に合わせて再設計する。
- 本PRは研究ライブラリへの追加のみ。**main、Vercel、本番DB、営業AI、CSS許可表には変更なし**。

個別の再現実験は `CP-003` を基準に続け、制作プロセスの標準化は実装評価を経て別途判断する。
