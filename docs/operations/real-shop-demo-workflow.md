# 実店舗のデモを作る手順 (DEV-263h、Issue #263)

実在の店のデモの版 (写真なし) を、**リポジトリに店のデータを入れずに**作り、管理画面で登録・承認するまでの手順。
送信の流れ (品質承認 → 文章の承認 → 送信承認 → 共有 URL → 送信済み) は [`sales-mvp-runbook.md`](sales-mvp-runbook.md) の A-5 と同じ。

**hosted (Staging / Production) で行うには、runbook B のオーナー承認がすべて要る** (migration `20261116000000` を含む)。
この文書は手順であって、承認ではない。

---

## 0. 守ること

- **店のデータ (事実・頁・文章・描画・包み) を git に入れない。** リポジトリは公開されている。PR・Issue・コミットの文にも書かない。
- 事実は**オーナーが確認したものだけ**。推測・未確認の値・口コミ・Web の要約を足さない。
- 写真は使わない (写真なしの版を先に作る。共有できる権利の確かめられた写真は別の承認、MVP_SPEC §7)。AI 生成画像を公開しない。
- 輪 (SR-001) の頁・事実・画像を実店舗に使わない。
- Codex・画像生成・LLM の呼び出しは、この手順に含まない (別の承認)。

## 1. 作業の置き場

どちらか:

- **リポジトリの外** (推奨): 例 `~/second-root-shops/<shop_id>/`
- リポジトリの中の **`.local-shops/<shop_id>/`** (`.gitignore` の `/.local-shops/`。git が追跡しない。`tests/unit/sales/facts-onboarding.test.ts` が、追跡されたファイルが無いことを確かめる)

```
<置き場>/<shop_id>/
  facts-pack.json        # オーナーが確認した事実 (shop_facts_pack_v1)
  comp/                  # 頁: index.html, style.css, copy.json, copy-review.json [, copy-rounds/<i>/]
  renders/               # comp-lane の PNG (PC 1440 / SP 390)
  pkg/                   # package-local の出力 (v2 の包み)
```

- シンボリックリンクでリポジトリの中を指さない (登録の CLI はリンクを拒否する)。
- `git add -f` で `.local-shops/` を足さない。`git status` に店のファイルが出たら止まる。
- 片付けるときは、置き場のディレクトリを名指して消す (末尾に `/` を付けた `rm -rf` は使わない)。

## 2. facts-pack.json を書く

形は `shop_facts_pack_v1` (`lib/design-agent/quality-pipeline/facts-pack.ts`)。**デモの事実に写せる key だけ**を、それぞれ 1 回:

| key | 何か |
|---|---|
| `name` `category` `address` `description` | 1 つずつ、すべて必要。店名・業種・住所・確認済みの紹介文 |\n| `ward` `hours` `closed_days` `access` `phone` `workshop` | 確認できた場合のみ。未確認ならキーを**省略**する |
| `service_1` … `service_999` | メニュー・サービス (番号の順に並ぶ) |
| `statement_1` … | 店の言葉 (番号の順) |

```json
{
  "schema": "shop_facts_pack_v1",
  "shop_id": "<英小文字・数字・-・_ の 2〜41 文字>",
  "facts": [
    { "id": "F1", "key": "name", "value": "<店名>", "source_id": "S1" }
  ]
}
```

- 値は 400 文字まで、**前後に空白を付けない** (付いていれば登録は拒否する)。メールアドレスを値に入れない。
- **未確認の営業時間・定休日・アクセス・電話・ワークショップ・区は `unknown` や空欄の事実で埋めず、キーごと省略する。** その情報をサイトで確定事項として表示しない。\n- この変更は事実の保存・デモ作成を可能にするが、**文章監査の `facts_missing_hours` は引き続き HOLD**。正式な送信には、営業時間を確認するか、別途レビュー済みの安全な承認ルールが必要。門を無断で緩めない。\n- 未対応の key・同じ key が 2 つ・必須 key が足りなければ拒否される (`TRUSTED_FACTS_UNMAPPED_KEY` / `_DUPLICATE_KEY` / `_INCOMPLETE`)。写せない事実は、facts pack に入れない (頁にも出さない)。
- `source_id` はオーナーの確認の出どころ (手元のメモ) を指す番号。出どころの本文はこの JSON に入れない。
- 書いたら、オーナーに値を 1 つずつ見てもらう。**この JSON のバイトがそのまま登録される** (sha256 で照合)。後で 1 バイトでも変えると別の facts になる。

## 3. 頁を作る (写真なし)

1. `second-root-design-director` スキルの手順で方向を決める。成功例 (`docs/design/success-cases-index.md`・`success-principles-v1.md`) を見て、店に固有の Hero と構成を選ぶ。Identity Lock: 店の事実を作らない。
2. `comp/index.html`・`comp/style.css` を B方式で書く (script・外の URL・Web フォントなし、写真の枠を置かない)。
3. `comp/copy.json` (`comp_copy_v1`) に頁のすべての言葉を記録する。`lane` は **`real_shop_proposal`**。事実は `claim_type: fact` (facts pack の値そのもの)、見出しなどの提案は `proposal_pending_review` (`docs/design/comp-lane.md` §1)。創作 (`creative_expression`) は実店舗では使えない。
4. 頁の検査と描画 (PNG はリポジトリの外へ):

   ```bash
   npx tsx scripts/design-artifact/comp-lane.ts --dir <置き場>/<shop_id>/comp --facts <置き場>/<shop_id>/facts-pack.json --out <置き場>/<shop_id>/renders
   ```

   PC 1440 と SP 390 の**全頁を自分の目で最後まで見る** (はみ出し・重なり・切れた文字は機械では見つからない)。`review.json` の見比べは comp-lane.md §3。
