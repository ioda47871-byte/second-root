# DEV-139 Stage 0 (A-4) — ローカル DB の架空 seed 計画（未実行・要オーナー承認）

更新日：2026-11-17。基準：`develop` の `88597749`。**この文書は計画であって承認ではない。**
ここに書いたコマンドは、オーナーが「localhost の隔離された Supabase に架空データを足す」実行を個別に承認するまで**走らせない**。
この PR でも、どの DB にも書いていない（CI が自分の使い捨てローカル Supabase で統合テストを走らせるだけ）。

実装：`lib/demo-version-package/seed-s0.ts`、`scripts/sales/demo-version/s0-local-seed.ts`。
テスト：`tests/unit/sales/s0-local-seed.test.ts`（DB なし）、`tests/integration/s0-local-seed.test.ts`（CI の使い捨てスタック）。

## 1. 住所の不一致をどう解いたか（identity gate は不変）

PR #280 の `loadVerifiedGenerationFacts` は、候補の `sales_prospects.name`・`address` が facts pack の `name`・`address` と
**完全一致**することを求める（`PROSPECT_FACTS_IDENTITY_HOLD`）。この検査には手を入れていない。

| 店 | 結論 |
| --- | --- |
| 環 `fictional-bicycle-repair-tamaki` | **登録側では一致させられない。** スキーマの `sales_prospects_nagoya`（`normalized_address like '愛知県名古屋市%' and address like '%名古屋市%'`）が「架空市架空区架空町二丁目3-5」を拒む。だから既存 seed は仮住所 `SENDABLE_REGISTRY_ADDRESS` で、#280 は HOLD する。直すには (a) 制約を変える migration（Protected Scope）か、(b) 環 の facts の住所を変える（facts SHA が変わり、`page/index.html`・`copy.json`・`copy-review.json`・`step2-review/review.json` の HTML/copy の SHA と目視レビューがすべて無効になる）しかない。どちらも採らない。**環 は今のまま**で、STEP 2 の記録と e2e はそのまま通る。環 の HOLD は「同一性の不一致」の実例として統合テストで確かめる。 |
| Stage 0 の架空パン屋 `fictional-bakery-hoshigama`（A-2 が作った `design-library/research/quality-pipeline/poc/bakery/facts-pack.json`。A-2 の branch と同じバイト） | 住所「名古屋市瑞穂区架空町四丁目2-6」は名古屋の書式の架空の町で、品書きは `service_N`（facts の経路が写す鍵）。だから**登録行を facts から導く**（`s0RegistryRow`）。`name`・`address` は facts の値そのもの。正規化した鍵（`normalized_name`・`normalized_address`）だけ ingest と同じ正規化で作る。店の値はコードに書かず、pack から読む。 |

facts の経路（`demoContentFromFactsBytes` と DB の `sales_derive_facts_demo_content`）は `service_N`・`statement_N` しか写さず、
`menu_item_` は `TRUSTED_FACTS_UNMAPPED_KEY` / `facts_pack_unmapped_key` で止まる。seed は、facts の経路が拒む pack・名古屋の書式でない住所・
登録の業種（bakery / baked_goods / cafe）でない業種・`fictional-` でない shop id を、何も書く前に拒む。
pack の SHA は `d46adc81bee7b7096e47f57091d88df348ac37cf389d7cce071a76f634fcf715`。

## 2. 書き込む行（1トランザクション、すべて架空）

固定の prospect id：`13900000-5e00-4d00-8a00-000000000001`。`plan` サブコマンドが同じ内容を接続なしで出す。

