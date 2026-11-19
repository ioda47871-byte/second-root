# DEV-293 / PR #295 (IMAGE_FIRST オフライン受け渡し契約) — 独立 Fresh Review 記録

**最終判定: PASS**（Round 2、レビュー対象 `4d081f36c0a92c2b4d2f213dda2ad8131a49b03a`。Critical 0 / High 0 / Medium 0 / Low 8 = Round 1 の L1〜L6 と Round 2 の R2-L1・R2-L2）。

- Round 1（`4138bd9`）: PASS、C0/H0/M3/L6。M1〜M3 は `4d081f3` で修正。
- Round 2（`4d081f3`）: PASS、M1〜M3 の解消を確認。新しい Low 2件。
- レビュー後の差分はこの記録ファイルだけ。
- 未対応の Low（後続で扱う）: L1 `image_calls` の下限、L2 スクリーンショット幅の4値、L3 verdict と handoff の `parts` 共有、L4 `owner-evaluation.json` の読めない理由が AWAITING と同じ扱い、L5 `anon-N` の id 衝突、L6 `approval_packet_sha256` の照合なし、R2-L1 発行後の入力のメタデータ（run_id・枠など）の改変が未検出（コメントが検査より強い）、R2-L2 Hero を2枚に分けた申告。

以下はレビュアーの記録全文。

---

# Fresh Review — feature/dev293-image-first-contract (Issue #293 P1 IMAGE_FIRST オフライン受け渡し契約)

- レビュー対象 SHA: `4138bd92ddf51db41c43273742b20811c2ab67e8`
- 差分: `git diff 1f227a0...HEAD`(20 files, +2414 / -4)
- レビュアー: 独立 Fresh Reviewer(事前文脈なし、コードのみで判断。ソースは無変更)

## 判定: **PASS**(Critical 0 / High 0 / Medium 3 / Low 6)

READY_FOR_IMPLEMENTATION へ至る経路は `validateImageFirst` 内の1か所(validate.ts:368-371)だけで、
`rejects` が空・`ownerGate(...).pass`・両 composite 構築済み の3条件すべてが要る。owner 評価が無ければ
AWAITING(:143)、owner 評価の読み取り失敗も READY にはならない。SHA・寸法・バイト数・プロンプト SHA/文字数は
バイトから再計算している(validate.ts:246, 260-262)。adapter の `toImplCompareInput` は WeakMap(HANDOFFS)で
validateImageFirst 自身が作った READY オブジェクト以外を拒否し、JSON 往復した偽造 verdict も拒否される(テスト有)。
ownerGate は `evaluationVerdict`(≥22/25・各≥4・human_confirmed・real)をそのまま使い、閾値の変更なし。
Protected Scope(閾値・既存ゲート・impl-lane の `render_pair_complete` / `not_a_render`)の変更なし。
既存 isolation テストの変更は comp-impl / design-image-poc / impl-lane は**厳密パス**で追加。
identity-lock のみディレクトリ glob(M2)。capability.ts の変更は追加フィールドのみで、既存の集計値は不変。
モデル呼出・プロセス起動・ネットワーク・ファイル書き込みは image-first の lib / CLI に無い(isolation テストでも固定)。
fixture は合成画像と架空店舗のみで、バイナリのコミットは無い。

---

## Critical

なし。

## High

なし。

## Medium

