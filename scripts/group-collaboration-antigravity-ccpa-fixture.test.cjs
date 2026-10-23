"use strict";

// Actual loopback HTTP/TLS tests with our own random, synthetic OAuth token.
// No native SDK, original credential, Keychain, external host or model is used.
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const http = require("node:http"), net = require("node:net"), tls = require("node:tls");
const guard = require("./group-collaboration-antigravity-guard.cjs"), fixture = require("./group-collaboration-antigravity-ccpa-fixture.cjs");
const responseSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/antigravity-ccpa-owned-response-schema.json"), "utf8"));
function inputs() { return fixture.createOwnedSyntheticOAuthInputs({ root: fs.mkdtempSync("/private/tmp/sggroup-agy-ccpa-unit-") }); }
async function server(t, options = {}) {
  const auth = inputs(), control = await fixture.createOwnedCcpaLoopback({ root: auth.root, inputs: auth, ...options });
  t.after(async () => { const result = await control.stop(); assert.equal(result.allOwnedListenersClosed, true); assert.equal(result.ownedOpenSockets, 0); });
  return { auth, control };
}
function body(auth, request = { contents: [{ role: "user", parts: [{ text: "OWNED_FAKE_REQUEST" }] }] }) {
  return { project: auth.projectId, model: "gemini-2.5-flash", request };
}
function request(control, auth, method, data, options = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const req = http.request(control.endpoint + "/v1internal:" + method + (options.query || ""), { method: "POST",
      headers: { Authorization: "Bearer " + auth.syntheticToken, "Content-Type": "application/json", "Content-Length": bytes.length, ...options.headers } }, res => {
      const parts = []; res.on("data", part => parts.push(part)); res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"], bytes: Buffer.concat(parts) }));
    }); req.once("error", reject); req.setTimeout(5000, () => req.destroy(new Error("OWNED_HTTP_TEST_TIMEOUT"))); req.end(bytes);
  });
}
function validate(value, schema, label = "response") {
  if (schema.$ref) return validate(value, responseSchema.schemas[schema.$ref], label);
  assert.ok(schema, label + " schema exists");
  if (schema.type === "any") return;
  if (schema.type === "object") {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), label + " object");
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key] || schema.additionalProperties;
      assert.ok(child, label + "." + key + " belongs to the public selected schema"); validate(item, child, label + "." + key);
    }
  } else if (schema.type === "array") { assert.ok(Array.isArray(value), label + " array"); value.forEach((item, index) => validate(item, schema.items, label + "." + index)); }
  else if (schema.type === "integer") assert.ok(Number.isInteger(value), label + " integer");
  else assert.equal(typeof value, schema.type, label + " type");
  if (schema.enum) assert.ok(schema.enum.includes(value), label + " enum");
}
function checkResponse(method, bytes) {
  const value = JSON.parse(bytes); validate(value, responseSchema.methods[method].response);
  if (["generateContent", "streamGenerateContent"].includes(method)) {
    assert.equal(value.response.candidates.length, 1); assert.equal(value.response.candidates[0].content.role, "model");
    assert.equal(value.response.candidates[0].content.parts.length, 1); assert.equal(value.response.candidates[0].finishReason, "STOP");
  }
  return value;
}
function connect(proxyEndpoint, target, headers = {}) {
  const url = new URL(proxyEndpoint);
  return new Promise((resolve, reject) => {
    // Every socket goes to 127.0.0.1. The target is only the HTTP CONNECT text;
    // no test performs DNS or connects to either public hostname.
    const socket = net.connect({ host: "127.0.0.1", port: Number(url.port) }); let bytes = Buffer.alloc(0);
    const onData = part => {
      bytes = Buffer.concat([bytes, part]); const marker = bytes.indexOf("\r\n\r\n"); if (marker < 0) return;
      socket.removeListener("data", onData); socket.removeListener("error", reject); socket.pause();
      const remainder = bytes.subarray(marker + 4); if (remainder.length) socket.unshift(remainder);
      resolve({ socket, status: Number(bytes.toString("ascii", 0, marker).match(/^HTTP\/1\.1 (\d+)/u)?.[1]) });
    };
    socket.once("error", reject); socket.on("data", onData); socket.setTimeout(5000, () => socket.destroy(new Error("OWNED_CONNECT_TEST_TIMEOUT")));
    socket.once("connect", () => socket.write("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n" + Object.entries(headers).map(([key, value]) => key + ": " + value + "\r\n").join("") + "\r\n"));
  });
}
async function tlsRequest(control, auth, files, host, options = {}) {
  const tunnel = await connect(control.proxyEndpoint, host + ":443"); assert.equal(tunnel.status, 200);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: tunnel.socket, servername: options.servername || host, ...(options.trusted === false ? {} : { ca: fs.readFileSync(files.caPath) }) });
    let bytes = Buffer.alloc(0);
    socket.once("error", reject); socket.setTimeout(5000, () => socket.destroy(new Error("OWNED_TLS_TEST_TIMEOUT")));
    socket.once("secureConnect", () => {
      assert.equal(socket.authorized, true); const payload = Buffer.from('{"metadata":{"ideType":"ANTIGRAVITY"}}');
      socket.write("POST /v1internal:loadCodeAssist HTTP/1.1\r\nHost: " + (options.hostHeader || host) + "\r\nAuthorization: Bearer " + auth.syntheticToken
        + "\r\nContent-Type: application/json\r\nContent-Length: " + payload.length + "\r\nConnection: close\r\n\r\n"); socket.write(payload);
    });
    socket.on("data", part => { bytes = Buffer.concat([bytes, part]); });
    socket.once("end", () => {
      const marker = bytes.indexOf("\r\n\r\n"); if (marker < 0) { reject(new Error("OWNED_TLS_RESPONSE_MISSING")); return; }
      resolve({ status: Number(bytes.toString("ascii", 0, marker).match(/^HTTP\/1\.1 (\d+)/u)?.[1]), bytes: bytes.subarray(marker + 4) });
    });
    socket.resume();
  });
}

