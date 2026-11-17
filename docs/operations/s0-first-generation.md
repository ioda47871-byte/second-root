# DEV-139 Stage 0 — 最初の実生成1回の手順（準備だけ。**実行していない**）

更新日：2026-11-17。前提：prompt v2.1 を有効化する PR（branch `feature/dev-139-activate-prompt-v21`）が `develop` に merge されていること。
**この文書は承認を与えない。**実 Codex の呼び出しは、下の pin と commit を名指ししたオーナーの個別承認の後だけ。
画像生成・ネットワーク（Codex の呼び出し以外）・DB・worker/timer・公開・送信はどれも使わない。

対象：架空パン店 ほし窯（`fictional-bakery-hoshigama`）・方向 `d1-kiln-clock`・prompt v2.1・route B・参照画像 0 件。

## 0. 承認の前に必ずやること（pin の再確認）

prompt の SHA は `prompt.ts`・facts・方向案・参照の manifest の**バイト**で決まり、commit には依らない。だから squash merge で commit が
変わっても、同じバイトなら SHA は同じになるはずである。それでも、merge 後の `develop` で**走らせ直して確かめてから**承認に出す。
`--expected-commit` は merge 後の `origin/develop` の SHA（下の 3.）で、承認はそれに結びつく。

この branch で出した値（`docs/operations/s0-three-shop-directions.md`・`s0-generation-selection.json` と同じ）：
`prompt_sha256 b90951bc37070381c23e22e65aed11d34bf2deb318218a21e83c2815cbab31fe`、`prompt_chars 5332`。

```bash
cd ~/second-root && git fetch origin && git checkout develop && git pull --ff-only
test -z "$(git status --porcelain --untracked-files=all)" || echo "作業ツリーが空でない：止まる"
RUN=$HOME/sr-runs/s0-gen-$(date +%Y%m%d)-hoshigama-d1   # 新しい空のディレクトリ。リポジトリの外
mkdir -p "$(dirname "$RUN")" && mkdir "$RUN" && mkdir "$RUN/runs"
P=design-library/research/quality-pipeline/poc/bakery

npx tsx scripts/design-artifact/direction-set.ts --set "$P/direction-set.json" --facts "$P/facts-pack.json"   # 0 = READY_FOR_COMPS
npx tsx scripts/sales/demo-version/prepare-design-input.ts --facts "$P/facts-pack.json" \
  --directions "$P/direction-set.json" --direction-id d1-kiln-clock --out "$RUN/runs/design-input"
npx tsx scripts/design-artifact/phase2f-design.ts --print-pin --route B --prompt-version v2.1 \
  --facts "$P/facts-pack.json" --direction "$RUN/runs/design-input/direction.json" \
  --references "$RUN/runs/design-input/references.json"
# → prompt_version "v2.1"、references []、prompt_sha256 / prompt_chars が上の値と同じこと。違えば止まり、違う値で承認を取り直す
git rev-parse origin/develop   # → 承認に書く commit
```

## 1. 実機の resource preflight

Codex（と後段の Chromium）は重い処理なので、始める前に `docs/operations/wsl-resource-preflight.md` のとおり：

```bash
scripts/ops/wsl-resource-preflight.sh          # 0 OK / 10 SERIAL（重い処理は1つだけ）/ 20 STOP（始めない）
```

20 なら始めない。途中で突然 `Killed` されたら、直す前に `scripts/ops/wsl-resource-preflight.sh --oom-check --since "1 hour ago"` で
OOM-kill を確かめ、OOM なら resource failure として止まって報告する（再試行しない）。`%USERPROFILE%\.wslconfig` は変えない。

## 2. 承認 ID・plan ID・台帳

- 台帳：`SR_PHASE2F_STATE` を固定し、実呼び出しと包みの段が同じ台帳を読むようにする（リポジトリの外。CLI が確かめる）。
- **plan ID**：店ごとに1つ。例 `s0-hoshigama-v21-plan-1`（`^[a-z0-9][a-z0-9._-]{3,63}$`）。
- **承認 ID**：呼び出しごとに1つ、**一度しか使えない**。例 `s0-hoshigama-d1-v21-design-01`（`^[a-z0-9][a-z0-9._-]{3,95}$`）。
  再試行は新しい ID（例 `…-design-02`）に `--retry-of s0-hoshigama-d1-v21-design-01` を付ける。
- **台帳の上限**（`LIVE_LIMITS`、変えない）：1つの plan で初回4回・再試行2回まで、1回15分、plan 全体で2時間。
  オーナー指示 B の候補（初回6回＋各案1回の再試行＝最大12回）は、店ごとの plan（各店 初回2回＋再試行2回）なら上限の内に収まる。
  上限を超える呼び出しは台帳が拒む（`RUN_LIMIT_FIRST_CALLS` / `RUN_LIMIT_RETRIES` / `RUN_TIME_BUDGET`）。