### M1. `compareImageFirst` が手組み(偽造)の `ImageFirstImplInput` を無検査で受け付け、`png_sha256` を再計算しない
- 場所: `lib/design-agent/image-first/adapter.ts:88`(`compareImageFirst`)、`:94`(`composite_sha256: d.png_sha256`)
- シナリオ: `ImageFirstImplInput` はただの構造型で、`toImplCompareInput` を通さなくても
  `{ schema: "image_first_impl_input_v0", run_id: "<承認済み run>", record_sha256: "<承認済み manifest の SHA>", viewports: {...任意の png...} }`
  を組んで `compareImageFirst` に渡せる。報告書は承認済み run の `run_id` / `record_sha256` と、入力に書かれた
  `png_sha256`(実際に比較した `png` と無関係でもよい)を `design.composite_sha256` として出す。
  `passing` は常に false なので公開・承認には直結しないが、「READY の comp と比較した」という体裁の報告が
  未承認の画像で作れてしまい、「adapter は偽造を受け付けない」という契約が `toImplCompareInput` までしか届いていない。
  また `toImplCompareInput` は HANDOFFS 内の composite の `png` Buffer を参照のまま渡す(:47)ので、
  呼び出し側が `input.viewports.*.png` を書き換えると、同じ verdict からの次回の `toImplCompareInput` の出力も変わる。
- 修正案: (a) `compareImageFirst` が verdict を直接受け取り、内部で `handoffOf` を呼ぶ形にする。または
  `toImplCompareInput` が返したオブジェクトを WeakSet に登録し、`compareImageFirst` の先頭で照合する。
  (b) `design.composite_sha256` は `sha256(d.png)` を再計算して入れる(不一致なら `ImageFirstStop`)。
  (c) `png: Buffer.from(c.png)` でコピーを渡す。偽造入力が拒否されるテストを1本足す。

### M2. identity-lock の isolation テストを、厳密パスではなくディレクトリ glob で広げている
- 場所: `tests/unit/design-agent/identity/identity-lock.test.ts:197`(`":!tests/unit/design-agent/image-first/**"`)
- シナリオ: 方針は「isolation テストは厳密パスでのみ拡張し、緩めない」。同じファイルの既存の例外はすべて単一ファイル
  (他レーン分)で、今回の lib 側(`:!lib/design-agent/image-first/validate.ts`)も厳密パス。しかしテスト側は
  `image-first/**` で、今後このディレクトリに置くどのファイル(fixture や、本物のモジュールをつなぐ統合テスト)が
  identity-lock を import しても検出されない。現時点で identity-lock を名指しするのは
  `tests/unit/design-agent/image-first/isolation.test.ts` の1ファイルだけなので、glob にする理由も無い。
- 修正案: `":!tests/unit/design-agent/image-first/isolation.test.ts"` に置き換える。

### M3. PC の「Hero だけ」の機械判定が、正方形または縦長の1枚ではほぼ起きない
- 場所: `lib/design-agent/image-first/composition.ts:29`(`desktop_1440: { screen: 900, min: 1.5 }`)、`:130-133`
- シナリオ: PC の下限は 1440 幅で高さ 1350px(縦横比 0.9375)。画像ツールの通常の出力は 1024×1024(→1440×1440)と
  1024×1536(→1440×2160)なので、どちらの1枚でも `mode: "single"` で `COMP_HERO_ONLY(composite_height)` を通る。
  テスト(validate.test.ts:78-92)で落ちるのは横長 1152×768 の場合だけ。残る判定は、記録の自己申告(各セクションの box)と
  visual-read の `observed_section_ids` / `header_visible` / `footer_visible`(`assistant_visual` なら Claude の自己申告)
  だけになる。Hero 1枚に「全セクションがある」という read を付ければ、機械判定は AWAITING まで進む。
  owner の `image_first_hard_fails.hero_only` が最後の砦になっているので READY へ直接は抜けないが、
  「hero-only は機械検査で拒否する」という要件(と docs §1 の表)と比べると機械側の守りが弱い。
- 修正案: PC にも最低枚数(例: `section_sequence` で2枚以上、または合成の高さ ≥ 2 画面)を課す。
  あるいは、1枚の PC で宣言できるセクション数に上限を設ける。それをしない場合は、docs §2/§4 に
  「PC 1枚の正方形・縦長は高さ判定を通る。Hero だけかどうかは read とオーナーが見る」と限界を明記する。
  暫定の閾値として残すなら、正方形 1024 の1枚が通ることを固定するテストを置き、意図して残していることを示す。

## Low

