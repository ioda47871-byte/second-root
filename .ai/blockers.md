# Blockers

> 人間の判断・操作が必要な事項と、技術的に止まっている事項を記録する。
> 解除されたら「解除済み」に移し、解除日と対応を書く。Secret の値は書かない。

## 未解除

### DEV-066 の残りと品質改善の次の案（2026-10-20、人の判断待ちを含む）

- 背景: controlled run（efb4bdb2、job b-c73a43b5-…）は 3 候補とも revise 18/25（brand_fit 3・generic_template_feel 3・他は 4）→ BLOCKED QUALITY_NOT_ACCEPTED。原因の調査（読み取りだけ）: revise は実際に次の候補を作っているが、(1) profile の direction・heroLayout.alignment・motion・confidence・rationale は screenshot に何も描かれない（写真の無い頁では palette.surface も、accent の motif が無ければ accent も）、(2) 頁の骨組み（節の順・見出し・英語の分類ラベル）は固定で、Instagram だけの店は事実が少なく短い頁になる、(3) 写真は出ない（Instagram の写真は使わない方針）、(4) 日本語の店名では display 書体が実質 2 通り、(5) review の notes は次の round に渡らない（DEV-034）。DEV-066 は (1) で round を無駄にしないようにした（品質基準は不変）
- DEV-066 の残り: 写真の loop（photo-pipeline）には見える変化の確認が無い / 以前の低い候補と同じ修正の検出は無い / 追加の review（見えない修正のときのもう一度）の accept は second look と同じく gate を通る（1 run の review の上限は 4 → 6）。扱いを変えるかは人の判断
- 次の案（効果の大きい順の見込み。どれも閾値・verdict・gate は変えない）:
  - DEV-067 案: direction に CSS の preset を付ける（`[data-direction=…]` で罫線・見出し・label・menu の番号・hero の枠などを変える）。schema は変えない。renderer の test（direction の組ごとに computed style が違う・overflow 無し・contrast）。テンプレート感への効果が最も大きい見込み。人の判断は不要（Claude が進めてよいか確認）
  - DEV-068 案: 日本語の display 書体を face ごとに別にする（editorial_serif と mincho、2 つの grotesk）。next/font で自前配信
  - DEV-069 案: heroLayout.alignment を CSS で効かせる（または語彙から外す）
  - DEV-070 案: 参照画像（ぼかし済み）から主要色を数個だけ測って brief / review に hex で渡す（画像の内容・文字は渡さない）
  - 人の判断が要る: review の notes を次の round に渡す（DEV-034 の方針の変更）／ 初期候補を 2〜3 個にする（Codex の時間とコスト）／ Instagram の写真を使う（権利・同意の判断）
- 次の実走: efb4bdb2 は attempts 2/3 で blocked（再 reset は未承認）。改善の効果は新しい controlled run（人の承認: 対象 demo・DB の reset・W・C）で測る

### HUMAN-023 — comp to site（DEV-082）の人の判断: 実物の comp での最初の実装と、Claude の実装の段の将来の自動化（非ブロッキング）

- 背景: DEV-082 は Codex の comp を Claude が頁として実装するための local PoC（`docs/operations/comp-to-site.md`）。synthetic の comp でだけ確かめた（report は `synthetic_only`、類似度は決して pass にならない）。画像生成は止まっている（HUMAN-022 の結果を受けて、次は HUMAN-024 / DEV-084）。
- 判断 1（実物の comp が出たら）: rubric の合格（≥ 22、人の確認）の後、Claude Code の session で `layout-spec.json` と頁を書き、`comp-impl-poc.ts --bundle … --page …` を流して、comp と screenshot を並べて人が見る。そのときに、検査の許容（節の位置 ±0.05〜0.06・palette の各 channel 10・type ±20 %・anti-template の距離 0.35）が実物で妥当かを人が確かめる。数字の変更は品質基準なので人の承認の後だけ。
- 判断 2（将来）: Claude の実装の段を無人で動かすか、どう動かすか。このリポジトリの自動化は人がサインインした CLI（Codex は ChatGPT のサインイン、API key は使わない）で、リポジトリのコードは model の API を呼ばない（Anthropic の API も呼ばない）。自動化するなら (a) 人の WSL で Claude Code を worker と同じ形で動かす か (b) API を使う（key の扱い・課金・規約）のどちらかで、どちらも人の判断。DEV-082 はどちらも作らない。
- AI の concept 画像を頁で使う場合（DEV-076 の後）: 1 枚ずつ人の review の記録（`assets.json` の `approval`）、local preview だけ、`published: false`、頁には「架空店舗のデザイン提案｜和菓子の画像はAI生成のイメージです」。asset store への取り込みは DEV-070 の一部を戻すので別の判断（`docs/operations/design-image-assets.md`）。
- 触れないもの: 営業 demo・worker・timer・asset store の規則・品質ゲート・Production / Staging / DB。

### HUMAN-024 — imagegen の約 156 秒の失敗の原因を分ける、Codex を呼ばない確認（DEV-084。1 段ずつ別の承認）

- 背景（HUMAN-022 の結果、2026-10-22）: 4 回の PoC（HUMAN-018 / 019 / 020 / 21b、model `gpt-6.1-sol`・CLI 0.159.0・paginated）の**最初の imagegen はすべて 155.6〜157.8 秒で `failed/none`**。HUMAN-018 だけ、モデルが 2 回目を呼び 32.6 秒で成功した。
  DEV-084 の調査（`docs/operations/imagegen-timeout-investigation.md`、rust-v0.159.0 の source と reqwest 0.12.28 を data として読んだ。Codex は流していない）:
  画像の要求は `POST https://chatgpt.com/backend-api/codex/images/generations`（stream なし）。Codex は request / connect の timeout を付けず、**1 回のツール呼び出しの中で HTTP を最大 5 回**（再試行 4 回、5xx と transport error、backoff 計約 3 秒）送る。
  reqwest 0.12.28 は **Linux（WSL2 を含む）では既定で `TCP_USER_TIMEOUT` 30 秒・keepalive 15 秒**を socket に付け、Codex はそれを変えない。156 秒 ≒ 5 ×（約 30.5〜31 秒）+ 約 3 秒。
  公開の報告（openai/codex#24323、#45381 の Linux の comment）も Linux で「1 回約 31 秒 × 5 回・`timeout`」。最有力は H1「経路上で keepalive の probe に応答がなく、待っている間の接続が 30 秒で切られる」。対立仮説は H2「server が約 30 秒で 5xx」、H3「1 回の長い要求（約 156 秒）が再試行されない error で終わる」。
- コマンドと読み方の正本は `docs/operations/design-image-poc.md` の「HUMAN-024」（GitHub で表示されるよう、コマンドはそこに置く）。
- **人の判断（2026-10-23）**:
  - **A-2 方針として承認**: 修正版 passt の導入へ進める。対象は Ubuntu 26.04 の `passt 0.0~git20260120.386b5f5-1` に限る。`design-wsl-isolation.md` §6 の例外は、この package について、配布元の署名・hash・依存関係を確かめ、既存の jail の隔離水準を保つ場合に限る。**実際の package の導入と WSL の変更はまだ許可されていない。**
  - **A-3 方針として採用**: 198.51.100.53 へは UDP/53 だけを許し、UDP/853 を含む残りは拒否。独立 branch で最小の code・検査・test・設計書の修正 → 独立 review と CI → merge まで可。条件: jail の隔離を弱めない／DNS の名前解決が動く／UDP/853 を確実に拒否／TCP/53・TCP/853 の拒否を保つ／private address への制限を保つ／変更前後の差分を確認できる／worker・timer・Codex・認証設定を変えない。**実 WSL への適用は別の承認。**
  - 更新の準備: A-3 の後に、worker の停止確認・更新前の記録・旧 package の確保・新 package の署名と hash・DNS 制限の適用・更新・jail の安全性検査・通信検証・rollback を実行できる形に整理する。**既存の timer は勝手に止めない。A-4・A-5 を含む実機作業は段階ごとに承認。** 手動導入した package の security update を月 1 回確認する運用と管理担当を、更新の前に確定する（A-10）。
  - EOF の調査結果は維持。24b-v2 の更新前の検証は必須にしない。更新後は 24b-v2 で接続の維持を確認する。**通信 test の成功だけで画像生成の問題が解決したとは判定しない。実 Codex（A-8）は別の承認。**
- **現在地（2026-10-22）: 24a・24b・24b-host 済み（承認の A-1 は完了）。次は passt の更新の承認判断（`docs/operations/passt-update-plan.md` §0 の要約と §8 の表、DEV-087 で最終整理）。** passt の更新・WSL の設定の変更・jail の変更・worker / timer の変更・Codex の実行は**どれも承認されていない**。
- **24b・24b-host の結果（済み、2026-10-22、人が流した）**:
  - jail の中（pasta 経由）: `JAIL_OK`、A_reqwest_default `status=200 idle_end=EOF idle_s=27`、B_keepalive_only `status=200 idle_end=EOF idle_s=57`、C_plain `status=200 idle_end=OPEN idle_s=100`。
  - host（jail の外、WSL の通常の network）: A・B・C とも `status=200 idle_end=OPEN idle_s=100`。
  - 読み: keepalive を送る接続だけが、予想どおりの時刻（A は `TCP_USER_TIMEOUT` 30 秒 − 読み取り 3 秒 = 約 27 秒、B は 15 + 3 × 15 − 3 = 約 57 秒）で終わり、host では 3 本とも開いたまま。**古い pasta が jail の経路で keepalive の ACK を落としていることを強く支持する。**
  - ただし **画像生成の約 156 秒の失敗が同じ原因だとは断定しない**。24b は応答を受け取った後の待機（GET）、Codex は応答がまだ始まらない POST の待機。確かめられるのは更新後の Codex 1 回（A-8）だけ。
  - `ERR_ETIMEDOUT` ではなく `EOF` だった点（DEV-087 で分析、`design-image-poc.md` の「24b result」）: Ubuntu 24.04 の Python 3.12.3（+ OpenSSL 3.0.13）の ssl は、kernel が `ETIMEDOUT` で切った socket を ragged EOF として返し、既定の `suppress_ragged_eofs=True` で空の読み取りになる（noble と同じ package で手元で試験して確認。CPython は 3.13.0a6 の gh-115627 で直し、3.12 には backport されていない）。3.12 では RST と FIN も `EOF` になるので、語だけでは区別できない。pasta `1e6f92b` の source は keepalive に ACK も FIN も RST も返さない。時刻の一致と host の結果から、jail の kernel 自身が切った（`ETIMEDOUT`）と見るのが最も確からしい（errno そのものは 24b では出せない）。
  - 任意の 24b-v2（`suppress_ragged_eofs=False`、読む前に `SO_ERROR` と `TCP_INFO` を見る。手元の 127.0.0.1 で試験済み）は、更新の判断には必須ではない。更新後の確認（A-6）では 24b の代わりに 24b-v2 を使う案。
