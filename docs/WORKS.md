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
| `hoshi-no-cha` | `ioda47871-byte/hoshi-no-cha-stand` | `1e9cb0d3c3d7b63123118e71cf80770d5c0b4c4e`（main。2026-08-22 に `vercel deploy --prod` した作業ディレクトリから救出したソース） | `defc063e176f0d11742404c6fc63099a46d282bc`（branch `feat/static-export-secondroot`） | `/works/hoshi-no-cha` |

| slug | Next.js | export コマンド（Concept 側） | import コマンド（Second Root 側） |
|---|---|---|---|
| `yasashii-beauty-salon` | 16.3.2 | `npm run export:secondroot`（`SECOND_ROOT_EXPORT=1 NEXT_PUBLIC_SITE_URL=https://secondroot.jp/works/yasashii-beauty-salon next build`） | `node scripts/import-work.mjs --slug yasashii-beauty-salon --source ../yasashii-beauty-salon/out` |
| `midori-seitai` | 15.5.23 | `npm run export:secondroot`（`SECOND_ROOT_EXPORT=1 next build`） | `node scripts/import-work.mjs --slug midori-seitai --source ../-midori-seitai/out` |
| `hoshi-no-cha` | 16.3.2 | `npm run export:secondroot`（`SECOND_ROOT_EXPORT=1 next build`） | `node scripts/import-work.mjs --slug hoshi-no-cha --source ../hoshi-no-cha-stand/out` |

3件とも Second Root 配下で配信している（トップのカードはすべて `/works/<slug>`）。
各 Concept Work の元の Vercel project（`*.vercel.app`）はそのまま残している。

同じ export 用 commit から export すれば、ページの内容・asset・パスは同じになる。
ただし Next の build ID（`_next/static/<buildId>/` と HTML 内の参照）は build ごとに変わるため、
バイト単位では一致しない。

## 仕組み

1. Concept Work 側（`next.config.ts`）: `SECOND_ROOT_EXPORT=1` のときだけ
   `output: "export"`、`basePath: "/works/<slug>"`、`images.unoptimized: true` にする。
   通常の `npm run build`（元の Vercel project）は変わらない。
2. next/image は文字列 `src` に basePath を付けないため、Concept Work 側の
   `src/lib/asset.ts` の `asset()` で付ける（yasashii は各 `<Image>`、midori は
   `src/lib/photos.ts` の写真パス）。
3. export の `out/` を `scripts/import-work.mjs` で `public/works/<slug>/` へコピーする
   （`tests/unit/import-work.test.ts`）。
   - 引数: `--slug` / `--source` は値が必須（`-` で始まる値は不可）。slug は
     `^[a-z0-9]+(-[a-z0-9]+)*$`（64 文字まで）。位置引数 `<slug> <out>` も可。
   - コピー先はスクリプト自身の場所から決まる `<repo>/public/works/<slug>`（cwd に依存しない）。
     source が symlink・public/works の中・public/works を含む・コピー先と重なる場合は拒否。
   - ファイル: symlink を辿らずに（lstat）全ファイルを列挙し、symlink・dotfile（`.env*` を含む）・
     `*.map`・通常ファイル以外が 1 つでもあれば拒否。
   - URL（`/works/<slug>` の外を指すルート相対 URL を拒否）:
     - HTML / SVG: 全属性（引用符なし・`'`・`"`、`srcset` は全候補）、`style` 属性・`<style>` の
       `url()`。`<script>` 内の RSC payload（JS 文字列）は JSON として展開して下記で検査。
     - CSS: `url()` と `@import`。
     - RSC payload（`.txt`）・JSON: basePath 配下か、この export の route（`/about`、`/#concept`
       など。router が basePath を付ける）であること。それ以外は asset ファイル
       （画像・フォント・CSS・JS・`.txt` など）と、`src` / `srcSet` / `href` / `poster` /
       `action` などの値を拒否。
     - JS: asset ファイル（画像・フォント・CSS など）を指すルート相対の文字列。フレームワーク自身の
       文字列（`/_next/`、`/index.txt`、route 名）は実行時に basePath と結合されるため対象外。
       実行時のリクエストが basePath の外に出ないことは e2e（`works.spec.ts` の `watch`）で確認する。
     - 絶対 URL の canonical / og:url / og:image / twitter:image は
       `https://secondroot.jp/works/<slug>` の直後が終端・`/`・`?`・`#` のいずれかであること
       （`/works/<slug>evil` などの前方一致は拒否）。
   - 手順: 検査 → リポジトリ直下の一時ディレクトリ（`.works-import-*`、gitignore 済み）へコピー →
     コピーを再検査（ファイル一覧・サイズ・内容）→ 旧コピーと入れ替え（失敗時は旧コピーを戻す）→
     旧コピーと一時ディレクトリを削除。どこで失敗しても `public/works/<slug>` はそのまま残る。
