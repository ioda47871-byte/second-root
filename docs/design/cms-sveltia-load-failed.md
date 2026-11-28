# Sveltia CMS の保存で「Load failed」（iPhone の Brave、2026-11-28）: 原因の調べと直し方（Issue #380）

状態: **ローカルの調べと直し**。サインイン・試験用 repo への push はしていない。
出来事: 試験用のサイト（trial commit d9fbaa3、Cloudflare の deploy 55bd19c6）で、iPhone の Brave（中身は WebKit）から施工実績を写真 3 枚つきで新しく作り、保存すると「Load failed」と出た。「Load failed」は WebKit の fetch の失敗（TypeError）の文言。

## 1. 原因の見立て（確からしい順）

1. **（最有力）管理画面の CSP に `'wasm-unsafe-eval'` が無く、WebKit で写真の WebP 化が失敗して巨大な PNG のまま保存しようとした。**
   - Sveltia 5.0.3 の本体（`dist/sveltia-cms.js`）を読むと: WebP にするとき、ブラウザが自前で WebP を作れれば `OffscreenCanvas.convertToBlob` を使い、作れなければ `@jsquash/webp`（WebAssembly）を unpkg から読み込んで使う。それにも失敗すると、エラーを出さずに `convertToBlob` に戻る。**WebKit は WebP を自前で作れない**ので、iPhone では jsquash の道を通る。
   - WebAssembly は、CSP の `script-src` に `'wasm-unsafe-eval'` が無いと動かない。今の CSP には無い。
   - **ローカルで再現した**（Chromium に WebKit と同じく「WebP を作れない」ふりをさせ、試験用の保存先で写真 3 枚・各 5 MB の合成の JPEG を保存）:
     - 今の CSP: コンソールに「Compiling or instantiating WebAssembly module violates the following Content Security policy directive … script-src 'self' https://unpkg.com」。保存された写真は **PNG、1 枚 約 12.9 MB、3 枚で 38.6 MB**（ファイル名は `img_4001.png` など）。
     - `'wasm-unsafe-eval'` を足した CSP: **WebP、1 枚 約 0.94 MB、3 枚で 2.8 MB**（Chromium が自前で WebP を作ったときと同じ）。
   - Sveltia の保存の仕組み（本体のコードで確認）: 変更したファイルを、**写真などのバイナリを先、entry の JSON を最後**に並べ、base64 の大きさで **約 2 MB（2,097,152 バイト）ごとの組**に分け、**組ごとに 1 回ずつ GitHub の GraphQL `createCommitOnBranch`** を送る（前の commit の上に次の commit を積む）。1 つのファイルが組の大きさを超えるときは、そのファイルだけで 1 回になる。408・413・499・502・504 か送信の失敗のとき、複数のファイルの組は分けて送り直すが、**1 つのファイルの組は分けられないので、そこで保存が止まる**。commit の作者を利用者にする設定（`user`）のときは別の道（REST の blob → tree → commit → ref）を通る。
   - PNG のままだと、写真 1 枚（約 12.9 MB）が base64 で **約 17 MB の要求 1 回**になり、3 枚で 3 回、entry は最後の回に入る。GitHub は処理に 10 秒を超える要求を打ち切り 502 か 504 を返す（https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api 「If GitHub takes more than 10 seconds to process an API request, GitHub will terminate the request」）。要求の大きさの上限は公式に書かれていない（未確認）。打ち切りの応答や途中で切れた通信には CORS の見出しが付かないことが多く、そのときブラウザには「Load failed」としか見えない（**推論**。実際の GitHub の応答は token が要るので確かめていない）。
   - したがって **途中まで保存されることがありうる**: 先の写真の commit が通り、後の写真か entry の回で止まると、repo に PNG の写真だけが入り、entry は無い、という形になる。
   - なお、その PNG がもし保存されても、構築の写真の検査（2 MiB まで）で止まり、前の公開が残る。
2. **（低い）保存の通信そのものを CSP が止めた。** 本体を読む限り、保存で使うのは `https://api.github.com`（REST の `git/trees`・`git/blobs`・`git/refs`）と `https://api.github.com/graphql` だけで、どちらも CSP の `connect-src` で許している。`uploads.github.com`・`raw.githubusercontent.com` などの別の宛先は使っていない。
3. **（低い・未確認）Brave の Shields が unpkg か GitHub への通信を止めた。** Brave がこれらを止めるという報告は見つからなかった。Safari で同じ操作をすれば切り分けられる。
4. 認証の方法（token か Additions か）は、この失敗の原因ではないと見る（保存の要求の大きさと WebAssembly の可否の問題）。

## 2. 直し方（この PR）

- 管理画面の CSP の `script-src` に **`'wasm-unsafe-eval'`** を足す（`experiments/pages-cms/sveltia-config.ts`）。WebAssembly だけを許し、文字列の eval（`'unsafe-eval'`）は許さない。Safari は 16 から対応（それより古い iOS では効かない、未確認）。
- 注意: WebP の変換器 `@jsquash/webp`（`^1.5.0`）も、HEIC の変換器と同じく **unpkg から版を固定せずに**読み込まれる（Sveltia 本体の中の指定。SRI も付けられない）。
- 試験用 repo の更新の ZIP: `admin/index.html` と `site/sveltia-config.ts` の 2 つ（構築は `admin/index.html` が生成物と同じかを検査するので、必ず一緒に上げる）。content と写真は含まない。

## 3. オーナーの確かめ方（短く）

1. **GitHub に何か書かれたかを見る**: 試験用 repo の Commits で、失敗した時刻ごろに **1 つ以上の新しい commit** があるか（写真 1 枚ごとに 1 commit になりうる）。あれば、`media/` に `img_*.png`（10 MB 以上）が入っていないか、`content/works/` に新しい entry があるかを見て、画面を撮る。**PNG の写真だけが入って entry が無い**（途中まで保存された）ことがありうる。その写真は頁から参照されないので、構築は無視し公開もしない。ただし repo の容量を使うので、消すかどうかと手順を Second Root と決める（消すのは別の作業）。
2. Cloudflare の Deployments に、その時刻の構築があれば、成功か失敗かを撮る（失敗でも前の公開は残る）。
3. 更新の ZIP を上げ、Cloudflare の構築の成功を確かめてから、**iPhone の Safari** で `/admin/` を開き、写真 1 枚で保存する。成功したら写真 3 枚で試す。続けて Brave でも試す（失敗したら Brave の Shields を一時的にこのサイトだけ下げて試す）。
4. 撮るもの: エラーの表示（時刻が分かるように）、使ったブラウザと iOS の版、保存した写真の枚数、成功したら GitHub の `media/` に入ったファイルの名前と大きさ（`.webp`・1 MB 前後のはず）。手元に clone があれば `live-trial-measure.ts originals --repo <clone>` の結果。

## 4. まだ分からないこと

- 実際の GitHub の応答（502/504 か、通信が切れたか）。iPhone では開発者ツールが使えないので、エラーの文言と時刻と GitHub 側の commit の有無で判断する。
- WebKit の jsquash の WebP 化の速さ（数秒〜十数秒かかりうる、と Sveltia の文書）。
