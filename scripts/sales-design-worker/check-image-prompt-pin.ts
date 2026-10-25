/**
 * DEV-110: read-only, model-free check run AFTER checkout, UNDER run.lock.
 * Never prints the full prompt or shop facts.
 */
import { createHash } from "node:crypto";
import { buildMockupPrompt, loadPocInputs, parseDirectionVersion } from "../../lib/design-agent/design-image/prompt";

export function isPinnedPrompt(prompt: string, expectedSha: string, expectedChars: number): boolean {
  return (
    prompt.length === expectedChars &&
    createHash("sha256").update(prompt, "utf8").digest("hex") === expectedSha
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw new Error("PIN_ARGUMENTS_INVALID");
  const [direction, sha, chars] = args;
  if (!direction || !sha || !/^[a-f0-9]{64}$/.test(sha) || !chars || !/^[1-9][0-9]{0,5}$/.test(chars)) {
    throw new Error("PIN_ARGUMENTS_INVALID");
  }
  const version = parseDirectionVersion(direction);
  const prompt = buildMockupPrompt(await loadPocInputs(".", version));
  if (!isPinnedPrompt(prompt, sha, Number(chars))) throw new Error("PIN_MISMATCH");
  console.log("POC_PIN_OK direction=" + version + " sha256=" + sha + " chars=" + prompt.length);
}

if (process.argv[1]?.endsWith("check-image-prompt-pin.ts")) {
  main().catch((e: unknown) => {
    // No prompt or potentially sensitive runtime error printed.
    const reason = e instanceof Error && e.message === "PIN_MISMATCH" ? "PIN_MISMATCH" : "PIN_CHECK_FAILED";
    console.error("STOP: " + reason + "; no Codex call was started.");
    process.exitCode = 23;
  });
}
