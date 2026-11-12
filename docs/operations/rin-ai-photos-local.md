# 輪 (SR-001) を AI 写真入りでローカルに再現する — WSL の手順 (DEV-196s)

オーナーが **自分の WSL のユーザー**で、自分で実行する手順。Claude は WSL で何も実行しない。
この手順は WSL の service・isolation・runner・`.wslconfig` を **変えない**。変えないと進めない所に来たら、そこで止まって報告する。

> **DB の変更はこのローカルの stack だけ** (オーナーの決定 2026-11-12)。共有の schema (`supabase/migrations`) は変えない。
> §8 で `scripts/sales/demo-version/local-rin-ai-photos.sql` をこの stack にだけ当てる (架空の輪の固定の id にだけ AI のデモ画像を許す)。
> 元に戻すのは `npx supabase db reset` (この stack の DB を migration から作り直す)。Staging・Production には当てない。

## 0. 前提と影響の一覧

| 項目 | 内容 |
|---|---|
| 誰が | オーナーの普段の WSL ユーザー (worker の利用者でも root でもない)。sudo を使うのは §3 の読むだけのコピーだけ |
| 入力 (変えない) | 輪の AI 写真の run の出力 (`<job-dir>`): `<photo-bundle-dir>` の元の写真 6 枚・`swap/page/`・`swap/renders/`・`swap/rights.private.json`・`swap/swap-summary.json`。`<job-dir>` と `<photo-bundle-dir>` の実際の値は **チャットで受け取って手で入れる** (リポジトリには書かない) |
| オーナーの確認 | §5 の描写の確認のファイル (オーナーが WSL で書いて持つ。Git に入れない) |
| Docker | **必要** (ローカルの Supabase)。オーナーのユーザーで `docker ps` が通らないなら、そこで止める。Docker の導入・設定は WSL の変更なのでオーナーが別に決める |
| ディスク | clone 約 30 MB (pack) / 25 MB (作業木)・`node_modules` 約 0.9 GB・Playwright の Chromium 約 0.6 GB (`~/.cache/ms-playwright`、無ければ)・Docker の image 約 3.3 GB (postgres 1.7 GB・storage-api 1.3 GB・kong 0.2 GB・gotrue 0.1 GB・postgrest 30 MB、無ければ)・DB の volume 約 0.2 GB・一時のコピーと包み 数十 MB |
| メモリ | Supabase (db・auth・rest・storage・kong) 待機で約 0.5 GB・`next dev` 約 1 GB・包みの Chromium 一時に約 0.5 GB。§1 の判定が `SERIAL` なら一つずつ (Supabase を起動したまま、包み → 取り込み → app の順に、重なりなく) |
| port | 54321 (API)・54322 (DB)・3140 (app)。どれも 127.0.0.1 |
| DB | この stack の DB にだけ §8 の patch (check 1 つと関数 1 つ)。`supabase/migrations` は変えない。§13 の `supabase db reset` で元に戻る |
| 残るもの | §13 で消すまで: Docker の image と volume、clone と `node_modules`、`~/.cache/ms-playwright`、一時のコピー (`$T`)。§13 の後に残るのは、消さないと決めた image と cache だけ |
| Git・PR・Issue | 画像・権利の記録・包み・screenshot・鍵を **上げない**。`.env*` も作らない (鍵は shell の変数だけ) |

## 1. resource preflight と checkout

```bash
mkdir -p ~/sr-rin-local && cd ~/sr-rin-local
git clone https://github.com/ioda47871-byte/second-root.git && cd second-root
git checkout <DEV-196s を merge した develop の commit>   # coordinator が伝える 40 文字
scripts/ops/wsl-resource-preflight.sh
```

- `OK` → 進む。`SERIAL` → 進むが重い処理は一つずつ。`STOP` → **始めない** (docs/operations/wsl-resource-preflight.md §1)
- 途中で `Killed` が出たら `scripts/ops/wsl-resource-preflight.sh --oom-check --since "1 hour ago"`。OOM なら resource failure として止まる

## 2. 依存とローカルの Supabase

```bash
npm ci                                   # lockfile どおり。package は変えない
npx playwright install chromium          # --with-deps は付けない (sudo apt = WSL の変更)
docker ps --format '{{.Names}}' | grep '^supabase_.*_second-root$' && echo "STOP: 既に second-root の stack が動いている (共有しない・reset しない)"
npx supabase start -x studio,imgproxy,realtime,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit
```

- Chromium が共有ライブラリの不足で起動しないなら止める (入れるには sudo が要る)
- `supabase start` は image の取得 (初回のみ) と migration の適用を行う。Storage (private の bucket `sales-demo-versions`) は起動する

## 3. 入力を読むだけでコピーする (sudo)

job の出力は worker の利用者の 0700 の下にあるので、読むには sudo が要る。**これはコピーである**: 自分のユーザーの 0700 の一時ディレクトリへの、一時の、private なコピー。§13 で消す。
元は `cp` が読むだけで、書き換えない (atime が更新されることはある)。前後で sha256 を取り、変わっていないことを確かめる。

