# DEV-139 P0-2b — 店舗固有のB-route生成結果を営業用文章・デモ審査につなぐ

**状態**: コード実装（ローカル／オフライン）。**実Codex/Claudeによる新規デザイン制作、候補DB接続、承認済みプレビューの管理画面表示は未完成。** 関連: Issue #139 / #263、前工程のDraft PR #278。

## 追加した接続

既存の`phase2f`と`art_direction_set_v0`で、店舗固有の３方向の中から選んだ**オリジナルのB-route HTML/CSS**を受け取る。架空店・ローカルでの利用を前提に、以下を順序固定で行う。

1. **factを固定**：既存の`shop_facts_pack_v1`をバイト単位SHA256で特定。元ファイルを更新しない。実店舗は既存`sales_demo_facts_packs`でオーナー登録済みの同一内容でなければ、後段のimport/送信はできない。**source_idだけでは実在性や確認済みの証拠にならない**。
2. **店舗らしさの前提**：既存`scripts/design-artifact/direction-set.ts`の検査をそのまま呼び、店・facts SHA・異なる3方向の構造・成功例参照の入力が`READY_FOR_COMPS`か調べる。通っても生成HTMLが方向に忠実という証明にはならない。
3. **生成結果を文章台帳に変換**：`lib/sales/b-route/derive-copy.ts`が、既存のサーバー`checkArtifactHtml`で静的な安全・表示文字を確認。テキストがfacts packの原文・許された全文/文単位に一致すれば`fact`（出典のF番号付き）、それ以外は`proposal_pending_review`、架空の品質研究レーンだけ`creative_expression`。**曖昧なfact帰属、未対応ラベル、数字や営業時間等の根拠不明な主張は停止**。営業時間・定休日・所在地などのラベルは、構文木で隣接する値（dt/dd、同じ行のth/td、同じ親要素内の直後、直後の兄弟要素）がそのキーのfactと一致するときだけfactに結び付け、記録する本文はページに表示された一致部分とする。隣接しない場合は`LABEL_NOT_ADJACENT_TO_FACT`で停止する。`hidden`属性・`aria-hidden="true"`・`<template>`内の要素は表示されないものとして扱い、隠れたラベルや隠れた部分を含む値には結び付けない。**限界**：HTMLの構文木だけでは、CSS（クラス指定の`display:none`、flexの`order`や`row-reverse`、グリッド配置、画面外への絶対配置、透明色や`font-size:0`など）による非表示・並べ替えを判定できない。そのためラベルで結び付けたfact行はすべて`owner_review_needed: true`とし、PC/SPの目視レビューとオーナー確認を最後の防壁とする（原文と完全一致するfact行は従来どおり）。既存`checkArtifactCopy`が最終判定し、検査ルールを複製しない。
4. **私有のcompとして書き出す**：`scripts/sales/demo-version/from-prototype.ts`が`index.html`/`style.css`/`copy.json`を私有の新ディレクトリ`comp/<方向ID>/`へ書く（次段の`comp-lane.ts`が方向IDをディレクトリ名から読むため）。`status.json`にはprospect ID（任意）、facts SHA、direction-set SHA、選んだ方向ID、HTML/CSS/copy SHA、コピー分類件数（ラベルで結んだ事実行の数`label_bound_fact_lines`を含む。目視レビューでは、この行のラベルと値がPC/SPで隣り合うことを確かめる）、`sendable:false`を保存。
5. **従来の審査へ引き渡す**：次に目視で1440/390全ページを評価し、既存の`comp-copy`・`comp-lane`・`package-local`（PR #278のadapter）へ渡す。品質不十分・文章HOLDなら停止。**このPRだけでv2パッケージが承認されたことにはならない。**

## 既存phase2fデザイン生成器への入力（追加）

`scripts/sales/demo-version/prepare-design-input.ts` は、成功例の原理を参照した既存の`art_direction_set_v0`（各方向がC1〜C7審査を通過）から、既存の`phase2f` **v2**に渡す`direction.json`と`references.json`を作る。プロンプト本文やSHA pinは生成しない。3方向の中から1方向を明示選択するが、固定のLPレイアウトやテンプレートを生成しない。

```bash
npx tsx scripts/sales/demo-version/prepare-design-input.ts \
  --facts "$HOME/second-root-shops/fictional-bakery/facts-pack.json" \
  --directions "$HOME/second-root-shops/fictional-bakery/direction-set.json" \
  --direction-id direction-a \
  --out "$HOME/second-root-runs/fictional-bakery-input"
```

