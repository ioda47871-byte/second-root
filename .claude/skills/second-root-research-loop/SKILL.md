---
name: second-root-research-loop
description: Second Root のデザイン研究ループ。オーナーが Claude アプリで「改善して」「成功例として保存」「不採用」「次の店へ」「続きから」「研究の状況」と言ったとき、または新しいセッションでデザイン研究を再開するときに必ず使う。研究履歴（design-library/research-log/）を読み、レビュー画面を private artifact で出し、オーナーの判断・理由・画像の来歴を記録し、次の作業へ進める。画像生成や承認 ID の消費はしない（承認ルールに従う）。
---

# Second Root デザイン研究ループ

オーナーはデザインを見て判断することに集中する。Claude は記録・レビュー画面・次の準備を受け持つ。
オーナーに WSL のコマンドを打たせない。コマンドは Claude が `scripts/design-research/research.ts` で実行する。

## 0. いつも最初に

```
node --import tsx scripts/design-research/research.ts status
```

出力（現在の店・方向・段階・次の作業・オーナー待ち・履歴）を読んでから動く。`design-library/research-log/briefs/` に
今の brief があれば読む。店舗デザインの中身を考えるときは `second-root-design-director` スキルにも従う。

## 1. 言葉と動作

| オーナーの言葉 | Claude がすること |
|---|---|
| 「続きから」「研究の状況」・新しいセッション | `status` を読み、今の段階と次の1手を短く伝える。オーナー待ちがあればそれを先に出す |
| 新しい run が届いた（inbox に未記録の bundle） | `intake <bundle id> --shop … --direction … --iteration …`（改善版なら `--parent`）→ §2 のレビュー画面を出す |
| 「改善して」（＋理由） | `decide <entry> --decision revise --words "<原文>" --reason … --keep … --improve … --brief briefs/<shop>-<next>.md` → brief を書く／直す → 指示文と承認パケットの準備（§3） |
| 「成功例として保存」 | `decide <entry> --decision adopt --words "<原文>" --reason …`。CP-* 研究事例への登録は別作業（オーナーに聞く） |
| 「不採用」 | `decide <entry> --decision reject --words "<原文>" --reason …`。失敗の理由は次の方向案で避ける |
| 「次の店へ」 | `next-shop`（キューの先頭の架空店舗へ）。今の店が未判定なら、先にそれを一言確認する |

- `--words` はオーナーの言葉そのまま（短く）。`--reason` `--keep` `--improve` はオーナーの言葉と、オーナーが同意した所見から書く。
  オーナーが言っていない理由を判断として記録しない。
- 記録は追記のみ。判断を変えるときは新しい `decide`（seq が増え、最新が有効）。ファイルを手で書き換えない。
- 実店舗は記録しない（ログは架空店舗だけを受け付ける）。

## 2. レビュー画面（オーナーが Claude アプリで見る）

```
node --import tsx scripts/design-research/research.ts review-page <entry> --out <scratchpad>/review-<entry> [--notes <notes.json>]
```

- `notes.json` は `{"keep":[…],"weak":[…],"next":[…]}`。プレビューを Read で全部見て、監査（`~/sr-runs/review-inbox/audits/<id>/AUDIT.md`）と
  照らして Claude が書く。
- できたフォルダーを Artifact で publish する（`index.html` を file_path、`img/*.png` を `files`）。初回は新しい URL、同じ entry の
  更新は同じ file_path で。private のまま。リンクをオーナーに渡す。
- 画像をリポジトリや公開の場所に置かない。

## 3. 改善版の準備と承認の境界

改善版の生成までの順番（既存の承認ルールは変えない）:

1. brief（`briefs/<shop>-<dN>.md`）を書く。事実パックの外のことは書かない。
2. 指示文の変更（`lib/design-agent/image-first/prompt.ts` のピン、`IMAGEFIRST_ALLOWLIST`）を feature ブランチで PR にする。テスト・独立レビュー。
3. 新しい承認パケット（新しい承認 ID・plan ID・期限）を下書きする。**パケットの承認と merge はオーナーだけ**（OWNER MERGE ONLY）。
4. 生成はオーナーが承認した ID で1回だけ。届いたら §1 の intake から。

Claude がしないこと: 画像生成・Codex・worker・pilot・自動起動の実行、承認 ID の発行・消費、root / systemd、Staging / Production、課金、
破壊的な削除。必要になったらオーナーに頼む。
