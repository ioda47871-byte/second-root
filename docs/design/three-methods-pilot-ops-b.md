# 3方式のパイロットの実行の環境と手順 (承認 B) — DEV-151

DEV-151。Issue #180。配線の PR #190 (DEV-150) は develop にマージされた (`91cf3a3`、2026-11-01、オーナーの承認)。この文書は、計画 (`docs/design/three-methods-pilot-plan.md`、以下「計画」) §10 の **B (実行の環境と手順)** を、オーナーがそのまま承認し、そのまま実行できる形に書いたものである。

**この文書を書くあいだ、WSL・jail・`sr-designgen`・worker・timer・Codex・画像ツール・ネットワーク・有料 API には、一度も触れていない。** 書いた事実は、リポジトリの文書とコードから取った。リポジトリに手順が無いものは「(手順書に無い。オーナーが決める)」か「**案**」と書いた。

オーナーの優先は「3方式の実画面を、安全に、最後まで比べられる状態に届くこと」で、検査を増やすことではない。この文書は新しい検査を足さない。手順と受け渡しだけを決める。

## 1. 目的と範囲

**B が決めること:**

- `sr-designgen` (jail の中) で、配線した CLI をどう起動するか。
- 本番の worker・timer・画像の PoC・jail の Claude を、パイロットの窓のあいだどう止め、どう戻すか。
- 出力をどこに置き、Claude の作業場所へどう渡し、Claude の書いたものをどう戻すか。
- 生成した絵の目視の検査を誰がするか。オーナーの盲検をどう保つか。
- 失敗したときに何を止め、何を残し、どう戻すか。

**B が決めないこと (B を承認しても行えないこと):**

- 実の呼び出しの1回ずつ (C1-a・C1-b・C1-c・C2-a・C2-b) とやり直し (R)。それぞれ別の承認である (計画 §10)。
- D (ページを研究のディレクトリに入れる PR) のマージ。
- `.wslconfig`・jail の入れ直し (`jail-install`)・passt の更新・`sr-jail-net` の再起動・Production/Staging/DB・営業の送信。
- LIVE_LIMITS・pin・台帳・検査の変更。

## 2. 役割

| 誰 | すること | しないこと |
|---|---|---|
| **オーナー** | 承認 (B、C1-a〜R、D)。WSL の管理者 (uid 1000) の端末で、`sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- …` を打つ。**`sr-designgen` で走る手順はすべてオーナーが走らせる** (計画 §3.0): pin の確認、実の呼び出し、pre-render、Artifact 化、lane づくり、`--direction`、`--page-request` (C2 の承認のため)、台帳を読む `--check`、`--versions`。名指しした出力だけを受け渡しの場所へ写す (§5) | 評価の前に絵 (PNG) を開かない (§7)。`answer.json`・`quarantine/` を Claude に渡さない。承認を使い回さない |
| **Claude (開発の session)** | pin を出して承認の文案を作る。ページを書く (LAYOUT_FIRST・DIRECTION_FIRST、lane からの VISUAL_FIRST の実装)。台帳を読まない手順を自分の作業場所で走らせる (`--print-pin`、`--page-request`、仮の絵での `--check`、`impl-compare.ts`)。絵の目視の記録を書く (§6)。受け取った写しのハッシュを検める。盲検の評価のための並べ替え (§7)。記録 (`three_method_run_v0`) | `sr-designgen` で何も走らせない。jail の Claude (Remote Control) を使わない (§3 の P-3)。**WSL の管理者の利用者 (uid 1000、sudo を持ち、`~/sr-pilot-handover` の持ち主) として動かない**: その利用者は `sudo` で `answer.json`・`quarantine/`・台帳・すべての PNG を読めるので、§2 の分離が成り立たない。`answer.json`・`quarantine/`・デザインの出力のフォルダー・台帳の中身を開かない。途中の絵をオーナーに見せない。実の呼び出しを起動しない (研究 §7) |
| **独立の Claude の検査者 (任意)** | 方式の名前を知らされずに、絵1枚と事実パック・Identity Lock だけを見て、目視の記録を書く (§6) | ほかの方式の出力、lane、ページ、`prerender.md`、方式の対応を見ない |

- 手順の上の分離であって、OS の分離ではない (計画 §2.1、`lib/design-agent/impl-lane/handoff.ts` の注記)。`sr-designgen` で走る CLI は技術的には `answer.json` と `quarantine/` を読める。だから Claude を `sr-designgen` から外し、写しだけを渡す。
- **Claude の作業場所は、クラウドの Claude Code の session に決める** (この文書を書いた session と同じ種類)。そこには `sr-designgen` のファイルも管理者のホームも無く、オーナーが渡した写しだけがある。代わりにするなら、sudo を持たず、jail の外で、オーナーのホームと `sr-designgen` のホームを読めない別の利用者だけである (その利用者を作るのは B の外)。**管理者の利用者で Claude を動かす案は認めない** (認めれば §2 の分離をあきらめることになる)。
- **jail の Claude (`sr-jail-claude.service`) は `sr-designgen` として動く Claude である** (`docs/operations/design-wsl-autonomy.md`)。この分離のため、パイロットでは使わない (P-3)。

## 3. 事前準備 (C1 の前に1回)

### 3.0 共通の形 (案)

