# IMAGE_FIRST P3 承認パケット — 架空パン店 ほし窯 の全頁デザイン画像

2026-11-19 作成（Issue #293 P3 の準備）。**状態: 承認済み。**

承認の状態を表すのは、すぐ上の「状態」の行と §10 の表だけである。両方が「承認済み」になるまで、この文書は Codex の実呼び出し・画像生成・
課金・WSL 操作のどれも認めない。オーナーが §10 を記入し、上の状態の行を書き換え、その版の SHA-256 を確定するまで、何も実行しない。
入口はこの文書そのもの（承認コミットに入っている版）を読み、§10 に未記入の欄がある、どちらかの状態が「承認済み」でない、または §10 の値が
起動の引数と違えば、何も使わずに拒否する（`PACKET_NOT_APPROVED` / `PACKET_APPROVAL_MISMATCH`）。

- 経路: `IMAGE_FIRST`（出力 `MODEL_GENERATED_FULL_PAGE_COMP`、記録 `model_full_page_comp_v0`）。契約は
  [`image-first-handoff.md`](image-first-handoff.md)、方針は [`design-first-workflow-decision.md`](design-first-workflow-decision.md) の「2026-11-19 追補」。
- コード: プロンプト `lib/design-agent/image-first/prompt.ts`、ピン表示 `scripts/design-artifact/image-first-prompt.ts`、
  実呼び出しの段 `lib/design-agent/phase2f-live/full-page-call.ts`、オーナーが手で起動する入口 `scripts/design-artifact/image-first-generate.ts`。
- テスト: `tests/unit/design-agent/image-first/prompt.test.ts`、`tests/unit/design-agent/phase2f-live/full-page-call.test.ts`（スタブだけ。実呼び出しなし）。

## 1. 何のための呼び出しか

| 呼び出し | 目的 |
|---|---|
| 方向性 d1（`d1-kiln-clock`、時刻の軸）を 1 回 | 同じ店の facts から、Codex の画像ツールが **Web サイトの全頁デザイン画像**（PC 1440 と SP 390 の別々の設計）を先に描けるかを確かめ、オーナーが絵として評価する |
| 方向性 d3（`d3-flour-crust`、粉と焼き色の見開き）を 1 回（任意） | d1 と構図の違う 2 案目。オーナーが「1 案だけ」と決めた場合は行わない |

どちらも「1 承認 = 1 回の `codex exec` = 1 バッチで 6 枚」。写真素材の生成ではない。画像の文字は事実の根拠にしない。
画像から切り抜いた部分を Web の素材にしない。比較対象の Claude 直接制作版（LAYOUT_FIRST）は、画像を作る側には一切渡さない（§8）。

## 2. 枚数とセクションの並び（生成の前に宣言する）

画像ツールは大きさを指定できず、観測された出力は縦横比 1.5 まで（1024×1536、1254×1254、1448×1086、1536×1152）。
縦長 2:3 の 1 枚は、PC では 1440×2160 CSS px（2.4 画面）を覆うが、SP では 390×585（1 画面の 844 に届かない）しか覆わない。
そのため **PC 2 枚 + SP 4 枚 = 6 枚**にした（1 バッチの上限 `MAX_BATCH_IMAGES = 6` に収まる。PC 3 + SP 3 だと SP の合成が
3×585 = 1755px で、検査の下限 2 画面 = 1688px にほぼ余裕がない）。継ぎ目はすべて `section_break`（区画を途中で切らない）。

d1（`d1-kiln-clock`）

| 表示 | 画像 | 区画（上から。枠の高さに対する割合） |
|---|---|---|
| PC | pc-1 | hero 0–41% / fire 41–71% / open 71–100% |
| PC | pc-2 | names 0–33% / sellout 33–67% / visit 67–100% |
| SP | sp-1 | hero 0–100%（1画面目は hero だけ） |
| SP | sp-2 | fire 0–100% |
| SP | sp-3 | open 0–50% / names 50–100% |
| SP | sp-4 | sellout 0–50% / visit 50–100% |

d3（`d3-flour-crust`）

| 表示 | 画像 | 区画 |
|---|---|---|
| PC | pc-1 | name 0–41% / spread-flour 41–71% / spread-fire 71–100% |
| PC | pc-2 | spread-names 0–33% / hours 33–67% / visit 67–100% |
| SP | sp-1 | name 0–100% |
| SP | sp-2 | spread-flour 0–100% |
| SP | sp-3 | spread-fire 0–50% / spread-names 50–100% |
| SP | sp-4 | hours 0–50% / visit 50–100% |

