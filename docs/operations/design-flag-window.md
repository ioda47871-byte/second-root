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
2. **独立した復旧 session（Claude の one-shot の scheduled task）**: 期限の 10 分後に、この環境で**新しい session**が起き、develop を checkout して `off --if-until <UNTIL>` → develop に記録を push（redeploy）→ `verify --expect off` まで行う。この session（window を開いた Claude）が止まっていても動く。flag がすでに `false` で、その後の deployment なら何もしない。期限の値が `<UNTIL>` でない（別の window）なら何もしない。
   - **予行（window の前、読むだけ）**: 同じ形の one-shot の scheduled task を数分後に 1 回だけ作り、新しい session が develop を checkout して `staging:design-flag -- status` を `DESIGN_FLAG STATUS` まで実行でき、`git push --dry-run origin develop` が通ることを確かめる（何も書かない）

どちらも効かなかったときは §5。

## 3. 手順（承認の後）

時刻は UTC。`<UNTIL>` は開始から 150 分後を勧める（deploy 2 回 ≒ 10 分 + cycle の上限 75 分 + 余裕）。

| # | 誰 | 何 | 確認 |
|---|---|---|---|
| 0 | Claude | `staging:design-flag -- status`・`staging:bypass-status`（読むだけ）。Sales Agent の scheduled task が無効であること | flag `false`・Authentication on・production branch `main` |
| 1 | Claude | 復旧の scheduled task を作る（§4、`<UNTIL>` + 10 分、新しい session）。§2 の予行が通っていること | task id を記録 |
| 2 | Claude | `staging:design-flag -- on --until <UNTIL>` | `DESIGN_FLAG ON_WRITTEN flag=true until=<UNTIL>` |
| 3 | Claude | `.ai/progress.md` に window の開始を 1 行書いて develop に push（= develop の redeploy） | — |
| 4 | Claude | `staging:design-flag -- verify --expect on --sha <3 の commit>` を READY まで繰り返す | `DESIGN_FLAG VERIFIED_ON` |
| 5 | **人（WSL）** | 期限まで 80 分以上あるときだけ: `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh --dry-run` → `CYCLE_DRY_RUN_OK` なら `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh` を 1 回。最後の `CYCLE_RESULT` 行を Claude に | `CYCLE_RESULT CYCLE_OK …` |
| 6 | Claude | 結果に関係なく `staging:design-flag -- off` → `.ai` に結果を書いて push → `verify --expect off --sha <その commit>` | `DESIGN_FLAG VERIFIED_OFF` |
| 7 | Claude | 1 の scheduled task を必ず消す（残しても `--if-until` で別の window は閉じないが、記録の push が増える） | — |
| 8 | 人 または Claude | `.ai/runbooks/controlled-run/after.sql`（読むだけ） | design_status・attempts・review |

- window の間は develop に push しない（3 と 6 の記録だけ）。Sales Agent の run を始めない（flag が on だと新しい demo が `pending` で作られる）
- 5 で `CYCLE_STOP_*` のときも 6 へ。`phase=after_claim` / `claim_unknown` は `design-worker-cycle.md` §6

## 4. 復旧の scheduled task の文面（新しい session 用）

```
Second Root の Staging design flag の自動復旧（DEV-064、docs/operations/design-flag-window.md §4）。期限 <UNTIL> を過ぎた。
リポジトリ ioda47871-byte/second-root で、最初に git fetch origin develop && git checkout -B develop origin/develop（default branch は main で、script は develop にしかない）。その上で次だけを行う。Production・Vercel Authentication・DB・timer・営業送信・他の env には触れない。値（secret）を表示しない。
1. npm run -s staging:design-flag -- off --if-until <UNTIL>
   - OFF_SKIPPED_OTHER_WINDOW なら何もせず、その行を報告して終わる（別の window）
   - FAILED なら 2 回まで再実行。直らなければ最後の行と FAILED: の行だけを報告して終わる（app の期限で flag はすでに無効）
2. ALREADY_OFF のときは git fetch origin develop して npm run -s staging:design-flag -- verify --expect off --sha <origin/develop の commit>。VERIFIED_OFF なら 4. へ（何も push しない）
   OFF_WRITTEN のとき、または 2. の verify が VERIFIED_OFF でないとき:
   .ai/progress.md に「<日時> 自動復旧: design flag off（DEV-064 の scheduled task）」を 1 行足し、commit して git push origin develop（競合したら pull --rebase して 1 回だけ再 push）
3. npm run -s staging:design-flag -- verify --expect off --sha <develop の HEAD> を、VERIFIED_OFF になるまで約 1 分おきに最大 15 分
4. 最後に status の出力と最後の DESIGN_FLAG 行を報告する
```

## 5. 自動復旧が効かなかったとき

| 状況 | 影響 | 対処 |
|---|---|---|
| 復旧 session が起きない・途中で止まった | 期限の後は app が flag を無効として扱う（§2 の 1）。`status` は `passed` と出る | Claude（どの session でも）が §3 の 6。Claude が使えなければ人が Vercel の画面で Project → Settings → Environment Variables → `SALES_AI_DESIGN_ENABLED`（Preview・develop）を `false` → develop を Redeploy |
| Vercel が書き込みを拒む（403、token に権限がない） | `on` の最初の書き込み（期限）で止まる。flag は `false` のまま | window を開かない。人が画面で `SALES_AI_DESIGN_ENABLED_UNTIL` と flag を設定する（同じ範囲）か、token の権限を見直す |
| `off` は書けたが redeploy しない | 新しい deployment まで旧い値。期限で無効 | develop に push（記録の commit）、または人が画面で Redeploy |
| 期限が cycle の途中で来た | submit が 503 → `CYCLE_STOP_*`（`phase=after_claim`） | `design-worker-cycle.md` §6（job id を条件にした SQL・`--deliver-only`・lease の満了）。demo は未送信・未公開 |
| 期限の値が壊れた・空になった・消えた | 形が違う・空なら flag は無効（fail closed）。record が消えると期限なし（従来どおり） | `off` を実行。`status` で `until` を確かめる |
| team の方針で期限の record が plain で作れず、encrypted / sensitive になった | script は「他の record」として以後すべて拒否（flag は `false` のまま） | 人が Vercel の画面でその record を消す。window は人が画面で行うか、方針を見直す |
| 新しい session が develop を checkout できない・api.vercel.com の credential が無い・push できない | 復旧 session は止まる。期限で app は無効 | §2 の予行で事前に見つける。window の後なら上の 1 行目と同じ |

最後の砦: timer は無効のまま（cycle は人が手で動かすときだけ走る）。bridge は token と Vercel の bypass の両方が要る。Production には flag も期限も無い。
