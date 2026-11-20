# IMAGE_FIRST の非公開の結果返却 — private bundle・転送（偽物だけ）と、実在する経路の調査（Issue #302 P2）

2026-11-20。Issue #302 P2（オフライン、実サービスへの接続なし）。**これは承認ではない。** このコードは何も送らない。
実在の受け渡し先への接続・設定・課金は、それぞれ別のオーナー承認である。

- 追加したもの: `lib/design-agent/imagefirst-worker/bundle.ts`（検査・封入・検証）、`lib/design-agent/imagefirst-worker/transport.ts`
  （配送の状態機械・転送の interface・**偽の**転送と受け手）、`tests/unit/design-agent/imagefirst-worker/bundle.test.ts`
- 入力: 終わった run ディレクトリと worker の receipt（`cycle.ts` が書くもの）。`cycle.ts` と入口は**変更せず、import もしない**
  （テストで import の一覧を固定。Codex・画像ツール・子プロセス・ネットワークに届かない）。

## 1. bundle（1 承認 = 1 bundle、封入後は不変）

```
<bundles>/<承認 ID>/manifest.json   imagefirst_private_bundle_v1（ID・コミット・SHA・バイト数だけ。プロンプト文・パス・秘密なし）
<bundles>/<承認 ID>/SHA256SUMS      "<sha256>  <path>"（全ファイル、整列）
<bundles>/<承認 ID>/receipt.json    worker の receipt から run_dir（WSL の絶対パス）だけを "private_outside_repo" に置き換えたもの
<bundles>/<承認 ID>/parts/{pc-1,pc-2,sp-1..sp-4}.png
<bundles>/<承認 ID>/composites/{pc,sp}.png   （呼び手が SHA を渡したときだけ）
```

- **bundle の SHA = manifest.json のバイトの SHA-256。** manifest が全ファイルの SHA・バイト数と SHA256SUMS の SHA を持つので、1 つの
  ハッシュが全バイトを覆う。同じ承認 ID の 2 回目の封入は `BUNDLE_EXISTS`（上書きしない）。一時名で書いてから rename。0700 / 0600。
- 封入の前に: receipt が `succeeded`・`verified`・停止コードなし・PC 2 + SP 4・`stopped_images` が空、receipt の `run_dir` = 渡された
  run ディレクトリ（realpath）、run ディレクトリと receipt が自分の所有で group/other に閉じている。`parts/` と `composites/` に
  receipt（と渡された合成の SHA）に無いファイルがあれば `RUN_FILE_UNEXPECTED`、無ければ `RUN_FILE_MISSING`、link は `RUN_FILE_LINK`、
  receipt の名前が `parts/(pc|sp)-*.png` でない（`../`・絶対パス・別ディレクトリ）なら読む前に `RUN_FILE_OUTSIDE`。各ファイルは
  link を辿らずに**一度だけ**読み、そのバイトで SHA・サイズ・PNG（`design-image/png.ts` の `checkPng`、CRC まで）を検め、同じバイトを封入する。
- run ディレクトリの他のファイル（`prompts/`・`call.json`・`run-plan.json` など）は**入れない**。
- receipt の `run_dir`（ホームのパス）は bundle が機械の外へ出ても漏れないよう伏せる。他の欄（各 part の SHA を含む）は同じ。
  manifest は伏せた receipt の SHA（`receipt_sha256`）と、元の receipt のバイトの SHA（`receipt_original_sha256`）を持つ。
  後者は WSL 上の元の receipt とだけ照合できる（受け手は元のパスを知らないので照合できない）。画像との結び付きは part の SHA で保たれる。
- 合成画像は receipt に結び付いていない: 封入する側が渡した SHA に一致する、形の正しい PNG であることしか保証しない（送り手を信頼する前提）。
- 受け手の側で残る弱さ（既知・Low）: O_NOFOLLOW は最後の部分だけを守り、`parts/` を検査と open の間に link に替える攻撃は防がない
  （0700・自分の所有の木なので、同じユーザーの攻撃者に限る）。同じ job への `deliverBundle` の同時実行に lock は無い（job の書き込みは atomic）。
- 合成画像（PC/SP の完成カンプ）は既定ではディスクに無い（`image-first-check --run` がメモリで作り、SHA を出す）。書き出した場合だけ
  `composites/pc.png`・`composites/sp.png` に置き、その SHA を `composites` で渡す。SHA の無い合成ファイルは拒否。

