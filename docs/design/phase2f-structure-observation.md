# Phase 2f の構造の観察 (DEV-138、Issue #175、report-only・offline)

- 比較: `lib/design-agent/structure/observe.ts` (`observeStructure`)
- 実行: `scripts/design-artifact/phase2f-structure-observe.ts`
- 参照: `design-library/intelligence/v02/structure-descriptors-v0.json` (DEV-136、宣言・仮)

## 範囲 (オーナー承認: Issue #175)

**作り終えた Phase 2f の package を、あとから観察するだけ**の別の段である。

- package の試作 (`quarantine/index.html`・`style.css`・`assets/*.png`) を、JS 無効・閉じた origin で PC 1440 と
  SP 390 にもう一度描き、描画から測れる構造だけを、成功例と不採用例の宣言された構造と比べる
- 報告は `--out` に書く。**package の中には書かない** (書くと intake の未申告ファイルになる)。`..` で始まる名前や、
  リンクを経由した道でも断る (実体のパスで比べる)。既存の報告も上書きしない
- package から読むのは通常のファイルだけ (リンクは読まない。`quarantine/` と `assets/` もリンクなら拒否)。大きさの上限は artifact.json 1 MiB・HTML 384 KiB・CSS 256 KiB・画像 16 MiB (artifact schema と同じ値)
- package のファイル (画像・prototype・artifact.json) は1バイトも変えない (テストで固定)
- runner・prompt・設計の port・intake・承認・停止条件は変えていない。参照データは prompt にも設計の入力にも入らない
  (構造モジュールの隔離テストが、取り込めるのを観察の CLI 1つだけに固定する)
- gate・retry・新しい閾値は無い (閾値は descriptor.ts の仮のものを再利用)

```
npx tsx scripts/design-artifact/phase2f-structure-observe.ts --package <artifact dir> --out <report.json> [--references <json>]
```

## 報告の形 (`structure_observation_v0`)

| 欄 | 意味 |
| --- | --- |
| `status` | `observed` か `check_failed` (測れなかった。結果なしであり、合格ではない) |
| `check_failed` | `{ code: MEASURE_PAGE_REFUSED \| MEASURE_FAILED \| BROWSER_LAUNCH_FAILED, detail }` (detail はエラーの1行目、パスを伏せ 160字まで) |
| `viewports.desktop_1440` / `mobile_390` | 幅ごとの観察 |
| ・`measured` | 描画から測れた観点だけ (すべて measured) |
| ・`unknown_aspects` | 測れなかった観点。**候補には何も宣言しない** (Hero と流れは汎用 LP の印が測れたときだけ分かる) |
| ・`generic_skeleton` | 汎用 LP の印が2つ以上そろったときの理由。無ければ null |
| ・`too_close_to_success` | 成功例の骨格と 0.75 以上 (写し) |
| ・`close_to_rejected` | 不採用の版の骨格と 0.6 以上 |
| ・`undecided` | 両方に分かる観点が少なく、比べられない参照。**「近くない」とは数えない** |
| ・`blocked_requests` | ページが外へ出ようとした回数 (拒否して数える) |
| `package` | artifact_id・route・prototype の HTML/CSS の SHA-256 |
| `reference_set` | 参照データのパス・SHA-256・status |
| `advisory: true` / `scope: offline_report_only` / `notes` | 助言であること、仮であること |

## 確かめたこと

テスト (`tests/unit/design-agent/structure/observe.test.ts`、架空のページと架空の参照):

- 汎用 LP は不採用の骨格に近いと出る (汎用の印つき)。SP は SP の描画で測る
- 成功例の骨格をそのまま持つページは写しと出る
- 候補には宣言しない (汎用の印が無いページの Hero と流れは unknown)
- 記述の薄い参照は undecided。それしか無いと、何も判定しない
- 測れないページ (拒否されるマークアップ、閉じたブラウザ) は check_failed と理由
- 本物の参照データでも、汎用 LP は記録された不採用の版に近いと出て、成功例には近くない
- CLI: package の外に書き、package の全ファイルのハッシュが変わらない。上書きしない。package の中への出力・
  試作の無い package (A方式)・引数の誤りは断る

隔離 (`tests/unit/design-agent/structure/structure.test.ts`): 構造モジュールを取り込めるのは、この CLI の正確なパス1つを
足しただけ。CLI の import は観察と参照の schema と node・playwright だけに固定し、phase2f・Codex・ネットワーク・
子プロセスを使わず、書くのは新しい報告1つ (`flag: "wx"`) だけ、と固定した。

### 誤検知の確認 (offline の試作12枚)

DEV-133 の評価で作った架空店舗の試作12枚 (スキルあり・なし) に掛けた。

- 12枚とも `observed`。`too_close_to_success`・`close_to_rejected`・`generic_skeleton` は PC・SP とも 0 件 (誤検知 0)
- 参照38件のうち、判定できたのは多くの試作で3件、残りは `undecided` (35件)。測れる観点だけでは、Hero と流れで
  書かれた参照の多くと比べられない
- つまり今の参照データでは、**この観察が拾えるのは汎用 LP の骨格に近いものくらい**であり、写しの検出力は低い。
  参照の記述を増やすか、候補の Hero と流れを (宣言ではなく) 測れるようにしない限り、それ以上には上がらない

## 限界

- 語彙・閾値・参照のラベルは仮 (Issue #159)。参照は研究記録からの宣言で、原本の無いものが多い
- 再描画の負荷: 1 package につき Chromium で2回描く (PC と SP)。runner の外で、作り終えたあとにだけ走る
- 報告は package に入らない (別ファイル)。artifact の記録 (`observed.checks.structure`) へ載せるのは、
  package を作り直すことになるので、この段ではしていない