4. export は各ページを `<page>.html` で出力し、Next の `public/` は拡張子なしの URL を
   返さない。そのため `next.config.ts` の `staticWorks` に slug とページ名を登録し、
   rewrite で `/works/<slug>` → `index.html`、`/works/<slug>/<page>` → `<page>.html`
   に対応付ける。`/works/<slug>/_next/static/**`（hash 付き）は immutable でキャッシュする。
   Next 15（midori）の router は Home の RSC payload を `/works/<slug>.txt` として取りに行く
   （export が書くのは `index.txt`）ため、これも rewrite で `index.txt` に対応付ける。
5. `public/works/**` は minify 済みの build 成果物なので ESLint の対象外
   （`eslint.config.mjs`）。
6. `/works/**` の全レスポンス（HTML・`.txt`・画像・JS など）に `X-Robots-Tag: noindex, nofollow`
   を付ける（`next.config.ts`）。各ページの robots meta（noindex）もそのまま。Second Root 自身の
   ページには付けない。

## 更新手順

Concept Work を直したら、export して取り込み直すだけで更新できます。

```bash
# 1. Concept Work 側（例: yasashii-beauty-salon。midori は ../-midori-seitai、星の茶は ../hoshi-no-cha-stand）
cd yasashii-beauty-salon
git checkout <更新したい commit / branch>   # export 設定（next.config.ts・asset()）を含むこと
npm ci
npm run export:secondroot                    # out/ に出力。全ページが ○ (Static) であること

# 2. Second Root 側
cd second-root
node scripts/import-work.mjs --slug yasashii-beauty-salon --source ../yasashii-beauty-salon/out
node scripts/import-work.mjs --slug midori-seitai --source ../-midori-seitai/out
node scripts/import-work.mjs --slug hoshi-no-cha --source ../hoshi-no-cha-stand/out
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
- 星の茶
  - 元サイト（vercel.app）は `robots: index, follow`。Second Root 配下の静的版だけ
    `SECOND_ROOT_EXPORT=1` で `noindex, nofollow` にしている（元の Vercel production は変更なし）。
  - フォント（Shippori Mincho / Noto Sans JP / Cormorant Garamond）は元サイトどおり
    Google Fonts から実行時に読み込む（`fonts.googleapis.com` / `fonts.gstatic.com`）。
    `/works/**` には CSP を付けていないので Second Root 側ではブロックされない。
    取得できない環境では `app/globals.css` の游明朝・ヒラギノ明朝などのローカルフォントに
    フォールバックする（e2e は Google Fonts を空の CSS で置き換えて、この状態で検査している）。
  - 元サイトから、320px の `/menu` で 1 行分（「ゆっくり引き出した甘み。」）が 15〜20px
    はみ出す。Concept Work のデザインは変えない方針のため、そのままにしている。
  - canonical はない（元サイトも同じ）。独自の JSON-LD（CreativeWork）は元サイトどおり残している。
