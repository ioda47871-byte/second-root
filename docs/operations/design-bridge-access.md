# Vercel Authentication を維持したまま bridge だけを通す（DEV-059）

WSL の design bridge（`sr-designbridge`）は、Staging の bridge API
（`https://second-root-git-develop-brot-yanagi.vercel.app/api/internal/sales-design/jobs`、Vercel project `prj_EdI3HMmSZ6NmtTFSqp1nscyYnHGS`）に claim / submit を送る。
Preview には Vercel Authentication が掛かっているので、これまでは controlled rerun のたびに人が Authentication を一時的に外していた（復旧タスク 2 つ・固定の期限・自動復旧つき）。
2026-10-19 の人の指示: **Authentication は外さない。認証された bridge だけが届く方式を考える。** HUMAN-010（timer の有効化）は保留。

この文書は方式の比較・推奨案・人の操作・確認と戻し方をまとめる。

> **この文書と DEV-059 の PR は、HUMAN-010（cycle の install・timer の有効化）も、Staging の `SALES_AI_DESIGN_ENABLED` を常時 ON にすることも承認しない。** それぞれ別の人の判断のまま。
> この PR は Vercel・Supabase・WSL の設定を何も変えていない。secret も作っていない。コードの対応は**既定で無効**。

関連: bridge の手順 `design-bridge.md`、cycle `design-worker-cycle.md`、Staging の secret の置き場所 `../STAGING.md` §2.1・§5、secret の一覧 `../SECURITY.md` §1。

## 1. 今の状態（2026-10-19、Claude の読み取り）

`api.vercel.com` への GET（proxy の credential、読み取りだけ。secret の値は表示しない形で集計）と、credential の付かない deployment 固有 URL への無認証 POST で確かめた。

| 項目 | 値 |
|---|---|
| Vercel Authentication（`ssoProtection`） | `all_except_custom_domains`（Preview と Production の `*.vercel.app` URL を保護。custom domain の `secondroot.jp` は公開） |
| Password Protection / Trusted IPs / OPTIONS Allowlist | どれも無し |
| Protection Bypass for Automation | **2 つ**。① 2026-08-22 作成・note なし・`isEnvVar: true`（system env の `VERCEL_AUTOMATION_BYPASS_SECRET` として deployment に入っているもの）② 2026-09-28 作成・note「Second Root Staging Claude」・`isEnvVar: false`（Operational Claude 用。Claude Cloud の API credential「Second Root Staging API」に入っている） |
| 無認証の API 呼び出しへの応答 | **401**、`content-type: application/json`、本文は `{"protection":{…,"vercel_auth_enabled":true,…},"message":"Protected by Vercel Authentication",…}`（ブラウザ以外には 302 ではなく JSON の 401。`_vercel_sso_nonce` の cookie つき） |
| 存在しない（でたらめな）bypass 値を付けた場合 | 同じ 401（Vercel の JSON） |

bridge API 自身の 401 は `{"error":"unauthorized"}`。本文で区別できるので、bridge は Vercel の 401 を `BRIDGE_PROTECTION_BLOCKED`、API の 401 を `BRIDGE_UNAUTHORIZED` と分けて止まる（§6）。

## 2. Vercel の仕様（出典）

2026-10-19 に読んだ Vercel の公式 docs・changelog（docs の `last_updated` を併記）。

