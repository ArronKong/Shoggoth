import { AsyncLocalStorage } from "node:async_hooks";

const MAX_BYTES = 64 * 1024 * 1024;
const failure = () => Object.assign(new Error("SECRET_MODEL_PROJECTION_UNAVAILABLE"), { code: "SECRET_MODEL_PROJECTION_UNAVAILABLE" });
async function* blocked() {
  yield { type: "finish", reason: { kind: "error", failure: { code: "SECRET_MODEL_PROJECTION_UNAVAILABLE", message: "SECRET_MODEL_PROJECTION_UNAVAILABLE" } } };
}

// The native llm/stream contract forbids editing its immutable session log.
// Carry only its trusted session identity to the HTTP boundary; replace the
// outgoing body while retaining the selected adapter, auth and destination.
export function installModelSecretProjection(ctx, endpoint) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{64}$/u.test(endpoint)) throw failure();
  const context = new AsyncLocalStorage(), original = globalThis.fetch;
  const wrapped = async (input, init) => {
    const scope = context.getStore();
    if (!scope) return original(input, init);
    let body;
    try {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
      if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BYTES) throw failure();
      const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
      const response = await original(`${endpoint}/project`, { method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: scope.sessionId, payload: JSON.parse(raw) }) });
      if (!response.ok) throw failure();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.byteLength; if (size > MAX_BYTES) throw failure(); chunks.push(chunk); }
      body = Buffer.concat(chunks).toString("utf8");
      const value = JSON.parse(body); if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
    } catch {
      scope.failed = true;
      return new Response(JSON.stringify({ error: { code: "SECRET_MODEL_PROJECTION_UNAVAILABLE", message: "SECRET_MODEL_PROJECTION_UNAVAILABLE" } }),
        { status: 400, headers: { "content-type": "application/json" } });
    }
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.delete("content-length");
    return input instanceof Request ? original(new Request(input, { ...init, headers, body })) : original(input, { ...init, headers, body });
  };
  Object.assign(wrapped, original); globalThis.fetch = wrapped;
  ctx.on("llm/stream", (options, next) => {
    const sessionId = options.sessionId;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512) return blocked();
    // Native attachment transports can upload bytes before their JSON model
    // request. Until that native transport is mediated, stop before it starts.
    const image = value => value && typeof value === "object" && (value.type === "image"
      || Object.values(value).some(item => item && typeof item === "object" && image(item)));
    if (image(options.messages)) return blocked();
    const scope = { sessionId, failed: false };
    return (async function* () {
      const iterator = context.run(scope, () => next()[Symbol.asyncIterator]());
      try {
        while (true) {
          const item = await context.run(scope, () => iterator.next());
          if (scope.failed) { yield* blocked(); return; }
          if (item.done) return;
          yield item.value;
        }
      } catch (error) { if (scope.failed) yield* blocked(); else throw error; }
      finally { await context.run(scope, () => iterator.return?.()); }
    })();
  }, { prepend: true });
  return async () => {
    const response = await original(`${endpoint}/ready`, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, body: '{"protocol":1}' });
    if (!response.ok || (await response.json()).ready !== true) throw failure();
  };
}
