/**
 * Ask the Instagram capture helper for one signed-in capture (DEV-028
 * Phase 3). Run as the worker / Claude user (sr-designgen), which cannot
 * read the browser profile: this only drops a request into the spool and
 * copies back the privacy-processed PNGs.
 *
 *   npm run -s sales:design-capture -- --request-id <id> --source-file ~/sr-design-input/<shop>/source.json [--out <dir>]
 *
 * Output: a code (and the copied files' directory). Never a URL, a username,
 * a cookie or page text.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { purgeOldCaptures } from "../../lib/design-agent/browser/profile";
import { requestCapture } from "../../lib/design-agent/capture-helper/client";
import { REQUEST_ID } from "../../lib/design-agent/capture-helper/spool";

const REPO = resolve(__dirname, "../..");
process.umask(0o077);
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const insideRepo = (p: string) => !relative(REPO, p).startsWith("..");
const say = (line: string) => process.stdout.write(`${line}\n`);
// (refuses while any process of the requester runs: the display is shared)
export const LOGIN_COMMAND = "sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh login";

async function main(): Promise<number> {
  const requestId = flag("request-id") ?? "";
  if (!REQUEST_ID.test(requestId)) {
    say("usage: --request-id <a-z 0-9 -, 3-63> --source-file <file.json with instagram_url> [--out <dir>]");
    return 2;
  }
  const sourceFile = flag("source-file");
  if (!sourceFile || insideRepo(expand(sourceFile))) {
    say("SOURCE_FILE_INVALID (a file outside the repository)");
    return 2;
  }
  let url: unknown;
  try {
    url = (JSON.parse(await readFile(expand(sourceFile), "utf8")) as { instagram_url?: unknown }).instagram_url;
  } catch {
    say("SOURCE_FILE_INVALID");
    return 2;
  }
  const root = expand("~/.local/share/second-root-design/helper-captures");
  const out = flag("out") ? expand(flag("out")!) : join(root, requestId);
  if (insideRepo(out)) {
    say("OUT_IN_REPO (keep captures outside the repository)");
    return 2;
  }
  await purgeOldCaptures(root);
  const result = await requestCapture({ requestId, url: typeof url === "string" ? url : "", destDir: out });
  say(result.reason ? `${result.code} (${result.reason})` : result.code);
  if (result.code === "CAPTURED") {
    say(`  ${result.files.length} image(s), ${result.softened} media area(s) softened → ${out}`);
    return 0;
  }
  if (result.code === "LOGIN_REQUIRED") {
    say("The capture session has expired or never existed. A PERSON signs in (never automated),");
    say("after stopping this user's processes (Claude, the worker):");
    say(`  ${LOGIN_COMMAND}`);
    return 5;
  }
  if (result.code === "INSTAGRAM_CHALLENGE" || result.code === "INSTAGRAM_CAPTCHA") return 6;
  return result.code === "CAPTURE_HELPER_UNAVAILABLE" ? 3 : 4;
}

main().then(
  (code) => process.exit(code),
  () => {
    say("CAPTURE_REQUEST_FAILED");
    process.exit(2);
  },
);
