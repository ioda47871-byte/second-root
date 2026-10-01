/**
 * The website capture's only way out (DEV-028 Phase 3, security review
 * round 3 H2): an HTTP proxy inside the worker process that Chromium is
 * forced to use for EVERYTHING the shop's page does: documents, sub
 * resources, fetch / XHR / WebSocket from the page AND from Web Workers and
 * Service Workers (which never pass through Playwright's request routing),
 * loopback included (bypass list `<-loopback>`).
 *
 * For each connection the proxy itself resolves the name, accepts it only
 * when EVERY address is public (isPrivateAddress) and the port is 80 / 443,
 * and connects to the address it checked. Chromium never resolves names of
 * its own, so a DNS answer that changes between check and use (rebinding)
 * cannot point the browser at 127.0.0.1, the LAN, the WSL host or a cloud
 * metadata service. WebRTC (UDP) and QUIC cannot use an HTTP proxy: the
 * website browser is started with WEBSITE_BROWSER_ARGS, which turn them off.
 */
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/** Returns the address to connect to, or null to refuse. */
export type EgressPolicy = (host: string, port: number) => Promise<string | null>;

/** Chromium flags for a browser whose traffic must all go through the proxy. */
export const WEBSITE_BROWSER_ARGS = ["--webrtc-ip-handling-policy=disable_non_proxied_udp", "--force-webrtc-ip-handling-policy", "--disable-quic"] as const;

const ALLOWED_PORTS = new Set([80, 443]);
const IDLE_MS = 60_000;
const MAX_SOCKETS = 64;

/** Production: ports 80 / 443, every address of the name public; the first one is used. */
export function publicEgress(isPrivateAddress: (address: string) => boolean): EgressPolicy {
  const cache = new Map<string, Promise<string | null>>();
  return (host, port) => {
    if (!ALLOWED_PORTS.has(port)) return Promise.resolve(null);
    const name = host.replace(/^\[|\]$/g, "").toLowerCase();
    let hit = cache.get(name);
    if (!hit) {
      hit = isIP(name)
        ? Promise.resolve(isPrivateAddress(name) ? null : name)
        : !/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/.test(name)
          ? Promise.resolve(null)
          : lookup(name, { all: true, verbatim: true }).then(
              (list) => (list.length > 0 && list.every((a) => !isPrivateAddress(a.address)) ? list[0]!.address : null),
              () => null,
            );
      cache.set(name, hit);
    }
    return hit;
  };
}

/** "host:port" / "[v6]:port" of a CONNECT line. */
function splitAuthority(raw: string): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]+):(\d{1,5})$/.exec(raw);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1]!, port } : null;
}

const HOP_HEADERS = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "upgrade", "te", "trailer", "transfer-encoding"]);

function forwardHeaders(headers: IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP_HEADERS.has(k)) out[k] = v;
  out.host = host;
  return out;
}

export interface EgressProxy {
  /** For Playwright: { server, bypass }. */
  proxy: { server: string; bypass: string };
  /** Connections the policy refused (counts only, never addresses). */
  refused(): number;
  close(): Promise<void>;
}

export async function startEgressProxy(policy: EgressPolicy): Promise<EgressProxy> {
  let refused = 0;
  const sockets = new Set<Duplex>();
  const track = (s: Duplex) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => s.destroy());
    if ("setTimeout" in s) (s as Socket).setTimeout(IDLE_MS, () => s.destroy());
  };
  const allowed = async (host: string, port: number) => {
    const address = await policy(host, port).catch(() => null);
    if (address === null) refused += 1;
    return address;
  };

  const server = createServer((req, res) => {
    // Plain http:// requests arrive with an absolute URL.
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        res.writeHead(400).end();
        return;
      }
      const port = url.port === "" ? 80 : Number(url.port);
      const address = url.protocol === "http:" && url.username === "" && url.password === "" ? await allowed(url.hostname, port) : null;
      if (address === null) {
        res.writeHead(403).end();
        return;
      }
      const upstream = httpRequest(
        { host: address, port, method: req.method, path: `${url.pathname}${url.search}`, headers: forwardHeaders(req.headers, url.host), setHost: false, timeout: IDLE_MS },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    })();
  });
  server.maxConnections = MAX_SOCKETS;
  server.on("connection", track);
  server.on("connect", (req, client: Duplex, head: Buffer) => {
    void (async () => {
      const target = splitAuthority(req.url ?? "");
      const address = target ? await allowed(target.host, target.port) : null;
      if (target === null || address === null) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = connect({ host: address, port: target.port });
      track(upstream);
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
    })();
  });
  // An Upgrade over a plain proxy request: never needed for a screenshot.
  server.on("upgrade", (_req, socket: Duplex) => {
    refused += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("egress proxy has no port");
  return {
    proxy: { server: `http://127.0.0.1:${address.port}`, bypass: "<-loopback>" },
    refused: () => refused,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
