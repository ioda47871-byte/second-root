# IMAGE_FIRST: オーナーの承認を誰も偽造できない形で root に届ける（設計案、Issue #302）

状態: **設計案（未実装）**。2026-11-22 のオーナーの方針で C 案（GitHub での本人承認）を採用する方向。実装は OWNER MERGE ONLY の別 PR。
この文書は境界を何も変えない。

## 0. 目的と守ること

- 目的: オーナーが **GitHub アプリで生成を承認するだけ**で、生成 → 監査 → 研究ログ保存まで進む。毎回 WSL は触らない。
- 要件（オーナー 2026-11-22）:
  1. Claude 以外の連携も含め、**オーナーの GitHub 権限を使って承認を偽造できない**。
  2. **通常の開発 PR は Claude が自律的に統合**でき、**画像生成に使う commit だけはオーナーの承認が必須**。
- 守ること（緩めない）: 1 パケット = 1 承認 ID = 1 回、再試行・延長・再利用なし、期限はパケット §10 だけ、未承認・期限切れ・方向の取り違えは
  claim の前に止まる、Claude（jail の sr-designgen）は root にならず、root の設定・timer・状態に書けない。
- 前提: PR #325（timer・autorun）と #326（設定の信頼境界）。この文書は、その中の「root の承認コマンド」を置き換える。

## 1. 承認は 2 つのものを信じている

今の承認コマンド（`fetch` → `checkout --detach origin/develop` → `imagefirst-approve.sh <ID>`）で、オーナーは 2 つを同時に認めている:

1. **実行の承認**: このパケット（ID・プロンプト・枚数・期限）で 1 回生成してよい。
2. **コードの信頼**: その commit を、root（autorun・`admin.sh`）と、jail の外で Codex と Claude のサインインの写しを持って動く worker
   （`lib/**` の import 全体、`package*.json` と `npm ci`、`tsconfig*`）として動かしてよい。

特定のパスだけを保護しても、root と worker が実際に動かすコードは import と依存を辿って広がり、漏れが出る（#327 レビュー 1 回目の Critical 2 件）。
だから本案では **オーナーの承認 = ある 1 つの commit の木全体を認めること**とし、root はその木だけを動かす。

## 2. 誰がオーナーとして振る舞えるか（要件 1 の出発点）

2026-11-22 に確かめた事実: jail の Claude の GitHub の token は**オーナー本人のアカウント（`ioda47871-byte`）**のもの。
さらに、オーナーのアカウントの権限で動きうるものは Claude だけではない:

- 個人の token（classic / fine-grained）、`gh` の token、git の credential helper
- オーナーが許可した OAuth App・GitHub App のユーザー token（例: Claude の GitHub App、Claude Code Remote の GitHub 連携と git の proxy、
  claude.ai の connector、Vercel などのデプロイ連携）
- オーナーのブラウザ・端末のログイン

GitHub の API では、PR の承認（review）を**ブラウザやアプリで押したのか、token で作ったのかを確実には区別できない**。したがって
**オーナーの普段のアカウントを「承認者」にする限り、要件 1 は満たせない**（連携を全部棚卸ししても、将来の連携で崩れる）。

## 3. 承認者の身元の比較

| 案 | 内容 | 要件 1 |
|---|---|---|
| (i) オーナーの普段のアカウントで承認 | 今のまま | **不可**（Claude・すべての連携がオーナーとして承認を作れる） |
| (ii) Claude だけを別アカウントにする | Claude の token を machine user に | 不十分（Claude 以外の連携は依然オーナーとして承認を作れる） |
| (iii) **承認だけに使う専用アカウント（承認者）** | オーナーが新しく作り、**GitHub アプリ（スマホ）でのログインだけ**に使う。token・OAuth App・GitHub App の許可・SSH/GPG 鍵を一切持たない。2 段階認証（passkey） | **可**。どの連携もこのアカウントの資格情報を持たない。root は承認者の**数値の user id** だけを信じる |

**推奨は (iii)**。root の確認は「承認者の承認があるか」と「その承認が今動かす木と同じ木に付いているか」だけで、ruleset や admin 権限には頼らない。
オーナーの普段のアカウント（またはそれを使う連携）が admin として ruleset を外しても、承認者の承認は作れないので root は動かない（妨害はできても偽造はできない）。

