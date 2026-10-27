# CP-004 | harebare — Spinning Beigoma Editorial v1

**状態:** OWNER_POSITIVE_RESEARCH_SELECTION / 2026-10-27 JST（オーナーの「いいじゃん」「保存して」を記録）。**デザインの最終公開承認、実店舗の制作依頼、ブランド許諾ではない。**

**実装:** ChatGPT内の非公式コンセプトHTML/CSS/JavaScript PoC v1。ローカルブラウザでPC・スマホを検証したが、公開・Next.js移植・商用稼働は未実施。

## 独自性（構図の理由）

- 川口の鋳物職人が製作したベーゴマ型の焼菓子に着目し、**回転する軌道**を視線誘導の基本原理にする。
- 巨大な serif の `harebare` と商品写真を重ねる。文字は見出しの行ではなく、写真と対等な構図の骨格として扱う。
- 伝統的な鋳物の質感（暗い金属・陰影）と焼き菓子の軽やかさ（バター色・粉・かけら）を同一画面で対比させる。
- セクション間の境界をまたぐ写真、斜めの裁ち落とし、非対称なサイズ比で、定番の3列カード・整列したLP構成を回避する。
- PCとスマホで情報と画像の重なりを再配置し、固定幅の画像を単純縮小しない。

## 適用してはいけないこと

- **この構図を他店舗へコピーしない。** 学習対象は「店舗固有の要素→配置の原理へ変換する制作過程」。
- 実店舗の写真、ロゴ、商標、商品の説明を生成素材へ無許諾で置き換えた状態で公開しない。
- 現行の営業AIやデザインDBへ自動投入しない。実店舗への送信も行わない。
- ブラウザ確認済み ≠ 商用運用成功 ≠ Next.jsビルド成功。

## オリジナルの保管証跡

元PNGとPoCのZIPはChatGPT会話内のファイルとして保管。GitHubへは**研究メタデータのみ**を登録（元のバイナリ画像のアップロードは未実施）。

| アーティファクト | 寸法/形式 | SHA-256 |
| --- | --- | --- |
| `harebare_editorial_poc/screenshots/desktop_full.png` | 1440×3580 / PNG | `eb41b8a59a217259ef9010cf604616f63f765a6c22fbbca180cab0e8c7246849` |
| `harebare_editorial_poc/screenshots/mobile_full.png` | 390×3844 / PNG | `55701641e04f290086efb0d79eb246228b4de1424d529eabe09122ed510a9df5` |
| `harebare_editorial_poc_v1_source.zip` | ZIP / HTML+CSS+JS+assets+tests | `889d6fba877520eb1a78ee14da05e9d0a0d444f692eb38895b4273311e05a3b6` |
| `harebare_editorial_poc/preview_offline.html` | offline HTML | `31554613676db89dff5db6d9b6e1a1d8af6b7998525d7a5e863b69a1be3166ac` |

**評価の射程:** 主人公の「回転するベーゴマクッキー」を構図に転写し、非定型コラージュをWeb実装できたことが研究成果。今後の実装ルール一般化は複数業種の検証後とする。
