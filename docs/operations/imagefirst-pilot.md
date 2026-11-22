# IMAGE_FIRST 限定パイロット（ほし窯 d3、1回だけ）— オーナーの手順

> **自動実行について**: 承認コマンド 1 行の後に同じパイロットを自動で 1 回動かす仕組み（`imagefirst-approve.sh` と
> `sr-imagefirst-autorun.timer`、未設置）は [`imagefirst-autorun.md`](imagefirst-autorun.md)。その timer か service が
> enable / active の間は、この手順の preflight の `timers` の行が FAIL する（手で動かす前に timer を止める）。

> **d4 について（PR #320）**: この手順書の本文は d3 の 1 回（実施済み・承認 ID は使用済み）を書いたもの。d4 も同じ scripts で動くが、
> 承認は `docs/design/image-first-hoshigama-d4-packet.md`（冒頭と §10）だけで行い、承認 ID は `hoshigama-imagefirst-d4-<YYYYMMDD>-<NN>`、
> 計画 ID は `hoshigama-imagefirst-p4-<YYYYMMDD>`。どの承認パケット・ピンを使うかは ID の方向性から worker が選ぶ
> （`lib/design-agent/imagefirst-worker/run-directions.ts` の `IMAGEFIRST_RUNS`）。下の §1 のコマンドの d3 の ID を、承認した d4 の ID に
> 置き換えて使う。d4 用の期待される出力・停止のコードは d3 と同じ。d4 の 1 回も、パケットの承認とマージの後だけ。

Issue #302 のオーナー事前承認（2026-11-21、コメント 7053442141）に基づく、**1回だけ**の限定パイロットの手順。

1. 実 Codex の画像生成を 1回（`codex exec` 1回、最大 15 分、PC 2 + SP 4、再試行なし）
2. 既存の worker が receipt を書き、bundle を封入し、非公開の review inbox へ渡す（PR #310）
3. 監査の `--dry-run`
4. 実 Claude CLI の監査を 1回（PR #311、採点基準 v2 = PR #314）

既存の門（承認パケット §10、pin、claim、ledger、jail との排他、監査の marker）は**どれも変えていない**。このパイロットのために
新しい runner・承認の読み取り・agent は作っていない。使うのは次の既存部品だけである。

| 部品 | 役割 |
|---|---|
| `scripts/sales-design-worker/imagefirst-worker.ts` | `--precheck`（何も書かない確認。`would_run` のとき期限も返す）、`--check-codex-auth-only`（Codex のサインインだけを確認。何も使わない）、1回の実行（claim → 既存の入口 → receipt → 封入 → inbox） |
| `scripts/sales-design-worker/imagefirst-deliver-review.sh` | 受け渡しが失敗したときだけ、同じ bundle を1回だけ再送（生成はしない） |
| `scripts/sales-design-worker/imagefirst-audit.ts` | `--check-auth-only`（claude のログインの形だけ確認。モデルは呼ばない）、`--dry-run`、本番の監査1回 |
| `imagefirst-autostart.sh` の `busy()`・`trusted_path()`・`setpriv` の行・worker の起動行・シグナルの扱い | そのまま写した（テストが同じであることを固定） |
| `scripts/ops/wsl-resource-preflight.sh` | メモリの確認 |
| `scripts/sales-design-capture/admin.sh` | 止めるとき（`claude-stop`） |

新しく足したのは、root が手で起動する2本のシェルだけ（どちらも systemd に入れない）。

- `scripts/sales-design-worker/imagefirst-pilot-preflight.sh <承認 ID>`: **読むだけ**の確認。PASS / FAIL の表を出す。
- `scripts/sales-design-worker/imagefirst-pilot.sh <承認 ID>`: preflight → worker 1回 → 受け渡しの確認（必要なら再送1回）→ dry-run → 監査1回 → 要約。
  `--sync-clone` は worker の専用 clone を origin/develop へ早送りするだけ（自動起動の手順 5 をそのまま写したもの）。

## 1. オーナーの手順（最小）

承認 ID は `hoshigama-imagefirst-d3-20261121-01`（パケットの期限 `2026-11-22T03:00:00Z`）。

- worker が始められる時間: **2026-11-21T03:00Z 〜 2026-11-22T02:55Z（日本時間 11/21 12:00 〜 11/22 11:55）**。
  期限の 24 時間前から使え、終わる 5 分前からは worker の precheck が `APPROVAL_EXPIRES_SOON` で止める。
- パイロットは**期限まで 20 分以上**あるときだけ始める（preflight の `approval` の行が、20 分未満なら FAIL にする）。
  つまり遅くとも **2026-11-22T02:40Z（日本時間 11/22 11:40）** までに開始する。