出力は`direction.json`・`references.json`（既存のオーナー許可済みmanifestに由来）・入力SHAを記録した`pin.json`。**参照画像は元の許可済みmanifestに実在する場合のみ候補**であり、方向の文章にCP番号が書いてあるだけでは素材を利用しない。

**プロンプトSHAを作るときは、以下の既存の隔離済みCLIをオフライン・pin表示モードで手動実行する。** 新アダプターから直接import・自動起動はしない。

```bash
npx tsx scripts/design-artifact/phase2f-design.ts --print-pin \
  --route B --prompt-version v2 \
  --facts "$HOME/second-root-shops/fictional-bakery/facts-pack.json" \
  --direction "$HOME/second-root-runs/fictional-bakery-input/direction.json" \
  --references "$HOME/second-root-runs/fictional-bakery-input/references.json"
```

実Codexに進むときはこのCLIの別入口が**オーナー個別承認・prompt hash・commit pin**を要求する。本PRはそれを呼ばず、方向・参照を受け渡すまで。新しいprompt v3、常駐worker、実Codexを有効にしない。

最終的に3方向の各案を実際に生成する段階では、モデル呼び出しの回数・承認と独立視覚評価が必須。方向の構造が異なるだけでは生成サイトの視覚的な多様性や成功品質を保証しない。

## オフラインの実行例

依存関係（`npm ci`）を用意した開発用チェックアウトで、架空の店の私有データを指定する。

```bash
npx tsx scripts/sales/demo-version/from-prototype.ts \
  --facts "$HOME/second-root-shops/fictional-bakery/facts-pack.json" \
  --prototype "$HOME/second-root-shops/fictional-bakery/generated-prototype" \
  --directions "$HOME/second-root-shops/fictional-bakery/direction-set.json" \
  --direction-id direction-a \
  --lane quality_research_fictional \
  --out "$HOME/second-root-runs/fictional-bakery-first"
```

入力の`generated-prototype`には、実際にデザイン生成機構で作られた`index.html`・`style.css`を置く。これらはサンプルテンプレを店名だけ変更したものではないことを、別途ビジュアル審査する。`out`は存在しないリポジトリ**外**ディレクトリとし、パスのリンクを拒否する。実店舗レーンの入力も公開リポジトリ外だけ。

次段で`comp/`を検査する。その検査・オフライン準備のスクリプトは**別PR（PR #278）**にあり、このブランチには含まれない。いきなり`show_owner`の`review.json`を機械生成してはならない。実際のPC/SP全ページを独立確認したレビューが必要で、その後にPR #278側の手順に従う。

既存ローカルSupabase環境での版import/管理画面確認は`docs/operations/sales-mvp-runbook.md`を使い、**登録済みfacts packの同一SHA**で縦断E2Eを証明するまで完了扱いしない。`real_shop_proposal`は新しく作った文章をすべてオーナー提案として扱い、無承認の送信を許可しない。

## テストと限界

- `tests/unit/sales/b-route-derive-copy.test.ts`：架空のパン屋・カフェ・焼菓子店の3種と、事実混入・営業時間・ラベル/安全規則・実店舗レーンを検査。ラベルと値を入れ替えたdt/ddは停止し、隣接する4形を通すことも検査。
- `tests/unit/sales/b-route-private-guards.test.ts`：2つのステージングスクリプトのファイル系ガード（出力の既存・リポジトリ内・シンボリックリンクの親、リンクされた入力、実店舗入力のリポジトリ内配置、方向不一致、入力の途中変更、prospect ID）を一時ディレクトリで検査。
- 機械的な構造差の証明は、成功例と同等の**美観**・コピーの自然さ・候補情報の**事実確認**を保証しない。機械PASSのみで`owner_approval`を付けず、成功例DBへ登録しない。
- **今回未接続**：候補prospect ID→オーナー登録済みfacts取得、既存の実Codex呼び出しポートの限定承認付き稼働、デザインの自動方向選択、新生成ページをv2→DB→管理画面まで完全に通すローカルE2E。これらは次の小PRで行う。
- 禁止：Harissy個別修正の再開、実店舗個別facts/HTMLの公開repo保存、承認されないCodex・画像生成・WSL worker/timer起動、本番DB、公開、Instagram/メール自動送信。
