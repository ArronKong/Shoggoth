// OpenCode's supported chat.headers hook binds the native session identity.
// Only that owned process's tagged model fetch is transformed; the original
// fetch retains its destination, authentication, cancellation and response.
const HEADER = "x-shoggoth-local-model-session";
const MAX_BYTES = 64 * 1024 * 1024;
const SUPPORTED = new Set(["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/anthropic", "@ai-sdk/google"]);
const fail = () => { throw Object.assign(new Error("SECRET_MODEL_PROJECTION_UNAVAILABLE"), { code: "SECRET_MODEL_PROJECTION_UNAVAILABLE" }); };

function installModelProjection(endpoint, original = globalThis.fetch) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{64}$/u.test(endpoint)) fail();
  const wrapped = async (input, init) => {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    const sessionId = headers.get(HEADER);
    if (sessionId === null) return original(input, init);
    headers.delete(HEADER);
    let body;
    try {
      if (!/^ses_[A-Za-z0-9_-]{8,128}$/u.test(sessionId)) fail();
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
      if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BYTES) fail();
      const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
      const response = await original(`${endpoint}/project`, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json" }, signal,
        body: JSON.stringify({ sessionId, payload: JSON.parse(raw) }) });
      if (!response.ok) fail();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength; if (size > MAX_BYTES) fail(); chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString("utf8");
      const value = JSON.parse(body); if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    } catch {
      // SDKs classify a rejected fetch as a retryable connection failure. A
      // local 400 response ends this request without contacting the provider or
      // asking OpenCode to repeat native tools while protection is unavailable.
      return new Response(JSON.stringify({ error: { type: "invalid_request_error",
        code: "SECRET_MODEL_PROJECTION_UNAVAILABLE", message: "SECRET_MODEL_PROJECTION_UNAVAILABLE" } }),
      { status: 400, headers: { "content-type": "application/json" } });
    }
    headers.delete("content-length");
    // A Request may already own a body stream. Reconstruct it with the safe
    // body; do not consume or mutate the original native history.
    if (input instanceof Request) return original(new Request(input, { ...init, headers, body }), undefined);
    return original(input, { ...init, headers, body });
  };
  Object.assign(wrapped, original);
  globalThis.fetch = wrapped;
  return {
    "chat.headers": async (input, output) => {
      if (!SUPPORTED.has(input?.model?.api?.npm) || !/^ses_[A-Za-z0-9_-]{8,128}$/u.test(input.sessionID)) fail();
      output.headers[HEADER] = input.sessionID;
    },
  };
}

export default async function secretProjection() {
  const endpoint = process.env.SHOGGOTH_OPENCODE_SECRET_PROJECTION;
  const hooks = installModelProjection(endpoint);
  const response = await fetch(`${endpoint}/ready`, { method: "POST", redirect: "error",
    headers: { "content-type": "application/json" }, body: '{"protocol":1}' });
  if (!response.ok || (await response.json()).ready !== true) fail();
  return hooks;
}