```bash
O='<job-dir>'                                      # チャットで受け取った job の出力のディレクトリ
B='<photo-bundle-dir>'                             # その中の元の写真のディレクトリ (O からの相対の名前)
T=$(mktemp -d "$HOME/rin-input.XXXXXX")          # 自分の 0700
sudo test -f "$O/swap/swap-summary.json" || echo STOP_NO_SUMMARY
sudo find "$O/$B" "$O/swap" -type f -exec sha256sum {} + | sort -k2 > "$T/before.sha256"
sudo cp -r "$O/swap/page" "$T/page"
sudo cp -r "$O/swap/renders" "$T/renders"
sudo cp "$O/swap/rights.private.json" "$O/swap/swap-summary.json" "$T/"
sudo mkdir "$T/originals" && sudo cp "$O/$B"/*.png "$T/originals/"
sudo chown -R "$(id -un):$(id -gn)" "$T" && chmod -R go-rwx "$T"
sudo find "$O/$B" "$O/swap" -type f -exec sha256sum {} + | sort -k2 | diff - "$T/before.sha256" && echo ORIGINALS_UNCHANGED
ls "$T/originals" | wc -l                          # 6
```

## 4. 鍵を shell の変数にだけ置く

```bash
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE
set -a; . <(npx supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)='); set +a
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" SUPABASE_DB_URL="$DB_URL"
```

`API_URL` が `http://127.0.0.1:54321`、`DB_URL` が `postgresql://…@127.0.0.1:54322/postgres` でなければ、取り込みの script は拒否する (ローカルだけ)。

## 5. 描写の確認 (オーナーが 1 枚ずつ書く)

`depicts_real_product`・`depicts_real_interior`・`depicts_real_equipment` (実在の商品・店内・設備を写しているか) は
**決めつけない**。オーナーが元の写真を 1 枚ずつ目で見て、自分で書く。brief の V6 (文字・ロゴ・ブランドなし) とは別に、
画像ごとの明示の確認が要る。ファイルは WSL の自分の場所 (例: `~/rin-depiction.json`、0600) に置き、Git・PR・Issue に上げない。

```bash
sha256sum "$T/originals"/*.png                    # 6 行。各行の 64 文字を下の sha256 に入れる
```

```json
{
  "schema": "rin_depiction_confirmation_v0",
  "photos": [
    {
      "sha256": "<元の写真 1 枚目の sha256、64 文字>",
      "depicts_real_product": false,
      "depicts_real_interior": false,
      "depicts_real_equipment": false,
      "confirmation": "The admin looked at this image and confirmed it shows no real product, no real shop interior and no real equipment. / 管理者がこの画像を目で確かめ、実在の商品・店内・設備を写していないことを確認した。"
    }
  ]
}
```

- `photos` に 6 枚すべて (1 枚 1 項目)。`confirmation` は上の文をそのまま
- 1 枚でも実在のものを写しているなら、その値を `true` にする。包みは `DEPICTS_REAL` で止まる (取り込まない)
- 載っていない写真 (`DEPICTION_NOT_CONFIRMED`)・どの写真でもない sha256 (`DEPICTION_PHOTO_UNKNOWN`)・形の違い (`DEPICTION_CONFIRMATION_INVALID`) も止まる

## 6. 包む (読むだけ、書くのは `$T/pkg` だけ)

```bash
npx tsx scripts/sales/demo-version/package-local.ts --out "$T/pkg" \
  --page "$T/page" --rights "$T/rights.private.json" --summary "$T/swap-summary.json" \
  --originals "$T/originals" --depiction-confirmation ~/rin-depiction.json \
  --compare-renders "$T/renders" --png-out "$T/full"
```

期待: `"status": "OK"`、`photos` に 15 件 (5 枠 × desktop / tablet / mobile。`mode` は `lossless`、元が 16 bit か ICC 付きなら `lossless_after_srgb8_conversion`、収まらなければ `lossy` と `quality`)、`rewrite_proof.html.refs` が 15、`rights_summary.by_status.ai_demo_internal` が 15、`compare` に desktop_1440 / mobile_390 の画素の差 (`ours` と `research` の大きさ、`differing_pixels`)。
`FAIL` ならその `code` だけを Claude に渡す (例: `RIGHTS_REFUSED`・`AI_DEMO_PROMPT_NOT_APPROVED`・`PAGE_NOT_THE_SWAP_COPY`・`DEPICTS_REAL`・`PHOTO_REF_POSITION`)。出力に owner・同意の記録・private path・出所は出ない。

## 7. seed (架空の輪の店)

```bash
npx tsx scripts/sales/demo-version/import-local.ts --seed-rin --seed-only
```

期待: `{"status":"OK","seeded":true,"prospect_id":"c4d31f24-8c91-4495-8ba1-db4706f438f8",…}` (架空の輪の固定の id。連絡先なし・outreach なし)。

## 8. ローカルだけの patch を当てる

```bash
npx tsx scripts/sales/demo-version/apply-local-rin-patch.ts
```

