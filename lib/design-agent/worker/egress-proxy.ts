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
 * metadata service. It dials directly: the worker's own HTTPS_PROXY is not
 * used (an upstream proxy would resolve names itself), so a network where only
 * an upstream proxy reaches the internet has no website source. WebRTC (UDP) and QUIC cannot use an HTTP proxy: the
 * website browser is started with WEBSITE_BROWSER_ARGS, which turn them off.
 */
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/** Returns the checked addresses to connect to (tried in order), or null to refuse. */
export type EgressPolicy = (host: string, port: number) => Promise<string[] | null>;

/** Chromium flags for a browser whose traffic must all go through the proxy. */
export const WEBSITE_BROWSER_ARGS = ["--webrtc-ip-handling-policy=disable_non_proxied_udp", "--force-webrtc-ip-handling-policy", "--disable-quic"] as const;

const ALLOWED_PORTS = new Set([80, 443]);
const IDLE_MS = 60_000;
// Chromium opens a tunnel per host (plus HTTP/1 sockets): shop pages with many CDN / analytics hosts need room.
const MAX_SOCKETS = 256;

/** Production: ports 80 / 443, every address of the name public; the first one is used. */
export function publicEgress(isPrivateAddress: (address: string) => boolean): EgressPolicy {
  const cache = new Map<string, Promise<string[] | null>>();
  return (host, port) => {
    if (!ALLOWED_PORTS.has(port)) return Promise.resolve(null);
    const name = host.replace(/^\[|\]$/g, "").toLowerCase();
    let hit = cache.get(name);
    if (!hit) {
      hit = isIP(name)
        ? Promise.resolve(isPrivateAddress(name) ? null : [name])
        : !/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/.test(name)
          ? Promise.resolve(null)
          : lookup(name, { all: true }).then(
              (list) => (list.length > 0 && list.every((a) => !isPrivateAddress(a.address)) ? list.map((a) => a.address) : null),
              () => {
                cache.delete(name); // a passing DNS failure is asked again next time
                return null;
              },
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

function endToEnd(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP_HEADERS.has(k)) out[k] = v;
  return out;
}

/** Connects to the first of the checked addresses that answers. */
function dial(addresses: readonly string[], port: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const next = (i: number) => {
      if (i >= addresses.length) return resolve(null);
      const socket = connect({ host: addresses[i]!, port, timeout: 15_000 });
      const fail = () => {
        socket.destroy();
        next(i + 1);
      };
      socket.once("error", fail);
      socket.once("timeout", fail);
      socket.once("connect", () => {
        socket.removeListener("error", fail);
        socket.removeListener("timeout", fail);
        socket.setTimeout(0);
        resolve(socket);
      });
    };
    next(0);
  });
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
    const addresses = await policy(host, port).catch(() => null);
    if (addresses === null || addresses.length === 0) {
      refused += 1;
      return null;
    }
    return addresses;
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
      const addresses = url.protocol === "http:" && url.username === "" && url.password === "" ? await allowed(url.hostname, port) : null;
      if (addresses === null) {
        res.writeHead(403).end();
        return;
      }
      const socket = await dial(addresses, port);
      if (socket === null) {
        res.writeHead(502).end();
        return;
      }
      track(socket);
      const upstream = httpRequest(
        { createConnection: () => socket, method: req.method, path: `${url.pathname}${url.search}`, headers: { ...endToEnd(req.headers), host: url.host, connection: "close" }, setHost: false, timeout: IDLE_MS },
        (up) => {
          res.writeHead(up.statusCode ?? 502, endToEnd(up.headers));
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
      const addresses = target ? await allowed(target.host, target.port) : null;
      if (target === null || addresses === null) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = await dial(addresses, target.port);
      if (upstream === null || client.destroyed) {
        upstream?.destroy();
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        return;
      }
      track(upstream);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
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