- **24a の結果（済み、2026-10-22、人が流した）**: kernel `6.18.33.2-microsoft-standard-WSL2`・WSL の network mode `nat`・passt `0.0~git20240220.1e6f92b-1`（Ubuntu 24.04 の標準の package。noble に -updates / -security / -backports は無い）・`pasta --version` は `pasta unknown version`（mode 名の後に版。Debian の build は git が無いので版を埋めない。版は dpkg と hash で見る）・system の keepalive の sysctl `7200 75 9`（reqwest が socket ごとに keepalive と `TCP_USER_TIMEOUT` を付けるので Codex の socket には効かない）・jail `JAIL_OK`・proxy の変数（`HTTP(S)_PROXY` / `NO_PROXY` / `ALL_PROXY`、大文字小文字とも）はすべて unset。
  → upstream の `1e6f92b`（2024-02-20）は `238c69f`（2024_11_21「tcp: Acknowledge keep-alive segments」）より前なので、入っている pasta は keep-alive に ACK を返さない。H1（pasta が keepalive の ACK を落とし、約 30 秒 × 5 回で切れる）が強まった。proxy なしなので Codex は jail から chatgpt.com へ直接つなぎ、24b はその経路を測る。
  → 24b の手順は DEV-086 で jail の実装と突き合わせ直した（コマンドは変えていない。`design-image-poc.md` の HUMAN-024）。結果は上の「24b・24b-host の結果」（jail で A が約 27 秒で切れ host は OPEN → pasta の行）。
- 24a（読むだけ・network なし・費用 0。**済み**、手順は記録として残す）:
  - jail の外: kernel・WSL の network mode・**passt の版**（`dpkg-query -W passt` / `pasta --version`）・keepalive の sysctl。
  - jail の中: proxy の環境変数が設定されているか（値は出さない）。
  - Codex は jail の network namespace から **pasta** を通って外に出るので、keepalive に応答する相手は pasta。upstream の passt が keep-alive に ACK するのは 2024_11_21.238c69f から（keep-alive の続きの修正は 2025-02 の 472e2e9 と 2025-12 の aa809d3）。Ubuntu 24.04 の古い passt だけで H1 がそのまま起きうる。
  - Codex に渡るのは `HTTP(S)_PROXY` / `NO_PROXY` だけ（`ALL_PROXY` は sandbox.ts:79 で消える）。私設 address の proxy は jail から届かない（`IPAddressDeny`）。
- 24b（**済み**。Codex 0 回・sign-in なし・課金なし・約 2 分。network: chatgpt.com:443 へ認証なしの `GET /robots.txt` を 3 本。手順は記録として残す）:
  - jail の中で、reqwest の Linux の既定と同じ socket option（A）、keepalive だけ（B）、何もなし（C）の TLS 接続を開き、100 秒待つ。
  - 任意の 24b-host: 同じ probe を jail の外（人の WSL user、host の namespace）で 1 回流し、pasta と WSL の NAT を分ける。
  - 読み方:
    - `idle_s` は 3 秒の読み取りの後から数える。
    - A が `ERR_ETIMEDOUT`（Python 3.12 では `EOF`）で約 27 秒、B が約 57 秒（または `OPEN`）、C が `OPEN` → keepalive の ACK が返っていない。
    - それが jail の中だけなら → pasta が原因（passt の更新の案）。
    - 3 本とも `OPEN` → H2 が有力。
  - 修正後の probe は、ACK を落とす local の再現（iptables、後で削除）で確かめた: A 27 秒・B 57 秒・C OPEN。
- 24c（24b で結論が出ないときだけ。**24b で結論が出たので今は使わない**。Codex 1 回、画像生成つき、passt の更新の**前**）: DEV-084 の merge の後に、HUMAN-021b と同じ v1 のコマンドを 1 回。更新の**後**の Codex 1 回は別の段で、`passt-update-plan.md` の A-8（V-4）。
  `img_call_ms=` と `img_fail_timing=` で呼び出しごとの時間、cell の script が error を捕まえなかったときは `img_fail_reason=TIMEOUT`（H1）か `HTTP_5XX`（H2）が分かる。
- 修正の案（どれも人の承認が要る。DEV-084 は実装していない）:
  (1) 自動の再試行を 0 回に: `openai` は予約された provider id で上書きできない（config_toml.rs:66-72）ので、`-c` で自前の provider（`requires_openai_auth = true`・`request_max_retries = 0`）に切り替える。model の通信も同じ provider になる挙動の変更。失敗が 1 回・約 31 秒になるだけで、原因は直らない。
  (2) ツールを 1 回だけ呼び、失敗したら error 文を表示して止まる、と prompt に書く: 強制ではない。prompt は byte 単位で固定なので別の PR。
  (3) 最初の失敗で PoC が Codex を止める（run.ts が session log を見る）。
  (4) H1 が確定したら: **passt の更新**（24a の版が 2024_11_21.238c69f より古く、24b が jail の中だけで切れるとき。WSL の system package の変更）、WSL の network mode（`.wslconfig`、人の承認。host でも切れるときだけ）、または upstream に報告する（外部への投稿は人の判断）。jail の中の loopback の proxy は、その上流の socket も pasta を通るので、pasta が原因なら（keepalive を送らない proxy でない限り）効かない。
  CLI の更新は効かない見込み（2026-10-22 の main も reqwest 0.12.28 で、TCP の option を付けていない）。
- 触れないもの: HUMAN-022 と同じ。`~/.codex/config.toml`・`.wslconfig`・CLI の版・model は変えない。
- 返してほしいもの: 24a・24b・24b-host は受け取り済み。次は `passt-update-plan.md` §8 の承認の判断（A-2 から順に）。
- 解除条件: 24b で「jail だけ切れる」になった（2026-10-22）ので、passt の更新は `passt-update-plan.md` §8 の承認（A-2 から順に）を 1 つずつ受けてからだけ進める。人が更新しないと決めた場合も解除（その後の案は同 §7）。画像の失敗の原因の確定は A-8（更新後の Codex 1 回）。

### HUMAN-021 — 画像ツールが使われない原因を分ける、安い順の確認（DEV-078 の merge の後。1 段ずつ別の承認）

- 背景: HUMAN-019（1effb40）と HUMAN-020（cae33e8）の v2 は、どちらも `CODEX_NO_IMAGE`。HUMAN-020 の診断: exit 0・`image_tool=0/0`・`agent_msgs=1`・`agent_chars=32`・`errors=0`・`turn=completed`・`thread_dir=0`・画像 0、Codex 約 183 秒（HUMAN-019 には診断がなかった）。
  DEV-078 の調査（Codex CLI 0.163.0 の source、`docs/operations/design-image-poc.md` の「Why the image tool was not used (DEV-078)」）: 画像ツールは `image_gen.imagegen` で、`codex exec --json` はその item を出さない（`image_tool=0/0` は何も証明しない）。
  ツールの失敗（画像の利用枠 `image_gen` を含む）は error event ではなくツールの出力としてモデルに返り、turn は exit 0 で終わる。つまり (i) ツールが出ていない、(ii) 出ていたがモデルが文章を選んだ、(iii) 方針で断った、(iv) ツールが呼ばれて失敗した、のどれも今の診断と矛盾しない。
  HUMAN-018（v1）の直後から続けて失敗していること・183 秒かかっていること（画像ツールは数分かかる）は (iv)（画像の利用枠を含む）と合うが、確定はできない。
  DEV-078 は、model を呼ばない preflight と、CLI の session log と最後の答えをメモリの中だけで固定の符号にする分類（`outcome=` `answer=` `img_calls=` `img_fail=` `cli=` `model=` `class=`）を足した。prompt は変えていない（v2 の「使えなければエラーを答える」は curiosity-media の毎日動いている文の忠実な訳で、根拠なしに変えると原因が分からなくなる）。
- 前提: DEV-078 の PR が develop に merge されていること（`POC_DIAG_SUMMARY` に `outcome=` と `cli=` があることで確かめる）。
  **21b・21c は DEV-080 の merge の後**（`POC_DIAG_SUMMARY` に `hist=` と `cm_cells=` があることで確かめる。無ければ古い develop で、0.159.0 の log を読み違える）。
- DEV-080 の訂正（2026-10-21、Codex は流していない。openai/codex rust-v0.159.0 と 0.163.0 の source を data として読んだ。`docs/operations/design-image-poc.md` の「Codex CLI 0.159.0, paginated history and code mode (DEV-080)」）:
  `codex exec` は session log を **paginated** の history で書く（legacy ではない）ので `image_generation_end` は残らず、画像ツールの状態と失敗は `item_completed` の **Extension** item（kind `image_gen.generation`）にある。
  さらに 0.159.0 の bundled の model は `gpt-5.5` 以外すべて **code_mode_only** で（PoC は `-m` を渡さない）、imagegen は `exec` の cell の JavaScript から `image_gen__imagegen` として呼ばれ、`function_call imagegen` は出ない。
  DEV-078 の分類はこのどちらも読めず、呼ばれていても `TOOL_NOT_CALLED` と出しえた。DEV-080 が両方を読み、code mode で呼び出しが見えないときは `TOOL_NOT_SEEN_CODE_MODE`（class `inconclusive`、結論なし）にした。
