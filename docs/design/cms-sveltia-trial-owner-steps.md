# Sveltia CMS の実環境の試験: オーナーの手順（Issue #380、案）

2026-11-28。状態: **ローカルの PoC だけ**。サインイン・アカウント作成・試験用 repo への push・公開の変更は何もしていない。実施にはオーナーの承認が要る。
出典は Sveltia CMS の公式の文書（アクセス日 2026-11-28）。背景は [`cms-upload-limit-options.md`](cms-upload-limit-options.md)（枝 `feature/dev380-upload-limit-options`）。hosted の Pages CMS は約 3.3 MB を超える写真を 413 で断る。

## 1. ローカルで確かめたこと（2026-11-28）

- 管理画面 `admin/config.yml` を、`.pages.yml` と同じ元（`experiments/pages-cms/pages-config.ts`）から生成する（`experiments/pages-cms/sveltia-config.ts`）。項目・順・必須・選択肢は `.pages.yml` と同じ。
- Sveltia CMS **5.0.3**（npm の `@sveltia/cms`、2026-11-27 公開、5.x の安定版になって 2 日目の最新）を `admin/index.html` で版を固定して読み込む。公式は版を固定しないことを勧めるが（https://sveltiacms.app/docs/start）、Second Root は納品物のコードを固定する方針のため固定した。
- 管理画面は試験中に GitHub の書き込みの token を持つので、`admin/index.html`（生成物）に **SRI**（5.0.3 の `sveltia-cms.js` の中身の sha384。unpkg が別の中身を返すとブラウザが読み込まない）と **CSP**（Sveltia の公式の基本の指定 https://sveltiacms.app/docs/security に、`worker-src blob:`・GitHub の API・Additions の Worker を足したもの）を入れた。ローカルの Chromium で、SRI が通り、CSP の違反なしに起動・写真の変換・保存ができた。GitHub の API への実際の通信は token が要るので **未検証**。
- **注意**: HEIC の変換器（WebAssembly、約 300 KB）は、Safari 以外のブラウザで HEIC を選んだときだけ unpkg から読み込まれ、**版は固定されていない**（Sveltia 本体の中から読み込むため SRI も付けられない）。iPhone の Safari は HEIC を自前で読むので、変換器は読み込まれない、と公式。
- 新しい entry のファイル名は entry の `id` と同じ（`{id}.json`、Pages CMS と同じ形）。Sveltia の試験用の保存先で確かめた。
- ローカルの Chromium で起動した（GitHub 版の設定）: ログインの画面（「Work with Local Repository」「Sign In with GitHub」「Sign In Using Access Token」）が出た。設定の読み込みのエラーは無し。
- 公式の試験用の保存先（`test-repo`。ブラウザの中に保存し、サインイン不要）で、合成の写真 `test-data/phone/IMG_4001.JPG`（4032×3024、5.26 MB、EXIF の向き 6、偽の位置情報）を施工実績の写真の欄に入れて保存した:
  - 保存された写真: `/media/img_4001.webp`、**945,890 バイト、1920×2560（縦向きに直った）、EXIF・XMP・位置情報なし**。今の写真の検査（2 MiB・4096px）をそのまま通る。
  - 保存された entry: ファイル名は `id` と同じ UUID、空の任意の項目は省かれた。今の構築でそのまま頁になった（公開の写しは 804,884 バイト）。
- **まだ確かめていないこと（未検証）**: iPhone の Safari での動き（Safari は WebP を自前で作れず、別の方法で作るので遅い・PNG になりうる、と公式）、本物の HEIC（ローカルでは作れない）、GitHub への実際の保存、Additions のログイン。

## 2. ログインの方法（どれか 1 つ）