マージの順番: PR #314（採点基準 v2、マージ済み）→ **オーナーが新しい承認パケットの PR #315 をマージ** → **オーナーが PR #300 をマージせずに閉じる**。

1. **新しい承認パケットの PR #315（OWNER MERGE ONLY）の差分を確認して、オーナーがマージする。**
   変わるのは `docs/design/image-first-hoshigama-p3-packet.md` の冒頭の状態の行・§10 の表・最後の1行だけ。§3 の pin は変わらない。
   PR #300 はマージせずに閉じる。
2. WSL の root で、root の管理用 clone を**承認したコミットに detached で**合わせ、きれいなことを確かめる（他の runbook と同じ形。
   `<承認したコミット>` は #315 のマージ後の develop の 40 桁の SHA）。

   ```bash
   sudo git -C /root/sr-capture-admin fetch -q origin
   sudo git -C /root/sr-capture-admin checkout -q --detach <承認したコミット 40 桁>
   [ -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" ] && echo ADMIN_CLONE_CLEAN
   ```

   preflight と pilot も、管理用 clone がきれいで、root が実行するスクリプトが root のもの・他人が書けないこと（`trusted_path`）を確かめ、
   そうでなければ何もせずに止まる（`*_ADMIN_CLONE_DIRTY` / `*_ADMIN_CLONE_UNTRUSTED`、exit 2）。始めに管理用 clone の HEAD を表示する。
3. **パイロットの直前に、`sr-designgen` として Codex（ChatGPT）と claude.ai にサインインし直す。** どちらの確認も、ローカルの
   サインインの記録の形しか見られない。期限の切れた・取り消されたサインインは、Codex では claim の後、claude では監査の marker の後に
   初めて失敗し、承認 ID や監査の1回を使ってしまう（§3）。`~/sr-runs` が `sr-designgen` の 0700 のディレクトリとしてあること
   （Codex のサインイン確認が生成と同じ場所の設定で動くため。無ければ preflight の `codex` の行が `OUT_DIR_PARENT_MISSING` で FAIL する。
   先に root で `install -d -o sr-designgen -g sr-designgen -m 700 /home/sr-designgen/sr-runs`）。
4. worker の clone を origin/develop へ早送りして（パケットのマージで develop が進むため）、preflight を実行する。

   ```bash
   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot.sh --sync-clone
   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot-preflight.sh hoshigama-imagefirst-d3-20261121-01
   ```

   最後の行が `IMAGEFIRST_PILOT_PREFLIGHT PASS approval=hoshigama-imagefirst-d3-20261121-01 failed=0 exit=0` でなければ、ここで止める（§3）。
5. パイロットを**1回だけ**実行する。

   ```bash
   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-pilot.sh hoshigama-imagefirst-d3-20261121-01
   ```

   中で preflight をもう一度実行し、1つでも FAIL なら何も始めない。

## 2. 期待される出力

preflight（すべて PASS のとき。値は例）:

```
imagefirst-pilot-preflight: admin clone /root/sr-capture-admin at <40桁> (clean)
imagefirst-pilot-preflight: | resource     | PASS | OK: MemTotal ... MiB / MemAvailable ... MiB / ...
imagefirst-pilot-preflight: | disk         | PASS | ... MiB free (at least 4096)
imagefirst-pilot-preflight: | exclusion    | PASS | sr-jail-claude stopped and disabled/masked, sr-design-cycle stopped, no sr-designgen process
imagefirst-pilot-preflight: | timers       | PASS | sr-design-cycle.timer, sr-imagefirst-autostart.timer/.service, sr-imagefirst-autorun.timer/.service off
imagefirst-pilot-preflight: | clone        | PASS | clean, HEAD = origin/develop = <40桁>
imagefirst-pilot-preflight: | no_prior_run | PASS | no claim, run, receipt, delivery, inbox copy or audit for hoshigama-imagefirst-d3-20261121-01
imagefirst-pilot-preflight: | rubric       | PASS | the clone's audit is rubric if-claude-audit-v2 (schema imagefirst_claude_audit_v2)
imagefirst-pilot-preflight: | approval     | PASS | the worker would run now, ... min of the approval left: {"status":"would_run",...}
imagefirst-pilot-preflight: | codex        | PASS | on PATH, no .env, signed in with ChatGPT (sandboxed check; an expired sign-in cannot be seen here)
imagefirst-pilot-preflight: | claude_bin   | PASS | on sr-designgen's PATH outside the jail
imagefirst-pilot-preflight: | claude_auth  | PASS | claude.ai subscription, first party, no API key
IMAGEFIRST_PILOT_PREFLIGHT PASS approval=hoshigama-imagefirst-d3-20261121-01 failed=0 exit=0
```

