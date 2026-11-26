# 成功例の原本の受け渡し（オーナー向けチェックリスト、Issue #336）

承認された成功例 37 件（[`originals-catalog.md`](../../design-library/success-cases/originals-catalog.md) の A/B/C）を、すべて原本で見られるようにするための受け渡しの手順。
受け渡すファイルの名前と、採用記録にある SHA-256 は [`originals-handover.json`](../../design-library/success-cases/originals-handover.json) が正本（下の表はその写し）。

**リポジトリは公開なので、原本（PNG・HTML・ZIP）はリポジトリに入れない。** 置くのはこの機械の非公開の置き場だけ。リポジトリに入るのは名前と SHA-256 などの記録だけ。
`manifest.json` と `second-root-research-successes.json` の件数は変えない（30 件・1 件のまま）。

## 1. 2026-11-26 の棚卸し（この機械とリポジトリ）

- ホーム（`/home/sr-designgen`、node_modules と .git を除く）の ZIP・PNG・WebP・JPEG・HTML 3,649 個の SHA-256 を、記録の SHA-256（134 個）と照合した。**新しく見つかった原本は 0 件。** ZIP は 1 個も無かった。
- 一致したのは、リポジトリにすでにある CP-001・CP-002・CP-003 の閲覧用 WebP（とそのコピー）と、SR-001 の頁（HTML）だけ。
- SR-001 の AI 写真入り完成版（2026-11-07 採用）のレンダー 3 枚は、非公開の画像実行の出力にある。実行の要約に書かれた頁の SHA-256 が台帳の値と一致し、各レンダーの SHA-256 が要約の値と一致することを確かめた（連鎖での照合。台帳そのものにはレンダーの SHA-256 は無い）。
- CP-001〜003 の元の PNG・ソース ZIP は、この機械に無い。
- CP-024 の疑似復元 v3 は記録で触れられているだけで、バイトはリポジトリにもこの機械にも無い。v3 は採用原本 v2 ではない。
- Windows 側（`/mnt/c`）は探していない。

| 状態 | 件数 | id |
|---|---|---|
| 原本を照合済み（非公開の写し） | 1 | SR-001（AI 写真入り完成版のレンダー、連鎖で照合。頁はリポジトリ） |
| リポジトリの登録ファイルを照合済み | 3 | CP-001・CP-002・CP-003（閲覧用 WebP。元 PNG は未受領） |
| 疑似復元だけ | 0 | （CP-024 v3 は記録だけで、バイトは無い） |
| SHA-256 不一致 | 0 | |
| 原本なし（受け渡し待ち） | 33 | CP-004〜013・015〜024、SR-002、CP-033〜037（B、26 件）、CP-026〜032（C、7 件） |

## 2. 置き場所

ChatGPT ライブラリ（`/セカンドルート/`）や会話から、下の表のファイルをダウンロードして、**名前を変えずに**次の場所に置く。

```
~/second-root-originals/<ID>/<ファイル名>        例: ~/second-root-originals/CP-034/SecondRoot_CP034_v12B_FullWeb_20261109.zip
~/second-root-originals/<ID>/pseudo/<ファイル名> 疑似復元（作り直し・近似の再現）。原本としては登録されない
```

- `<ID>` は表の ID（`CP-004`、`SR-002` など）。フォルダは自分で作る（`mkdir -p ~/second-root-originals/CP-034`）。
- 置いたファイルは道具が書き換えない。道具が書くのは `~/second-root-originals/_extracted/`（照合できた ZIP の中身）と `~/second-root-originals/_index/private-originals-index.json`（非公開の索引）だけ。
- 優先の順（`originals-catalog.md` の「原本を増やす順番」）: ① SR-002・CP-033〜037（ZIP と SHA-256 がそろう。全ページの Web サイト）→ ② CP-004〜024 のうち PC/SP がそろう HTML の PoC（CP-024・CP-009・CP-015 など）→ ③ C（CP-026〜032）は、まず原本がどこにあるかを確かめる。
- ZIP が 1 つあれば、表の同じ ID の PNG は要らない（ZIP の中で照合される）。ZIP が見つからないときは、表の PNG だけでもよい。

## 3. 受け渡すファイルの一覧

区分 B は ZIP（`success_zip`）を最優先。区分 C は記録された SHA-256 が無いので、渡しても「未照合」のままで、原本としては登録されない（原本だと確かめる方法を別に決める必要がある）。区分 A はリポジトリに閲覧用ファイルがあり、元のファイルは任意。

