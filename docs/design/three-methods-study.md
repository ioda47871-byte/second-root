# 3制作方式の比較研究 (VISUAL_FIRST / LAYOUT_FIRST / DIRECTION_FIRST)

DEV-141。Issue #180 (オーナー事前承認、2026-11-01) により、Issue #177 の **Phase E (統合検証) に追加する研究**として扱う。#177 の Phase A〜E を置き換えず、進行中の開発も止めない。

**この文書は設計である。** 実 Codex・画像生成は、ここに書いた計画に対応する個別の実行承認 (§7) を受けるまで行わない。模擬の結果 (§8) は、方式の優劣を示すものとして扱わない。

## 1. 名前

比べる制作方式には、次の名前を使う。既存の技術的な経路 (Phase 2f の Route `A_image` / `B_html_prototype` / `C_hybrid`) とは別の名前であり、混同しない。

| 方式 | 誰が何をするか |
|---|---|
| **VISUAL_FIRST** | Codex が完成デザインの PC/SP ビジュアルを作る。Claude が、承認されたそのデザインを Web として実装する |
| **LAYOUT_FIRST** | Claude が店舗固有の PC/SP の構図と実装を作る。必要な写真・イラストを Codex が個別に生成し、Claude が組み込む。共通テンプレートには固定しない |
| **DIRECTION_FIRST** | Codex がビジュアルの方向を示す。Claude が、実装できる PC/SP の構図を設計する。Codex が追加の素材を生成し、Claude が組み込む |

各方式は、内部で既存の Route を部品として使う (§3)。方式と Route は1対1ではない。

## 2. 何を比べるか (研究の問い)

> 同じ架空店舗・同じ事実・同じ予算で、**誰が見た目の方向と構図を決めるか**を変えると、成果物の店舗らしさ・独創性・完成度、実装の忠実さ、PC/SP の品質、手間 (時間・生成回数・修正回数) はどう変わるか。

変える条件は「方向と構図を決める担い手」だけである。そのほかの条件は §4 で揃える。

## 3. 各方式の手順・入出力・引き渡しの境界

共通の入力は、事実パック・Identity Lock・共通の店舗ブリーフ・同じコンテンツの一覧 (§4)。

### VISUAL_FIRST

1. **Codex (デザイン呼び出し 1回):** 共通の入力から、完成デザインを作る。
   - **既定案 V-B:** Route `B_html_prototype` / `C_hybrid` の Codex 試作を使う。runner がそれを PC1440/SP390 で描き、その描画をデザインの原本とする。
2. **Codex (画像 0〜1回):** デザインが写真・イラストを要るとき、Route C の画像1枚を作る (既存の `MAX_ASSETS = 1`)。
3. **オーナー:** そのデザインを承認する (Phase 2f の intake で `render_pair_complete`)。
4. **引き渡し:** `prepareImplementationLane` (DEV-128) で、artifact の記録・PC/SP の原本・素材だけを渡す。**Codex の試作の HTML/CSS は渡さない。**
5. **Claude:** 原本を見て実装する (`index.html` / `style.css` / `assets/`)。
6. **検査:** `impl-compare` (DEV-139) で原本と比べる。

- **代案 V-A:** Route `A_image` の画像ツールの絵をデザインとする案。この絵はその幅の描画ではない (concept image)。DEV-139 は concept image を原本とみなさないので、実装の忠実度を機械では測れない。**どちらにするかはオーナーが決める (§10)。**

### LAYOUT_FIRST

1. **Claude:** 共通の入力から、店舗固有の PC/SP の構図と実装を作る。
   - `second-root-design-director` と `frontend-design` のスキルに従う。B方式の制約 (JS なし・外部読み込みなし) を守る。
   - 素材の置き場所は、`<img alt>` と、`data-asset` で示す要求として書く。
2. **Codex (画像 0〜1回):** 要求された素材を1枚生成する。
   - 要求の形は既存の `AssetRequest` と同じ (asset_id・alt・prompt・prompt_sha256・測った位置・essential)。
   - 画像を呼ぶ道筋も既存のものを使う。
3. **Claude:** 素材を組み込む。
4. **検査:** デザインの原本が無い方式なので、忠実度ではなく「自分の構図の描画と、素材を組み込んだあとの描画」の差を記録する。PC/SP の品質は §5 の共通の検査で見る。