### L1. `image_calls` の下限を見ていない
- 場所: `lib/design-agent/image-first/validate.ts:126-128`
- `image_calls > totalParts` と `image_completed !== totalParts` は見ているが、`image_calls = 0` や
  `image_calls < image_completed` という矛盾した記録も通る。失敗が1件でもあれば拒否する前提なので、
  `image_calls !== totalParts`(または `image_calls !== image_completed + image_failed`)で
  `CODEX_IMAGE_COUNT_MISMATCH` にするのが自然。

### L2. HTML スクリーンショット判定の幅は 1440/390/2880/780 の4値だけ
- 場所: `validate.ts:88`, `:239`
- 1280 / 1366 / 1920 幅の撮影や DPR 1.5(2160 / 585)はこの判定を通り、残りは `rendered_from`(自己申告)と
  read の `looks_like_browser_screenshot` だけになる。docs §4 の「検査できないこと」に「幅の特徴だけで守る」とあるが、
  対象が4値だけであることも書き添えるとよい。

### L3. verdict と handoff が可変の参照を共有している
- 場所: `validate.ts:359`(`parts: composites[v].parts` が HANDOFFS 内の CompositeView と同じ配列)、`adapter.ts:47`(M1 の png)
- `verdict.composites.desktop_1440.parts[0].scale = 9` のような変更が、あとで `toImplCompareInput` が出す `parts` に
  そのまま出る。コピー(`parts.map((p) => ({ ...p }))`)で切り離す。

### L4. `owner-evaluation.json` が symlink・1MiB 超・読めない場合、「評価なし」と同じ扱いになる
- 場所: `lib/design-agent/image-first/builder.ts:33-35, 56`、`validate.ts:363`
- `readInside` が null を返すと `ownerEvaluation: undefined` になり、AWAITING になる。READY へは抜けないので
  fail-open ではないが、改ざんの兆候(リンクへのすり替え)が「未評価」に見えてしまう。存在するのに読めない場合は
  `UNPARSEABLE` 扱い(→ `COMP_NOT_OWNER_APPROVED: EVAL_INVALID`)にすると区別できる。
  visual-read / identity は "missing" で拒否されるので、そちらは問題ない。

### L5. capability.ts: 実 id が `anon-N` の呼び出しと匿名の呼び出しが同じキーになる
- 場所: `lib/design-agent/design-image/capability.ts:691`(既存)、`:883`(追加)
- ログ上の id がたまたま `anon-0` だと、匿名呼び出しと同じキーで合算される(これは既存の挙動)。今回の追加で、
  `anonymousKeys` に入ったその実 id は `image_call_ids` から消える。実害は小さいが、匿名キーを id の形
  (`IMAGE_CALL_ID`)に合わない文字列(例: `\u0000anon-0`)にすれば衝突しない。既存の集計値は変わらない。

### L6. `approval_packet_sha256` は「あるかどうか」しか見ていない
- 場所: `validate.ts:192`
- 何とも照合していない(P2 の承認パケットの実体は無い)。docs §7 で P2 と書いているので意図どおりだが、
  docs §4 の `COMP_GENERATION_UNAPPROVED` の行に「SHA は存在の確認のみ(照合は P2)」と書いておくと誤読を防げる。

---

## 確認した点(問題なし)

- READY の条件: 機械の reject が0件 かつ owner gate 合格 かつ PC/SP 両方の composite がある場合のみ(validate.ts:368)。
  owner 評価が無ければ AWAITING。テスト validate.test.ts:24-45 で固定。
- ownerGate: run_id・manifest バイトの SHA・`compSetSha256`・`evaluation.comp_sha256` の4点に結び付けている。
  `evaluationVerdict` をそのまま使う(閾値の再実装なし)。合計の不一致・確認者の欠落も拒否する。
- SHA の再計算: パーツは `sha256(bytes)` と `checkPng` の寸法・バイト長で照合する。プロンプトは SHA と文字数、
  facts pack と direction は SHA。記録の値は信用していない。
