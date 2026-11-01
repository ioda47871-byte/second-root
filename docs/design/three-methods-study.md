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

> 同じ架空店舗・同じ事実・同じ予算で、**誰が見た目の方向と構図を決めるか**を変えると、成果物の店舗らしさ・独創性・完成度、実装の忠実さ、PC/SP の品質、手間 (時間・生成回数・修正回数)、費用、失敗率、作り直しやすさはどう変わるか。

変える条件は「方向と構図を決める担い手」だけである。そのほかの条件は §4 で揃える。

## 3. 各方式の手順・入出力・引き渡しの境界

共通の入力は、事実パック・Identity Lock・共通の店舗ブリーフ・同じコンテンツの一覧 (§4)。

### VISUAL_FIRST

1. **Codex (デザイン呼び出し 1回):** 共通の入力から、完成デザインを作る。
   - **既定案 V-B:** Route `B_html_prototype` / `C_hybrid` の Codex 試作を使う。runner がそれを PC1440/SP390 で描き、その描画をデザインの原本とする。
2. **Codex (画像 0〜1回):** デザインが写真・イラストを要るとき、Route C の画像1枚を作る (既存の `MAX_ASSETS = 1`)。
3. **引き渡しの条件:** Phase 2f の intake の状態が `render_pair_complete` であること。これは機械の状態で、オーナーの承認ではない (`intake.ts` の約束)。
   - Issue #180 の「承認済みデザイン」は、盲検を保つため、この研究では「オーナーが承認した実行計画 (§7) で作られ、機械の状態が `render_pair_complete` のデザイン」とする。オーナーは、評価 (§5) の前に成果物を見ない。
   - 3方式とも、評価の前にオーナーが途中の成果物を見て選ぶことはしない (§4)。デザインの途中確認を入れたい場合は、3方式すべてに同じ確認を入れ、盲検が崩れることを記録する (§10)。
4. **引き渡し:** `prepareImplementationLane` (DEV-128) で、artifact の記録・PC/SP の原本・素材だけを渡す。**Codex の試作の HTML/CSS は渡さない。**
5. **Claude:** 原本を見て実装する (`index.html` / `style.css` / `assets/`)。
6. **検査:** `impl-compare` (DEV-139) で原本と比べる。

- **代案 V-A:** Route `A_image` の画像ツールの絵をデザインとする案。
  - この絵はその幅の描画ではない (concept image)。
  - 今の実装レーンは、concept image だけの artifact (`concept_only`) を**引き渡さない** (`handoff.ts`)。V-A にすると、引き渡しの道筋そのものを新しく作る必要がある。
  - 実装の忠実度も、機械では測れない (DEV-139 は concept image を原本とみなさない)。
  - **どちらにするかはオーナーが決める (§10)。**

### LAYOUT_FIRST

1. **Claude:** 共通の入力から、店舗固有の PC/SP の構図と実装を作る。
   - `second-root-design-director` と `frontend-design` のスキルに従う。B方式の制約 (JS なし・外部読み込みなし) を守る。
   - 素材の置き場所は、`<img alt>` と、`data-asset` で示す要求として書く。
2. **Codex (画像 0〜1回):** 要求された素材を1枚生成する。
   - 要求の形は、既存の `AssetRequest` と同じにする (asset_id・alt・prompt・prompt_sha256・測った位置・essential)。
   - **ただし、今の画像の呼び出し (`phase2f-image.ts` / `image-call.ts`) が受け付けるのは2つだけである。** Codex のデザインの実行に結び付いた Route C の要求と、Route A の和菓子の固定の prompt。Claude が書いた要求を受け付ける入口は無い。新しく作る必要がある (§9 の DEV-143、オーナーの個別承認が要る)。
3. **Claude:** 素材を組み込む。
4. **検査:** デザインの原本が無い方式なので、実装の忠実度は測らない (測れないと記録する)。PC/SP の品質は §5 の共通の検査で見る。

### DIRECTION_FIRST

