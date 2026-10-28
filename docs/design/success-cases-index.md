# 承認研究デザイン事例の登録（2026-10-28）

Second Rootの **成功したアートディレクションの研究記録** は [design-library/success-cases](../../design-library/success-cases/README.md) に登録。

* CP-001: Mond — editorial triptych（研究用成功例）
* CP-002: Sissi — botanical organic composition（研究用成功例）
* CP-003: なごやビーンズv4 — design approved（実装PoC / 非公開）
* CP-004: harebare — spinning beigoma editorial（実装PoC / 研究用として選定・非公開）
* CP-005: Hamsa — rice koji / shared loaf editorial（実装PoC / 研究成功例としてオーナー承認・非公開）
* CP-006: Melon de Mille — CUT & STACK（B案の改良版・研究デザイン成功例として承認。HTML/CSS未実装・非公開）
* CP-007: ORGN. — SEAM / CUT（ヘアサロン＋古着リメイク・研究成功例としてオーナー承認・HTML実装PoCのみ・非公開）
* CP-008: 整体院 Go. — PAUSE / GO（最初のA案の強い意匠を保持した改良版・研究デザインとして承認。HTML/CSS未実装・非公開）
* CP-009: 豆＊豆 — STITCH / TOGETHER（ヨーヨーキルト＋赤い扉・研究成功例として承認。HTML/CSS/JSローカルPoCのみ・非公開）
* CP-010: ぺいぱばっくらいたー — PT-02 本棚が地図になる v3（構図維持・質感改善による研究成功例、ローカルHTML/CSS/JS PoCのみ・非公開）
* CP-011: BAR N — GLASS / SILENCE Structure Recovery v2（巨大グラスと光の屈折を維持した下層再構成・ローカルHTML研究成功例として承認、非公開）
* CP-012: Admy — ONE OF A KIND / Mineral Specimen Editorial（天然石と標本帳の構成・初期FULL画像を研究成功例として承認、HTML未実装・非公開）

* CP-013: スペースたのしい — TOY PACKAGING / SCRAPBOOK v2（玩具のブリスターパック＋紙のコラージュを保護した改良版、研究デザイン画像として承認・未実装）

* CP-015: imairo. — TABLE AS A MAP / TABLE JOURNAL v2（食卓を巡る操作＋紙片ノートの独立UIを研究用ローカルHTMLで実装し成功例として承認。元Heroの文字は焼き込み、店舗公認・商用公開なし）

* CP-016: ズールー工作所 — COUNTERWEIGHT ZK-01 v1（重力・支点・余白を画面の骨格として使用する操作可能なHTML/CSS/JS/SVG研究PoC。初期の汎用LP案は不採用。商用公開なし）

* CP-017: Rurikoyarn — UNWIND v1.1（巨大な糸ループと暗色の余白を保護し局所的な質感補正で改善した研究採用画像。HTML未実装）

* CP-018: MOLE FACTORY — OVERPRINT / MISREGISTER v1（重ね刷りの色版・網点・トンボを情報のレイアウトに変換した研究採用静止画。実Web化・実店舗公認なし）

* CP-019: 浦田杏梨 / ANNA URATA — WAX / TIME v1（蝋の変形過程をBEFORE/MELTING/AFTERの空間的な読順にした非公式の研究成功画像。Web未実装・作家公認なし）

* CP-020: 喫茶 ITALICO / SHOWCASE v1（喫茶店のガラス棚を情報構造にした静止デザイン。Webなしの最終確認は保留）

* CP-021: TERACE / PICK — COMPOSE v1（透明アクリルの選択・組立・プレビューを空間構図にした静止画像。v2は改善不足で不採用し、事前指示に従い初稿v1を採用。Webサイトなし調査は保留）

* CP-022: Harissy / CRUMB・FRACTURE v1（ドーナツ断面の亀裂とクラムを視線構造にした初稿を21件目の研究成功に採用。画像のみ、店舗公認なし）

成功した**レイアウトをテンプレート化せず**、店舗ごとのアートディレクションやスクリーンショット比較の方法を学ぶ。
既存の40+40件の候補データとは別管理。営業システム・本番サイトへ自動投入しない。

## Design Intelligence pilot v0.1（研究用）

[成功事例21件の設計知識・審査候補20件](../../design-library/intelligence/v01/README.md) を追加。
設計過程・失敗の理由・実装状況を構造化したJSONと、既存10件の人間審査＋新規10件の優先候補を整理したキューを保持する。**20件が審査済みという意味ではなく、成功21例も生成器に自動投入しない。**

## Structure First 実験（v0.2）

[画像生成前の3構成案比較・紙芝居書店の試作設計](../../design-library/intelligence/v02/README.md)。既存成功例と定性的に照合し、左右交互LPの再発を防ぐための研究用監査を追加。**CP-010は研究成功例として採用済みだが、実店舗への正式公開ではない。**

## 次の固定目標：研究成功30件（2026-10-28決定）

[研究ロードマップ：成功例30件・参考20件の深掘り審査・画像からWebへの再現性](design-intelligence-next-milestone-30.md) に、現状**参考候補80件＋採用研究21件＝計101件**、次の研究成功例**30件（あと9件）**、優先課題3つと採用判定の区別を固定。これは件数だけを追う目標ではなく、非テンプレート性・人間の承認・実装忠実度を評価するマイルストーンであり、本番システム導入承認ではない。

## CP-020以降の候補条件

新規研究店舗は[Webサイトなし選定ゲート](no-website-shop-intake-policy.md)に従う。**公式ECサイト（BASE等）がある店も新規候補から除外**。検索未発見を不存在の断言とせず、プロフィール外部リンクを確認する。
