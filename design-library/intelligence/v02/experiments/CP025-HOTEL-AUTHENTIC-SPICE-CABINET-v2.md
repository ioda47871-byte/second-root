# CP-025｜HOTEL AUTHENTIC — THE SPICE CABINET / Full-page v2

**制作日:** 2026-10-28 JST  
**状態:** `RESEARCH_FULLPAGE_V2_AWAITING_OWNER_REVIEW`。**未採用**。直前の「THE EDIBLE ATLAS」v1にユーザーが**「凡庸だな」**と評価したため、その初稿を不採用として構造から再設計。ユーザーに改良v2の評価をまだ求めていないため、研究成功件数は**23件のまま**（Web試作成功10、静止画成功13）。

## 失敗したv1との差

- 旧案は左大見出し＋右料理写真Hero、4地域のタブ＋概念地図、暗緑の写真説明帯、紙色の案内カード、アクセス情報という「よくあるセクション積層」の骨格だった。写真を複数回使い、地域を替えても体験の本質は変わらなかった。
- **新案はキャビネットの4つの引き出しがサイトの中心的な情報構造**。4地域を選択する操作が、物理的に引き出しを開ける動作になる。4地域は正確な文化地理・現行メニューを断定せず、編集用のイメージとして扱う。
- 1枚のAI料理写真は**NORTH引き出しの内部に一度だけ**配置。SOUTH/EAST/WESTの3引き出しは**異なるインラインSVGの抽象資料図**と独立したテキストを表示し、写真の重複を防止。
- 下層は**FIELD NOTES：Aroma／Texture／Balanceという収蔵記録**、最下層は**来店案内を入れた封筒**に。ヒーロー写真と交互の帯、汎用的な3商品カードを足すことによる構図の平均化を回避。
- 横はみ出しなしであることと、**本当にデザインが独創的かどうかは別問題**。v2は正式な美的評価待ち。

## ローカル実装と検証

- HTML/CSS/JS：独立DOMテキスト、4つの本物のbuttonと`aria-expanded`、開閉状態、現在の引き出し番号。主要ページ内リンク、公式Instagram、Googleマップへの通常の外部リンク。
- レスポンシブ：**320,375,390,430,768,1024,1280,1440,1920px**の9幅をChromium+Playwright `page.set_content` で確認。意図しない横はみ出し **0**、画像読み込み成功、ページJS例外 **0**、PC1440とスマホ390で4地域すべてを開く動作 **8/8成功**。
- PC1440全ページ、スマホ390全ページ、両者の俯瞰比較、WEST引き出し選択時の各画面、旧v1との並列比較を作成。
- **未検証:** 実機ブラウザ、Safari/Firefox、アクセシビリティの総合監査、Next.js移植、本番デプロイ、商用権利、正式店舗承認。表示テキストの可読性は概念用の品質で商用校正前。
- 外部フォント依存を設けず、画像を埋め込んだ`preview_offline.html`を提供。

## 店舗・素材の事実確認境界

- 題材は名古屋市昭和区のインド料理店 **HOTEL AUTHENTIC**。出店者本人紹介ではインドの南北東西の料理を扱うとされる（[2026出店者案内](https://socialtower.jp/2026/08/)／[第三者店舗掲載](https://tabelog.com/aichi/A2301/A230108/23085894/)）。
- 画像は**AI生成の研究素材**で、本物の料理やメニューの写真ではない。引き出し、抽象資料図、コピーはすべてSecond Root研究用の創作物。現行提供料理、価格、営業時間、予約状況を創作しない。
- 公式サイト・公式ECは検索で未発見。ただし**Instagramプロフィールの外部リンク未確認**のため、`WEB_NOT_FOUND_AFTER_SEARCHES__LINK_IN_BIO_UNVERIFIED`。サイトが無いことは確定しておらず**営業対象資格HOLD**。研究の採用と実店舗の依頼・公開は別。
- v1の不採用分析は[CP-025 v1記録](CP025-HOTEL-AUTHENTIC-EDIBLE-ATLAS-v1.md)に追記済み。

## 原本の照合（SHA-256）

| 対象 | SHA-256 |
| --- | --- |
| `index.html` | `ccee6d8b43d50e6f651a091e745d1570131d8fb7ca3a85781da5c6aa17e3426a` |
| `preview_offline.html` | `a428ed02a283571829ff646b8711cf7e9c5b1a13b594cbdd01ee8131d17d81ef` |
| `qa.json` | `19356d5b35b8d5181272987222dcd07c0b781b0a7702c523eba023e1bc1a3ad4` |
| `screenshots/1440_full_page.png` | `6e813185cc44f6b870600a445e9fa522ed780df2e0bbc149604f31399b0b886e` |
| `screenshots/390_full_page.png` | `3816f139941cb765e4166fdb9e30077e2749ec39836e713acd4fcb8dc5b8ef99` |
| `screenshots/desktop_mobile_overview.jpg` | `7701845c8f26e8d6cf5a260d5959320ebe5b5d10cf94eec24b920559f83ad0af` |
| `SecondRoot_CP025_SpiceCabinet_FullPage_v2.zip` | `feadaaa457d83bc06db400d727e568647dacb165933563a35205d02ef2563c2e` |

原本はChatGPT会話側に保存、GitHubには研究記録と照合値のみ。**CP-025はv1不採用、v2評価待ち。研究成功23件、目標30件まで7件、CP-014は未採用のまま。**