test("fake OAuth producer follows pinned future-cache fields and never overwrites an existing owned token", () => {
  const auth = inputs(), document = JSON.parse(fs.readFileSync(auth.tokenPath, "utf8"));
  assert.equal(auth.tokenPath, path.join(auth.geminiHome, "antigravity-acp/acp_token.json"));
  assert.equal(document.token, auth.syntheticToken); assert.ok(/^owned-agy-ccpa-fixture-[a-f0-9]{64}$/u.test(document.token));
  for (const key of ["client_id", "client_secret", "refresh_token"]) assert.ok(document[key].startsWith("owned-fake-"));
  assert.equal(document.token_uri, "https://oauth2.googleapis.com/token"); assert.equal(document.project_id, auth.projectId);
  const ttl = Date.parse(document.expiry) - Date.now(); assert.ok(ttl > 590000 && ttl <= 3600000);
  assert.equal(fs.statSync(auth.tokenPath).mode & 0o777, 0o600); assert.equal(guard.sha(fs.readFileSync(auth.tokenPath)), auth.tokenSha256);
  assert.equal(auth.requiredNativeEnvironment.AGY_ACP_FORCE_FILE_STORAGE, "1"); assert.equal(auth.originalCredentialRead, false);
  assert.equal(auth.originalKeychainRead, false); assert.equal(auth.SDKsStarted, 0); assert.equal(auth.realOAuthAcceptance, false);
  assert.throws(() => fixture.createOwnedSyntheticOAuthInputs({ root: auth.root }), { code: "EEXIST" });
  assert.equal(guard.sha(fs.readFileSync(auth.tokenPath)), auth.tokenSha256);
  for (const ttlSeconds of [599, 3601, 1.2]) assert.throws(() => fixture.createOwnedSyntheticOAuthInputs({ root: fs.mkdtempSync("/private/tmp/sggroup-agy-ccpa-invalid-"), ttlSeconds }), { code: "AGY_CCPA_FAKE_EXPIRY_UNSAFE" });
});
test("owned input mutation, original-looking bearer and unsafe roots are refused before any listener", async () => {
  const auth = inputs(); fs.appendFileSync(auth.tokenPath, " ");
  await assert.rejects(fixture.createOwnedCcpaLoopback({ root: auth.root, inputs: auth }), { code: "AGY_GUARD_FILE_CHANGED" });
  const other = inputs(); await assert.rejects(fixture.createOwnedCcpaLoopback({ root: other.root, inputs: { ...other, syntheticToken: "not-an-owned-token" } }), { code: "AGY_CCPA_ONLY_OWNED_FAKE_AUTH_ALLOWED" });
});
test("unsafe root strings are refused before querying original Home or traversal metadata", () => {
  const realpath = fs.realpathSync; let calls = 0;
  fs.realpathSync = () => { calls += 1; throw new Error("OWNED_TEST_UNEXPECTED_METADATA_QUERY"); };
  try {
    for (const root of ["/Users/fixture/.gemini", "/private/tmp/sggroup-x/../../../Users/fixture/.gemini", "relative", null]) {
      assert.throws(() => fixture.createOwnedSyntheticOAuthInputs({ root }), { code: "AGY_CCPA_ROOT_UNSAFE" });
    }
    assert.equal(calls, 0);
  } finally { fs.realpathSync = realpath; }
});
test("strict capture parser preserves large/deep complete schemas and rejects duplicate/unsafe JSON", () => {
  const properties = Object.fromEntries(Array.from({ length: 10000 }, (_, index) => ["field" + index, { type: "string" }]));
  properties.constructor = { type: "string" }; properties.__proto__ = { type: "boolean" };
  let nested = { properties }; for (let index = 0; index < 24; index += 1) nested = { nested };
  const parsed = fixture.parseCapturedJson(JSON.stringify(nested)); assert.ok(parsed.nested); assert.equal(Object.getPrototypeOf(parsed), null);
  assert.throws(() => guard.parseStrictJson(JSON.stringify(nested), { maxBytes: fixture.MAX_BODY }), { code: "AGY_GUARD_INPUT_COMPLEXITY" });
  for (const [raw, code] of [['{"a":1,"\\u0061":2}', "AGY_CCPA_DUPLICATE_JSON_KEY"], ['{"x":"\\ud800"}', "AGY_CCPA_INVALID_STRING"], ['{"x":1e999}', "AGY_CCPA_NONFINITE_NUMBER"], ['{"x":1} trailing', "AGY_CCPA_INVALID_JSON"], ['[1,]', "AGY_CCPA_INVALID_JSON"]]) assert.throws(() => fixture.parseCapturedJson(raw), { code });
  assert.throws(() => fixture.parseCapturedJson("[".repeat(fixture.MAX_JSON_DEPTH + 1) + "0" + "]".repeat(fixture.MAX_JSON_DEPTH + 1)), { code: "AGY_CCPA_JSON_COMPLEXITY" });
  assert.throws(() => fixture.parseCapturedJson("[" + "0,".repeat(fixture.MAX_JSON_NODES) + "0]"), { code: "AGY_CCPA_JSON_COMPLEXITY" });
  assert.throws(() => fixture.parseCapturedJson("x".repeat(fixture.MAX_BODY + 1)), { code: "AGY_CCPA_BODY_SIZE_INVALID" });
});
test("actual HTTP load/fetch/JSON/SSE responses match the selected pinned public response fields", async t => {
  const f = await server(t, { responses: [{ text: "OWNED_TEXT" }, { functionCall: { name: "create_file", args: { TargetFile: "OWNED_PATH", CodeContent: "OWNED_CODE" } } }] });
  const load = await request(f.control, f.auth, "loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }); assert.equal(load.status, 200);
  assert.equal(checkResponse("loadCodeAssist", load.bytes).cloudaicompanionProject, f.auth.projectId);
  const models = await request(f.control, f.auth, "fetchAvailableModels", { project: f.auth.projectId }); assert.equal(models.status, 200);
  assert.equal(checkResponse("fetchAvailableModels", models.bytes).models["gemini-2.5-flash"].supportsThinking, false);
  const generate = await request(f.control, f.auth, "generateContent", body(f.auth)); assert.equal(generate.status, 200);
  assert.equal(checkResponse("generateContent", generate.bytes).response.candidates[0].content.parts[0].text, "OWNED_TEXT");
  const stream = await request(f.control, f.auth, "streamGenerateContent", body(f.auth), { query: "?alt=sse" }); assert.equal(stream.status, 200); assert.equal(stream.contentType, "text/event-stream");
  assert.ok(stream.bytes.toString().startsWith("data: ") && stream.bytes.toString().endsWith("\n\n"));
  assert.equal(checkResponse("streamGenerateContent", stream.bytes.toString().slice(6, -2)).response.candidates[0].content.parts[0].functionCall.name, "create_file");
  const snapshot = f.control.snapshot(); assert.equal(snapshot.acceptedRequests, 4); assert.equal(snapshot.generationCount, 2);
  for (const record of snapshot.records) { assert.equal(record.headersStored, false); assert.equal(record.actualSdkIngressProven, false); assert.equal(record.actualNativeToolBodyProven, false); assert.equal(record.modelAdmission, "UNPROVEN"); }
});
test("actual HTTP captures exact large request bytes and extracts only bound schemas without a native-origin claim", async t => {
  const f = await server(t), properties = Object.fromEntries(Array.from({ length: 6000 }, (_, index) => ["property" + index, { type: "string" }]));
  const declaration = { name: "create_file", parametersJsonSchema: { type: "object", properties } };
  const raw = Buffer.from(JSON.stringify(body(f.auth, { tools: [{ functionDeclarations: [declaration] }], contents: [] }), null, 2) + "\n");
  const answer = await request(f.control, f.auth, "generateContent", raw); assert.equal(answer.status, 200);
  const record = f.control.snapshot().records[0]; assert.deepEqual(fs.readFileSync(record.path), raw); assert.equal(record.sha256, guard.sha(raw)); assert.equal(record.bytes, raw.length);
  const schemas = f.control.extractBuiltinSchemas(record); assert.equal(Object.keys(schemas.create_file.parameters.properties).length, 6000);
  assert.equal(schemas.create_file.actualSdkIngressProven, false); assert.equal(schemas.create_file.actualNativeToolBodyProven, false);
  assert.ok(schemas.create_file.authority.includes("must-be-verified-separately"));
  assert.throws(() => f.control.extractBuiltinSchemas({ ...record, sha256: "0".repeat(64) }), { code: "AGY_CCPA_CAPTURE_RECORD_UNBOUND" });
  fs.appendFileSync(record.path, " "); assert.throws(() => f.control.extractBuiltinSchemas(record), { code: "AGY_GUARD_FILE_CHANGED" });
});
test("replaced same-byte capture identity cannot be accepted as the original capture", async t => {
  const f = await server(t), data = body(f.auth, { tools: [{ functionDeclarations: [{ name: "run_command", parameters: { type: "object" } }] }] });
  assert.equal((await request(f.control, f.auth, "generateContent", data)).status, 200);
  const record = f.control.snapshot().records[0], bytes = fs.readFileSync(record.path), replacement = record.path + ".replacement";
  fs.writeFileSync(replacement, bytes, { mode: 0o600 }); fs.renameSync(replacement, record.path);
  assert.throws(() => f.control.extractBuiltinSchemas(record), { code: "AGY_GUARD_FILE_CHANGED" });
});
test("unknown authorization, duplicate bearer and host mismatch are denied before any body capture", async t => {
  const f = await server(t), marker = Buffer.from('{"OWNED_FAKE_PRIVATE_CANARY":"MUST_NOT_BE_CAPTURED"}');
  for (const headers of [{ Authorization: "Bearer OWNED_WRONG_TOKEN" }, { Authorization: ["Bearer " + f.auth.syntheticToken, "Bearer OWNED_OTHER_TOKEN"] }, { Host: "outside.invalid" }]) {
    assert.equal((await request(f.control, f.auth, "generateContent", marker, { headers })).status, 401);
  }
  assert.equal(f.control.snapshot().records.length, 0); assert.deepEqual(fs.readdirSync(path.join(f.auth.root, "ccpa-loopback-control/captures")), []);
  assert.equal(JSON.stringify(f.control.snapshot()).includes("MUST_NOT_BE_CAPTURED"), false);
  assert.equal(JSON.stringify(f.control.snapshot()).includes(f.auth.syntheticToken), false);
});
test("malformed UTF-8, duplicate JSON, oversized length and unbound request fields are refused", async t => {
  const f = await server(t);
  const rejected = [Buffer.from([0xff]), Buffer.from('{"project":"x","project":"y"}'), Buffer.from("[1,]"), { ...body(f.auth), model: "another-model" }, { ...body(f.auth), project: "outside-project" }, { ...body(f.auth), environment: {} }];
  for (const value of rejected) assert.equal((await request(f.control, f.auth, "generateContent", value)).status, 400);
  assert.equal((await request(f.control, f.auth, "generateContent", Buffer.alloc(0), { headers: { "Content-Length": fixture.MAX_BODY + 1 } })).status, 400);
  assert.equal(f.control.snapshot().records.length, 0);
});
test("only four exact registered routes and their declared query forms are accepted", async t => {
  const f = await server(t);
  for (const [method, query] of [["onboardUser", ""], ["generateContent", "?alt=sse"], ["generateContent", "?extra=1"], ["generateContent", "?alt=json&alt=json"], ["streamGenerateContent", ""], ["streamGenerateContent", "?alt=json"]]) assert.equal((await request(f.control, f.auth, method, body(f.auth), { query })).status, 404);
  assert.equal((await request(f.control, f.auth, "loadCodeAssist", { metadata: { ideType: "OTHER" } })).status, 400);
  assert.equal((await request(f.control, f.auth, "fetchAvailableModels", { project: "other" })).status, 400);
  assert.equal(f.control.snapshot().records.length, 0);
});
test("generation budget rejects additional requests without capturing their bodies", async t => {
  const f = await server(t, { maxGenerations: 1 }); assert.equal((await request(f.control, f.auth, "generateContent", body(f.auth))).status, 200);
  assert.equal((await request(f.control, f.auth, "generateContent", body(f.auth))).status, 429);
  assert.equal(f.control.snapshot().records.length, 1); assert.equal(f.control.snapshot().generationCount, 1);
});
test("total capture budget also bounds onboarding/model-list loops; stopped listeners stay closed", async t => {
  const f = await server(t, { maxRequests: 1 });
  assert.equal((await request(f.control, f.auth, "loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } })).status, 200);
  assert.equal((await request(f.control, f.auth, "fetchAvailableModels", { project: f.auth.projectId })).status, 429);
  assert.equal(f.control.snapshot().records.length, 1); assert.equal(f.control.snapshot().maxRequests, 1);
  assert.deepEqual(await f.control.stop(), { allOwnedListenersClosed: true, ownedOpenSockets: 0, sdkStarted: false });
  assert.deepEqual(await f.control.stop(), { allOwnedListenersClosed: true, ownedOpenSockets: 0, sdkStarted: false });
  await assert.rejects(request(f.control, f.auth, "loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }), { code: "ECONNREFUSED" });
});
test("response plans are exact synthetic text/function-call plans with no uncontrolled response fields", () => {
  for (const value of [{}, { text: "x", functionCall: { name: "x", args: {} } }, { text: "x", extra: 1 }, { functionCall: { name: "../shell", args: {} } }, { functionCall: { name: "x", args: {}, extra: 1 } }]) assert.throws(() => fixture.fixtureResponse(value), { code: "AGY_CCPA_RESPONSE_PLAN_INVALID" });
  assert.throws(() => fixture.fixtureResponse({ text: "" }), { code: "AGY_CCPA_RESPONSE_PLAN_INVALID" });
});
test("actual TLS CONNECT permits two fixed hosts using only the owned CA and never remote forwarding", async t => {
  const auth = inputs(), files = fixture.createOwnedTlsFiles({ root: auth.root }), control = await fixture.createOwnedCcpaLoopback({ root: auth.root, inputs: auth, tlsFiles: files });
  t.after(async () => { const result = await control.stop(); assert.equal(result.allOwnedListenersClosed, true); assert.equal(result.ownedOpenSockets, 0); });
  assert.equal(files.systemTrustChanged, false); assert.equal(files.sdkStarted, false);
  for (const host of fixture.FIXED_TLS_HOSTS) { const answer = await tlsRequest(control, auth, files, host); assert.equal(answer.status, 200); checkResponse("loadCodeAssist", answer.bytes); }
  assert.equal((await tlsRequest(control, auth, files, fixture.FIXED_TLS_HOSTS[0], { hostHeader: "outside.invalid" })).status, 401);
  await assert.rejects(tlsRequest(control, auth, files, fixture.FIXED_TLS_HOSTS[0], { trusted: false }), error => ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(error.code));
  await assert.rejects(tlsRequest(control, auth, files, fixture.FIXED_TLS_HOSTS[0], { servername: "outside.invalid" }), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  for (const [target, headers] of [["outside.invalid:443", {}], ["cloudcode-pa.googleapis.com:80", {}], ["127.0.0.1:443", {}], ["cloudcode-pa.googleapis.com:443", { "Proxy-Authorization": "OWNED_REJECTED" }]]) {
    const attempt = await connect(control.proxyEndpoint, target, headers); assert.equal(attempt.status, 403); attempt.socket.destroy();
  }
  const snapshot = control.snapshot(); assert.equal(snapshot.records.length, 2); assert.equal(snapshot.fixedTlsConnects, 5); assert.equal(snapshot.refusedTlsConnects, 4);
  assert.equal(snapshot.remoteForwarding, false); assert.equal(snapshot.systemTrustChanged, false); assert.equal(snapshot.SDKsStarted, 0); assert.equal(snapshot.originalAuthReadersStarted, 0);
  assert.ok(snapshot.records.every(record => record.transport === "fixed-host-owned-TLS-CONNECT"));
  for (const record of files.files) assert.equal(guard.sha(fs.readFileSync(record.path)), record.sha256);
});
test("TLS certificate/key hash-preserving replacement is refused before TLS listener starts", async () => {
  const auth = inputs(), files = fixture.createOwnedTlsFiles({ root: auth.root }), bytes = fs.readFileSync(files.keyPath), replacement = files.keyPath + ".replacement";
  fs.writeFileSync(replacement, bytes, { mode: 0o600 }); fs.renameSync(replacement, files.keyPath);
  await assert.rejects(fixture.createOwnedCcpaLoopback({ root: auth.root, inputs: auth, tlsFiles: files }), { code: "AGY_GUARD_FILE_CHANGED" });
});
