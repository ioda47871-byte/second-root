# ほし窯 d4 を 1 回だけ生成する — オーナー用の 1 回限りの実行シート（Issue #302）

> **状態: 承認済みパケットの実行手順（未実行）。** 承認: `docs/design/image-first-hoshigama-d4-packet.md`（PR #321、オーナーがマージ、
> merge `2ddba2ffeffc0e4fa8b45cf425951757307a62e6`）。承認 ID `hoshigama-imagefirst-d4-20261122-01`・計画 ID `hoshigama-imagefirst-p4-20261122`・
> 期限 `2026-11-23T03:00:00Z`。範囲は **Codex 1 回・画像最大 6 枚・15 分・再試行なし**。Issue #302 comment 7073311344 の指示で、Claude が
> 準備・確認・後処理を引き受け、**オーナーの操作をこのシートのブロック A〜D だけにした**。このシートは追加の承認ではない。

- 時間: **C（パイロット）を `2026-11-23T02:40:00Z`（日本時間 11/23 11:40）までに始める**（preflight は期限まで 20 分以上を要求）。
  余裕をみて **A を 02:15Z（11:15 JST）ごろまでに始める**（B と C の間でサインインし直すならさらに早く）。窓の始まりは `2026-11-22T03:00:00Z`。
  過ぎたら始めない（延長・流用・再試行はしない。新しいパケットの承認に戻る）。
- 決まり: 各ブロックは `( set -euo pipefail … )` の中で動き、門で止まると `STOP_*` を出してそのブロックを終える（端末は閉じない）。
  **`STOP_*`・`FAIL`・`error`・`fatal`・想定外の出力が 1 行でも出たら先へ進まず、ブロック D（戻す）だけを行い、Claude に「続きから」と伝える。**
- 境界（変えない）: `sr-designgen` が jail の外で動くのは、既存の preflight・pilot が内部で行う `setpriv` での権限の落とし（worker・Codex・claude）
  だけ。**その場の `runuser`・`su`・`sudo -u` はしない**。sudo を `sr-designgen` に与えない。Remote Control と同居してパイロットを動かさない
  （B で止める）。`admin.sh` と保護スクリプトを変えない。root の新しいコードは使わない（既存の preflight・pilot・`admin.sh` だけ）。
- **ブロック B で Remote Control（この Claude のセッション）が止まる。** Claude はその間なにもしない。D で戻してから新しいセッションで再開する。
- 秘密（トークン・`~/.codex`・`~/.claude` の中身）は表示しない。GitHub に貼ってよいのはパイロットの `share:` の行と最後の行だけ
  （`docs/operations/imagefirst-pilot.md` §4）。

## Claude が済ませたこと（オーナーの操作は不要）

| 確認 | 結果 |
|---|---|
| PR #321 のマージ・承認の値（冒頭と §10） | develop で「承認済み」、d4・上記の ID・計画 ID・期限（独立レビュー PASS、`readApprovalPacket` が受け付けることをテストで固定）。#321 の CI の再実行は success |
| 実行経路（PR #320） | d4 は d4 パケットだけで動き、d3 の ID・パケットでは動かない。worker・pilot・preflight は ID の方向性で行を選ぶ |
| §3 のピン | plan `0c3849b2…`・バッチ `993d938a…`・14408 字が `IMAGEFIRST_RUNS.d4` と一致 |
| 期限の窓 | 作成時点（2026-11-22T03:10Z ごろ）で窓の中 |
| 出力先 | `~sr-designgen/sr-runs` は `sr-designgen` の 0700。d4 の run・bundle・inbox はまだ無い（`no_prior_run` が通る見込み） |
| 使用済みの ID | 使用済みは d3 の `…-d3-20261121-01` だけ。d4 の ID はどこでも未使用 |

`EXPECTED_SHA` は、Claude が知らせる **その時点の develop の先端**（40 桁）。上の表の `2ddba2ff…`（パケットのマージ）ではない
（このシートの PR などで develop は進む）。A・B・C のどこかで develop が動いたら、ブロックが `STOP_DEVELOP_MOVED` で止まる。そのときは D で戻し、
Claude に新しい値を聞く。

## A. 管理用 clone を固定する（root。Remote Control はまだ動いていてよい）

```bash
( set -euo pipefail
EXPECTED_SHA=<Claude が知らせる 40 桁>
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo STOP_SHA_FORMAT; exit 1; }
sudo git -C /root/sr-capture-admin fetch -q origin
[ "$(sudo git -C /root/sr-capture-admin rev-parse origin/develop)" = "$EXPECTED_SHA" ] || { echo STOP_DEVELOP_MOVED; exit 1; }
sudo git -C /root/sr-capture-admin checkout -q --detach "$EXPECTED_SHA"
[ -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" ] || { echo STOP_ADMIN_CLONE_DIRTY; exit 1; }
echo "ADMIN_CLONE_OK $(sudo git -C /root/sr-capture-admin rev-parse HEAD)" )
```

## B. Remote Control を止め、develop が動いていないことを確かめ、worker の clone をそろえ、preflight を通す（root）

`EXPECTED_SHA` には A と同じ値を入れる。

