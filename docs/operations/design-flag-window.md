# Staging の design flag の window（controlled run、DEV-064）

controlled run（HUMAN-010）のために、Staging の `SALES_AI_DESIGN_ENABLED` を**期限つきで**一時的に ON にし、必ず OFF に戻す手順。
2026-10-20 の人の指示: できるだけ Claude 主体で、人の操作を少なく。Claude が途中で止まっても、指定の期限までに flag が OFF に戻る独立した手段を用意する。

> この文書と DEV-064 の PR は flag の変更も cycle の実走も承認しない。window を開くのは人の明示の承認の後。
> Vercel Authentication・Production・timer・実営業送信には触れない。

関連: cycle `design-worker-cycle.md`（§4 の 4.・§6・§7）、bridge の Vercel 保護 `design-bridge-access.md`、controlled run の SQL `.ai/runbooks/controlled-run/`。

## 1. 何が変わるか（範囲）

| 対象 | window で | Production への影響 |
|---|---|---|
| `SALES_AI_DESIGN_ENABLED`（Vercel、Preview・branch `develop`・plain の 1 record、id `rMGvxH8aHWZZC5Z5`） | `false` → `true` → `false` | なし。Production の record は無い（= 無効）。record の target・branch は変えない |
| `SALES_AI_DESIGN_ENABLED_UNTIL`（Vercel、Preview・`develop`・plain。初回に作る） | 期限（UTC） | なし。Preview `develop` だけに作る |
| develop の Preview deployment | push で作り直す（2 回） | なし。Production は `main` からだけ build される（`status` が確かめる） |
| Staging DB | cycle が対象の demo 1 件に設計を書く（承認済みの reset の後） | なし（Staging の Supabase だけ） |

`npm run staging:design-flag` が送ってよい request は次だけ（`guardedFetch`、それ以外は送る前に拒否。test あり）:
GET（project・env 一覧・develop の alias の deployment）、PATCH `env/<id>`（body は `{ value }` だけ）、POST `v10/projects/<id>/env`（key `SALES_AI_DESIGN_ENABLED_UNTIL`・plain・target `["preview"]`・gitBranch `develop` のときだけ）。
deployment を作る・promote する・env を消す・target を変える request は無い。
PATCH は、直前の読み取りで Preview `develop` の record だと確かめた id だけに、flag は `"true"` / `"false"`、期限は時刻の形の値だけ。
production branch が `main` でない、flag の record が Preview `develop` の 1 つでない、どちらかの key に他の record（Production・全 branch・encrypted）がある、env の一覧が Production の record を隠している（`hiddenProductionEnvCount`）、のどれかなら何も書かずに止まる。

## 2. 期限で自然に閉じる仕組み（二重）

1. **app の中の期限（`SALES_AI_DESIGN_ENABLED_UNTIL`、DEV-064）**: 値は `YYYY-MM-DDTHH:MM:SSZ`。設定されていると、flag はその時刻より前だけ有効（`lib/sales/design.ts` の `aiDesignEnabled`、request ごとの判定）。期限を過ぎると、誰も何もしなくても bridge API は `design_bridge_disabled`（503）、demo はテンプレート、Sales Agent の persist は従来どおり。形が違う値・空の値は無効（fail closed）。未設定（record が無い）なら従来どおり（Production は未設定）。
   - `on` は期限を**先に**書き、flag を後で `true` にする。期限なしで flag が `true` になる瞬間は無い。`--until` は 30 分〜4 時間先だけ。flag が `false` でない間の `on` は拒否（window を延ばさない。延ばすなら `off` → 改めて承認）
   - 遠い未来の期限は script では書けない（4 時間まで）。Vercel の画面で人が書いた値は app が形だけを確かめる
2. **独立した復旧 session（Claude の one-shot の scheduled task、DEV-065 で Vercel の API だけに）**: 期限の 10 分後に、この環境で**新しい session**が起き、repo を clone（無ければ）して develop を checkout し、`off --if-until <UNTIL>` → `status` を行う。**push しない**（scheduled task の session には repo が sources として付かず、git proxy が push を拒む: 2026-10-20 の予行で 403）。この session（window を開いた Claude）が止まっていても動く。期限が `<UNTIL>` と違う正しい時刻（別の window）なら何もしない（期限が無い・壊れているときは off する）。
   - push しなくてよい理由: 期限を過ぎた deployment は app の中で flag が無効（1.）。復旧 session が flag の record を `false` にするので、次に develop が deploy されたとき（Claude の記録の push、人の Redeploy、誰かの merge）も `false`。`verify --expect off` はその後で Claude が確かめる
   - **予行（DEV-065、人が 2026-10-20 に承認した 1 回）**: 同じ形の one-shot の scheduled task を 1 回だけ作り、新しい session が develop を checkout して `status`（flag `false` を確認）→ `write-check --id <flag の id>`（`false` の上に `false` を 1 回だけ書く。§6）→ `status` まで行えることを確かめる。push しない。その後、Claude（通常の session）が develop に記録を push して `verify --expect off`

