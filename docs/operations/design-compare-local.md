# DEV-073 3 店の比較（実機・実 Codex、local の架空の店）

> **人の明示的な承認が先に要る**（`.ai/blockers.md` HUMAN-017）。承認したら `--human-approval-confirmed` を付ける。
> 付けなければ `compare-local.sh` も `compare.ts` も何も始めずに止まる（`STOP: --human-approval-confirmed is missing`）。

根拠: `.ai/proposals/design-agent-direction-2026-10-20.md` §8 の 5（各段の比較項目）と 7（業種・ブランドの異なる 3 店で明確に違う Web サイトを生成できるか）、
`.ai/proposals/design-spec-stage1.md` §8-3・§9。

## 何をするか

repo の架空の 3 店（`scripts/sales-design-worker/compare/shops/*.json`）を、design worker と**同じ pipeline**に流して比べる。

| 店（key） | 業種 | category | 事実 |
|---|---|---|---|
| `wagashi` | 和菓子屋（架空菓庵） | baked_goods | 多い（説明・7 品・営業時間・定休日・アクセス・電話） |
| `coffee` | スペシャルティコーヒーのスタンド（EXAMPLE BREW STAND） | cafe | 中（短い説明・4 品・営業時間・定休日） |
| `patisserie` | ブーランジュリー兼パティスリー（Boulangerie Pâtisserie Exemple） | bakery | 少ない（住所・営業時間・2 品） |

名前・住所は実在しえない値（「テスト」「架空」、電話は 052-000-）。

mode:

- `design`（既定）: 店ごとに worker の `runJobPipeline`（`lib/design-agent/worker/run.ts`）を呼ぶ: Codex の brief → render → screenshot → Codex の review →
  最大 2 回の revision。prompt・output schema・timeout・strict → loose の schema の切り替え・品質ゲート（5 軸・accept・MAX_REVISIONS・QUALITY_NOT_ACCEPTED）は
  worker と同じコード。店ごとの時間の上限も worker の 1 job と同じ 50 分。加えて baseline も描く
- `baseline`: 店ごとに category default の profile から layout を除いたもの（Stage 1 の前の頁 = 今の頁）を同じ preview で描く。Codex は使わない
- `hand_written`: 人が書いた Stage 1 の spec（`compare/hand-written/*.json`）を描く。**Codex の生成ではない**（report・contact sheet に明記）。renderer の表現の幅を示す demo

**参照画像は使わない。** 写真 PoC の参照（`https://example.com/`）は local の fixture ではなく、架空の店には公式サイトも Instagram も無いため。
prompt は「店の参照画像は無い。事実と category からブランドを判断する」と言う（参照が 1 枚以上のときの prompt は変わらない）。
AI 生成の店舗写真・Instagram 画像は使わない（写真は無し）。

結果（`sr-designgen` の home の外に出ない。repo の外）:

```
~/sr-design-compare/<compare id>/
  runs/<compare id>-<key>/        design の run（worker と同じ形: facts.json・candidate-N.json・final.json・review の記録・shots/・
                                  before/after-*.png・report.json）
  runs/<compare id>-<key>-base/   baseline（default.json）
  runs/<compare id>-<key>-hand/   hand_written（final.json）
  （各 run に page-desktop.png・page-mobile.png = 比べた頁）
  compare-report.json / compare-report.md / contact-sheet.png
```

`runs/` は `/design-preview/<run id>` が読む形。見るには（jail の中、`sr-designgen`）:

```bash
cd ~/work/second-root && npm run build && SR_DESIGN_PREVIEW_ROOT=$HOME/sr-design-compare/cmp-001/runs npx next start --port 3100 --hostname 127.0.0.1
# http://127.0.0.1:3100/design-preview/cmp-001-wagashi?profile=final（baseline は …-wagashi-base?profile=default、Codex の前の頁は ?profile=none）
# 見終わったら Ctrl-C（または next start の PID を kill）
```

## しないこと

- DB・Supabase（Staging / Production）・bridge・Vercel・flag・cycle・timer・実営業の送信に触れない
- worker の queue（`~/sr-design-jobs`）・結果（`~/.local/share/second-root-design`）・ledger・asset store を読み書きしない（Codex の sandbox からも隠す）
- 公開 `/demo` には何も出ない（`/design-preview` は `SR_DESIGN_PREVIEW_ROOT` のある local の `next start` だけ）
- 実店舗の facts・名前・URL・Instagram・写真を使わない。renderer のコードを変えない。commit・push しない
- 同じ compare id を 2 回流さない（2 回目は `COMPARE_ID_USED` で止まる）
- worker の run（`run.sh`）と同時に動かない（`run.sh` と同じ `run.lock` を取る。取れなければ `STOP` で何もしない）

## 人がやること

### 0. 承認（HUMAN-017）

この compare id の実行について、人が明示的に承認していること。

### 1. 1 コマンドで流す（timer が動いていれば止めて戻す、jail の中で比較）

最初に baseline だけ（Codex なし、build と Chromium だけ。数分）で道具の動作を確かめ、その後に design を流す。

