import { BlobGreen, LeafSpray, Dots } from "./Decor";

export default function Philosophy() {
  return (
    <section className="section ph" aria-labelledby="ph-h">
      <BlobGreen className="ph-blob" />
      <LeafSpray className="decor ph-leaf" />
      <Dots className="decor ph-dots" cols={5} rows={4} />

      <div className="container">
        <div className="ph-in">
          <p className="label-en">Philosophy</p>
          <h2 className="ph-title" id="ph-h">
            すでにあるものが、
            <br />
            これからも続いていくために。
          </h2>
          <p className="ph-text">
            看板も、常連さんとの間柄も、積み重ねてきた時間も、もうそこにある。私たちが作るのは、真新しい何かではありません。すでにあるものが、これからも続いていくための、もう一つの根です。
          </p>
        </div>
      </div>
    </section>
  );
}