`sr-designgen` で走る手順は、すべて次の形で、オーナーが管理者の端末から打つ (形 J)。`admin.sh run` は画像の PoC と同じ入口である (`docs/operations/design-image-poc.md` の Run、`scripts/sales-design-capture/admin.sh` の `run`。jail の transient unit `sr-jail-run-*`、`RuntimeMaxSec=3500`)。

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
set -u; umask 077
cd ~/work/second-root
S=~/.local/state/sr-design-worker; R="$HOME/sr-three-methods"; mkdir -p "$S" && chmod 700 "$S"
rc=0; flock -n -E 75 "$S/run.lock" <コマンド> || rc=$?; echo "EXIT=$rc"'
```

- **phase2f の CLI を `sr-designgen` で起動する手順書は、リポジトリに無かった** (計画 §3.0・§11)。形 J は、画像の PoC の Run の形 (`admin.sh run sr-designgen -- /bin/bash -lc`、run.lock の `flock -n`) に合わせた**案**である。
- **phase2f の CLI は run.lock を取らない** (run.lock を取るのは `run.sh`・`design-image-poc.sh`・`compare-local.sh` などだけ。`grep run.lock scripts lib`)。worker の run と画像の PoC は run.lock を取るので (`run.sh` は取れなければ何もせず 0 で終わる。`design-image-poc.sh` は exit 3 で止まる)、形 J でコマンドのあいだ run.lock を持てば、それらは同時に走らない。`EXIT=75` は「ほかが run.lock を持っていた。何も起動していない」。
- run.lock を取らないもの (`design-demo.ts`・`photo-poc.sh`・手での `codex`) は、窓のあいだ起動しない (`design-image-poc.md` の Run の最後の段落と同じ理由: 実の呼び出しは途中で切れた呼び出しの残りを消す。計画 §3.0)。
- 終了コードは CLI のまま: 0 成功、2 承認を使う前に断られた (何も使っていない)、1 承認を使い、成功しなかった (計画 §7)。
- 出力 (JSON) はオーナーの端末に出る。実の呼び出しの CLI は1行 (`phase2f-live-cli.ts` の `say`)、オフラインの手順 (`phase2f-steps.ts`・`three-methods-steps.ts`) は字下げした複数行である。prompt・Codex の答え・絵は出ない。

### 3.1 手順

| # | 何を | コマンド・確かめ方 | 出典 | 止める条件 |
|---|---|---|---|---|
| P-0 | 窓を決める | パイロットの窓 (開始・終わり) をオーナーが決め、ほかの重い作業をしないと決める | 計画 §3.0 | — |
| P-1 | 実機の resource preflight | 形 J の `<コマンド>` を `scripts/ops/wsl-resource-preflight.sh` にする (jail の中でも `/proc/meminfo` を読む。画像の PoC の wrapper も jail の中で同じものを走らせる) | `docs/operations/wsl-resource-preflight.md` §1、`design-image-poc.md` の wrapper の 2. | `STOP` (exit 20) なら始めない。数字をそのまま Claude に渡す (§5 の形)。`SERIAL` なら、窓のあいだ重い処理は1つずつ (どの手順も1つずつ走らせる) |
| P-2 | 窓の確認 (読むだけ) | `docs/operations/passt-update-plan.md` §5.0 の **W-0** の block (`W0:BEGIN`〜`W0:END`) を、jail の外の管理者の shell で、そのまま走らせる。`W0_OK` であること。あわせて記録する: `systemctl list-timers --all 'sr-*' --no-pager` と `systemctl is-enabled sr-design-cycle.timer sr-design-worker.timer sr-design-bridge.timer` の出力 (戻すときの比べる元) | passt-update-plan §5.0 | `W0_HOLD` なら、その理由が無くなるまで待つ。止めない |
| P-2a | 本番の worker・timer を止める | **記録では、worker の timer はどれも有効になっていない** (`sr-design-cycle.timer` は HUMAN-010 で保留、`sr-design-worker.timer`・`sr-design-bridge.timer` は 2026-10-17 の読み取りで無し・inactive。`.ai/blockers.md` HUMAN-010、`.ai/progress.md` 2026-10-17、passt-update-plan §5.0)。P-2 で有効なものが見つからなければ、**止める操作は無い**。見つかったときだけ、その timer を止め、名前を記録する: `sr-design-cycle.timer` は `design-worker-cycle.md` §5 の「止める」の4行 (`sudo systemctl disable --now sr-design-cycle.timer` → `sudo systemctl stop sr-design-cycle.service` → `sudo systemctl stop 'sr-jail-run-*'` → `systemctl list-units 'sr-jail-run-*' --no-pager` が空)。system の `sr-design-worker.timer` は `design-worker-wsl.md` §6 の system の timer の形で `sudo systemctl stop sr-design-worker.timer` (戻すときは `sudo systemctl start sr-design-worker.timer`)。§7 の `systemctl --user disable --now` は user の unit の形で、jail のある machine では使わない (§6) | 同左 | 動いている cycle・worker の run があれば、終わるまで待つ (切らない。cycle が claim の後なら `design-worker-cycle.md` §6 になり、パイロットを始めない) |
| P-2b | 画像の PoC を止める | 画像の PoC には timer も unit も無い。人が打ったときだけ動く (`design-image-poc.md` の Safety、`design-image-one-command.md`)。**止める操作は無い。** 窓のあいだ起動しない。W-0 が PoC の process の無いことを確かめる | 同左 | PoC の process があれば待つ |
| P-2c | 止めない timer | `sr-capture.timer` (KNOWN-UNRELATED、止めない)。`sr-claude-auth-watch.timer` (BLOCKING。止めない・無効にしない。W-0 は30分以内に動くときだけ待つ)。**この timer の script は、design の利用者・`admin.sh`・shell の委任を参照する** (人の読むだけの確認、passt-update-plan「A-3 by backport onto `c066618`」の「`sr-claude-auth-watch.timer`」の段落)。窓の中で動けば、jail の Claude を起こす・`claude-stop` で動いている呼び出しを切る・run.lock を取らない `sr-designgen` の process を起こす、のどれもありうる。だから **W-0 の `W0_TIMER BLOCKING sr-claude-auth-watch.timer … next=` の時刻を記録し、窓 (最後の呼び出しの開始 + 見張りの20分 + 余裕) がその時刻より前に終わるように組む**。何を走らせるかは、読むだけの **AW-1** (同じ段落の block) で確かめられる | passt-update-plan「A-3 by backport onto `c066618`」・§5.0 | 窓が `next=` をまたぐなら、その窓では始めない (止めない・無効にしない。窓を選び直す) |
| P-3 | jail の Claude を止める (案) | まず jail の Claude に、作業を commit・push して止まってもらう。次に `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh status` の `jail:` の行 (enabled / active) を記録し、`sudo bash …/admin.sh claude-stop` | `design-wsl-autonomy.md` §1 の 5.、passt-update-plan §5.0「Claude in the jail」 | **`claude-stop` は `sr-jail-net` 以外の `sr-jail-*.service` をすべて止める** (`admin.sh` の `stop_jail_units`)。パイロットの run の最中には打たない。窓の始めと終わりだけ |
| P-4 | ほかの run が無い | W-0 が、`sr-jail-run-*` の unit・worker / PoC / Codex の process・cycle の lock を見る。run.lock は形 J の `flock -n` が毎回見る | passt-update-plan §5.0 | `EXIT=75` |
| P-5 | commit の pin (C1) | 先に形 J で `git rev-parse HEAD; git status --porcelain --untracked-files=all` を出し、**今の HEAD (P-5a の「前の HEAD」) を記録する**。作業ツリーが空でなければ、ここで止める: Run の2行は `git clean` をしないので、追跡していないファイルはそのまま残り、CLI は承認を使う前に断る。jail の Claude の作業 (P-3 で commit・push を頼んだもの) かもしれないので、消すかどうかはオーナーが決める (消すのは B に含めない)。次に、形 J で、run.lock の中で checkout を develop に揃える。`<コマンド>` は `sh -c "timeout 180 git fetch -q --no-tags origin +refs/heads/develop:refs/remotes/origin/develop && timeout 60 git checkout -q --force --detach origin/develop"` (画像の PoC の Run と同じ2行)。そのあと形 J で `git rev-parse HEAD origin/develop; git status --porcelain --untracked-files=all` を出し、HEAD = origin/develop = C1、作業ツリーが空であることを確かめる。**C1 が決まったら、C2 まで fetch しない** (CLI は HEAD を **手元の** `origin/develop` と比べる。`phase2f-live-cli.ts` の `commit`。fetch し直して develop が進んでいれば、承認した C1 と合わなくなる) | `design-image-poc.md` の Run、`phase2f-live-cli.ts` | 合わなければ呼び出さない (CLI も承認を使う前に断る) |
| P-5a | 依存 | 前の checkout から `package-lock.json` が変わっていれば、`npm ci` が要る (画像の PoC の wrapper の 4.。形 J の Run の2行は `npm ci` をしない)。形 J で `git diff --quiet <P-5 で記録した前の HEAD> HEAD -- package-lock.json; echo $?` を見て、1 なら形 J で `npm ci` (**案**。ネットワークに出る。今の checkout の commit は記録に無い) | `design-image-poc.md` の wrapper の 4. | `npm ci` が失敗したら始めない |
| P-6 | Codex の版・`.env`・サインイン | 形 J の `<コマンド>` の代わりに、HUMAN-021a の block の最初の4行 (`.env` の確認 → `echo ".env: absent"` → `codex --version`) と `codex login status` を走らせる (flock は要らない。model は呼ばない)。`codex --version` の最後の語 (例 `codex-cli 0.159.0` の `0.159.0`。`codex.ts` の `parseCliVersion` と同じ読み方) を **CLI_VERSION** として記録する。`codex login status` は「Logged in using ChatGPT」であること | `.ai/blockers.md` HUMAN-021a、`docs/operations/design-agent-wsl.md` §3 | `.env` があれば止まる (中身を見ない・貼らない)。サインインが切れていれば、`admin.sh shell` の中で `codex login --device-auth` (`design-agent-wsl.md` §3、`design-wsl-autonomy.md` §1 の 3.)。**この確認は、明らかな切れを承認の前に見つけるだけである。** `codex login status` は手元の auth.json だけを読むので、取り消された token でも通る (`lib/design-agent/codex.ts` の `SIGNED_OUT_SIGN` の注記)。そのときは呼び出しで 401 になり、承認を使ったことになる (`CODEX_NOT_SIGNED_IN`。やり直しは R。計画 §7) |
| P-6a | 版の値の扱い | **CLI 自身は、今の版を出力しない。** `--expect-cli-version` は、違えば `CODEX_CLI_VERSION_MISMATCH`、読めなければ `CODEX_CLI_VERSION_UNKNOWN` で、承認を使う前に止まるだけである (`phase2f-live-cli.ts` の `checkGeneration`)。だから P-6 の値を承認に書く。直近の記録は `0.159.0`・`gpt-6.1-sol` (計画 §5)。違う値なら、その値で承認するかをオーナーが決める | `phase2f-live-cli.ts` | — |
| P-7 | pin を `sr-designgen` でも出す | 形 J で、C1-a と C1-b の `--print-pin` (§4 の C1-a・C1-b の 1.)。どちらも Codex を呼ばない。Claude が自分の作業場所の C1 で出した値、計画 §5 の値 (`f6632d28…e0ac`/4415、`641d01f9…d3ad`/3353) と同じであること | 計画 §5 | 違えば止める (承認しない) |
| P-8 | 空きの容量 | (手順書に無い。オーナーが決める) **案:** 形 J で `df -h "$HOME"`。必要な量の記録は無い。画像1枚は 24 MiB まで (`design-image-poc.md` の PNG の検査)、PC/SP の描画が方式ごとに2枚 | — | — |
| P-9 | 出力の根と台帳 | 形 J で `install -d -m 0700 "$R" "$R/<PLAN_VF>" "$R/<PLAN_LF>" "$R/<PLAN_DF>"` (flock は要らない)。親は先に作る (`OUT_DIR_PARENT_MISSING` を避ける。計画 §3.0)。1回の呼び出し・1つの手順ごとに、新しいフォルダー `$R/<plan_id>/<手順の名前>` (下の表)。台帳は `~/.local/state/sr-design-worker/phase2f-live/` (`ledger.ts` の `defaultLedgerDir`。`SR_PHASE2F_STATE` を設定しない)。選んだ plan_id と approval_id がまだ使われていないことを、形 J で `ls ~/.local/state/sr-design-worker/phase2f-live/plans ~/.local/state/sr-design-worker/phase2f-live/approvals 2>/dev/null` の名前だけで確かめる | 計画 §3.0・§5、`ledger.ts` | 名前があれば、その ID を使わない |
| P-10 | 受け渡しの場所 | jail の外、オーナーの管理者の利用者のホーム。`install -d -m 0700 ~/sr-pilot-handover` (§5) | `design-image-poc.md` の Intake (`~/sr-comp-bundles`) と同じ形 | — |

出力のフォルダーの名前 (案。`<R>` = `/home/sr-designgen/sr-three-methods`):

| 手順 | フォルダー |
|---|---|
| C1-a デザイン | `<R>/<PLAN_VF>/c1a-design` |
| pre-render | `<R>/<PLAN_VF>/prerender` |
| C1-c 画像 | `<R>/<PLAN_VF>/c1c-image` |
| Artifact 化 | `<R>/<PLAN_VF>/package` と `<R>/<PLAN_VF>/package-result.json` |
| lane | `<R>/<PLAN_VF>/lane` |
| VISUAL_FIRST の実装 (戻したもの) | `<R>/<PLAN_VF>/in-impl` |
| C1-b 方向 | `<R>/<PLAN_DF>/c1b-direction` |
| 方向の受け渡し | `<R>/<PLAN_DF>/direction` |
| ページの要求 (C2) | `<R>/<PLAN_LF>/page-request`、`<R>/<PLAN_DF>/page-request` |
| C2-a / C2-b 画像 | `<R>/<PLAN_LF>/c2a-image`、`<R>/<PLAN_DF>/c2b-image` |
| 目視の記録 (戻したもの) | `<R>/<plan_id>/in-inspection` |
| 検査 | `<R>/<plan_id>/check` |
| やり直し | 元の名前に `-r1` |

## 4. 実行の手順

各手順は形 J (§3.0) で打つ。`<コマンド>` だけを書く。値は承認の文から写す (§9)。`F=design-library/research/three-methods/facts-pack.json`、`B=design-library/research/three-methods/brief.json` と読む (形 J の中では、パスをそのまま書く)。

### 4.0 毎回 (どの実の呼び出しの前にも)

1. P-1 の resource preflight。`STOP` なら止める。
2. ほかの run が無い (形 J の `EXIT=75` でないこと。`systemctl list-units 'sr-jail-run-*' --no-pager` が空)。
3. 形 J で `git rev-parse HEAD origin/develop; git status --porcelain --untracked-files=all`: HEAD = origin/develop = 承認の commit、空。
3a. W-0 をもう一度走らせ (jail の外)、`W0_TIMER BLOCKING sr-claude-auth-watch.timer … next=` が、この呼び出しの開始 + 20分 (見張り) より後であること。前であれば起動しない (P-2c)。`W0_HOLD` の理由が jail の Claude を止めたこと以外にあれば起動しない。
4. 2回目からは、それまでに成功したパイロットの呼び出しの**すべて** (方式をまたいで) で `npx tsx scripts/design-artifact/three-methods-steps.ts --versions --steps <dir>,<dir>,…` (計画 §7、暫定決定 5)。`GENERATION_CHANGED`・`GENERATION_FACTS_UNKNOWN` (exit 2) なら止める。`--previous-steps` は同じ plan の中しか比べないので、方式をまたぐ比べはこの手順だけが行う。
5. その呼び出しの pin を出し、**SHA-256 と文字数を承認の文と1文字ずつ照らす。** 違えば Enter を押さない。C1-a・C1-b・C2-a・C2-b は形 J の `--print-pin`。**C1-c には `--print-pin` が無い**ので、`prerender/prerender.md` の SHA-256 と文字数を照らす (§4.3 の 1.)。
6. 出力のフォルダーが新しい (まだ無い) こと。
7. 承認の文の approval_id・plan_id・commit・CLI_VERSION・previous steps を、打つコマンドと照らす。

### 4.1 C1-a: VISUAL_FIRST のデザイン (`design`・`C_hybrid`)

1. pin: `npx tsx scripts/design-artifact/phase2f-design.ts --print-pin --route C --facts design-library/research/three-methods/facts-pack.json --prompt-version tm0 --tm-brief design-library/research/three-methods/brief.json` → `f6632d283bbb1ed59941cd2064dd286b31968799d0f91c3c7b179967dbc0e0ac` / 4415。
2. 起動:
   ```
   npx tsx scripts/design-artifact/phase2f-design.ts --route C --facts design-library/research/three-methods/facts-pack.json --prompt-version tm0 --tm-brief design-library/research/three-methods/brief.json --out "$R/<PLAN_VF>/c1a-design" --plan-id <PLAN_VF> --approval-id <APPROVAL_C1A> --expected-prompt-sha256 f6632d283bbb1ed59941cd2064dd286b31968799d0f91c3c7b179967dbc0e0ac --expected-prompt-chars 4415 --expected-commit <C1> --expect-cli-version <CLI_VERSION> --human-approval-confirmed
   ```
   この plan の最初の呼び出しなので `--previous-steps` は無い (台帳に成功した呼び出しが無い)。
3. Claude へ写す: `c1a-design/call.json`・`generation.json` (§5)。**`answer.json` は写さない。**
4. 続けて (オフライン、オーナー): pre-render。`npx tsx scripts/design-artifact/phase2f-steps.ts --prerender --route C --design "$R/<PLAN_VF>/c1a-design" --facts design-library/research/three-methods/facts-pack.json --out "$R/<PLAN_VF>/prerender"`。
   - `CODEX_NO_ASSET_ON_ROUTE_C` など、デザインの答えが使えないときは、計画 §7 の「デザインの答えが使えない」の行 (新しい approval_id の最初の呼び出し。方式のやり直し1回と数える)。
   - オーナーは `prerender/prerender.md` を読み、C1-c の承認を決める (絵の説明と位置を読むので、盲検を弱める。§7 に記録する)。**試作の横はみ出しは、ここでは分からない** (Artifact 化で初めて分かる。計画 §3.2 の 4.)。
   - Claude へ写すもの: 無い。

### 4.2 C1-b: DIRECTION_FIRST の方向 (`direction`・`direction_text`)

C1-a と同じ commit C1。どちらを先にしてもよい。

1. pin: `npx tsx scripts/design-artifact/phase2f-direction.ts --print-pin --facts design-library/research/three-methods/facts-pack.json --tm-brief design-library/research/three-methods/brief.json` → `641d01f91d85bfd0005effd08b2ec9c0767a384878fd6f2accaeed730dc6d3ad` / 3353、答えの schema `e9050605def92bb9556a25e7a2bc88657c41a3fb21b2d70ed1521a97bfa555ef`。
2. 起動:
   ```
   npx tsx scripts/design-artifact/phase2f-direction.ts --facts design-library/research/three-methods/facts-pack.json --tm-brief design-library/research/three-methods/brief.json --out "$R/<PLAN_DF>/c1b-direction" --plan-id <PLAN_DF> --approval-id <APPROVAL_C1B> --expected-prompt-sha256 641d01f91d85bfd0005effd08b2ec9c0767a384878fd6f2accaeed730dc6d3ad --expected-prompt-chars 3353 --expected-commit <C1> --expect-cli-version <CLI_VERSION> --human-approval-confirmed
   ```
3. 続けて (オフライン、オーナー): `npx tsx scripts/design-artifact/three-methods-steps.ts --direction --step "$R/<PLAN_DF>/c1b-direction" --facts design-library/research/three-methods/facts-pack.json --out "$R/<PLAN_DF>/direction"`。
4. Claude へ写す: `direction/direction.json`、`c1b-direction/call.json`・`generation.json`。**`c1b-direction/answer.json` は写さない** (検めた方向だけを `direction.json` で渡す。計画 §3.4 の 3.)。

### 4.3 C1-c: VISUAL_FIRST の画像 (`image`・`C_hybrid`)

1. pin: `prerender/prerender.md` にある SHA-256 と文字数 (Route C の画像の pin は、試作の絵の説明から決まる。計画 §5)。`--print-pin` は route C には無い。
2. 起動:
   ```
   npx tsx scripts/design-artifact/phase2f-image.ts --route C --request "$R/<PLAN_VF>/prerender/image-request-A1.json" --out "$R/<PLAN_VF>/c1c-image" --plan-id <PLAN_VF> --approval-id <APPROVAL_C1C> --expected-prompt-sha256 <prerender.md の SHA> --expected-prompt-chars <prerender.md の文字数> --expected-commit <C1> --expect-cli-version <CLI_VERSION> --previous-steps "$R/<PLAN_VF>/c1a-design" --human-approval-confirmed
   ```
   tm0 のデザインの画像なので、`--expect-cli-version` と、そのデザインの実行を名指しした `--previous-steps` が無ければ `GENERATION_PIN_REQUIRED` (計画 §12.4)。
3. 続けて (オフライン、オーナー): Artifact 化と lane。
   ```
   npx tsx scripts/design-artifact/phase2f-steps.ts --package --route C --facts design-library/research/three-methods/facts-pack.json --prompt-version tm0 --tm-brief design-library/research/three-methods/brief.json --design "$R/<PLAN_VF>/c1a-design" --image "$R/<PLAN_VF>/c1c-image" --artifact-id <ARTIFACT_ID> --shop-id fictional-bakery-komugi --shop-name "架空パン工房 こむぎ灯" --out "$R/<PLAN_VF>/package" --result "$R/<PLAN_VF>/package-result.json"
   npx tsx scripts/design-artifact/three-methods-steps.ts --lane --package "$R/<PLAN_VF>/package" --facts design-library/research/three-methods/facts-pack.json --out "$R/<PLAN_VF>/lane"
   ```
   (2行は別々に形 J で打つ。) `render_pair_complete` でなければ lane はできない (試作の横はみ出しなど。計画 §7)。
4. Claude へ写す: `lane/` の中身すべて (`lane.json` と、そこに並ぶファイル: Artifact の記録・PC/SP の原本・素材)、`c1c-image/call.json`・`generation.json`・`report.json`、`package-result.json`。**`package/` (特に `quarantine/`) と `c1a-design/answer.json` と `prerender/` は写さない。** C1-c の絵そのものは、lane の素材として渡る (§6 の目視の対象)。

### 4.4 Claude のオフラインの作業 (C1 のあと)

- VISUAL_FIRST: lane の写しから実装 (`index.html`・`style.css`・`assets/`)。lane の絵を `assets/` に置く。
- LAYOUT_FIRST: 共通の入力から実装 (C1 を待たなくてよい。計画 §3.1)。
- DIRECTION_FIRST: `direction.json` と共通の入力から実装。
- 横はみ出しの修正は、**仮の絵で** `three-methods-steps.ts --check` を自分の作業場所で走らせて行う (本物の絵を `assets/` から外す)。本物の絵があると、出所を台帳で検められず `REJECT` になるため (計画 §12.4)。`LIMITS` (3回・原因ごとに2回) の中だけ。
- VISUAL_FIRST の忠実度: `npx tsx scripts/design-artifact/impl-compare.ts --lane <lane の写し> --impl <実装> --out <report.json>` (記録だけ、台帳を読まない)。
- LAYOUT_FIRST・DIRECTION_FIRST の絵を求めるなら、`--page-request` を自分の作業場所で走らせ、要求と `prerender.md` を確かめる。絵が要らなければ `--no-image-reason` で `no-image.json` (暫定決定 3)。

### 4.5 D: LAYOUT_FIRST と DIRECTION_FIRST のページの PR (絵を求めるときだけ)

1. Claude が `design-library/research/three-methods/pilot-1/layout-first/` と `…/direction-first/` に、2つのページ (`index.html`・`style.css`。絵は `<img src="assets/A1.png" alt="…">`、絵のファイルは入れない) を入れる PR を作る。研究のデータだけ。独立の Fresh Review と、最新の head の必須 CI。
2. **ページの修正は、この PR の前に終える。** C2 の絵はページの SHA-256 に結び付く (`IMAGE_PAGE_MISMATCH`)。マージのあとでページを1バイトでも変えると、その絵は使えない。
3. オーナーの承認 D の扱いは §7.4。マージのあとの develop の head が C2 である。
4. P-5 と同じ2行で、`sr-designgen` の checkout を C2 に揃える (ここで1回だけ fetch する)。P-5a も同じ。

### 4.6 C2-a / C2-b: ページの画像 (`page_image`・`claude_page`)

方式ごとに1回ずつ。下は LAYOUT_FIRST (C2-a)。DIRECTION_FIRST (C2-b) は `<PLAN_DF>`・`direction-first` に読み替える。

1. 要求 (オフライン、オーナー): `npx tsx scripts/design-artifact/three-methods-steps.ts --page-request --method LAYOUT_FIRST --page-root design-library/research/three-methods/pilot-1 --page design-library/research/three-methods/pilot-1/layout-first/index.html --hero <hero の区画> --facts design-library/research/three-methods/facts-pack.json --out "$R/<PLAN_LF>/page-request"`。
2. pin (オーナー、形 J): `npx tsx scripts/design-artifact/phase2f-image.ts --print-pin --page-request "$R/<PLAN_LF>/page-request/asset-request-A1.json" --page-root design-library/research/three-methods/pilot-1 --facts design-library/research/three-methods/facts-pack.json`。Claude も、自分の作業場所の C2 で、自分の `--page-request` の出力から同じものを出す。**2つの値と承認の文が同じであること。** `--hero` の値は Claude が承認の文に書く。
3. 起動:
   ```
   npx tsx scripts/design-artifact/phase2f-image.ts --route P --page-request "$R/<PLAN_LF>/page-request/asset-request-A1.json" --page-root design-library/research/three-methods/pilot-1 --facts design-library/research/three-methods/facts-pack.json --out "$R/<PLAN_LF>/c2a-image" --plan-id <PLAN_LF> --approval-id <APPROVAL_C2A> --expected-prompt-sha256 <pin の SHA> --expected-prompt-chars <pin の文字数> --expected-commit <C2> --expect-cli-version <CLI_VERSION> --human-approval-confirmed
   ```
   LAYOUT_FIRST はこれが plan の最初の呼び出し。DIRECTION_FIRST (C2-b) は C1-b が成功していれば `--previous-steps "$R/<PLAN_DF>/c1b-direction"` が要る (無ければ `PREVIOUS_STEPS_REQUIRED`)。
4. Claude へ写す: `c2a-image/image.png`・`call.json`・`generation.json`・`report.json`。
5. Claude (と任意の独立の検査者) が目視の記録を書き、オーナーへ戻す (§5・§6)。
6. 組み込みと検査 (オフライン、オーナー): `npx tsx scripts/design-artifact/three-methods-steps.ts --check --page design-library/research/three-methods/pilot-1/layout-first/index.html --facts design-library/research/three-methods/facts-pack.json --out "$R/<PLAN_LF>/check" --image "$R/<PLAN_LF>/c2a-image" --visual-inspection "$R/<PLAN_LF>/in-inspection/<記録>.json"`。
7. Claude へ写す: `check/` の中身すべて (`check.json`・`pc1440.png`・`sp390.png`)。

### 4.7 VISUAL_FIRST の最後の検査

1. Claude が実装 (と、lane の絵の目視の記録) をオーナーへ戻す (§5)。オーナーが `<R>/<PLAN_VF>/in-impl/` と `in-inspection/` に置く。
2. オフライン、オーナー: `npx tsx scripts/design-artifact/three-methods-steps.ts --check --page "$R/<PLAN_VF>/in-impl/index.html" --facts design-library/research/three-methods/facts-pack.json --out "$R/<PLAN_VF>/check" --asset-origin "$R/<PLAN_VF>/c1c-image,$R/<PLAN_VF>/c1a-design" --visual-inspection "$R/<PLAN_VF>/in-inspection/<記録>.json"`。デザインの実行 (C1-a) も `--asset-origin` に並べる (計画 §12.4)。
3. Claude へ写す: `check/` の中身すべて。

絵を使わない LAYOUT_FIRST・DIRECTION_FIRST のページは、台帳を読まないので、最後の `--check` も Claude が自分の作業場所で走らせる (計画 §3.0)。

### 4.8 R: やり直し

- 同じ plan・同じ kind と route の、成功していない呼び出しだけ。元の起動の行に `--retry-of <元の approval_id>` を足し、新しい approval_id と新しい `--out` (`-r1`) にする。`--previous-steps` には、その plan で成功した呼び出しをすべて入れる。
- 「成功したが使えない」デザインは `--retry-of` ではなく、新しい approval_id の最初の呼び出し (計画 §7、暫定決定 2)。
- 方式ごとに1回まで (承認で守る。台帳は2回まで通す。計画 §4)。

### 4.9 止める規則 (どの手順でも)

次のどれかなら、Enter を押さない・次の手順に進まない。何も消さず、出力 (JSON) と終了コードだけを Claude に渡す。

- `--print-pin` の値・commit・CLI_VERSION・approval_id・plan_id・previous steps が、承認の文と1文字でも違う。
- 形 J が `EXIT=75` を出した。`admin.sh run` が `HOST_UNSAFE` (exit 3) か `JAIL_NOT_INSTALLED` (exit 2) を出した。jail の unit が起動しなかった (probe は unit の `ExecStartPre` なので、通らなければ `EXIT=` の行が出ないまま `systemd-run` が失敗する)。
- `--versions` が止まった。
- 終了コード 2 (承認を使っていない。原因を直して**同じ** approval_id で起動し直せる)。
- 終了コード 1、または `UNEXPECTED` (承認を使ったかを §8 で決める)。
- 予定に無いもの (知らない符号、`generation_model_changed` の警告、予定より長い時間)。

## 5. 成果物の受け渡し

### 5.1 既にある形

- **`sr-designgen` → オーナー:** 画像の PoC の「Viewing」と「Intake」: オーナーが管理者の利用者 (jail の外) で `sudo install -m 0600 -o "$(id -u)" -g "$(id -g)" <元> <写し>` で、自分の非公開のフォルダーへ写す。元は変えない (`design-image-poc.md`)。
- **オーナー → Claude:** 写したファイルを Claude の session にアップロードする (`design-image-poc.md` の Intake、`docs/operations/comp-to-site.md` §8)。
- `docs/operations/design-bridge.md` の bridge は、Staging の job と worker の spool をつなぐもので、ファイルの手渡しには使えない (この文書の外)。
- **Claude → `sr-designgen` (戻す向き) の手順は、リポジトリに無い。**

### 5.2 案: 1つのフォルダーと1つの tar

オーナーの管理者の利用者のホームに、手順ごとのフォルダーを作り、名指ししたファイルだけを写し、ハッシュを付けて1つの tar にする。

```bash
# 例: C2-a の画像の写し (管理者の利用者で。jail の外)
D=/home/sr-designgen/sr-three-methods/<PLAN_LF>/c2a-image
H=~/sr-pilot-handover/<PLAN_LF>-c2a-image
install -d -m 0700 ~/sr-pilot-handover "$H"
for f in image.png call.json generation.json report.json; do sudo install -m 0600 -o "$(id -u)" -g "$(id -g)" "$D/$f" "$H/$f"; done
( cd "$H" && sha256sum image.png call.json generation.json report.json > SHA256SUMS )
install -d -m 0700 ~/sr-pilot-tars
T=~/sr-pilot-tars/"$(basename "$H")".tar
tar -C ~/sr-pilot-handover --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf "$T" "$(basename "$H")" && sha256sum "$T"
rm -r "$H"    # 写しの絵を残さない。tar とその SHA-256 だけを残す
```

- **案:** tar は、絵の無いフォルダー `~/sr-pilot-tars/` に置き、写しのフォルダーは tar を作ったら消す。名前の順に並べ、時刻と持ち主を揃える (`--sort=name --mtime=@0 …`、GNU tar) ので、tar の中の順や時刻から、写した順は分からない。

- オーナーは tar のファイルを Claude の session にアップロードし、tar の SHA-256 の1行を文で送る。**絵を1枚ずつアップロードしない** (アップロードの画面に絵が出て、盲検が崩れる。§7)。
- Claude は、新しい空のフォルダーに tar を置き、tar の SHA-256 を照らしてから展開し、`sha256sum -c SHA256SUMS` を通す。名前の一覧が下の表と同じでなければ使わない。リンクや表に無いファイルがあれば止める。
- 受け渡しのフォルダーは WSL の中に置き、`/mnt/c` (Windows のデスクトップなど) には置かない。WSL の中でも、Windows の Explorer で `\\wsl$` (`\\wsl.localhost`) から開かない (どちらもサムネイルで絵が見える)。
- フォルダーとして `lane/` を写すときは、`lane.json` に並ぶファイルを1つずつ同じ形で写す (`sudo install` はフォルダーを写さない)。`lane.json` のパスに下のフォルダー (原本・素材など) があれば、先にそのフォルダーを `install -d -m 0700` で作る。**案:** `sudo cp -a` を使わない (持ち主とリンクをそのまま写すため)。

**戻す向き (Claude → `sr-designgen`)、案:** Claude は、戻すファイル (目視の記録・VISUAL_FIRST の実装) を同じ形の tar にし、SHA-256 を文で示す。オーナーは tar を受け取り、SHA-256 を照らして管理者のホームで展開し、`sha256sum -c` を通してから、1つずつ `sudo install -d -o sr-designgen -g sr-designgen -m 0700 <R>/<plan_id>/in-…` と `sudo install -m 0600 -o sr-designgen -g sr-designgen <ファイル> <R>/<plan_id>/in-…/` で置く。VISUAL_FIRST の実装の `in-impl/assets/` のような下のフォルダーも、先に `sudo install -d -o sr-designgen -g sr-designgen -m 0700` で作る。**Claude の session からファイルをオーナーの手元へ持ち出す手段は、リポジトリに記録が無い** (§10)。

**もっと小さい案 (戻す向き):** 戻すものは文字だけにできる。目視の記録 (JSON) と VISUAL_FIRST の実装の `index.html`・`style.css` は、Claude が文として示し、SHA-256 を添える。オーナーはそれを貼ってファイルにし、`sha256sum` で照らしてから上の形で置く。実装の `assets/A1.png` は Claude から戻さず、オーナーが `sudo install -m 0600 -o sr-designgen -g sr-designgen <R>/<PLAN_VF>/c1c-image/image.png <R>/<PLAN_VF>/in-impl/assets/A1.png` で直に置く (絵は一度も `sr-designgen` へ戻らない。名前 `A1.png` はページの `<img src>` と同じにする)。

### 5.3 写すもの・写さないもの

| 手順 | Claude へ写す | 写さない |
|---|---|---|
| P-1・どの手順でも | 出力 (JSON) と `EXIT=` | — |
| C1-a | `c1a-design/call.json`・`generation.json` | `c1a-design/answer.json` (試作の HTML/CSS を含む) |
| pre-render | 無し | `prerender/` のすべて (`prerender.md`・`image-request-A1.json`) |
| C1-b | `c1b-direction/call.json`・`generation.json` | `c1b-direction/answer.json` |
| 方向の受け渡し | `direction/direction.json` | — |
| C1-c | `c1c-image/call.json`・`generation.json`・`report.json` (絵は lane で渡る) | — |
| Artifact 化 | `package-result.json` | `package/` のすべて (`quarantine/` を含む) |
| lane | `lane/lane.json` と、そこに並ぶファイルすべて | lane に無いもの |
| C2-a / C2-b | `image.png`・`call.json`・`generation.json`・`report.json` | `page-request/` (Claude は自分で作れる) |
| 検査 | `check/` のすべて | — |
| どの手順でも | — | 台帳 (`~/.local/state/sr-design-worker/phase2f-live/` の receipt・result・slots)、`~/.codex/`、セッションログ、ほかの plan の出力 |

台帳は、オーナーが §8 の判断 (承認を使ったか) のために名前を見るだけにする。

## 6. 画像の目視の検査

- **何を検めるか:** パイロットで Claude の実装に載る本物の絵すべて (C1-c の絵 = lane の素材、C2-a・C2-b の絵)。`--check` は、その絵の SHA-256 を名指しした `three_method_asset_inspection_v0` が無ければ `HOLD` で止まる (計画 §12.4、`lib/design-agent/three-methods/asset-image-audit.ts`)。
- **誰が書くか:** Claude が、自分の作業場所で、写しの絵を見て書く (`method: "assistant_visual"`、`inspector` に「Claude (development session)」と session を書く)。**任意で**、方式の名前を知らされない独立の Claude が、別に書く (`inspector` に「Claude (independent, method-blind)」)。記録は文字だけである。
- **独立の検査者が見てよいもの:** その絵1枚 (ファイル名は `image-<SHA-256 の先頭8文字>.png` に付け直す)、事実パック (`facts-pack.json`)、Identity Lock (`identity-lock.json`)、記録の形 (`asset-image-audit.ts` の `AssetInspection`)。**見せないもの:** 方式の名前と plan_id、ほかの方式の絵と出力、lane、ページ、`prerender.md` と絵の説明 (alt)、Claude の記録。
- **2つの記録があるとき (案):** `--check` に渡せる記録は1つである (`--visual-inspection <json>`)。独立の記録を `--check` に渡し、Claude の記録は比べるために残す。2つの `answers` が違えば、`--check` の前にオーナーへ止める (どちらを使うかはオーナーが決める)。
- **observed と inferred:** `observed` (見えた文字・印・描かれたもの・業種の手がかり) と `answers` だけが判定に使われる。`inferred` (解釈) は記録に残るだけで、判定に使われない (`asset-image-audit.ts`)。見えないことを推して書かない。迷えば `unknown`。
- **判定と、そのあと:**

| 判定 | いつ | そのあと |
|---|---|---|
| `PASS_ASSET_ONLY` | 記録が揃い、どの答えも `no` | 組み込みへ進む。店舗の同一性ではない (それはページの文字の `auditPageText`) |
| `HOLD` | 記録が無い・不完全・SHA が無い、読めない文字、店名でない文字や印 (「BREAD」のような一般の語も)、どれかが `unknown` | `--check` は記録を書いて exit 2。その方式はオーナーへ止まる。記録の書き誤り (schema に合わない) だけは、検査者が正しく書き直してよい。答えを変えて通すために書き直さない。一般の語をどう扱うかはオーナーが決める (計画 §12.4) |
| `REJECT` | 記録の SHA が描いた絵と違う、出所が分からない、ほかの店の名前・印、業種が違う、事実に反する | exit 2。その方式はオーナーへ止まる。出来の悪さはやり直しの理由にならない (計画 §7)。絵を外すか・方式を止めるかはオーナーが決める (計画 §10 の「主役でない画像が失敗したとき」は未決) |

- **オーナーは、盲検の評価の前に絵を開かない。** `method: "human_visual"` の記録は、パイロットでは使わない (オーナーが絵を見ることになるため)。

## 7. 盲検の保ち方

### 7.1 誰が何を知っているか

- オーナーは、承認と起動に立ち会うので、どの方式で何が呼ばれたかを知っている (研究 §11)。盲検で守るのは「どの絵がどの方式か」である。
- Claude は方式と絵の対応を知っている。だから Claude は、評価の前に絵をオーナーに見せない・説明しない。

### 7.2 名前と対応 (案)

1. 評価に出す絵は、3方式の最後の `--check` の `pc1440.png`・`sp390.png` (Claude の実装の描画。計画 §6.1)。
2. Claude は、3方式に X / Y / Z を無作為に割り当てる (例 `node -e` の `crypto.randomInt`)。評価の束は `review/X-pc1440.png`・`review/X-sp390.png`… と `review-sheet.md` の写しだけにする。ファイルの中に方式の名前・plan_id・approval_id が無いこと、PNG に文字の chunk が無いこと (`tEXt`・`iTXt`・`zTXt`) を確かめる。PNG の高さは方式ごとに違い、これは隠せない。
3. 対応のファイル `mapping.json` (`{"X": "<方式>", "Y": …, "Z": …, "nonce": "<16 バイトの乱数の hex>"}`) を書き、その SHA-256 を、評価の束を渡す前に Issue #180 のコメントに書く (ハッシュだけ)。nonce は、6通りしかない対応をハッシュから当てられないようにするためである。
4. **案 (封をした写しをオーナーが持つ):** Claude の session の container は長く残るとは限らないので、Claude が持ち続けることには頼らない。Claude は `mapping.json` だけの tar (`mapping.tar`、§5.2 と同じ形) を作ってオーナーへ渡し、その SHA-256 を Issue #180 に書く (3.)。オーナーは開かずに `~/sr-pilot-tars/` に置く。オーナーが点と「採れない印」を付け終えて Issue #180 に書いたあとで、SHA-256 を照らしてから開く。封は約束であって、機械が止めるのではない。早く開けば §7.5 で記録する。点は後から直さない (`review-sheet.md`)。
5. 評価の束は §5.2 の tar (名前の順・時刻を揃えたもの) で渡す。オーナーは、点を付けるときに初めて開く (Windows で見るなら、そのときだけデスクトップへ写し、終わったら消す。`design-image-poc.md` の Viewing と同じ)。

### 7.3 オーナーが見るもの・見ないもの

| いつ | 見る | 見ない |
|---|---|---|
| 承認 C1-a・C1-b・C2 の pin | SHA-256・文字数・commit・版 (文字だけ) | prompt の本文 (読んでもよいが、読めば記録する) |
| 承認 C1-c・C2-a・C2-b | `prerender.md` の絵の説明 (alt) と位置 (計画 §3.0。盲検を弱める) | 絵 |
| 受け渡し | ファイルの名前と SHA-256 | どの PNG も開かない (`sudo install` と `sha256sum` だけ。ファイルの管理画面のサムネイルも出さない) |
| 盲検の評価 | `review/` の X/Y/Z と `review-sheet.md` | 方式名・`mapping.json`・`check.json`・run の記録 |
| 評価のあと | すべて (計画 §6.1 の「評価のあとに開くもの」) | — |

### 7.4 D の PR (案)

- オーナーは、D の PR の差分 (HTML/CSS) を開かない。承認は、Claude が示す**ファイルの一覧 (パスと SHA-256) と head の SHA、独立の Fresh Review の PASS と必須 CI の結果**だけを見て、Issue #180 か PR のコメントで出す (「D を承認、head `<SHA>`」)。
- マージは、その承認を受けて Claude が行う (feature → develop。`docs/AI_WORKFLOW.md` の条件を満たすこと)。承認の head と違う head はマージしない。
- 代わりの案: オーナーが自分でマージする (差分のタブを開かずに)。どちらにするかは §10。

### 7.5 盲検が崩れたとき

- 崩れるもの: オーナーが評価の前に絵を見た、受け渡しで絵が表示された、`mapping.json` を早く開いた、D の差分を読んだ、Claude が途中の絵や方式の特徴を伝えた。
- 崩れても止めない。何が・いつ・どの方式についてかを、その方式の `three_method_run_v0` の `notes` に書く (盲検の欄は形に無い。`run-record-template.json`)。`prerender.md` を読んだことは、決まった弱め方として書く。
- 評価のあとで点を直さない。

## 8. 停止と復旧

### 8.1 失敗ごと

符号と復旧は計画 §7 の表のとおり。ここでは、実行の環境で足すものだけを書く。

| 失敗 | 止まるもの | 残すもの | 復旧 |
|---|---|---|---|
| 形 J が `EXIT=75` | その手順 | 何も使っていない | worker の run か画像の PoC が終わるまで待つ。窓の中でこれが出たら、P-2 からやり直す |
| `admin.sh run` の `HOST_UNSAFE` (exit 3)・`JAIL_NOT_INSTALLED` (exit 2)、probe が通らず unit が起動しない (`EXIT=` の行が出ない) | その手順 | 何も使っていない | 窓を閉じる。jail の修理は B の外 (別の承認) |
| 呼び出しを途中で止めたい | その呼び出し | 台帳に receipt と、`aborted` か `failed` (どちらになるかは決まらない) | `sudo systemctl stop 'sr-jail-run-*'` (`design-worker-cycle.md` §5 と同じ行)。systemd は unit の cgroup のすべての process に SIGTERM を送るので、CLI だけでなく Codex も同時に受け取る。CLI が先に受け取れば `aborted` と記録するが (`phase2f-design.ts` などの見出し)、Codex が先に終われば `failed` と記録されうる。**どちらでも承認は使った** (やり直しは R)。ほかの `sr-jail-run-*` が無い窓なので、止まるのはその手順だけ。Ctrl-C と端末が切れたときの `systemd-run --pipe --wait` の振る舞いは、リポジトリに記録が無い (§10)。端末は閉じない |
| 終了コード 1・`UNEXPECTED`・端末が切れて結果が分からない | その方式 | すべて | 台帳の `approvals/<approval_id>/` があるかを、オーナーが名前だけで見る (形 J で `ls ~/.local/state/sr-design-worker/phase2f-live/approvals/<approval_id>`)。**あれば承認を使った**: その approval_id を二度と使わない。利用枠も使ったと数える。やり直すなら R の承認。無ければ使っていないので、原因を直して同じ approval_id で起動し直す (計画 §7) |
| 突然 `Killed` (exit 137) | すべて | すべて | jail の中では kernel log が読めない (`OOM_UNKNOWN`)。オーナーが jail の外で `sudo journalctl -k --since "1 hour ago" \| grep -iE 'out of memory\|oom-kill\|killed process'` (`wsl-resource-preflight.md` §2)。OOM なら **resource failure として止まる**: 直さない・skip しない・そのまま打ち直さない。数字と kill の行を Claude に渡す。承認を使ったかは上の行で決める。`.wslconfig` は変えない (§4 の確認は人) |
| サインインが切れた (`CODEX_NOT_SIGNED_IN`) | その呼び出し | 記録 | `admin.sh shell` の中で `codex login --device-auth`。承認を使っていれば R |
| 窓の終わりまでに終わらない | 窓 | すべて | 動いている手順を切らない。終わってから §8.2 で戻す。続きは次の窓。**次の窓では P-1 から P-7 をやり直す**: §8.2 で戻したあとは worker の `run.sh` が自分で checkout を develop に揃える (`design-worker-wsl.md` §3) ので、窓をまたぐと C1 のままとは限らない。P-5 の commit が前と違えば、残りの呼び出しは新しい commit で承認し直す (§10.2 の 4.) |

### 8.2 パイロットのあと (または中止したとき) に戻す

1. 動いている手順が無いこと: `systemctl list-units 'sr-jail-run-*' --no-pager` が空。
2. P-2a で止めた timer があれば、その名前のものだけを戻す (`sudo systemctl enable --now <timer>`。`design-worker-cycle.md` §5 の enable の行)。止めていなければ何もしない。
3. P-3 で jail の Claude が enabled だったなら `sudo bash …/admin.sh claude-start` (`CLAUDE_STARTED (jailed)`)。enabled でなかったなら起動しない (passt-update-plan §5.0 の V-2b と同じ考え)。
4. 確かめる: `admin.sh status` の `jail:` の行が P-3 の記録と同じ。`systemctl list-timers --all 'sr-*' --no-pager` と `is-enabled` が P-2 の記録と同じ。W-0 をもう一度走らせて `W0_OK`。
5. `sr-designgen` の checkout は、C1 か C2 に detach したまま残してよい。worker の `run.sh` は自分で develop に揃える (`design-worker-wsl.md` §3 の `SR_DESIGN_WORKER_REF`)。画像の PoC の1回の入口は、実行のときに承認の commit を名指しする (`design-image-one-command.md`)。
6. 消さないもの: 台帳 (使った承認の記録。**使った承認は二度と使わない**)、`$HOME/sr-three-methods/` (評価と E が済むまで)。受け渡しの写しと評価の束を消す時期はオーナーが決める (§10)。

### 8.3 コードの戻し方

- リポジトリの変更は要らない。B は文書と手順だけである。
- 配線に不具合が見つかったら、develop へ PR #190 を revert する新しい PR を出す (オーナーの承認)。既存の入口は配線の前と同じに戻る。台帳に残った新しい kind の記録は、方式ごとの plan_id にしか属さない (計画 §7)。

## 9. 承認の単位

### 9.1 B を承認すると行えること

1. 窓の確認 (P-0〜P-2、P-4、読むだけ) と resource preflight。
2. P-2a: 有効な worker・cycle の timer が見つかったときだけ、窓のあいだそれを止め、窓のあとに P-2 の記録どおりに戻すこと。
3. P-3: jail の Claude を窓の始めに止め、窓のあとに前の状態へ戻すこと。
4. P-5・P-5a・§4.5 の 4.: `sr-designgen` の checkout を、run.lock の中で C1 に、D のあと C2 に揃えること (必要なら `npm ci`)。
5. P-6: `.env` の確認、`codex --version`、`codex login status` (model を呼ばない)。サインインが切れていれば `codex login --device-auth`。
6. P-7〜P-10: `--print-pin`、出力の根・受け渡しのフォルダーを作ること。
7. §4 の**オフラインの手順** (pre-render、Artifact 化、lane、`--direction`、`--page-request`、`--check`、`--versions`) を、オーナーが形 J で走らせること。
8. §5 の受け渡しと、§6 の目視の記録、§7 の盲検の手順。
9. §8 の停止と戻し方。

### 9.2 B を承認しても行えないこと

- 実の呼び出し (C1-a・C1-b・C1-c・C2-a・C2-b) と、やり直し (R)。1回ずつ、別の承認。
- D のマージ。
- `.wslconfig`・jail・passt・`sr-jail-net`・helper・Production/Staging/DB・営業の送信の変更。

### 9.3 呼び出し1回ずつの承認の文 (型)

Claude が下の型を埋めて出し、オーナーが承認する。オーナーは §4.0 の 5.・7. でこの文とコマンドを照らす。

| 欄 | 例 / 出どころ |
|---|---|
| 承認の名前 | C1-a / C1-b / C1-c / C2-a / C2-b / R-<元> |
| approval_id | `komugi-tm-vf-design-<日付>-01` (計画 §5 の案。形は `^[a-z0-9][a-z0-9._-]{3,95}$`) |
| plan_id | `komugi-tm-vf-<日付>` (形は `^[a-z0-9][a-z0-9._-]{3,63}$`) |
| kind・route・入口 | 例 `design`・`C_hybrid`・`phase2f-design.ts --prompt-version tm0` |
| expected prompt SHA-256 と文字数 | `--print-pin` か `prerender.md` の値 |
| expected commit | C1 か C2 (40文字) |
| expected CLI version | P-6 の CLI_VERSION |
| previous steps | その plan で成功した呼び出しの出力のフォルダーすべて (無ければ「無し」) |
| C1-c だけ | 要求のファイル (`prerender/image-request-A1.json`) のパス、名指すデザインの実行の approval_id と run_id、主役かどうか (essential)。どれも `prerender.md` にある |
| C2-a / C2-b だけ | ページのパス (`--page-root` からの位置)、ページの html の SHA-256、`--hero` の値 |
| plan の残り | その plan の使った枠 (最初・やり直し) と使った時間 (`prerender.md` か `--page-request` の `prerender.md`。計画 §5) |
| `--versions` に渡すもの | パイロットで成功した呼び出しのすべて (方式をまたぐ) |
| retry-of | R のときだけ、元の approval_id |
| 出力のフォルダー | §3 の表の名前 (新しいもの) |
| 上限 | 1回 15分、見張り 20分、plan 2時間 (`LIVE_LIMITS`)。ChatGPT の利用枠を1回分 (単価は記録に無い) |
| 止める条件 | §4.9 |
| 打つコマンド | §4 の行に値を入れたもの全文 |

## 10. 記録が無いこと・決めてほしいこと

### 10.1 リポジトリに手順・記録が無かったこと

- phase2f の CLI を `sr-designgen` で起動する手順 (形 J は案)。
- phase2f の CLI が run.lock を取ること (取らない。形 J の `flock` は案)。
- 今の Codex CLI の版を出す CLI の手順 (CLI は違えば止まるだけ。P-6 は HUMAN-021a の block を使う)。
- 今の timer の状態 (記録は 2026-10-17〜23 のもので、どれも有効になっていない)。窓の中で `sr-claude-auth-watch.timer` が何をするか (AW-1 で読むだけで確かめられる。P-2c は `next=` の前に窓を終える形にした)。
- サインインが取り消されていないことを、承認の前に確かめる手段 (`codex login status` は手元の auth.json だけを読む。`codex.ts`)。
- `systemd-run --pipe --wait` (`admin.sh run`) で、Ctrl-C や端末の切断のときに中の手順がどうなるか。
- 空きの容量の確かめ方と、要る量。
- 今の `sr-designgen` の checkout の commit と、`npm ci` が要るか。
- Claude → `sr-designgen` の受け渡し、Claude の session からファイルを持ち出す手段、session が tar のアップロードを受けるか。
- 盲検の評価の束をオーナーがどこで見るか (画像の PoC の Viewing の形はある)。
- `--check` の描画の PNG に文字の chunk があるか (§7.2 の 2. で確かめる)。
- 1回の呼び出しの所要時間と利用枠 (計画 §11 と同じ)。

### 10.2 決めてほしいこと

1. **パイロットの窓** (日時と長さ)。続きを別の窓にしてよいか。
2. **jail の Claude を窓のあいだ止めるか** (P-3。案は止める)。
3. **有効な worker・cycle の timer が見つかったとき**、止めて戻すか (P-2a)、窓を選び直すか。
4. **develop へのマージを窓のあいだ止めるか。** 案: C1 から最後の呼び出しまで、D のほかはマージしない。C1 の commit は、同じ窓の中で fetch しなければ変わらない。窓をまたぐと worker が checkout を develop に戻しうる (§8.1)。選べるのは、(a) C1 を固定する (窓のあいだも次の窓までも develop に D のほかを入れない。次の窓で P-5 が同じ C1 になる)、(b) commit が動いてよい (計画 §3.0 の前提。そのたびに新しい commit で承認し直す) のどちらか。C2 (D のマージ) には、それまでに develop に入ったすべてが入る。
5. **形 J (`admin.sh run` + `flock -n -E 75 run.lock`) を使うか。**
6. **受け渡しの場所と手段:** オーナーのホームの `~/sr-pilot-handover/`、tar のアップロード、戻す向きの手段。Claude の作業場所はクラウドの session に決めた (§2)。WSL の管理者の利用者は選べない。
7. **独立の Claude の検査者を置くか**、置くなら誰がどう起動するか。2つの記録が違ったときにどちらを使うか。
8. **D の承認とマージ (§7.4):** ファイルの一覧と head の SHA だけで承認し Claude がマージするか、オーナーがマージするか。
9. **VISUAL_FIRST の実装を、戻す向きの tar で `sr-designgen` へ置くこと** (§4.7)。代わりに D の PR に入れる案もあるが、計画 §6.1 (評価の前に成果物をリポジトリに入れない) の例外を増やす。
10. **ID:** plan_id・approval_id (計画 §5 の案)、`--artifact-id`、`--hero` の値。
11. **CLI_VERSION:** P-6 で読んだ値で承認するか (直近の記録 `0.159.0` と違うとき)。
12. **評価の束の見方と、`mapping.json` を開く時** (§7.2)。
13. **成果物を消す時期:** 受け渡しの写し・評価の束・`$HOME/sr-three-methods/` (E の前か後か)。
14. **`HOLD` の一般の語・主役でない絵が使えないとき** の扱い (計画 §10・§12.4 で未決のもの)。