| ID | 区分 | ファイル | 種類 | 記録の SHA-256 |
|---|---|---|---|---|
| CP-004 | B | `harebare_editorial_poc_v1_source.zip` | source_zip | `889d6fba877520eb1a78ee14da05e9d0a0d444f692eb38895b4273311e05a3b6` |
| CP-004 | B | `desktop_full.png` | pc_png | `eb41b8a59a217259ef9010cf604616f63f765a6c22fbbca180cab0e8c7246849` |
| CP-004 | B | `mobile_full.png` | sp_png | `55701641e04f290086efb0d79eb246228b4de1424d529eabe09122ed510a9df5` |
| CP-005 | B | `secondroot_CP005_Hamsa_success_archive_20261027.zip` | success_zip | `7f0cfa59d092faea785a425bdb1c7a088b6e72d676d0aa242291eb494f14b0ca` |
| CP-005 | B | `hamsa_editorial_poc_v1.zip` | source_zip | `141e8827aadf2368224065faa5669f44f35c7b71abebcf9348a7d25065dbf413` |
| CP-005 | B | `design_reference_polished.png` | design_png | `54b4eddecdd053e1a4796779910798afba4d8f93218227000b3d41eab9a306aa` |
| CP-005 | B | `1440_full.png` | pc_png | `e1a0ac1ff9ff3db820094ef5c1a4127e1a634e09f10bf451b9b1a0dc615d1fc0` |
| CP-005 | B | `390_full.png` | sp_png | `6494351672ebaee545d53c85f5aae0a70ab3357656a30528d7e4929a9c31e9e2` |
| CP-006 | B | `secondroot_CP006_Melon_de_Mille_success_20261027.zip` | success_zip | `09070c9c7957eca876d9eebfe737bf021613d92161d5db4e8df474841b9737f7` |
| CP-006 | B | `CP-006_Melon_de_Mille_Cut_and_Stack_v2_approved.png` | approved_png | `996b4671da84b7a1a9fe69b5322f7652ff73aa69ec215c7958413805e6ca1921` |
| CP-007 | B | `secondroot_CP007_ORGN_SEAM_CUT_success_20261027.zip` | success_zip | `094aa62835123dc60918b62bda785b21ae53f65abd6bb44fe4784f249cbf338e` |
| CP-007 | B | `1440_full.png` | pc_png | `2d3083780691b00fb73127ee74370d34b34faa7e8d46b997da36a276b4c69d93` |
| CP-007 | B | `390_full.png` | sp_png | `c61bdfb84f5c399927364bad2493768d8b48808a0a2481cf63f422f296ea5e72` |
| CP-008 | B | `secondroot_CP008_SeitaiGo_success_20261027.zip` | success_zip | `bd2a12763c0b02964339b8539fae9bf62f6b5868143e16305bd494f0c965efb9` |
| CP-008 | B | `CP-008_SeitaiGo_v3_approved.png` | approved_png | `bb861c745f45b7cac87b1c74b59e05adbbf069e7c70cdbbf149e3c3c8346d63f` |
| CP-009 | B | `secondroot_CP009_MameMame_success_20261027.zip` | success_zip | `b393331cd5e63efb1c59b3470016fedb1b61f4e30d9166830db68855252b69d2` |
| CP-009 | B | `CP-009_MameMame_desktop_full.png` | pc_png | `aee4dcc2e41fd15fddf5bdf26d46835ced3208135342dfa866c6ec94aa9526f5` |
| CP-009 | B | `CP-009_MameMame_mobile_full.png` | sp_png | `b4513ecd14e7f12cd52dcce6b3d9379475864736cc92316c4933a0c20303ec14` |
| CP-010 | B | `secondroot_CP010_PaperTheater_PT02_success_20261027.zip` | success_zip | `a438dfce1434de4b6973283edcfd696c1a1e0b6a10850cb60b4918f21e59eecc` |
| CP-010 | B | PC FULL（1440） | pc_png | `6341c869f931810e449a3406ff87c5c9abf9e05bf5b5d56e87cc93a3f41983ce` |
| CP-010 | B | スマホ FULL（390） | sp_png | `a9594cda129bf903fd3a5978eb063b2c7a597dc13b2edd884f089d6b2f714ed1` |
| CP-011 | B | `secondroot_CP011_BAR_N_success_20261027.zip` | success_zip | `db741840c31b79b8e1582d99b7c39797a6a9d260f6718eabba89541c58dd873d` |
| CP-011 | B | `secondroot_CP011_BAR_N_structure_recovery_v2.zip` | source_zip | `e47e79fb882f3d5caec9de153552a56f85392020508f163f1d72ab803a36cb55` |
| CP-011 | B | `1440_full.png` | pc_png | `870ccff24b45438a6be2fbfda95aed8906208bac479bdb43b65c48ef1bc1bc4e` |
| CP-011 | B | `390_full.png` | sp_png | `dd4b1cf113c1b09ab45514b36f6bcd7fa11cf675f5464741f9640b3ac88038d5` |
| CP-012 | B | `secondroot_CP012_Admy_success_20261027.zip` | success_zip | `7fa174c2e341c009c82124208ec8624981e84b14df7e21970a25fadb5d9323f8` |
| CP-012 | B | `CP-012_Admy_owner_approved_concept.png` | approved_png | `b9309e3d4d4226abd3b2400fb079c6ecdd592874679f592d1b5e91ecfe672176` |
| CP-013 | B | `secondroot_CP013_SpaceTanoshii_success_20261028.zip` | success_zip | `ea3587b138cf42c54e0ae0e34ba3e1a792d8d6105cb52cca5ad973af2c5da0cb` |
| CP-013 | B | `CP-013_SpaceTanoshii_v2_approved.png` | approved_png | `6b52cdc05537d740cd61e4cbee042f86aa73c3b1cb8806059611979dfc6e031b` |
| CP-015 | B | `SecondRoot_CP015_TableJournal_v2_20261028.zip` | success_zip | `b580f3612d5ba36987adf39cd379f68424801676365a2fb01b9589750f74d696` |
| CP-015 | B | PC1440 ノート表示PNG | pc_png | `39615184f7b78e139f18f91761e2d630c1762661ec5b5f8bcb28aa1dfdb0bba2` |
| CP-015 | B | スマホ390 ノート表示PNG | sp_png | `4e997de75939d51145a098711d57076b59580a5a1263b1e1329d879df1d27d2f` |
| CP-016 | B | `SecondRoot_CP016_Zulu_Counterweight_ZK01_study.zip` | success_zip | `18e78a159b2d7f91fafc21c4cfde58c59e7ce57e232d79df1ed742be2966eab5` |
| CP-016 | B | PC 1440 初期状態の PNG | pc_png | `9ea42fe1cc87056d2810069343aa937468048917650897fe69780f1e7e08107e` |
| CP-016 | B | スマホ 390 初期状態の PNG | sp_png | `3b67d554b68e36aaf98fcebc8e45f960a267f3d2f80fcba51cd988b9e37c2e58` |
| CP-017 | B | `SecondRoot_CP017_UNWIND_v1_1_refinement_comparison.zip` | success_zip | `e7fdffe2e939d7aa7a4c0045e7ad8ef488a722b3b3ae17584e3f088836f8f293` |
| CP-017 | B | `CP017_Rurikoyarn_UNWIND_v1_1_refined.png` | approved_png | `4e70e70425d71a2ffe38ac702121e399817255493fac29e40c166d2850b21b28` |
| CP-018 | B | `a_wide_graphic_poster_like_website_landing_page.png` | approved_png | `69a4275c1e5adaac43199f4f825c5d43366702c69ac4ca7fd9bf15df970aacfa` |
| CP-019 | B | `wide_cinematic_high_end_editorial_website_homepag.png` | approved_png | `2162587bc40a8c2e33620ad78b35837457f3c507f7edb94f874bed6afe444ef9` |
| CP-020 | B | `a_cinematic_moody_vintage_café_website_landing_p.png` | approved_png | `1b19426edc9a135dc1f40bddf6f86417c16ed9d230c8dbc85150551e75877049` |
| CP-021 | B | `a_wide_high_quality_editorial_web_graphic_design.png` | approved_png | `c8675baaa39c9c04bab28a68ecc8ffe790b0d135187475340143b258daec94eb` |
| CP-022 | B | `wide_cinematic_editorial_website_poster_style_ima.png` | approved_png | `c6816c02d7d102c554b292fe9142567e25deba0b03fac575c06cb30f6a696abc` |
| CP-023 | B | `昼と夜を彩るバーガー_バー.png` | approved_png | `7f3ced52f3d22d09b6c6775a950619e28cbc5283b8102805bcd9362f364d194b` |
| CP-024 | B | `SecondRoot_CP024_Boheme_FullPage_Research_v2.zip` | success_zip | `ed83a5fa210b3847dbd95ce703f0799db7d148e6a55659bc47db999a90efc50a` |
| CP-024 | B | PC1440 全ページ PNG | pc_png | `5c81a615ed3bfec4c1d27ee1729bf80d56112a5df62d92b69b4274de673d0de9` |
| CP-024 | B | スマホ390 全ページ PNG | sp_png | `4e3af11e5f04646e890d8a14dc1143ea3b937e78b5928d2d8b2fcfd2ed634c68` |
| CP-033 | B | `SecondRoot_CP033_MARTELLI_Approved_20261108.zip` | success_zip | `5f18b6672bbc60d7db18c2af7b123fd2db448a78b8272c5e085746f1634edd77` |
| CP-034 | B | `SecondRoot_CP034_v12B_FullWeb_20261109.zip` | success_zip | `6f4fea138de381b2bca2d0d687f6ac821f897a0ee5e0079ffa97ba61632e51a1` |
| CP-035 | B | `SecondRoot_CP035_A_OneSheet_v2_20261110.zip` | success_zip | `81ad1b3f1351bc843ac97ca6aed761353e00f5ddc25715dc2a46da90051a5382` |
| CP-036 | B | `SecondRoot_CP036_Marugo_D_PhotoPolish_20261110.zip` | success_zip | `1527f51c1dc3109682e65c4192a46c7c07e02cbe47bea91af321cbeecdd74f61` |
| CP-037 | B | `SecondRoot_CP037_CA_MessageClarity_v2_20261110.zip` | success_zip | `4c4202266eb6b3814b012ea3c237feffc38428327f7fc27d64087b69105260eb` |
| SR-002 | B | `金時湯_地下水の物語.png` | approved_png | `da08c7981d26f269e73408edb0f12d631f1fd19071f4e7853138086795392695` |
| SR-002 | B | `SecondRoot_SR002_Kintokiyu_approved_20261107.zip`（ZIP 自体の SHA-256 は記録なし。中の承認 PNG で照合する） | container_zip | 記録なし |
| CP-026 | C | `SecondRoot_CP026_SawaddeeChao_ChiangMaiShopNote_v5.zip` | candidate_zip | 記録なし |
| CP-027 | C | `SecondRoot_CP027_MATO_BetweenFloors_v2_Approved.zip` | candidate_zip | 記録なし |
| CP-028 | C | `SecondRoot_CP028_Yumetuna_OneSheet_v1_Approved.zip` | candidate_zip | 記録なし |
| CP-029 | C | `SecondRoot_CP029_SNOWMY_SoftPop_v4_Approved.zip` | candidate_zip | 記録なし |
| CP-030 | C | `SecondRoot_CP030_Takada_ServiceCounter_v2_Approved.zip` | candidate_zip | 記録なし |
| CP-031 | C | `SecondRoot_CP031_ReformNakamura_Hybrid_v3.zip` | candidate_zip | 記録なし |
| CP-032 | C | `SecondRoot_CP032_Tamamushiya_IridescentLight_v1_Approved.zip` | candidate_zip | 記録なし |
| CP-001 | A | 元 PNG（記録に名前なし） | original_png | `99316fb40d71a0081bd5e9b892acf69d386a472722fb7d0bb1638ad0a2557d95` |
| CP-002 | A | 元 PNG（記録に名前なし） | original_png | `9376f4eb7e24cb881627956d331d9d5f97c405ac197f051128352d0db1b4814d` |
| CP-003 | A | `nagoya_beans_editorial_v4_source.zip` | source_zip | `7f2f14769d196311d22e629097371c67aa2dd1c2b205561b0178279cebe6ff9b` |
| CP-003 | A | PC PNG | pc_png | `c1e42ba20375f2b990f05c43086504fae23fdd9030359d9e9565dda87fa13d24` |
| CP-003 | A | SP PNG | sp_png | `f8050aaf2b629d805fa338cad0c46edc7d3df2c8a7111f918f645da451169a1b` |