### DIRECTION_FIRST

1. **Codex (方向の呼び出し 1回):** 共通の入力から、ビジュアルの方向を示す。
   - 方向は、Design DNA の8観点 (hero・typography・palette・product_visual・section_rhythm・navigation・mobile・implementation) を文章で返す形とする。画像ではない (§10 で、方向の画像を使う代案を検討する)。
   - これは新しい prompt なので、実行前に pin が要る (§7)。
2. **Claude:** その方向から、実装できる PC/SP の構図を設計し、実装する。
3. **Codex (画像 0〜1回):** 要求された素材を1枚生成する (LAYOUT_FIRST と同じ道筋)。
4. **Claude:** 素材を組み込む。
5. **検査:** 方向の文書と実装の対応を、オーナーが見られる形にする。品質の機械検査は §5 と同じ。

### 引き渡しの境界 (3方式に共通)

- Claude の実装の入力は、事実パック・Identity Lock・共通ブリーフ・同じコンテンツの一覧と、方式ごとに決まった Codex の出力だけ。
  - VISUAL_FIRST では、lane の原本と素材。
  - DIRECTION_FIRST では、方向の文書と素材。
  - LAYOUT_FIRST では、素材だけ。
- Codex の試作の HTML/CSS は、どの方式でも Claude に渡さない (DEV-128 の約束をそのまま使う)。
- 画像の承認 (`approval_id`) と、素材を `design_only` として扱うことは、既存の Route C の規則どおりとする。

## 4. 揃える条件

| 条件 | 揃え方 |
|---|---|
| 店舗 | 新しい架空のパン屋 **架空パン工房 こむぎ灯** 1件 (`design-library/research/three-methods/`)。これまで Codex に渡したことのない店にし、過去の方向案や基準線の影響を避ける |
| 事実 | `facts-pack.json` (16件。値はすべて研究用の作り物で、名前を持つものには「架空」を付ける) |
| Identity Lock | `identity-lock.json` (研究用、`is_research_only: true`) |
| 同じコンテンツ | ページに出してよい文は、事実の値と、40字以内の中立なラベルだけ (design-director の評価と同じ規則)。3方式とも同じ事実の集合を、全部載せる |
| ブリーフ | 共通の店舗ブリーフ (店の意図と制約) を1つにする。**見た目の方向 (DNA) は書かない**。方向を決める担い手が、比べる変数だからである |
| 画面 | PC 1440 / SP 390、dsf 1、JS 無効、外部通信なし (Phase 2f の描画と同じ) |
| 技術の制約 | B方式の試作の制約 (`checkPrototype`)、実装レーンの CSS と書体の許可一覧 |
| Claude の条件 | 同じモデル・同じスキル・同じ修正の上限 (`runLoop` の `implementationAttempts: 3`、`fixesPerCause: 2`)。オフラインで行う |
| 生成の予算 | 方式ごとに、Codex のデザインまたは方向の呼び出しは **0〜1回**、画像は **0〜1枚**、やり直しは **1回まで** (§6) |
| 採否 | オーナーが盲検で評価する (§5)。数値は採否の代わりにしない |

入力のハッシュ (SHA-256) は次のとおり。変わればテスト (`tests/unit/design-agent/research/three-methods.test.ts`) が落ちる。

- `facts-pack.json`: `e63d925a1e1cdae46502d9e2a1fc2745eb69a47e65df7ba51fdd9036d04597c0`
- `identity-lock.json`: `29c1fd88013e42b30a1a8f42a1b3e1773e27ac80c3a0c1756a8725d4b48fbcb4`

## 5. 計測と評価

### 機械の検査 (既存のものを使う。新しい品質検査は作らない)

| 見るもの | 道具 | 対象 |
|---|---|---|
| 実装の忠実度 (SSIM・色差・区画の位置・順序・大きさ) | `impl-compare` (DEV-131/139) | VISUAL_FIRST (V-B) |
| SP の読みやすさ・押しやすさ | `measureMobileQuality` (DEV-134/140)。`renderPrototype` の SP 描画で実行する | 3方式 |
| 構造の観察 (汎用 LP の印、成功例・不採用例との近さ) | `observeStructure` (DEV-138) | 3方式 |
| 店の取り違え | `auditPageText` (Identity Lock) | 3方式 |
| 横はみ出し・描画の失敗 | Phase 2f の描画 (`PROTOTYPE_HORIZONTAL_OVERFLOW` など) | 3方式 |
| 事実に無い文 | design-director の評価と同じ数え方 (見える行のうち、事実の値に無く、文の形をしたもの) | 3方式 |

