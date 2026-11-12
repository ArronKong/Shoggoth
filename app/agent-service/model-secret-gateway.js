"use strict";

// Destinations and payload were explicitly authorized by the user for this
// integration: protected content, or the original request if local masking fails,
// plus that request's existing auth headers, to the original endpoints below.
// This component never reads
// credential files, chooses an endpoint from a request, or follows redirects.
const http = require("node:http");
const { createModelSecretTransport } = require("./model-secret-transport");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const { serviceError } = require("./security");
const { processOrOriginal } = require("../core/chat-secret-fallback");
const TARGETS = Object.freeze({
  chatgpt: "https://chatgpt.com/backend-api/codex/",
  "openai-api-key": "https://api.openai.com/v1/",
  "grok-cli": "https://cli-chat-proxy.grok.com/v1/",
  "grok-api-key": "https://api.x.ai/v1/",
});
const HEADERS = new Set(["authorization", "chatgpt-account-id", "openai-organization", "openai-project",
  "openai-beta", "accept", "user-agent", "originator", "version", "session_id",
  "x-codex-beta-features", "x-openai-client-user-agent", "x-client-request-id"]);
const GROK_HEADERS = new Set(["authorization", "accept", "user-agent", "x-grok-client-mode", "x-xai-token-auth",
  "x-authenticateresponse", "x-grok-client-version", "x-grok-client-identifier", "x-grok-conv-group-id", "x-grok-conv-id",
  "x-grok-req-id", "x-grok-model-override", "x-grok-session-id", "x-grok-agent-id", "x-grok-turn-idx", "traceparent",
  "x-compactions-remaining", "x-compaction-at", "x-grok-doom-loop-check", "x-grok-exact-repetition-check"]);
const MAX_BODY = 64 * 1024 * 1024;
const RESPONSE_PRELUDE = new Set(["response.created", "response.in_progress", "response.queued"]);
const RESPONSE_TERMINAL = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);
const PROJECTION_UNAVAILABLE = "SECRET_MODEL_PROJECTION_UNAVAILABLE";
const fail = code => { throw serviceError(code, "模型请求的本地凭据处理未完成，内容未发送"); };

function writeError(res, status, code, message) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: { code, message } }));
}

