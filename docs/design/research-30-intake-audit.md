# 研究成功30件への統合：追加7件（CP-026〜CP-032）の監査台帳と統合方針

**作成：2026-10-29（DEV-120）／状態：監査と受け入れ準備のみ。研究セットへの登録・件数の変更・PR #142 の変更はしていない。**

## 0. 研究件数の意味（オーナー決定、2026-10-29）

| 区分 | 件数 | 意味 |
|---|---:|---|
| **オーナーが正式採用した研究** | **30** | 下の2行の合計 |
| PR #142 に登録済みで、既存 Adapter で検査できる研究 | 23 | CP-001〜013、CP-015〜024 |
| 採用済みだが、原本未照合・未登録の研究 | 7 | CP-026〜032（この文書と intake ファイル） |

- **原本が未照合であっても、採用の取り消しではない。** 7件はオーナーが採用済みで、その状態を `owner_adopted_originals_not_checked` と記録する。
- intake の `counted_in_registered_dataset: false` は、**研究データセット（PR #142 の manifest、Adapter が検査する登録件数）にまだ加えていない**という意味だけを持つ。採用の有無を表すものではない。旧名の `counts_toward_success` は誤解を招くので改名した。
- 7件が静止画研究かローカル Web 試作かは、まだ分からない（`research_form: unknown`）。HTML や PC/SP の全ページ実装があるとは仮定しない。原本で形式が分かったら（採用画像を記録してから）、存在しない成果物だけを `not_implemented`（未実装）と記録する。何が存在するかは原本で確かめる。例えば静止画研究なら HTML と ZIP は通常存在しないが、全ページの画像があるかどうかは原本次第で、決めつけない。

## 1. 基準（読み取りで確認した事実）

| 項目 | 値 |
|---|---|
| develop | `f8ebaf734522e31305b138748ed381fc91c9f983` |
| 研究 PR #142 の HEAD | `efe269f4b4a13f3c05bfb799891c8157c9be4c0b`（未マージ。最新コミットは CP-025 の不採用と v3 の記録） |
| 研究成功（manifest と success-patterns） | 23件：CP-001〜013、CP-015〜024 |
| 内訳 | HTML/CSS/JS ローカル PoC 10件、画像のみ 13件 |
| 成功に含まないもの | CP-014（未採用）、CP-025（評価待ち・v1/v2 は不採用） |
| 参考候補 | 80件（未審査） |
| 審査待ちキュー | 20件 |

既存の Design Intelligence Adapter（`scripts/design-intelligence/brief.ts --summary`）を PR #142 のチェックアウトに対して実行した結果も同じだった（23 / 10 / 13 / 80 / 20）。読んだファイルの SHA-256 は次のとおり。

- manifest.json：`bd503a3b…d638da`
- success-patterns.json：`cacabc3a…ac37a4`
- review-queue.json：`0c74a8f7…3e05be6`

`validate.mjs` も PASS した。

**CP-026〜CP-032 と、その店名は、develop にも PR #142 にもまったく存在しない**（`git grep` で確認）。manifest の方針どおり、原本の画像・HTML・ZIP は ChatGPT の会話側にあり、GitHub にはない。

## 2. 監査台帳（7件 × 必要な証拠）

凡例：「採用（オーナー）」列の ✅ はオーナーの決定（原本の照合ではない）／その他の列の ✗ は不足（原本未照合）。PC/SP 全ページ・HTML・ZIP の ✗ は「未受領」で、「存在する」という意味ではない。形式が分かったら、存在しないものは「未実装」と記録する。

| ID | 店名・版 | 採用（オーナー） | 採用の発言原文 | 採用画像 | PC 全ページ | SP 全ページ | HTML | ZIP | SHA-256 | デザイン分析 | 不採用履歴 | 業種 | Web有無・出典 | 権利 | Identity Lock |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CP-026 | Sawaddee Chao v5 | ✅（オーナー決定） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗（v1〜v4 の扱い不明） | ✗ | ✗ | ✗ | ✗ |
| CP-027 | MATO OBJECTS STORE v2 | ✅（オーナー決定） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗（v1 不明） | ✗ | ✗ | ✗ | ✗ |
| CP-028 | ユメツナベース v1 | ✅（オーナー決定） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| CP-029 | SNOWMY v4 | ✅（オーナー決定） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗（v1〜v3 不明） | ✗ | ✗ | ✗ | ✗ |
| CP-030 | 高田時計店 v2 | ✅（オーナー決定） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗（v1 不明） | ✗ | ✗ | ✗ | ✗ |
| CP-031 | リフォーム 中村 v3 | ✅（オーナー決定） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗（v1〜v2 不明） | ✗ | ✗ | ✗ | ✗ |
| CP-032 | 幸せを呼ぶ玉虫屋 v1 | ✅（オーナー決定） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

**採用はオーナーの決定として確定している。原本で照合できた項目は0。** 分かっているのは、オーナーの指示（2026-10-29）に書かれた「ID・店名・版・採用済み」だけである。静止画研究かローカル Web 試作かも分からないため、30件の静止画 / Web 試作の内訳も未確定。