- 期待: `{"status":"OK","patch":"local-rin-ai-photos","scope":"local only","revert":"npx supabase db reset"}`。何度実行しても同じ (冪等)
- 変えるのは 2 つだけ: table の check `sales_demo_images_real_shop_no_ai_demo` を輪の id のときだけ AI のデモ画像を許す形に、関数 `sales_check_demo_image_write()` を「輪の id で、輪の行に架空の印 (名前・仮の住所・連絡先なし) があるときだけ `ai_generated_demo`、depicts_* がすべて false・出所が正しい・public_web が false のときだけ `ai_demo_internal`、それ以外は `unknown`」に。共有の禁止・変えられないこと・取り消しはそのまま
- `DB_URL_*` (ローカルでない DB)・`RIN_SEED_MISSING` / `RIN_SEED_MARKERS` (§7 の seed がない・印が違う) なら止まり、何も変えない
- 元に戻す: `npx supabase db reset` (この stack の DB と Storage の行が消え、migration どおりに戻る)

## 9. 取り込み

```bash
npx tsx scripts/sales/demo-version/import-local.ts --package "$T/pkg" --seed-rin
```

期待: `"status": "OK"`、`prospect_id` が `c4d31f24-8c91-4495-8ba1-db4706f438f8`、`created: true`、files 19 件 (HTML・CSS・写真 15・描画 2) がすべて upload して照合済み。もう一度実行しても同じ版 (upload なし)。
§8 の patch を当てていなければ `INGEST_REFUSED` で止まり、版・画像・upload は何も残らない。

## 10. 管理者の利用者 (ローカルだけ)

```bash
ADMIN_EMAIL=rin-preview@test.example.com; ADMIN_PW="$(openssl rand -base64 18)"
ADMIN_ID=$(curl -sS -X POST "$API_URL/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\",\"email_confirm\":true}" \
  | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["id"])')
docker exec -i supabase_db_second-root psql -U postgres -c "insert into public.sales_admins (user_id) values ('$ADMIN_ID')"
echo "$ADMIN_PW"                                  # この端末に出るだけ。どこにも書かない
```

## 11. app (preview の旗だけ)

```bash
SALES_DEMO_VERSIONS_ENABLED=true SALES_DEMO_VIEW_SIGNING_KEY="$(openssl rand -base64 32)" npx next dev --webpack -p 3140 -H 127.0.0.1
```

- `SALES_DEMO_QUALITY_REVIEW_ENABLED` は **設定しない** (書き込みの欄が出ない。「今は無効です（表示だけ）」が出る)
- Windows のブラウザで `http://localhost:3140/admin/login` (WSL2 の localhost 転送)。届かなければ止める (WSL のネットワークの設定は変えない)
- §10 の利用者でログインし、`/admin/sales/demos/c4d31f24-8c91-4495-8ba1-db4706f438f8` を開く

## 12. 研究の描画と比べる・screenshot

1. **研究の描画との比較**: §6 の出力の `compare` を見る (`--compare-renders "$T/renders"` で、保存する写しを描いた全頁と研究の描画 `desktop_1440.png` / `mobile_390.png` を画素で比べたもの)。`same_size` と `differing_pixels` / `ratio` を Claude に渡す (数字だけ)。大きさや画素が違えば、`$T/full/desktop_1440.full.png`・`mobile_390.full.png` と `$T/renders/` の同じ名前の画像を並べて目で見る
2. **管理画面の screenshot** (自分の PC にだけ置く。Git・PR・Issue に上げない):
   - 幅 1440: 描画のタブ (PC と SP の全頁を最後まで scroll して「最後まで表示しました」)、縮小の注記「縮小表示（実寸の約N%）…」、「生の頁」のタブ (1:1。frame の中を scroll して全頁)
   - 幅 390 (DevTools の端末の表示): SP の描画 (全頁、縮小の注記) と「生の頁」のタブ (1:1)
   - 見ること: 写真が 6 枚とも出ている (SP の作業台は SP 用の写真)、研究の描画と同じ構図・色・文字、「AI 生成のデモ画像を含む (デモ専用・共有不可)」の表示、共有の欄が無い、390 で頁が横にはみ出さない

## 13. 後片付け

```bash
# app を Ctrl-C で止めてから
npx supabase db reset                # §8 の patch を外し、migration どおりの schema に戻す (この stack だけ)
npx supabase stop --no-backup        # この stack の container と volume (DB・Storage の中身) を消す
rm -rf "$T"                          # 一時のコピーと包み (元の job の出力はそのまま)
# 描写の確認のファイル (§5) はオーナーの確認の記録として手元に残してよい (Git・PR・Issue には上げない)
unset SERVICE_ROLE_KEY SUPABASE_SERVICE_ROLE_KEY ANON_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY DB_URL SUPABASE_DB_URL ADMIN_PW
# 任意 (もう使わないなら): rm -rf ~/sr-rin-local ~/.cache/ms-playwright; docker image prune
```

`supabase stop --no-backup` の後、§3 の元 (`$O`) は変わっていない (§3 で確かめた sha256 の一覧は `$T` と一緒に消える)。
