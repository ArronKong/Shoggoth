"use strict";

// Same-origin chat WebSocket broker.
//
// The browser React chat connects to /__chatws and speaks the plain gateway
// protocol (sessions.list / chat.history / chat.send + events) WITHOUT any
// device auth. For each browser connection the broker opens an upstream WS to
// the federating proxy and performs the device-auth v2 handshake on the
// browser's behalf (reusing the on-disk operator identity), then relays frames
// both ways. This keeps ed25519/pairing/crypto entirely server-side, so the
// browser client stays tiny — and it still gets the proxy's Hermes federation.

const { WebSocketServer, WebSocket } = require("ws");
const {
  CONNECT_TIMEOUT_MS,
  DEFAULT_ORIGIN,
  safeParse,
  loadOperatorAuth,
  buildConnectParams,
} = require("./device-auth");
const { sanitizeOpenClawHello } = require("./openclaw-2-contract");

const CHAT_WS_PATH = "/__chatws";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Is this upgrade allowed to ride the broker's on-disk operator identity?
 *
 * WebSocket handshakes are NOT subject to the same-origin policy: any page can
 * open `ws://127.0.0.1:<port>/__chatws`, and the browser dutifully sends OUR
 * Host — so the Host check below (a DNS-rebinding guard) can't tell our own
 * page apart from evil.com. Only `Origin` can, and it must therefore be our own
 * page's origin. Without this, a malicious page gets a fully authenticated
 * operator channel (chat.send drives agent tool calls, chat.history reads every
 * session) — cross-site WebSocket hijacking.
 *
 * A *missing* Origin means a native client (no browser sends a WS handshake
 * without one); those already have filesystem access to the same identity, so
 * they stay allowed. A literal "null" origin (sandboxed iframe, file://) is a
 * known bypass and is refused.
 *
 * @param {string|undefined} origin  the request's Origin header
 * @param {number|undefined} selfPort  the port this server is listening on
 */
function isAllowedBrowserOrigin(origin, selfPort) {
  if (origin === undefined) return true; // native client, not a browser
  if (!origin || origin === "null") return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return false;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return !selfPort || port === selfPort;
}

/**
 * Attach the chat broker to an http server.
 * @param {import('node:http').Server} httpServer
 * @param {{ getUpstreamUrl: () => string, getOrigin?: () => (string|undefined), authResolver?: object }} opts
 *   authResolver: device-auth createAuthResolver 实例(与管理面共享凭证);缺省回退旧的
 *   loadOperatorAuth(独立脚本/旧调用保持可跑)。
 */
function attachChatBroker(httpServer, { getUpstreamUrl, getOrigin, authResolver } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://127.0.0.1").pathname;
    } catch {
      pathname = req.url;
    }
    if (pathname !== CHAT_WS_PATH) return; // not ours — leave for any other handler
    // DNS-rebinding guard: loopback-only origin. A page rebound to 127.0.0.1
    // still sends its own Host, so a non-loopback Host isn't really us.
    const host = String(req.headers.host || "").trim().replace(/:\d+$/, "").toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    // Cross-site WebSocket hijacking guard: only OUR page may ride the on-disk
    // device auth. The Host check above cannot catch this (see the helper).
    const selfPort = httpServer.address()?.port;
    if (!isAllowedBrowserOrigin(req.headers.origin, selfPort)) {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => bridge(client));
  });

  function bridge(client) {
    // The proxy URL is not the credential namespace. Freeze both endpoints
    // before awaiting SecretRef resolution, and reject changed configuration.
    const url = (getUpstreamUrl?.() || "").trim();
    if (!url) {
      try {
        client.close(1011, "no upstream configured");
      } catch {
        /* ignore */
      }
      return;
    }
    const origin = getOrigin?.() || DEFAULT_ORIGIN;
    const gatewayUrl = authResolver?.getGatewayUrl?.();
    const endpointCurrent = () => url === (getUpstreamUrl?.() || "").trim()
      && (!authResolver?.getGatewayUrl || gatewayUrl === authResolver.getGatewayUrl());
    let upstream;
    let closed = false;
    let ready = false;
    const backlog = [];
    const toClient = (s) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(s);
        } catch {
          /* ignore */
        }
      }
    };
    const flush = () => {
      while (backlog.length && upstream?.readyState === WebSocket.OPEN) upstream.send(backlog.shift());
    };

    const timer = setTimeout(() => {
      if (!ready) {
        try {
          upstream?.close();
        } catch {
          /* ignore */
        }
        try {
          client.close(1011, "auth timeout");
        } catch {
          /* ignore */
        }
      }
    }, CONNECT_TIMEOUT_MS);
    async function connectGateway() {
      const auth = authResolver
        ? await (typeof authResolver.resolveConnectAuthAsync === "function"
          ? authResolver.resolveConnectAuthAsync(gatewayUrl) : authResolver.resolveConnectAuth(gatewayUrl))
        : loadOperatorAuth();
      if (closed || client.readyState !== WebSocket.OPEN) return;
      if (!endpointCurrent()) { client.close(1011, "gateway configuration changed"); return; }
      if (!auth) { client.close(1011, "no operator identity"); return; }
      upstream = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined);
    upstream.on("message", (data) => {
      if (closed || !endpointCurrent()) {
        try { client.close(1011, "gateway configuration changed"); } catch { /* ignore */ }
        try { upstream.terminate(); } catch { /* ignore */ }
        return;
      }
      const raw = data.toString();
      const frame = safeParse(raw);
      // Consume the device-auth handshake; relay everything else to the browser.
      if (frame && frame.type === "event" && frame.event === "connect.challenge") {
        try {
          upstream.send(
            JSON.stringify({
              type: "req",
              id: "broker-connect",
              method: "connect",
              params: buildConnectParams(auth, frame.payload?.nonce),
            }),
          );
        } catch {
          try {
            client.close(1011, "auth send failed");
          } catch {
            /* ignore */
          }
        }
        return;
      }
      if (frame && frame.type === "res" && frame.id === "broker-connect") {
        clearTimeout(timer);
        if (frame.ok) {
          let gatewayReady;
          if (frame.payload?.degraded === true) {
            // The federating proxy deliberately synthesizes this response while
            // OpenClaw is down so foreign backends remain usable. There is no
            // negotiated gateway contract to publish until its in-place retry
            // later completes a real hello.
            gatewayReady = { degraded: true };
          } else {
            try {
              gatewayReady = sanitizeOpenClawHello(frame.payload);
            } catch (err) {
              const reason = err?.code === "OPENCLAW_VERSION_UNSUPPORTED"
                ? "unsupported OpenClaw version"
                : "invalid gateway hello";
              try { client.close(1011, reason); } catch { /* ignore */ }
              try { upstream.close(); } catch { /* ignore */ }
              return;
            }
          }
          ready = true;
          // 网关随 hello-ok 签发/轮换设备令牌 → 持久化(与管理面共用一份存储)。
          const issued = frame.payload?.auth?.deviceToken;
          if (authResolver && typeof issued === "string" && issued) {
            try { authResolver.storeDeviceToken(issued, frame.payload?.auth?.issuedAtMs, gatewayUrl); } catch { /* 不影响中继 */ }
          }
          toClient(JSON.stringify({ type: "event", event: "gateway.ready", payload: gatewayReady }));
          flush();
        } else {
          try {
            client.close(1011, "auth rejected");
          } catch {
            /* ignore */
          }
          try {
            upstream.close();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      toClient(raw);
    });

    upstream.on("close", () => {
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        /* ignore */
      }
    });
    upstream.on("error", () => {
      clearTimeout(timer);
      try {
        client.close(1011, "upstream error");
      } catch {
        /* ignore */
      }
    });
    }
    client.on("message", (data) => {
      const raw = data.toString();
      if (ready && upstream?.readyState === WebSocket.OPEN) upstream.send(raw);
      else backlog.push(raw);
    });
    const releaseUpstream = () => {
      closed = true;
      clearTimeout(timer);
      backlog.length = 0;
      // Once the browser side is gone there is nobody left to complete a graceful
      // upstream close handshake. Terminate so server shutdown cannot retain it.
      try { upstream?.terminate(); } catch { /* already closed */ }
    };
    client.on("close", () => {
      releaseUpstream();
    });
    client.on("error", () => {
      releaseUpstream();
    });
    void connectGateway().catch(() => {
      clearTimeout(timer);
      if (!closed) { try { client.close(1011, "upstream connect failed"); } catch { /* ignore */ } }
    });
  }

  return wss;
}

module.exports = { attachChatBroker, CHAT_WS_PATH, isAllowedBrowserOrigin };