- SR-002 の ZIP（`SecondRoot_SR002_Kintokiyu_approved_20261107.zip`）は ZIP 自体の SHA-256 が記録に無い。中の `金時湯_地下水の物語.png` が記録の値と一致すれば、**その PNG だけ**を原本として扱う（ZIP の中に SHA256SUMS があれば、すべて一致しなければならない。無ければ確かめようがない）。ZIP そのものと、記録の無いほかの中身は「未照合・原本ではない」として別に並べ、原本としては見せない。
- SR-002 と CP-033 の ZIP の名前は、develop の記録には無く、未マージの PR #237・#240 のブランチの記録にある（`originals-handover.json` の `name_source`）。SHA-256 は develop の `originals-index.json` にある。
- SR-001 は受け渡し不要（頁はリポジトリ、完成版のレンダーはこの機械の非公開の出力にある）。

## 4. 照合のしかた（道具）

```
# 置いたファイルを照合し、非公開の索引を作る（SR-001 の完成版も登録する）
npx tsx scripts/design-artifact/success-originals.ts verify --root ~/second-root-originals \
  --sr001-job ~/.local/share/second-root-design/image-autorun/job-bicycle-20261106201051-2bba09

# 全 37 件の閲覧ページを作る（空のフォルダか、まだ無いフォルダに）
npx tsx scripts/design-artifact/success-originals.ts viewer --root ~/second-root-originals \
  --out ~/second-root-originals/_viewer-$(date +%Y%m%d)
```

