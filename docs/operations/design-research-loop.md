# デザイン研究ループ（Issue #302 P5）

オーナーは Claude アプリでデザインを見て判断するだけにする。記録・レビュー画面・次の準備は Claude が行う。
手順の正本は `.claude/skills/second-root-research-loop/SKILL.md`。ここは仕組みと境界の説明。

## 置き場所

| もの | 場所 | Git |
|---|---|---|
| 研究ログ（来歴・オーナー判断・brief・状態） | `design-library/research-log/` | commit する（メタデータのみ） |
| 生成画像・プレビュー・監査の所見の本文 | `~/sr-runs/review-inbox/`（0700） | 入れない |
| オーナー用レビュー画面 | Claude の scratchpad → private の claude.ai artifact | 入れない |

```
design-library/research-log/
  state.json                         今の店・方向・段階・次の作業・オーナー待ち・次の店のキュー（唯一書き換えるファイル）
  entries/<bundle id>.json           1 回の run: 承認 ID・plan・commit・bundle SHA・各プレビューの SHA と元画像の SHA・監査の点数（書き込み1回）
  decisions/<bundle id>--<n>.json    オーナーの判断（adopt / revise / reject）・原文・理由・残す点・改善点（追記のみ、最新が有効）
  briefs/<shop>-<dN>.md              revise から Claude が書いた改善指示
```

## コマンド（Claude が実行する）

`node --import tsx scripts/design-research/research.ts <cmd>`

- `status` — 再開用の要約。読み取りのみ（テストでファイルが変わらないことを確認）。新しい session は最初にこれを読む（CLAUDE.md）。
- `intake <bundle id> --shop --direction --iteration [--parent]` — inbox の INDEX.json・プレビュー・audit.json を互いに照合してから記録。
- `review-page <entry> --out <dir> [--notes notes.json]` — レビュー画面（HTML + img/）。リポジトリの中には書けない。
- `decide <entry> --decision adopt|revise|reject --words … --reason … [--keep …] [--improve …] [--brief …]`
- `queue-add <shop> --note …` / `next-shop`

## 境界

- 記録は承認ではない。`adopt` はオーナーの選択の記録で、CP-* 研究事例（`design-library/success-cases/`）への登録ではない。
- 画像生成・Codex・worker・pilot・自動起動・承認 ID の発行と消費は、既存の承認ルール（`docs/operations/claude-autonomy.md` §3・§7.8、各承認パケット）のまま。
- 実店舗は記録しない（`fictional: true` だけを受け付ける。DEV-263h）。
