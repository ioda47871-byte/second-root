# IMAGE_FIRST 限定パイロット（ほし窯 d3、1回だけ）— オーナーの手順

Issue #302 のオーナー事前承認（2026-11-21、コメント 7053442141）に基づく、**1回だけ**の限定パイロットの手順。

1. 実 Codex の画像生成を 1回（`codex exec` 1回、最大 15 分、PC 2 + SP 4、再試行なし）
2. 既存の worker が receipt を書き、bundle を封入し、非公開の review inbox へ渡す（PR #310）
3. 監査の `--dry-run`
4. 実 Claude CLI の監査を 1回（PR #311）

既存の門（承認パケット §10、pin、claim、ledger、jail との排他、監査の marker）は**どれも変えていない**。このパイロットのために
新しい runner・承認の読み取り・agent は作っていない。使うのは次の既存部品だけである。

| 部品 | 役割 |
|---|---|
| `scripts/sales-design-worker/imagefirst-worker.ts` | `--precheck`（何も書かない確認）と、1回の実行（claim → 既存の入口 → receipt → 封入 → inbox） |
| `scripts/sales-design-worker/imagefirst-deliver-review.sh` | 受け渡しが失敗したときだけ、同じ bundle を1回だけ再送（生成はしない） |
| `scripts/sales-design-worker/imagefirst-audit.ts` | `--check-auth-only`（ログインの形だけ確認。モデルは呼ばない）、`--dry-run`、本番の監査1回 |
| `imagefirst-autostart.sh` の `busy()`・`setpriv` の行・worker の起動行 | そのまま写した（テストが一字一句同じであることを固定） |
| `scripts/ops/wsl-resource-preflight.sh` | メモリの確認 |
| `scripts/sales-design-capture/admin.sh` | 止めるとき（`claude-stop`） |

新しく足したのは、root が手で1回だけ起動する2本のシェルだけ（どちらも systemd に入れない）。

- `scripts/sales-design-worker/imagefirst-pilot-preflight.sh <承認 ID>`: **読むだけ**の確認。PASS / FAIL の表を出す。
- `scripts/sales-design-worker/imagefirst-pilot.sh <承認 ID>`: preflight → worker 1回 → 受け渡しの確認（必要なら再送1回）→ dry-run → 監査1回 → 要約。
  `--sync-clone` は worker の専用 clone を origin/develop へ早送りするだけ（自動起動の手順 5 をそのまま写したもの）。

## 1. オーナーの手順（最小）

承認 ID は `hoshigama-imagefirst-d3-20261121-01`、使える時間は **2026-11-21 12:00 〜 2026-11-22 12:00（日本時間）**
（パケットの期限 `2026-11-22T03:00:00Z` の 24 時間前から。終わる 5 分前からは precheck が `APPROVAL_EXPIRES_SOON` で止める）。

1. **新しい承認パケットの PR（OWNER MERGE ONLY）の差分を確認して、オーナーがマージする。**
   変わるのは `docs/design/image-first-hoshigama-p3-packet.md` の冒頭の状態の行・§10 の表・最後の1行だけ。§3 の pin は変わらない。
   PR #300 はマージしない（閉じるか、マージせずに置いておく）。
2. WSL の root で、root の管理用 clone を更新する。

   ```bash
   sudo git -C /root/sr-capture-admin pull --ff-only
   ```

3. worker の clone を origin/develop へ早送りして（パケットのマージで develop が進むため）、preflight を実行する。

   ```bash
   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot.sh --sync-clone
   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot-preflight.sh hoshigama-imagefirst-d3-20261121-01
   ```

   最後の行が `IMAGEFIRST_PILOT_PREFLIGHT PASS approval=hoshigama-imagefirst-d3-20261121-01 failed=0 exit=0` でなければ、ここで止める（§3）。
4. パイロットを**1回だけ**実行する。

   ```bash
   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot.sh hoshigama-imagefirst-d3-20261121-01
   ```

   中で preflight をもう一度実行し、1つでも FAIL なら何も始めない。

## 2. 期待される出力

preflight（すべて PASS のとき。値は例）:

```
imagefirst-pilot-preflight: | resource     | PASS | OK: MemTotal ... MiB / MemAvailable ... MiB / ...
imagefirst-pilot-preflight: | disk         | PASS | ... MiB free (at least 4096)
imagefirst-pilot-preflight: | exclusion    | PASS | sr-jail-claude stopped and disabled/masked, sr-design-cycle stopped, no sr-designgen process
imagefirst-pilot-preflight: | timers       | PASS | sr-design-cycle.timer, sr-imagefirst-autostart.timer/.service off
imagefirst-pilot-preflight: | clone        | PASS | clean, HEAD = origin/develop = <40桁>
imagefirst-pilot-preflight: | no_prior_run | PASS | no claim, run, receipt, delivery, inbox copy or audit for hoshigama-imagefirst-d3-20261121-01
imagefirst-pilot-preflight: | approval     | PASS | the worker would run now: {"status":"would_run",...}
imagefirst-pilot-preflight: | codex        | PASS | on PATH, a sign-in is present (not read), no .env
imagefirst-pilot-preflight: | claude_bin   | PASS | on sr-designgen's PATH outside the jail
imagefirst-pilot-preflight: | claude_auth  | PASS | claude.ai subscription, first party, no API key
IMAGEFIRST_PILOT_PREFLIGHT PASS approval=hoshigama-imagefirst-d3-20261121-01 failed=0 exit=0
```

パイロット（成功のとき）: preflight の表、`imagefirst-pilot: worker: {"status":"succeeded",...}`、`hand-off: ... "status":"delivered"`、
`audit dry run: {"status":"planned",...}`、`audit: {"status":"completed",...}`、要約（下）、最後の行
`IMAGEFIRST_PILOT PILOT_DONE phase=after_claim approval=hoshigama-imagefirst-d3-20261121-01 exit=0`。