`<out>/index.html` をブラウザで開く。このページ自体はスクリプトも通信も使わず（CSP）、画像は横の `images/` に写してある。ブラウザによっては file: のページで画像（CSP の `img-src 'self'`）が出ないことがあるので、初回に画像が表示されるかを確かめる。「原本の頁を開く」は原本の HTML を別の頁として開くもので、その頁はこの制限の外にあり、スクリプトや外部への通信を含むことがある。

道具がすること（`lib/design-agent/case-study/success-originals.ts`）:

1. `<ID>/` の各ファイルの SHA-256 を計算し、その ID の**採用原本**の値（`originals-handover.json` の受け渡しの一覧）と比べる。`manifest.json` や `originals-index.json` にだけある値（閲覧用の WebP、下書き、比較の画像、リポジトリの写しなど）と一致したものは「記録にはあるが採用原本ではない」として表示し、原本には数えない（公開の WebP を写して置いても原本にはならない）。
2. ZIP は中身を読み、全ファイルの CRC-32 を確かめる。暗号化・ZIP64・リンク・`..` を含む名前は読まない。中に `SHA256SUMS` があれば、書かれたすべてのファイルが一致しなければならない（1 つでも違えば不合格）。
3. 判定:
   - **原本**: ファイルの SHA-256 が採用原本の値と一致。ZIP 自体が一致したときは中身もすべてその採用 ZIP の一部として見せる。ZIP 自体は記録に無く、中のファイルが一致したとき（SR-002 など）は、**一致した中のファイルだけ**が原本で、ほかの中身は「未照合・原本ではない」。照合できた ZIP は `_extracted/<ID>/<SHA の先頭 12 桁>/` に展開する（既にあれば、中身が同じときだけ使い回す。違えば止まる）。
   - **SHA-256 不一致**: 記録はあるが一致しない。原本として扱わず、展開もしない。
   - **未照合**: その ID に記録された SHA-256 が無い（区分 C）。原本として扱わない。
   - **疑似復元**: `pseudo/` に置いたもの。SHA-256 が何であっても原本にはしない。閲覧ページでは破線の枠と「原本ではない」の表示で分ける。