区画の順は PC・SP とも方向性の順そのまま（SP の並べ替えは区画の中の組み方で行う。区画は落とさない）。

## 3. プロンプト（全文は次のコマンドで表示する。SHA-256 と文字数）

```
npx tsx scripts/design-artifact/image-first-prompt.ts --direction d1 --print-pin
npx tsx scripts/design-artifact/image-first-prompt.ts --direction d3 --print-pin
```

読むだけで、何も書かず、何も呼ばない。各画像のプロンプト全文・SHA・文字数、区画と枠、Codex が実際に読む
**バッチのプロンプト**（6 枚の全文を順に含む）とその SHA・文字数（台帳のピン）、計画全体の SHA を出す。
プロンプトは非公開の run ディレクトリに置く（リポジトリには SHA だけ）。

| | d1 | d3 |
|---|---|---|
| 計画 SHA（`--expected-plan-sha256`） | `3b7fd1605c1187ad5e8788dba02b561f324566c9f0488312272f79977682d611` | `a19b6896ffd50111df9ad7029f49ded5757999ddfb31943103a206f6a44072a8` |
| バッチ SHA（`--expected-prompt-sha256`） | `dff5edbfa82c8ec02192d3d9b7d2d0f1d2da728da867fb89636a84a2f10eab34` | `291475d9ae66b2308d147a7b56ae1a0c9c53822e44cd5425d60976513712e398` |
| バッチ文字数（`--expected-prompt-chars`） | 11943 | 12338 |
| 方向性オブジェクト SHA（direction.json） | `3c2a50de5ddd42d5f98e120553ebf82cc400b4319e1195b9d37d15b866e4c48b` | `91b4dcfca9a7df561bc2cbebb4c8720aa453f11ddfa030c60fd7a5737237bd23` |
| facts パック SHA | `d46adc81bee7b7096e47f57091d88df348ac37cf389d7cce071a76f634fcf715` | 同じ |
| 成功原理の記録 SHA（principles-v1.json） | `a7c9a3f467f46787520885edf67df692a23e4c37ac05934fcfabb67ea9c4bf6d` | 同じ |

各画像のプロンプト（SHA-256 / 文字数）:

| 画像 | d1 | d3 |
|---|---|---|
| pc-1 | `d7bc282896a0fd52822bd229c9a36052816d5c159b55d5c7ea4b65ad12371706` / 1840 | `558c6b31337fa5f44845262a21eec31f1f6d89a2cb5042603dfa5f37b2cefaa8` / 1950 |
| pc-2 | `7c076fafa7b9613893e0da1e2b52f745ec6874c346b6a60cddd5b2b54eee5ba8` / 1874 | `3740bff2ce108969bd823b6fbc6cc48422b8a637b4c05bb0debc3434fe89c5fb` / 1921 |
| sp-1 | `714dbeaf3bffdd034e3008ee5558767716f197d19221953aa86e6295c05c3659` / 1709 | `37947652b53b28adb464847766432a00ba3e5b552ecb514b4da2667bbec61f3e` / 1759 |
| sp-2 | `58f4068a9549aa8b2b347a4035425b4ae2de907d0d764142e7f1d84d092e9c8c` / 1695 | `064be06ce5367d7f6ffac2ca24171a11fcd4435b034f0241fbab8c4b159c0abf` / 1830 |
| sp-3 | `d78f827d1d17902ea8637847ea7aba6e704078e1eed341b17e9bec9614371f10` / 1885 | `0870dd112c3f87a033dadddd9c8417ee109bc0b3168389b1fdd1300599696c57` / 1908 |
| sp-4 | `d6ac53cb5100ce460f1900fd27ac21a83e1e0b412296c99b936515cbaac72529` / 1853 | `3f1eaba11e75a0f83b52734dcbd20ca04af96b2a7cbc50889edcae1794f46f65` / 1883 |