| 表 | 行数 | 書き方 | 列と値 |
| --- | --- | --- | --- |
| `sales_prospects` | 1 | seed が直接 insert（DB の所有者の接続） | `id` 上記 / `name` `架空パン店 ほし窯` / `normalized_name` `架空ぱん店ほし窯` / `address` `名古屋市瑞穂区架空町四丁目2-6` / `normalized_address` `愛知県名古屋市瑞穂区架空町4-2-6` / `ward` `瑞穂区` / `category` `bakery` / `website_status` `present` / `website_url` `https://s0-bakery.example.com/` / `website_domain` `s0-bakery.example.com` / `public_email` `info@s0-bakery.example.com` / `recommended_channel` `email` / `do_not_contact` `false` |
| `sales_sources` | 1 | seed が直接 insert | `field` `email` / `value` `info@s0-bakery.example.com` / `source_url` `https://s0-bakery.example.com/contact` / `source_type` `official_contact` / `verified_at` now()（メールの出典検査は commit 時） |
| `sales_demos` | 1 | 既存の `sales_onboard_facts_demo(…, 'operator_cli')` | `template` `bakery_v1` / `content` = facts バイトから DB が導いた内容（`facts_pack` `fictional-bakery-hoshigama`、`facts_pack_sha256` 上記 SHA）/ `expires_at`・`disabled_at` null |
| `sales_demo_facts_packs` | 1 | 同じ onboarding が `sales_insert_facts_pack` で | `facts_pack_text` = pack のバイトそのもの / `facts_sha256` 上記 / `shop_id` `fictional-bakery-hoshigama` / `recorded_by` 指定した管理者 / `recorded_via` `operator_cli` |
| `sales_outreaches` | 1 | seed が直接 insert | `kind` `initial` / `channel` `email` / `status` `drafted` / `subject` `ホームページのご提案` / `body` 「はじめまして。…（架空の店の確認用の下書き。送信しない）」 |

合計 5 行。auth ユーザー・承認・送信・版・画像は作らない。宛先は RFC 2606 の予約ドメインで誰にも届かない。
挿入した id はすべて記録ファイル（`s0_local_seed_record_v1`、**repo の外**、リンク不可）に書く。新しいファイルは排他的に作る（`wx`、mode 0600）。
既にあるファイルは、まったく同じ記録のときだけそのまま（`unchanged`）、違えば上書きせず `S0_RECORD_FILE_DIFFERS`（ids は標準出力に出るので失われない）。
seed の前に、既存のファイルが S0 の記録でなければ接続せずに `S0_RECORD_FILE_NOT_S0`。
2回目は同じ id を返す（`created: false`）。固定 id の行が seed と違えば `S0_SEED_ID_TAKEN` で何も書かない。

## 3. スイッチ（DB の所有者のローカルのもの）

| スイッチ | 扱い | 理由 |
| --- | --- | --- |
| `sales_facts_registration_settings.operator_cli_enabled` | **seed が自分のトランザクションの中で** onboarding の直前に on、commit の前に off。手で切り替えない | `sales_onboard_facts_demo(…'operator_cli')` が要求する。途中で失敗すれば rollback で元の値に戻る（統合テストで確認） |
| `sales_local_test_settings.local_test_recipients_enabled` | **off でなければ seed は `S0_LOCAL_TEST_RECIPIENTS_ON` で何も書かない** | off なら架空の店（`content.facts_pack` が `fictional-`）への送信承認を DB が `test_recipient_fictional_shop` で拒み続ける（統合テストで確認）。Stage 0 では送信承認を通さない |
| `sales_demo_share_settings.versioned_sharing_enabled` | **off のまま** | 版での共有は不要 |

`.env.local` の `SALES_LOCAL_E2E_TEST_RECIPIENTS` も入れない（入れてもローカル DB のスイッチが off なら止まる）。

## 4. コマンド（承認後に、この順で）

前提：runbook Part A の A-1（`npx supabase start`、`.env.local`）と A-2 の「1 の管理者」（`ADMIN_ID`・`ADMIN_EMAIL`・`ADMIN_PW`）。

