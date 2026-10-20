# DEV-029 写真 PoC（実機・実 Codex）

> **DEV-070（2026-10-20 人間決定）で前提が変わった。** 写真は `approved_real`（店舗が提供または利用を許可し、同意の記録があるもの）だけ。
> `generated_concept`（AI 生成などの「イメージ画像」）と「イメージ画像」ラベルは削除した。AI 生成・架空の店舗写真は使わない。
> poc-photo-001〜005 は削除前の `generated_concept` で行った記録（`.ai/reviews/DEV-029.md`）で、同じ手順ではもう流せない。
>
> **この PoC を流すには、使う写真そのものについて人の明示的な承認が先に要る**（未承認の画像利用は禁止。`.ai/proposals/design-agent-direction-2026-10-20.md` §8.6）。
> 承認が無いうちは、下の production preview の確認（写真は描画した fixture だけ）までしか行わない。

写真込みのデザインを、本物の worker（jail の中の `sr-designgen`、ChatGPT サインインの Codex、bubblewrap の sandbox）で 1 回通して、
所要時間・lineage・cleanup を確かめる。対象は local `/design-preview` だけ（公開 `/demo`・DB・Storage・Routine には何も出ない）。

- job は架空のパン屋（`POC SAMPLE BAKERY`、facts は `photo-poc.sh` に固定）。実店舗の facts・名称・URL・Instagram は使わない。
- reference は `https://example.com/`（IANA の文書用ドメイン。店舗ではない）。公式サイトの capture 経路をそのまま通るが、写真 asset にはならない。
- 写真は `approved_real` だけ。同意の記録（`--consent-id`・`--approved-by`・`--approved-at`）が要り、scope は `local_preview` だけで入れる（公開 demo には出さない）。
  preflight は全写真が `approved_real` で同意が `local_preview` を含むことを確かめる（`approved_for_local_preview`、満たさなければ `NOT_APPROVED_FOR_LOCAL_PREVIEW`）。
- worker・Codex は画像を作らない。画像生成 AI・外部の画像生成 API は使わない。
- Instagram・公式サイトの画像は、店舗の利用許可（同意の記録）が無ければ写真として入れない。reference screenshot は色・雰囲気の分析にだけ使われ、asset にはならない（intake が拒否する）。
- facts は架空のパン屋のまま。実店舗の写真をこの架空の頁に載せることが、その店舗の許可の範囲に入っていることを確かめる。
- job id は `poc-photo-<n>`。同じ id は 2 回走らない（intake が既存の写真で、preflight が queue・結果の存在で止める）。

実行前に実機 resource preflight（`docs/operations/wsl-resource-preflight.md`）を行う。`photo-poc.sh` も最初に同じ確認をし、`STOP` なら何も始めない。
PoC は `next build` と Chromium と Codex を含むので、full unit suite など他の重い処理と同時に流さない。

## PoC の前に: production preview の確認（`RENDER_OK` になるまで PoC を流さない）