- パス: 記録の `file` / `prompt_file` は `parts/…png` / `prompts/…txt` の正規表現に限られ、`readInside` が
  realpath の一致でリンクを拒否する。CLI は realpath した run dir と、解決前のパスの両方で `RUN_DIR_IN_REPO` を判定する。
  リポジトリ内を指す symlink 経由も拒否される。実装 assets の名前は正規表現で絞り、assets dir が symlink なら unreadable。
- 宣言済みの reject code が実際に出るか: COMPOSITE_OUT_OF_RANGE(512×8192)、PART_UNDECODABLE(16bit グレー)、
  SEAM_BROKEN を含め、REJECT_CODES はすべて到達可能でテストがある。docs §4 の表とコードは一致している。
- SP = PC の縮小: 同一バイト、ページ全体の縦横比と SSIM、パーツ単位の縦横比と SSIM の3段で見ている。SP の高さ下限
  (≥ 1688px @390)と組み合わさるので、PC を縮めただけの SP はそもそも高さ不足か、ページ全体の判定で落ちる。
- capability.ts: `calls` には画像呼び出ししか入らない(function_call の imagegen / image_generation_call / end 記録)。
  追加は `image_call_ids` の算出だけで、既存のフィールドの値は変わらない。diagnostics の要約行にも出さない。
- isolation: comp-impl / design-image-poc / impl-lane/handoff は厳密パスでの追加で、import 名まで固定している。
  image-first/isolation.test.ts で、ネットワーク・プロセス・書き込みの API が無いことと、CLI がどこからも起動されないことを固定。
- fixture: 架空店舗(`fictional-test-lamp`)、メモリ上で描いた単色の合成画像、OS の temp dir。実店舗の画像や非公開画像は無い。

## 実行したコマンドと結果

```
git rev-parse HEAD
  → 4138bd92ddf51db41c43273742b20811c2ab67e8
git diff --stat 1f227a0...HEAD
  → 20 files changed, 2414 insertions(+), 4 deletions(-)
npx vitest run tests/unit/design-agent/image-first tests/unit/design-agent/impl-lane \
  tests/unit/design-agent/comp-impl/isolation.test.ts tests/unit/design-agent/identity \
  tests/unit/design-agent/design-image-poc.test.ts
  → Test Files 9 passed (9), Tests 193 passed (193), exit 0
npm run typecheck   (next typegen && tsc --noEmit)
  → exit 0
git status --short
  → 空(作業ツリーは無変更)
```

---

# Round 2 — Medium 修正の再レビュー

- レビュー対象 SHA: `4d081f36c0a92c2b4d2f213dda2ad8131a49b03a`(差分 `git diff 4138bd9..4d081f3`、7 files, +71 / -9)
- 判定: **PASS**(Critical 0 / High 0 / Medium 0 / 新規 Low 2。Round 1 の L1〜L6 は今回の範囲外として未対応のまま)

## Round 1 の Medium の確認

### M1 → 解消
- `adapter.ts`: `toImplCompareInput` が composite の Buffer を `Buffer.from` でコピーし、発行した入力を
  WeakMap `ISSUED` に、発行時の composite SHA と一緒に登録する。
- `compareImageFirst` は、未発行の入力を `INPUT_NOT_ISSUED` で止める。発行済みの入力も、比較の前に png を
  もう一度コピーしてから SHA を計算し直す。発行時の SHA と違うか、`png_sha256` の欄が書き換えられていれば `INPUT_CHANGED` で止める。
  比較に使うのはそのコピー(`designs[v]`)で、報告の `composite_sha256` は発行時の値(`issued[v]`)。
  照合からコピーまでの間に入れ替えられる余地は無い(照合したコピーをそのまま使っている)。
- テスト(handoff.test.ts +22 行)で次を確かめている: structuredClone した入力、PC と SP の png の入れ替え、
  SHA 欄の書き換え、1バイトの改変、同じ verdict から発行した2つの入力が Buffer を共有しないこと。
- 残る点は R2-L1 を参照(png 以外の欄の改変は見ていない)。