- 実装の忠実度は、デザインの原本がその幅の描画である方式 (VISUAL_FIRST の V-B) でしか測れない。測れない方式は、測れないと記録する。
- 閾値は、どれも既存の仮の値である。新しい閾値は作らない。

### オーナーの盲検評価

- 3方式の PC1440/SP390 の全頁画像を、方式名を伏せて (X/Y/Z。並び順は無作為) 並べる。
- 観点は Issue #180 の3つ (店舗らしさ・デザイン独創性・視覚的完成度) と、PC の出来・SP の出来の、計5つ。それぞれ 1〜5 で付ける。
  - 尺度の目安は、既存の `docs/operations/design-image-eval-template.md` の書き方に合わせる。
- 「これは採れない」(事実の誤り・店の取り違え・読めない) は、点数とは別に印を付ける。
- 盲検の点を付けたあとで、方式名と機械の検査と手間の記録を開く。
- 評価票は `design-library/research/three-methods/review-sheet.md`。

### 手間の記録 (1方式1回ごと)

`design-library/research/three-methods/run-record-template.json` の形 (`three_method_run_v0`) で残す。

- 方式、店、実行の種類 (`mock` か `live`。§8)、入力のハッシュ (事実パック・Identity Lock・ブリーフ)
- Codex の呼び出しごとに、用途 (design・direction・asset)、approval_id、plan_id、prompt の SHA-256 と文字数、開始・終了の時刻、結果、やり直しかどうか
- 生成した画像の枚数と、使った枚数
- Claude の作業時間 (開始と終了の時刻)
- 修正の回数
  - 修正ループの試行回数と、原因ごとの回数
  - オーナーに頼まれた作り直しの回数
- 成果物のパスと SHA-256 (PC/SP の画像、HTML、CSS、素材)
- 機械の検査の報告のパスと要約
- 失敗と停止 (コードと理由)

## 6. 実行回数・時間・費用

| | VISUAL_FIRST (V-B) | LAYOUT_FIRST | DIRECTION_FIRST |
|---|---|---|---|
| Codex のデザイン/方向の呼び出し | 1 (デザイン) | 0 | 1 (方向) |
| 画像生成 | 0〜1 | 0〜1 | 0〜1 |
| やり直しの上限 | 1 | 1 | 1 |
| 最大の呼び出し数 | 3 | 2 | 3 |

- **パイロット (各方式1回):** 最初の呼び出しは最大5回 (デザイン1・方向1・画像3)、やり直しは最大3回、合わせて**最大8回**。
- **推奨:** パイロットのあとに、同じ条件でもう1回ずつ行い、ぶれを見る (合わせて最大16回)。2回目を行うかは、パイロットの結果を見てオーナーが決める。
- **費用:** これまでの実行と同じく、ChatGPT のプランの利用枠を使う。API の課金は無い (`docs/design/phase2f-b-v11-experiment-plan.md` §4、`docs/operations/design-image-poc.md`)。円・ドルの単価は、リポジトリのどこにも記録が無い。利用枠の消費は、パイロットで最大8回分である。
- **時間:**
  - Codex の1回の呼び出しは、多くは数分で、15分で打ち切る (`LIVE_LIMITS.callTimeoutMs`)。1つの計画は2時間まで (`planBudgetMs`)。
  - Claude の実装は、方式ごとに 30〜60分を見込む (design-director の評価では、1件 9〜12分・約16〜19万トークン。実装と修正の分を足した)。
  - 見込みの合計は、Codex の呼び出しが 0.5〜2時間 (オーナーが立ち会う)、Claude の作業が 1.5〜3時間。
- 1つの計画あたりの上限は、既存の `LIVE_LIMITS` (最初の呼び出し4回・やり直し2回) に収まる。**方式ごとに別の plan_id とする。**

## 7. 実行の承認 (まだ何も実行しない)