どちらも効かなかったときは §5。

## 3. 手順（承認の後）

時刻は UTC。`<UNTIL>` は開始から 150 分後を勧める（deploy 2 回 ≒ 10 分 + cycle の上限 75 分 + 余裕）。

| # | 誰 | 何 | 確認 |
|---|---|---|---|
| 0 | Claude | `staging:design-flag -- status`・`staging:bypass-status`（読むだけ）。Sales Agent の scheduled task が無効であること | flag `false`・Authentication on・production branch `main` |
| 1 | Claude | 復旧の scheduled task を作る（§4、`<UNTIL>` + 10 分、新しい session）。§2 の予行（`WRITE_CHECK_OK`）が通っていること | task id を記録 |
| 2 | Claude | `staging:design-flag -- on --until <UNTIL>` | `DESIGN_FLAG ON_WRITTEN flag=true until=<UNTIL>` |
| 3 | Claude | `.ai/progress.md` に window の開始を 1 行書いて develop に push（= develop の redeploy） | — |
| 4 | Claude | `staging:design-flag -- verify --expect on --sha <3 の commit>` を READY まで繰り返す | `DESIGN_FLAG VERIFIED_ON` |
| 5 | **人（WSL）** | 期限まで 80 分以上あるときだけ: `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh --dry-run` → `CYCLE_DRY_RUN_OK` なら `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh` を 1 回。最後の `CYCLE_RESULT` 行を Claude に | `CYCLE_RESULT CYCLE_OK …` |
| 6 | Claude | 結果に関係なく `staging:design-flag -- off` → `.ai` に結果を書いて push → `verify --expect off --sha <その commit>` | `DESIGN_FLAG VERIFIED_OFF` |
| 7 | Claude | 1 の scheduled task を必ず消す（残しても `--if-until` で別の window は閉じず、flag が `false` なら `ALREADY_OFF` で何も書かない） | — |
| 8 | 人 または Claude | `.ai/runbooks/controlled-run/after.sql`（読むだけ） | design_status・attempts・review |

- window の間は develop に push しない（3 と 6 の記録だけ）。Sales Agent の run を始めない（flag が on だと新しい demo が `pending` で作られる）
- 5 で `CYCLE_STOP_*` のときも 6 へ。`phase=after_claim` / `claim_unknown` は `design-worker-cycle.md` §6

## 4. 復旧の scheduled task の文面（新しい session 用、DEV-065）

```
Second Root の Staging design flag の自動復旧（DEV-065、docs/operations/design-flag-window.md §4）。期限 <UNTIL> を過ぎた。
次だけを行う。git push・PR・Production・Vercel Authentication・DB・WSL・timer・営業送信・他の env には触れない。値（secret）を表示しない。失敗したら原因を報告して止まる（権限や設定を変えて回避しない）。
0. /home/user/second-root が無ければ cd /home/user && git clone https://github.com/ioda47871-byte/second-root.git。cd /home/user/second-root && git fetch origin develop && git checkout -B develop origin/develop（default branch は main で、script は develop にしかない）
1. npm run -s staging:design-flag -- off --if-until <UNTIL>
   - OFF_WRITTEN / ALREADY_OFF: 2. へ
   - OFF_SKIPPED_OTHER_WINDOW: 何もせず 2. へ（期限が別の正しい時刻 = 別の window）
   - FAILED: 1 分おいて 2 回まで再実行。直らなければ 2. へ（app の期限で flag はすでに無効）
2. npm run -s staging:design-flag -- status
3. 1. と 2. の出力（最後の DESIGN_FLAG 行と FAILED: の行を含む）をそのまま報告する。push はしない
```

- 報告は Claude（通常の session）が `list_events` で読む。`OFF_WRITTEN` なら、Claude が develop に記録を push して `verify --expect off`

## 5. 自動復旧が効かなかったとき