要約（`imagefirst-pilot: summary: ` で始まる行。コード・ハッシュ・数だけ）:

```
approval=... codex_runs=1 (one worker run; never retried) delivery=delivered
approval_id=...  commit=<40桁>  receipt_status=succeeded stop_code=none  receipt_sha256=<64桁>
packet_sha256=<64桁>  plan_sha256=<64桁>  prompt_sha256=<64桁>
images=pc=2 sp=4 total=6 verified=true
image=parts/pc-1.png sha256=<64桁> size=<幅>x<高さ> sha_matches_file=yes   （6行）
delivery=state=delivered bundle_sha256=<64桁>
audit_status=completed stop_code=none  audit_bundle_sha256=<64桁>
rubric=version=<版> sha256=<64桁>
scores_desktop_1440=total=.. lowest=.. verdict=.. hard_fails=.. beauty=.. fit=.. ...
scores_mobile_390=...
verdict=<show_owner|revise|drop> (advisory only; the owner decides)
```

終了コード: 0 完了、20 preflight の FAIL（何も始めていない）、12 開始前に busy、2 使い方・拒否、
1 worker を起動した後で止まった（worker の停止・未配送・jail の起動・dry-run や監査が想定外）、40/41 シグナル・内部エラー。

## 3. 止めるとき・戻すとき

- **preflight が FAIL**: 何も使っていない。表の理由を直してから preflight をやり直す（例: `exclusion` → `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop`、
  `clone` が behind → `--sync-clone`、`codex` → `sr-designgen` で Codex に ChatGPT でサインイン・`~/.codex/.env` を消す、
  `claude_bin` → `sr-designgen` の PATH（`/usr/local/bin:/usr/bin:/bin`）に `claude` を置く、`claude_auth` → `sr-designgen` で claude.ai にサインイン）。
  `approval` が `APPROVAL_EXPIRY_TOO_FAR` なら、まだ使える時間の前（日本時間 11/21 12:00 より前）。
- **途中で止めたい**: パイロットの端末で Ctrl-C。worker や監査の実行中なら止める合図を渡し、worker は receipt（`WORKER_INTERRUPTED`）を、
  監査は停止の記録を書いてから終わる。**承認 ID は使ったことになる**（claim は残る）。
- **worker を起動した後に止まった**（終了コード 1）: 再実行しない。2回目のパイロットは preflight の `no_prior_run` と worker の claim
  （`APPROVAL_ALREADY_CLAIMED`）で必ず止まる。生成をやり直すには、新しい承認パケット・新しい承認 ID・オーナーのマージが要る。
  受け渡しだけが失敗した場合（`PILOT_NOT_DELIVERED`）は、後で `imagefirst-deliver-review.sh <承認 ID>` で同じ bundle を再送できる（生成はしない）。
  監査を別に1回やり直すかどうかはオーナーが決める（marker と `audits/<ID>/` を手で消す必要がある。docs/operations/imagefirst-claude-audit.md §4）。
- **戻すもの**: このパイロットは systemd の unit・timer・自動起動のスイッチや印を作らず、変えない。jail を止めた場合は、
  使い終わってから必要なら `admin.sh claude-start` で戻す。画像・receipt・bundle・監査は `~sr-designgen/sr-runs/`（0700）に残る。

## 4. 送り返すもの（GitHub には状態とハッシュだけ）

パイロットの最後の行と、`imagefirst-pilot: summary:` の行（上の §2 の形）だけを Issue #302 に貼る。
**画像・プレビュー・`audit.json` / `AUDIT.md` の本文・プロンプト・`~/.codex` や `~/.claude` の中身・トークンは、GitHub にも Issue にも貼らない。**
画像を見るのはオーナーの手元（WSL の `~/sr-runs/review-inbox/`）か、Remote Control のローカル閲覧（任意）だけ。

## 5. 費用

- Codex: ChatGPT のプランの利用枠（と `image_gen` の利用上限）を使う。**金額は不明**（記録がない）。上限は回数（1回）と時間（15 分）で決めている。
- Claude: claude.ai のサブスクリプションの利用枠を使う（API キーは拒否する）。呼び出しは最大3回（表示幅ごとに1回 + 形の崩れた答えへの聞き直し1回）、各 10 分まで。**金額は不明**。
- 利用枠を超えた場合（`CODEX_QUOTA` / `CLAUDE_QUOTA`）は止まり、再試行しない。

## 6. PR #300 について

PR #300（`hoshigama-imagefirst-d3-20261120-01`、期限 `2026-11-21T03:00:00Z`）は**マージしない・延長しない・使い回さない**。
閉じるか、マージせずに置いておく。新しいパケット（承認 ID `hoshigama-imagefirst-d3-20261121-01`、計画 ID `hoshigama-imagefirst-p3-20261121`）が
それに代わる。§3 の pin（計画 `a19b6896…`、バッチ `291475d9…` / 12338 文字）は PR #300 と同じである（facts・方向性・成功原理・プロンプトのコードが
変わっていないため）。監査の採点基準（`audit-rubric.ts`）は pin の入力に入っていない。

## 7. テスト

```
npx vitest run tests/unit/design-agent/imagefirst-worker/pilot.test.ts
```

偽の WSL（`systemctl`・`setpriv`・`pgrep` の stub、一時的な bare origin の clone）、worker と監査の CLI の stub、本物の
`imagefirst-deliver-review.sh` を使う。PATH の `codex` と `claude` は記録して失敗する stub で、テストのたびに一度も起動していないことを確かめる。
本物の Codex・Claude・ネットワーク・root・systemd は使わない。