```bash
export SUPABASE_DB_URL="$(npx supabase status -o json | jq -r .DB_URL)"   # 127.0.0.1 / localhost 以外なら seed は接続前に止まる
REC="$HOME/s0-seed-record.json"                                           # repo の外

# 0. 書かずに確認
npx tsx scripts/sales/demo-version/s0-local-seed.ts plan

# 1. seed（旗が無ければ、またはローカル以外の URL なら、接続前に止まる。facts CLI のスイッチは seed が中で扱う）
npx tsx scripts/sales/demo-version/s0-local-seed.ts seed --admin "$ADMIN_ID" --record "$REC" --owner-approved-local-seed

# 2. #280 の読取（読むだけ。管理者のセッションで RLS を通す。server-only のため react-server 条件で起動）
S0_ADMIN_PASSWORD="$ADMIN_PW" NODE_OPTIONS=--conditions=react-server \
  npx tsx scripts/sales/demo-version/s0-local-seed.ts verify --admin-email "$ADMIN_EMAIL"
#   → {"status":"OK", "facts_sha256":"d46adc81bee7b7096e47f57091d88df348ac37cf389d7cce071a76f634fcf715", ...}。違う SHA なら S0_READ_SHA_NOT_COMMITTED

# 3. 版の取り込み（この facts SHA で作った v2 包みができてから。C-6 の生成の後）
npx tsx scripts/sales/demo-version/import-local.ts --package <pkg-dir> --prospect 13900000-5e00-4d00-8a00-000000000001 --facts-from-store

# 4. 管理画面
npm run build && npm run start
#   http://127.0.0.1:3000/admin/login → http://127.0.0.1:3000/admin/sales/demos/13900000-5e00-4d00-8a00-000000000001
#   今日の画面：http://127.0.0.1:3000/admin/sales

# 5. 片付け（記録した行だけ。3 の取り込みや画面の操作をした後は --include-imported が要る）
npx tsx scripts/sales/demo-version/s0-local-seed.ts cleanup --record "$REC" --owner-approved-local-seed [--include-imported]
```

3 は**いまは実行できない**：この facts SHA で作った包みはまだ無い（新しい B-route 生成は承認待ち）。
環 の包みは facts が違うので、この候補には取り込めない（`--facts-from-store` で `COPY_FACTS_NOT_FROM_FACTS_PATH` で止まる）。

### 片付けの保証

- 記録ファイルは `s0_local_seed_record_v1`・prospect id がこの固定 id・`fictional-` の shop id・各表 uuid 1つ・余分な鍵なし、でなければ `S0_RECORD_INVALID`（ほかの店の行は消せない）。facts の SHA か shop id が今の pack と違えば `S0_RECORD_FACTS_MISMATCH`。
- prospect がまだ seed のまま（名前・住所・メール）でなければ `S0_CLEANUP_PROSPECT_NOT_SEED`。
- 記録に無い行が seed の表にあれば（例：画面で facts を登録し直した）`S0_CLEANUP_UNRECORDED_ROWS`（表ごとの件数を出す）。
- 取り込み・管理画面の操作で増えた行（版・ファイル・品質/文章の審査・承認・メモなど）があれば、`--include-imported` なしでは `S0_CLEANUP_IMPORTED_ROWS`。
- **外部キーは最後まで効いたまま。** `pg_constraint` から、5つの seed の表を参照する外部キーを DB 全体から集め、seed の表と既知の取り込みの表以外
  （例：`sales_ig_threads.prospect_id`、`on delete set null`）から参照があれば `S0_CLEANUP_UNKNOWN_REFERENCES` で何も消さない。
- 1トランザクション。trigger を切るのは**追記のみの表**（facts の保存先・版・審査の表。delete を拒む user trigger がある）の **user trigger だけ**、
  その表の delete 1文の間だけ（`alter table … disable trigger user` → delete → `enable trigger user`）。外部キーの trigger は切らない。
  各 delete はこの prospect の1行に当たること。そのあと同じ外部キーで参照が0件、この prospect の行がどの表にも残っていないことを確かめてから commit。どこかで違えば全部 rollback。
- **Storage のファイルは消さない**。`--include-imported` の出力 `storage_prefixes_left` が 0 でなければ、取り込んだ版のファイルが
  private bucket に残っている（ローカルの `npx supabase stop --no-backup` で消える）。

## 5. 期待する管理画面の状態