Claude 用の machine user（ii）は、要件 1 には**不要**になる。ただし最小権限として推奨は残る（Claude が admin として branch を消す・ruleset を変える
などの妨害を防ぐ）。切り替えはオーナーの判断で後からでよい。

## 4. 「画像生成に使う commit だけ承認必須」の構造の比較（要件 2）

| 案 | 仕組み | 通常の開発 | 生成に使う commit | 判定 |
|---|---|---|---|---|
| (a) develop + CODEOWNERS（前の案） | develop の上のパケットの PR だけ承認者のレビュー必須 | 自律 | develop の途中の commit を辿って特定。承認の PR の差分はパケットだけで、それまでの自律マージのコードは別の比較リンクで見る | 動くが複雑。develop に承認済みの §10 が混ざる |
| (b) **保護した承認ブランチ `imagefirst/approved`** | 生成は**このブランチの commit からだけ**。develop には承認の要件を一切付けない | **完全に自律**（今のまま） | 承認ブランチへの PR の差分 = **前回承認した commit からの全部の変更**（コードもパケットも）。承認者はそれを GitHub アプリで見て Approve | **推奨** |
| (c) オーナーの署名つきの tag（D 案の変形） | オーナーが PC で commit に署名 | 自律 | 署名した commit | 強いが毎回 PC の操作が要る（目標に合わない） |

**推奨は (b)**。承認済みの §10 は承認ブランチにだけ存在し、develop の上のパケットは常に「承認待ち」のままなので、develop の自律マージから実行が生まれることはない。

## 5. 推奨案の流れ（(iii) 承認者 + (b) 承認ブランチ）

### 毎回の流れ

1. Claude が新しいパケット（新しい承認 ID）を develop に作る（§10 は承認待ち。今まで通り自律マージでよい）。
2. Claude が `imagefirst/run-<ID>` を作る: develop の commit D に承認ブランチの先端 T をマージし（T の子孫にする）、その上でパケットの §10 を
   「承認済み」にする 1 commit を足す。`imagefirst/approved` への PR を開く。
3. Claude アプリにレビューページ（前回との比較・プロンプト・6 枚の内訳・上限）と **PR の Files changed へのリンク**を出す。
4. **オーナーが承認者として GitHub アプリで差分を見て Approve**（これが唯一の承認操作）。
5. Claude が merge commit でマージする（承認は承認者にしか作れず、root が木の一致を確かめるので、マージする者は誰でもよい）。
6. root の timer が承認ブランチの新しい先端 C を確かめ（§6）、通れば C に固定して claude-stop → 生成 1 回 → 監査 → claude-start（#325 / #326 のまま）。
7. 次のセッションで Claude が inbox を読み、研究ログ（develop）に記録してレビューページを出す（#324）。

### 一度だけの準備（オーナー。GitHub の Web で。設計の確定後）

- 承認者のアカウントを作る（passkey の 2 段階認証。token・連携・鍵を作らない。GitHub アプリにだけログイン）。collaborator（Write）にする。
- `imagefirst/approved` を、その時点でオーナーが認める commit から作る（root の「最後に信頼した commit T」の初期値になる）。
- `imagefirst/approved` の ruleset（多層防御。root はこれに頼らない）: PR 必須、承認 1、Code owners のレビュー必須（このブランチの
  `CODEOWNERS` を `* @<承認者>`）、新しい push で承認を取り消す、最後に push した人以外の承認、force push・削除の禁止、
  マージ方式は merge commit だけ、bypass する者は無し。
- develop には何も足さない。
- root に読み取り専用の fine-grained token（このリポジトリの Contents・Pull requests・Metadata の read だけ）を置く。作るのは普段のアカウントでよい
  （読み取り専用の token では承認を作れない）。承認者のアカウントには token を作らない。

## 6. root の検証器

- 検証器は **root の持ち物の固定の場所**（例 `/usr/local/lib/sr-imagefirst/`）に置き、unit はそれを動かす。リポジトリから自分を更新しない
  （更新は一度だけの root の操作として、オーナーの承認で行う）。
- root だけが読める設定 `/etc/sr-design-worker/approval-relay.json`（0600 root）: 承認者の**数値の** user id、リポジトリ、ブランチ名。
  状態 `/var/lib/sr-imagefirst-autostart/approved-tip`（root の 0700）: 最後に信頼した commit T。token は `/etc/sr-design-worker/github-read-token`（0600 root）。