各プロンプトが必ず言うこと: Web サイトの平面のデザインカンプであり、写真・ポスター・端末の見本画像ではない／
表示（PC 1440 か SP 390。SP は PC の縮小でない別の設計）／全頁を何枚に分けた何枚目か、縦長 2:3 の枠／この画像の区画と枠の割合／
上下の隣の区画（継ぎ目のため）／方向性の考え・PC か SP の組み方・守る核／成功例から一般化した原則 5 つ（下）／
**書いてよい文字は facts の値そのものだけ**（区画ごとに決めた facts、ヘッダーのナビは「営業時間」「定休日」「所在地」「道順」「電話」）／
数字だけの目盛りや時刻のラベルを単独で書かない／価格・受賞・歴史や創業年・人物・評判・お客様の声・メニュー・予約・限定を作らない。

成功原理（`principles-v1.json` の P2〜P6 を一般化した文。プロンプトには事例の名前もレイアウトも入れない）と、出所の事例 ID:

| 原理 | 出所の事例 |
|---|---|
| P2 中心の考え1つが区画の順序と区切りを決める | CP-008, 009, 016, 017, 018, 019, 023, 032 |
| P3 下の区画も同じ世界の別の面、最後は来店の終点 | CP-009, 012, 027, 029, 030 |
| P4 区画ごとに地・文字・余白・密度を変え、主役を1つに絞る | CP-001, 002 |
| P5 文字・線・印で読む順番をつくる | CP-001, 002, 008, 009, 012, 018, 022 |
| P6 SP は PC の縮小でない別の設計 | CP-009, 016, 028 |

## 4. モデル・CLI・ツール（分かっていること／分かっていないこと）

- 呼び出し: WSL 上の Codex CLI の `codex exec`（jail 内、読み取り専用、ChatGPT サインインだけ、`.env` なし、画像機能を明示的に有効）。
  1 回の実行の中で画像ツール `image_gen.imagegen` を最大 6 回呼ぶ（`lib/design-agent/design-image/image-once.ts` の `generateImagesInOneRun`）。
- 画像モデル: CLI 0.159.0 のソースを読んだ限りでは `gpt-image-2`、`size: auto`、`quality: auto`、`background: opaque`。
  モデルが大きさを指定する手段はない（`docs/operations/imagegen-timeout-investigation.md` §2）。実行の記録には画像モデル名が出ないので、記録では「不明」（警告）とする。
- CLI の版: 2026-11-18 に使われたのは 0.169.0。**0.169.0 での大きさの振る舞い（縦長 2:3 を返すか）は未確認。**横長や正方形が返った場合、
  SP の合成が 2 画面に届かず `COMP_HERO_ONLY` で拒否される可能性がある（それも結果として記録する。作り直しはしない）。
- セッションのモデル（Codex の会話モデル）: 実行後にセッションのログから読む。事前には分からない。
- 1 回の実行で 6 枚がそろうか、指示どおりの順に保存されるかは**未確認**。順は保存時刻で決め、オーナー前の located read で区画を照合する。

## 5. 呼び出し回数と上限

| 項目 | 値 |
|---|---|
| 呼び出し | 方向性ごとに `codex exec` 1 回（その中で画像ツール最大 6 回）。d1 だけなら 1 回、d1 と d3 なら 2 回 |
| 台帳 | `phase2f-live` の台帳（種類 `full_page_comp`、経路 `image_first`）。1 計画あたり最初の呼び出し 4 回・再試行 2 回の上限は変えていないが、**この経路では再試行を使わない** |
| 時間 | 1 回 15 分まで（`LIVE_LIMITS.callTimeoutMs`）。計画全体で 2 時間まで（`planBudgetMs`）。過去の観測: 画像 1 枚の成功 約 33 秒、失敗 約 156 秒 |
| 金額 | **不明。**記録がない。ChatGPT のプランの利用枠と、別枠の `image_gen` の利用上限に対して消費される。金額の上限は数字で言えないので、上の回数と時間で上限を決める |

## 6. 実行する環境（オーナーが起動する）

1. オーナーの WSL。実行ユーザーは `sr-designgen`（Codex の ChatGPT サインイン済み）。bubblewrap の jail の中で Codex が動く（入口が準備する）。
2. 先に `scripts/ops/wsl-resource-preflight.sh` を実行し、`STOP` なら始めない。
3. リポジトリの clone は、承認したコミットそのもの（HEAD = origin/develop = 承認コミット、作業ツリーがきれい）。**このコードが develop に入るのは別の承認（独立レビューと CI の後）である。**
4. 出力は `~/sr-runs/<run>/`（親は実ディレクトリ、run は新規、mode 0700。リポジトリの中なら `RUN_DIR_IN_REPO` / `OUT_DIR_INSIDE_REPO` で拒否）。
5. 受け渡し: `tar` と `SHA256SUMS` でオーナーへ。**GitHub へは push しない**（画像・プロンプト・manifest のどれも）。

