# 承認シート — 画像生成の無人実行（real Codex）を ON にする（DEV-186・DEV-187）

**状態: OFF（未承認）。** このシートは、オーナーが後で ON を決めるための1枚。ここに書いたことは承認されるまで何も起こさない。

## 何が動くか

既存の design worker（`run.sh` → `worker.ts`、jail の中の `sr-designgen`）が、1回の実行で最大1件の「承認済みデモ画像生成ジョブ」を処理する（`scripts/sales-design-worker/image-autorun.ts`）。1件 = real Codex 1回・画像呼び出し最大6回・15分、その後に取り込み・d1-v10 差し替え・PC/SP 描画。画像はリポジトリの外（`~/.local/share/second-root-design/image-autorun/<job_id>/`）に残り、Git・公開には出ない。

**1回限りの使用は root が確定する（DEV-187）。** root の `cycle.sh`（`sr-design-cycle.service`）が、その回の worker 実行の直前に:

1. スイッチ（上の root 所有ファイル）を root 自身が読む。inbox の最初のジョブは **worker の利用者として**だけ読む（`runuser`、link を辿らない、16KiB まで）。
2. ジョブとエントリ（`job_id`・承認 ID・scope・期限が未来かつ24時間以内）が合えば、root の state（`/var/lib/sr-design-cycle/`、0700）に `image-approval-used/<承認ID>` と `image-job-used/<job_id>` を atomic に作る。**どちらかが既にあれば発行しない**（`IMAGE_GRANT_APPROVAL_USED` / `IMAGE_GRANT_JOB_USED`）。
3. その後でだけ、grant（`/var/cache/sr-design-image-grant/grant.json`、root の 0644、置き場所は root の 0755）を書く。中身は承認 ID・job_id・ジョブのバイト列の SHA256・発行時刻・その worker 実行の終わりまでの期限。
4. worker の hook は、ほかのすべての確認に加えてこの grant を確かめる（root 所有・link でない・書き込み不可・ID と SHA256 の一致・期限内）。無ければ `REFUSED_NO_GRANT` で Codex を呼ばない。
5. grant はその worker 実行の直後と cycle の終了時（成功・失敗・中断のどれでも）に消える。**使用の印は消えない**。grant を出した回の cycle は `CYCLE_IMAGE_RUN` で終わる（その回は bridge の claim をしない）。

## オーナーが決めること（記入欄）

| 項目 | 上限・既定 | 決定 |
| --- | --- | --- |
| 対象店舗 | `tsugute` のみ（コードがほかを拒む） | |
| 承認 ID | 新規の ID（`tsugute-photos-20261106-01` は消費済みで常に拒否） | |
| 期限 `expires_at` | 依頼から最大24時間（それ以上は拒否） | |
| 最大ジョブ数 | 1承認につき1件（`max_jobs: 1` 固定）。エントリの `job_id` と同じ名前のジョブファイルだけが通る | |
| 最大画像数 | 6（`max_images ≤ 6`） | |
| 利用枠・費用 | ChatGPT サインインの Codex 画像の利用枠を1件あたり最大6回使う。新しい API キー・課金・契約は無い。枠切れは `CODEX_QUOTA` で止まり再試行しない | |

## ON の仕方（オーナーが WSL で sudo、Claude はしない）

```bash
sudo install -d -o root -g root -m 0755 /etc/sr-design-worker
sudo tee /etc/sr-design-worker/image-autorun.json >/dev/null <<'JSON'
{ "version": 1, "enabled": true,
  "approvals": [ { "approval_id": "<新しいID>", "job_id": "<ジョブのファイル名から .json を除いたもの>", "shop": "tsugute", "max_images": 6, "max_jobs": 1, "expires_at": "<ISO 8601>" } ] }
JSON
sudo chmod 0644 /etc/sr-design-worker/image-autorun.json
```

エントリの `expires_at` は**書く時点から最大24時間後**にする（それより先の期限のエントリは、ジョブの依頼時刻に関係なく拒否される）。

ジョブ（同じ承認 ID・同じ scope、ファイル名 = エントリの `job_id`）を `~sr-designgen/sr-design-jobs/image-autorun/inbox/<job_id>.json` に置くと、次の cycle の worker 実行で処理される（`sr-design-cycle.service` が動いていること。worker を手で動かしても grant が無いので生成しない）。

## 止める・失効

- **使用と失効は自動:** 実行の前に root が承認 ID と job_id を使用済みにする。実行後にオーナーがエントリを消す必要は**無い**（残っていても二度と grant は出ない。片付けとして消すのは自由）。期限を過ぎたエントリも grant にならない。
- **緊急停止スイッチ（全体）:** `enabled` を `false` にするか、ファイルを消す → root は grant を出さず、worker は以後のジョブを `HELD_AUTORUN_DISABLED` にする。
- 使用の印: root の `/var/lib/sr-design-cycle/image-approval-used/<id>`・`image-job-used/<job_id>`（worker からは消せない）と、worker の `~/.local/state/sr-design-worker/poc-approval-used/<id>`（多重の防御）。同じ ID・同じ job_id を再び使うには、**新しい承認 ID と新しい job_id** のエントリが要る。
- **失敗の後:** `~/.local/state/sr-design-worker/image-autorun/STOPPED` ができ、以後すべて `REFUSED_AFTER_FAILURE`。オーナーが原因を見てから手で消す。自動の再試行は無い。
- 実行中の停止は worker の service を止める（途中のジョブは次回 `FAILED_INTERRUPTED`、再開しない）。

## 残る限界（はっきり書く）

- worker の利用者（`sr-designgen`）は自分の `poc-approval-used`・`STOPPED`・queue を消せる。ただしそれでは grant は再発行されない（root の印が先に確定している）。テストで、その後の生成呼び出しが0回であることを確かめている。
- **`sr-designgen` として動くもの（jail の中の Claude を含む）は、このゲートの外で `codex` を直接、自分の `CODEX_HOME` で動かせる。** この gate は「承認済みジョブの経路」を1回に限るもので、その利用者が持つ Codex のサインインそのものを封じるものではない。
- grant の有効中（その worker 実行の間、最長約1時間）は、同じ job の同じバイト列について worker 側の別のプロセスも grant を読める。生成は hook 側の lock・処理中の印・worker の台帳で1回に限られるが、これらは worker 自身の state である。
- root の `cycle.sh` は、ジョブの中身を worker の利用者として読んだ値（job_id・承認 ID・SHA256・scope）でエントリと突き合わせる。worker が偽っても、通るのは root のエントリに書かれた1つの job_id・1つの承認 ID だけで、使用の印が1回で閉じる。

## 記録されること

`~/.local/state/sr-design-worker/image-autorun/audit.jsonl` と worker の出力に、判定ごとに1行: 時刻・コード・job_id・job の SHA256・承認 ID・店舗・画像枚数・呼び出し数・停止コード・出力の path。プロンプト本文・画像・秘密情報は書かない。結果は `image-autorun/{done,failed,held}/<job_id>.result.json`。

## 注意

- ON にしても本番能力（`APPROVED_CAPABILITIES=[]`）・本番 CSS gate・公開は変わらない。
- 画像ジョブは cycle の最初の worker 実行（idle run）で処理され、grant を出した回の cycle はそこで終わる（bridge の claim は次の回）。