4. 結果を `_index/private-originals-index.json`（0600）に書く。SR-001 の連鎖の登録は、`--sr001-job` を付けないで実行しても消えない（前の索引の登録を、連鎖を確かめ直したうえで引き継ぐ。連鎖が崩れていれば止まる）。
5. 閲覧ページは作るたびに、各ファイルの SHA-256 を計算し直し、索引の判定も**今の記録**で確かめ直す（記録から消えた値は原本として見せない）。索引の形が違えば（知らない状態・欄の欠け・余分な欄）止まる。不一致のファイルがある成功例には「不一致のファイルあり」と出る。
6. メモリ: ZIP は 1 つずつ丸ごと読む（ZIP は 256 MiB まで、展開した中身の合計は 768 MiB まで、中の 1 ファイルは 64 MiB まで）。これより大きい ZIP は読まずに止まるので、分けて渡す。

道具は送信・生成・コミットをしない。置き場と出力先はリポジトリの外でなければ止まる。

## 5. 原本が見つかった後

- 段 1 の「原本で確認した成功例」に数えるのは、従来どおり `case-study-check.ts` の規則（`originals-index.json` と `manifest.json`）。この受け渡しの道具は数え方を広げない。
- 区分 C の原本が見つかり、SHA-256 を記録したいときは、オーナーの確認のうえで別の PR（記録の更新）にする。
