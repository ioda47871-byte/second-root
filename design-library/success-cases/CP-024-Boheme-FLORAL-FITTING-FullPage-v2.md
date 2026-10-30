# CP-024 | Boheme. — FLORAL FITTING ROOM / Full-page HTML study v2

**ユーザー採用日:** 2026-10-28 JST。「いいじゃん毎回これで出して」と全ページ形式を高評価した後、「**これを成功例として、次にいこう**」と明示。**23件目のSecond Root研究成功例**。採用対象はHero初稿だけでなく、**PC/スマホの最後まで設計した全ページHTML/CSS/JS研究試作 v2**。

## 店舗コンセプトと独自の情報構造

名古屋市中村区の生花店Boheme.（Instagram: https://www.instagram.com/boheme.nagoya/ ）の「花を着崩す。」をファッションの**フィッティングルーム**に変換。
- ヒーロー：アンティーク鏡の中央に大きな非対称の花のスタイリングを置き、左右を金属製ラックと花材で構成。
- 下層の情報経路：**Introduction → The Fitting（LOOKを選ぶ）→ Styling Rail（COLOR/SILHOUETTE/TEXTUREのハンガー吊りタグ）→ Concept/Story → Visit**。単なる写真商品カードの反復ではなく、花を着こなす体験をページ全体に延ばした。
- デザインをPCだけでなくスマホ用にも再配置。LOOK 01/02/03のUIは実際に切り替え可能。

## 本研究の品質と未実装部分

- **PC全ページ・スマホ全ページ・PC/スマホ俯瞰比較・下層抜粋・HTML/CSS/JS実装・自己完結プレビュー・ZIP**をセットで提出し、ユーザーが全体を評価して採用。
- ローカルChromium+Playwright `page.set_content` で**320,375,390,430,768,1024,1280,1440,1920px**の9画面幅において、意図せぬ横はみ出しなし、Hero画像読込、LOOK切替、JS例外0を確認。**Safari/Firefox/実機/支援技術の総合監査/Next.js/本番公開は未検証**。
- **PC Heroの文字と写真は元画像に焼き込み**で、近似クリック領域を使った研究的な操作。花・内装・花器もAI生成の架空画像。LOOK 3種は独立した実商品写真ではなく**同じ原本画像に色調補正・クロップを当てた研究的な見せ分け**。完全な制作受託サイトではない。
- 商店の**公式Web/本人運営ECは検索で未発見**だが、Instagramプロフィール外部リンク未確認、同名BASE店舗の運営主体未確認のため**サイトなし営業候補資格はHOLD**。ユーザーの成功承認は研究デザインの承認であり、実店舗公認・写真利用権・営業送信・本番反映は承認されていない。

## 採用原本とハッシュ（SHA-256）

| 対象 | SHA-256 |
| --- | --- |
| Hero原本（全ページv2でもビット同一） | `8bd0bc176b1e2e5043536aba5e97c556c426b2651679c8f274d1d971ac5f13ce` |
| `index.html` | `71eb17c7e330b43a49379afe601f2e29230a7024065ea4f8afe80e400f8bfc49` |
| `preview_offline.html` | `d9593eaef6241ca67b92321f948cc85846f59e286de59b739b539bade474708f` |
| PC1440全ページPNG | `5c81a615ed3bfec4c1d27ee1729bf80d56112a5df62d92b69b4274de673d0de9` |
| スマホ390全ページPNG | `4e3af11e5f04646e890d8a14dc1143ea3b937e78b5928d2d8b2fcfd2ed634c68` |
| PC/スマホ俯瞰比較JPG | `33c4cef00cee2e90a9a47484982cec7b57cb124a01e8f9af7b2803d8b2e800fd` |
| **研究ZIP** `SecondRoot_CP024_Boheme_FullPage_Research_v2.zip` | **`ed83a5fa210b3847dbd95ce703f0799db7d148e6a55659bc47db999a90efc50a`** |

ファイル原本はChatGPT会話側に保管。GitHubには**本文・照合ハッシュのみ**を登録し、大きなPNG/HTML/ZIPバイナリはコミットしない。

## 学習原理

**Heroの出来栄えだけでWebサイト全体を評価しない。** 店舗の具体的な「花を着こなす」体験を、セクション・UI・モバイル閲覧順に一貫して変換。別店にはBoheme.の鏡・花・ラックやこのレイアウトをコピーせず、店固有の行為から新構造を発明する。以降の新規研究では[PC/スマホ全ページ提出ルール](../../docs/design/research-full-page-review-gate.md)を標準とする。

**登録後の研究成功累計：23件（ローカルHTML/CSS/JS研究PoC10件＋静止コンセプト13件）、30件目標まで7件、参考候補80件。CP-014未採用。**
