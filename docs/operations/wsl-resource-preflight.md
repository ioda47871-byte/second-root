# 実機 resource preflight（WSL のメモリ・swap）

Production / Staging などの設定とは別に、**実機（WSL）で重い処理を始める前**に毎回行う確認。
WSL の使えるメモリが約 2.8 GB しかない状態で、runner と full unit suite を一緒に動かして OOM-kill された実績がある。

重い処理とは次のもの:

- full unit suite（`npm test` / `npx vitest run`）
- Chromium / Playwright（e2e、capture、screenshot）
- design worker（`run.sh`・`photo-poc.sh`。`next build` + preview + Chromium + Codex）
- Codex（`codex exec`）

## 1. 始める前に必ず確認する

```bash
scripts/ops/wsl-resource-preflight.sh
```

`MemTotal` / `MemAvailable` / `SwapTotal` / `SwapFree` を MiB で出し、次のどれかを返す（読むだけで何も変えない）:

| 判定 | 条件（MemAvailable） | すること |
|---|---|---|
| `OK`（exit 0） | 6 GiB 以上 | 重い処理は同時に 2 つまで。テストは `npx vitest run --maxWorkers=2` |
| `SERIAL`（exit 10） | 3〜6 GiB | 重い処理は 1 つずつ。テストは `npx vitest run --maxWorkers=1 --no-file-parallelism` |
| `STOP`（exit 20） | 3 GiB 未満 | 始めない。数字を人に報告し、§4 の確認に進む |

- swap が 0 なら `WARN` を出す。swap がないと、一瞬の山でそのまま process が kill される
- 判定に関係なく、重い処理を無制限に並列化しない。複数の worker、full suite と worker、full suite 2 本などを同時に走らせない
- 迷ったら、worker 数もテストの並列度も 1 に落とす

## 2. 突然 `Killed` されたとき（exit 137 / SIGKILL）

コードの不具合として修正ループに入る前に、OOM-kill かどうかを確かめる:

```bash
scripts/ops/wsl-resource-preflight.sh --oom-check --since "1 hour ago"
```

| 結果 | 意味 | すること |
|---|---|---|
| `OOM_KILL_FOUND`（exit 1） | kernel が OOM で kill した | **resource failure として止まる**。コードを直さない、テストを skip しない、そのまま再実行しない。数字（§1）と kill の行を人に報告する |
| `NO_OOM_KILL`（exit 0） | kernel log に OOM がない | 通常の失敗として原因を調べる |
| `OOM_UNKNOWN`（exit 3） | jail の中などで kernel log が読めない | 人に、jail の外で `sudo journalctl -k --since "1 hour ago" \| grep -iE 'out of memory\|oom-kill\|killed process'` を頼む。分かるまで修正ループに入らない |

## 3. 並列度を落とす方法

- テスト: `npx vitest run --maxWorkers=1 --no-file-parallelism`（ファイルを絞るときも同じ指定）
- design worker: 1 回に 1 job（`run.sh --max=1`、既定）。worker の run を同時に 2 つ起動しない（`run.sh` の lock も同時実行を止める）
- photo PoC / E2E（`SR_PHOTO_E2E=1`）は `next build` を含む。full suite と同時に流さない

## 4. `.wslconfig` は勝手に変えない

`%USERPROFILE%\.wslconfig`（Windows 側）は **Claude が変更しない**。STOP / SERIAL が続くときは、まず次の 3 つを確認する。どれも読むだけ。

1. 今の `.wslconfig` の中身（Windows の PowerShell）:
   `Get-Content $env:USERPROFILE\.wslconfig`（無ければ未設定）
2. Windows の物理 RAM（同じく PowerShell）:
   `[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)`
3. WSL の中で実際に使えるメモリと swap: §1 の `wsl-resource-preflight.sh`

jail の中の Claude からは Windows の drive も PowerShell も見えない（design-wsl-isolation.md）。そのため 1 と 2 は人に頼む。

**`.wslconfig` が未設定か不足していて、Windows 側の RAM にも余裕があるときだけ**、次を**候補として人に提示する**:

```ini
[wsl2]
memory=6GB
swap=4GB
```

- 余裕の目安: 物理 RAM から 6 GB を引いても、Windows 側に 4 GB 以上が残ること（例: 物理 16 GB なら可、8 GB なら勧めない）
- 変更するのは**人が承認した後**だけ。書き換えも人が行うか、人の明示の指示で行う
- 反映には `wsl --shutdown`（Windows の PowerShell）が要る。WSL のすべての distro・jail・worker・Remote Control が止まるので、実行中の run がないことを確かめてから人が行う
- 反映後に §1 をもう一度実行して、`MemTotal` / `SwapTotal` が変わったことを確かめる

## 5. 報告の形

止まるときは、次だけを人に渡す（prompt・Codex の出力・店舗の情報は含めない）:

- `MemTotal / MemAvailable / SwapTotal / SwapFree`
- 判定（`STOP` / `SERIAL`）、または `--oom-check` の結果と kill の行
- 何を始めようとしていたか（full suite / worker / photo PoC など）
- §4 の確認が要るかどうか
