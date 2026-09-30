# DEV-028 local design worker — fresh review

- 対象: `a063702..4118533`（worker の実装、run.sh、runbook、テスト）
- 方法: 実装と文脈を共有しない独立 agent。Playwright 1.62.1 で実際に試して確認した（popup、CSP、shadow DOM、redirect、短いグリッド）
- 結果: High 1 / Medium 5 / Low 7。すべて修正した。ただし「同じ id が failed/ と done/ の両方に入る」と「遅れた遷移の理由表示」の 2 件は、結果が正しいので記録だけにした

| # | 重さ | 指摘 | 対応 |
|---|---|---|---|
| H1 | High | ネットワーク失敗・5xx・予期しない browser の失敗まで `PUBLIC_SOURCE_UNAVAILABLE`（done）になり、job が二度と試されない。短いページでは grid-lower の clip が外れ、撮れた 2 枚まで失う | 確定の答え（ログイン壁・challenge・rate limit・非公開/無い・Instagram 外・空）だけを `PUBLIC_SOURCE_UNAVAILABLE` にした。一時的な失敗は `SOURCE_CAPTURE_FAILED` として ledger で 1 回やり直す。clip はページの高さで切り詰め、3 枚目の失敗は無視する。テスト: 5xx、接続拒否、短いグリッド |
| M1 | Medium | `window.open` の popup で `request.frame()` が throw し、worker が落ちる | frame が無い遷移は popup として黙って止める。route handler 全体を catch する。テスト: popup |
| M2 | Medium | report.json を書いた後に失敗すると、catch が run directory を消す | report.json がある run directory は消さない。done への移動だけをやり直す |
| M3 | Medium | CSS の blur が class の背景画像・SVG image・shadow DOM に届かない。CSP で style が止まりうる。確認もしない | `bypassCSP`。加えて、撮った PNG の中ですべての media の矩形（shadow DOM を含む）を 1/10 に縮めて blur をかけて戻す。テスト: 縞模様の画像 3 種のコントラストが消えることを画素で確認 |
| M4 | Medium | Codex CLI の session log（`$CODEX_HOME/sessions/.../rollout-*.jsonl`）に参考画像が残りうる | 呼び出しごとに、その thread id の session log だけを消す。テスト: 偽の CLI が書いた log が消え、他の log は残る |
| M5 | Medium | brief のやり直しが最初の timeout を使い回して時間を超えうる。signal・watchdog で止まると job が stale として 1 回に数えられる | 呼び出しごとに残り時間を読み直す。signal・watchdog では作業中の job を inbox に戻し、回数に数えない |
| L | Low | 空の lock ファイルで 3 時間止まる | 読めない lock は 1 分で古いとみなす（テストあり）。JSON の読み違いで lock・claim・marker の読み取りが throw していた不具合も直した（テスト: 壊れた claim） |
| L | Low | 死んだ worker の一時ディレクトリが 6 時間残る（browser cache に元の画像） | 持ち主が死んでいればすぐ消す（テストあり） |
| L | Low | 呼び出し側の環境変数で run.sh の環境の掃除を飛ばせる | 再起動の目印を引数にした（テストあり） |
| L | Low | Windows 側の symlink を辿って書く | コピー先と中のファイルが link なら `windows_copy: failed`（テストあり） |
| L | Low | report の revisions が少なく出る。category default のときに Codex の低い confidence が見えない | pipeline が数えた `revisions` と `brief_confidence` を report に出す（テストあり） |
| L | Low | 同じ id の superseded が failed/ に残る | 記録のみ（inbox に新しい同じ id があるときだけ起き、新しい方が処理される） |
| L | Low | 遅れた script 遷移が OFF_SITE ではなく EMPTY_PAGE と出る | 記録のみ（結果は同じ `PUBLIC_SOURCE_UNAVAILABLE`） |

レビュー中に見つけた flaky: 負荷の高いときに mock への `route.fetch` がすぐ失敗した（keep-alive の接続を相手が閉じた直後）。fetch を 1 回だけやり直すようにし、design-agent のテストを 4 回続けて全件 PASS にした。

検証: unit 472 件 PASS、lint・typecheck PASS、run.sh の実ファイルのテスト PASS。本番の build → next start → 撮影の経路は container で確認した。

## 修正の再確認（58cac66）

- H1〜M5 と Low の修正は reviewer が実際に試して確認した
- **新しい High**: `mediaRects` の page callback の中の名前付き関数を、tsx（keepNames）が `__name()` で包む。その helper はページに無いので、本番（run.sh → tsx）では取得が毎回 CAPTURE_ERROR になっていた
  - vitest の変換では起きないため、テストでは見えなかった
  - 対応: page callback の中に名前付き関数を置かない（stack を使うループにした）
  - 回帰テストを追加した: worker 1 件を tsx の子 process で端から端まで動かす
  - 修正前のコードでは、このテストが落ちることを確かめた
- Low の追加対応
  - 予期しない crash と watchdog: job を processing に残し、recovery が回数に数える。いつも run を壊す job も failed/ に行く。人や systemd の signal だけは数えずに inbox へ戻す
  - `abandonActiveJobSync` は、inbox に同じ id の新しい job があれば上書きしない
  - signal で途中止めになった Codex の session log: 起動時に消す。対象は、1 行目の cwd が design agent の一時ディレクトリを指すものだけ。他の Codex session には触らない（テストあり）
  - lock の引き取りの race（rm → wx）は run.sh の flock で直列化されるので、記録だけにした