機械で読める同じ台帳は `design-library/research-intake/cp-026-032.json` に置いた。

- 証拠は全項目を `missing`、形式を `research_form: unknown` にしている。`counted_in_registered_dataset: false`（登録件数にまだ加えない）、`approval_for_generation: false`。
- 検査は `lib/design-agent/intelligence/intake.ts` で行う。
  - 「確認済み」という状態を持たない（ファイルを照合する仕組みが無いので、照合したと書けないようにしてある）。
  - 登録済みの ID と、CP-014・CP-025 との重複を拒否する。登録済みの ID は呼び出し側が渡すので、検査の強さはその一覧次第（§4）。今はテストが固定の一覧を渡している。
  - 研究セットへの昇格は常に不可と報告する。
- Adapter もその CLI もこのファイルを読まない（テストで固定）。

## 3. 原本から受け取る必要があるもの（1件ごと）

1. **採用の発言の原文**と日付（例：「成功例とします」）。採用したのがどの版かが分かる形で受け取る。
2. **研究の形式**：静止画研究か、ローカル Web 試作（HTML/CSS/JS）か。
3. **採用画像**とその SHA-256（静止画研究ならコンセプト画像、Web 試作なら画面のキャプチャ）。
4. **あるものだけ**：PC 全ページ・SP 全ページのキャプチャ、HTML、ZIP と、その SHA-256。無いものは「未実装」と記録し、作ったり補ったりしない。
5. **不採用・比較した版**（v1〜vN-1）の扱いと理由。画像の SHA-256 があればそれも受け取る。
6. **デザイン分析**：店固有の要素、構造への翻訳、視覚の仕組み、採用理由、既知の失敗、コピー禁止事項、実装との差。既存の success-patterns と同じ項目を埋める。
7. **業種**（例：`thai_restaurant`）。
8. **店の Web 有無と出典**：公式サイト、EC、SNS の外部リンクを確認済みか。
9. **権利**：生成写真か、店の素材か、利用許可の有無。
10. **Identity Lock**：店名と業種のすり替わりが無いことの目視結果（REJECT / HOLD / PASS_IDENTITY_ONLY）。

1・2・3・6・7 が揃えば、既存の23件と同じ形式で研究成功として登録できる。8〜10 は営業や本番への利用の条件なので、研究成功の登録では「不足」として記録すればよい。既存の事例でも、5/23件は営業の条件（SNS のリンク未確認）が HOLD のまま登録されている。ただし、Identity Lock や権利の欄を持つ既存事例は無い。

## 4. 既存データを壊さない統合方針

- **既存の23件、参考80件、審査待ち20件は変更しない。** 追加は新しいレコードの追記だけにする。
- **未照合の7件を manifest や success-patterns に入れない。** Adapter は次の場合に読み込みを止める（安全側の停止）。
  - manifest と success-patterns の ID が一致しない（`CORPUS_REGISTRY_MISMATCH`）。
  - 成功以外の状態のレコードがある（`CORPUS_NOT_AN_OWNER_SUCCESS`）。

  したがって「保留」のレコードを足すだけで、23件の研究資料まで読めなくなる。7件は別ファイル（intake）で管理する。
- **1件ずつ昇格する。** 原本と照合できた1件について、次の3つを同じコミットで追加する。PR #142 の続きか、その上に積む研究 PR で行う。
  1. `success-cases/CP-0xx-*.md`（採用記録）
  2. manifest のレコード（成功の状態と SHA-256）
  3. success-patterns の分析
- **昇格したら intake から外す。** intake の検査は、呼び出し側が渡した「登録済みの ID」と重なる ID を拒否する。今はテストが固定の一覧（CP-001〜024、CP-014 を除く）を渡しているだけなので、外し忘れを自動で見つけるには、昇格の PR で PR #142 の manifest の ID を渡す検査を足す必要がある（次のタスク1）。
- 採用済みは最初から30件。**登録件数**が30件になるのは、7件すべてが昇格したときだけ。途中は「採用30件のうち、登録済み 23 + n件、未登録（intake）7 − n件」と報告する。
- 選択台帳（Selection Ledger）への記録（版ごとの採用・不採用と発言原文）は、昇格した後に partial モードで追加できる。台帳は manifest にある事例しか受け付けないので、昇格前には使わない。

## 5. 研究用 `validate.mjs` の固定値（PR #142 側。今回は変更しない）

固定値に依存しているのは次の2つ。

- `cases.length === 23`（"case count/IDs do not match pilot"）
- `implementation === "local_html_css_js_poc"` の件数が `=== 10`（"PoC counts ambiguous"）

審査待ちキューの 20 / 10 / 10 は今回の追加と関係がないので、そのまま残す。

30件に対応する最小修正の案（研究 PR 側で、7件の昇格と同じ PR に入れる）：