worker と同じ経路（tsx・`next build`・preview server・asset route・Chromium・render check）で、写真付きの候補を 1 つ描く。
Codex は使わず、job も作らない。架空の一時 fixture だけを使い、終われば消す。

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc "cd ~/work/second-root && git fetch -q origin develop && git checkout -q --force --detach origin/develop && scripts/ops/wsl-resource-preflight.sh; npm run -s sales:design-worker -- preview-check"
```

- `RENDER_OK`（exit 0）: PoC に進んでよい
- `PREVIEW_CHECK_FAILED` / `RENDER_MISMATCH`（exit 1）: 表示された符号を Claude に渡す。PoC は流さない
- `RESOURCE_STOP`（exit 20）: 使えるメモリが 3 GiB 未満。`docs/operations/wsl-resource-preflight.md` に従う

## 人がやること（これだけ）

### 0. 写真ごとの承認を得る（これが無ければ流さない）

使う写真（1〜3 枚）そのものについて、PoC に使ってよいと人が明示的に承認していること。承認したら `--human-approval-confirmed` を付ける（付けなければ `photo-poc.sh` は何も始めずに止まる）。

### 1. 写真を用意する（1 枚。stress PoC では 3 枚）

条件:

- 店舗が提供した、または店舗が利用を許可した実写真で、その許可の記録（メール・フォームなど）がある。`--consent-id` はその記録を指す id（記録そのものではない）
- AI 生成・合成・架空の写真ではない
- 人物が写っていない（手・顔・人影も含めない）
- reference（Instagram・公式サイト）の screenshot や、その切り抜きではない（Instagram の写真を使うなら、その写真について店舗の許可がある元の画像を使う）
- PNG / JPEG / WebP、各辺 320〜2400 px、15 MB 以下
- 1 枚目は縦長（hero 向け）。3 枚のときは 2 枚目を横長、3 枚目を正方形にし、互いに違う構図にする（似すぎると near duplicate で使われない）

### 2. 1 コマンドで流す（timer が動いていれば止めて戻す、画像を worker の場所に置く、jail の中で PoC）

```bash
sudo bash -c '
A=/root/sr-capture-admin/scripts/sales-design-capture/admin.sh; J=poc-photo-006
F=<画像のパス 例 /mnt/c/Users/<you>/Desktop/photo-1.jpg>
C=<同意の記録の id>; T=<許可を得た日時 例 2026-10-20T09:00:00+09:00>
P=photo-1.${F##*.}     # 拡張子は元のまま（intake は拡張子と中身の一致を確かめる）
# develop の worker が先にこの job を取らないように。動いていたときだけ止めて、最後に戻す
W=$(systemctl is-active sr-design-worker.timer 2>/dev/null); [ "$W" = active ] && systemctl stop sr-design-worker.timer
# 画像を worker 利用者の入力場所へ（ディレクトリも sr-designgen のもの。facts.json もここに書かれる）
install -d -o sr-designgen -g sr-designgen -m 700 /home/sr-designgen/sr-design-input /home/sr-designgen/sr-design-input/$J &&
install -o sr-designgen -g sr-designgen -m 600 "$F" /home/sr-designgen/sr-design-input/$J/$P &&
# jail の中で: checkout → facts → intake → preflight → enqueue → run.sh → report
bash $A run sr-designgen -- /bin/bash -lc "cd ~/work/second-root && git fetch -q origin develop && git checkout -q --force --detach origin/develop && ./scripts/sales-design-worker/photo-poc.sh --job-id $J --consent-id $C --approved-by <あなたの handle> --approved-at $T --human-approval-confirmed --image ~/sr-design-input/$J/$P"
[ "$W" = active ] && systemctl start sr-design-worker.timer; true'
```

最後に出る JSON（`~/sr-design-poc/poc-photo-006.json`、`sr-designgen` の home）を Claude に渡す。
中身は符号・数・ミリ秒だけ（prompt、Codex の文章、path、店舗の情報は入らない）。

`photo-poc.sh` が途中で止まったとき（`POC_NOT_READY` など）は、表示された符号を Claude に渡す。job id は使い回さず、次は新しい番号（`poc-photo-007` など。001〜005 は使用済み）。

## 3 枚 stress PoC

1 枚 PoC の report で次がすべて満たされたときだけ、新しい job id、承認済みの写真 3 枚（`--image` を 3 回）で同じ手順を流す。

- `outcome: done`、`lineage_ok: true`、`cleanup_ok: true`（DEV-053: final の review が accept しなかった run は `outcome: blocked`・`codex.quality_not_accepted: true`。lineage・cleanup・見積りの確認には使えるが、デザインの品質は合格していない）
- `estimate.verdict: OK`（revision 2 の保守的な見積りが 50 分の 80 % 以内）
- `codex.notes` に `PHOTO_RENDER_MISMATCH` / `RENDERER_CHANGE_NEEDED` がない

## report の読み方

| 項目 | 意味 |
|---|---|
| `outcome` / `codex` | 結果、final の candidate、revision 数、review の点数・判定 |
| `photos` | 写真数、analysis（`done` / `reused` / 失敗の符号）、final の layout、種類ごとの Codex call 数 |
| `timing.call_list` | Codex の exec ごとの `stage`・`duration_ms`・`schema`・`result` |
| `timing.slowest` / `by_stage` | 一番遅い call、stage ごとの合計 |
| `total_ms` | job の開始から report までの時間（capture・build 後の preview を含む） |
| `estimate` | revision 0 / 1 / 2 の見積り（平均と、各 stage の最も遅い call による保守的な値）と、run の予算 50 分に対する判定 |
| `lineage` | `assets.json` → `photo-analyses.json` → 各 `*.images.json` を、今の store から検証した結果 |
| `cleanup` | worker の temp root、Codex の work dir、`photo-N.png` のコピー、design agent の Codex session log が残っていないこと（すべて 0） |

`timeout` / 50 分の予算は、実測を見るまで変えない。`estimate.verdict` が `AT_RISK` / `OVER` なら、変更せずに Claude が数字から案を出し、人が決める。

## 失敗して inbox に戻った PoC job の再開（人の承認の後だけ）

worker は job の途中の失敗を 1 回目は「やり直し」として inbox に戻す（ledger の attempts が 1 になる）。2 回目も失敗すると failed へ進む。
inbox に戻った job は、次に動いた `run.sh` が自動で拾う。そのため、承認前は `run.sh` を動かさない。

`photo-poc.sh` は使用済みの job id を止めるので、再開には使えない（intake も enqueue もやり直さない）。再開の手順は次のとおり。

1. 上の production preview の確認で `RENDER_OK` を確かめる
2. job がどこにあるかを確かめる（読むだけ）:
   `ls ~/sr-design-jobs/inbox ~/sr-design-jobs/processing ~/sr-design-jobs/done ~/sr-design-jobs/failed`
3. 承認されたら、jail の中で `scripts/ops/wsl-resource-preflight.sh` を実行し、次を流す:
   `./scripts/sales-design-worker/run.sh --max=1`（develop）
   その後 `npm run -s sales:design-worker -- poc-report --job-id <id>` を実行する
