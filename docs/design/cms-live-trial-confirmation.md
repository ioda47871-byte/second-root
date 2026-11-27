# CMS の実環境の試験: 最終確認の依頼（オーナーの署名用、Issue #380）

2026-11-27。状態: **確認の依頼だけ**。Claude はサインイン・アカウントの作成・GitHub App の導入・公開・送信をしていない。
オーナーは 2026-11-27 に実環境の試験（Pages CMS + GitHub + Cloudflare Pages、**架空の自動車施工店のデータだけ**）を承認した。
実際の導入・作成・公開は、**この頁の対象と権限を見たうえでのオーナーの最終確認の後**に行う。問い合わせの送信は承認されていない。
手順の詳細は [`cms-live-trial-owner-sheet.md`](cms-live-trial-owner-sheet.md)、構築の設定の正本は納品用 repo の雛形の `README.md`（`experiments/pages-cms/delivery-template/README.md`、PR #385、2026-11-27 時点で未マージ）。

## 1. 対象

| 項目 | 案（オーナーが決めて ☐ に印） |
|---|---|
| 試験用 repo の名前 | `sr-cms-trial-autocare`（実店名・業種の固有の言葉を入れない） ☐ |
| 公開 / 非公開 | **非公開（private）** ☐。理由: 試験の中身を外に出さないため。雛形の構築は公開する頁から写真のメタデータ（位置情報を含む）を除くが、**repo には上げた元のファイルがそのまま残る**（`pages-cms-phone-photos.md` §4）。試験の画像は合成で、スマートフォン相当の試験用 JPEG には架空の位置情報（北緯 0°・東経 0°）だけを入れてある（公開する頁から消え、repo の元のファイルには残ることを確かめるため）。実在の場所の位置情報は入れない。本番でも非公開にする前提を試す |
| repo の持ち主 | オーナーの個人の GitHub アカウント ☐（組織は作らない）。アカウント名: ________ |
| 本番の枝 | `main` ☐ |
| 顧客役 | オーナーの 2 つ目のメールアドレス（GitHub アカウントなし）を Pages CMS の協力者として招く ☐ |
| 非認可の確認 | 招いていないメールアドレス、または repo に権限の無い GitHub アカウント ☐ |
| Claude の push | 既定はオーナーが push。Claude に push させるなら、repo 名と使う認証情報をここに書く: ________ ☐ |

## 2. 今の接続の状態

**ローカルで分かること**: この開発の repo（Second Root）の remote は `github.com/ioda47871-byte/second-root`。記録（`docs/STAGING.md`）には Vercel の team `brot-yanagi` と GitHub の連携がある。
**分からないこと**: Cloudflare のアカウントの有無、Cloudflare と GitHub がすでにつながっているか、どの GitHub App がどのアカウントに入っているか。Claude からは見えない。

**オーナーが見る画面**（サインインはオーナーだけ）:
1. GitHub → 右上のアイコン → **Settings** → Integrations の **Applications** → **Installed GitHub Apps**: 「Cloudflare Workers and Pages」「Pages CMS」が入っているか、入っていれば Configure で範囲（All / Only select）を見る（https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps）。
2. 同じ画面の **Authorized GitHub Apps** タブ: 両方の App を認可済みか。
3. 組織に属しているなら: Your organizations → Settings → Third-party Access の **GitHub Apps**。
4. https://dash.cloudflare.com → **Workers & Pages**: 既存のプロジェクトと、つながっている Git の repo。Cloudflare は「A GitHub account should only point to one Cloudflare account」とする（https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/）。本番・顧客用の Cloudflare につながっている GitHub アカウントなら、試験は別の GitHub アカウントで行う。

結果: Cloudflare のアカウント ☐ 有り ☐ 無し（作る）／ Cloudflare と GitHub の接続 ☐ 無し ☐ 有り（相手: ______）

## 3. 入れる GitHub App

