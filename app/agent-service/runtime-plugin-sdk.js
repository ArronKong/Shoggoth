"use strict";
// Plugin SDK V1. The same bounded JSONL protocol works over stdio and TLS.
const crypto = require("node:crypto");
const { runtimeData, RUNTIME_V1_METHODS, validateRuntimeEvent } = require("./runtime-handle-v1");
const { runtimeBinding, runtimeCapabilities } = require("./runtime-adapter");
const { serviceError } = require("./security");
const allowed = new Set([...Object.keys(RUNTIME_V1_METHODS), "authenticationState", "stop"]);
const fail = () => serviceError("RUNTIME_PLUGIN_PROTOCOL_INVALID", "Plugin protocol rejected the request");
function serveRuntimePlugin({ input = process.stdin, output = process.stdout, factory, authorize = () => true,
  token = null, onError = () => {} }) {
  let buffer = Buffer.alloc(0), handle = null, initializing = false, closed = false, pending = 0;
  let remove = () => {}, closePromise = null; const replies = new Map(), inFlight = new Set(); let nextId = 0;
  const send = value => {
    if (closed) throw fail();
    const text = JSON.stringify(runtimeData(value));
    if (Buffer.byteLength(text) > 8 * 1024 * 1024 || output.writableLength > 8 * 1024 * 1024) throw fail();
    output.write(text + "\n");
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true; input.off("data", consume); remove();
    for (const { reject, timer } of replies.values()) { clearTimeout(timer); reject(fail()); } replies.clear();
    closePromise = (async () => { let timer;
      try { await Promise.race([Promise.resolve().then(() => handle?.stop?.()), new Promise((_, reject) => {
        timer = setTimeout(() => reject(serviceError("RUNTIME_STOP_UNCONFIRMED", "Plugin did not confirm stop")), 5000);
      })]); } finally { clearTimeout(timer); }
    })();
    return closePromise;
  };
  const closeObserved = () => { void close().catch(onError); };
  const hostRequest = (method, params) => new Promise((resolve, reject) => {
    if (replies.size >= 64) { reject(fail()); return; }
    const id = `host-${++nextId}`, timer = setTimeout(() => { replies.delete(id); reject(fail()); }, 120_000);
    replies.set(id, { resolve, reject, timer });
    try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) { clearTimeout(timer); replies.delete(id); reject(error); }
  });
  async function dispatch(frame) {
    const message = runtimeData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)));
    if (message.jsonrpc !== "2.0" || !["string", "number"].includes(typeof message.id)) throw fail();
    if (!message.method) {
      const reply = replies.get(message.id); if (!reply) throw fail();
      replies.delete(message.id); clearTimeout(reply.timer);
      if (message.error) reply.reject(fail()); else reply.resolve(message.result); return;
    }
    if (inFlight.has(message.id) || pending >= 64) throw fail();
    inFlight.add(message.id); pending++;
    try {
      let result;
      if (message.method === "initialize") {
        if (handle || initializing || message.params?.version !== 1) throw fail();
        initializing = true;
        const actual = Buffer.from(typeof message.params.token === "string" ? message.params.token : "");
        const expected = Buffer.from(token || "");
        if (token !== null && (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))) throw fail();
        const binding = runtimeBinding(message.params.binding);
        const context = { binding, workspace: message.params.workspace, permissionPolicy: message.params.permissionPolicy,
          hostRequest, emit(event) { const checked = validateRuntimeEvent(event); if (checked) send({ jsonrpc: "2.0", method: "runtime/event", params: checked }); } };
        if (await authorize(context) !== true || closed) throw fail();
        handle = await factory(context);
        if (closed) { await handle?.stop?.(); return; }
        const capabilities = runtimeCapabilities(handle.capabilities);
        remove = handle.subscribe?.(context.emit) || (() => {});
        result = { version: 1, binding, capabilities, homeIdentity: String(handle.homeIdentity || binding.runtimeAccountId) };
      } else {
        const name = message.method.startsWith("runtime/") ? message.method.slice(8) : "";
        if (!handle || !allowed.has(name) || typeof handle[name] !== "function") throw fail();
        result = await handle[name](runtimeData(message.params || {}));
      }
      if (!closed) send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (error) {
      if (!closed) send({ jsonrpc: "2.0", id: message.id, error: { code: -32000,
        message: "Runtime request failed", data: { code: /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.code || "") ? error.code : "RUNTIME_PLUGIN_FAILED" } } });
    } finally { pending--; inFlight.delete(message.id); }
  }
  function consume(chunk) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > 8 * 1024 * 1024) { closeObserved(); input.destroy?.(); return; }
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      const frame = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      void dispatch(frame).catch(error => { onError(error); closeObserved(); input.destroy?.(); });
    }
  }
  input.on("data", consume); input.once("end", closeObserved); input.once("error", closeObserved); output.once("error", closeObserved);
  return { close };
}
function createRuntimeWorker({ token, factory, authorize, tls: tlsOptions = null, host = "127.0.0.1", port = 0 }) {
  if (typeof token !== "string" || Buffer.byteLength(token) < 32 || Buffer.byteLength(token) > 4096
    || (!tlsOptions && host !== "127.0.0.1")) throw fail();
  const connections = new Map();
  const accept = socket => {
    if (connections.size >= 32) { socket.destroy(); return; }
    socket.setTimeout(15_000, () => socket.destroy());
    const session = serveRuntimePlugin({ input: socket, output: socket, token,
      factory: context => { socket.setTimeout(0); return factory(context); }, authorize });
    connections.set(socket, session); socket.once("close", () => { connections.delete(socket); void session.close().catch(() => {}); });
  };
  const server = tlsOptions ? require("node:tls").createServer(tlsOptions, accept) : require("node:net").createServer(accept);
  return { server, listen: () => new Promise((resolve, reject) => { server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(server.address()); }); }),
    async close() { const results = await Promise.allSettled([...connections].map(async ([socket, session]) => { socket.destroy(); await session.close(); }));
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (results.some(result => result.status === "rejected")) throw serviceError("RUNTIME_STOP_UNCONFIRMED", "Worker did not confirm stop"); } };
}
module.exports = { serveRuntimePlugin, createRuntimeWorker };