- 順番（安い順。前の段の結果で次を決める。どの段も Claude は WSL に触れない）:
  1. **21a — 手元の確認（model の呼び出しなし・費用 0）。済み（2026-10-21、人が流した）**: `.env: absent`・`codex-cli 0.159.0`（2026-09-29 の版）・`config.toml: no matching line`・bundled の model はどれも `['text','image']`。
     → `.env` の問題なし、config.toml は画像ツールを切っていない、model は画像の入力に対応。版が 0.163.0 ではなく 0.159.0 だったので、その版の source で log の読み方を確かめた（DEV-080）。以下は記録として残す手順:
     jail の中の `sr-designgen` で（capture helper のある machine では `sudo -iu sr-designgen` は nologin で使えず、jail の外の `sr-designgen` の process は helper を `REQUESTER_PRIVILEGED` にする: `design-worker-wsl.md`・`design-capture-helper.md`・`design-wsl-isolation.md`）。
     **`.env` の確認を最初に**: Codex は `--version` でも、clap の前に `$CODEX_HOME/.env` を自分の環境に読み込む（arg0 の `load_dotenv`）ので、`.env` があれば `codex` を 1 つも起動せずに止まる:

     ```bash
     sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
     H="${CODEX_HOME:-$HOME/.codex}"
     if [ -e "$H/.env" ] || [ -L "$H/.env" ]; then ls -la "$H/.env" | cut -c1-10; echo "STOP: $H/.env exists (contents not shown); no codex command was run"; exit 0; fi
     echo ".env: absent"
     codex --version
     npm ls -g --depth=0 @openai/codex 2>/dev/null | tail -n +2
     grep -n -E "^[[:space:]]*(model|model_provider|model_reasoning_effort|profile)[[:space:]]*=|image_generation|imagegen|^\[features\]" "$H/config.toml" 2>/dev/null || echo "config.toml: no matching line"
     codex debug models --bundled 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); [print(m.get(\"slug\"), m.get(\"input_modalities\")) for m in d.get(\"models\", [])]" | head -20'
     ```

     分かること: `.env` の有無（あれば DEV-078 は `CODEX_DOTENV_PRESENT` で止まる。中身は見ない・貼らない。人が jail の中で消すか移す。その後もう一度 21a）、版（0.163.0 か、もっと古いか）、config.toml が `image_generation = false` にしていないか、使う model が画像の入力に対応しているか（`image_generation_available` の条件）。`--bundled` は binary の中の一覧だけを読む（network なし）。
     返してほしいもの: 出力そのまま（秘密は含まない）。
     任意（同じ `admin.sh run sr-designgen -- /bin/bash -lc '…'` の中で、`.env` が無いと確かめた後に）: `codex features list | grep -E "^image_generation"`（model の呼び出しはないが、cloud の設定を取りに network に出うる。利用枠は使わない）。
  2. **21b — v1 の再走（実績のある prompt、Codex 1 回）。済み（2026-10-22、人が develop c3fa813 で流した）**: CLI 0.159.0・model `gpt-6.1-sol`・prompt 4 754 字・
     `hist=paginated tool_mode=unknown cm_cells=1 cm_ref=1 img_calls=1 img_ok=0 img_failed=1 img_fail=OTHER` → `outcome=TOOL_FAILED`・`class=capability`・stop `CODEX_IMAGE_TOOL_FAILED`、画像なし。
     → model は code mode の cell から imagegen を呼び、images の要求そのものが失敗した（`image_gen` の usage limit ではない）。理由の切り分けは DEV-081（`img_fail_type=` `img_fail_reason=` `img_http=` `img_err=` と models cache の欄）、次の確認は HUMAN-022（Codex を呼ばない）。以下は記録として残す手順:
     HUMAN-020 から少なくとも数時間（できれば翌日）空けて、画像の利用枠の窓が戻ってから:

     ```bash
     sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
     S=~/.local/state/sr-design-worker; mkdir -p "$S" && chmod 700 "$S"
     flock -n "$S/run.lock" sh -c "cd ~/work/second-root && timeout 180 git fetch -q --no-tags origin +refs/heads/develop:refs/remotes/origin/develop && timeout 60 git checkout -q --force --detach origin/develop" \
       || { echo "STOP: a design worker run is in progress; nothing was changed"; exit 3; }
     cd ~/work/second-root && SR_DESIGN_IMAGE_POC_DIRECTION=v1 ./scripts/sales-design-worker/design-image-poc.sh --human-approval-confirmed'
     ```

     費用: Codex 1 回（画像生成つき、ChatGPT の plan の枠、API の課金なし、自動の再試行なし、15 分 / 全体 3300 秒）。
     分かること（DEV-080 の後。まず `cli=0.159.0 hist=paginated` と `tool_mode=` を見る）: v1 で画像が出る → 今日の環境は動く、v2 の prompt が疑わしい（21c へ）。v1 も画像なし →
     `outcome=TOOL_FAILED_USAGE_LIMIT` / `POC_STOP: CODEX_QUOTA` なら画像の利用枠（Extension item の構造化された失敗）。`TOOL_FAILED*` / `CODEX_IMAGE_TOOL_FAILED` ならツールは呼ばれて失敗した（`img_fail`。code mode では `cm_ref=1`・`img_calls≥1` で `function_call` が無いのが普通）。
     `TOOL_NOT_SEEN_CODE_MODE`（class `inconclusive`）なら、code mode（`cm_cells>0` か `tool_mode=code_mode_only`）で呼び出しが見えないだけで、**試みたかどうかは分からない**（引数の検査で始まる前に断られた呼び出しは何も残さない。0.159.0 の log にはツールの一覧も無い）。prompt の問題とは読まない。次の一手は runbook の提案「`-m gpt-5.5` で imagegen を direct のツールにする」（挙動の変更なので人の承認と別の PR が要る）。
     `TOOL_NOT_CALLED` を信じてよいのは `tool_mode=direct`（か `unknown`）**かつ** `cm_cells=0` のときだけ（+ `answer=TEXT_TOOL_UNAVAILABLE` ならツールが出ていない、`TEXT_OTHER` / `TEXT_REFUSAL` ならモデルが文章を選んだ）。
  3. **21c — v2（DEV-078 の版、prompt は HUMAN-020 と同じ）、Codex 1 回。保留（2026-10-22、人の判断）**: 21b の v1 が画像を出さなかったので流さない。v1 が再び画像を出すまで保留。21b で v1 が画像を出した後だけ。コマンドは 21b から `SR_DESIGN_IMAGE_POC_DIRECTION=v1 ` を外したもの（HUMAN-020 と同じ）。
     分かること: `outcome=` と `answer=` で、呼んで失敗した（`TOOL_FAILED*`）か、呼ばなかった（`TOOL_NOT_CALLED`、direct mode で `cm_cells=0` のときだけ）か、code mode で分からない（`TOOL_NOT_SEEN_CODE_MODE`、`inconclusive`）かが分かる。
     `TOOL_NOT_CALLED` + `TEXT_OTHER` / `TEXT_REFUSAL` のときだけ、v2 の prompt を v1 の実績のある指示の書き方に寄せる修正（別 Task、根拠つき）を提案する。`TOOL_NOT_SEEN_CODE_MODE` では prompt を直さず、21b と同じく direct mode の model の提案（人の承認）へ。
  - 最小の画像 probe（1 行の prompt で「赤い丸を 1 枚」）は、21b の v1 が（direct mode で）`TOOL_NOT_CALLED` + `TEXT_OTHER` で曖昧なときだけ提案する（今は作っていない。作るなら PoC の 3 つ目の direction として別の小さい PR と別の承認）。
- 触れないもの: HUMAN-019 / 020 と同じ（DB・Staging・Production・Vercel・flag・worker の timer / queue / 結果・asset store・送信・GitHub）。同時に `design-demo.ts`・`photo-poc.sh`・手動の `codex exec` を流さない。`~/.codex/config.toml` は変えない（DEV-078 は command line の `-c` だけ）。
- 返してほしいもの: 各段の出力（21a）／`POC_STOP` または `POC_IMAGE_READY` の行と `POC_DIAG_SUMMARY` の 1 行（21b・21c）。
- 解除条件: 21b と（必要なら）21c の結果が届く、または人が流さないと決める。

### HUMAN-020 — DEV-077 の修正の後に、第2案（v2）を WSL でもう 1 回だけ流す承認

- 状況（2026-10-21）: **人が 1 回流した（develop cae33e8、direction v2、prompt 6801 文字）。結果は `CODEX_NO_IMAGE`**: exit 0・`image_tool=0/0`・`agent_msgs=1`・`agent_chars=32`・`errors=0`・`turn=completed`・`thread_dir=0`・画像 file 0・Codex 約 183 秒。
  調査と対策は DEV-078（Codex は流していない）。次は HUMAN-021（手元の確認 → v1 の再走 → v2）。

- 背景: HUMAN-019（develop 1effb40、v2）は Codex の呼び出しは始まったが `CODEX_NO_IMAGE` で止まり（`design-image-poc.ts` exit 1、画像なし）、理由が分からなかった。
  DEV-077 は Codex を流さずに (1) 理由を分ける診断（`POC_DIAG` / `POC_DIAG_SUMMARY`、固定の符号と数だけ）を足し、(2) v2 の prompt を締めた
  （最初に組み込みの画像生成ツールだけを使う・答えは 1 枚の raster 画像で HTML / CSS / code や文章の説明ではない・ツールが使えなければ代わりをせずエラーを答える、
  coding agent に作る作業と読める語を外す、禁止の重複を 1 回に、12379 → 6801 文字、上限は v1 の 1.5 倍 7131 を test で固定）。禁止事項はどれも変えていない。
- 前提: DEV-077 の PR が develop に merge されていること（log の `direction v2` と、最後の方に `POC_DIAG_SUMMARY` の行が出ることで確かめる。出なければ古い develop）。
- コマンド（HUMAN-019 と同じ。jail の中、timer はそのまま）:

  ```bash
  sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
  S=~/.local/state/sr-design-worker; mkdir -p "$S" && chmod 700 "$S"
  flock -n "$S/run.lock" sh -c "cd ~/work/second-root && timeout 180 git fetch -q --no-tags origin +refs/heads/develop:refs/remotes/origin/develop && timeout 60 git checkout -q --force --detach origin/develop" \
    || { echo "STOP: a design worker run is in progress; nothing was changed"; exit 3; }
  cd ~/work/second-root && ./scripts/sales-design-worker/design-image-poc.sh --human-approval-confirmed'
  ```

- 費用・時間: Codex の呼び出し **1 回**（画像生成つき、ChatGPT の plan の枠、API の課金なし）。**自動の再試行はない**（失敗しても 2 回目は流れない）。1 回は 15 分で打ち切り、全体 3300 秒以内。
- 触れないもの: HUMAN-019 と同じ（DB・Staging・Production・Vercel・flag・worker の timer / queue / 結果・asset store・送信・GitHub）。同時に `design-demo.ts`・`photo-poc.sh`・手動の `codex` を流さない。
- 返してほしいもの（どれも秘密を含まない）:
  - 画像ができたとき: `POC_IMAGE_READY` の後の `mockup.png` を runbook の「第2案 › Viewing」で `kakuu-kaan-mockup-v2.png` として見て upload（と `report.json`）。評価は HUMAN-019 と同じ rubric
  - 止まったとき: `POC_STOP: <符号>` の行と、`POC_DIAG_SUMMARY …` の 1 行（または `sudo cat <POC_DIAG の path>` の diagnostics.json）
  - どちらの場合も `POC_DIAG_SUMMARY` の行があれば一緒に（prompt・Codex の文章・path・file 名・thread id・env の値は入っていない）
