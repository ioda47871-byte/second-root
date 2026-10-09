# Sales Design Bridge（DEV-030）— 実機の手順

Sales Agent の demo と、WSL の AI design worker をつなぐ。設計は `docs/ARCHITECTURE.md` §10、境界は `docs/SECURITY.md` §11。

**この文書の手順はすべて人が行う。** DEV-030 の PR は次のどれも行っていない:
- migration の Staging / Production への適用
- secret の生成と Vercel への設定
- Linux 利用者と spool の作成
- jail の変更と入れ直し
- systemd unit の install / enable

順番を守る。どの段階でも、`SALES_AI_DESIGN_ENABLED` を `true` にしない限り Sales Agent は既存のまま動く。

```
Second Root server ──https── local bridge（sr-designbridge, token あり）
                                   │ /srv/sr-design-bridge/to-worker   (job)
                                   ▼ /srv/sr-design-bridge/from-worker (result)
                             design worker（sr-designgen, jail の中, token なし）
```

## 0. 承認が要る点（この順で人が決める）

| # | 何を | 理由 |
|---|---|---|
| A | migration `20261009000000_sales_design_bridge.sql` を Staging に適用（次に Production） | DB schema の変更 |
| B | `SALES_DESIGN_BRIDGE_TOKEN` の生成と、Vercel（Staging の Preview → Production）・bridge の file への保存 | secret |
| C | Linux 利用者 `sr-designbridge` と `/srv/sr-design-bridge` の作成 | 実機の権限 |
| D | worker の jail に spool の bind を 2 行足し、root だけの clone から入れ直す | security boundary の設定（root） |
| E | `SALES_AI_DESIGN_ENABLED=true`（Staging → Production） | 機能を有効にする |
| F | `sr-design-bridge.timer` の install / enable（任意。それまでは手で `--once`） | 自動実行 |

## 1. migration（A）

- Staging: `docs/STAGING.md` の手順（`npm run staging:apply`）で適用し、`npm run staging:verify` を確かめる。
- Production: `docs/RELEASE.md` の手順。人が適用する。
- 適用しても既存の demo は `design_status = null`（legacy）のまま。flag が無効なら、アプリは新しい列を読みも書きもしない。

## 2. token（B）

```bash
# 人の端末で。値はどこにも貼り付けず、2 か所に保存するだけ
openssl rand -base64 48 | tr -d '\n'
```

- Vercel: `SALES_DESIGN_BRIDGE_TOKEN`（server only。`SALES_AGENT_INGEST_TOKEN` と**別の値**。同じだと API は 503）。
- bridge: `/home/sr-designbridge/.config/second-root/design-bridge.token`（`sr-designbridge` の所有、0600）。
- **worker（`sr-designgen`）・Codex・Claude の session・Operational Claude には渡さない。**

## 3. 利用者と spool（C）

```bash
sudo adduser --system --group --home /home/sr-designbridge --shell /usr/sbin/nologin sr-designbridge
# sudo / docker / lxd 等の admin group には入れない。sr-designgen の group にも入れない

sudo install -d -o root -g root -m 0755 /srv/sr-design-bridge
sudo install -d -o sr-designbridge -g sr-designgen -m 2750 /srv/sr-design-bridge/to-worker
sudo install -d -o sr-designgen -g sr-designbridge -m 2750 /srv/sr-design-bridge/from-worker
```

- `to-worker/`: bridge が job を書き、worker は読むだけ（消せない）。
- `from-worker/`: worker が結果を書き、bridge は読むだけ。
- どちらの側も、link を辿らない・通常ファイル・link 数 1・サイズ上限・strict schema で読む。

## 4. worker の jail（D、root）

worker の jail は `/srv` を空の read-only にしている（`scripts/sales-design-capture/jail/jail.properties`）。spool を見せるには、承認したうえで次の 2 行を足し、**root だけの clone**（`/root/sr-capture-admin`）から入れ直す（`docs/operations/design-wsl-isolation.md`）。

```
BindReadOnlyPaths=-/srv/sr-design-bridge/to-worker
BindPaths=-/srv/sr-design-bridge/from-worker
```

- 入れ直した後に `admin.sh jail-check` が `JAIL_OK` を返すことを確かめる。
- **DEV-030 の PR は `jail.properties` を変えていない。** この 2 行は、別の承認済み commit で入れる。
- これで jail から見えるのは spool の 2 つの directory だけになる。token・Supabase・server への経路は増えない（token は jail の外の `sr-designbridge` だけが持つ）。

