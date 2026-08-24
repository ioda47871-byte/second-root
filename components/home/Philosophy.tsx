import { BlobGreen, BlobSand, LeafSpray, LeafBranch, Dots } from "./Decor";
import Jp from "./Jp";

/**
 * Brand breathing room, not a sales block — so this is the one section
 * where the organic shapes are allowed to dominate the composition.
 */
export default function Philosophy() {
  return (
    <section className="section ph" aria-labelledby="ph-h">
      <BlobGreen className="ph-blob" />
      <BlobSand className="ph-blob-sand" />
      <LeafSpray className="decor ph-leaf" />
      <LeafBranch className="decor ph-leaf-b" />
      <Dots className="decor ph-dots" cols={5} rows={4} />
      <span className="ph-circle" aria-hidden="true" />

      <div className="container">
        <div className="ph-in">
          <p className="label-en">Philosophy</p>
          <h2 className="ph-title" id="ph-h">
            すでにあるものが、
            <br />
            これからも続いていくために。
          </h2>
          <p className="ph-text">
            <Jp t="看板も、｜常連さんとの間柄も、｜積み重ねてきた時間も、｜もうそこにある。｜私たちが作るのは、｜真新しい何かでは｜ありません。｜すでにあるものが、｜これからも｜続いていくための、｜もう一つの根です。" />
          </p>
        </div>
      </div>
    </section>
  );
}