### 上限（呼び手は下げることしかできない。上げると `LIMITS_RAISED`）

| 対象 | 上限 | 理由 |
|---|---|---|
| 各 part | 24 MiB、1 辺 512–8192 px、40 Mpx | run 自身の検査（`MOCKUP_PNG_LIMITS`）と同じ数字。run が通さないものを bundle が通さない。実際の画像ツールの出力は 1–4 MiB |
| 各合成 | 48 MiB、1 辺 256–16384 px、40 Mpx | 合成は PC 1440 幅 × 最大 16000 px（`COMP_COMPOSITE_OUT_OF_RANGE`）の縦長 |
| receipt | 256 KiB | 実物は数 KiB |
| manifest / SHA256SUMS | 64 KiB / 16 KiB | 9 ファイル分 |
| 合計 | 192 MiB | 各上限の和（約 240 MiB）より小さく、上限ぎりぎりのファイルを並べても通らない。実際の run は 10–40 MiB |

## 2. 配送の状態機械

`sealed →（deliver）→ delivering →（受け手が同じ bundle ID と SHA を確認）→ delivered`

- 失敗（転送の失敗・ack の喪失・違う SHA の ack・中断）は `sealed` に戻る。`delivering` のまま残った job（プロセスが落ちた）も
  読み込み時に `sealed` として扱う。**受け手の確認なしに `delivered` にしない。**
- 再送は**同じ封入済み bundle だけ**: 毎回ディスクから検証し直し、その SHA が登録時の SHA と違えば `BUNDLE_CHANGED` で何も送らない。
  再封入・再生成はしない（このモジュールは worker・入口・Codex に届かない）。試行は 5 回まで（`ATTEMPTS_EXHAUSTED`、それでも再生成しない）。
- 受け手は冪等: 同じ ID・同じ SHA = `duplicate`（何も置き換えない、同じ ack）。同じ ID・違うバイト = `BUNDLE_ID_CONFLICT`。
  受け手は**自分が期待する記録**（オーナーの承認: 承認 ID・plan ID・コミット）と、主張された bundle SHA、SHA256SUMS、サイズ、パス
  （`../`・重複・許可外の名前）、link・特殊ファイル、PNG の形、receipt と manifest の一致をすべて検め直す。
- 保持と取得（データだけ。実サービスは無い）: manifest に `access.retrieval_ttl_seconds = 900`（15 分の取得許可）と
  `retention.retain_days = 7`・`delete_after`。これらは**送り手の申告**で、検証は固定値と完全に一致すること（`created_at` + 7 日 =
  `delete_after`、余分な欄なし。不正・欠落・遠い日付は `BUNDLE_TERMS_INVALID`）だけ。**受け手はそれを使わない**: 取得トークンの期限
  （15 分）と削除の時刻（7 日）は、受け手が**自分の受け取り時刻と自分の定数**（`RECEIVER_TERMS`）から計算し、自分の記録
  （`<inbox>/.records/<ID>.json`）に残す。`purgeExpired` はその記録だけを読み、記録が無い・読めない bundle も消す（fail closed）。
- 受け手は書き込む前に各ファイルと合計のサイズを検める。同じ ID の同時受信は `duplicate` / `BUNDLE_ID_CONFLICT` になる。
  job の `attempts` が欠けている・不正（整数でない、負、5 超）なら job を読めないとして拒否し、呼び手は上限を上げられない。

## 3. 実在する非公開の受け渡し先の調査（読むだけ。何も設定・呼び出ししていない）

問い: **WSL の worker が認証つきで非公開にアップロードでき、かつオーナーの Claude チャットがそこから画像を読める**経路は、
リポジトリの中に検証済みのものがあるか。