```bash
( set -euo pipefail
EXPECTED_SHA=<A と同じ 40 桁>
rc=0; sudo bash /root/sr-capture-admin/scripts/ops/wsl-resource-preflight.sh || rc=$?
[ "$rc" = 0 ] || [ "$rc" = 10 ] || { echo "STOP_RESOURCE rc=$rc"; exit 1; }   # OK(0) / SERIAL(10) は進む。STOP(20) は止める
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop
sudo git -C /root/sr-capture-admin fetch -q origin
[ "$(sudo git -C /root/sr-capture-admin rev-parse HEAD)" = "$EXPECTED_SHA" ] || { echo STOP_ADMIN_CLONE_MOVED; exit 1; }
[ "$(sudo git -C /root/sr-capture-admin rev-parse origin/develop)" = "$EXPECTED_SHA" ] || { echo STOP_DEVELOP_MOVED; exit 1; }
sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot.sh --sync-clone
sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot-preflight.sh hoshigama-imagefirst-d4-20261122-01 | tee /root/d4-preflight.txt
grep -q "admin clone /root/sr-capture-admin at $EXPECTED_SHA" /root/d4-preflight.txt || { echo STOP_ADMIN_CLONE_SHA; exit 1; }
grep -qE "\| clone +\| PASS \|.*$EXPECTED_SHA" /root/d4-preflight.txt || { echo STOP_WORKER_CLONE_SHA; exit 1; }
echo "B_OK worker clone and admin clone at $EXPECTED_SHA" )
```

- **C へ進むのは、preflight の最後の行が `IMAGEFIRST_PILOT_PREFLIGHT PASS approval=hoshigama-imagefirst-d4-20261122-01 failed=0 exit=0` で、
  ブロックの最後に `B_OK …` が出たときだけ。** preflight が 1 行でも FAIL なら（終了コード 20 で表の後にブロックが止まる）**絶対に C を実行しない**
  （何も使っていない）。D で戻し、表をそのまま Claude に見せる。
- **サインインのし直し（runbook §1 手順 3。推奨）**: preflight はローカルの記録しか見られない。期限切れの Codex のサインインは claim の後に
  `CODEX_NOT_SIGNED_IN` になって承認 ID を使い切り、期限切れの claude.ai のサインインは監査の marker の後に失敗する。**し直さずに C へ進むなら、
  その危険を受け入れることになる。** 手順（B の後・C の前に、jail の中で。中身は表示しない）:
  1. `.env` が無いことを確かめる（Codex は引数より先に `.env` を読むため）:
     `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- test ! -e /home/sr-designgen/.codex/.env && echo NO_CODEX_DOTENV`
     — `NO_CODEX_DOTENV` が出なければ止めて D。
  2. Codex: `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- codex login --device-auth`
     （表示される URL とコードをブラウザで入力する。文書にある経路は `admin.sh shell` の中での同じコマンドで、こちらは端末なしの同じ jail。
     `admin.sh shell` が開けるならそちらでもよい）。
  3. claude.ai: Remote Control と同じサインインで、B で止める直前まで動いていた。古いと思う場合だけ `admin.sh shell` の中で `claude` にログインし直す。
  4. その後 B のブロックをもう一度実行し（`EXPECTED_SHA` は同じ）、`B_OK` を確かめる。

## C. パイロットを 1 回だけ実行する（root。2026-11-23T02:40Z まで）

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot.sh hoshigama-imagefirst-d4-20261122-01; echo "pilot exit=$?"
```

- 中で fetch と preflight をもう一度行い、develop が動いた・1 つでも FAIL なら何も始めない。
- 成功: 最後の行 `IMAGEFIRST_PILOT PILOT_DONE phase=after_claim approval=hoshigama-imagefirst-d4-20261122-01 exit=0`。
- **再実行しない。** 最後の行が `phase=after_claim` なら、終了コードが 1・2・41 のどれでも承認 ID は使われた可能性がある。新しいパケットが要る（パケット §9）。
  `phase=before_claim`（終了コード 40 など）なら何も使っていない。
- 途中で止めたいときは Ctrl-C を 1 回だけ押して待つ（receipt と停止の記録が残る）。

## D. 戻す（必ず行う。A〜C のどこで止まっても）

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start
```

- `CLAUDE_STARTED (jailed)` が出たら、Claude アプリで新しいセッションを開き「続きから」と伝える。C の出力のうち **`share:` の行と最後の行**
  （または FAIL の表・`STOP_*` の行）を一緒に貼る。`local-only:` の行・画像・トークンは貼らない。
- `HOST_UNSAFE` / `CLAUDE_NOT_STARTED` などで戻らないとき: `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh status` を見てから
  `claude-start` を 1 回だけやり直す。それでも戻らなければ、表示されたコードの行だけを書き留める（journal の中身は貼らない）。画像・記録は
  `~sr-designgen/sr-runs/` に残っているので、戻った後に Claude が照合する。

## Claude が引き受ける後処理（D の後、新しいセッションで）

1. `research.ts status` で再開し、`~/sr-runs/review-inbox/` の d4 の bundle・プレビュー 6 枚・receipt・監査を照合する（SHA・枚数・承認 ID・計画 ID・コミット）。
2. 研究ログに `intake hoshigama-imagefirst-d4-20261122-01 --shop hoshigama --direction d4 --iteration 1 --parent hoshigama-imagefirst-d3-20261121-01`。
3. 非公開のレビュー画面（private artifact）を作り、d3 との比較と監査の要点を添えて Claude アプリに出す。
4. 採否はオーナーが決める（「改善して」「成功例として保存」「不採用」）。画像・生の監査・秘密は GitHub に出さない。
