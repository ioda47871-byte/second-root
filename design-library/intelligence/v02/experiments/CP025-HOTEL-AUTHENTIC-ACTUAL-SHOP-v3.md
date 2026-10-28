# CP-025｜HOTEL AUTHENTIC — THE MONTHLY MENU WALL / Full-page v3

**日付：** 2026-10-28 JST。**状態：`RESEARCH_FULLPAGE_V3_AWAITING_OWNER_REVIEW`、未成功採用**。

## ユーザー評価と再設計のきっかけ

- v1 THE EDIBLE ATLAS全ページを見たユーザー「**凡庸だな**」→一般的な左コピー/右写真Hero、地域タブ、写真/説明帯の反復に戻った問題を記録し**不採用**。
- v2 THE SPICE CABINET全ページを見たユーザー「**この店っぽくないな**」→暗いスパイス棚という業種一般からの発想で、現実の店の造形と料理の特徴を押さえていなかったため**不採用**。v2の基本ブラウザテストがPASSでも店の個性の検証にはならなかった。

## 新たに確認した実店舗の特徴

**対象：HOTEL AUTHENTIC**（名古屋市昭和区山里町70-2、八事日赤近く）。公式Instagram `https://www.instagram.com/hotel.authentic/`、[公式LINE](https://page.line.me/202svvgd)。

1. [内装施工VELETA](https://veletainc.com/works/indian-restaurant-hotel-authentic/)および[店舗デザイン.COM](https://www.tenpodesign.com/work/detail/39839)：**外観のワインレッドに金色文字の看板、内部の白い壁/大理石/青い金属格子/白青の装飾タイル/木の椅子**。実写真の構図を素材としてコピーせず、これらの配色と建築要素を**オリジナルCSSの抽象グラフィック**として使う。
2. [公式LINEメニュー説明](https://page.line.me/202svvgd/showcase/1392728193052006)：**毎月地域テーマを変えて、昼はセット、夜はアラカルト**。注文後につくるチャイ＋自家製ビスケット、タンドール調理、デザート等。**現時点の地域、メニュー名、品数、値段、在庫は提示していない**。
3. [2026年の訪問記録](https://search-ethnic.com/gourmet/hotel_authentic_3/)では現地風の手作りの掲示紙メニューの写真/記述がある。掲示紙は**研究上の構造モチーフ**で、現在壁に同じ物があるとは断定しない。
4. 本人の独立ホームページ/ネットショップは検索で未発見。ただしInstagramのプロフィールリンク先を検証できていないため、**サイトが存在しないと断言しない**。**本人のLINE公式アカウントは実在**。今回の研究画像は本人公認/正式営業提案ではない。

## v3での独立した全ページ構造

**THE MONTHLY MENU WALL — 店内の紙が毎月貼り替わる。**

- **ENTRY / REAL PLACE:** 実際のワインレッドの看板、青い格子と白タイルの室内という明確な個性を、Heroの建築そのものと色に反映。「汎用インド料理ポスター」「木のスパイス棚」を再使用しない。
- **01 THE MENU WALL:** 背景は青い線の掲示壁。**MONTHLY REGIONS / CHAI / TANDOOR**と書いた紙の案内をクリックすると、中央の黄色い紙自体が異なる説明に**物理的に差し替わる**。全部の文言は公式LINEに基づき、今月の具体的な提供品の創作なし。
- **02 THE PLACE:** 白大理石、タイルと青い鉄格子を下層の仕切りや背景へ継続。料理写真は**AI生成研究イメージ**をこの区画で一度だけ使用し、現行の商品や実店舗の写真とは区別。
- **03 AT THIS TABLE:** 公式に掲載された月替わり/チャイ/タンドールの情報を飲食店内の小さな説明としてまとめる。
- **04 VISIT:** ワインレッドの掲示カードで、確認された住所と**公式Instagram/LINE**の最新案内リンク、Googleマップの導線へ。営業時間の推測や架空の予約ボタンなし。

## ローカルでの全ページ試作とQA

- `index.html`：独立したDOM、CSSによるオリジナル建築モチーフ、JavaScriptによる紙の差し替え。PC/スマホで最後まで読める構造。
- `preview_offline.html`：AI生成の**説明用料理画像**を埋め込んだ自己完結HTML。
- **PC1440フルページPNG、スマホ390フルページPNG、俯瞰比較画像、月替わり案内の切替画面、v2/v3の比較**を出力。
- Chromium+Playwrightによる研究用ローカル確認：**320,375,390,430,768,1024,1280,1440,1920pxの9画面幅**。初回は768pxでバッジが右へはみ出したため修正し、再検証で**9幅すべて意図しない横はみ出し0、画像読み込み成功、紙の案内を3種選ぶボタン全部成功、JS例外0**。390pxのモバイルナビも開閉確認。
- **Firefox/Safari/実機/スクリーンリーダー総合監査/Next.js/本番公開は未実施**。オーナーの美的評価も待ち。

## 研究ソース／原本ハッシュ（SHA-256）

| ファイル | SHA-256 |
| --- | --- |
| `index.html` | `f84b8b2c5b4d43f87ae85fd7a216c39b90ac0ec49de43bb0e2229ff356229406` |
| `preview_offline.html` | `a8839122931fcd3337f1a465a214e5dbc930f8aafb723a17d188a146e676a9bc` |
| `assets/illustrative_food.jpg` | `737fe9c86c4ea087e98c89c73adcfd3a216d36f7943a7911bdf0410f8beb6c1f` |
| PC1440全ページ | `368b846af489dcf889006ef1f3f95bbe7caef8fffd92408d5809f003da0f2853` |
| スマホ390全ページ | `adfe87a5d64133d4711f1badc01f5d24f11fdeb2cc7e516d83f04be271e35fc1` |
| PC/スマホ俯瞰 | `f41d24aa3ef5eb49c2ef92c1a7dd9c619d6cd11d126f565b58fadd696b5642b0` |
| 旧v2と新v3のPC全体比較 | `8656bcb715759d94c444e049666c6b1099637c4222ec0dae10e2de81bba8cde6` |
| `qa.json` | `2ba853a9b31b9036b69574367f008d4d29abeacd1f752d2685def55b46e5a4e7` |
| ZIP `SecondRoot_CP025_HOTEL_AUTHENTIC_ActualShop_FullPage_v3.zip` | `6cf37160840cbdec7920796dfe81952ba2fa5dbd3a26c3ea063d6211e55bfb8d` |

**著作権・実在性:** ローカル画像は以前Second Rootが生成した料理のAI研究画像を編集したもの。内装は**既存の写真を無断利用せずCSSで抽象的に再現**。写真・ロゴ・文字の本物であること、実商品、価格、営業時間、本人公認や商用使用は保証しない。原本とZIPは会話側。**GitHubには研究メモとハッシュだけ**でバイナリは保存しない。

**研究成功数は23件（HTML成功PoC10件＋静止画像成功13件）。v3はユーザー評価待ち、CP-014も未採用。30件目標まで7件。** 営業候補選定はSNSプロフィールリンク未確認でHOLD、本番サイト/営業AI/生成ワーカー/DBへ変更なし。