| 状況 | 影響 | 対処 |
|---|---|---|
| 復旧 session が起きない・途中で止まった | 期限の後は app が flag を無効として扱う（§2 の 1）。`status` は `passed` と出る | Claude（どの session でも）が §3 の 6。Claude が使えなければ人が Vercel の画面で Project → Settings → Environment Variables → `SALES_AI_DESIGN_ENABLED`（Preview・develop）を `false` → develop を Redeploy |
| Vercel が書き込みを拒む（403、token に権限がない） | `on` の最初の書き込み（期限）で止まる。flag は `false` のまま | window を開かない。人が画面で `SALES_AI_DESIGN_ENABLED_UNTIL` と flag を設定する（同じ範囲）か、token の権限を見直す |
| `off` は書けたが redeploy しない | 新しい deployment まで旧い値。期限で無効 | develop に push（記録の commit）、または人が画面で Redeploy |
| 期限が cycle の途中で来た | submit が 503 → `CYCLE_STOP_*`（`phase=after_claim`） | `design-worker-cycle.md` §6（job id を条件にした SQL・`--deliver-only`・lease の満了）。demo は未送信・未公開 |
| 期限の値が壊れた・空になった・消えた | 形が違う・空なら flag は無効（fail closed）。record が消えると期限なし（従来どおり） | `off` を実行。`status` で `until` を確かめる |
| team の方針で期限の record が plain で作れず、encrypted / sensitive になった | script は「他の record」として以後すべて拒否（flag は `false` のまま） | 人が Vercel の画面でその record を消す。window は人が画面で行うか、方針を見直す |
| 新しい session が develop を checkout できない・api.vercel.com の credential が無い | 復旧 session は止まる。期限で app は無効 | §2 の予行で事前に見つける。window の後なら上の 1 行目と同じ |
| 復旧 session は `OFF_WRITTEN` だが redeploy が無い | 今の deployment は期限で無効。record は `false` | 通常の session の Claude が develop に記録を push → `verify --expect off`。Claude が使えなければ人が画面で Redeploy |
| `write-check` が `WRITE_DENIED`（401/403） | 何も変わらない。Claude の credential では flag を書けない | window を開かない。token の権限は人の判断（Claude は広げない）。人が画面で操作する方式に切り替えるかを決める |

最後の砦: timer は無効のまま（cycle は人が手で動かすときだけ走る）。bridge は token と Vercel の bypass の両方が要る。Production には flag も期限も無い。

## 6. 書き込み権限の確認（`write-check`、DEV-065）

`npm run staging:design-flag -- write-check --id <flag の env var id>`（今の id は `rMGvxH8aHWZZC5Z5`、`status` と Vercel の一覧で確かめる）。

- 直前の読み取りで flag が `"false"`、`--id` が Preview `develop` の flag の record の id、production branch が `main`、他の record も隠れた Production の record も無い、のすべてのときだけ、その record に `{ "value": "false" }` を **1 回だけ** PATCH して読み直す
- 結果: `WRITE_CHECK_OK`（書ける。値は `false` のまま）/ `WRITE_DENIED`（401/403。何も変わらない）/ `FAILED`（拒否・通信の失敗。何も書いていないか、書いた値は `false`）
- 期限の record・他の env・Production・Vercel Authentication には触れない。deployment も作らない
- record の `updatedAt` が動くので、その後の `verify --expect off` は新しい deployment（develop への push）の後で通る

## 7. window の時間割（150 分）と WSL の事前確認

| 時刻（開始 T） | 出来事 |
|---|---|
| T−10 分 | §3 の 0（Claude）。人は WSL で下の事前確認 |
| T | 復旧 task を作る（`<UNTIL>` + 10 分 = T+160 分）→ `on --until <T+150 分>` → 記録の push |
| T+5〜10 分 | `VERIFIED_ON`（Claude）→ 人に cycle の開始を依頼 |
| T+10〜70 分 | 人が cycle（`--dry-run` → 本番 1 回。上限 75 分）。開始は T+70 分まで（期限まで 80 分以上） |
| cycle の後 | Claude が `off` → push → `VERIFIED_OFF` → 復旧 task を消す → `after.sql`（人の read-only） |
| T+150 分 | 期限: app が flag を無効として扱う |
| T+160 分 | 復旧 task が発火（消していなければ）: `off --if-until` |

WSL の事前確認（人、何も変えない）:

```bash
systemctl is-enabled sr-design-cycle.timer 2>&1; systemctl is-active sr-design-cycle.timer 2>&1   # disabled / inactive（または not-found）
sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh --dry-run                        # CYCLE_RESULT CYCLE_DRY_RUN_OK（flag が false でも通る: claim の前で止まる）
```

- `--dry-run` が `CHECK_*` で止まったら window を開かない（符号だけを Claude に）