1. **Codex (方向の呼び出し 1回):** 共通の入力から、ビジュアルの方向を示す。
   - 方向は、Design DNA の8観点 (hero・typography・palette・product_visual・section_rhythm・navigation・mobile・implementation) を文章で返す形とする。画像ではない (§10 で、方向の画像を使う代案を検討する)。
   - これは新しい prompt で、今の ledger の呼び出しの種類 (`design` / `image` / `concept_image`) にも「方向」は無い。方向の呼び出しの入口と prompt を新しく作り、pin を出す必要がある (§9 の DEV-143、オーナーの個別承認が要る)。
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
| 店舗 | 新しい架空のパン屋 **架空パン工房 こむぎ灯** 1件 (`design-library/research/three-methods/`)。リポジトリの中に、Codex に渡した記録の無い店にし、過去の方向案や基準線の影響を避ける |
| 事実 | `facts-pack.json` (16件。値はすべて研究用の作り物で、名前を持つものには「架空」を付ける) |
| Identity Lock | `identity-lock.json` (研究用、`is_research_only: true`) |
| 同じコンテンツ | ページに出してよい文は、事実の値と、40字以内の中立なラベルだけ (design-director の評価と同じ規則)。3方式とも同じ事実の集合を、全部載せる |
| ブリーフ | 共通の店舗ブリーフ (店の意図と制約) を1つにする。**見た目の方向 (DNA) は書かない**。方向を決める担い手が、比べる変数だからである。今の design の prompt (`DesignBrief`) は DNA の8観点を必須にしているので、DNA の無いブリーフを Codex に渡すには prompt の組み立てを変える必要がある (§9 の DEV-143、オーナーの個別承認が要る) |
| 参考資料 | 3方式で同じにする。なお、既存の v2 の prompt (DEV-124) はブリーフ無しで組めるが、前もって書いた `OpenDirection` (コンセプト・Hero・流れ・成功例の研究) と参照の manifest (`ReferenceManifest`、`resolveDirection` で検める) が要る。これでは、比べる変数 (方向を決める担い手) が方式の外で決まってしまう。また、事実と画像の規則 (`V2_FACT_RULES` / `V2_IMAGE_RULES`) が和菓子の店向けに書かれている。研究ありの v1.1 の prompt は Route B だけで、Route C の画像と同時には使えない。どちらも DEV-143 で扱う。Claude は3方式とも同じスキル (成功例・不採用例を含む) を使う。Codex のデザイン・方向の呼び出しには、既存の「研究あり」の prompt の形 (`phase2f-b-v11-experiment-plan.md`) で、同じ成功例の要約を渡す。完全には揃わないので、残る差を §11 に記録する |
| 修正のきっかけ | 3方式で同じにする。**修正のきっかけは、Claude の実装の描画の横はみ出しだけ** (`renderPrototype` で描いて、横の大きさが幅を越えるもの。オフラインで直し、上限は `runLoop` の `LIMITS` を借りる)。`runLoop` は比較の差で修正するが、この研究は3方式を揃えるため比較の差を記録だけにし、上限だけを借りる。**Codex のデザインの描画のはみ出しは、修正しない**: 既存の描画がそれを stops に記録し (`PROTOTYPE_HORIZONTAL_OVERFLOW`)、artifact は incomplete になって引き渡されず、その回をオーナーへ止める。やり直しは §6・§7 の承認つきの枠でだけ行う。**店の取り違え (Identity Lock の REJECT / HOLD) は、修正せず、その回をオーナーへ止める** (`runLoop` と同じ。停止条件を変えない)。**SP の所見 (`measureMobileQuality`)・事実に無い文・VISUAL_FIRST の比較の差は、記録するだけで、修正のきっかけにしない** (report-only の約束。`docs/design/phase2f-mobile-quality.md`、DEV-140、Issue #177 条件4。事実に無い文は既存の門ではない)。ほかの所見をきっかけにするかは、オーナーが決める (§10) |
| オーナーの作り直しの依頼 | 3方式とも、評価の前は0回。評価のあとの「作り直しやすさ」の測定 (§5) だけで、各方式1回 |
| 画面 | PC 1440 / SP 390、dsf 1、JS 無効、外部通信なし (Phase 2f の描画と同じ) |
| 技術の制約 | B方式の試作の制約 (`checkPrototype`)、実装レーンの CSS と書体の許可一覧 |
| Claude の条件 | 同じモデル・同じスキル・同じ修正の上限 (`runLoop` の `LIMITS`: `implementationAttempts: 3`、`fixesPerCause: 2`)。オフラインで行う |
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
| 横はみ出し・描画の失敗 | Codex のデザインは Phase 2f の描画 (`PROTOTYPE_HORIZONTAL_OVERFLOW` などを stops に記録する)。Claude の実装は同じ `renderPrototype` の描画の横の大きさ | 3方式 |
| 事実に無い文 | design-director の評価と同じ数え方 (見える行のうち、事実の値に無く、文の形をしたもの)。評価用の数え方で、既存の門ではない。記録するだけ。数えるコードは研究のテストか fixture の中に置き、新しい品質検査として登録しない (DEV-142) | 3方式 |

- 実装の忠実度は、デザインの原本がその幅の描画である方式 (VISUAL_FIRST の V-B) でしか測れない。測れない方式は、測れないと記録する。
- 構造の観察の「成功例・不採用例との近さ」は、成功例を見て作った方式に有利に出うる (同じ参照で測るため)。方式の比較では順位付けに使わず、参考として示すだけにする。
- 閾値は、どれも既存の仮の値である。新しい閾値は作らない。

### オーナーの盲検評価

- 3方式の PC1440/SP390 の全頁画像を、方式名を伏せて (X/Y/Z。並び順は無作為) 並べる。
- 観点は Issue #180 の3つ (店舗らしさ・デザイン独創性・視覚的完成度) と、PC の出来・SP の出来の、計5つ。それぞれ 1〜5 で付ける。
  - 尺度の目安は、既存の `docs/operations/design-image-eval-template.md` の書き方に合わせる。
- 「これは採れない」(事実の誤り・店の取り違え・読めない) は、点数とは別に印を付ける。
- 盲検の点を付けたあとで、方式名と機械の検査と手間の記録を開く。
- 評価票は `design-library/research/three-methods/review-sheet.md`。

- 修正のきっかけ (Claude の実装の横はみ出し) は、`renderPrototype` の `scrollWidth` と幅を、ビューポートごとに記録する。上限 (`LIMITS`) を使い切ったら、`runLoop` と同じく、その回をオーナーへ止める。

### 費用・失敗率・作り直しやすさ

- **費用:** 方式ごとの、Codex の呼び出しの数 (利用枠の消費) と、Claude の作業時間・トークンの概算。円・ドルの単価は記録が無いので、数で比べる。
- **失敗率:** 失敗・中断・拒否された呼び出しの数 ÷ 呼び出しの数。停止 (stops) の数とあわせて記録する。
- **作り直しやすさ:** 評価のあとで、3方式に同じ変更の依頼を1つ出す (例: 「商品を1つ足し、差し色を変える」。依頼の文は事前に固定する)。それを反映するのにかかった時間・変えたファイルの数・新たに要った Codex の呼び出しの数を記録する。
  - この測定で Codex の呼び出しが要る場合は、パイロットの「最大8回」の外である。呼び出しごとに §7 の承認と別の plan_id が要る。

### 手間の記録 (1方式1回ごと)

`design-library/research/three-methods/run-record-template.json` の形 (`three_method_run_v0`) で残す。

- 方式、店、実行の種類 (`mock` か `live`。§8)、入力のハッシュ (事実パック・Identity Lock・ブリーフ)
- Codex の呼び出しごとに、用途 (design・direction・asset)、approval_id、plan_id、prompt の SHA-256 と文字数、commit・Codex CLI の版・報告されたモデル (`generation.json` から写す)、開始・終了の時刻、結果、やり直しかどうか
- 生成した画像の枚数と、使った枚数
- Claude の作業時間 (開始と終了の時刻)
- 修正の回数
  - 修正ループの試行回数と、原因ごとの回数
  - オーナーに頼まれた作り直しの回数
- 成果物のパスと SHA-256 (PC/SP の画像、HTML、CSS、素材)
- 機械の検査の報告のパスと要約
- 失敗と停止 (コードと理由)、失敗率
- 作り直しやすさの測定 (時間・変えたファイルの数・要った Codex の呼び出しの数)

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
   - VISUAL_FIRST の共通ブリーフ (DNA なし)・DIRECTION_FIRST の方向・Claude が書いた素材の要求は、どれも今の入口では呼べない。入口と prompt を作るのは DEV-143 で、オーナーの個別承認を受けてから行う。
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
| DEV-143 | 実行に要る入口を作る: DNA の無い共通ブリーフの prompt、方向の呼び出し (prompt・ledger の種類)、Claude が書いた素材の要求を受け付ける画像の入口。pin の出力。Codex は呼ばない | **オーナーの個別承認が要る。** prompt・承認の流れ・ledger を変えるので、Issue #177 の条件付きマージの対象外 (#177 条件3と対象外の一覧) |
| パイロット | 実 Codex・画像生成で、各方式1回 | **呼び出しごとの個別承認** (§7) |
| オーナーの評価 | 盲検の評価票で比べ、方式を推奨する。採用はオーナーが決める | オーナー |

## 10. オーナーに決めてほしいこと

1. **VISUAL_FIRST のデザインの形。** 既定案は V-B (Codex の HTML 試作を描いたものを原本にし、忠実度を測れる)。代案は V-A (画像ツールの絵。忠実度は目で見るしかない)。
2. **DIRECTION_FIRST の方向の形。** 既定案は、文章の方向 (DNA の8観点)。代案は、方向を示す画像1枚。代案にすると画像の枚数が1枚増え、予算が揃わなくなる。
3. **回数。** パイロットを各方式1回にするか、最初から2回にするか。
4. **途中の確認。** 既定案は、オーナーが評価の前に成果物を見ない (盲検を保つ)。デザインの途中確認を入れる場合は、3方式すべてに同じ確認を入れ、盲検が崩れたと記録する。
5. **DEV-143 (実行の入口を作る) を始めてよいか。** prompt・ledger・画像の入口を変えるので、個別の承認が要る。
6. **Claude の実装の横はみ出しのほかに、修正のきっかけを足すか。** 既定案は、足さない (SP の所見・事実に無い文・比較の差は記録するだけ。今の report-only の約束どおり)。足す場合は、検査の信頼性 (SP は DEV-140 の誤検知2件・既知の限界3つ。事実に無い文は評価用の数え方で、既存の門ではない) を踏まえて決める。

## 11. 限界

- 1店舗・1〜2回の比較である。方式の差と、その回のぶれとを分けきれない。
- 盲検でも、方式の癖から見分けがつくことがある。オーナーは実行計画を承認して起動に立ち会うので、何が作られたかを知っている。これも盲検を弱める。
- 参考資料は揃えるが、Claude のスキルと Codex の prompt では渡し方が違い、完全には揃わない。
- LAYOUT_FIRST と DIRECTION_FIRST には、デザインの原本が無い。実装の忠実度は VISUAL_FIRST でしか比べられない。
- 検査の閾値と構造の語彙は、どれも仮のものである (Issue #159)。

## 12. 模擬の通し実行の結果 (DEV-142、MOCK)

**MOCK。これは手順・引き渡し・検査・記録の通しの確かめだけで、方式の優劣の証拠にしない。** Codex・画像生成・ネットワーク・有料 API は呼んでいない。Codex の出力は、手で書いた fixture (`design-library/research/three-methods/mock/`) を偽の port が返したもの。素材 A1 は、テストのコードが作った単色の PNG。3方式の fixture は同じ1人が書いたので、見た目の差も方式の差ではない。

- テスト: `tests/unit/design-agent/research/three-methods-mock.test.ts` (補助は同じ場所の `three-methods-mock.ts`)。PC1440/SP390 の画像と `three_method_run_v0` の記録 (`run_kind: "mock"`、Codex の呼び出しは `outcome: "mock"`・`approval_id: null`) を一時ディレクトリに書く。残すときは空のディレクトリを `THREE_METHODS_MOCK_OUT` に渡す。
- 通った道筋:
  - VISUAL_FIRST (V-B): 偽の DesignPort → 実際の Phase 2f の runner (Route B) → `render_pair_complete` → `intakeArtifact` → `prepareImplementationLane` (lane は `artifact.json` と PC/SP の原本だけ。試作の HTML/CSS は入らない) → 試作と別に書いた実装 → `compareImplementation`。
  - LAYOUT_FIRST: Claude の構図 + MOCK の素材1枚 → `renderPrototype`。1回目は SP で横にはみ出す (fixture にわざと入れた)。修正のきっかけはこれだけで、2回目 (手で書いた修正) で通った。
  - DIRECTION_FIRST: 方向の文書 (DNA の8観点、MOCK) → Claude の構図 + MOCK の素材1枚 → `renderPrototype`。
- 共通の検査は既存の道具だけを使った: `checkPrototype`、`renderPrototype` の `mobileQuality` (`measureMobileQuality`)、`observeStructure` (実際の参照の集合 `structure-descriptors-v0.json`)、`auditPageText`、`renderPrototype` の `scrollWidth`。事実に無い文は、design-director の評価と同じ数え方で、テストの中で数えた (品質検査として登録していない)。
- 修正のきっかけの約束 (§4) も、模擬で確かめた:
  - はみ出し続ける実装は、`LIMITS` (3回・原因ごとに2回) で止まる。
  - 別の店の名前が出た実装は、はみ出していても修正せずに止まる (Identity が PASS でない)。
  - Codex のデザインのはみ出しは修正しない。runner が `PROTOTYPE_HORIZONTAL_OVERFLOW` を記録して incomplete になり、lane が引き渡しを断る。

この container での1回の値 (MOCK。描画の環境で変わりうる):

| | VISUAL_FIRST (V-B) | LAYOUT_FIRST | DIRECTION_FIRST |
|---|---|---|---|
| 修正の回数 (`repair_attempts`) | 0 | 1 (1回目の SP 390 の scrollWidth 1200 → 2回目 390) | 0 |
| 最後の実装のはみ出し (scrollWidth PC / SP) | 1440 / 390 (なし) | 1440 / 390 (なし) | 1440 / 390 (なし) |
| SP の所見 (`measureMobileQuality`) | なし | なし | なし |
| Identity | PASS_IDENTITY_ONLY | PASS_IDENTITY_ONLY | PASS_IDENTITY_ONLY |
| 事実に無い文 (行) | 0 | 0 | 0 |
| 構造の観察 (汎用 LP の印 / 不採用例との近さ) | なし / なし | なし / PC で CP-025-v1 | なし / なし |
| impl-compare | compared。差は PC_PAGE_LAYOUT・PC_SECTION_COLOUR_STORY・SP_PAGE_LAYOUT (page SSIM 0.78 / 0.759、仮の閾値 0.8)。記録だけ | 対象外 (原本が無い) | 対象外 (原本が無い) |
| Codex の呼び出し (すべて `mock`) | design 1 | asset 1 | direction 1・asset 1 |

- 構造の観察の「不採用例との近さ」は参考だけで、順位付けに使わない (§5)。impl-compare の差は、模擬の実装と模擬の試作の差であり、Claude の実装の忠実度を示さない。
- 模擬で分かった、実行の前に要ること (どれも DEV-143 の範囲): runner の v1 prompt は DNA のあるブリーフを必須とする (模擬は `mock/runner-brief.json` で通した)。方向の呼び出しと、Claude が書いた素材の要求を受け付ける画像の入口は無い (記録では prompt の SHA を `null` にした)。intake は `approval_id` などの生成の事実を要るので、偽の port は形だけの値 (`mock-not-an-approval-dev142`) を返した。研究の記録の `approval_id` は `null` のまま。
