import { IconChat, IconSearch, IconDoc, IconLayout, IconCheckCircle, IconRocket } from "./Decor";

const STEPS = [
  { n: "01", Icon: IconChat, t: "相談", d: "まずは、今困っていることをお聞きします。" },
  { n: "02", Icon: IconSearch, t: "ヒアリング", d: "お店の状況、お客様層、伝えたいことを整理します。" },
  { n: "03", Icon: IconDoc, t: "提案", d: "必要な機能と構成を、分かりやすくご提案します。" },
  { n: "04", Icon: IconLayout, t: "制作", d: "デザインと実装を進め、途中経過もご確認いただきます。" },
  { n: "05", Icon: IconCheckCircle, t: "確認", d: "公開前に、内容と動作を一緒に確認します。" },
  { n: "06", Icon: IconRocket, t: "公開", d: "ドメイン・サーバーの設定を行い、公開します。" },
];

export default function Process() {
  return (
    <section className="section section--warm" id="process" aria-labelledby="ps-h">
      <div className="container">
        <div className="sec-head sec-head--center">
          <p className="label-en">Process</p>
          <h2 className="h2" id="ps-h">
            制作の流れ
          </h2>
          <p className="h2-sub">ご相談から公開まで、6つのステップで丁寧に進めます。</p>
          <span className="rule-mark" />
        </div>

        <div className="ps-row">
          {STEPS.map(({ n, Icon, t, d }) => (
            <div className="ps-step" key={n}>
              <div className="ps-circle">
                <Icon />
              </div>
              <div>
                <p className="ps-no">{n}</p>
                <h3 className="ps-t">{t}</h3>
                <p className="ps-d">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