class ModelSecretGateway {
  constructor({ projection, provenance = null, disclosures = null, request, env = process.env,
    onDiagnostic = () => {} }) {
    this.projection = projection; this.provenance = provenance; this.request = request;
    this.env = env; this.transport = null;
    this.disclosures = disclosures; this.onDiagnostic = onDiagnostic;
    this.routes = new Map(); this.inflight = new Set(); this.closed = false;
    this.server = null; this.starting = null;
  }
  reset() {
    if (this.server?.listening || this.inflight.size || this.transport) fail("SECRET_MODEL_GATEWAY_BUSY");
    this.closed = false; this.starting = null; this.server = null;
  }
  async open() {
    if (this.closed) fail("SECRET_MODEL_GATEWAY_CLOSED");
    if (!this.starting) this.starting = new Promise((resolve, reject) => {
      this.server = http.createServer({ maxHeaderSize: 32 * 1024 }, (req, res) => {
        void this.handle(req, res).catch(error => {
          if (res.destroyed || res.writableEnded) return;
          if (res.headersSent) { res.destroy(); return; }
          // Projection clients keep their local RPC failure status. A model
          // client's 5xx retry budget is reserved for upstream failures.
          const route = this.routes.get(req.url?.split("/", 2)[1]);
          const localProjection = route?.target === null || /\/(?:project|ready)$/u.test(req.url || "");
          const decided = ["SECRET_DISCLOSURE_CANCELED", "SECRET_DISCLOSURE_EXPIRED"].includes(error?.code);
          writeError(res, localProjection && !decided ? 503 : 400, decided ? error.code : PROJECTION_UNAVAILABLE,
            decided ? "This model request was canceled or its confirmation expired." : "Local credential processing did not complete.");
        });
      });
      this.server.requestTimeout = 120_000; this.server.headersTimeout = 15_000;
      this.server.on("clientError", (_error, socket) => socket.destroy());
      this.server.on("upgrade", (_req, socket) => socket.destroy());
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        this.server.on("error", () => { this.closed = true; for (const c of this.inflight) c.abort(); });
        resolve();
      });
    });
    await this.starting;
  }
  async bindLocal({ scope, assertCurrent = () => {}, validateRequest = async () => {} }) {
    return this.bind({ scope, providerKind: "local-projection", assertCurrent, validateRequest });
  }
  async bindLocalSessions({ resolveScope, assertCurrent = () => {} }) {
    if (typeof resolveScope !== "function") fail("SECRET_MODEL_ROUTE_UNSUPPORTED");
    return this.bind({ providerKind: "local-projection", resolveScope, assertCurrent });
  }
  async bindGrokSession({ providerKind, resolveScope, assertCurrent = () => {} }) {
    if (!["grok-cli", "grok-api-key"].includes(providerKind) || typeof resolveScope !== "function") fail("SECRET_MODEL_ROUTE_UNSUPPORTED");
    return this.bind({ providerKind, resolveScope, assertCurrent });
  }
  async bind({ scope, providerKind, resolveScope = null, assertCurrent = () => {}, validateRequest = async () => {} }) {
    if ((!TARGETS[providerKind] && providerKind !== "local-projection")
      || resolveScope && !["local-projection", "grok-cli", "grok-api-key"].includes(providerKind)
      || !resolveScope && (!scope?.profileId || !scope?.sessionId)) fail("SECRET_MODEL_ROUTE_UNSUPPORTED");
    assertCurrent(); await this.open(); assertCurrent();
    if (this.routes.size >= 4096) fail("SECRET_MODEL_ROUTE_CAPACITY");
    const token = crypto.randomBytes(32).toString("hex"), route = {
      scope: scope ? Object.freeze({ profileId: scope.profileId, sessionId: scope.sessionId }) : null, resolveScope,
      target: TARGETS[providerKind] || null, grok: providerKind.startsWith("grok-"), assertCurrent, validateRequest, active: true, requests: new Set(), ready: false,
    };
    this.routes.set(token, route);
    return Object.freeze({ baseUrl: `http://127.0.0.1:${this.server.address().port}/${token}`,
      ready: () => route.active && route.ready,
      close: () => { route.active = false; this.routes.delete(token); for (const controller of route.requests) controller.abort(); } });
  }
  async handle(req, res) {
    if (this.closed || !["POST", "GET"].includes(req.method) || req.headers.origin || req.headers["sec-fetch-site"]
      || req.headers.host !== `127.0.0.1:${this.server.address().port}`
      || req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity"
      || req.method === "POST" && !/^application\/json(?:\s*;|$)/iu.test(req.headers["content-type"] || "")) fail("SECRET_MODEL_REQUEST_INVALID");
    const match = /^\/([a-f0-9]{64})\/(responses(?:\/(?:compact|input_tokens))?|project|ready|models|api-key)$/u.exec(req.url || "");
    const route = match && this.routes.get(match[1]);
    const discovery = match && ["models", "api-key"].includes(match[2]);
    if (!route || (["project", "ready"].includes(match[2])) !== (route.target === null)
      || match[2] === "ready" && !route.resolveScope
      || discovery && (!route.grok || req.method !== "GET") || !discovery && req.method !== "POST") fail("SECRET_MODEL_ROUTE_INVALID");
    const controller = new AbortController(); route.requests.add(controller); this.inflight.add(controller);
    const assertCurrent = () => {
      if (this.closed || !route.active || controller.signal.aborted) fail("SECRET_MODEL_CANCELED");
      route.assertCurrent();
    };
    const aborted = () => controller.abort();
    req.on("aborted", aborted); res.on("close", aborted);
    let started, bytes = 0, sse = false, disclosed = false, reason = "local_rejection";
    try {
      assertCurrent();
      await route.validateRequest(); assertCurrent();
      if (discovery) {
        if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0) !== 0) fail("SECRET_MODEL_REQUEST_INVALID");
        const headers = {};
        for (const [name, value] of Object.entries(req.headers)) if (GROK_HEADERS.has(name) && typeof value === "string") headers[name] = value;
        const { statusCode, body: upstream } = await this.dispatch(new URL(match[2], route.target),
          { method: "GET", headers, signal: controller.signal }, undefined, 15_000);
        assertCurrent();
        if (statusCode < 200 || statusCode >= 300) { upstream.destroy(); fail("SECRET_MODEL_UPSTREAM_UNAVAILABLE"); }
        let size = 0; const chunks = [];
        for await (const chunk of upstream) { size += chunk.length; if (size > 1024 * 1024) fail("SECRET_MODEL_RESPONSE_INVALID"); chunks.push(chunk); }
        assertCurrent(); const body = Buffer.concat(chunks); JSON.parse(body.toString("utf8"));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(body); return;
      }
      let size = 0; const parts = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail("SECRET_MODEL_INPUT_INVALID"); parts.push(chunk); }
      const body = Buffer.concat(parts).toString("utf8");
      let input; try { input = JSON.parse(body); } catch { fail("SECRET_MODEL_INPUT_INVALID"); }
      if (match[2] === "ready") {
        if (JSON.stringify(input) !== '{"protocol":1}') fail("SECRET_MODEL_INPUT_INVALID");
        assertCurrent(); route.ready = true;
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end('{"ready":true}'); return;
      }
      let requestScope = route.scope, nativeSessionId = null;
      if (route.resolveScope && route.target === null) {
        if (!input || Object.keys(input).sort().join(",") !== "payload,sessionId"
          || typeof input.sessionId !== "string") fail("SECRET_MODEL_INPUT_INVALID");
        nativeSessionId = input.sessionId;
        requestScope = route.resolveScope(nativeSessionId);
        if (!requestScope?.profileId || !requestScope?.sessionId) fail("SECRET_MODEL_IDENTITY_UNAVAILABLE");
        requestScope = { ...requestScope }; input = input.payload;
      } else if (route.resolveScope) {
        requestScope = route.resolveScope();
        if (!requestScope?.profileId || !requestScope?.sessionId) fail("SECRET_MODEL_IDENTITY_UNAVAILABLE");
        requestScope = { ...requestScope };
      }
      if (!input || typeof input !== "object" || input.previous_response_id || input.conversation) fail("SECRET_MODEL_REMOTE_CONTEXT_UNVERIFIED");
      const assertScopeCurrent = () => {
        assertCurrent();
        if (route.resolveScope) {
          const current = route.resolveScope(nativeSessionId);
          if (current?.profileId !== requestScope.profileId || current?.sessionId !== requestScope.sessionId) fail("SECRET_MODEL_IDENTITY_UNAVAILABLE");
        }
      };
      const projected = await processOrOriginal(async () => this.projection.project(requestScope, input,
        { signal: controller.signal, assertCurrent: assertScopeCurrent,
          ...(this.provenance ? { isTrustedOpaque: await this.provenance.verifier(requestScope) } : {}) }), input,
      { signal: controller.signal, assertCurrent: assertScopeCurrent, onFallback: () => { disclosed = true; } });
      assertScopeCurrent();
      assertCurrent();
      await route.validateRequest(); assertScopeCurrent();
      const data = Buffer.from(JSON.stringify(projected));
      // This endpoint only returns a projection to its bound local Runtime.
      // Provider authentication and HTTP routing remain inside that Runtime.
      if (route.target === null) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(data); return;
      }
      const headers = { "content-type": "application/json", "content-length": String(data.length) };
      for (const [name, value] of Object.entries(req.headers)) if ((route.grok ? GROK_HEADERS : HEADERS).has(name) && typeof value === "string") headers[name] = value;
      started = performance.now(); reason = "upstream_unavailable";
      const { statusCode, headers: responseHeaders, body: upstream } = await this.dispatch(new URL(match[2], route.target),
        { method: "POST", headers, signal: controller.signal }, data, 300_000);
      reason = "local_rejection";
      assertCurrent();
      if (statusCode < 200 || statusCode >= 300) {
        upstream.destroy();
        if ([401, 403, 429].includes(statusCode)) {
          writeError(res, statusCode, statusCode === 429 ? "rate_limit_exceeded" : "authentication_error",
            statusCode === 429 ? "Model rate limit reached." : "Model authentication was rejected.");
          return;
        }
        if (statusCode >= 500) reason = "upstream_unavailable";
        fail("SECRET_MODEL_UPSTREAM_UNAVAILABLE");
      }
      // No Location, Set-Cookie, auth material or provider diagnostics are
      // reflected. Successful model streams keep their protocol bytes.
      // The fixed Responses endpoint can omit Content-Type on a valid SSE
      // response. In that case its request's stream flag is authoritative.
      const responseType = responseHeaders["content-type"]
        || (projected.stream === true ? "text/event-stream" : "application/json");
      sse = /text\/event-stream/iu.test(responseType);
      const writeHeaders = () => res.writeHead(statusCode, { "Content-Type": responseType, "Cache-Control": "no-store" });
      const receipt = this.receiptStream(this.provenance && !disclosed ? requestScope : null, sse, {
        holdPrelude: route.grok && sse,
        requireTerminal: disclosed && sse && !route.grok,
        onBytes: size => { bytes += size; },
        onReject: () => { reason = "local_rejection"; },
      });
      reason = "upstream_unavailable";
      // Keep the downstream socket outside pipeline's automatic destruction so
      // a local validation failure can end on a complete protocol event.
      await pipeline(upstream, receipt, async source => {
        for await (const chunk of source) {
          if (!res.headersSent) writeHeaders();
          if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal });
        }
      }, { signal: controller.signal });
      if (!res.headersSent) {
        // Grok can retry a 502 until it has received output from the stream.
        if (route.grok && sse) fail("SECRET_MODEL_UPSTREAM_UNAVAILABLE");
        writeHeaders();
      }
      res.end();
    } catch (error) {
      if (!route.target) throw error;
      if (controller.signal.aborted || error?.code === "SECRET_MODEL_CANCELED") reason = "canceled";
      else if (error?.code === "SECRET_MODEL_PROXY_INVALID") reason = "local_rejection";
      if (started !== undefined) {
        try { this.onDiagnostic({ reason, elapsedMs: Math.round(performance.now() - started), bytes }); } catch {}
      }
      if (res.destroyed || res.writableEnded) return;
      const upstreamFailed = reason === "upstream_unavailable";
      // The original-content fallback authorizes one send of that request.
      const retryable = upstreamFailed && !disclosed;
      if (!retryable && sse && !route.grok) {
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        const message = upstreamFailed ? "Model service temporarily unavailable."
          : reason === "canceled" ? "SECRET_MODEL_CANCELED" : "SECRET_MODEL_RESPONSE_INVALID";
        res.end(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: {
          id: "shoggoth-local-failure", status: "failed", error: { code: "invalid_prompt", message },
        } })}\n\n`);
      } else if (res.headersSent) res.destroy();
      else if (upstreamFailed) writeError(res, retryable ? 502 : 400, "upstream_unavailable", "Model service temporarily unavailable.");
      else if (route.grok) writeError(res, 400, PROJECTION_UNAVAILABLE, PROJECTION_UNAVAILABLE);
      else throw error;
    } finally {
      req.removeListener("aborted", aborted); res.removeListener("close", aborted);
      controller.abort(); route.requests.delete(controller); this.inflight.delete(controller);
    }
  }
  async dispatch(url, options, data, timeoutMs) {
    if (!this.request) {
      this.transport ||= createModelSecretTransport({ env: this.env });
      return this.transport.send(url, options, data, timeoutMs);
    }
    const upstream = await new Promise((resolve, reject) => {
      const outgoing = this.request(url, { ...options, agent: false }, resolve);
      outgoing.on("error", reject);
      outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error("Model transport idle timeout")));
      outgoing.end(data);
    });
    return { statusCode: upstream.statusCode, headers: upstream.headers, body: upstream };
  }
  receiptStream(scope, sse, { holdPrelude = false, requireTerminal = false, onBytes = () => {}, onReject = () => {} } = {}) {
    const decoder = new StringDecoder("utf8"); let buffer = "";
    let prelude = holdPrelude ? "" : null, terminal = false;
    const readEvent = text => {
      if (!text.trim() || text.trim() === "[DONE]") return null;
      let value;
      try { value = JSON.parse(text); }
      catch { if (scope) fail("SECRET_MODEL_RESPONSE_INVALID"); return null; }
      if (scope) this.provenance.record(scope, value.item || value.response?.output || value.output || value);
      return value;
    };
    return new Transform({
      transform(chunk, _encoding, done) {
        onBytes(Buffer.byteLength(chunk));
        if (!sse && !scope) { done(null, chunk); return; }
        try {
          buffer += decoder.write(chunk);
          if (sse) {
            let start = 0;
            for (const boundary of buffer.matchAll(/\r?\n\r?\n/gu)) {
              const end = boundary.index + boundary[0].length;
              const frame = buffer.slice(start, end);
              start = end;
              if (Buffer.byteLength(frame) > MAX_BODY) fail("SECRET_MODEL_RESPONSE_INVALID");
              const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).trimStart()).join("\n");
              const value = scope || prelude !== null || requireTerminal ? readEvent(data) : null;
              if (requireTerminal && RESPONSE_TERMINAL.has(value?.type)) terminal = true;
              if (prelude !== null && (!data || RESPONSE_PRELUDE.has(value?.type))) {
                prelude += frame;
                if (Buffer.byteLength(prelude) > MAX_BODY) fail("SECRET_MODEL_RESPONSE_INVALID");
                continue;
              }
              if (prelude) this.push(prelude);
              prelude = null;
              this.push(frame);
            }
            buffer = buffer.slice(start);
          }
          if (Buffer.byteLength(buffer) > MAX_BODY) fail("SECRET_MODEL_RESPONSE_INVALID");
          done();
        } catch (error) { onReject(); done(error); }
      },
      flush: done => {
        if (!sse && !scope) { done(); return; }
        if (requireTerminal && !terminal) {
          done(serviceError("SECRET_MODEL_UPSTREAM_UNAVAILABLE", "Model stream ended before a terminal event."));
          return;
        }
        try {
          buffer += decoder.end();
          if (!sse) { readEvent(buffer); done(null, Buffer.from(buffer)); return; }
          if (scope && buffer.trim()) fail("SECRET_MODEL_RESPONSE_INVALID");
          done(null, prelude === null && !buffer.trim() ? buffer : undefined);
        } catch (error) { onReject(); done(error); }
      },
    });
  }
  async close() {
    this.closed = true;
    this.disclosures?.close();
    for (const route of this.routes.values()) route.active = false;
    this.routes.clear(); for (const controller of this.inflight) controller.abort();
    if (this.starting) await this.starting.catch(() => {});
    if (this.server?.listening) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
    await this.transport?.close(); this.transport = null;
  }
}
module.exports = { ModelSecretGateway, TARGETS };
