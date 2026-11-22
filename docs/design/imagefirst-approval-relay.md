# IMAGE_FIRST: オーナーの承認を Claude が偽造できない形で root に届ける（設計案、Issue #302）

状態: **設計案（未実装・オーナーの判断待ち）**。実装は OWNER MERGE ONLY の別 PR。この文書は境界を何も変えない。

## 0. 目的と前提

- 目的: オーナーが毎回 WSL の root で `imagefirst-approve.sh <ID>` を打つ操作をなくし、Claude アプリから辿る **1 回の承認操作**だけで
  生成 → 監査 → 研究ログ保存まで進むようにする。
- 守ること（緩めない）: 1 パケット = 1 承認 ID = 1 回、再試行・延長・再利用なし、期限はパケット §10 だけ、未承認・期限切れ・方向の取り違えは
  claim の前に止まる、Claude（jail の sr-designgen）は root にならず、root の設定・timer・承認の印に書けない。
- 前提とする自動化: PR #325（timer・autorun）と #326（設定の信頼境界）。この文書は、その中の「root の承認コマンド」だけを置き換える。

## 1. 承認は 2 つのものを信じている

今の承認コマンド（`fetch` → `checkout --detach origin/develop` → `imagefirst-approve.sh <ID>`）で、オーナーは 2 つを同時に認めている:

1. **実行の承認**: このパケット（ID・プロンプト・枚数・期限）で 1 回生成してよい。
2. **コードの信頼**: その時点の develop の commit を、root（autorun・`admin.sh` の claude-stop/start）と、jail の外で Codex と Claude の
   サインインの写しを持って動く worker（`lib/**` の import 全体、`package*.json` と `npm ci` の依存のスクリプト、`tsconfig*`）として動かしてよい。

承認コマンドを置き換える仕組みは、**両方**を、Claude には作れない形で root に届けなければならない。2 だけを「特定のパスの保護」で守ろうとすると、
root と worker が実際に動かすコードは import と依存を辿って `lib/`・`scripts/`・依存の全体に広がり、漏れが出る（独立レビューの Critical 2 件）。
だから本案は、**オーナーの承認 = ある 1 つの commit C の木全体を認めること**とし、root はその C だけを動かす。これは今の承認コマンド
（その時点の develop を丸ごと信じる）と同じ水準で、緩めていない。

## 2. 今の信頼の穴

2026-11-22 に確かめた事実: **jail の Claude が使う GitHub の token はオーナー本人のアカウント（`ioda47871-byte`）のもの**である。

GitHub の上で「オーナーがした」ように見えること（PR の承認・マージ・コメント）は、すべて Claude にも作れる。「OWNER MERGE ONLY」は今は
運用の約束であって、技術的な壁ではない。ほかに:

- **Claude アプリの会話**は Claude が読んで中継する。会話の中の「承認します」を root に渡す経路は、どれも Claude が作れる。
- **claude.ai の Artifact の共有データ**も Claude がオーナーとして書ける（`ArtifactData` は利用者として書く）。
- gh の token のほかにも、オーナーとして動ける資格情報がありうる（git の credential helper、`GH_TOKEN`、`hosts.yml` の別のアカウント、
  Claude Code Remote の GitHub 連携・git の proxy、claude.ai の connector）。

## 3. 方式の比較

| 案 | オーナーの操作 | 偽造できない根拠 | 判定 |
|---|---|---|---|
| A. Claude アプリの会話・ボタンだけ | アプリで「承認」 | なし（Claude が中継・同じアカウント） | **不可** |
| B. TOTP（認証アプリの 6 桁）をアプリに打つ | アプリで 6 桁 | 6 桁はどのパケット・どの commit にも結びつかず、表示も Claude 経由なので、Claude が別のものに使い回せる | 単独では**不可** |
| C. **GitHub の身元の分離 + オーナーの GitHub 承認（commit C の木全体）を root が確かめる** | GitHub アプリで PR の差分を見て Approve（必要ならマージ） | Claude は別の身元で、オーナーの承認を作れない。承認は PR の head に付き、squash・up-to-date 必須により head の木 = develop の C の木。root は自分の読み取り token で確かめ、C だけを動かす | **推奨**（Claude アプリから 1〜2 タップ） |
| D. オーナーの署名（FIDO2 のセキュリティキー / Windows Hello の `ssh-keygen -Y sign -n sr-imagefirst-approve`） | 「ID・パケットの SHA-256・期限・commit C」の 1 行に署名し、アプリに貼る | 鍵は WSL の外。署名は C と ID に結びつく。root は root の `allowed_signers` で確かめる。GitHub の身元の分離が無くても成り立つ | 代わりの案（強いが毎回 PC で署名が要る） |