```bash
sudo bash -c '
A=/root/sr-capture-admin/scripts/sales-design-capture/admin.sh; C=cmp-001; M=design   # baseline だけなら M=baseline（id も別に: cmp-001-base など）
W=$(systemctl is-active sr-design-worker.timer 2>/dev/null); [ "$W" = active ] && systemctl stop sr-design-worker.timer
bash $A run sr-designgen -- /bin/bash -lc "cd ~/work/second-root && git fetch -q origin develop && git checkout -q --force --detach origin/develop && ./scripts/sales-design-worker/compare-local.sh --compare-id $C --mode $M --human-approval-confirmed"
[ "$W" = active ] && systemctl start sr-design-worker.timer; true'
```

`compare-local.sh` の手順（どれも失敗すれば止まる）: 承認の flag と引数 → 許可した環境変数だけで再起動（API key・token・DB の資格情報は渡らない）→
実機 resource preflight（`docs/operations/wsl-resource-preflight.md`、`STOP` なら何も始めない、exit 20）→ worker の run lock → `origin/develop` に checkout と
`npm ci`（lock が変わったときだけ）→ `compare.ts`（`next build` 1 回、`next start` 1 つ、Chromium、Codex）。

渡すもの: 最後に出る `~/sr-design-compare/cmp-001/compare-report.md`（と `.json`、`contact-sheet.png`）。中身は符号と数だけ（Codex の文章・rationale・
prompt・path は入らない）。途中で止まったら表示された符号を渡す。`Killed` / exit 137 / 124 のときは修正の前に OOM を確かめる（script が `--oom-check` を表示する）。

### 時間と費用の見込み

- build: 1 回（WSL で数分）。各頁の描画と safety の検査は数十秒
- Codex: 店ごとに brief 1 回 + review 1〜3 回が普通（second look・見えない修正のときの追加を含めた上限は review 6 回、1 店 7 回）。3 店で 6〜21 回。
  これまでの実測（DEV-046）は brief 約 30 秒・review 約 15 秒。参照画像が無いぶん 1 回の入力は worker の通常の job より小さい
  （brief は約 12,000 字 ≈ 3,000 token + 画像 2 枚、review は約 14,000 字 ≈ 3,500 token + 画像 2 枚。`compare-report` の `prompt_sizes` に実際の値）
- 上限: 1 店 50 分（worker と同じ。各 call の timeout は brief 15 分・review 10 分）、全体 3 時間（`SR_DESIGN_COMPARE_BUDGET_SECONDS`、design の既定 10800）。
  通常は全体で 15〜30 分の見込み
- 費用: Codex は ChatGPT のサインイン（plan の利用枠）で動く。API の従量課金は無い（API key は子 process に渡らない）。枠の消費は呼び出し回数と
  上の token 数に比例する

## report の読み方（`compare-report.md` / `.json`）

| 項目 | 意味 |
|---|---|
| 店ごと: 結果・判定・5 軸・total・round・revision | design の final candidate の最後の review（`done` = accept、`blocked` + `QUALITY_NOT_ACCEPTED` = gate で不合格）。total = 5 軸の和（generic は 6 − 点）、25 点満点 |
| Codex 呼び出し・時間 | `call_list`（stage・ミリ秒・schema・結果）。worker の `CallTimer` の値そのもの |
| prompt 字数（≈token） | 1 回ごとの prompt の字数と字数 / 4、添付画像の数。画像の token は別 |
| 選ばれた layout | 描かれた形（事実に対して normalize した後）: direction・first view・節（kind/variant/地）・type・書体。adjustments は normalize の固定の符号（`dropped:<kind>` など） |
| 店の間の違い | 3 店の頁の組ごとの構造の距離と画素の差。**ここが大きいほど「明確に違うサイト」** |
| baseline との違い | 各店の頁と、その店の今の頁（category default、layout なし）との違い = 実画面の変化 |
| baseline どうしの違い | 今の頁どうしの違い（参考: 店の間の違いがこれより大きくなっているか） |
| 安全の検査 | 1440 と 390 で: 欠けた事実の key（全事実が頁にあること）・お知らせ帯・footer の注記が見えること・横のはみ出し（px） |

構造の距離は 7 つの部分の平均（各 0〜1）: first view（同じ 0 / 違う 1）・節の順（kind の並びの編集距離 / 長い方の節数）・variant と地
（どちらかにしか無い kind も違うと数える）・direction・文字組（type の scale と見出し、display / body の書体・大文字・太さ・字間の 7 項目のうち違う割合）・hero
（layout・高さ・揃え）。0 = 同じ構造、1 = 全部違う。画素の差は 2px ごとに見て、色の差が平均 24（0〜255）を超える画素の割合（全体と最初の画面。
片方にしか無い行・列は違うと数える）。

`compare-report` を作り直すだけなら（Codex も build も無し）: `npx tsx scripts/sales-design-worker/compare-report.ts --compare-id cmp-001`。

## この container での確認（Codex なし）

- `tests/unit/design-agent/compare.test.tsx`: worker の test の fake Codex と Chromium で design / baseline / hand_written を流し、run dir・report・contact sheet・
  承認の flag が無いときの拒否（shell と TS）・Codex の文章が report に出ないことを確かめる
- 手書きの spec の demo（**Codex の生成ではない**）: `next build` + `start` の実画面で 3 店の hand_written と baseline を描いた contact sheet
  （DEV-073 の報告に path）