| 候補 | リポジトリにあるもの | WSL から書けるか | チャットから画像を読めるか | 判定 |
|---|---|---|---|---|
| Supabase の private bucket `sales-demo-versions` | `supabase/config.toml`（ローカルだけ。`public = false`、1 ファイル 4MiB、MIME は `text/html`・`text/css`・`image/webp`・`image/jpeg`、anon/authenticated の policy なし = service role だけ）。読み書きは `lib/demo-version-package/import.ts`・`lib/demo-frame/serve.ts`（デモ版の配信用）。hosted の bucket は runbook で「承認が要る・未実施」 | **いいえ。** PNG は MIME で拒否、6 枚＋合成は 4MiB を超えうる。書けるのは server の service role だけで、WSL に service role の鍵を置かない方針（runbook B-5a）。用途もデモ版で、デザイン画像の受け渡しではない | **いいえ。** チャット用の読み取り経路・connector は無い | 未確認・未達 |
| Vercel | `scripts/staging/vercel-preview.mjs`・`lib/design-agent/bridge/vercel-bypass.ts`（Preview の保護を越える bypass 用のトークン読み） | 画像の保存先（Blob 等）は**リポジトリに無い**（`@vercel/blob` の依存なし） | いいえ | 未確認・未達 |
| bridge spool | `lib/design-agent/bridge/spool.ts`（`/srv/sr-design-bridge`、JSON だけ、1 ファイル 64 KiB / 結果 16 KiB、厳密な schema） | 画像は**運べない**（schema と上限を緩めない。Issue #302 の指定） | いいえ | 対象外 |
| GitHub（Issue 添付・PR・artifact） | — | **禁止**（画像・tar・プロンプトの push、公開 URL、誰でも読める artifact は代わりにしない） | — | 使わない |
| オーナーの PC のフォルダを Claude のセッションへ接続する機能（Claude アプリの Remote Control） | リポジトリには無い（製品の機能） | WSL の `~/sr-runs` を読ませる形になる。オーナーがアプリで設定し、フォルダを共有する必要があり、クラウドのセッションから使えるかはアカウント次第 | **未確認**（この作業では接続も一覧の取得もしていない） | 未確認・未達 |

**結論: 検証済みの、認証つき・非公開で、WSL から送れてチャットから画像を読める経路は、いまリポジトリに無い。「未確認・未達」。**
したがって P2 の完了条件「チャットから実際にプレビュー画像を読める」は**満たしていない**。現時点で実際に使える受け渡しは、
従来どおり WSL 上の private bundle（または tar + SHA256SUMS）をオーナーが手で取り出すことだけである。

各案に要るもの（どれも別承認。この PR では何もしない）:

1. **Supabase に IMAGE_FIRST 専用の private bucket を新設**: hosted の Storage 設定（新しい bucket・PNG の MIME・サイズ）、WSL 専用の
   書き込みだけの資格情報（service role を WSL に置かない設計が要る: 署名つきアップロード URL を発行する server の route など）、
   チャット側の読み取り経路。Storage の容量・転送の課金、DB/設定の変更 → **新サービス設定・課金・DB の承認**。
2. **Vercel Blob 等の新規ストレージ**: 新しい依存（package.json）、新しい契約・課金、トークンの保管 → **新サービス・課金・依存追加の承認**。
3. **Remote Control のフォルダ共有**: オーナーが自分の PC の Claude アプリで、`~/sr-runs` の bundle 置き場（リポジトリの外、0700）を
   共有する一回限りの操作。新サービス・課金は無いが、**オーナーの PC へのアクセスの許可**と、チャットのセッションで実際に画像が読めることの
   実地確認が要る。実地確認まで「未確認」のまま。
4. いずれの場合も、実際の送信を有効にする前に、受け手の検証（`verifyBundleDir` と期待する記録）を本物の受け手に入れ、偽の転送の
   テスト（このファイルの §2）と同じ fail-closed を確かめる。

> **Issue #302 P3 の追記（2026-11-20）**: 上の表の最後の行（Remote Control）について、新しいフォルダ共有は要らないことが分かった。
> jail の Claude は worker と同じ `sr-designgen` として動き、自分のホームが見えるので、`~/sr-runs/review-inbox/`（0700）に置いた bundle と
> プレビューを、権限を変えずに読める。ローカル inbox・プレビュー・ダミー PoC と、オーナーの確認手順は
> [`imagefirst-review-handoff.md`](imagefirst-review-handoff.md)。実機での確認はまだ（未確認）。ChatGPT 側は未達のまま。

## 4. 使い方（いまはオフラインのテストだけ）

```
npx vitest run tests/unit/design-agent/imagefirst-worker/bundle.test.ts
```

実機での封入（P3 の承認と、run が成功した後だけ）は、`packBundle({ runDir, receiptPath, bundlesDir: "~/sr-runs/bundles" の実パス })` を
呼ぶ小さな入口を足す形になる（この PR には入口を入れない。送信先が無いため）。bundle は `~/sr-runs` と同じくリポジトリの外、0700。
GitHub へは push しない。
