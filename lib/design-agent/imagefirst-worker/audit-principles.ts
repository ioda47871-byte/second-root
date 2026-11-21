/**
 * Issue #302 (owner comment 7053442141): the quality PRINCIPLES of approved success examples, and the recorded failure causes,
 * that the IMAGE_FIRST Claude CLI audit (audit-rubric.ts) hands the model as text. Data only: no import, no file, no process.
 *
 * What this is for. The audit's `success_principles_applied` check asks whether THIS shop's own composition applies these
 * principles. It never asks how close the page looks to an example: an example is evidence of a principle, not a target,
 * and copying an example's (or any other shop's) design, colours or layout is penalised.
 *
 * Which examples, and why. Only registered success examples whose source files are in the repository and readable, with
 * differing structures, and only the strongest evidence level the repository has for a picture:
 *   - CP-001 Mond (a mosaic of panels whose sizes change every row, a huge shop name crossing the photo edge) and CP-002
 *     Sissi (a branch line crossing the name diagonally, curved / trapezoid photo frames, staggered numbered sections):
 *     registered WebP previews that Claude viewed (VISUAL_VERIFIED in the visual-read matrix); the `learn` / `do_not_copy`
 *     lines are copied verbatim from those viewing records. Both are single concept pictures (no phone page).
 *   - CP-003 なごやビーンズ v4 PC / SP (a process map plus a ground colour that changes with the process; the phone page
 *     recomposed): the owner-approved generation references, `learn` / `do_not_copy` copied verbatim.
 *   - Failure causes: three observed patterns of the success-principles synthesis whose evidence is a rejected draft of an
 *     adopted case (CP-016's first draft looked like the earlier success examples' skeleton and was rejected; CP-023 v5 and
 *     CP-011 v1 were rejected for generic lower sections). Copied verbatim; each record states the rejection.
 * Not used: cases with no picture in the repository as principle evidence, the draft CP-026〜032 records, and the
 * provisional structure vocabulary (gated).
 *
 * The `structure` line of each example is written here (not copied, not pinned): it only tells the model that the examples'
 * structures differ, so that no single look is the target.
 *
 * Provenance: every entry names the example id, the case record and the file + field its text is copied from. A test
 * (claude-audit-rubric.test.ts) pins every text against that file and checks that the record exists, so the text cannot
 * drift from its source. The paths are provenance only: nothing in the audit opens them.
 */

export type PrincipleProvenance = {
  /** The registered success example (the case id). */
  example_id: string;
  /** The case record in the success-example catalogue. */
  record: string;
  /** The file the text is copied from, verbatim. */
  source: string;
  /** Where in `source`. */
  field: string;
  /** The SHA-256 of the registered picture the text was learned from. */
  asset_sha256: string;
};

export type SuccessPrinciples = {
  id: string;
  /** Which audit viewports get this example's principles. */
  viewports: readonly ("desktop_1440" | "mobile_390")[];
  /** One line on the example's own structure, so the model can see the examples differ (not a target). */
  structure: string;
  principles: readonly string[];
  do_not_copy: readonly string[];
  provenance: PrincipleProvenance;
};

const BOTH = ["desktop_1440", "mobile_390"] as const;

