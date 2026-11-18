# ほし窯 d2-hearth-floor v4 — カンプ (研究専用、成功例ではない) (DEV-139)

2026-11-17。`../d2-hearth-floor-v3` (A3) から `<wbr>` を外した版。A3 のディレクトリは変えずに残す (追記専用)。**今の候補はこの版。**

- **直したこと (1巡、`review.json` の `rounds`):** A3 は文の折り目を `<wbr>` で指定していて、サーバーの文章の検査が文字の断片を記録に無い文として読み、
  写真と文章の入った包み (v2) が作れなかった (検査は緩めない)。`<wbr>` を全部外し、折り返しを CSS の箱の幅 (`ic` 単位で N 字分、`word-break: keep-all`) で
  句の切れ目に合わせた。所在地は区と町の間に空白を入れた。行の組み方の違いは `review.json` の `remaining`。
- copy.json は A1〜A3 と同じバイト。文章の監査は v4 のファイルで round 0 から `approve_candidate` (`copy-review.json`)。
- Claude の見比べ (`review.json`) は v4 の描画 (PC 1440・1024・768・SP 390 を見た) で `show_owner`、`comp-lane.ts --check-review` 通過。
- 写真の板の HTML の3つ組は A1〜A3 と同じ。C ページ `../../fidelity/d2-v2` の index.html はこの版と同じバイト。
