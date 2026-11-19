# ほし窯 d2-hearth-floor v5 — カンプ A5 (研究専用、成功例ではない) (DEV-139 / Issue #290 P1)

2026-11-19。`../d2-hearth-floor-v4` (A4、d2-v2 の元) の次の候補。**A4 と `../../fidelity/d2-v2` は1バイトも変えていない** (追記のみ)。
C ページ `../../fidelity/d2-v3` の index.html・style.css・copy.json は**この版と同じバイト**。デザインの記録 (オーナーの評の各点に何をしたか) は
`../../fidelity/d2-v3/README.md` にある。

- **文章:** copy.json は A4 / d2-v2 と同じバイト (`ec9c1d6b…40f8`)。**新しい言葉は1つも足していない。** 文章の監査は v5 のファイルで round 0 から
  `approve_candidate` (`copy-review.json`)。
- **Claude の見比べ** (`review.json`): 1巡、`show_owner`、`comp-lane.ts --check-review --facts` 通過。PC 1440・768・SP 390 を d2-v2 と同じ描き方で並べて見た。
- **comp-lane** (JS 無効・通信遮断・dsf 1): 所見 0 件。描画 PC 1440×4757 `478525c1…6eec`、SP 390×4064 `d27dcce5…b210`
  (この容器の書体 Noto Serif CJK JP / Noto Sans CJK JP。書体で機械ごとにバイトが変わる)。
- 写真の板の HTML の3つ組は A4 と同じ文字・改行・字下げ (差し替えの spec がそのまま照らす)。
- **Fresh Review (`.ai/reviews/DEV-139-hoshigama-d2-v3.md`) の指摘を同じ版で直した:** M1 熱の輪が窯の奥との境で直線に切れていた (PC) → 横の消え方に縦の消え方を重ねた (`mask-composite: intersect`)。
  L1 粉の字が器の縁を越えていた → 字を 840 → 740 にして縁の内側へ。L2 窯の奥の写真の下が空いていた → バゲットを区画の中央に大きく (4.86vw) 置いた。