export const SUCCESS_PRINCIPLES: readonly SuccessPrinciples[] = [
  {
    id: "CP-001-concept",
    viewports: BOTH,
    structure: "1枚のコンセプト画像。写真と文の板の大きさが毎段変わる不規則なモザイク (喫茶)",
    principles: [
      "店名を巨大な文字にして写真との境をまたがせ、文字と写真を一つの面にする",
      "店の物を独立した章にし、写真の中で別の段に繰り返し出す",
      "板の大きさと地の明暗を毎段変え、同じ帯を並べない",
      "小さな番号と横線のラベルで、自由な配置にも読み順を与える",
    ],
    do_not_copy: ["Mond の店名・ロゴ・文・写真", "青い花柄カップのモチーフそのもの", "同じ板の割り付け (位置と比率)"],
    provenance: {
      example_id: "CP-001",
      record: "design-library/success-cases/CP-001-Mond.md",
      source: "design-library/research/quality-pipeline/visual-reads/CP-001/concept.read.json",
      field: "observation.learn / observation.do_not_copy",
      asset_sha256: "ac8307aaa974aa0b3aabf9b91e9b525533c8119b929bc4e806ff5f56865b6c82",
    },
  },
  {
    id: "CP-002-concept",
    viewports: BOTH,
    structure: "1枚のコンセプト画像。枝の線が画面を斜めに横切り、曲線・台形に切った写真と千鳥の区画 (花)",
    principles: [
      "店の素材の形 (枝の弧) を、写真の枠の形と画面の区切りに使う",
      "素材の色を見本として画面の要素に出し、配色の根拠を見せる",
      "番号つきの区画を千鳥に置き、作り方の順を読み順にする",
    ],
    do_not_copy: ["Sissi の店名・文・写真", "花のアーチと台形の位置と比率", "色見本の丸の配置そのもの"],
    provenance: {
      example_id: "CP-002",
      record: "design-library/success-cases/CP-002-Sissi.md",
      source: "design-library/research/quality-pipeline/visual-reads/CP-002/concept.read.json",
      field: "observation.learn / observation.do_not_copy",
      asset_sha256: "07024daaa642e2ea3e28b856119f119a89e352f580c0e14dfbad62e497ea40ef",
    },
  },
  {
    id: "CP-003-pc",
    viewports: ["desktop_1440"],
    structure: "PC の全頁の HTML 試作。工程の段階を地図にし、区画の地の色が工程に合わせて変わる (焙煎)",
    principles: [
      "Photograph, very large type and empty space overlap across section boundaries; the story sections each take a different visual rhythm instead of a stack of equal product cards; the finish holds from the first screen to the footer.",
    ],
    do_not_copy: ["its diagonal roast-stage map", "its coffee photographs and its section words", "its colours, typefaces and grid", "the shop name and brand of なごやビーンズ"],
    provenance: {
      example_id: "CP-003",
      record: "design-library/success-cases/CP-003-NagoyaBeans-v4.md",
      source: "design-library/phase2f/references/success-references-v1.json",
      field: "refs[id=CP-003-pc].learn / .do_not_copy",
      asset_sha256: "be8f9aaeb06f02d192a08ceaab640eb1121befe14daa59eaee2e4d59e3ee52b6",
    },
  },
  {
    id: "CP-003-sp",
    viewports: ["mobile_390"],
    structure: "SP の全頁の HTML 試作。PC の地図を狭い画面のために組み直した頁 (焙煎)",
    principles: ["The phone page is composed again for a narrow screen (its own order, scale and overlaps), not the desktop shrunk; large type and images still cross section edges."],
    do_not_copy: ["its diagonal roast-stage map", "its coffee photographs and its section words", "its colours, typefaces and grid", "the shop name and brand of なごやビーンズ"],
    provenance: {
      example_id: "CP-003",
      record: "design-library/success-cases/CP-003-NagoyaBeans-v4.md",
      source: "design-library/phase2f/references/success-references-v1.json",
      field: "refs[id=CP-003-sp].learn / .do_not_copy",
      asset_sha256: "45d54a7e3cf774c61c66ddb498e326b07a8bdc8f182e64c38a83a101e12aa7a0",
    },
  },
];

export type FailureCause = {
  pattern: string;
  evidence: string;
  provenance: { example_id: string; record: string; source: string; field: string };
};

/** Recorded failure causes (a rejected draft of an adopted case each). Text only, verbatim. */
export const FAILURE_CAUSES: readonly FailureCause[] = [
  {
    pattern: "直前の案や参照に似すぎる",
    evidence: "CP-016 初稿 (「同じような構成になってきた」)",
    provenance: { example_id: "CP-016", record: "design-library/success-cases/CP-016-Zulu-COUNTERWEIGHT-ZK01.md", source: "design-library/research/quality-pipeline/principles-v1.json", field: "failure_codes[].pattern / .evidence" },
  },
  {
    pattern: "下層が帯・カード・左右交互の繰り返し",
    evidence: "CP-023 v5",
    provenance: { example_id: "CP-023", record: "design-library/success-cases/CP-023-BURGERS-INC-NEON-FLIP-v4.md", source: "design-library/research/quality-pipeline/principles-v1.json", field: "failure_codes[].pattern / .evidence" },
  },
  {
    pattern: "Hero だけ強く下層は別の世界",
    evidence: "CP-011 v1",
    provenance: { example_id: "CP-011", record: "design-library/success-cases/CP-011-BAR-N-GLASS-SILENCE.md", source: "design-library/research/quality-pipeline/principles-v1.json", field: "failure_codes[].pattern / .evidence" },
  },
];