- 解除条件: 画像か停止の符号（と診断の行）が届く、または人が流さないと決める。

### HUMAN-019 — DEV-075 の design image PoC 第2案（v2）を WSL で 1 回流す承認

- 何: 架空菓庵の Web デザイン comp の PNG を 1 枚、第2案の art direction（`design-library/poc/wagashi-art-direction-v2.json`、0.3-poc）で `sr-designgen` の ChatGPT サインインの Codex（組み込み画像生成）に作らせる。
  header nav（「商品・こだわり」「店舗情報」の 2 つ）・Hero（店名と、どら焼きの断面の和菓子の画像）・商品・こだわり（商品の画像の card 2〜3 枚、caption は説明文の言葉そのままだけ）・店舗情報（定義リスト）の 3 節、縦 2:3。
  道具は HUMAN-018 と同じ `scripts/sales-design-worker/design-image-poc.sh`（v2 が既定）、手順・画像の見方・評価は `docs/operations/design-image-poc.md` の「第2案」。Claude は WSL に触れない。
- 方針の変更（2026-10-21、人が承認）: 和菓子そのもの（どら焼き・上生菓子・粒あんの接写）と抽象的な素材（和紙・木の盆・器・麻）の AI 生成の画像を、**提案用のイメージとしてだけ**許す（実際の店の商品の写真として扱わない）。
  引き続き禁止: 架空の店舗の AI 画像（外観・内観・店員・人・手・看板）、Instagram や第三者の写真・デザインの模倣、logo・紋、画像が実物だと言う文、価格・口コミ・受賞・沿革・人物の創作。
  画像の中の表示は「架空店舗のデザイン提案｜和菓子の画像はAI生成のイメージです」。fixture の「テスト」の値は出さなくてよい（fixture は変えない）。
  **この方針と v2 は PoC の中だけ**（worker・demo の生成・preset・renderer・asset store は読まない。静的 test で固定）。worker・demo・Production での採用は、評価と別の人の承認が要る。
- 前提: DEV-075 の PR が develop に merge されていること（古い develop では v1 が流れる。log の `direction v2` と `report.json` の `direction_version: "v2"` で確かめる）。
- コマンド（HUMAN-018 と同じ。jail の中、timer はそのまま）:

  ```bash
  sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
  S=~/.local/state/sr-design-worker; mkdir -p "$S" && chmod 700 "$S"
  flock -n "$S/run.lock" sh -c "cd ~/work/second-root && timeout 180 git fetch -q --no-tags origin +refs/heads/develop:refs/remotes/origin/develop && timeout 60 git checkout -q --force --detach origin/develop" \
    || { echo "STOP: a design worker run is in progress; nothing was changed"; exit 3; }
  cd ~/work/second-root && ./scripts/sales-design-worker/design-image-poc.sh --human-approval-confirmed'
  ```

  （v1 をもう一度流すときだけ `./scripts/…` の前に `SR_DESIGN_IMAGE_POC_DIRECTION=v1 ` を付ける。それ以外の値は `POC_DIRECTION_INVALID` で何もせず止まる）
- 費用: Codex の呼び出し **1 回**（画像生成つき）、ChatGPT の plan の利用枠。API の従量課金なし（API key は子 process に渡らず、API key のサインインは拒否）。
- 時間: Codex の 1 回は 15 分で打ち切り（通常は数分）。全体の上限 3300 秒（55 分）。
- 触れないもの: DB・Supabase（Staging / Production）・bridge・Vercel・flag・cycle・worker の timer（止める・戻す・有効化するのどれも）・worker の queue / 結果 / ledger・
  asset store・公開 `/demo`・実営業の送信・GitHub（commit・push しない）。参照画像なし、店舗・人物の画像なし、店舗の事実は fixture のまま。出力は
  `~/sr-design-image-poc/wagashi-XXXXXX/` だけ（repo の外、公開しない）。
- 同時に流さないもの: この PoC の間は `design-demo.ts`・`photo-poc.sh`・手動の `codex` を同じ `sr-designgen` で流さない（これらは run.lock を取らず、PoC の開始時の掃除と終了時の画像 dir の差分が、同時に動く call の session log / 画像を消しうる）。
- 人の操作: (1) この 1 回を承認する、(2) 上のコマンドを流す、(3) runbook の「第2案 › Viewing」で `mockup.png` を Windows の Desktop に `kakuu-kaan-mockup-v2.png` として写して見る、
  (4) その PNG（と `report.json`）を Claude の session に upload する。止まったら表示された `POC_STOP: <符号>` を渡す。
- 評価: 画像ができただけでは DEV-075 は終わらない。`docs/operations/design-image-eval-template.md` の 5 項目（各 1〜5）で Claude が採点し人が確認、**22/25 以上（人の目標）・hard fail なし**で合格。hard fail（事実の創作・店舗 / 人物の画像・表示の欠落・logo / 実物の主張・事実の崩れ）は人の決めた規則そのもの。「4 未満の項目なし」は当初 Claude の提案だったが、2026-10-22 に人が採用した（「22/25点以上、各項目4点以上を基本方針とする」）。合格は 22/25 以上・各項目 4 以上・hard fail なし。DEV-082 の `comp-impl/bundle.ts` は合計だけを検査しているので、各項目の検査は #96 の merge の後の follow-up（DEV-083 の PR #98 に記載）。
- 解除条件: 画像（または停止の符号）が届く、または人が流さないと決める。
- 状況（2026-10-21）: **人が 1 回流した（develop 1effb40、direction v2）。結果は `CODEX_NO_IMAGE`**（Codex の呼び出しは始まり、`design-image-poc.ts` は exit 1、画像なし）。
  理由を分ける診断は当時なかった。調査と修正は DEV-077（診断の追加と v2 の prompt の修正、Codex は流していない）。次の 1 回は HUMAN-020。

### HUMAN-018 — DEV-074 の design image PoC を WSL で 1 回流す承認

- 何: 架空菓庵（DEV-073 の fixture）の Web デザイン mockup の PNG を 1 枚、`sr-designgen` の ChatGPT サインインの Codex（組み込み画像生成）に作らせる。
  道具は `scripts/sales-design-worker/design-image-poc.sh`、手順・しないこと・停止の符号・画像の見方は `docs/operations/design-image-poc.md`。
  Claude は WSL に触れない（この container では fake sandbox の test だけ）。
- 前提: PR #88 が develop に merge されていること（wrapper は lock の中で `origin/develop` に合わせる。無ければ `POC_NOT_ON_REF` で止まる）。
- コマンド（jail の中、timer はそのまま。doc の「Run」と同じ）:

  ```bash
  sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
  S=~/.local/state/sr-design-worker; mkdir -p "$S" && chmod 700 "$S"
  flock -n "$S/run.lock" sh -c "cd ~/work/second-root && timeout 180 git fetch -q --no-tags origin +refs/heads/develop:refs/remotes/origin/develop && timeout 60 git checkout -q --force --detach origin/develop" \
    || { echo "STOP: a design worker run is in progress; nothing was changed"; exit 3; }
  cd ~/work/second-root && ./scripts/sales-design-worker/design-image-poc.sh --human-approval-confirmed'
  ```

- 費用: Codex の呼び出し 1 回（画像生成つき）、ChatGPT の plan の利用枠。API の従量課金なし（API key は子 process に渡らず、API key のサインインは拒否）。
- 時間: Codex の 1 回は 15 分で打ち切り（通常は数分）。全体の上限 3300 秒（55 分、jail の 1 回の実行 3500 秒の中、run.sh と同じ）。
- 触れないもの: DB・Supabase（Staging / Production）・bridge・Vercel・flag・cycle・worker の timer（止める・戻す・有効化するのどれも）・worker の queue / 結果 / ledger・
  asset store・公開 `/demo`・実営業の送信・GitHub（commit・push しない）。参照画像なし、写真なし（食品・店舗の写真 / render を禁止）、店舗の事実は fixture のまま。出力は
  `~/sr-design-image-poc/wagashi-XXXXXX/` だけ（repo の外、公開しない）。
- 同時に流さないもの: この PoC の間は `design-demo.ts`・`photo-poc.sh`・手動の `codex` を同じ `sr-designgen` で流さない（これらは run.lock を取らず、PoC の開始時の掃除と終了時の画像 dir の差分が、同時に動く call の session log / 画像を消しうる）。
- 品質の注意: fixture の menu は全品「テスト」入り、説明文の頭は「比較用の架空の和菓子屋です。実在の店舗ではありません。」、access は「テスト線テスト駅」。
  prompt はこれらを画像から省くことを許す（事実は変えない）。menu の無い mockup は失敗ではない。
- 人の操作: (1) この 1 回を承認する、(2) 上のコマンドを流す、(3) doc の「Viewing the result」で `mockup.png` を Windows の Desktop に写して見る、
  (4) その PNG（と `report.json`）を Claude の session に upload する。止まったら表示された `POC_STOP: <符号>` を渡す。
- 解除条件: 画像（または停止の符号）が届く、または人が流さないと決める。
- 状況（2026-10-21）: 人が 1 回流し、画像を見た（和風だがポスター風で、Web サイトとしての営業の訴求が弱い）。第2案は DEV-075 / HUMAN-019。

### HUMAN-017 — DEV-073 の 3 店の比較を WSL で流す承認と操作

- 何: Stage 1 の比較（design-agent-direction §8 の 5・7、design-spec-stage1.md §8-3）。架空の 3 店（和菓子・コーヒースタンド・ブーランジュリー兼パティスリー）を
  worker と同じ pipeline（実 Codex）に流し、baseline（今の頁）と比べる。道具は `scripts/sales-design-worker/compare-local.sh`、手順・時間と費用の見込み・
  しないこと・report の読み方は `docs/operations/design-compare-local.md`。Claude は WSL に触れない（この container では fake Codex の test と手書きの spec の demo だけ）。