| 何 | 出典 |
|---|---|
| Protection Bypass for Automation は**全プラン**。「You can create multiple bypass secrets per project to manage access independently for different tools」。「You can use each available secret to bypass Deployment Protection on **all deployments in a project** until the secret is revoked」。header `x-vercel-protection-bypass`（推奨）か同名の query。bypass するのは Vercel Authentication・Password・Trusted IPs と、system mitigation・Bot protection。攻撃中の DDoS 対策・rate limit は bypass しない | [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)（last_updated 2026-09-16） |
| 複数 secret の対応（各 secret に note） | [changelog: Protection bypass for automation now supports multiple secrets](https://vercel.com/changelog/protection-bypass-for-automation-multiple-secrets)（2026-01-13） |
| 「Create one secret per system」「revoke them independently」「Revoking a secret invalidates it for all existing deployments」「Prefer headers over query parameters」。権限は team の Member 以上か Project Administrator | [Automated & Agent Access](https://vercel.com/docs/deployment-protection/automated-agent-access)（last_updated 2026-09-15） |
| Deployment Protection Exceptions は全プラン。指定した preview domain が**誰にでも公開**される | [Deployment Protection Exceptions](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/deployment-protection-exceptions)（last_updated 2026-09-15） |
| OPTIONS Allowlist は全プラン。`OPTIONS` の preflight だけを通す | [Methods to bypass Deployment Protection](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection)（last_updated 2026-09-15） |
| Trusted IPs は **Enterprise だけ**。IPv4 / CIDR。許可外は 404 | [Trusted IPs](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/trusted-ips)（last_updated 2026-08-28） |
| Trusted Sources は全プラン。短命の OIDC token（header `x-vercel-trusted-oidc-idp-token`）。issuer は公開された OpenID Discovery（`/.well-known/openid-configuration`・JWKS）が要る。rule ごとに対象 environment を選べる | [Trusted Sources](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources)（last_updated 2026-08-28）、[changelog](https://vercel.com/changelog/trusted-sources-for-deployment-protection)（2026-05-13） |
| Shareable Links は全プラン（Hobby は 1 account 1 本）。branch の deployment を query で共有する、人向けの機能 | [Sharable Links](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/sharable-links)（last_updated 2026-08-28） |
| Vercel Authentication の cookie は 1 URL 限定 | [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication)（last_updated 2026-09-15） |

## 3. 前提: bypass を持った攻撃者に何ができるか

どの方式でも、Vercel の保護を通った後に bridge API が**自分の認証**をする（`lib/sales/design-bridge-auth.ts`）:
flag が無効・hash 未設定なら 503、bridge token（SHA-256 の照合）が無ければ 401。ingest token では通らない。
Vercel の保護は「外側の扉」で、bridge token が「内側の鍵」。

| bypass の値**だけ**を持つ人ができること | できないこと |
|---|---|
| project のすべての保護付き deployment（develop の alias・他の branch の Preview・deployment 固有 URL・Production の `*.vercel.app` URL）を、Vercel のログインなしで開く。公開 demo の画面、管理画面のログイン画面を見る | 管理画面に入る（Supabase の管理者ログインが要る） |
| Bot protection・system mitigation を通る（攻撃中の DDoS 対策・rate limit は通らない） | bridge API で claim / submit する（bridge token が要る）、ingest API を使う（ingest token が要る） |
| どの deployment が何の branch かを URL から推測する | DB・環境変数・Vercel の設定を読む・変える、deploy する |

bridge の利用者（`sr-designbridge`）が乗っ取られた場合は、token と bypass の両方が漏れる。これは、今の「Authentication を一時的に外している間に token が漏れた」場合と同じ力（Staging の design job の claim / submit）で、増えるのは「Vercel の保護付きページを見られる」ことだけ。

## 4. 方式の比較

| | (a) bridge 専用の bypass secret | (b) 既存の bypass を使い回す | (c-1) Deployment Protection Exceptions | (c-2) Trusted IPs | (c-3) OPTIONS Allowlist | (d-1) Trusted Sources（自前の OIDC issuer） | (d-2) 毎回 Authentication を外す（今） |
|---|---|---|---|---|---|---|---|
| Authentication を維持 | ○ | ○ | ×（alias が誰にでも公開） | ○ | ○ | ○ | ×（開いている間は誰にでも公開） |
| bridge だけが通る | ○（bypass + bridge token） | △（Operational Claude と同じ値） | ×（誰でも。bridge token だけが守り） | △（その IP の全員） | ×（POST は通らない） | ○ | ×（bridge token だけ） |
| 露出の範囲 | project 全体の保護付き deployment（branch・environment で絞れない） | 同じ（しかも 2 か所に同じ値） | その domain を誰にでも | IP 単位 | — | rule で選んだ environment（`preview`）。branch では絞れない | project の全 deployment（外している間） |
| 費用 | 無料（全プラン） | 無料 | 無料（全プラン） | **Enterprise のみ** | 無料 | 無料。ただし公開の issuer（discovery・JWKS）を自前で運用 | 無料。人の手間と復旧タスク |
| 失効 | Vercel の画面でその secret だけ revoke（他は無傷）。redeploy 不要（env var にしない） | revoke すると Operational Claude の Staging ingest も止まる | 画面で domain を外す | 画面で IP を外す | — | rule を消す / 鍵を替える | Authentication を戻す |
| 漏れた時の特定 | secret ごとに note があり、どれが漏れたか分かる | WSL と Claude Cloud のどちらから漏れたか分からない | — | — | — | 鍵ごと | — |
| WSL 側の準備 | 0600 file 1 つ（このPRのコード、既定で無効） | 値を Claude Cloud の credential から人が取り出して WSL に写す | 無し | 固定の global IP が要る（家庭回線では変わる。Vercel は IPv4 だけ） | 無し | 署名鍵・token 発行・公開 host に discovery と JWKS | 無し |
| 判定 | **推奨** | 不可 | 不可（Authentication を外すのと同じ） | 不可（費用・IP） | 不可（用途違い） | 将来の候補 | やめる |

その他に検討して外したもの:
- **Shareable Links**: 人がブラウザで見るための機能（query + cookie）。値が URL に乗る。deployment / branch 単位で、自動化の手順が docs に無い。
- **`vercel curl` / Vercel MCP**: WSL に Vercel のアカウントのログイン（project の設定を変えられる強い credential）を置くことになる。bypass より範囲が広い。
- **bridge API を Production の custom domain で呼ぶ**: 対象は Staging。Production は変えない。
- **①の `VERCEL_AUTOMATION_BYPASS_SECRET`（isEnvVar）を使う**: その値はすべての deployment の環境変数に入っていて、build・関数のコードから読める。bridge には使わない。

### (a) の詳細

- 露出: project 全体（§3）。Vercel は branch や host で絞れないので、**host の限定は bridge 側で行う**: header は設定した 1 つの origin（`https://<name>.vercel.app`、API URL と同じ origin）への request にだけ付け、redirect は辿らない（`redirect: "error"`）。`secondroot.jp` やその他の host には決して送らない（コードが拒否する）。
- 費用: 無料。
- 失効: Vercel → second-root → Settings → Deployment Protection → Protection Bypass for Automation で、その secret（note「Second Root design bridge (WSL)」）を revoke / delete。全 deployment で即時に無効。env var にしていないので redeploy は要らない。Operational Claude の secret（②）は影響を受けない。
- 失敗: 値が違う・revoke 済み → Vercel が 401（JSON）→ bridge は `stopped: BRIDGE_PROTECTION_BLOCKED`（exit 3）。claim の前なら cycle は `CYCLE_STOP_CLAIM`（phase=before_claim、何も変わらない）。claim の後の最後の deliver-only なら `CYCLE_STOP_DELIVER_AFTER` → `design-worker-cycle.md` §6。file が無い・権限が緩い・origin が違う → bridge は request を送る前に `BRIDGE_BYPASS_NOT_CONFIGURED` / `BRIDGE_BYPASS_UNSAFE`、cycle は dry-run の段階で `CHECK_BYPASS_*`。どれも fail closed で、Authentication を外す方向には倒れない。
- 攻撃者: §3 のとおり。bridge token が無ければ bridge API では何もできない。

### (b) を採らない理由

- 「Second Root Staging Claude」の値は、Claude Cloud の API credential の中にしか無い（proxy が付け、Claude の process にも入らない）。WSL に写すには人がその値を取り出す必要がある。
- 1 つの値を 2 つの caller が持つと、片方の漏れでも両方を止めることになり、どちらから漏れたか分からない。`SECURITY.md` §1 の「caller ごとに別の secret」に反する。

### (d-1) Trusted Sources を今は採らない理由

static な secret を置かずに済み、`preview` だけに絞れるので、仕組みとしては (a) より良い。ただし WSL には OIDC の issuer が無い。
自前で用意するには、署名鍵を WSL（root か `sr-designbridge`）に置き、discovery document と JWKS をインターネットから読める host に公開し、短命の token を発行する仕組みを作って保守する必要がある。
GitHub Actions の issuer を使うと bridge が WSL の外に出ることになり、spool の設計（`design-bridge.md`）と合わない。
public の issuer を安定して置ける場所ができたら、(a) から移る候補にする（移るときは (a) の secret を revoke する）。

## 5. 推奨: (a) bridge 専用の bypass secret

- Vercel に、bridge のためだけの Protection Bypass for Automation を **3 つ目の secret** として作る（note「Second Root design bridge (WSL)」。**env var には指定しない**）。
- 値は WSL の `sr-designbridge` の file にだけ置く: `/home/sr-designbridge/.config/second-root/design-bridge.vercel-bypass`（`sr-designbridge` の所有、0600、通常 file、link 数 1、改行なし）。
  - 「root だけが読める file」にしないのは、bridge が `sr-designbridge` として動き（root では動かない。`run.sh` が止める）、root の file を読めないため。bridge token と同じ所有者・同じ mode で、worker（`sr-designgen`）・jail・Codex・Claude の session からは読めない。root はどちらも読める。
- 有効・無効を決めるのは次の 2 つ。**役割が違う**:
  1. **bridge の設定** `~sr-designbridge/.config/second-root/design-bridge.env` の 2 行
     `SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=<上の file>` と `SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=https://second-root-git-develop-brot-yanagi.vercel.app`。
     **この 2 行だけで bypass は有効になる**: `sr-design-bridge.service`（`EnvironmentFile=` でこの file を読む）と、手での `run.sh`（`design-bridge.md` §6 の `env $(cat …design-bridge.env)`）は、root のスイッチに関係なく header を付ける。
  2. **cycle のスイッチ** root の `/etc/second-root/design-cycle.conf` の `SR_DESIGN_CYCLE_VERCEL_BYPASS=on`。これは `cycle.sh` だけに効く（cycle は env file を読んで、許可した変数だけを bridge に渡すため。無い・`off` なら cycle は 2 つの設定を渡さない）。bridge の unit や手での実行は止めない。
  - したがって **無効にする = `design-bridge.env` の 2 行を消す**（と、cycle のスイッチも消すか `off` にする）。スイッチを `off` にするだけでは cycle 以外の実行は止まらない（§8）。
- bridge のコード（DEV-059。`lib/design-agent/bridge/vercel-bypass.ts`・`client.ts`・`scripts/sales-design-bridge/bridge.ts`）:
  - 2 つの設定がどちらも無ければ何もしない（既定）。片方だけなら `BRIDGE_BYPASS_NOT_CONFIGURED` で止まる。
  - origin は `https://<1 つの label>.vercel.app` そのもの（port・path・query・末尾の `/`・認証情報なし）で、API URL の origin と同じでなければ `BRIDGE_BYPASS_UNSAFE`。
  - file は `O_NOFOLLOW`（link なら kernel が開かない）と `O_NONBLOCK`（FIFO で止まらない）で開き、**開いた handle を fstat で**確かめてからその handle から読む: 通常 file・link 数 1・この利用者の所有・mode が**ちょうど 0600**（cycle の確認と同じ。0400 も不可）・512 byte 以下・空白のない 16〜256 文字の可視 ASCII の 1 値。名前で確かめてから別に開き直すことはしない（確認と読み取りの間に差し替えられない）。bridge token と同じ値は拒否。どれかが違えば `BRIDGE_BYPASS_UNSAFE`（無ければ `BRIDGE_BYPASS_NOT_CONFIGURED`）。
  - bridge token の file（`readTokenFile`、DEV-030）は従来どおり lstat の後に読む形のまま（共通の helper ではないので DEV-059 では変えない）。
  - header は、送る URL の origin が設定の origin と完全に一致するときだけ付ける。redirect は辿らない（`redirect: "error"`。Node の fetch は redirect の応答で例外になり、`BRIDGE_API_UNAVAILABLE` で止まる）。
  - 値・file の path・origin は出力しない。エラーは固定の符号だけ。有効なときは 1 行 `vercel protection bypass in use (configured origin only)` を出す。
  - bridge token は今までどおり必要（bypass は token の代わりにならない）。
- cycle（`scripts/sales-design-worker/cycle.sh`）: スイッチが `on` のときだけ、env file の 2 行の形・origin が API URL の origin と同じこと・bypass file が `sr-designbridge` の 0600 の通常 file であること（中身は読まない）を確かめ、bridge に path と origin だけを渡す。出力は `cycle: vercel bypass: on|off`。子の出力の redaction は `*bypass*` という名前の値も消す。

## 6. 人の操作（1 回にまとめる）

**前提**（DEV-059 を含む承認済みの commit への更新。HUMAN-010 の install と同じ流れで、timer は有効化しない）:
`/root/sr-capture-admin` と `~sr-designbridge/second-root` をその commit に合わせ、`design-cycle.conf` の `SR_DESIGN_CYCLE_BRIDGE_SHA` を更新する（`design-worker-cycle.md` §4 の 1.〜2.、`design-bridge.md` §5）。

**人の操作（1 回）**:

1. Vercel → second-root → Settings → Deployment Protection → Protection Bypass for Automation → **Create**。note は `Second Root design bridge (WSL)`。env var（`VERCEL_AUTOMATION_BYPASS_SECRET`）にする secret は今のまま変えない。表示された値をコピーする（チャット・GitHub・Claude には貼らない）。
2. WSL で次をそのまま貼る。値は画面に出さずに入力する（`read -s`）。file が既にあれば上書きしない。
   値が空・短い・空白や制御文字を含むなど bridge が受け付けない形なら、**値を表示せずに**止まり、file も env の行も cycle のスイッチも書かない（bridge と同じ規則: 16〜256 文字の可視 ASCII）。
   ```bash
   sudo -u sr-designbridge -H bash -c 'umask 077; export LC_ALL=C
     d="$HOME/.config/second-root"; f="$d/design-bridge.vercel-bypass"; e="$d/design-bridge.env"
     test ! -e "$f" || { echo "bypass file exists; not overwritten" >&2; exit 1; }
     IFS= read -rs -p "Vercel bypass value (not shown): " v; echo
     [[ "$v" =~ ^[!-~]{16,256}$ ]] || { unset v; echo "BYPASS_VALUE_INVALID: empty or not 16-256 visible ASCII characters (not shown); nothing written" >&2; exit 1; }
     printf "%s" "$v" > "$f"; unset v; chmod 600 "$f"
     grep -q "^SR_DESIGN_BRIDGE_VERCEL_BYPASS_" "$e" || printf "SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=%s\nSR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=https://second-root-git-develop-brot-yanagi.vercel.app\n" "$f" >> "$e"
     stat -c "%U %a %s bytes" "$f"' \
   && { sudo grep -q '^SR_DESIGN_CYCLE_VERCEL_BYPASS=' /etc/second-root/design-cycle.conf || echo 'SR_DESIGN_CYCLE_VERCEL_BYPASS=on' | sudo tee -a /etc/second-root/design-cycle.conf >/dev/null; } \
   && sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh --dry-run
   ```
   - `stat` が `sr-designbridge 600 32 bytes` 前後、最後の行が `CYCLE_RESULT CYCLE_DRY_RUN_OK …`、途中に `cycle: vercel bypass: on` が出ること。
   - `design-bridge.env` の `SR_DESIGN_BRIDGE_API_URL` が `https://second-root-git-develop-brot-yanagi.vercel.app` であること（違えば dry-run が `CHECK_BYPASS_INVALID` で止まる）。
   - 途中で失敗して空の file が残ったら `sudo -u sr-designbridge -H sh -c 'rm "$HOME/.config/second-root/design-bridge.vercel-bypass"'` で消してやり直す。

この操作は Vercel の Deployment Protection の設定を変えない（secret を 1 つ足すだけ）。Authentication は ON のまま。Staging の flag も変えない。

## 7. 確かめ方

Authentication は ON のまま。claim をしない確かめ方から順に行う。

1. **Claude（読み取りだけ）**: `api.vercel.com` の project を GET し、bypass の数が 3、新しい secret の note が `Second Root design bridge (WSL)`、`isEnvVar: false`、`ssoProtection` が変わっていないことを、値を出さずに確かめる。
2. **人（WSL、bridge token を使わない・claim しない）**: bypass が Vercel を通るかだけを見る。値は sh の組み込みの `printf` から curl の標準入力へ渡し、表示しない。bridge token を付けないので、API は何も claim しない。
   ```bash
   sudo -u sr-designbridge -H sh -c 'printf "x-vercel-protection-bypass: %s\n" "$(cat "$HOME/.config/second-root/design-bridge.vercel-bypass")" \
     | curl -sS --max-redirs 0 -H @- -X POST -H "content-type: application/json" --data "{}" \
         https://second-root-git-develop-brot-yanagi.vercel.app/api/internal/sales-design/jobs' \
     | python3 -I -c 'import json,sys; b=json.load(sys.stdin); print("VERCEL_BLOCKED" if "protection" in b else "REACHED_APP " + str(b.get("error")))'
   ```
   - `REACHED_APP design_bridge_disabled`（flag が OFF）か `REACHED_APP unauthorized`（flag が ON、token なし）なら bypass は効いている。
   - `VERCEL_BLOCKED` なら値が違う・revoke 済み。header を付けずに同じ curl をすると `VERCEL_BLOCKED` になることも確かめてよい。
3. **controlled rerun（人が承認した window の中で、今までどおり）**: Authentication は外さずに、flag だけを今までの手順で一時的に ON にして `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh` を 1 回。`CYCLE_OK`（または `CYCLE_IDLE`）であること、bridge の段に `vercel protection bypass in use` が出ること。これまでの「Authentication を外す」「復旧タスク 2 つ」は要らなくなる（flag の扱いと期限は今までどおり人が決める）。

## 8. 戻し方・失効・入れ替え

| したいこと | 操作 | 結果 |
|---|---|---|
| **使うのをやめる（無効にする）** | `design-bridge.env` の 2 行を消す（`sr-designbridge`）**と**、`/etc/second-root/design-cycle.conf` の `SR_DESIGN_CYCLE_VERCEL_BYPASS` の行を消す（root） | どの実行（cycle・`sr-design-bridge.service`・手での `run.sh`）も header を付けない。Vercel が 401 → `BRIDGE_PROTECTION_BLOCKED`（cycle は `CYCLE_STOP_CLAIM`、何も変わらない）。env の行を消さずにスイッチだけを消すと、cycle は `cycle: vercel bypass: off` で渡さないが、bridge の unit と手での実行は送り続ける |
| cycle だけを一時的に止める | `SR_DESIGN_CYCLE_VERCEL_BYPASS=off`（root） | cycle だけが渡さなくなる。cycle 以外は上の行のとおり変わらない |
| 失効（漏れた疑いを含む） | Vercel の Deployment Protection で note `Second Root design bridge (WSL)` の secret を revoke / delete → WSL の file を消す（`sudo -u sr-designbridge -H sh -c 'shred -u "$HOME/.config/second-root/design-bridge.vercel-bypass"'`） | すべての deployment で即時に無効。redeploy は要らない。Operational Claude（②）は影響なし |
| `sr-designbridge` が乗っ取られた疑い | 上の失効に加えて、bridge token も替える（`design-bridge.md` §2・`SALES_DESIGN_BRIDGE_TOKEN_SHA256`） | 両方の鍵が替わる |
| 定期の入れ替え（例: 90 日ごと、WSL の入れ替え時） | 新しい secret を作る → file を新しい値で置き換える（§6 の 2. は既存の file を上書きしないので、古い file を消してから）→ §7 の 2. → 古い secret を revoke | 止まる時間なし |
| 方式ごとやめる | 上の失効 + conf と env の行を消す | DEV-059 以前と同じ（Authentication ON のままでは bridge は届かない） |

コードの戻しは不要（設定が無ければ何もしない）。DB・migration は無い。

## 9. HUMAN-010 との関係

- 推奨案が入っても、HUMAN-010（cycle の install・dry-run・timer の有効化）は**保留のまま**。timer を有効にするかは別の人の判断。
- この方式で変わるのは「Vercel の保護を外さずに bridge が届く」ことだけ。Staging の `SALES_AI_DESIGN_ENABLED` を常時 ON にするかも、別の判断（`design-worker-cycle.md` §7）。
- Authentication を一時的に外す運用（復旧タスク・固定の期限）は、この方式の確かめ（§7）が済んだ後は使わない。