## 最終確認（11f75bd）

- 確認して問題なし: tsx での取得（通常のページ・popup・iframe）、他の page callback、signal・crash の扱い、inbox の上書き防止
- Low 1 件を修正した: session log の片付けが 1 行目全体に正規表現を当てていたため、指示文に worker のパスが書かれた無関係な session まで消しうる。1 行目を JSON として読み、`cwd` のパスの要素だけを見るようにした（テストあり）
- 最終判定: **PASS**。Critical・High・Medium は 0 件。残りは記録だけの Low 3 件（superseded、遅れた遷移の理由表示、flock で直列化される lock の race）

## schema の fallback（実走前 preflight の指摘）

- preflight で見つけたこと: strict schema は `maxLength` などを含む。loose への fallback は brief にしか無かった。API が strict を拒むと review が毎回失敗し、run は必ず fallback_template で終わる
- 修正: 各 job は strict から始める。CODEX_EXEC_FAILED / CODEX_NO_JSON のときだけ、その呼び出しを loose で 1 回だけ送り直し、その job の残り（brief / review）は最初から loose を使う
  - その他の失敗（timeout・quota・サインイン）では送り直さない
  - 答えは完全な zod schema と palette の検査で従来どおり検証する
  - report には `codex.schema_mode` と `SCHEMA_LOOSE_AFTER_<BRIEF|REVIEW>_<code>` だけを残す
- テスト（偽の Codex が、受け取った schema が strict か loose かを記録する）
  - strict の brief が失敗 → loose の brief → loose の review
  - strict の review が失敗 → loose の review → 2 回目の review は最初から loose
  - loose でも失敗 → 従来どおり fallback（brief / review それぞれ）
  - loose の答えも palette と余分な項目で弾く
  - quota では送り直さない
  - strict が通れば最後まで strict

## Business Discovery PoC（meta-check）の fresh review

- 対象: b7b0642。独立した agent が注入した `fetchImpl` で実際に試した
- Medium 1 件（修正済み）
  - HTTP 200 で本文が error（期限切れの token・rate limit）や proxy の HTML だった場合に、TARGET_UNSUPPORTED と判定していた
  - 対応: error 本文と JSON でない本文は数値で分類する。`business_discovery` が無い 200 は META_UNKNOWN_ERROR にする（テストあり）
- Low 3 件（修正済み）
  - token のディレクトリの所有者・種類を検査していなかった → 検査する
  - link を辿ると token の置き場所が repo の中を指せた → realpath で比べる
  - `lstat` から読むまでの間に差し替えられうる → O_NOFOLLOW で開き、開いた handle の stat で検査する
  - 応答の大きさの上限が読み終えた後にかかっていた → 読む途中で打ち切る
  - 文書に SECRET_FILE_UNSAFE / META_UNKNOWN_ERROR が無かった → 追加
- 確認済みで問題なし
  - token は Authorization header だけ・redirect で失敗・timeout・appsecret_proof・出力の許可リスト・username の注入不可・テスト用の注入口を CLI から使えないこと・Messaging のコードに触れていないこと・文書の保存手順

## 専用ブラウザ profile の PoC（login / capture）の fresh review

- 対象: ba2fd1d。独立 agent が実際に動かして確かめた
- Medium 3 件（修正済み）
  1. profile の検査が link を辿っていた（Node 22 の `readdir` recursive は link 先のディレクトリにも入る。`/` への link で木の外を歩き、止まらない）
     - 対応: 自前で歩く。link には入らず、数えながら上限で止まる
     - テスト: `/` への link で 5 秒以内に拒否する
  2. アカウント部分を隠す処理が、bio や profile 全体を隠しうる
     - 「おすすめ」を含む bio にも反応していた
     - main を包む sticky の要素まで隠していた
     - 対応: 「おすすめ」はセクションの題名と完全一致したときだけ扱う。header や投稿を含む要素は決して隠さない。main を包む要素は除く
     - テスト: 和文の bio、sticky で包まれた main
  3. 画面表示の変数（DISPLAY など）が、共有の子 process 環境を通じて Codex にも渡っていた
     - 対応: ログインの窓にだけ渡す
     - テスト: 共有環境には入らないこと
- Low（修正済み）
  - 親ディレクトリがまだ無いとき、リンクを解決しない path で検査していた → 存在する最も近い祖先を解決して検査し、作成後にもう一度検査する（テストあり）
  - サインイン済みの判定が弱かった（未ログインでも出る `/explore/` を含んでいた）→ サインイン済みにしか無い要素だけにし、定義を 1 か所にまとめた
  - main が無いと切り出しができない → EMPTY_PAGE で止める（テストあり）
  - 例外が出たときに空の撮影フォルダが残った → 消す
  - テストの穴: profile の session が次の起動に残ることを確かめるテストを追加した
- **残る未検証**: 表示ありのログインで書いた session を、表示なし（`channel: "chromium"`）の撮影で読めるか。この環境には画面が無いため試せない。人の WSL での初回実走で確かめる
- 再確認（f02ac38）: **PASS**（Critical / High / Medium は 0 件）。残っていた Low 2 件も直した
  - 「おすすめ」だけの語が bio の中にあると bio の塊を隠しうる → header の中の要素は対象にしない（テストあり）
  - profile の中に読めないフォルダがあると、中を検査せずに飛ばしていた → PROFILE_UNSAFE_ENTRY で止める
