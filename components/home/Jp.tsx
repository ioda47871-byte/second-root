/**
 * 日本語本文を「意味のまとまり」単位でしか折り返さないようにするヘルパー。
 *
 * body には word-break:auto-phrase / text-wrap:pretty / line-break:strict を
 * かけているが、auto-phrase は文節境界での改行を優先するだけで、
 * 「初めての/お客様」「外部/サービス」「当方の/ミス」のような、
 * 文法上は許されるが読むと引っかかる分断までは防げない。
 *
 * そこで本文を全角パイプ「｜」で意味のまとまりに区切り、各まとまりを
 * nowrap の inline span にする。ブラウザはまとまりの境界でしか改行できず、
 * 文字も語句も一切変えないまま、読みの単位で折り返せる。
 *
 * まとまりは MAX 文字以内に保つこと。超えたものは 360px で横にはみ出す
 * ため、保険として nowrap を外して通常の折り返しに戻す。
 */
const MAX = 14;

export default function Jp({ t }: { t: string }) {
  return (
    <>
      {t.split("｜").map((chunk, i) =>
        chunk.length > MAX ? (
          <span key={i}>{chunk}</span>
        ) : (
          <span className="nb" key={i}>
            {chunk}
          </span>
        )
      )}
    </>
  );
}
