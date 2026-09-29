import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyGraphError, formatMetaCheck, GRAPH_HOST, readSecretFile, runMetaCheck } from "@/lib/design-agent/worker/meta";

// Business Discovery PoC (meta-check) against a local mock of the Graph API.
// Fictional ids, usernames and texts only.

const TOKEN = "EAAtesttokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const OUR_ID = "17841400000000001";
const SECRET_TEXT = "FICTIONAL-BIO-TEXT-9f2c";
const CAPTION = "FICTIONAL-CAPTION-51aa";

type Route = { status: number; body: unknown };
let server: Server;
let host = "";
const seen: Array<{ url: string; auth: string | undefined }> = [];
let routes: (url: URL) => Route;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    const r = routes(url);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  host = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => server.close());

const ok = (url: URL): Route => {
  const fields = url.searchParams.get("fields") ?? "";
  if (url.pathname.endsWith("/me")) return { status: 200, body: { id: "100000000000001" } };
  if (fields === "id") return { status: 200, body: { id: OUR_ID } };
  return {
    status: 200,
    body: {
      business_discovery: {
        username: "example_shop",
        biography: SECRET_TEXT,
        website: "https://example.com/",
        followers_count: 120,
        media_count: 40,
        id: "17841400000000002",
        media: {
          data: [
            { id: "1", media_type: "IMAGE", media_url: "https://cdn.example/1.jpg", caption: CAPTION, permalink: "https://www.instagram.com/p/x/", timestamp: "2026-09-01T00:00:00+0000" },
            { id: "2", media_type: "VIDEO", thumbnail_url: "https://cdn.example/2.jpg", timestamp: "2026-09-02T00:00:00+0000" },
          ],
        },
      },
      id: OUR_ID,
    },
  };
};
const errorAt = (stage: "me" | "caller" | "target", status: number, error: Record<string, unknown>) => (url: URL): Route => {
  const fields = url.searchParams.get("fields") ?? "";
  const which = url.pathname.endsWith("/me") ? "me" : fields === "id" ? "caller" : "target";
  return which === stage ? { status, body: { error: { message: `LEAK-MESSAGE ${SECRET_TEXT}`, ...error } } } : ok(url);
};

const check = (extra: Partial<Parameters<typeof runMetaCheck>[0]> = {}) => runMetaCheck({ token: TOKEN, igUserId: OUR_ID, username: "example_shop", graphHost: host, ...extra });