どちらの案でも、**オーナーは Claude の作るページではなく、GitHub 自身の差分（前回信頼した commit との比較）を見て承認する**
（Claude のレビューページは説明を誤れるため）。D では C の 40 桁を GitHub の画面で確かめる。

## 4. 推奨案 C の段階

### 段階 0: 今の自動化を安全に動かす（承認コマンドは残る）

1. #324（inbox-scan）を通常の規則でマージ。
2. オーナーが #325 → #326 の順にマージ（OWNER MERGE ONLY。#326 は #325 のマージの後に base を develop に変え、差分と CI を確かめ直す）。
3. 一度だけの root の操作（それぞれ安全確認とオーナーの明示承認）: `claude`・`codex` を root の持ち物として入れ直す、
   `/etc/sr-design-worker/codex-config.toml` の配置、`imagefirst-autorun.md` §2 の確認、timer の有効化。
4. 新しいパケット（新しい承認 ID）で、承認コマンド 1 行の自動実行を 1 回確かめる。
5. 直す点（独立レビュー）: autorun は試行の記録の後に develop が動くと止まる（承認 ID が使えなくなる）。Claude が保護のない PR を途中で
   マージするだけで承認を潰せるので、**root が決めた C に固定し、生きている develop とは比べない**ようにする。

### 段階 1: Claude の GitHub の身元をオーナーから分ける（オーナーの GitHub での操作 + jail の token の差し替え 1 回）

- Claude 用の別アカウント（machine user）を作り、collaborator（**Write** だけ。Maintain・Admin にしない）にする。jail の `gh` の token を
  その fine-grained token に差し替える（今まで通り `admin.sh run sr-designgen -- gh auth login --with-token`、標準入力）。
- **オーナーの資格情報を jail から全部なくす**: §2 の一覧を棚卸しして消す。最後に**確かめのテスト**: Claude として保護した PR を承認・マージ
  しようとして失敗することを見る（オーナーが立ち会う）。
- develop の ruleset（オーナーが GitHub の Settings で作る。**bypass する者は無し**。admin も迂回できない設定）:
  PR 必須・直接 push 禁止・必須 CI・**squash だけ**・**マージ前に最新にすることを必須**・新しい push で古い承認を取り消す・
  最後に push した人以外の承認が必要・Code owners のレビュー必須。
- `.github/CODEOWNERS`（OWNER MERGE ONLY の PR）でオーナーの持ち物にするのは、**承認の意味を持つファイルと規則そのもの**だけ:
  `docs/design/image-first-*-packet.md`、`.github/**`、`CODEOWNERS`。コードは C の木全体の承認で守るので、ここで並べない。
  Claude の自律マージ（パケット以外）は今まで通り動く。
- ruleset を作るときに一度だけ、オーナーが手で基準を決める（その時点の develop を最初の「信頼した commit」として root に記録）。

### 段階 2: root の検証器（OWNER MERGE ONLY の PR + 一度だけの設置）

- 検証器は **root の持ち物の固定の場所**（例 `/usr/local/lib/sr-imagefirst/`）に置き、unit はそれを動かす。admin clone の develop から
  自分を更新しない（検証器の更新は一度だけの root の操作として、オーナーの承認で行う）。
- root だけが読める設定 `/etc/sr-design-worker/approval-relay.json`（0600 root）: オーナーの**数値の** user id、リポジトリ、最後に信頼した commit。
  読み取り専用の fine-grained token（Contents・Pull requests・Metadata の read だけ）は `/etc/sr-design-worker/github-read-token`（0600 root）。
- 検証（全部満たさなければ印を書かない。API の失敗・形や型の違いは何もしないで終わる。FAIL CLOSED）:
  1. root の admin clone で `fetch`（今の承認コマンドと同じ。root の git、利用者の設定なし）。
  2. GitHub API で、最後に信頼した commit T の後に develop へマージされた PR のうち、**その PR 自身の差分がパケットの §10 を「承認済み」に変え、
     ある承認 ID を書いたもの**を探す。C = その PR の `merge_commit_sha`（develop の先端でなくてよい。後から別の PR がマージされても C を使う）。
     パケットのファイルを変えるだけの PR（誤字の修正など）は承認として扱わない。
  3. C のパケットの §10 が承認済みで、ID が未使用（`used/<ID>` と `autorun/<ID>/attempt` が無い）、期限が未来で §10 の値そのもの。
  4. その PR の head に対する**オーナーの数値の id の最後のレビューの状態**が `APPROVED`（レビューの一覧を全部読む。後の `CHANGES_REQUESTED`・
     取り消し（dismissed）があれば不可）で、そのレビューの `commit_id = head`。**head の木 = C の木**（root の clone で `C^{tree}` を出し、
     API の head の commit の tree と比べる）。
  5. 木の祖先関係（root の clone で確かめる）: T が C の祖先、C が develop の祖先。T..C の各 commit に PR がある（直接 push が混ざっていない）。
  6. `GET /repos/{owner}/{repo}/rules/branches/develop` で、段階 1 の規則が今も有効（外されていれば止める）。この API は bypass する者を
     見せないので、bypass の追加はオーナーの設定の管理に頼る（残る Low）。
  7. 通ったら、lock の中で admin clone を `checkout --detach C` し、C を autorun → pilot に渡す（pilot は C で新しく clone する。今の仕組み）。
     「最後に信頼した commit」を C に進める。以後、生きている develop は見ない。
