import {
  IconChat,
  IconSearch,
  IconDoc,
  IconLayout,
  IconCheckCircle,
  IconRocket,
  LeafSpray,
  LeafBranch,
  Dots,
} from "./Decor";
import Jp from "./Jp";

const STEPS = [
  {
    n: "01",
    Icon: IconChat,
    t: "相談",
    d: "まずは、｜今困っていることを｜お聞きします。｜無料診断も｜この段階です。",
  },
  {
    n: "02",
    Icon: IconSearch,
    t: "ヒアリング",
    d: "お店の状況、｜お客様層、｜伝えたいことを｜整理します。",
  },
  {
    n: "03",
    Icon: IconDoc,
    t: "提案・契約",
    // 旧「お見積り・契約書のうえ着手金50%」は日本語として係り受けが崩れるため、
    // 意味(見積り→契約→着手金50%)を変えずに言い回しだけ整えた。
    d: "構成と機能を｜ご提案します。｜お見積り・ご契約のうえ、｜着手金50%を｜ご入金いただきます。",
  },
  {
    n: "04",
    Icon: IconLayout,
    t: "制作",
    d: "デザインと実装を進め、｜途中経過も｜ご確認いただきます。",
  },
  {
    n: "05",
    Icon: IconCheckCircle,
    t: "確認",
    d: "テスト環境で｜内容と動作を確認し、｜修正のうえ｜公開の承認を｜いただきます。",
  },
  {
    n: "06",
    Icon: IconRocket,
    t: "公開",
    d: "残金のご入金を｜確認後に公開し、｜アカウントと完成データを｜お渡しします。",
  },
];

export default function Process() {
  return (
    <section className="section section--warm" id="process" aria-labelledby="ps-h">
      <LeafSpray className="decor ps-leaf-a" />
      <LeafBranch className="decor ps-leaf-b" />
      <Dots className="decor ps-dots" cols={5} rows={4} />

      <div className="container">
        <div className="sec-head sec-head--center sec-body">
          <p className="label-en">Process</p>
          <h2 className="h2" id="ps-h">
            制作の流れ
          </h2>
          <p className="h2-sub">
            <Jp t="ご相談から公開まで、｜6つのステップで｜丁寧に進めます。" />
          </p>
          <span className="rule-mark" />
        </div>

        {/* PCは3×2。横6列に押し込むより一工程を大きく見せることを優先する。 */}
        <div className="ps-row sec-body">
          {STEPS.map(({ n, Icon, t, d }) => (
            <div className="ps-step" key={n}>
              <div className="ps-circle">
                <Icon />
              </div>
              <div>
                <p className="ps-no">{n}</p>
                <h3 className="ps-t">{t}</h3>
                <p className="ps-d">
                  <Jp t={d} />
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