- 範囲: local の `~/sr-design-compare/<compare id>/` だけ。DB・bridge・Staging・Production・flag・cycle・timer・送信・worker の queue と結果には触れない。参照画像なし、写真なし。
  Codex は 3 店で 6〜21 回（ChatGPT の plan の枠、API の課金なし）、通常 15〜30 分、上限 3300 秒（55 分。jail の 1 回の実行 3500 秒の中、run.sh と同じ）。
  worker の timer には一切触れない（同時に走らないことは run.lock で保つ）。入口は `compare-local.sh` だけ（`compare.ts` の直接起動は止まる）。
  結果は参照なし・架空の店の条件なので、styling の差は実際の job より控えめに出うる（doc の「条件の偏り」）。
- 人の操作: (1) この実行を承認する、(2) まず `--mode baseline`（Codex なし）で道具の動作を確かめる、(3) `--mode design --compare-id cmp-001 --human-approval-confirmed` を
  jail の中で流す（doc の 1 コマンド。timer はそのまま）、(4) `compare-report.md`（と `.json`・`contact-sheet.png`）を Claude に渡す。時間切れで止まったら、
  それまでの report と符号を渡す（残りの店は新しい compare id と `--shops` で流せる）。
- 解除条件: design の report が届く（または人が流さないと決める）。

### HUMAN-016（任意）— WSL に残る generated_concept の PoC asset の削除（DEV-070）

- 何: DEV-029 の写真 PoC（poc-photo-001〜005 など）で入れた `generated_concept` の画像と manifest が、WSL の worker 利用者の asset store に残っているかもしれない。DEV-070 から、その manifest は無効として読み込まれず（写真なしの表示になり、worker は失敗しない）、画像が頁に出ることは無い。消すのは任意の後片付け。
- 場所（コードの規則: `lib/design-agent/assets/store-root.ts`）: `SR_DESIGN_ASSETS_ROOT`（絶対 path のとき）、無ければ `$HOME/.local/share/second-root-design-assets`。worker 利用者 `sr-designgen` なら `/home/sr-designgen/.local/share/second-root-design-assets/<job id>/`（`manifest.json` と `asset-<24 桁の hex>.png`）。PoC の job id は `poc-photo-*`、preview-check の一時 store は終了時に自動で消える。
- 入力に置いた元画像があれば `/home/sr-designgen/sr-design-input/poc-photo-*/`（`concept-*.png`）も対象。
- 人の操作（任意）: 中身を確かめて、`generated_concept` を含む job の directory を消す。Claude は WSL に触れない（何も実行していない）。
- 解除条件: 人が消した、または残すと決めた。

### HUMAN-015 — Claude の Supabase（Staging）読み取りが 401

- 何: 2026-10-20、この session の proxy が入れる Supabase の token が `Invalid access token`（401）になった。Vercel の読み取りは動く。controlled run の前後の読み取り（`.ai/runbooks/controlled-run/snapshot.sql`・`after.sql`）が Claude からできない。
- 人の操作: Supabase で read-only に使える新しい access token を発行し、Claude の cloud environment の設定（session の title bar の environment メニュー → Edit → Network secrets）で `api.supabase.com` の値を差し替える。新しい session から有効。値は会話・GitHub に出さない。古い token は revoke。
- 代わり: 人が Supabase SQL editor で `snapshot.sql`・`after.sql` を実行し、結果（profile の中身は含まない）を貼ってもよい。
- 解除条件: Claude の read-only query が通る。
- 2026-10-20 人の判断: 新しい token は今は発行しない。読み取りは人の側の Supabase 接続（ChatGPT 経由、read-only）で行う。Claude からの読み取りは 401 のまま（未解除のまま残す。必要になったら上の手順で）。
- 2026-10-20 人が `snapshot.sql` を read-only で実行（事前の写し）: demo `efb4bdb2-5fb8-4575-b2e1-76217a832485`・`ready`・attempts 1・job `0fdbda79-794a-410b-931f-9677628742a3`・worker commit `f562166fda314af32d7c0b60a2c6f0f4262fa697`・updated_at 2026-10-16 10:10:44.754171+00・profile_md5 `89911ff811874960e23ae80d449e4542`・profile_bytes 722・outreach initial / instagram / drafted / 未送信・do_not_contact false・disabled_at null・queue_open 0。手順 A の前提はすべて満たす。

### HUMAN-010 — design worker の cycle（DEV-052）の WSL への install と timer の有効化

- 何: `scripts/sales-design-worker/cycle.sh` と `scripts/sales-design-worker/systemd/sr-design-cycle.{service,timer}` を、root の admin clone（`/root/sr-capture-admin`）から install し、dry-run の後に timer を有効化する。手順は `docs/operations/design-worker-cycle.md`。
- 前提: Staging の `SALES_AI_DESIGN_ENABLED=true` と Vercel Preview の bridge 経路が常時使えること（今は controlled rerun のたびに一時開放）。これは Authentication の常時の扱いに関わるため、別途人の判断。
- 状態（2026-10-19、人）: **保留**。timer は有効化しない。Vercel Authentication は維持し、認証された bridge だけが通る方式を Claude が検討する。
- 人の判断が要る点（PR #66）: bridge を `sudo -u` でなく `runuser` で動かす・`/etc/second-root/design-cycle.conf` に承認した bridge の SHA を置く・preflight SERIAL を OK とする・最初の deliver-only は全件 0 を求める・回復 SQL（job id と processing を条件）。
- 解除条件: 人が install と dry-run（`CYCLE_DRY_RUN_OK`）を行い、timer の有効化を承認する。
- 残りの前提（2026-10-20 整理、どれも人の判断・操作）:
  1. HUMAN-013（bypass の接続、`BYPASS_OK`）。これで「Authentication を外す」「復旧タスク 2 つ」は不要になる。
  2. controlled run 用の design job: Staging の demo は 3 件とも `ready`（2026-10-20 の読み取り）で、claim できる job が 0。用意の仕方を人が選ぶ: (a) flag ON の間に Operational Claude の Staging run で新しい店を準備（`AIデザイン待ち` の demo ができる。外部の公開ページの読み取りあり、1 日 5 件まで、送信はしない）、(b) 既存の `ready` の demo 1 件を `pending` に戻す SQL（DB の書き込み、人の承認、今の profile は次の結果で置き換わる）。
  3. flag の扱い: controlled run の window の間だけ Staging の `SALES_AI_DESIGN_ENABLED=true`（Vercel の env の変更 + develop の redeploy、人の承認）。常時 ON にするかは timer の前に別途判断（`design-worker-cycle.md` §7）。
  4. cycle の install（`design-worker-cycle.md` §4）: `/etc/second-root/design-cycle.conf` を作る（`SR_DESIGN_CYCLE_BRIDGE_SHA=` bridge の checkout の commit 40 文字、`SR_DESIGN_CYCLE_VERCEL_BYPASS=on`）→ setup script を `--replace` なしでもう一度（段 6 で dry-run、`CYCLE_DRY_RUN_OK`）→ window の中で `cycle.sh` を手で 1 回（`CYCLE_OK` か `CYCLE_IDLE`、bridge の段に `vercel protection bypass in use`）→ unit を置いて unit の中で 1 回（hardening の下での動作は実機で未確認）。
  5. PR #66 の判断: bridge を `runuser` で動かす・conf に承認した bridge の SHA を置く・preflight の SERIAL を OK とする・最初の deliver-only は全件 0・claim 後に止まったときの回復 SQL（job id と processing を条件）。
  6. Instagram のログインが有効であること（`LOGIN_REQUIRED` なら `admin.sh login`。cycle は回避せず止まる）。
  7. 上がすべて済んでから timer の enable を承認（`design-worker-cycle.md` §5）。
- controlled run の手順（2026-10-20 再更新、DEV-064 merge 後）。正本は `docs/operations/design-flag-window.md`。SQL は `.ai/runbooks/controlled-run/`
  - 状態: 対象 demo `efb4bdb2-5fb8-4575-b2e1-76217a832485` は人の承認済みの更新で `pending`（attempts 1、queue_open 1、outreach drafted 未送信）。**再度 reset しない**。restore 用 SQL は人の PC に保存済み。flag `false`・期限なし・timer 無効
  - flag の操作・redeploy・確認は Claude（`npm run staging:design-flag`、Preview develop だけ、期限つき）。期限で app が自然に無効、加えて期限 + 10 分の独立した復旧 session
  - 残りの承認: (R) 予行（one-shot の scheduled task 1 つ、新しい session が develop で `status` を実行し `.ai/progress.md` に 1 行 push。Vercel・DB は書かない）→ (W) window（復旧 task の作成・`on --until`（開始 + 150 分）・push・verify・終了時の `off`・push・verify・task の削除）→ (C) 人が WSL で `cycle.sh --dry-run` → `cycle.sh` を 1 回（期限まで 80 分以上あるときだけ）
  - 開始前チェック: 予行が通った / `status` が flag false・production branch main / `staging:bypass-status` が auth on・bridge_secret present / Sales Agent の scheduled task 2 つが無効 / demo が pending・attempts 1・queue_open 1（人の read-only） / 人が window の 2.5 時間 WSL にいられる
  - 復旧: 上の「復旧」と同じ。flag は window の終わりに必ず `false`（`design-flag-window.md` §5）
  - 予行 R の結果（2026-10-20）: 新しい session の起動・checkout・Vercel の読み取りは成功、develop への push は 403（scheduled task の session に repo が付かない）→ DEV-065（e59121d）で復旧 session を Vercel の API だけ（`off --if-until` + `status`、push なし）に変更
  - DEV-065 の書き込み確認（2026-10-20、人の承認 1 回）: 独立 session（`trig_0158TxdeGYFqU9Fj2CwDNGxX` → `cse_01FYXGAaGhMLhpV2oXy4TGrg`、`run_once_fired`・`enabled: false`）が `write-check --id rMGvxH8aHWZZC5Z5` を 1 回 → `WRITE_CHECK_OK`（false の上に false、他の env・Production・Authentication は不変）。その後 Claude が develop に記録を push し `verify --expect off`
  - **残りの承認**: (W) window を開く（`design-flag-window.md` §3・§7: 復旧 task の作成・`on --until <T+150 分>`・push・`VERIFIED_ON` → cycle の後に `off`・push・`VERIFIED_OFF`・task の削除）/ (C) 人が WSL で事前確認（§7）→ `cycle.sh` を 1 回。demo efb4bdb2 は pending のまま（再 reset しない）。DB の読み取りは人の側（HUMAN-015）

