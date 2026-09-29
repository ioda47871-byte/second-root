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