```js
// 件数は固定しない。既存の23件が ID ごとに残っていること、manifest と success-patterns が
// 同じ ID を持つこと、事例ごとに view と implementation が一致することを確かめる。
const BASELINE_23 = ["CP-001","CP-002","CP-003","CP-004","CP-005","CP-006","CP-007","CP-008","CP-009","CP-010","CP-011","CP-012","CP-013",
  "CP-015","CP-016","CP-017","CP-018","CP-019","CP-020","CP-021","CP-022","CP-023","CP-024"];
const byId = new Map(manifest.records.map(r => [r.id, r]));
assert(unique(cases.map(x => x.id)) && unique(manifest.records.map(r => r.id)), "duplicate case IDs");
assert(cases.length === manifest.records.length && cases.every(x => byId.has(x.id)), "case count/IDs do not match registry");
assert(BASELINE_23.every(id => byId.has(id)), "a baseline case was removed or renamed");
assert(!byId.has("CP-014") && !byId.has("CP-025"), "CP-014 / CP-025 are not successes");
const pocView = (v) => /html_css_js/.test(v); // Adapter の implementationFromView と同じ規則
assert(cases.every(x => pocView(byId.get(x.id).view) === (x.implementation === "local_html_css_js_poc")), "implementation does not match the manifest view");
const poc = cases.filter(x => x.implementation === "local_html_css_js_poc").length;
console.log(`PASS: ${cases.length} research success patterns (${poc} PoC, ${cases.length - poc} image only); ...`);
```

- 既存の23件は ID の一覧で守る。件数の下限だけだと、既存の1件を新しい ID に置き換えても通ってしまう（レビューで再現）。この案では、CP-024 を CP-026 に置き換えると "a baseline case was removed or renamed" で止まることを確認した。
- 23件の中身（各フィールド）の改変は、この案では検出しない。必要なら、既存の23件の manifest レコードの SHA-256 を固定する検査を別に足す。
- PoC の判定は事例ごとに、Adapter の `implementationFromView` と同じ規則（`/html_css_js/`）で view と implementation を照合する。既存の23件で PoC 10件・画像のみ13件になり、PASS することを PR #142 のファイルで確認した（manifest の view は10種類）。

## 6. 研究データを生成器へ直接渡さない方法

- 研究データ → **Adapter**（`lib/design-agent/intelligence/corpus.ts` / `brief.ts`）→ 研究ブリーフ（JSON）。ブリーフは人と Claude が読むためのもので、生成器はこれを読まない。
- Adapter は次の性質を持つ。
  - 件数を固定せず、各ファイルの SHA-256 を出す。
  - 成功の状態・ID の一致・方針の文言を照合する。
  - 研究の文章は「データ」として扱い、制御文字や指示の囲みを拒否する。
- intake（今回）は Adapter のディレクトリにあるが、Adapter のどのモジュールも CLI も読まない（テストで固定）。昇格した事例だけが Adapter を通る。
- 研究ありの B 方式で比較するときは、次の手順を踏む。
  1. Adapter のブリーフから、使う事例と項目（構造への翻訳、コピー禁止事項など）を人が選ぶ。
  2. 選んだ内容を、プロンプトの別の版として SHA-256 と文字数を固定する。
  3. 承認 ID を付けて実行する（Phase 2f-2 の承認台帳を使う）。

  研究なしの B（プロンプト `a2fdd003…7954`）は比較の基準として変更しない。

## 7. 架空菓庵 B 方式のベースライン記録（計画のみ）

報告では、retry-1 は「Codex による生成は成功、正式な Artifact の作成で停止、研究なし、品質は不合格」だった。このうち**「品質は不合格」は ChatGPT による暫定評価**で、オーナー本人の最終的な採否の判断とは分けて記録する。記録する値は WSL の出力から写す。作り話はしない。今回は値が手元に無いので、ファイルは作っていない。

記録する項目：

- 承認 ID：`wagashi-b-design-20261029-02`（オーナーの申告値。リポジトリでは未照合）
- retry-of：`-01`
- 枠：retry-1
- run_id
- プロンプトの SHA と文字数：`a2fdd003…` / 5706
- コミット：`f8ebaf73…`
- tool_version と model_reported（`generation.json` から）
- 設計の `call.json` の状態
- Artifact 化で止まったコード（`--package` の出力、または結果 JSON の stop code）
- PC1440 と SP390 の画像が出ていれば、その SHA-256
- 品質の評価は2つに分けて記録する。
  - `provisional_evaluation`：ChatGPT による暫定評価（現時点では不合格）、評価の観点、評価した日時。
  - `owner_final_decision`：オーナー本人の最終判断（採用 / 不採用 / 未判断）と、発言の原文。オーナーが判断するまでは `pending` とし、暫定評価をオーナーの判断として扱わない。
- `research_used: false`

置き場所の案は `design-library/phase2f/baselines/wagashi-b-20261029-02.json`。必要なら小さな schema と検査を付ける（次のタスク）。失敗の記録・台帳・成果物そのものは書き換えない。

## 8. 今回変更していないもの

- PR #142 とそのファイル（validate.mjs を含む）。
- 既存の23件、参考80件、審査待ち20件。
- main、Vercel、Supabase、営業 AI、worker、bridge、jail。
- Codex と画像生成（実行していない）。
- B 方式の承認台帳と失敗記録。