### HUMAN-007 — Production 準備と Release PR #29 の merge（DEV-019）
- 状態: **PR #29 を main へ merge 済み（2026-09-28、b14aab7。人間の明示承認に基づき Claude が実行）**。残りは merge 後の人間の作業。
  - **smoke test**（`docs/RELEASE.md` §8 の 5）: 管理者ログイン・非管理者の拒否・token ありの ingest `status`。
    - Claude が credential なしで確認済み: `/`・`/privacy`・`/terms`・`/robots.txt` は 200、`/admin/login` は 200、ingest の token なしは 401、不明なデモは 404、private route の header あり。
  - **Production Routine**（§8 の 6）: 別の environment を作る。API credential は `secondroot.jp` 限定で、bypass なし。まず手動で 1 回実行し、その後スケジュールを有効化する。
  - 最初の 1 週間は、送信前に人間が候補を確認する。Release の技術的な条件（CI・review・Staging 実走・DEV-025）はすべて満たした。
- PR #29（develop → main）は、人間の明示承認（2026-09-28）があるまで Draft のままにしていた。merge は、その承認に基づき Claude が行う。Claude は Production の DB・環境変数を変更しない。
- main（PR #27）との衝突は PR #39 で解消した（両方 Next.js 16.3.6、develop 側を採用）。
- 人間にお願いすること（この順番。詳細は `docs/RELEASE_READINESS.md` §13）:
  1. Production 用の Supabase project（HUMAN-002）
  2. migration 16 本の適用（`supabase db push`）
  3. `staging:verify --project-ref <prod-ref>` で確認
     - 人間が自分の端末で、Production に絞った短期の token を使って実行する。
     - Claude には Production 用の token を渡さない（Management API の token は任意の SQL を実行できる）。
     - 結果の PASS / FAIL 一覧を Claude に貼れば確認する。
  4. Auth の設定（sign-up OFF・パスワード 12 文字以上）
  5. 管理者の作成と `sales_admins` への登録（人間）
     - この後 verify の 14 項目すべて PASS を確認し、token を Revoke する。
  6. Vercel の **Production だけ**に 5 つの変数を設定する
     - Supabase の 3 つ・新しい ingest token・`SALES_DEMO_BASE_URL=https://secondroot.jp`
     - `INSTAGRAM_*` はまだ入れない。
  7. Deployment Protection を確認する（`secondroot.jp` が公開のままであること）
  8. PR #29 の CI が green で、衝突がないことを確認する
  9. Draft を外して人間が merge する
- merge 後: smoke test、Production の Routine（host `secondroot.jp` 限定の API credential）、最初の 1 週間は送信前に人間が確認する。
- 解除条件: PR #29 が merge され、Production の smoke test が通ること。
- 2026-09-28 人間が完了・確認したこと（secret の値は書かない）:
  - Production project `second-root-production`（ref `sagjzgcpqcbrqbokawiz`、Tokyo）に migration 16 本を適用し、`staging:verify` で **14/14 PASS** を確認した。
  - Auth: public sign-up OFF・Confirm email ON・パスワード最小長 12。
  - 管理者 1 名を作成し、`sales_admins` に登録した。
  - 確認に使った token は Revoke した。
  - Vercel Production に 5 変数を設定した（Supabase の 3 つ・`SALES_AGENT_INGEST_TOKEN`・`SALES_DEMO_BASE_URL=https://secondroot.jp`）。既存の Production の変数は変更していない。`INSTAGRAM_*` は未設定。
  - Vercel Authentication は Standard Protection のまま。`secondroot.jp` は Production の custom domain として公開する構成。
  - 古い main の再デプロイはしていない。

### HUMAN-006 — Instagram 公式 Messaging API の Meta 側設定（DEV-024）
- 対象 Task: DEV-024（DEV-020〜023 のコード・DB・管理画面・テストは完成済み。実アカウントでの確認だけが残る）
- 状態: 人間待ち（MVP の Release とは独立。HUMAN-004 の Staging があると先に安全に確認できる）
- 必要な操作と値（手順・画面の場所は `docs/INSTAGRAM_SETUP.md`）:
  1. Meta App を作成（ユースケース: Instagram のメッセージとコンテンツを管理）
  2. Second Root の Instagram プロアカウントを接続し、Instagram アプリで「メッセージへのアクセスを許可」をオン。権限は `instagram_business_basic` と `instagram_business_manage_messages`
  3. Vercel（Staging は Preview、本番は Production）に設定して再デプロイ:
     - `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`（`openssl rand -hex 32`）
     - `INSTAGRAM_APP_SECRET`
     - `INSTAGRAM_ACCOUNT_ID`
     - `INSTAGRAM_ACCESS_TOKEN`（60 日で失効。更新手順は §7）
  4. Webhook を登録: callback `https://<ドメイン>/api/webhooks/instagram`、verify token は 3 と同じ値、field は `messages`。アカウントの subscription もオンにする
  5. アプリを Live にする。自社アカウント用なので Standard Access（App Review 不要）の想定。一般ユーザーとのやりとりで失敗した場合だけ、Advanced Access（ビジネス認証 + App Review）を人間が判断する
  6. inbox Routine `second-root-sales-inbox` を作成（`ops/sales-agent/SCHEDULE.md` §5）
- 推奨: Staging で 1〜6 → `docs/INSTAGRAM_SETUP.md` §8 の確認表 → Release 承認後に Production で 3〜5。
- 解除後に確認すること（§8）:
  - Meta の Verify が成功する
  - 管理画面の「Instagram 連携を確認」が OK
  - 個人アカウントからの DM が「未照合」として表示される
  - Routine が返信案を作る
  - 「この内容で返信」で 1 回だけ届き、2 回目は「送信済み」になる
- Claude は Meta の画面操作・App Review 申請・token の扱いを行わない。

### HUMAN-003 — branch protection の required checks（推奨・非ブロッキング）
- 状態: 人間待ち（開発は止めない）
- 内容: GitHub → Settings → Branches で `main` と `develop` に branch protection を設定し、required status checks に `static` / `unit` / `integration` / `build` / `e2e` / `e2e-sales` を追加する。
- 理由: 現状 Claude は CI green を確認してから merge しているが、GitHub 側でも強制されると安全。
- DEV-004 で Claude が allowed_scope を拡張（GA を /demo・/admin で無効化、noindex / no-referrer ヘッダ、e2e 分割）。既存ページの挙動は不変とレビュー確認済み。異論があれば PR #12 を参照。

## 解除済み

### HUMAN-022 — HUMAN-018 と HUMAN-021b が CODEX_HOME に残したものを読む（Codex を呼ばない・費用 0。DEV-081）（解除: 2026-10-22）

- 結果（人が流した）: design-agent の thread は 79。画像の PoC の 4 回はどれも model `gpt-6.1-sol`・CLI 0.159.0・`hist=paginated`。`image_items` は次のとおり。
  - HUMAN-018（v1）: `failed/none/155584ms`、続けて `completed/none/32648ms`（画像あり）
  - HUMAN-019（v2）: `failed/none/157760ms`
  - HUMAN-020（v2）: `failed/none/155770ms`
  - HUMAN-021b（v1）: `failed/none/157684ms`
- 読み:
  - model の変更は原因ではない（4 回とも同じ）。v2 の prompt も原因ではない（v1 も失敗）。
  - HUMAN-019 / 020 は画像ツールを**呼んでいた**（`image_tool=0/0` は `--json` に item が無いため）。HUMAN-018 も最初の 1 回は同じ失敗。
  - 4 回とも最初の呼び出しが約 156 秒で失敗している → 調査は DEV-084、次は HUMAN-024。
- 当時の手順（記録）:

- 背景: HUMAN-021b は code mode で imagegen を呼び、images の要求そのものが失敗した（`img_fail=OTHER`）。rust-v0.159.0 の source（DEV-081、`docs/operations/design-image-poc.md` の「Why a called image tool failed」）では、
  構造化された `failure` は limit id が `image_gen` の usage limit のときだけで、他の失敗（別の limit id の 429・4xx・5xx・timeout・接続・認証）はすべて `failure: null`。HTTP の状態は session log に残らない（cell の script が表示したときだけ）。
  一方、PoC の掃除は `sessions/**/rollout-*.jsonl` しか消さず、Codex の `state_5.sqlite`（threads: model・reasoning_effort・cli_version・history_mode・作成時刻）と
  `thread_history_1.sqlite`（paginated の item: `imageGeneration` の status・failure・開始と終了の時刻）と `models_cache.json`（最新の catalog）は残る。
- 何: runbook の「HUMAN-022」のコマンド（jail の中の `sr-designgen`、run.lock の中、SQLite は `mode=ro`、network・model・`codex` の process なし）。印字は固定の欄だけ（thread id・cwd・題・最初の message・prompt・結果・path・identity・ETag は出さない）。
- 費用: なし（Codex 0 回）。
- 分かること: HUMAN-018 と HUMAN-021b の model が違うか（違えば server 側の既定の model の変更が最有力 → `-m` の案）、21b の失敗が即座か（4xx）長くかかったか（5xx / timeout）、HUMAN-019 / 020 が画像ツールを呼んだか、catalog の先頭の model と `tool_mode`・画像入力。
- 触れないもの: HUMAN-021 と同じ。CODEX_HOME の行・既存の file は変えない（SQLite は `mode=ro` で開く。WAL の DB では SQLite が空の `-wal` / `-shm` を作ることがあるので「何も書かない」とは言わない。`immutable=1` は使わない）。`codex` を起動しない。
- 返してほしいもの: 出力そのまま（秘密は含まない）。
- 解除条件: 出力が届く、または人が流さないと決める。

### HUMAN-014 — cycle の install と dry-run（timer なし、HUMAN-010 の一部）（解除: 2026-10-20）

