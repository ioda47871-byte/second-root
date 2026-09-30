# Concept Work の静的配置（/works/<slug>）

自主制作サイト（Concept Work）は、それぞれ別リポジトリの Next.js アプリです。
Second Root には React component として混ぜず、各リポジトリで **static export** した
成果物を `public/works/<slug>/` に置いて配信します。

- Concept Work は Second Root とは別の HTML 文書になる。Second Root の layout・
  `globals.css`・フォント・GA・JSON-LD は一切入らず、逆に Concept Work の Tailwind
  （preflight を含む）も Second Root に入らない。
- DB・Supabase・Sales Agent に依存しない。静的ファイルなので将来 Cloudflare Pages
  などへそのまま移せる。
- Second Root 本体に `output: "export"` は入れない（/admin・/demo・/api が動的なため）。

## 配置済み

| slug | 元リポジトリ | 元 commit（本番） | export 用 commit | 公開 URL |
|---|---|---|---|---|
| `yasashii-beauty-salon` | `ioda47871-byte/yasashii-beauty-salon` | `c7fdde64a43390398ccf5e5467db7ceb0dc5cf18`（main） | `216669c4aa0c2fd3a6d27eb53e36f004ddc3de20`（branch `feat/static-export-secondroot`） | `/works/yasashii-beauty-salon` |
| `midori-seitai` | `ioda47871-byte/-midori-seitai` | `6d79c0d97be7b46b5c26d4298fcf64bbc423ce0e`（main） | `538ad5f40a550ddebb6b2f0783020e3afdec49f5`（branch `feat/static-export-secondroot`） | `/works/midori-seitai` |

| slug | Next.js | export コマンド（Concept 側） | import コマンド（Second Root 側） |
|---|---|---|---|
| `yasashii-beauty-salon` | 16.3.2 | `npm run export:secondroot`（`SECOND_ROOT_EXPORT=1 NEXT_PUBLIC_SITE_URL=https://secondroot.jp/works/yasashii-beauty-salon next build`） | `node scripts/import-work.mjs --slug yasashii-beauty-salon --source ../yasashii-beauty-salon/out` |
| `midori-seitai` | 15.5.23 | `npm run export:secondroot`（`SECOND_ROOT_EXPORT=1 next build`） | `node scripts/import-work.mjs --slug midori-seitai --source ../-midori-seitai/out` |

星の茶スタンドは未移行（トップのカードは vercel.app を指したまま）。

## 仕組み

1. Concept Work 側（`next.config.ts`）: `SECOND_ROOT_EXPORT=1` のときだけ
   `output: "export"`、`basePath: "/works/<slug>"`、`images.unoptimized: true` にする。
   通常の `npm run build`（元の Vercel project）は変わらない。
2. next/image は文字列 `src` に basePath を付けないため、Concept Work 側の
   `src/lib/asset.ts` の `asset()` で付ける（yasashii は各 `<Image>`、midori は
   `src/lib/photos.ts` の写真パス）。
3. export の `out/` を `scripts/import-work.mjs` で `public/works/<slug>/` へコピーする。
   スクリプトは、HTML / RSC payload（`.txt`）の中のルート相対 URL（`/_next`・`/images`
   など）がすべて `/works/<slug>` 配下か、絶対 URL の canonical / og:url があれば
   `https://secondroot.jp/works/<slug>` を指しているかを検査し、外れていれば何も
   コピーせずに止まる。
4. export は各ページを `<page>.html` で出力し、Next の `public/` は拡張子なしの URL を
   返さない。そのため `next.config.ts` の `staticWorks` に slug とページ名を登録し、
   rewrite で `/works/<slug>` → `index.html`、`/works/<slug>/<page>` → `<page>.html`
   に対応付ける。`/works/<slug>/_next/static/**`（hash 付き）は immutable でキャッシュする。
   Next 15（midori）の router は Home の RSC payload を `/works/<slug>.txt` として取りに行く
   （export が書くのは `index.txt`）ため、これも rewrite で `index.txt` に対応付ける。
5. `public/works/**` は minify 済みの build 成果物なので ESLint の対象外
   （`eslint.config.mjs`）。

## 更新手順

Concept Work を直したら、export して取り込み直すだけで更新できます。

```bash
# 1. Concept Work 側（例: yasashii-beauty-salon。midori は ../-midori-seitai）
cd yasashii-beauty-salon
git checkout <更新したい commit / branch>   # export 設定（next.config.ts・asset()）を含むこと
npm ci
npm run export:secondroot                    # out/ に出力。全ページが ○ (Static) であること

# 2. Second Root 側
cd second-root
node scripts/import-work.mjs --slug yasashii-beauty-salon --source ../yasashii-beauty-salon/out
node scripts/import-work.mjs --slug midori-seitai --source ../-midori-seitai/out
```

（`node scripts/import-work.mjs <slug> <out>` の位置引数でも同じ。）

3. スクリプトが表示するページ一覧と `next.config.ts` の `staticWorks` の `pages` を比べ、
   ページを増減したときは合わせる。
4. この文書の「配置済み」の commit を更新する。
5. 確認して commit する。

```bash
npm run build
npx playwright test tests/e2e/works.spec.ts tests/e2e/existing-site.spec.ts
```

注意:

- Concept Work の本番（main）に export 設定がまだ入っていない場合は、export 用 branch を
  本番 commit に rebase / merge してから export する。
- `import-work.mjs` は `public/works/<slug>/` を丸ごと置き換える（古い hash 付きファイルは残さない）。
- Concept Work は `robots: noindex` のため `app/sitemap.ts` には載せていない。

## 新しい Concept Work を追加するとき

1. Concept Work 側に、上記 1・2 と同じ export 設定を入れる（basePath は `/works/<slug>`）。
2. `node scripts/import-work.mjs --slug <slug> --source <out>` で取り込む。
3. `next.config.ts` の `staticWorks` に `{ slug, pages }` を追加する。
4. `components/home/ConceptWorks.tsx` のリンク先を `/works/<slug>` にする。
5. `tests/e2e/works.spec.ts` の `WORKS` に追加する。

## 既知の差分・制約

- 画像は `images.unoptimized` のため元の webp（1086〜1536px、1枚 55〜213KB）をそのまま配信する。
  元の Vercel 版は next/image が画面幅に合わせて縮小していたので、写真の画素がごくわずかに
  異なる（文字・レイアウトは一致）。
- `/works/<slug>/<存在しないパス>` は Second Root の 404 ページになる。
- `/works`（slug なし）はページがなく 404。
- midori は元サイトにも canonical がない（metadataBase 未設定）ため、静的版にも付けていない。