### M2 → 解消
- `identity-lock.test.ts:197` が `":!tests/unit/design-agent/image-first/isolation.test.ts"` という厳密パスになった。
  identity-lock を名指しするファイルは、今もこの1本だけ(Round 1 で確認)。isolation テストはこれで緩んでいない。

### M3 → 解消(限界を docs に明記)
- `composition.ts`: `singleMinAspect: 1.6` を追加した。`compositeProblems` は、合成が1枚かつ高さ÷幅 ≤ 1.6 のとき
  `singleTooShort` を返し、`validate.ts:286` がそれを `COMP_HERO_ONLY(<vp>_single_picture_too_short)` にする。
  1024×1024 と 1024×1536 の1枚は、1440 に拡大しても拒否される。SP の1枚は、高さの下限(390 幅で 1688px、縦横比 4.33)が
  先に効くので影響しない。既存の閾値は変えておらず、拒否を増やす方向の変更だけ。
- `docs/design/image-first-handoff.md` §2 に、新しい規則と「それ以外の Hero だけは read とオーナー評価でしか防げない」
  という限界が追記された。
- テスト(validate.test.ts +12 行)は `compositeProblems` の単体テストで、validate を通した end-to-end ではない。
  validate.ts 側の追加は1行の対応付けなので、許容する。

## 新規の指摘

### R2-L1(Low)発行済みの入力の png 以外の欄は、改変されても検出されない
- 場所: `lib/design-agent/image-first/adapter.ts:110, 117-118, 131-132`
- `ISSUED` が覚えているのは composite の SHA だけ。発行後に `input.run_id` / `input.record_sha256` /
  `viewports[v].sections`(枠)/ `height` / `parts` を書き換えても、そのまま比較と報告に使われる。
  たとえば別の run の `run_id` を付けた報告や、偽の枠で比較した報告が作れる。`composite_sha256` は本物のままなので
  照合すれば矛盾は分かり、`passing` も常に false なので Low とする。ただし `ISSUED` のコメント
  「a hand-built or edited input is refused」は実際の検査より強いことを言っている。
- 修正案: 発行時に入力全体を `Object.freeze` で深く凍結する(Buffer は凍結できないので、今のコピー+SHA 照合を残す)。
  または、比較と報告で使う値を入力からではなく `ISSUED` に保存した控えから取る。

### R2-L2(Low)`singleTooShort` は「1枚」だけが対象で、Hero を2枚に分けると通る
- 場所: `lib/design-agent/image-first/composition.ts:140`
- 1024×1536 の Hero 1枚を 1024×768 の2枚に切り、`section_sequence` の2パーツとして申告すると、合成は 1440×2160 で
  高さの下限も `singleTooShort` も通る。ただし、それには呼び出し ID 2つ・承認・read を偽って申告する必要がある。
  docs の追記が「それ以外は read とオーナーが防ぐ」と限界を明記しているので、意図どおりの残りとして Low に留める。

## 回帰の確認
- 変更された行で、READY へ至る経路は変わっていない(validate.ts の READY 条件は無変更)。adapter の変更は拒否を増やす方向だけ。
- Protected Scope・既存の閾値・impl-lane 側には差分が無い。isolation の ALLOWED と import 名の固定も変わっていない。

## 実行したコマンドと結果(Round 2)
```
git rev-parse HEAD                     → 4d081f36c0a92c2b4d2f213dda2ad8131a49b03a
git diff --stat 4138bd9..4d081f3       → 7 files changed, 71 insertions(+), 9 deletions(-)
npx vitest run tests/unit/design-agent/image-first tests/unit/design-agent/impl-lane \
  tests/unit/design-agent/comp-impl/isolation.test.ts tests/unit/design-agent/identity \
  tests/unit/design-agent/design-image-poc.test.ts
                                       → Test Files 9 passed (9), Tests 195 passed (195), exit 0
npm run typecheck                      → exit 0
git status --short                     → 空(ソースは無変更)
```
