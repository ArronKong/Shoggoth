"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { ModelSecretGateway, TARGETS } = require("../app/agent-service/model-secret-gateway");
const { registerDesktopSecretIpc, CHANNELS } = require("../app/desktop-secret-ipc");
const { processOrOriginal, prepareForSend, projectTextOrOriginal } = require("../app/core/chat-secret-fallback");
const codes = require("../app/core/chat-secret-fallback-codes.json");
const SCOPE = { profileId: "fixture", sessionId: "session-a" };
const failure = code => Object.assign(Error("synthetic local failure"), { code });
const original = { input: [{ role: "user", content: "password: SyntheticOnly987" },
  { type: "function_call_output", call_id: "completed-once", output: "Public receipt" }],
  tools: [{ name: "fixture" }], metadata: { text: "related original context" } };
test("retired desktop decisions never prompt or dispatch, including stale renderer clicks", async () => {
  const handlers = new Map(), frame = {}, wc = { mainFrame: frame }, window = { webContents: wc };
  const dispose = registerDesktopSecretIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getMainWindow: () => window, getRegistry: () => { throw Error("no registry request expected"); },
    dialog: { showMessageBox() { assert.fail("no dialog is allowed"); } } });
  const handler = handlers.get(CHANNELS.chatDecision);
  const request = { sessionKey: "agent:a:one", disclosureId: "f".repeat(64), choice: "original" };
  assert.equal((await handler({ sender: wc, senderFrame: {} }, request)).error.code, "PRIVILEGED_RENDERER_REQUIRED");
  for (const choice of ["original", "retry", "cancel"]) assert.equal((await handler({ sender: wc, senderFrame: frame },
    { ...request, choice })).error.code, "SECRET_DISCLOSURE_EXPIRED");
  dispose(); assert.equal(handlers.size, 0);
});
async function fixture(action) {
  const received = [], targets = []; let records = 0, processing = async () => { throw failure("SECRET_MEDIA_UNAVAILABLE"); };
  const provider = http.createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    received.push({ body: JSON.parse(body), auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"output":[{"encrypted_content":"opaque-fixture"}]}');
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const gateway = new ModelSecretGateway({ projection: { project: (...args) => processing(...args) },
    disclosures: { wait() { assert.fail("no waiting or UI decision"); }, close() {} },
    provenance: { verifier: async () => () => false, record() { records++; } },
    request(url, options, callback) { targets.push(url.href); return http.request("http://127.0.0.1:" + provider.address().port + "/", options, callback); } });
  const send = (route, input = original, suffix = "/responses") => fetch(route.baseUrl + suffix, {
    method: "POST", headers: { "content-type": "application/json", authorization: "synthetic-auth" }, body: JSON.stringify(input) });
  try { await action({ gateway, send, received, targets, records: () => records, setProcessing: fn => { processing = fn; } }); }
  finally { await gateway.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
}
for (const providerKind of Object.keys(TARGETS)) test(providerKind + ": original fallback preserves target/auth and sends exactly once", async () => fixture(async ({ gateway, send, received, targets, records }) => {
  const route = await gateway.bind({ scope: SCOPE, providerKind });
  const response = await send(route); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(received, [{ body: original, auth: "synthetic-auth" }]);
  assert.deepEqual(targets, [new URL("responses", TARGETS[providerKind]).href]); assert.equal(records(), 0);
}));
test("local runtimes receive original fallback and retain their selected model transport", async () => fixture(async ({ gateway, send, received, setProcessing }) => {
  const single = await gateway.bindLocal({ scope: SCOPE });
  const multi = await gateway.bindLocalSessions({ resolveScope: id => id === "native-session" ? SCOPE : null });
  for (const code of codes) {
    setProcessing(async () => { throw failure(code); });
    for (const [route, input] of [[single, original], [multi, { sessionId: "native-session", payload: original }]]) {
      const result = await send(route, input, "/project"); assert.equal(result.status, 200, code); assert.deepEqual(await result.json(), original);
    }
  }
  assert.equal(received.length, 0, "the local endpoint never chooses or calls a model service");
}));
test("successful processing protects data and attests only the processed request", async () => fixture(async ({ gateway, send, received, records, setProcessing }) => {
  const safe = { input: "protected fixture" }; setProcessing(async () => safe);
  const route = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  const response = await send(route); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(received[0].body, safe); assert.equal(records(), 1);
}));
test("ownership, invalid input, cancellation, uncertain state and unknown outcomes never fall back", async () => fixture(async ({ gateway, send, received, setProcessing }) => {
  const route = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  for (const code of ["SECRET_STORE_UNCERTAIN", "SECRET_REFERENCE_EXPIRED", "SECRET_REFERENCE_FORBIDDEN", "SECRET_MODEL_IDENTITY_UNAVAILABLE",
    "SECRET_MODEL_SCOPE_INVALID", "SECRET_MODEL_CANCELED", "SECRET_MEDIA_CANCELED", "SECRET_INPUT_INVALID", "SECRET_MODEL_INPUT_INVALID",
    "SECRET_TOOL_OUTCOME_UNKNOWN", "SECRET_OPERATION_CONFLICT", "ECONNRESET"]) {
    setProcessing(async () => { throw failure(code); });
    const response = await send(route); assert.equal(response.status, 400, code); await response.text();
  }
  assert.equal(received.length, 0);
}));
test("revocation while processing fails prevents original dispatch", async () => fixture(async ({ gateway, send, received, setProcessing }) => {
  let start, reject; const started = new Promise(resolve => { start = resolve; });
  setProcessing(() => { start(); return new Promise((_, fail) => { reject = fail; }); });
  const route = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  const waiting = send(route); await started; route.close(); reject(failure("SECRET_MEDIA_UNAVAILABLE"));
  assert.equal((await waiting).status, 400); assert.equal(received.length, 0);
}));
test("scope is rechecked after final async validation before delivering the original", async () => fixture(async ({ gateway, send, received }) => {
  let scope = SCOPE, validations = 0;
  const route = await gateway.bindLocalSessions({ resolveScope: () => scope });
  [...gateway.routes.values()][0].validateRequest = async () => { if (++validations === 2) scope = { ...SCOPE, sessionId: "other" }; };
  assert.equal((await send(route, { sessionId: "native", payload: original }, "/project")).status, 503);
  assert.equal(received.length, 0);
}));
test("automatic input/context fallback is once-only; manual review and cancellation remain strict", async () => {
  let calls = 0;
  const secrets = { prepare() { calls++; throw failure("SECRET_INPUT_REVIEW_REQUIRED"); }, projectText() { throw failure("SECRET_PROCESSING_UNAVAILABLE"); } };
  const input = { scope: SCOPE, operationId: "same-operation", text: "password: SyntheticOnly987" };
  assert.deepEqual(await prepareForSend(secrets, input), { text: input.text, references: [], version: 1 });
  assert.equal(calls, 1); assert.throws(() => secrets.prepare(input), { code: "SECRET_INPUT_REVIEW_REQUIRED" });
  assert.equal(projectTextOrOriginal(secrets, SCOPE, input.text), input.text);
  const diskFull = Object.assign(new Error("local storage failed", { cause: failure("ENOSPC") }),
    { code: "SECRET_PROCESSING_UNAVAILABLE" });
  await assert.rejects(processOrOriginal(async () => { throw diskFull; }, input), error => error === diskFull);
  const controller = new AbortController();
  await assert.rejects(processOrOriginal(async () => { controller.abort(); throw failure("SECRET_MEDIA_UNAVAILABLE"); }, input,
    { signal: controller.signal }), { name: "AbortError" });
});