| 方法 | 誰が何を作るか | 向き |
|---|---|---|
| A. アクセストークン（試験だけ） | オーナーが GitHub で **fine-grained token** を作る: Repository access = 試験用 repo だけ、Repository permissions = **Contents: Read and write**（https://sveltiacms.app/docs/backends/github）。管理画面の「Sign In with Token」に貼る | 最短。顧客には向かない（GitHub のアカウントと token の管理が要る）。試験の後に token を消す |
| B. Sveltia CMS Additions（顧客向けの本命） | オーナーが **Cloudflare のアカウント**を用意し、公式の Deploy ボタンで Worker を作る（GitHub に小さな repo が写され、Durable Object ができる。`ADMIN_SECRET` を 32 文字以上で作り保管）。Worker の `workers.dev` の URL を有効にし、ウィザードで最初の管理者を作り、GitHub App を作って **Only select repositories = 試験用 repo だけ**に入れる（https://sveltiacms.app/docs/additions/setup）。顧客役は ID とパスワードで入る（GitHub のアカウント不要）。Workers の Free プランで動く、と公式 | 顧客がスマートフォンで ID・パスワードで入れる。Worker の保守（Dependabot の PR をマージ）が増える。GitHub App の権限の一覧は公式に書かれていない（入れる画面を撮影） |

B を選んだら、Worker の URL（`https://` で始まるもの）を Second Root に伝える。Second Root が `admin/config.yml` を作り直す（`export-delivery.ts --sveltia-repo <owner/repo> --sveltia-additions-url <Worker の URL>`。設定ファイルは生成物なので手で直さない。構築が違いを見つけて止まる）。

## 3. 試験用 repo で変わるもの

- 追加: `admin/index.html`（Sveltia の読み込み・SRI・CSP、生成物）、`admin/config.yml`（生成物）、`site/sveltia-config.ts`（生成の元）。`build.mjs` は `site/sveltia-config.ts` を読むので、**この 2 つは必ず一緒に上げる**（片方だけだと構築が止まる。前の公開は残る）。
- 変更: `site.config.json` に `sveltia`（repo と branch、B なら Worker の URL）、`build.mjs`（`admin/config.yml` を検査し、`/admin/` に公開する）。
- 公開の頁に **`/admin/` のログイン画面が加わる**（`noindex`。Sveltia を unpkg から読む）。店の頁そのもの（`/`）は変わらず、`/admin/` へのリンクも無い。
- content（施工実績・お知らせ・営業時間）と写真はそのまま。Pages CMS（`.pages.yml`）も残るので、両方の管理画面が同じ content を編集できる（同時に使わない）。
- Sveltia で上げた写真は **WebP で repo に入る**（元の JPEG・HEIC は入らない。位置情報も残らない見込み、実機で確かめる）。

## 4. 実機で確かめる手順（承認の後）

1. Second Root が作った更新の ZIP を試験用 repo にブラウザで上げる（content は含まない）。Cloudflare の構築の成功を確かめる。
2. `https://<project>.pages.dev/admin/` を iPhone の Safari で開き、§2 の方法で入る。
3. 施工実績を 1 件追加し、写真の欄で iPhone の写真を**そのまま**選ぶ（① HEIC のまま ② 5 MB 前後の JPEG）。保存する。
4. 記録: 保存にかかった時間、GitHub の `media/` に入ったファイルの名前・大きさ、`live-trial-measure.ts originals --repo <手元の clone>` の結果（`format`・`width`・`height`・`gps`）、公開の頁で写真が出るまでの時間（`wait`）。
5. 同じ写真を Pages CMS で上げたときの 413 と比べる。

## 5. 戻し方

- Sveltia をやめる: 試験用 repo で `site.config.json` の `sveltia` を消し、`admin/` を消す（ブラウザで消せなければ Second Root が戻しの ZIP を作る）。Pages CMS はそのまま使える。
- A の後片付け: GitHub の Settings → Developer settings → Personal access tokens で token を消す。
- B の後片付け: GitHub の Installed GitHub Apps で Additions の App を Uninstall し、App を消す。Cloudflare で Worker を消す。Deploy で写された小さな repo も消す（Durable Object の消し方は公式に記載なし、未確認）。
- Sveltia で上げた WebP の写真と entry は content として残る（消すなら CMS で消す）。

## 6. 顧客への約束について

技術の試験。Sveltia は MIT で顧客の口座で動かせるが、Cloudflare・GitHub の無料枠が続くことは約束しない。iPhone の実機の結果が出るまで「そのまま選べる」と顧客に言わない。