- 何: `/etc/second-root/design-cycle.conf` を作り（bridge の commit と bypass のスイッチ）、setup script を `--replace` なしで動かして段 6 の `cycle.sh --dry-run` まで通す。unit は置かない・timer は enable しない・flag は変えない・DB は変えない。
- 前提: root の clone `/root/sr-capture-admin` は c066618（HUMAN-013 で合わせた）、bridge の checkout は 90c4c38caef5dafc539121195a6fd4d48753f477。
- 人の操作（WSL、1 行。bridge の checkout が 90c4c38 で clean であること・conf がまだ無いことを確かめてから作る。どれかが違えば何も書かずに止まる）:
  `B=$(sudo -u sr-designbridge -H git -C /home/sr-designbridge/second-root rev-parse HEAD) && [ "$B" = 90c4c38caef5dafc539121195a6fd4d48753f477 ] && test -z "$(sudo -u sr-designbridge -H git -C /home/sr-designbridge/second-root status --porcelain --untracked-files=normal)" && sudo test ! -e /etc/second-root/design-cycle.conf && sudo install -d -o root -g root -m 0755 /etc/second-root && printf 'SR_DESIGN_CYCLE_BRIDGE_SHA=%s\nSR_DESIGN_CYCLE_VERCEL_BYPASS=on\n' "$B" | sudo tee /etc/second-root/design-cycle.conf >/dev/null && sudo chmod 0644 /etc/second-root/design-cycle.conf && sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh`
  - 値は聞かれない（file があるので `BYPASS_FILE_PRESENT`）。`BYPASS_OK` の後、段 6 で `cycle: vercel bypass: on` と `CYCLE_RESULT CYCLE_DRY_RUN_OK …`、最後の行 `BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6`。
  - dry-run が止まったら（`CYCLE_DRY_RUN_NOT_OK`）、表示された `CHECK_*` / `CYCLE_STOP_PREFLIGHT` の符号だけを Claude に渡す。conf は残してよい（cycle は timer なしでは動かない）。やめるときは `sudo rm /etc/second-root/design-cycle.conf`。
- 解除条件: 人の出力に `CYCLE_DRY_RUN_OK` と `cycle: vercel bypass: on`。
- 2026-10-20 人が WSL で実行: `CYCLE_CONFIG_CREATED`・`BYPASS_FILE_PRESENT`・`PROTECTION_ON`・`BYPASS_OK`・`CYCLE_SWITCH_ON`・`cycle: vercel bypass: on`・`cycle: checks: OK`・`CYCLE_RESULT CYCLE_DRY_RUN_OK phase=before_claim job=none exit=0`・`BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6`。unit・timer・flag・DB は変わっていない。

### HUMAN-013 — bridge 専用 Vercel bypass secret の作成と WSL への設定（DEV-059 / DEV-063）（解除: 2026-10-20）

- 状態（2026-10-20）: Claude 側の準備は完了（PR #76 merge c066618）。人の操作待ち。Vercel Authentication は ON のまま、secret は 2 つ（bridge 用は未作成）、Staging の `SALES_AI_DESIGN_ENABLED`（Preview・develop）は `false`。
- 人の操作 1（Vercel の画面）: second-root → Settings → Deployment Protection → Protection Bypass for Automation → Create。note は `Second Root design bridge (WSL)`。**env var にはしない**。既存の 2 つは変えない。表示された値をコピー（チャット・GitHub・Claude には貼らない）。
- 人の操作 2（WSL、1 行。root の clone を c066618 に合わせてから setup script を動かす。prompt に値を貼って Enter、画面には出ない）:
  `sudo git -C /root/sr-capture-admin fetch -q origin && sudo git -C /root/sr-capture-admin checkout -q --detach c066618cd6a40fe1cef57f75a71b755eea4157e8 && test -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" && sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh`
  - 成功: `PROTECTION_ON`・`BYPASS_OK`（`REACHED_APP design_bridge_disabled`。flag が OFF なので正しい）・`CYCLE_CONF_ABSENT`（cycle の conf は HUMAN-010 の前なので無い。失敗ではない）・最後の行 `BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6`。
  - 止まったら出力の符号を Claude に渡す（値は貼らない）。`BYPASS_REJECTED` は値の貼り間違い → 同じ 1 行の末尾に ` --replace` を付けて正しい値でやり直す。`PROTECTION_NOT_ON` は Authentication が外れている可能性 → すぐ Vercel を確かめる。
  - bridge の checkout（`~sr-designbridge/second-root`、90c4c38）は bypass の対応（DEV-059）を含むので更新不要。
- 解除条件: Claude が `npm run staging:bypass-status` で `bridge_secret=present`・`isEnvVar: false`・`auth=on` を値なしで確認し、人の出力の `BYPASS_SETUP_OK` を確かめる。
- 戻し方・失効: `docs/operations/design-bridge-access.md` §8（Vercel で note の secret を revoke、WSL の file を消す。redeploy 不要）。
- 2026-10-20 人の実機結果: `BYPASS_FILE_WRITTEN`・`BYPASS_ENV_APPENDED`・`PROTECTION_ON`・`REACHED_APP design_bridge_disabled`・`BYPASS_OK`・`CYCLE_CONF_ABSENT`・`BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6`。
- 2026-10-20 Claude の読み取り（`npm run staging:bypass-status`、値は出さない）: Authentication on（all_except_custom_domains）、Password / Trusted IPs / OPTIONS off、secret 3 つ。**ただし note が入れ違い**: #1（2026-08-22 作成・`isEnvVar: true`、全 deployment の env に入っている古いもの）の note が `Second Root design bridge (WSL)`、#3（2026-10-20 作成・`isEnvVar: false`）の note が `Second Root design bridge`（"(WSL)" なし）。結果 `bridge_secret=env_var`。WSL の file にどちらの値が入っているかは Claude からは分からない（どちらでも Vercel は通すので BYPASS_OK になる）。
- **未解除**。直し方（人、値は出さない）: (1) Vercel の Protection Bypass for Automation で #1 の note を元に戻す（空か `legacy env var (do not use)`）、#3 の note を `Second Root design bridge (WSL)` にする（note を変えられなければ #3 はそのまま、#1 の note だけ外す）。(2) #3（2026-10-20、env var でないもの）の値をコピーし、WSL で `sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh --replace` に貼る（`BYPASS_SETUP_OK` まで）。これで WSL の file が env var の secret でないことが確定する。(3) Claude が `staging:bypass-status` で `bridge_secret=present` を確認して解除。
- 2026-10-20 人が note を修正（#1 `Legacy automation env var`・#2 `Second Root Staging Claude`・#3 `Second Root design bridge (WSL)`）し、#3 の値で `--replace`: `BYPASS_FILE_REPLACED`・`BYPASS_ENV_PRESENT`・`PROTECTION_ON`・`REACHED_APP design_bridge_disabled`・`BYPASS_OK`・`CYCLE_CONF_ABSENT`・`BYPASS_SETUP_OK step=6`。
- Claude の読み取り（2026-10-20）: `VERCEL_BYPASS_STATUS OK auth=on bridge_secret=present`。Authentication on（all_except_custom_domains）、secret 3 つ、#3 は isEnvVar false、Staging の flag は "false"、develop の alias は a64cc4b で READY。値は表示・記録していない。

### HUMAN-012 — WSL の design bridge を DEV-058 / DEV-059 以降の commit に更新（任意、HUMAN-010 とは別）（解除: 2026-10-19）

- 何: `sr-designbridge` の checkout（`~sr-designbridge/second-root`）を承認した commit（f7e7712 以降）に `git checkout --detach <commit> && npm ci`。手順は `docs/operations/design-bridge.md` §5・§10。
- 推奨の順番: HUMAN-011（migration）→ Staging の server（develop の自動 deploy で済み）→ bridge → worker（worker は `SR_DESIGN_WORKER_REF=develop` で run ごとに develop に揃う）。順番が違っても結果は失われない（§10）。
- bridge の Vercel bypass（DEV-059）は既定で無効のまま。有効にするのは `design-bridge-access.md` の人の承認後。timer（HUMAN-010）は保留のまま。
- 解除条件: 人が更新し、次の controlled run で `result <id>: delivered` と管理画面の「AI レビュー: …」の表示を確かめる。

- 人が更新（2026-10-19）: bridge を b04e135 に、npm ci 成功、TypeScript の動作確認 PASS。`/mnt/c/...` から run.sh を起動すると tsx の esbuild 起動が EACCES になる問題を発見（checkout に cd すれば成功）→ DEV-062（PR #75）で修正中。merge 後に bridge をその commit に更新すると、どこから起動してもよくなる。

### HUMAN-011 — Staging に DEV-057 と DEV-058 の migration を適用（この順で 1 回に）（解除: 2026-10-19）

- 何: `20261020110000_sales_funnel_views.sql`（DEV-057、view 2 つだけ）と `20261020120000_sales_design_review.sql`（DEV-058、`sales_demos.design_review` 列・check 2 つ・`sales_design_submit` の置き換え）。Staging は `20261019120000` まで（19 本）。未適用はこの 2 本だけ。
- 前提: develop が f7e7712（PR #72 の merge）以降。checkout が LF（STAGING.md §3）。
- 手順: `git ls-files --eol supabase/migrations | grep -v w/lf` が空 → plan（`npm run staging:apply -- --project-ref znbqgvawublgyjwfpmei`）で pending がこの 2 本だけ → `--confirm-ref znbqgvawublgyjwfpmei --apply` で全 PASS。FAIL は再実行せず出力を Claude に渡す。
- 適用しないとき: 履歴タブのファネルの部分だけ「読み込めませんでした」。AI デザインは flag が off なので影響なし（on にしても要約付きの submit は 503 で止まり、bridge が次の回に再送するだけ）。
- 解除条件: 適用後、Claude が読み取りで view・grant・security_invoker、`design_review` の check、`sales_design_submit` の引数（7 つ）・権限（service_role だけ）・本文（LF、repo と一致）を確認する。

- 人が適用（2026-10-19）: 19 → 21 本、セキュリティ検査 13 項目 PASS、Supabase の独立検証も正常。再適用しない。
- Claude の読み取り確認: migration 21 本（最新 20261020120000）・`sales_funnel_daily` / `sales_design_daily` は security_invoker、authenticated / service_role は SELECT だけ・anon は不可・`sales_demos_design_review_shape` / `_final` の check あり・`sales_design_submit` は 7 引数・service_role だけ実行可・本文は LF で md5 がローカルと一致・`design_review` は 0 行。

### HUMAN-009 — Staging に DEV-054 の migration を適用（探索段階の既知判定・却下の記憶）（解除: 2026-10-19）

- 人が適用: `20261019120000_sales_discovery_screening.sql`、18 → 19 applied、`HUMAN009_APPLY_OK`、セキュリティ検査すべて PASS。ChatGPT による独立の読み取り検証も完了。再適用しない。
- Claude の読み取り確認（2026-10-19）: migration 19 本（最新 20261019120000）・`sales_rejected_candidates` は RLS 有効・0 行・`sales_discovery_known_keys(p_stubs jsonb)` / `sales_remember_rejections(p_run_id uuid, p_entries jsonb)` / `sales_run_state(r sales_agent_runs, p_replayed boolean)` は anon・authenticated に実行権限なし、本文は LF で、md5 がローカル（同じ migration を適用した DB）と一致。