Issue #180 は、比較を行う方針と計画の準備を承認したものである。**実行の権限を足したものではない。** 実 Codex・画像生成を呼ぶ前に、Issue #134 / #159 と `docs/design/phase2f-live.md` の手続きを、呼び出しごとに満たす。

1. **prompt を作り、pin を出す (オフライン)。**
   - VISUAL_FIRST のデザイン、DIRECTION_FIRST の方向、3方式の素材のそれぞれについて作る。
   - `--print-pin` の形で、prompt の SHA-256・文字数・commit を出す。
   - VISUAL_FIRST の共通ブリーフ (DNA なし) と DIRECTION_FIRST の方向は、新しい prompt なので、作って review を通すのは DEV-143 で行う。
2. **オーナーに報告する。** 呼び出しの一覧 (用途・回数・prompt の SHA・利用枠の見込み・実行環境・失敗したときの扱い) をまとめる。
3. **オーナーが承認する。** 承認は、approval_id・plan_id・expected prompt SHA と文字数・expected commit の組である。
4. **オーナーが起動する。**
   - 実行環境は、WSL の `sr-designgen` (`sr-jail-*.service`) とする。
   - 本番の worker と画像の PoC は止めておく。
   - ledger は `~/.local/state/sr-design-worker/phase2f-live/` に置く。approval_id を使い回さない。
5. **失敗したとき。** 自動のやり直しはしない。やり直しは、計画の上限 (§6) の中で、新しい承認を受けて行う。チェックで断られた場合は、承認を使わない。

Claude は、prompt と pin の準備・報告・実行のあとの検査と記録を行う。**Claude が実 Codex や画像生成を起動することはない。**

## 8. 模擬と実画像の区別

- **模擬 (`run_kind: "mock"`、DEV-142):** Codex の出力の代わりに、保存済みの架空の fixture を使う。
  - デザインの代わりは、手で書いた試作 HTML の描画。素材の代わりは、色の板や、ライセンスを確かめた fixture の画像。
  - 3方式の手順・引き渡し・検査・記録が通しで動くことを確かめ、PC1440/SP390 の画像を作る。
  - **模擬の画像や数値は、方式の優劣の証拠にしない。** 報告・画像・記録のすべてに `MOCK` と付ける。
- **実画像 (`run_kind: "live"`):** §7 の承認を受けて、実 Codex・画像生成を使ったものだけ。
  - オーナーの盲検評価と、方式の推奨はこれで行う。
  - 標準の方式を決めるのはオーナーである。

## 9. 段階

| 段階 | 中身 | 承認 |
|---|---|---|
| DEV-141 (この文書) | 設計・事実パック・Identity Lock・評価票・記録の形・実行計画 | Issue #180 (offline) |
| DEV-142 | 3方式の模擬の通し実行 (fixture)、記録・検査・PC/SP の画像。テスト | Issue #180 (offline) |
| DEV-143 | 共通ブリーフ・方向の prompt・素材の要求の組み立てと pin の出力。オフラインで、Codex は呼ばない | Issue #180 (offline) |
| パイロット | 実 Codex・画像生成で、各方式1回 | **呼び出しごとの個別承認** (§7) |
| オーナーの評価 | 盲検の評価票で比べ、方式を推奨する。採用はオーナーが決める | オーナー |

## 10. オーナーに決めてほしいこと

1. **VISUAL_FIRST のデザインの形。** 既定案は V-B (Codex の HTML 試作を描いたものを原本にし、忠実度を測れる)。代案は V-A (画像ツールの絵。忠実度は目で見るしかない)。
2. **DIRECTION_FIRST の方向の形。** 既定案は、文章の方向 (DNA の8観点)。代案は、方向を示す画像1枚。代案にすると画像の枚数が1枚増え、予算が揃わなくなる。
3. **回数。** パイロットを各方式1回にするか、最初から2回にするか。

## 11. 限界

- 1店舗・1〜2回の比較である。方式の差と、その回のぶれとを分けきれない。
- 盲検でも、方式の癖から見分けがつくことがある。
- LAYOUT_FIRST と DIRECTION_FIRST には、デザインの原本が無い。実装の忠実度は VISUAL_FIRST でしか比べられない。
- 検査の閾値と構造の語彙は、どれも仮のものである (Issue #159)。