| 状況 | 画面 | 根拠 |
| --- | --- | --- |
| seed 直後（版なし） | デモの画面に「店舗の事実」が登録済み（SHA 上記）。版は無い。今日の画面に架空パン屋の下書き | seed の行 |
| 送信承認を押す | **拒否**：「架空の店（動作確認用）のデモなので送信できません。」 | DB の `test_recipient_fictional_shop`（スイッチ off。統合テストで確認） |
| 版を取り込んだ後 | 版は品質承認待ち・文章はオーナー確認待ち。`sendable: false` のまま | 既存の品質・文章の門 |
| 品質承認した版があるのに文章が未承認 | 「デモの文章をオーナーが確認（承認）していないため送れません。」 | `demo_copy_owner_confirmation_missing` |
| stale SHA（facts を登録し直した） | 「品質承認した版を作った後に店舗の事実が変わりました。…」／文章：「店舗の事実の保存先の今の事実が、文章の監査に使った事実と違うため送れません…」。#280：別の SHA を返す（pin した SHA と違う）、デモ内容が古い SHA のままなら `TRUSTED_FACTS_SHA_MISMATCH` | `demo_facts_changed` / `demo_copy_facts_changed` |
| DNC | 送信は「この店舗は営業不要（DNC）のため送れません。」。#280：`PROSPECT_DNC_OR_UNKNOWN` | `do_not_contact` |
| 除外リスト（名前+住所／ドメイン） | 「除外リストに一致するため送れません。…」。#280：`PROSPECT_EXCLUDED_OR_UNKNOWN` | `excluded` |
| デモの期限切れ・無効 | 送信は「デモが無いか無効のため送れません。」（無効の場合）。#280：`DEMO_NOT_ELIGIBLE` | `demo_unavailable` |
| 誤った事実（デモの内容が facts と違う） | #280：`TRUSTED_FACTS_CONTENT_MISMATCH`。名前/住所が違えば `PROSPECT_FACTS_IDENTITY_HOLD`（環 の seed もこれ） | #280 |

画面の文言は `lib/sales/approval.ts`・`lib/sales/copy-review/labels.ts`・`lib/sales/demo-version/admin-messages.ts`・
`lib/sales/test-recipient-labels.ts` のもの。HOLD を画面で再現するには DB の行を変える必要があり、それも書き込み（承認の範囲に含めるかはオーナーが決める）。

## 6. 何を証明したか／していないか

- 単体（DB なし、ここで実行）：旗なし・ローカル以外の URL・クエリ文字列・`PG*` の host 変数を接続前に拒む（CLI をプロセスとして起動して確認）。
  記録ファイルは repo の外・リンク不可・排他的に作成・違う記録で上書きしない。登録行が facts と完全一致し、名古屋の制約を満たす。#280 の本物の関数が、
  計画した行で成功し、環 の仮住所と1文字違いの住所では HOLD する。
- 統合（**CI の使い捨てローカル Supabase で後で走る。この container では走らせていない**）：seed が計画どおりの 5 行を書き、
  2回目は同じ id、facts CLI のスイッチは seed の後 off。途中失敗（onboarding が拒む）で行もスイッチも元どおり。テスト宛先のスイッチ on なら何も書かない。
  off なら送信承認は `test_recipient_fictional_shop`。未知の管理者では何も書かない。
  #280 が管理者のセッションで成功し、非管理者は RLS で見えない。
  HOLD：DNC、除外（名前+住所、ドメイン）、期限切れ・無効、同一性（1文字違い、環）、stale SHA、デモの事実の変更。
  片付けは記録した行だけを消し、ほかの架空店（環）は1行も変わらず、facts の保存先の追記のみ trigger は戻っている。
  取り込みの行（`sales_prospect_insights`）は `--include-imported` なしでは拒み、ありなら一緒に消す。
  `sales_ig_threads` からの参照は拒む。記録に無い行・改ざんした記録（ほかの店の demo id、別の prospect、別の SHA）・seed でなくなった prospect では何も消さない。
- していない：実 DB への seed、版の取り込み、管理画面の目視、送信。新しい生成。版を取り込んだ後の `--include-imported`（取り込みは Storage を要し、CI の統合スタックは Storage 無しで走る）。

## 7. 未解決

1. 既存の three-methods のパン屋と `design-library/phase2f/wagashi-facts-pack.json` の菓子店の pack は facts の経路に入らない（`menu_item_N`）。
   生成と DB への取り込みには A-2 の `poc/` の pack（`service_N`）を使う。
2. 架空カフェの facts も、住所は「名古屋市○○区架空町…」の書式、品書きは `service_N` であること（でなければ同じ2つで止まる）。
3. 環 を DB→admin の縦断に使うことはできない（#280 が HOLD）。環 は runbook Part A（#280 を通らない既存の流れ）の確認用に残る。
