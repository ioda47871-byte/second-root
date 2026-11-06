# 承認シート — 画像生成の無人実行（real Codex）を ON にする（DEV-186）

**状態: OFF（未承認）。** このシートは、オーナーが後で ON を決めるための1枚。ここに書いたことは承認されるまで何も起こさない。

## 何が動くか

既存の design worker（`run.sh` → `worker.ts`、jail の中の `sr-designgen`）が、1回の実行で最大1件の「承認済みデモ画像生成ジョブ」を処理する（`scripts/sales-design-worker/image-autorun.ts`）。1件 = real Codex 1回・画像呼び出し最大6回・15分、その後に取り込み・d1-v10 差し替え・PC/SP 描画。画像はリポジトリの外（`~/.local/share/second-root-design/image-autorun/<job_id>/`）に残り、Git・公開には出ない。

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

ジョブ（同じ承認 ID・同じ scope、ファイル名 = エントリの `job_id`）を `~sr-designgen/sr-design-jobs/image-autorun/inbox/<job_id>.json` に置くと、次の worker 実行で処理される。

## 止める・失効

- **実行の直後に必ず:** オーナーがそのエントリを消す（または `enabled` を `false` にする）。**これが正式な失効**であり、1回だけの承認を守る本体。
- **停止スイッチ:** `enabled` を `false` にするか、ファイルを消す → 以後のジョブは `HELD_AUTORUN_DISABLED`。
- **失効:** 承認エントリを消す（`REFUSED_NO_APPROVAL`）、または期限切れ（`REFUSED_APPROVAL_EXPIRED`）。使った ID は台帳 `~/.local/state/sr-design-worker/poc-approval-used/<id>` に残り、二度と使えない。
- **失敗の後:** `~/.local/state/sr-design-worker/image-autorun/STOPPED` ができ、以後すべて `REFUSED_AFTER_FAILURE`。オーナーが原因を見てから手で消す。自動の再試行は無い。
- 実行中の停止は worker の service を止める（途中のジョブは次回 `FAILED_INTERRUPTED`、再開しない）。

## 残る限界（はっきり書く）

使用済みの印（`poc-approval-used/<id>`）と `STOPPED` は worker の利用者（`sr-designgen`）の state にある。**worker の利用者として動くものは、承認の期間内ならこれらを消して同じジョブを出し直せる。** root 所有のエントリ（1つの `job_id` に結び付く）は worker から変えられないが、エントリが残っている間は消された印を補えない。だから **最大24時間の期間と、実行直後のオーナーによるエントリの削除が最後の歯止め**になる。

## 記録されること

`~/.local/state/sr-design-worker/image-autorun/audit.jsonl` と worker の出力に、判定ごとに1行: 時刻・コード・job_id・job の SHA256・承認 ID・店舗・画像枚数・呼び出し数・停止コード・出力の path。プロンプト本文・画像・秘密情報は書かない。結果は `image-autorun/{done,failed,held}/<job_id>.result.json`。

## 注意

- ON にしても本番能力（`APPROVED_CAPABILITIES=[]`）・本番 CSS gate・公開は変わらない。
- 画像ジョブは同じ worker 実行の時間（最大55分）を使うので、その回の cycle の bridge ジョブの時間が減る。