`codex` の行は、生成と同じ `.env` の規則・同じ sandbox の準備と probe の後、sandbox の中で `codex login status` を1回だけ読む
（`imagefirst-worker.ts --check-codex-auth-only`）。API キーのサインイン（`CODEX_API_KEY_AUTH`）、サインインなし（`CODEX_NOT_SIGNED_IN`）、
sandbox が使えない（`CODEX_SANDBOX_*`）は、**承認を使う前に**ここで FAIL になる。モデルは呼ばず、サインインの中身は読まない・表示しない。

パイロット（成功のとき）: preflight の表、`imagefirst-pilot: worker: {"status":"succeeded",...,"run_dir":"<local>","receipt":"<local>"}`、
`hand-off: ...`、`audit dry run: {"status":"planned",...}`、`audit: {"status":"completed",...}`、要約（下）、最後の行
`IMAGEFIRST_PILOT PILOT_DONE phase=after_claim approval=hoshigama-imagefirst-d3-20261121-01 exit=0`。
表示する JSON の行では、ローカルの場所（`run_dir`・`receipt`・`dir`）と bundle の SHA を `<local>` に置き換える。

要約は2つに分かれる。

- `imagefirst-pilot: share: ` で始まる行（**Issue #302 に貼ってよいのはこれと最後の行だけ**）: コード・枚数・寸法・yes/no だけ。

  ```
  share: approval=... codex_runs=1 (one worker run; never retried) delivery=delivered
  share: approval_id=...
  share: commit=<40桁> (the approved develop commit)
  share: receipt=status=succeeded stop_code=none
  share: images=pc=2 sp=4 total=6 verified=true
  share: image=pc-1 size=<幅>x<高さ> sha_matched=yes            （6行）
  share: delivery=state=delivered
  share: audit=status=completed stop_code=none rubric=if-claude-audit-v2 bundle_sha_matched=yes
  share: scores_desktop_1440=total=.. lowest=.. verdict=.. hard_fails=.. beauty=.. fit=.. ...
  share: scores_mobile_390=...
  share: verdict=<show_owner|revise|drop> (advisory only; the owner decides)
  ```

- `imagefirst-pilot: local-only: ` で始まる行: receipt・各画像・bundle・pin・採点基準の SHA-256、worker の stderr。**手元にだけ置き、
  GitHub には貼らない。**

終了コード: 0 完了、20 preflight の FAIL（何も始めていない）、12 開始前に busy、2 使い方・拒否、
1 worker を起動した後で止まった（worker の停止・拒否・時間切れ、未配送、jail の起動、中断 `PILOT_INTERRUPTED`、dry-run や監査が想定外）、
40 worker を起動する**前**のシグナル（`phase=before_claim`、何も使っていない）、41 内部エラー。
**`phase=after_claim` で終わったら（41 を含む）、承認 ID は使われた可能性がある**: receipt と `share:` の行を確かめる。

## 3. 止めるとき・戻すとき

- **preflight が FAIL**: 何も使っていない。表の理由を直してから preflight をやり直す。例:
  - `exclusion` → `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop`
  - `clone` が behind → `--sync-clone`
  - `rubric` → worker の clone の develop に採点基準 v2（PR #314）が入っていない。`--sync-clone`
  - `approval` が `APPROVAL_EXPIRY_TOO_FAR` → まだ使える時間の前。20 分未満 → この承認では始めない（新しいパケットが要る）
  - `codex` → `sr-designgen` で Codex に ChatGPT でサインインし直す（`codex login --device-auth`）・`~/.codex/.env` を消す・bubblewrap を確かめる。
    `OUT_DIR_PARENT_MISSING` なら `~sr-designgen/sr-runs` が無い: 先に `sr-designgen` の持ち物・mode 700 で作る
    （root で `install -d -o sr-designgen -g sr-designgen -m 700 /home/sr-designgen/sr-runs`）。Codex のサインイン確認は生成と同じ場所の設定で動くため、
    このディレクトリが要る（worker の precheck だけなら無くても通る）
  - `claude_bin` → `sr-designgen` の PATH（`/usr/local/bin:/usr/bin:/bin`）に `claude` を置く。`claude_auth` → `sr-designgen` で claude.ai にサインイン
- **途中で止めたい**: パイロットの端末で **Ctrl-C を1回だけ押して待つ**。worker や監査の実行中なら止める合図を渡し、worker は receipt
  （`WORKER_INTERRUPTED`）を、監査は停止の記録を書いてから終わる。パイロットは `PILOT_INTERRUPTED`（exit 1、`phase=after_claim`）で終わる。
  2回目の Ctrl-C は worker の猶予の中では強制停止になる（記録が残らないことがある）。**worker を起動した後なら承認 ID は使ったことになる**（claim は残る）。