### HUMAN-008 — Staging に除外リストの migration を適用（DEV-049 / DEV-050）（解除: 2026-10-19）

- 人が適用（`npm run staging:apply … --apply`）: `20261018000000_sales_exclusions.sql`、17 → 18 applied、検査 13 項目すべて PASS（`exclusions_no_plain_email` を含む）、APPLY_SUCCEEDED。再適用しない。
- 適用後の `staging:verify` は、限定トークンに `auth_config_read` の権限がないため Auth 設定の読み取りで 403 になり止まった（DB の検証の失敗ではない）。Auth 設定の確認は人が別途行う。
- Claude の読み取り確認（2026-10-19）: migration 18 本（最新 20261018000000）・`sales_exclusions` の列にメールは `email_digest` だけ・RLS 有効・policy `sales_exclusions_admin_read`・0 行・`sales_add_exclusion(… p_email_digest …)` / `sales_remove_exclusion` は SECURITY DEFINER・`sales_persist_candidate` は SECURITY INVOKER のまま。3 つの関数の本文は repo と一致（改行が CRLF である点だけが違う。適用した checkout の改行設定による。PL/pgSQL の動作には影響しない。今後は `.gitattributes` で migration を LF に固定する）。

### HUMAN-002 — Second Root 専用 Supabase project
- 状態: **Staging 用は作成済み（2026-09-28、人間）**。project `second-root`、ref `znbqgvawublgyjwfpmei`、Region ap-northeast-1。まず Staging / DEV-016 に使う。
- Production 用を別に作るか、この project を使うかは Release 承認時に人間が判断する（`docs/STAGING.md` §8）。Claude は project 作成・billing 変更を行わない。
- 2026-09-28: **残りは Production 用**。**新しい project を作る**（Staging の project は Preview・Staging の ingest token・Routine・Claude 用の token がつながっているため流用しない）。migration 16 本を人間が適用する。手順は `docs/RELEASE_READINESS.md` §13 の 1〜5、`docs/RELEASE.md` §8。
- 2026-09-28: **解除**。人間が Production 用の新しい project `second-root-production`（ref `sagjzgcpqcbrqbokawiz`、Tokyo）を作成した。

### HUMAN-004 — Staging セットアップに必要な人間の操作（DEV-016）
- 対象 Task: DEV-016（DEV-019 の Release 判断にも必要）
- 状態: **解除（2026-09-28）**。DEV-016 の Staging 実走が完了した（`.ai/reviews/DEV-016.md`）。DEV-025 も Staging で実測済み。以下は経緯の記録。手順の正本は `docs/STAGING.md`。
- 分かったこと: Claude Code（cloud）の container は HTTPS しか通らず、Postgres に直接つなげない（proxy が `db.<ref>.supabase.co` を拒否）。そのため `supabase db push` の代わりに、Supabase 公式 Management API で migration の適用と確認を行うスクリプト（`scripts/staging/`）を用意した。
- 人間にお願いすること:
  1. **Claude Code の environment に環境変数を追加**（cloud environment メニュー → Edit。値はチャットに貼らない。新しい session から有効）:
     - `SUPABASE_ACCESS_TOKEN`（必須）: Supabase → Account → Access Tokens。**scoped token（project `second-root` のみ、必要な権限だけ）**、有効期限は短く（権限の一覧は `docs/STAGING.md` §2）
     - `STAGING_SALES_AGENT_INGEST_TOKEN`（必須）: `openssl rand -hex 32`。Staging 専用
     - `VERCEL_TOKEN`（任意）: 入れない場合は 4 を人間が画面で行う
  2. **管理者ユーザー作成**: Supabase → Authentication → Add user → Create new user（email + password、Auto Confirm User オン）。パスワードは Claude に渡さず、email だけを伝える。
  3. **Vercel Preview の Deployment Protection の方針**を決める（`docs/STAGING.md` §5）。2026-09-28 に確認したところ、Preview（`https://second-root-git-develop-brot-yanagi.vercel.app`）は Vercel Authentication で保護されていて、ingest API も SSO へ転送される。このままでは Staging の Routine が ingest API に届かない。
     - (a) 推奨: Protection Bypass for Automation を作成する（Preview は非公開のまま）。この場合、Claude が Routine prompt に bypass header の対応を追加する。
     - (b) Preview の Vercel Authentication を OFF にする（管理画面はログイン必須、ingest は token 必須のまま。security 設定の緩和なので人間の判断）。
  4. （`VERCEL_TOKEN` なしの場合）Vercel Preview（branch `develop` のみ）に環境変数を 5 つ設定し、develop を再デプロイする（`docs/STAGING.md` §5）。
  5. **Staging の Routine** を作成する（スケジュールは無効、手動実行のみ。`docs/STAGING.md` §6）。
- 2026-09-28 進捗: Supabase の認証は API credential（api.supabase.com 限定）として登録済み。Staging に 15 migration を適用し、DB の security と必要な権限 12 項目はすべて PASS（`.ai/reviews/DEV-016.md`）。**残り**:
  - ~~(i) sign-up OFF・パスワード 12 文字~~、~~(ii) 管理者ユーザー~~: 2026-09-28 完了。Claude が管理者を登録し、`staging:verify` の 14 項目すべて PASS。
  - (iii) 3（Deployment Protection）・4（Vercel Preview の環境変数）・5（Staging Routine）。この session には Vercel の認証情報がない（api.vercel.com は 403）。Protection Bypass（(a)）を使う場合の prompt 対応は済み（`SALES_AGENT_VERCEL_BYPASS`）。
- 2026-09-28 (2): 人間が Vercel の API credential「Vercel Staging」（api.vercel.com 限定）と、Protection Bypass for Automation「Second Root Staging Claude」を作成した。**この session の proxy は Vercel の credential をまだ付けていない**（api.vercel.com は 403 `missingToken`。Supabase のものは付いている）。API credential は新しい session から有効になるため、次の session で `staging:vercel` から再開する。人間が作る secret（Staging の ingest token と bypass 値）の保存先は `docs/STAGING.md` §2.1。
- 2026-09-28 (3): 新しい session で確認。proxy は Vercel の credential を**付けるようになった**（エラーが `missingToken` → `invalidToken` に変化）が、Vercel が token 自体を拒否する（`/v2/user`・`/v9/projects`・`/v6/deployments` すべて 403 `invalidToken: true`）。Supabase の credential は有効（`staging:verify` 14 項目 PASS）。**人間にお願いすること**: Vercel → Account Settings → Tokens で token を作り直し（Scope は team `brot-yanagi`、有効期限は短く）、Claude Code の cloud environment → Edit → API credentials の「Vercel Staging」（host `api.vercel.com`）の値を差し替える。値は token 文字列だけ（`Bearer ` を付けない・前後の空白や改行を入れない）。新しい session から有効。
- 2026-09-28 (4): 人間が「Vercel Staging」の token を差し替えた。新しい session で read-only 確認: `/v9/projects`・`/v6/deployments` は 200（project `second-root` を取得）。`/v2/user`・`/v2/teams` は 404/403 だが、project 単位に絞った token なので想定どおり。Claude が `staging:vercel --apply` で Preview（branch `develop` のみ）に 4 変数（Supabase URL / anon key / service_role key / demo base URL）を設定。Production・他 branch の変数は変更なし（既存 3 変数は触れていない）。**残り（人間）**:
  - (A) Staging の ingest token（`openssl rand -hex 32`）を作り、`docs/STAGING.md` §2.1 の 3 か所に保存する: ① Vercel → second-root → Settings → Environment Variables に `SALES_AGENT_INGEST_TOKEN`（**Preview だけ・Branch `develop`・Sensitive**）② Staging Routine の environment ③ この開発 session の environment の API credential（host `second-root-git-develop-brot-yanagi.vercel.app`）。①の後、develop の Preview を再デプロイ（Claude が develop へ push しても再ビルドされる）。
  - (B) Staging Routine `second-root-sales-agent-daily-staging` を作成（スケジュール無効、手動実行のみ、環境変数は §6 の 3 つ）し、名前を Claude に伝える。
  - (A)(B) の後、Claude が DEV-016 の実走（§7）を行う。
- 2026-09-28 (5): **人間の作業はすべて完了**。Vercel Preview（develop）に `SALES_AGENT_INGEST_TOKEN` を設定。ingest token と bypass を 1 つの API credential「Second Root Staging API」にまとめた。Routine `second-root-sales-agent-daily-staging` を作成（遠い日付の schedule、Run now のみ）。Claude が再デプロイ後に認証を確認し、DEV-016 の実走（§7）を完了（`.ai/reviews/DEV-016.md`）。→ HUMAN-004 は解除扱い。残りは任意の確認 2 つ（人間の端末から bypass だけを付けた curl で ingest が 401 になること、管理画面で今日の 1 件を確認すること）と、Staging 終了後の token の revoke（§8）。
- 1 の後に Claude がやること:
  - migration の適用と security 確認（`staging:apply --apply --auth` → `staging:verify`）
  - 2 の後: 管理者の登録（`staging:admin`）
  - `VERCEL_TOKEN` がある場合: Preview の環境変数設定
  - 5 の後: DEV-016 の実走（`docs/STAGING.md` §7）とログ（`.ai/reviews/DEV-016.md`）
- 2026-09-28 時点で Claude が確認済みのこと: 全 14 migration を空の DB に順に適用でき、integration 全件（security audit を含む）が pass する（ローカル、`supabase db reset`）。

### HUMAN-005 — Vercel preview の build rate limit
- 状態: **解除（2026-09-28）**: PR #34 の Preview が Ready になった（rate limit 解除）。再発した場合も GitHub Actions の必須 CI で merge 判断を続ける。

### HUMAN-001 — Bootstrap PR の merge と develop 作成
- 対象 Task: DEV-001, DEV-002（以降すべて）
- 状態: **解除済み（2026-09-27）** — 人間承認に基づき Claude が PR #8 を main へ merge（32de89a）し、`develop` を作成。branch protection の設定は引き続き人間の推奨作業
- 必要な操作（1・2 は人間承認に基づき Claude が実施）:
  1. BOOT-001 の PR #8 を main へ merge
  2. merge 後の main から `develop` branch を作成し push
  3. （推奨）`main` / `develop` に branch protection を設定し、CI の `static` / `unit` / `build` / `e2e` を required check にする
- 解除条件: `origin/develop` が存在し、BOOT-001 の変更を含む