| App | 範囲 | 公式に書かれた権限 | 確かめ方 |
|---|---|---|---|
| Pages CMS（hosted、github.com/apps/pages-cms、開発者 pages-cms） | **Only select repositories** = 試験用 repo だけ | **未公開**。self-host で自分の App を作る手順は、repo の Administration・Actions・Contents を読み書き、Checks・Commit statuses・Metadata を読み、アカウントの Email addresses を読み（https://pagescms.org/docs/guides/installing/github-app/）。hosted が同じかは不明 | 導入の画面に GitHub が要求する権限を出す。**撮影して残す**。Administration の読み書きがあれば、続けるかをその場で判断 ☐ |
| Cloudflare Workers and Pages | **Only select repositories** = 試験用 repo だけ（Cloudflare も推奨） | 具体的な一覧は公式の文書に無い（install は repo への接近、authorize は本人の確認、と書かれるだけ） | 同じく導入の画面を撮影 |

## 4. Cloudflare Pages の設定（納品用 repo の README と同じ）

Framework preset: None ／ Build command: `npm ci && npm run build` ／ Build output directory: `dist` ／ Root directory: 空 ／
環境変数: `SKIP_DEPENDENCY_INSTALL` = `1` ／ Node: `.node-version`（22.23.4）／ 秘密: なし ／ Preview branch: None（プレビューを作らない）。
README と違ったら README が正しい。実際の Pages ではまだ試していない。

## 5. 費用

- **Cloudflare Pages Free**: 構築は月 500 回、同時 1 つ、1 回 20 分、1 サイト 20,000 ファイル、1 ファイル 25 MiB（https://developers.cloudflare.com/pages/platform/limits/）。試験では支払いの方法を登録しない。
- **Pages CMS（hosted）**: 公式は「100% free」と案内（https://pagescms.org/）。**料金がかからないという案内であって、商用の利用の約束ではない**（規約は app.pagescms.org・商用・上限に触れていない。[`pages-cms-hosted-terms.md`](pages-cms-hosted-terms.md)）。
- GitHub: 個人のアカウントの非公開 repo 1 つ。GitHub の料金はこの文書では調べていない。

## 6. 公開されるもの

- **架空の自動車施工店のサイト**が `https://<プロジェクト名>.pages.dev` に**誰でも見られる形で**公開される（プロジェクト名がホスト名になる。https://developers.cloudflare.com/pages/get-started/git-integration/）。店名は「架空のカーケア工房 そらいろ」で、頁の上に「提案用デモ（架空の店）」と出る（`experiments/pages-cms/auto-site.ts`）。実店名・ロゴ・写真・連絡先は無い。
- 検索エンジンに載る可能性がある。試験が終わったら §7 で消す。独自ドメイン・DNS は使わない。
- Pages CMS の管理画面は公開されない（サインインした人と招いた協力者だけ）。

## 7. 後片付け（試験の後、オーナー）

1. Cloudflare: プロジェクト → Settings → **Delete project**（https://developers.cloudflare.com/pages/get-started/git-integration/）。
2. GitHub: Installed GitHub Apps → 「Cloudflare Workers and Pages」と「Pages CMS」→ Configure → **Uninstall**。接続を外すと新しい構築は止まり、前の deployment は残る（Cloudflare の GitHub の文書）ので、1 を先に行う。
3. Authorized GitHub Apps で両方を **Revoke**。
4. 試験用 repo を削除。
5. Pages CMS の hosted に残る協力者・キャッシュの消し方は公式に無い。残ることを記録する。

## 8. 署名

上の対象・権限・公開・費用・後片付けを確認し、試験の導入・作成・公開を認める。問い合わせの送信は含まない。

日付: ________ ／ オーナー: ________ ／ 例外・条件: ________

出典のアクセス日: 2026-11-27（https://pagescms.org/docs/guides/installing/github-app/ は 2026-11-26 に読み、2026-11-27 の owner sheet で再掲）。
