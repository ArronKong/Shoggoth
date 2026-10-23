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
const { createEndpointGenerationGuard, endpointDigest } = require("./upstream-endpoint-generation");

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
    // The relay's Proxy transport and the Gateway credential namespace have
    // different lifetimes. A new Host must not tear down native chat observers.
    const transport = createEndpointGenerationGuard({ getUrl: () => getUpstreamUrl?.() || "" });
    const binding = transport.capture();
    if (!binding) { try { client.close(1011, "no upstream configured"); } catch {} return; }
    const origin = getOrigin?.() || DEFAULT_ORIGIN;
    const hasAuthNamespace = typeof authResolver?.getGatewayUrl === "function";
    const readNamespace = () => ({
      url: authResolver?.getGatewayUrl?.(),
      generation: authResolver?.getGatewayGeneration?.() ?? null,
    });
    const namespaceCurrent = (captured) => {
      try {
        const value = readNamespace();
        return value.url === captured.url && value.generation === captured.generation;
      } catch { return false; }
    };
    let initialNamespace;
    try { initialNamespace = readNamespace(); }
    catch { try { client.close(1011, "gateway configuration unavailable"); } catch {} return; }
    let upstream;
    let closed = false;
    let ready = false;
    let attempt = 0;
    let pendingHandshake = null;
    let initialAuthUsed = false;
    const backlog = [];
    const toClient = (s) => {
      if (client.readyState === WebSocket.OPEN) { try { client.send(s); } catch {} }
    };
    const rejectBacklog = () => {
      while (backlog.length) {
        const frame = safeParse(backlog.shift());
        if (frame?.type === "req") toClient(JSON.stringify({ type: "res", id: frame.id, ok: false, error: {
          code: "UPSTREAM_CHANGED", message: "后台连接已切换，消息未发送", admissionAccepted: false,
        } }));
      }
    };
    const transportCurrent = () => {
      if (!closed && transport.isCurrent(binding)) return true;
      rejectBacklog();
      try { client.close(1011, "gateway configuration changed"); } catch {}
      try { upstream?.terminate(); } catch {}
      return false;
    };
    const flush = () => {
      while (backlog.length && upstream?.readyState === WebSocket.OPEN) {
        if (!transportCurrent()) return;
        upstream.send(backlog.shift());
      }
    };
    const timer = setTimeout(() => {
      if (!ready) {
        try { upstream?.close(); } catch {}
        try { client.close(1011, "auth timeout"); } catch {}
      }
    }, CONNECT_TIMEOUT_MS);
    const resolveAuth = (namespace) => authResolver
      ? (typeof authResolver.resolveConnectAuthAsync === "function"
        ? authResolver.resolveConnectAuthAsync(namespace.url) : authResolver.resolveConnectAuth(namespace.url))
      : loadOperatorAuth();

    async function connectGateway() {
      // An explicitly unavailable managed namespace needs only the Proxy's local
      // degraded handshake. Never read the legacy identity as a fallback.
      const initialAuth = authResolver && initialNamespace.url === "" ? null : await resolveAuth(initialNamespace);
      if (closed || client.readyState !== WebSocket.OPEN) return;
      if (!transport.isCurrent(binding) || !namespaceCurrent(initialNamespace)) {
        client.close(1011, "gateway configuration changed"); return;
      }
      if (!initialAuth && initialNamespace.url !== "") { client.close(1011, "no operator identity"); return; }
      upstream = new WebSocket(binding.url, origin ? { headers: { Origin: origin } } : undefined);
      upstream.on("message", (data) => {
        if (!transportCurrent()) return;
        const raw = data.toString();
        const frame = safeParse(raw);
        if (frame?.type === "event" && frame.event === "connect.challenge") {
          let namespace;
          try { namespace = readNamespace(); } catch { return; }
          const degraded = frame.payload?.degraded === true;
          const sourceDigest = frame.payload?.gatewayBinding;
          const expectedDigest = endpointDigest(namespace.url, namespace.generation);
          // Our Proxy overwrites this digest from its live source binding. An old
          // challenge cannot cause new credentials to be signed for an old Host.
          if (!degraded && hasAuthNamespace && ((sourceDigest !== undefined && sourceDigest !== expectedDigest)
            || (sourceDigest === undefined && !namespaceCurrent(initialNamespace)))) return;
          const handshake = { id: attempt === 0 ? "broker-connect" : `broker-connect-${attempt}`,
            attempt: ++attempt, namespace, degraded, sourceDigest };
          pendingHandshake = handshake;
          if (degraded) {
            initialAuthUsed = true;
            // This is an App-local handshake only; no token, disk identity or
            // signature is needed for the already Origin-gated native relay.
            try { upstream.send(JSON.stringify({ type: "req", id: handshake.id, method: "connect", params: {} })); }
            catch { try { client.close(1011, "auth send failed"); } catch {} }
            return;
          }
          void (async () => {
            const auth = !initialAuthUsed && namespaceCurrent(initialNamespace)
              ? initialAuth : await resolveAuth(namespace);
            initialAuthUsed = true;
            if (pendingHandshake !== handshake || closed || !transportCurrent()
              || !namespaceCurrent(namespace)) return;
            if (!auth) { if (!ready) client.close(1011, "no operator identity"); return; }
            // Recheck immediately before writing the signed challenge.
            const params = buildConnectParams(auth, frame.payload?.nonce);
            if (!namespaceCurrent(namespace) || !transportCurrent()) return;
            upstream.send(JSON.stringify({ type: "req", id: handshake.id, method: "connect", params }));
          })().catch(() => {
            if (pendingHandshake === handshake && !ready && !closed) {
              try { client.close(1011, "auth send failed"); } catch {}
            }
          });
          return;
        }
        if (frame?.type === "res" && /^broker-connect(?:-[0-9]+)?$/.test(String(frame.id))) {
          const handshake = pendingHandshake;
          if (!handshake || frame.id !== handshake.id) return;
          if (!handshake.degraded && !namespaceCurrent(handshake.namespace)) return;
          pendingHandshake = null;
          if (frame.ok) {
            let gatewayReady;
            if (frame.payload?.degraded === true && handshake.degraded) gatewayReady = { degraded: true };
            else {
              try { gatewayReady = sanitizeOpenClawHello(frame.payload); }
              catch (err) {
                const reason = err?.code === "OPENCLAW_VERSION_UNSUPPORTED"
                  ? "unsupported OpenClaw version" : "invalid gateway hello";
                try { client.close(1011, reason); } catch {}
                try { upstream.close(); } catch {}
                return;
              }
            }
            clearTimeout(timer);
            ready = true;
            const issued = frame.payload?.auth?.deviceToken;
            if (!handshake.degraded && authResolver && typeof issued === "string" && issued
              && namespaceCurrent(handshake.namespace) && transport.isCurrent(binding)) {
              try {
                const args = [issued, frame.payload?.auth?.issuedAtMs];
                if (handshake.namespace.url !== undefined) args.push(handshake.namespace.url);
                authResolver.storeDeviceToken(...args);
              } catch {}
            }
            toClient(JSON.stringify({ type: "event", event: "gateway.ready", payload: gatewayReady }));
            flush();
          } else {
            try { client.close(1011, "auth rejected"); } catch {}
            try { upstream.close(); } catch {}
          }
          return;
        }
        toClient(raw);
      });
      upstream.on("close", () => { clearTimeout(timer); try { client.close(); } catch {} });
      upstream.on("error", () => { clearTimeout(timer); try { client.close(1011, "upstream error"); } catch {} });
    }
    client.on("message", (data) => {
      if (!transportCurrent()) return;
      const raw = data.toString();
      // The fixed transport is our Proxy, whose final Gateway-send boundary
      // independently checks the owner generation; native RPCs remain usable
      // while only the Gateway credential namespace is being replaced.
      if (ready && upstream?.readyState === WebSocket.OPEN) upstream.send(raw);
      else backlog.push(raw);
    });
    const releaseUpstream = () => {
      closed = true;
      attempt += 1;
      pendingHandshake = null;
      clearTimeout(timer);
      backlog.length = 0;
      try { upstream?.terminate(); } catch {}
    };
    client.on("close", releaseUpstream);
    client.on("error", releaseUpstream);
    void connectGateway().catch(() => {
      clearTimeout(timer);
      if (!closed) { try { client.close(1011, "upstream connect failed"); } catch {} }
    });
  }

  return wss;
}

module.exports = { attachChatBroker, CHAT_WS_PATH, isAllowedBrowserOrigin };