describe("meta-check (Business Discovery PoC)", () => {
  it("reports AUTH_OK, CALLER_OK and TARGET_FOUND with field names and counts only", async () => {
    routes = ok;
    seen.length = 0;
    const result = await check();
    expect(result.final).toBe("TARGET_FOUND");
    expect(result.steps.map((s) => s.code)).toEqual(["AUTH_OK", "CALLER_OK", "TARGET_FOUND"]);
    expect(result.target).toEqual({
      fields: ["biography", "followers_count", "media", "media_count", "username", "website"],
      media: 2,
      mediaFields: ["caption", "id", "media_type", "media_url", "permalink", "thumbnail_url", "timestamp"],
      mediaWithUrl: 1,
      mediaTypes: { IMAGE: 1, VIDEO: 1 },
    });
    const printed = formatMetaCheck(result).join("\n");
    for (const value of [SECRET_TEXT, CAPTION, "example_shop", "example.com", "cdn.example", TOKEN, OUR_ID]) expect(printed).not.toContain(value);
    // one Business Discovery request, metadata fields only, token only in the header
    const discovery = seen.find((s) => s.url.includes("business_discovery"))!;
    expect(decodeURIComponent(discovery.url)).toContain("business_discovery.username(example_shop){username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count,media.limit(12){id,media_type,media_url,thumbnail_url,caption,permalink,timestamp}}");
    for (const s of seen) {
      expect(s.auth).toBe(`Bearer ${TOKEN}`);
      expect(s.url).not.toContain(TOKEN);
      expect(s.url).toMatch(/^\/v26\.0\//);
    }
    expect(seen).toHaveLength(3);
  });

  it("adds appsecret_proof only when an app secret is given", async () => {
    routes = ok;
    seen.length = 0;
    await check({ appSecret: "appsecretFICTIONAL0123456789" });
    expect(seen.every((s) => /appsecret_proof=[0-9a-f]{64}/.test(s.url))).toBe(true);
    expect(seen.some((s) => s.url.includes("appsecretFICTIONAL"))).toBe(false);
  });

  it.each([
    ["an expired token", "me", 400, { code: 190, error_subcode: 463 }, "TOKEN_EXPIRED"],
    ["an invalid token", "me", 400, { code: 190 }, "TOKEN_INVALID"],
    ["a missing permission", "target", 403, { code: 10 }, "PERMISSION_ERROR"],
    ["a permission error (2xx code)", "caller", 400, { code: 200 }, "PERMISSION_ERROR"],
    ["an app rate limit", "target", 400, { code: 4 }, "RATE_LIMITED"],
    ["a page rate limit", "target", 400, { code: 32 }, "RATE_LIMITED"],
    ["an Instagram rate limit", "target", 400, { code: 80002 }, "RATE_LIMITED"],
    ["a Meta outage", "target", 500, { code: 2 }, "META_TRANSIENT_ERROR"],
    ["a transient error flag", "target", 400, { code: 9999, is_transient: true }, "META_TRANSIENT_ERROR"],
    ["a target that cannot be found", "target", 400, { code: 110, error_subcode: 2207013 }, "TARGET_UNSUPPORTED"],
    ["a wrong IG user id", "caller", 400, { code: 100 }, "CALLER_INVALID"],
  ] as const)("classifies %s", async (_label, stage, status, error, code) => {
    routes = errorAt(stage, status, error);
    const result = await check();
    expect(result.final).toBe(code);
    const printed = formatMetaCheck(result).join("\n");
    expect(printed).not.toContain("LEAK-MESSAGE");
    expect(printed).not.toContain(SECRET_TEXT);
  });

  it.each([
    ["an expired token", { error: { code: 190, error_subcode: 463 } }, "TOKEN_EXPIRED"],
    ["a rate limit", { error: { code: 4 } }, "RATE_LIMITED"],
    ["a transient error", { error: { code: 2 } }, "META_TRANSIENT_ERROR"],
    ["a body without business_discovery", { id: OUR_ID }, "META_UNKNOWN_ERROR"],
  ] as const)("classifies HTTP 200 with %s by its numbers, never as TARGET_UNSUPPORTED", async (_label, body, code) => {
    routes = (url) => ((url.searchParams.get("fields") ?? "").startsWith("business_discovery") ? { status: 200, body } : ok(url));
    expect((await check()).final).toBe(code);
  });

  it("does not take a non-JSON 200 page (for example a proxy page) as an unsupported target", async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes("business_discovery")
        ? new Response("<html>proxy</html>", { status: 200 })
        : new Response(JSON.stringify(String(input).includes("/me?") ? { id: "1" } : { id: OUR_ID }), { status: 200 })) as typeof fetch;
    expect((await check({ fetchImpl })).final).toBe("META_UNKNOWN_ERROR");
  });

  it("does not treat a token, permission or Meta failure as an unsupported target", () => {
    for (const code of [190, 10, 200, 4, 17, 32, 613, 1, 2]) {
      expect(classifyGraphError(400, { code, error_subcode: 2207013 }, "target").code).not.toBe("TARGET_UNSUPPORTED");
    }
  });

  it("reports a network failure as META_TRANSIENT_ERROR", async () => {
    const result = await runMetaCheck({ token: TOKEN, igUserId: OUR_ID, username: "example_shop", graphHost: "http://127.0.0.1:1" });
    expect(result.final).toBe("META_TRANSIENT_ERROR");
  });

  it("refuses bad input before any request", async () => {
    await expect(check({ username: "bad name" })).rejects.toThrow();
    await expect(check({ username: "a){id}" })).rejects.toThrow();
    await expect(check({ igUserId: "me" })).rejects.toThrow();
    await expect(check({ apiVersion: "latest" })).rejects.toThrow();
  });

  it("uses the fixed Graph host in production", () => {
    expect(GRAPH_HOST).toBe("https://graph.facebook.com");
    const entry = readFileSync(resolve(__dirname, "../../../scripts/sales-design-worker/worker.ts"), "utf8");
    expect(entry).not.toMatch(/graphHost|fetchImpl/);
  });
});

