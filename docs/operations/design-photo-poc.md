# DEV-029 写真 PoC（実機・実 Codex）

写真込みのデザインを、本物の worker（jail の中の `sr-designgen`、ChatGPT サインインの Codex、bubblewrap の sandbox）で 1 回通して、
所要時間・lineage・cleanup を確かめる。対象は local `/design-preview` だけ（公開 `/demo`・DB・Storage・Routine には何も出ない）。

- job は架空のパン屋（`POC SAMPLE BAKERY`、facts は `photo-poc.sh` に固定）。実店舗の facts・名称・URL・Instagram は使わない。
- reference は `https://example.com/`（IANA の文書用ドメイン。店舗ではない）。公式サイトの capture 経路をそのまま通るが、写真 asset にはならない。
- 写真は `generated_concept`（人が作って入れた画像、`generation.method: human_upload`）だけ。worker・Codex は画像を作らない。外部の画像生成 API は使わない。
- job id は `poc-photo-<n>`。同じ id は 2 回走らない（intake が既存の写真で、preflight が queue・結果の存在で止める）。

実行前に実機 resource preflight（`docs/operations/wsl-resource-preflight.md`）を行う。`photo-poc.sh` も最初に同じ確認をし、`STOP` なら何も始めない。
PoC は `next build` と Chromium と Codex を含むので、full unit suite など他の重い処理と同時に流さない。

## 人がやること（これだけ）

### 1. 画像を用意する（1 枚。stress PoC では 3 枚）

条件（`human_upload` の意味: あなたが作り、あなたが入れたもの）:

- 人物が写っていない（手・顔・人影も含めない）
- 実在の店舗・商品・看板・ロゴ・店名・文字が写っていない（架空のパンや焼き菓子、木の台、布などの静物）
- reference（Instagram・公式サイト）の screenshot や、その切り抜きではない
- PNG / JPEG / WebP、各辺 320〜2400 px、15 MB 以下
- 1 枚目は縦長（hero 向け）。3 枚のときは 2 枚目を横長、3 枚目を正方形にし、互いに違う構図にする（似すぎると near duplicate で使われない）

### 2. 1 コマンドで流す（timer が動いていれば止めて戻す、画像を worker の場所に置く、jail の中で PoC）

```bash
sudo bash -c '
A=/root/sr-capture-admin/scripts/sales-design-capture/admin.sh; J=poc-photo-001
F=<画像のパス 例 /mnt/c/Users/<you>/Desktop/poc-photo-001.png>
T=$(date -r "$F" --iso-8601=seconds) || exit 1     # 画像を作った日時（ファイルの更新時刻）
# develop の worker が先にこの job を取らないように。動いていたときだけ止めて、最後に戻す
W=$(systemctl is-active sr-design-worker.timer 2>/dev/null); [ "$W" = active ] && systemctl stop sr-design-worker.timer
# 画像を worker 利用者の入力場所へ（ディレクトリも sr-designgen のもの。facts.json もここに書かれる）
install -d -o sr-designgen -g sr-designgen -m 700 /home/sr-designgen/sr-design-input /home/sr-designgen/sr-design-input/$J &&
install -o sr-designgen -g sr-designgen -m 600 "$F" /home/sr-designgen/sr-design-input/$J/concept-1.png &&
# jail の中で: checkout → facts → intake → preflight → enqueue → run.sh → report
bash $A run sr-designgen -- /bin/bash -lc "cd ~/work/second-root && git fetch -q origin feature/dev-029-photo-art-direction && git checkout -q --force --detach origin/feature/dev-029-photo-art-direction && ./scripts/sales-design-worker/photo-poc.sh --job-id $J --created-by <あなたの handle> --created-at $T --image ~/sr-design-input/$J/concept-1.png"
[ "$W" = active ] && systemctl start sr-design-worker.timer; true'
```

最後に出る JSON（`~/sr-design-poc/poc-photo-001.json`、`sr-designgen` の home）を Claude に渡す。
中身は符号・数・ミリ秒だけ（prompt、Codex の文章、path、店舗の情報は入らない）。

`photo-poc.sh` が途中で止まったとき（`POC_NOT_READY` など）は、表示された符号を Claude に渡す。job id は使い回さず、次は `poc-photo-002`。

## 3 枚 stress PoC

1 枚 PoC の report で次がすべて満たされたときだけ、`J=poc-photo-003`、画像 3 枚（`--image` を 3 回）で同じ手順を流す。

- `outcome: done`、`lineage_ok: true`、`cleanup_ok: true`
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