5. 文章の監査 (round 0):

   ```bash
   npx tsx scripts/design-artifact/comp-copy.ts --audit <置き場>/<shop_id>/comp --facts <置き場>/<shop_id>/facts-pack.json
   ```

   `owner_review` に届くまで `--revise` → 言葉だけ直す → `--audit` (comp-copy.ts の冒頭)。`hold` / `fail` なら頁を直して最初から。

## 4. 包みを作る

```bash
npx tsx scripts/sales/demo-version/package-local.ts --out <置き場>/<shop_id>/pkg \
  --copy <置き場>/<shop_id>/comp --facts <置き場>/<shop_id>/facts-pack.json
```

`format: sales_demo_version_package_v2`・写真なし であること。

## 5. 事実を登録し、デモの事実を作る (管理画面)

候補 (prospect) は**既存の取り込み** (営業エージェントの run) で登録されたものを使う。名古屋の住所・業種・連絡先の出どころ・重複の規則はそのまま。この手順で候補は作らない。

1. `/admin/sales/demos/<prospect id>` を開く (旗 `SALES_DEMO_VERSIONS_ENABLED` と `SALES_DEMO_QUALITY_REVIEW_ENABLED`)。デモが無い候補でも、この頁に「デモの事実を facts pack から作る」だけが出る。
2. 「デモの事実を facts pack から作る」に `facts-pack.json` の中身を貼り、**内容を確認**。何が起きるか (作る / React のデモの内容を置き換える / 前の facts を置き換える / 変更なし) と事実の一覧が出る。
3. 「候補の登録」と「facts pack」の店名・住所が並んで出る。違うときは警告が出て、別の店の事実でないことを確かめてから「店名・住所の違いを確かめ、同じ店であることを確認しました」に印を付けないと作れない (候補の登録の名前・住所は取り込みの値で、この手順では変えない)。
4. 置き換えなら「今のデモの内容を置き換えることを確認しました」に印を付け、**この事実からデモの事実を作る**。
   - DB (`sales_create_demo_from_facts`) が 1 つの transaction で (DB 自身も admin と FactsPack の規則 (形・id・長さ・使えない文字) を検める。旗は画面を隠すだけ): 事実からデモの内容を作り (サーバーと同じ導き方)、デモを作るか内容を置き換え、同じバイトを店舗の事実として登録する (追記のみ)。
   - 拒否されるもの: 連絡しない (DNC)・除外リスト・同じ shop_id が別の候補にある・輪・無効化されたデモ・送信の承認済み / 送信済み / 共有中のデモ・デザインの処理中・別の shop_id への置き換え。
   - React のデモの内容を置き換えると、React のデモの表示も変わる (業種の値によっては React のデモは出なくなる)。送るのは版だけ。

ローカルの開発では同じことを CLI で (ローカルの DB だけ。DB の所有者の CLI のスイッチが要る。runbook A-2 の 4 (b)):

```bash
SUPABASE_DB_URL="$(npx supabase status -o json | jq -r .DB_URL)" \
npx tsx scripts/sales/demo-version/onboard-local.ts --prospect <prospect id> \
  --facts <置き場>/<shop_id>/facts-pack.json --admin "$ADMIN_ID" [--replace-content] [--identity-mismatch-confirmed]
```

facts pack のファイルはリポジトリの外か `.local-shops/` の下だけ (それ以外は `FACTS_FILE_IN_REPO`)。

## 6. 取り込む

```bash
npx tsx scripts/sales/demo-version/import-local.ts --package <置き場>/<shop_id>/pkg --prospect <prospect id> --facts-from-store
```

出力の `copy.facts_from_facts_path` が `true`。登録した facts と包みの facts pack が別のバイトなら `COPY_FACTS_NOT_FROM_FACTS_PATH` で止まる (何も書かない)。

> ここまではローカルの DB での手順。hosted (Staging / Production) へは、管理画面の版の頁の「版を取り込む」で同じ `pkg` のフォルダを選ぶ (DEV-263i、runbook B-5a)。server が `--facts-from-store` と同じ検査をして版にする。CLI から hosted へは入れない。前提 (migration・private bucket・旗) は runbook B-5a の承認が要る。

## 7. 管理画面で見て、承認する

runbook A-5 の 2〜9 と同じ: PC 1440 / SP 390 の全頁を見る → 品質の 7 項目 → 品質承認 → 文章の確認で「文章を承認」→ 送信承認 → オーナーが自分のメールアプリ / Instagram から送る → 「手動で送信済みにする」。

事実が変わったら: 新しい facts pack で 5 をやり直す (前の facts で作った版は `demo_facts_changed` / `demo_copy_facts_changed` で送れなくなる) → 3〜6 をやり直す。送信の承認後・送信後のデモの内容は置き換えられない。