## 3. 実 Codex の呼び出し1回 —— **オーナーの個別承認の後だけ。未実施**

```bash
export SR_PHASE2F_STATE="$HOME/.local/state/sr-design-worker/phase2f-live"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=<実機の Chromium>   # 後段の描画用
P=design-library/research/quality-pipeline/poc/bakery
npx tsx scripts/design-artifact/phase2f-design.ts --route B --prompt-version v2.1 \
  --facts "$P/facts-pack.json" \
  --direction "$RUN/runs/design-input/direction.json" \
  --references "$RUN/runs/design-input/references.json" \
  --out "$RUN/runs/design" \
  --plan-id s0-hoshigama-v21-plan-1 --approval-id s0-hoshigama-d1-v21-design-01 \
  --expected-prompt-sha256 <0. で確かめた prompt_sha256> --expected-prompt-chars <0. の prompt_chars> \
  --expected-commit <0. の origin/develop の SHA> \
  --human-approval-confirmed
```

- 参照 0 件なので `--reference-dir` は付けない（付けると `USAGE` で拒まれる）。
- 呼び出しの前に確かめられること（どれかが違えば exit 2、承認は使われない）：版が有効（v2.1）、facts が v2.1 の規則と矛盾しない、
  prompt の SHA と文字数、HEAD = `origin/develop` = `--expected-commit` で作業ツリーが空、`--out` が新しくリポジトリの外、承認 ID が未使用、
  plan の上限と残り時間、`.env` の規則と sandbox。
- 結果：exit 0 成功（`$RUN/runs/design` に `answer.json`・`generation.json`・`call.json`）、exit 1 呼び出した（承認は使った）が成功しなかった、
  exit 2 何も使わずに拒んだ。

## 4. 後段（Codex を呼ばない）

```bash
# 包みの段：台帳と出力の一致、v2.1 の指示文を組み直して受領の SHA と照合、試作の安全検査、PC/SP 描画、intake
npx tsx scripts/design-artifact/phase2f-steps.ts --package --route B --prompt-version v2.1 \
  --direction "$RUN/runs/design-input/direction.json" --references "$RUN/runs/design-input/references.json" \
  --facts "$P/facts-pack.json" --design "$RUN/runs/design" \
  --artifact-id DA-<YYYYMMDD>-<英小文字・数字6文字> --shop-id fictional-bakery-hoshigama --shop-name "架空パン店 ほし窯" \
  --out "$RUN/runs/artifact" --result "$RUN/runs/artifact-result.json"

# 接着（目視レビューの前は --review なし → VISUAL_REVIEW_MISSING で止まり、PC/SP の PNG ができる。その絵を人が見る）
node scripts/sales/demo-version/from-generation.mjs --facts "$P/facts-pack.json" \
  --directions "$P/direction-set.json" --direction-id d1-kiln-clock --design-input "$RUN/runs/design-input" \
  --expected-prompt-sha256 <承認した prompt_sha256> --design "$RUN/runs/design" \
  --artifact "$RUN/runs/artifact" --result "$RUN/runs/artifact-result.json" \
  --lane quality_research_fictional --out "$RUN/runs/glue-1"
```

`from-generation.mjs` は open direction の設計（`prompt_version` が v2 または v2.1）だけを受ける。ほかは `GENERATION_NOT_V2`。

## 5. 止まる条件（その場で止めて報告する。直してから走らせ直すことはしない）

- 0. の pin が記録と違う、commit が承認と違う、作業ツリーが空でない。
- preflight が 20（STOP）、または `Killed`（OOM を確かめる）。
- `phase2f-design` が exit 2（拒否。承認は未使用）または exit 1（承認は使った）。exit 1 の後の再試行は、オーナーが別の承認 ID で認めたときだけ。
- 台帳の上限に当たった。
- 包みの段・接着が止まった（そのコードを報告する）。`VISUAL_REVIEW_MISSING` は想定どおりの停止で、目視の番である。
- 生成物に facts に無い主張（価格・予約・受賞など）やテストの値が出ていた：門を緩めず、記録して止まる。

## 6. 元に戻す（出力を消すだけ）

元に戻すのは `$RUN` の下の出力だけである。台帳（`SR_PHASE2F_STATE`）は消さない（承認が二度使われないことを保つ記録）。
リポジトリ・DB・設定には何も書かれていないので、ほかに戻すものは無い。末尾にスラッシュを付けない、明示したパスだけを消す：

```bash
rm -rf -- "$RUN/runs/design" "$RUN/runs/artifact" "$RUN/runs/artifact-result.json" "$RUN/runs/glue-1"
```

関連：`docs/operations/s0-three-shop-directions.md`（6案と pin）、`docs/operations/s0-generation-glue.md`（後段の照合）。