- 検証（全部満たさなければ何もしない。API の失敗・形や型の違いも何もしない。FAIL CLOSED）:
  1. root の admin clone で `imagefirst/approved` を fetch（root の git、利用者の設定なし）。先端 C。C = T なら終わり。
  2. **C の第 1 親 = T**（承認は 1 回に 1 つ。履歴の書き換え・複数の未処理の承認は止めて報告）。H = C の第 2 親。**T は H の祖先**
     （これにより、承認者が GitHub で見た差分 = T の木から H の木への変更そのもの）。
  3. GitHub API: `merge_commit_sha = C`・base = `imagefirst/approved`・head の sha = H の PR がある。レビューの一覧を全部読み、
     **承認者の数値の id の最後の状態が `APPROVED`**、その `commit_id = H`、取り消されていない。
  4. **C の木 = H の木**（root の clone で確かめる。承認された木と動かす木が同じ）。
  5. T..C の差分が、**ちょうど 1 つのパケットの §10 を「承認済み」にし、承認 ID を書いている**。その ID は未使用（`used/<ID>` と `autorun/<ID>/attempt` が無い）、
     期限が未来で §10 の値そのもの（24 時間以内）。
  6. 通ったら T を C に進め（以後同じ承認は二度と通らない）、C を autorun → pilot に渡す（pilot は C を SHA で新しく clone する）。
     生きている develop も承認ブランチの後の動きも見ない。
- 止まったときは、理由のコードだけを worker が読める場所に書く（Claude が次のセッションでオーナーに伝える）。承認ブランチが壊れた
  （第 1 親が T でない等）ときの復旧はオーナーの root の操作（T の付け直し）で、自動では直さない。
- root が使うのは git・curl（`api.github.com` だけ、proxy の環境変数を無視）と、JSON の解析に root の持ち物の `python3 -I`（この WSL には jq が無い）。
  sr-designgen のコードは何も動かさない（今の規則と同じ）。
- 承認コマンド `imagefirst-approve.sh` は**手動の代わりとして残す**。

## 7. 脅威ごとの確認

| 脅威 | 止める仕組み |
|---|---|
| Claude・連携がオーナーのアカウントで承認を作る | 承認者は別アカウントで、どの連携もその資格情報を持たない。root は承認者の数値の id だけを信じる |
| admin 権限で ruleset を外す・直接 push する | root は ruleset に頼らない。承認者の承認・木の一致・第 1 親 = T が無ければ動かない（妨害のみ） |
| 承認の後に head を変える | レビューの `commit_id = H` と C の木 = H の木 |
| 承認者に見せる差分を偽る（別の履歴の PR・比較の基準のずらし） | T が H の祖先であることを root が確かめる。GitHub 自身の Files changed を見る |
| Claude のページでオーナーを誤らせる | 承認は GitHub アプリの差分を見て押す |
| root・worker のコード（`admin.sh`・`lib/**`・依存・`npm ci`）の差し替え | 承認は C の木全体に付き、root は C だけを動かす |
| develop の自律マージから実行が生まれる | 承認済みの §10 は承認ブランチにしか無い。develop は見ない |
| develop・承認ブランチを動かして承認を潰す | C に固定し、生きているブランチと比べない |
| 承認の使い回し・再試行 | T を進める・`used/<ID>`・`autorun/<ID>` は消さない。再武装は新しいパケットだけ |
| 検証器が自分を更新する | root の固定の場所。リポジトリから更新しない |
| root の設定・token・状態を読む/書く | `/etc/sr-design-worker`・`/var/lib/sr-imagefirst-autostart` は root だけ（今の境界のまま） |
| GitHub の障害・応答の改ざん | 失敗は何もしない。TLS で直接、proxy 無視。形・型が違えば止める |
| 承認者の端末・アカウントの乗っ取り | 本案の外（passkey、端末のロック）。承認者は普段使わないので露出が小さい |

## 8. オーナーに決めてほしいこと

1. 承認者の専用アカウント（(iii)）と承認ブランチ（(b)）の組み合わせで確定してよいか。
2. Claude 用の machine user への切り替え（最小権限。要件 1 には不要）をいつ行うか。
3. 承認ブランチの最初の commit（T の初期値）をいつ・どの commit にするか（#325・#326 と設置の後が自然）。