## 5. bridge の checkout と設定

`sr-designbridge` として、承認した commit を clone して `npm ci` する。bridge の `run.sh` は自分で更新しない。

```bash
sudo -u sr-designbridge -s /bin/bash   # この作業のときだけ
git clone https://github.com/ioda47871-byte/second-root.git ~/second-root
cd ~/second-root && git checkout --detach <承認した commit> && npm ci
install -d -m 700 ~/.config/second-root
printf 'SR_DESIGN_BRIDGE_API_URL=https://<Staging か Production の origin>\n' > ~/.config/second-root/design-bridge.env
chmod 600 ~/.config/second-root/design-bridge.env
# token file は §2 の値で、0600
```

worker の設定（`design-worker-wsl.md` の service / 手での起動）に、spool の path だけを足す:

```
SR_DESIGN_BRIDGE_SPOOL=/srv/sr-design-bridge
```

worker の `run.sh` はこの変数だけを通す。token・API の URL は worker に置かない。

## 6. 手で 1 回ずつ確かめる

1. Staging で `SALES_AI_DESIGN_ENABLED=true` にする（E）。Operational Claude の run が作る demo は「AIデザイン待ち」になる。
2. bridge: `sudo -u sr-designbridge env $(cat ~sr-designbridge/.config/second-root/design-bridge.env) ~sr-designbridge/second-root/scripts/sales-design-bridge/run.sh --once` → `claimed b-…`
3. worker: 通常どおり 1 run（`run.sh`）→ `bridge: imported 1` … `bridge: exported 1`
4. bridge をもう一度 `--once` → `delivered 1`
5. `/admin/sales` で「デモ確認可能」→ プレビューで確認 → 人が DM を送る → 「送信済み」

## 7. 出力の符号

| bridge | 意味 | 対応 |
|---|---|---|
| `BRIDGE_NOT_CONFIGURED` | URL か token file がない | §5 |
| `BRIDGE_TOKEN_UNSAFE` | token file が自分の 0600 の通常ファイルでない、短い | §2 |
| `BRIDGE_API_UNSAFE` | URL が https でない、credential や query がある | §5 |
| `BRIDGE_DISABLED` | server が 503（flag 無効・token 未設定・ingest token と同じ） | Vercel の設定 |
| `BRIDGE_UNAUTHORIZED` | token 不一致 | §2 |
| `BRIDGE_API_UNAVAILABLE` / `BRIDGE_RESPONSE_INVALID` | 通信・応答の問題 | 次の回に自動で再試行 |
| `BRIDGE_SPOOL_INVALID` | spool に書けない | §3 |
| `BRIDGE_WRONG_USER` | root・`sr-designgen`・`sr-igcapture` で起動した | `sr-designbridge` で起動する |

demo の `design_error_code`（管理画面では「デザインBLOCKED」「AIデザイン失敗」と既存テンプレートの案内）:
- `PUBLIC_SOURCE_UNAVAILABLE`、`FALLBACK_TEMPLATE`、`DESIGN_BLOCKED`、`RENDERER_CHANGE_NEEDED`
- `DO_NOT_CONTACT`、`DEMO_DISABLED`、`ALREADY_SENT`、`NO_VISUAL_SOURCE`、`DEMO_CONTENT_INVALID`
- `PROFILE_INVALID`、`WORKER_FAILED`（ほか worker の固定の符号）、`DESIGN_STALE`

## 8. 自動実行（F、任意）

`scripts/sales-design-bridge/systemd/sr-design-bridge.service` / `.timer`（10 分ごと）を、root だけの clone から `/etc/systemd/system/` に入れて enable する。
**repo のどの script も enable しない。** worker の timer も別の判断で、この文書は enable しない。

## 9. 止める・戻す

- **即時に止める**: Vercel の `SALES_AI_DESIGN_ENABLED` を外す（または `false`）。
  - bridge API は 503 になり、bridge は `BRIDGE_DISABLED` で止まる。
  - 公開 demo と管理画面は legacy の表示・操作に戻る。`ready` の profile は使われず、待ち・生成中の候補も送れるようになる。
  - DB の行はそのまま残る。
- bridge だけ止める: timer を disable するか、token file を消す。
- migration は forward only。flag が無効なら列は使われないので、戻す必要はない。
