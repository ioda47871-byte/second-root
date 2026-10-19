import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoveredStub } from "@/lib/sales/ingest-schema";

// DEV-054: the Operational Claude run prompt is Instagram-first and skips
// known shops, while every earlier rule stays in place.

const file = readFileSync(join(process.cwd(), "ops", "sales-agent", "RUN_PROMPT.md"), "utf8");
const prompt = file.slice(file.indexOf("---- prompt ここから ----"), file.indexOf("---- prompt ここまで ----"));
const section = (heading: string, next: string) => prompt.slice(prompt.indexOf(heading), prompt.indexOf(next));
const discover = section("## 3. discover", "## 4. verify");

describe("RUN_PROMPT discover (DEV-054)", () => {
  it("has the prompt markers", () => {
    expect(prompt.length).toBeGreaterThan(1000);
    expect(discover.length).toBeGreaterThan(500);
  });

  it("centres discovery on Instagram shops without an official site", () => {
    expect(discover).toContain("公式サイトを持たず、Instagram で発信している名古屋市内");
    expect(discover).toContain("site:instagram.com");
    expect(prompt).toContain("探す中心は**公式サイトがなく Instagram で発信している店舗**");
  });

  it("never logs in, never uses Instagram APIs or paid tools, never guesses", () => {
    expect(discover).toContain("**Instagram にログインしない。**");
    expect(discover).toContain("Instagram の API・非公開の取得手段・有料ツールは使わない");
    expect(prompt).toContain("ログインが必要なページの閲覧");
    expect(prompt).toContain("メールアドレスを**推測しない**");
  });

  it("keeps the website check rule: discovery never counts as not_found", () => {
    expect(discover).toContain("`website.status = \"not_found\"` の根拠にしない");
    expect(prompt).toContain("**2 回以上の独立した検索**");
    expect(prompt).toContain("**検索失敗を not_found にしない。**");
  });

  it("keeps the source, address and limit rules", () => {
    expect(discover).toContain("**住所が載っているページで**確認してから stub にする");
    expect(discover).toContain("「店舗の存在を知る」ためにだけ使う");
    expect(discover).toContain("≤20 件");
    expect(prompt).toContain("`verified` ≤ 10 件");
    expect(prompt).toContain("**あなたは営業メッセージを送りません。**");
    expect(prompt).toContain("fail-closed");
  });

  it("skips known keys and forbids getting around the mark", () => {
    expect(discover).toContain("`run.knownKeys`");
    expect(discover).toContain("**verify しない・verified に入れない**");
    expect(discover).toContain("理由を推測したり調べたりしない");
    expect(discover).toContain("別の key・別の表記・URL を外した stub・別の形の URL");
    expect(discover).toContain("**同じ session の中で 1 回だけ**");
    expect(prompt).toContain("`known` でないものだけ");
  });

  it("shows a stub example the schema accepts (no fields Op Claude may not send)", () => {
    const json = discover.slice(discover.indexOf("```json") + 7, discover.indexOf("```", discover.indexOf("```json") + 7));
    const body = JSON.parse(json.replace(/"https:\/\/…（見つかった場合のみ。なければ null）"/, "null").replace(/"https:\/\/www\.instagram\.com\/<handle>\/（なければ null）"/, '"https://www.instagram.com/test_pan/"'));
    for (const stub of body.candidates) expect(discoveredStub.safeParse(stub).success).toBe(true);
    expect(discoveredStub.safeParse({ ...body.candidates[0], known: true }).success).toBe(false);
  });
});
