# デモの AI アートディレクション PoC を WSL で動かす（DEV-028）

1 店舗の営業デモについて、ChatGPT でサインインした Codex CLI に「見た目だけ」を選ばせる。
選ばせたものを共通 renderer で描き、スクリーンショットを Codex に見せて評価させる。
直すのは design profile だけで、最大 2 回までにする。
人が手で 1 回ずつ起動する PoC であり、timer・Routine・DB には繋がない。

仕組みは怪異読本の入口画像 worker（curiosity-media `docs/operations/kaii-image-worker-wsl.md`、
D-139 / D-141 / D-143）と同じ設計である。

- API キーを使わない
- 専用の Linux ユーザーで動かす
- Codex を書き込みのできない sandbox で動かす
- 失敗は符号だけで返す

**利用者（`sr-designgen`）も、Codex のサインインも、怪異読本とは分ける。**

## 何をするか

```
npm run sales:design-demo -- --facts <facts.json> --screens <dir> --screens-reviewed [--hint "..."]
  1. facts を fact-only filter（toDemoView）に通す。通らなければ止まる
  2. next build → next start（127.0.0.1、SR_DESIGN_PREVIEW_ROOT を付けて /design-preview を有効にする）
  3. 今のテンプレートのデモ（before）を PC 1440px / mobile 390px で撮る
  4. brief: Codex に facts と参考スクリーンショットと before を渡す
     → DesignProfile（JSON Schema で固定）を受け取る
     → zod とコントラスト検査を通す
       - 通らない / Codex が失敗した → 既存テンプレートに戻す（fallback_template）
       - confidence < 0.5 → 業種の既定 profile を使う
  5. candidate を描いて撮る → review: Codex が VisualReview（採点・問題点・改訂 profile）を返す
     → revise なら改訂 profile で描き直す（最大 2 回）
     → renderer 自体の機能が要ると言われたら BLOCKED で止まる（コードは自動で変えない）
  6. 点の最も高い candidate を final にして撮る。before / after を並べて置く
```

Codex が決めてよいのは次の値だけである（`lib/design-agent/profile.ts` の列挙値の中から選ぶ）。

- palette
- typography
- heroLayout
- composition
- motifs
- spacing
- motion

文言・HTML・CSS は受け取らない。
ページの文字は、確認済みの fact と固定の見出しだけから作る（`tests/unit/design-agent/renderer.test.tsx`）。

## 1. 利用者を作る（WSL の root で）

```bash
sudo adduser --disabled-password --gecos "" sr-designgen
sudo chmod 700 /home/sr-designgen
# GitHub Actions の runner の利用者や kaii-imagegen を、この利用者の group に入れない。
```

## 2. 道具を入れる（sr-designgen で）

```bash
sudo -iu sr-designgen
# Node 22 以上（nvm などで利用者のホームに入れる）
npm config set prefix ~/.npm-global && echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
. ~/.profile
npm install -g @openai/codex@latest
codex --version            # 0.158.0 で確認した（--image / --output-schema / --output-last-message を使う）
```

`~/.profile` や `~/.bashrc` に `OPENAI_API_KEY` / `CODEX_API_KEY` を**書かない**。
CLI は子プロセスへ渡す前に消すが、そもそも置かない。

## 3. サインインする（人が 1 回。切れたら同じ手順）

```bash
codex login --device-auth  # 表示された URL を開き、コードを入れて ChatGPT でサインイン
codex login status         # 「Logged in using ChatGPT」であること（API key なら CLI は止まる）
```

`~/.codex/config.toml` に別の `model_provider`（Azure など、API キーを使うもの）を書かない。
CLI は念のため `-c model_provider="openai"` を付けて呼ぶ。

サインイン情報は `~/.codex/` にだけ置かれる。
**コピーしない。リポジトリ・Actions secrets・Vercel・Claude のクラウド環境に入れない。**

## 4. リポジトリ（読むだけ）

```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/ioda47871-byte/second-root.git && cd second-root
git checkout feature/dev-028-ai-art-direction   # merge 後は develop
npm ci
npx playwright install chromium                 # スクリーンショット用
```

この clone に入力や結果を置かない（リポジトリは public である）。
Supabase の鍵も要らない。PoC は DB を読まず、書かない。

## 5. 入力を用意する（リポジトリの外）

```
~/sr-design-input/<shop>/
  facts.json      確認済みの fact だけ（sales_demos.content と同じ形）
  screens/        人が撮った参考スクリーンショット（.png / .jpg / .webp、1〜6 枚、各 8 MB まで）
```

`facts.json` の形は次のとおり。値は、確認済みの公開情報だけにする。
分からない項目は書かない（null ではなく、キーごと省く）。

```json
{
  "name": "<店名>",
  "category": "baked_goods",
  "ward": "<区>",
  "address": "<確認済みの住所>",
  "hours": "<確認済みの場合だけ>",
  "closed_days": "<確認済みの場合だけ>",
  "access": "<確認済みの場合だけ>",
  "description": "<確認済みの紹介文だけ>",
  "menu_items": ["<確認済みのメニュー名>"]
}
```

メールアドレスは、書いても filter が落とす。電話番号は、デモに出してよい場合だけ書く。

スクリーンショットのチェックリストは次のとおり。`--screens-reviewed` は、これを確かめた印である。