起動コマンド（承認後にだけ。値は §3 と §10）:

```
npx tsx scripts/design-artifact/image-first-generate.ts --direction d1 --out ~/sr-runs/<run> \
  --plan-id <§10 の計画 ID> --approval-id <§10 のその方向性の承認 ID> --approval-expires <§10 の期限> \
  --packet docs/design/image-first-hoshigama-p3-packet.md --expected-packet-sha256 <承認した版のこの文書の SHA-256> \
  --expected-prompt-sha256 <§3> --expected-prompt-chars <§3> --expected-plan-sha256 <§3> \
  --expected-commit <承認コミット> --human-approval-confirmed
```

承認コミットはこの文書に書かない（この文書はそのコミットの一部なので、書き入れると別のコミットになる）。コミットは
`--expected-commit` だけで渡し、入口が HEAD = origin/develop = `--expected-commit`（作業ツリーがきれい）を確かめる。

## 7. 停止条件（再試行しない）

次のどれでもその場で止まり、承認 ID は使用済みになる（同じ ID は二度と使えない）。続けるには新しい承認パケットと新しい承認 ID が要る。

- 承認の前（何も使わない）: `HUMAN_APPROVAL_REQUIRED`、`PLAN_PIN_MISMATCH`、`PACKET_PATH_NOT_ALLOWED`、`PACKET_PIN_MISMATCH`、`PACKET_NOT_APPROVED`、`PACKET_APPROVAL_MISMATCH`、`PROMPT_PIN_MISMATCH`、`COMMIT_PIN_MISMATCH`、
  `APPROVAL_ID_DIRECTION_MISMATCH`、`APPROVAL_EXPIRY_INVALID`、`APPROVAL_EXPIRED`、`APPROVAL_EXPIRY_TOO_FAR`、`RUN_DIR_IN_REPO`、`OUT_DIR_*`、`APPROVAL_ALREADY_USED`、`RUN_LIMIT_*`、`RUN_TIME_BUDGET`、preflight の停止（`CODEX_DOTENV_PRESENT`、サンドボックス不可）。
- 呼び出しの後: `CODEX_NO_IMAGE`、`CODEX_IMAGE_INVALID`、`CODEX_IMAGE_UNSUPPORTED_FORMAT`、`CODEX_QUOTA`、`CODEX_IMAGE_TOOL_FAILED`、`CODEX_TIMEOUT`、
  `CODEX_EXEC_FAILED`、`CODEX_NO_THREAD`、`CODEX_NOT_SIGNED_IN`、`CODEX_DOTENV_PRESENT`、`CODEX_RESULT_DISCARDED_DOTENV`、`CODEX_IMAGE_CALLS_EXCEEDED`、
  `CODEX_IMAGE_COUNT_MISMATCH`、`CODEX_SESSION_LOG_UNVERIFIED`、`CODEX_ABORTED`。6 枚そろわない・失敗した画像呼び出しが 1 つでもある場合も止まる。
  止まった実行は `call.json` に停止コードを残し、返ってきた画像は `stopped/` に置く（部品にはしない）。

## 8. d2 の除外（画像を作る側に見せない）

- プロンプトの入力は facts パック・選んだ方向性オブジェクト 1 つ（d1 か d3）・成功原理の記録の 3 つだけ。方向性セット全体・既存の comp・写真・
  写真スロット・忠実度の記録・以前の承認やプロンプトは読まない（読み込み先はテストで固定し、除外パスは読む前に拒否する）。
- プロンプトに入れてはならない語（`LINEAGE_TOKENS`。含まれたら計画ごと拒否 `PROMPT_LINEAGE_TOKEN`）: `hearth`、`d2`、`ph-mouth`、`ph-loaf`、`窯口`、`窯の床`、それに「石」の後ろでない `窯の口`（`LINEAGE_PATTERNS`）。
- **オーナーが決めること（モチーフの重なり）**: d1 の方向性そのものの文（方向性セットの d1 の欄）は、Hero に「石窯の口の線画」を描かせる。
  d2 の Hero も窯の口（の弧）である。d2 の文がプロンプトに入ることはないが、モチーフは重なる。この重なりを許すかどうかはオーナーが決める
  （許さない場合は d1 を承認せず、方向性の文の見直しを別に頼む）。d1 のプロンプトの文はこの準備では変えていない。