- root が使うのは curl（`api.github.com` だけ、proxy の環境変数を無視）と、JSON の解析に root の持ち物の `python3 -I`
  （標準ライブラリだけ。この WSL には jq が無い）。sr-designgen のコードは何も動かさない（今の規則と同じ）。
- 承認コマンド `imagefirst-approve.sh` は**手動の代わりとして残す**（検証器を外す・GitHub が使えないとき）。

### 段階 3: Claude アプリの流れ

1. Claude が新しいパケットの PR を作り、Claude アプリにレビューページ（前回との比較・プロンプト・6 枚の内訳・上限）と、
   **GitHub の差分のリンク**（PR の Files changed と、最後に信頼した commit との比較）を出す。
2. オーナーが GitHub アプリで差分を見て Approve する。**§10 を承認済みにするパケットの PR を Approve すること = その 1 回の実行の承認**である。
   差分を見るときの比較の基準は、Claude のページの言う commit ではなく、**オーナーが前回承認した PR のマージの commit**（その PR に表示される）。マージは Claude（machine user）がしてよい: 承認はオーナーにしか作れず、
   squash・up-to-date で木が一致することを root が確かめるため。
3. timer が検証 → 印 → claude-stop → 生成 1 回 → 監査 → claude-start（#325 / #326 のまま）。
4. 次のセッションで Claude が inbox を読み、研究ログに記録してレビューページを出す（#324）。

## 5. 脅威ごとの確認

| 脅威 | 止める仕組み |
|---|---|
| Claude が承認を作る | Claude の token はオーナーではない（資格情報の棚卸し + 確かめのテスト）。root は数値の id で確かめる |
| Claude が root・worker のコードを書き換える（`admin.sh`・`lib/**`・依存・`npm ci` の install スクリプト） | 承認は C の木全体に付き、root は C だけを動かす。承認の後の push は承認を取り消す |
| squash・マージで木がずれる | squash だけ・up-to-date 必須。root が head の木 = C の木を確かめる |
| ruleset・CODEOWNERS を外す | machine user は Write だけ。`.github/**` はオーナーの持ち物。root が毎回規則を確かめる。bypass する者は無し |
| machine user が自分の PR を承認する | Code owners の承認 + 最後に push した人以外の承認 |
| develop を動かして承認を潰す（妨害） | C は承認した PR のマージの commit。先端でなくてよく、生きている develop と比べない |
| 比較のリンクの基準をずらして変更を隠す | root が T（最後に信頼した commit）が C の祖先であることを確かめる。オーナーは前回の自分の承認を基準に見る |
| 誤字の修正などのパケットの PR を承認させて実行させる | §10 を承認済みにする差分を持つ PR だけを承認として扱う |
| 検証器が自分を更新する | 検証器は root の固定の場所。develop から更新しない |
| Claude のページでオーナーを誤らせる | オーナーは GitHub 自身の差分を見て承認する |
| Claude が root の設定・token を読む/書く | `/etc/sr-design-worker` は root の 0700、jail からは見えない（今の境界のまま） |
| 承認の使い回し・再試行 | `used/<ID>`・`autorun/<ID>` は消さない（今のまま）。再武装は新しいパケットだけ |
| GitHub の障害・応答の改ざん | 失敗は何もしない。`api.github.com` へ TLS で直接、proxy 無視。形・型が違えば止める |
| オーナーのアカウントの乗っ取り | 本案の外（オーナーの 2 段階認証）。D を併用すると GitHub が破られても root は署名を要求できる |

## 6. オーナーに決めてほしいこと

1. 推奨案 C で進めてよいか（D を併せて用意するか）。
2. Claude 用の別の GitHub アカウントを作れるか（作れない場合、GitHub App という方法もあるが設置は重い）。
3. Claude アプリ以外で、毎回 GitHub アプリでの承認（1〜2 タップ）が要ることを受け入れられるか。
   Claude アプリの中だけで完結し、かつ Claude に偽造できない方法は、今の仕組みの中には無い（§2・§3）。
4. 段階 0 の一度だけの root の操作をいつ行うか（それぞれ別に確認と承認をもらう）。