- [ ] 店の**公開**ページだけ（Instagram はプロフィール上部と投稿グリッド。必要なら公式サイトの 1 画面）
- [ ] コメント欄・DM・通知・自分のアカウント情報が写っていない
- [ ] 第三者の顔・名前・個人情報が不要に写っていない（写っていれば切り抜く）
- [ ] ログイン状態を示す要素（自分のアイコン等）が写っていない

「今のデモ」のスクリーンショットは、CLI が自動で撮る（before）。用意しなくてよい。

## 6. 実行する

```bash
cd ~/src/second-root
unset OPENAI_API_KEY CODEX_API_KEY OPENAI_BASE_URL
npm run sales:design-demo -- \
  --facts ~/sr-design-input/<shop>/facts.json \
  --screens ~/sr-design-input/<shop>/screens \
  --screens-reviewed \
  --hint "American Editorial Bakery / Baked Goods"
```

| option | 意味 |
|---|---|
| `--run-id <id>` | 結果のディレクトリ名。既定は日時と乱数 |
| `--max-revisions 0..2` | 自動修正の回数（既定 2、上限 2） |
| `--skip-build` | 直前に `npm run build` 済みなら省く |
| `--schema-mode loose` | Codex が JSON Schema の長さ・範囲の指定を受け付けない場合だけ使う（zod の検査はそのまま） |
| `--port <n>` | ローカルの preview の port（既定 3210。使用中なら止まる） |
| `--out-root <dir>` | 結果の置き場所（既定 `~/.local/share/second-root-design`。リポジトリの中は拒否） |

全体は 75 分まで。

- build: 20 分
- brief: 15 分
- review: 1 回 10 分

時間切れの子プロセスは、process group ごと SIGTERM → SIGKILL する。

## 7. 結果

`~/.local/share/second-root-design/<run-id>/`（700）:

| file | 中身 |
|---|---|
| `before-desktop.png` / `before-mobile.png` | 今のテンプレート |
| `after-desktop.png` / `after-mobile.png` | final の profile |
| `candidate-N.json` / `final.json` | design profile（見た目の値と短い rationale） |
| `review-candidate-N.json` | Codex の採点・問題点・改訂案 |
| `report.json` | 状態・符号・各回の点 |
| `facts.json` | 入力した fact（fact filter 用） |
| `shots/` | 各 candidate のスクリーンショット |

Windows から見るには、エクスプローラーで
`\\wsl$\<distro>\home\sr-designgen\.local\share\second-root-design\` を開く。

終了コードの意味:

| code | 意味 |
|---|---|
| 0 | 完了。または `fallback_template`（既存テンプレートのまま） |
| 2 | BLOCKED（renderer の機能追加が要る。`review-*.json` を読み、人が判断する） |
| 3 | 環境の都合（サインイン・利用枠） |
| 1 | 入力の誤り、描画やシステムの失敗（`failure.json` に符号だけを残す） |

## 8. 失敗の符号

| 符号 | すること |
|---|---|
| `CODEX_NOT_INSTALLED` | 手順 2 |
| `CODEX_NOT_SIGNED_IN` | 手順 3 |
| `CODEX_API_KEY_AUTH` | `codex logout` → 手順 3 |
| `CODEX_QUOTA` | 時間を置く（ChatGPT の利用枠） |
| `CODEX_TIMEOUT` / `CODEX_EXEC_FAILED` / `CODEX_NO_JSON` | 1 回だけやり直す。続くなら `--schema-mode loose` を試す |
| `BRIEF_PROFILE_INVALID` | Codex の答えが列挙値やコントラストの検査を通らなかった。`brief-rejected.json` を見る |
| `LOW_CONFIDENCE_CATEGORY_DEFAULT` | 材料が弱かった。スクリーンショットを見直す |
| `RENDERER_CHANGE_NEEDED` | BLOCKED。renderer の拡張は人が判断し、PR で行う |
| `NO_REVIEWED_CANDIDATE` | review が 1 回も成功しなかった。未評価の design は出さず、既存テンプレートのまま |
| `OVERFLOW_<candidate>_DESKTOP / _MOBILE` | その candidate が横にはみ出した。スクリーンショットで確認する |

Codex の出力と stderr は画面にもログにも写さない。
問題点の文面などは、結果のディレクトリの JSON にだけ残る。

## 9. 後片付け

- 判断が終わったら、結果のディレクトリ（`~/.local/share/second-root-design/<run-id>/`）を消す
- 入力（`~/sr-design-input/<shop>/`）も消す。スクリーンショットを残し続けない
- Codex の作業ディレクトリ（`/tmp/sr-design-codex-*`）は、実行ごとに CLI が消す

## 置いてよいもの / 置いてはいけないもの

| もの | 置き場所 | 置いてはいけない所 |
|---|---|---|
| Codex のサインイン（`~/.codex/auth.json`） | sr-designgen のホームだけ | リポジトリ、Actions、Vercel、Claude のクラウド環境、他の利用者 |
| 店舗の facts / スクリーンショット | `~/sr-design-input/`（700） | リポジトリ（public）、Issue、PR |
| design profile・review・スクリーンショット | `~/.local/share/second-root-design/`（700） | リポジトリ、公開デモの asset |
| API キー（OpenAI） | **どこにも置かない** | — |

## この PoC がしないこと

- DB（Supabase）を読む・書く。migration も作らない
- Production・Staging・営業 Routine・Operational Claude に繋ぐ
- 店舗へ連絡する、DM・メールを送る
- Instagram を自動で撮る（スクリーンショットは人が用意する）
- 店舗写真・ロゴ・Instagram の画像をデモに使う
- renderer のコードを自動で書き換える（要るなら BLOCKED）
