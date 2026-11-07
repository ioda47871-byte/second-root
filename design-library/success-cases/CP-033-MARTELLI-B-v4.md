# CP-033｜MARTELLI — 型紙から立体へ（元研究ID SR-003）

**オーナーが採用した研究成功例31件目。** 既存CP30件の固定原本 `manifest.json` を変更せず、`approved-case-catalog.json` に31件目として登録する（`CP-033` と `SR-003` は**同一の研究事例**であり二重計上しない）。

## 正式採用の根拠と範囲

- 研究対象：名古屋の帽子ブランド MARTELLI（実在。店舗本人の依頼・公認は確認していない）
- 2026-11-08（日本時間）、オーナー発言「完成でいいと思います」に続き「既存成功例30件に追加して」と明示的に追加指示。
- 確定作品：**B案 v4 / Reference-informed**。HTML/CSS/JSと研究用AI素材を組み合わせた**ローカルWeb研究PoC**。PC1440/SP390の全ページ画像と操作用HTMLを含む。
- 承認していない事項：MARTELLI公式制作・商用/営業利用・Web公開・実店舗素材の使用許諾・生成器への自動投入・テンプレート転用・GitHub B方式の厳格適合。

## 完成原本

| ファイル | SHA-256 |
| --- | --- |
| `SecondRoot_CP033_MARTELLI_Approved_20261108.zip`（採用判断を追加した32ファイル） | `5f18b6672bbc60d7db18c2af7b123fd2db448a78b8272c5e085746f1634edd77` |
| `SecondRoot_SR003_MARTELLI_B_v4_ReferenceResearch_20261107.zip`（承認前の元ZIP、原本保全） | `5433b6c408359c8afc5673d11ec3afeeba336fae087076117a39dc477506a3c3` |
| `MARTELLI_preview.html`（オフラインで開ける単独HTML） | `2fdb9585e62bbc5c8206db9af1132468d400ec92fa2c6eb3e720845fbd6ca0ef` |
| `index.html`（編集用ソース） | `2809a20e28e81f7c0c2f1f9d1d352f013f4a88ccccf5da365f2e8c320750bd17` |
| `desktop_1440_full.png` | `36734ba7af5a28d74fddab67fcea28af0497e8d7b19ffd14ab03c373b9bb1dc9` |
| `mobile_390_full.png` | `aa8846058ef218fd4adcd48e3e2d540982e2674a6ee93b8e67a39513e1b8328d` |
| `PC_SP_overview.jpg` | `420fff401c8155d87645543163ec9a3a493d5ce0fa3a83dd0f61434dc34cdf5e` |

- 2つのZIPはいずれもChatGPTライブラリ `/セカンドルート/` に保管。**採用ZIPは元の全ファイルを変更せず、`OWNER_ADOPTION.json` と `ADOPTION_README.md` を追加した。**
- 元ZIPの`research-record.json`の `owner_status: unreviewed` は制作当時の状態。**今回のオーナー採用記録は `OWNER_ADOPTION.json` が優先**。履歴を上書きしない。
- 29件の元ファイルSHA256SUMSと、追加ZIP内31件のハッシュ整合をオフライン照合済み。
- GitHubには**メタデータとハッシュのみ**。PNG/HTML/ZIPバイナリのGitHub配置は未完了。Claudeはライブラリの採用ZIPを実際に取り込み、SHA照合とPC/SP目視を済ませてから分析する。

## なぜ成功例として保存するか：店舗の特徴を構造へ変える

- **中心原理**：型紙（平面）→木型（立体）→縫製（接点）→帽子/ヘッドピース（完成）を、ページ全体の変化として表現。
- **Hero**：着用写真1点と大きな文字組み。写真で商品カードを埋めるのではなく、顔・帽子のシルエットを画面の重心にする。
- **下層**：型紙は大きな切断線を含む編集面、木型は立体感、縫製は素材の接写、作品は**非対称ギャラリー**。写真帯や同形カードの繰り返しを禁止。
- **構造保持**：型紙の曲線は縫製の接線・区切り・読み順として利用。過去版で曲線が単なる装飾になり、汎用LPへ戻った失敗を記録。
- **実装性**：HTML/CSS/JSのページ内ナビ、SPメニュー、平面/立体の切替。PC/SPの文字と重なりを別設計。
- **外部参照で学んだこと**：Stephen Jones Millinery（造形的な撮影）、Maison Michel（役割別の情報設計）、Reinhard Plank（余白・絞った文章）、Nick Fouquet（工程を物語化）、KIJIMA TAKAYUKI（作品/記録の分離）、Lock & Co.（相談導線）。具体的な写真/構図/コピーは転用しない。

## 残す失敗と禁止事項

1. **CORE_LOST_IN_REFINEMENT**：整列した工程帯に変えたら、元の大胆な曲線が消えた。
2. **LOWER_SECTIONS_GENERIC / HERO_ONLY_WORLD**：Hero以外も構造を変形させる。写真・カードの帯は使わない。
3. **SURFACE_ONLY_CHANGE**：写真と色だけ変えて全体設計を変えたと報告しない。
4. **IMAGE_TYPE_RELATION_WEAK**：写真・型紙線・文字の間に明確な重なりと視線経路を保つ。
5. **RIGHTS / FACTS**：研究用AI写真はMARTELLIの実作品/工房ではない。コピー文は公式ブランドの発言ではない。イベントは過去催事として表記。予約/注文/価格/営業時間を創作しない。

## QAと限界

元ZIP内 `qa_results.json` に、Chromiumの1440 / 1024 / 768 / 390 / 320pxの結果を保存。各幅で横はみ出しなし、画像の破損なし、JS例外なし、アンカー移動・平面/立体切替・スマホメニューを確認（当該制作時のローカル実行記録であり、このコミットでの再実行ではない）。

Safari・Firefox・実機・Vercel本番検証は未実施。**画像・JavaScriptを使用したため、GitHubの厳格B方式（画像/JS禁止）のPASSではない**。研究完成の承認と技術方式の合格を混同しない。

## ソース

- https://www.spiral.co.jp/topics/cucuri
- https://www.instagram.com/martelli_malo/
- 採用ZIPに含まれる `research-notes.md` と `qa_results.json`。