describe("meta token file", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "srdw-meta-"));
    chmodSync(d, 0o700);
    return d;
  };

  it("accepts only a private regular file with a token-shaped value", async () => {
    const d = dir();
    const f = join(d, "meta-token");
    writeFileSync(f, `${TOKEN}\n`, { mode: 0o600 });
    expect(await readSecretFile(f, "token")).toBe(TOKEN);
    chmodSync(f, 0o644);
    await expect(readSecretFile(f, "token")).rejects.toMatchObject({ code: "TOKEN_FILE_UNSAFE" });
    chmodSync(f, 0o600);
    await expect(readSecretFile(f, "token", 12345)).rejects.toMatchObject({ code: "TOKEN_FILE_UNSAFE" });
    const link = join(d, "link");
    symlinkSync(f, link);
    await expect(readSecretFile(link, "token")).rejects.toMatchObject({ code: "TOKEN_FILE_UNSAFE" });
    const sub = join(d, "sub");
    mkdirSync(sub);
    await expect(readSecretFile(sub, "token")).rejects.toMatchObject({ code: "TOKEN_FILE_UNSAFE" });
    writeFileSync(f, "not a token; rm -rf", { mode: 0o600 });
    await expect(readSecretFile(f, "token")).rejects.toMatchObject({ code: "TOKEN_FILE_INVALID" });
    await expect(readSecretFile(join(d, "missing"), "token")).rejects.toMatchObject({ code: "TOKEN_FILE_MISSING" });
  });

  it("the CLI stops on an unsafe token file or directory without printing the token", async () => {
    const run = promisify(execFile);
    const repo = resolve(__dirname, "../../..");
    const config = dir();
    const workerDir = join(config, "sr-design-worker");
    mkdirSync(workerDir, { mode: 0o700 });
    writeFileSync(join(workerDir, "meta-token"), TOKEN, { mode: 0o644 });
    const args = [join(repo, "scripts/sales-design-worker/worker.ts"), "meta-check", "--ig-user-id", OUR_ID, "--username", "example_shop"];
    const env = { ...process.env, XDG_CONFIG_HOME: config };
    const first = await run(join(repo, "node_modules/.bin/tsx"), args, { cwd: repo, env }).catch((e: { code: number; stdout: string }) => e);
    expect((first as { code: number }).code).toBe(2);
    expect((first as { stdout: string }).stdout).toContain("TOKEN_FILE_UNSAFE");
    expect((first as { stdout: string }).stdout).not.toContain(TOKEN);
    chmodSync(join(workerDir, "meta-token"), 0o600);
    chmodSync(workerDir, 0o755);
    const second = await run(join(repo, "node_modules/.bin/tsx"), args, { cwd: repo, env }).catch((e: { code: number; stdout: string }) => e);
    expect((second as { code: number }).code).toBe(2);
    expect((second as { stdout: string }).stdout).toContain("TOKEN_FILE_UNSAFE");
    // a token directory that is a link into the repository is refused
    chmodSync(workerDir, 0o700);
    const linkBase = dir();
    symlinkSync(join(repo, "docs"), join(linkBase, "into-repo"));
    const third = await run(join(repo, "node_modules/.bin/tsx"), [...args, "--token-file", join(linkBase, "into-repo", "meta-token")], { cwd: repo, env }).catch((e: { code: number; stderr: string }) => e);
    expect((third as { code: number }).code).toBe(2);
    expect((third as { stderr: string }).stderr).toContain("outside the repository");
  });
});