- 方向性のうち、他の案を名指す欄（checklist・references・not_used など）はプロンプトに入れない。facts の内部 ID（F10 など）も取り除く。

## 9. 実行の後

1. `image-first-check.ts --assemble <run>` で manifest を作り、run に保存する。
2. 各画像の located read（`visual-read.json`）と Identity Lock の監査（`identity.json`）を記録し、`--run` で `AWAITING_OWNER_EVALUATION` まで進むことを確かめる。
3. **オーナーが PC と SP の合成画像と各画像を見て採点する**（25 点の評価表。hard fail なし、合計 22 以上、各項目 4 以上）。
4. 合格して `READY_FOR_IMPLEMENTATION` になったときだけ、Claude が HTML/CSS で忠実実装する。不合格なら実装しない。

## 10. 承認欄（オーナーが記入する。**未記入 = 未承認**）

| 項目 | 値 |
|---|---|
| 状態（承認するなら `承認済み` と書く） | 承認済み |
| 承認する方向性（`d1` / `d3` / `d1,d3`） | d3 |
| d1 の承認 ID（1 回限り。d1 を承認しないなら `なし`。形式 `<店>-imagefirst-d1-<YYYYMMDD>-<NN>`） | なし |
| d3 の承認 ID（1 回限り。d3 を承認しないなら `なし`） | hoshigama-imagefirst-d3-20261121-01 |
| 期限（UTC、`YYYY-MM-DDTHH:MM:SSZ`。起動の時点から 24 時間以内） | 2026-11-22T03:00:00Z |
| 計画 ID | hoshigama-imagefirst-p3-20261121 |
| 承認日・承認者 | 2026-11-21 オーナー（Issue #302 の事前承認。d3 のみ・1回・6枚・15分・再試行なし。記入は Claude、オーナーが差分を確認してマージ） |

- 入口はこの表を読む。どれかの欄が「未記入」のまま、または状態が `承認済み` でなければ `PACKET_NOT_APPROVED`。起動の `--direction`・
  `--approval-id`・`--approval-expires`・`--plan-id` が表の値と一字でも違えば `PACKET_APPROVAL_MISMATCH`。どちらも何も使わない。
- 期限は実在する UTC の時刻を `Z` 付きで書く（`2026-02-31` のような日付や、時差付きの書き方は `APPROVAL_EXPIRY_INVALID`）。過ぎていれば
  `APPROVAL_EXPIRED`、起動の時点から 24 時間より先なら `APPROVAL_EXPIRY_TOO_FAR`。
- 承認コミットはこの表に書かない（§6 のとおり `--expected-commit` で渡す）。
- 承認するときは、表の「状態」と一緒に**冒頭の状態の行（`**状態: 未承認。**`）も** `**状態: 承認済み。**` に書き換える。冒頭（最初の `## ` 見出しより前）に
  「未承認」が残っている、または冒頭の状態と表の状態が食い違うと `PACKET_NOT_APPROVED`。`## 10.` の見出しはコードブロックの外に 1 つだけ置く
  （2 つあれば拒否。コードブロックの中の例は読まない）。
- 入口が受け付ける承認パケットはこの文書（`docs/design/image-first-hoshigama-p3-packet.md`）だけで、読むのは作業ツリーではなく
  `--expected-commit` のコミットに入っている版である（コミットのピンと作業ツリーの確認が通った後に `git show` で読む）。`--packet` に別のファイル
  （`tests/` の下のもの、写し、他の文書）を渡すと `PACKET_PATH_NOT_ALLOWED` で何も使わずに拒否する。
- 期限の 24 時間は**起動した時点から**数える（承認を書いた時点からではない）。遠い先の期限を書いたパケットは、その期限の 24 時間前から
  使えるようになる。承認から時間が空いたら、期限を書き直して新しい版として承認し直す。

使用済みの承認 ID（以前の写真生成・phase2f・DEV-185 のもの）は使わない。PR #300 の d3 承認（期限 2026-11-21T03:00:00Z）は
マージせず、延長も再利用もしない（この版は新しい ID・計画 ID・期限で承認し直したもの。Issue #302）。