- **worker を起動した後に止まった**（終了コード 1）: 再実行しない。2回目のパイロットは preflight の `no_prior_run` と worker の claim
  （`APPROVAL_ALREADY_CLAIMED`）で必ず止まる。生成をやり直すには、新しい承認パケット・新しい承認 ID・オーナーのマージが要る。
  受け渡しだけが失敗した場合（`PILOT_NOT_DELIVERED`）は、後で `imagefirst-deliver-review.sh <承認 ID>` で同じ bundle を再送できる（生成はしない）。
  監査を別に1回やり直すかどうかはオーナーが決める（marker と `audits/<ID>/` を手で消す必要がある。docs/operations/imagefirst-claude-audit.md §4）。
- **分かっている限界**:
  - Codex: `login status` はローカルの記録しか読まないので、取り消された・期限切れの ChatGPT のサインインは見抜けない。その場合は claim と
    ledger の予約の後、呼び出しで `CODEX_NOT_SIGNED_IN` などになり、承認 ID は使われる（`codex exec` の課金は起きない）。だから直前にサインインし直す。
  - claude: `claude auth status` が通っても、ログインがまだ有効だとは限らない。期限切れなら監査の最初の呼び出しで失敗し、そのときには
    監査の1回限りの marker は作られている（監査を使った扱い）。だから直前にサインインし直す。
- **戻すもの**: このパイロットは systemd の unit・timer・自動起動のスイッチや印を作らず、変えない。jail を止めた場合は、
  使い終わってから必要なら `admin.sh claude-start` で戻す。画像・receipt・bundle・監査は `~sr-designgen/sr-runs/`（0700）に残る。

## 4. 送り返すもの（GitHub には状態コードだけ）

パイロットの**最後の行**と、**`imagefirst-pilot: share:` の行だけ**を Issue #302 に貼る。そこにあるのは状態のコード・枚数・寸法・
「SHA が一致したか（yes / no）」だけで、SHA-256 そのものは入っていない。
**`local-only:` の行（receipt・各画像・bundle・pin の SHA-256、stderr）、画像・プレビュー・`audit.json` / `AUDIT.md` の本文・プロンプト・
`~/.codex` や `~/.claude` の中身・トークン・ローカルの場所は、GitHub にも Issue にも貼らない。**
画像を見るのはオーナーの手元（WSL の `~/sr-runs/review-inbox/`）か、Remote Control のローカル閲覧（任意）だけ。

## 5. 費用

- Codex: ChatGPT のプランの利用枠（と `image_gen` の利用上限）を使う。**金額は不明**（記録がない）。上限は回数（1回）と時間（15 分）で決めている。
- Claude: claude.ai のサブスクリプションの利用枠を使う（API キーは拒否する）。呼び出しは最大3回（表示幅ごとに1回 + 形の崩れた答えへの聞き直し1回）、各 10 分まで。**金額は不明**。
- 利用枠を超えた場合（`CODEX_QUOTA` / `CLAUDE_QUOTA`）は止まり、再試行しない。

## 6. PR #300 について

PR #300（`hoshigama-imagefirst-d3-20261120-01`、期限 `2026-11-21T03:00:00Z`）は**マージしない・延長しない・使い回さない**。
オーナーが PR #315 をマージした後、マージせずに閉じる。新しいパケット（承認 ID `hoshigama-imagefirst-d3-20261121-01`、計画 ID
`hoshigama-imagefirst-p3-20261121`）がそれに代わる。§3 の pin（計画 `a19b6896…`、バッチ `291475d9…` / 12338 文字）は PR #300 と同じである
（facts・方向性・成功原理・プロンプトのコードが変わっていないため）。監査の採点基準（`audit-rubric.ts`）は pin の入力に入っていない。

## 7. テスト

```
npx vitest run tests/unit/design-agent/imagefirst-worker/pilot.test.ts
```

偽の WSL（`systemctl`・`setpriv`・`pgrep` の stub、一時的な bare origin の clone）、worker と監査の CLI の stub、本物の
`imagefirst-deliver-review.sh` を使う。PATH の `codex` と `claude` は記録して失敗する stub で、テストのたびに一度も起動していないことを確かめる。
Codex のサインイン確認（`codexSignInCheck`）は偽の sandbox で、ChatGPT・API キー・サインインなし・sandbox の失敗を確かめる。
本物の Codex・Claude・ネットワーク・root・systemd は使わない。
