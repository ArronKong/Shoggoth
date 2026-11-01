"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const SCOPE = { profileId: "fixture-agent", sessionId: "fixture-session" };
async function fixture(action) {
  const root = fs.mkdtempSync("/private/tmp/sg-model-project-");
  const secrets = await new TemporarySecretStore({ paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    cryptoBroker: { encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse() } }).open();
  try { await action({ secrets, projection: new ModelSecretProjection({ secrets }) }); }
  finally { await secrets.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
test("Responses native shell output, instructions and resumed history use scoped references", async () => fixture(async ({ secrets, projection }) => {
  const original = { model: "fixture", instructions: "password: 123456", input: [
    { type: "message", role: "user", content: "Read the file." },
    { type: "function_call", name: "exec_command", call_id: "call-123456", arguments: '{"cmd":"cat fixture.txt"}' },
    { type: "function_call_output", call_id: "call-123456", output: "password: 123456\nPublic receipt remains" },
    { type: "message", role: "user", content: "Continue with the previous receipt." },
  ] };
  const safe = await projection.project(SCOPE, original);
  assert.equal(safe.model, "fixture"); assert.equal(safe.input[2].call_id, "call-123456");
  assert(!safe.instructions.includes("123456")); assert(!safe.input[2].output.includes("123456"));
  assert(safe.input[2].output.includes("Public receipt remains"));
  assert.equal(original.input[2].output, "password: 123456\nPublic receipt remains");
  assert.equal(secrets.list(SCOPE).length, 1);
  const second = await projection.project(SCOPE, { input: "The unlabelled value is 123456." });
  assert(!second.input.includes("123456"));
  const other = await projection.project({ ...SCOPE, sessionId: "other" }, { input: "The order is 123456." });
  assert.equal(other.input, "The order is 123456.");
}));
test("tool business objects cannot use wire field names to bypass projection", async () => fixture(async ({ projection }) => {
  const result = await projection.project(SCOPE, { messages: [{ role: "tool", tool_call_id: "fixed",
    content: [{ type: "tool_result", output: { name: "password: 123456", role: "123456", password: 123456 } }] }] });
  assert.equal(result.messages[0].role, "tool"); assert.equal(result.messages[0].tool_call_id, "fixed");
  assert(!JSON.stringify(result).includes("123456"));
}));
test("a whole text value that is valid JSON cannot hide a known short credential", async () => fixture(async ({ secrets, projection }) => {
  for (const value of ["123456", "true", "null", "0"]) {
    await secrets.prepare({ scope: SCOPE, operationId: `known-${value}`, text: `password: "${value}"` });
    const result = await projection.project(SCOPE, { input: value });
    assert.match(result.input, /^\{\{SHOGGOTH_SECRET_/u);
  }
}));
test("short credentials do not corrupt protocol keys or JSON tool schemas", async () => fixture(async ({ secrets, projection }) => {
  await secrets.prepare({ scope: SCOPE, operationId: "known", text: 'password: "string"' });
  const result = await projection.project(SCOPE, { model: "fixture", tools: [{ type: "function", name: "safe_tool",
    parameters: { type: "object", properties: { text: { type: "string", description: "Use string for the password" } } } }],
    input: "The value is string" });
  assert.equal(result.tools[0].parameters.properties.text.type, "string");
  assert.equal(result.tools[0].name, "safe_tool"); assert(!result.input.includes("string"));
  assert(!result.tools[0].parameters.properties.text.description.includes("string"));
}));
test("nested JSON arguments retain escaping and bind newly detected credentials", async () => fixture(async ({ projection }) => {
  const result = await projection.project(SCOPE, { input: [{ type: "function_call", name: "example", call_id: "c",
    arguments: JSON.stringify({ nested: JSON.stringify({ password: 'quoted"value\\tail', note: "public" }) }) }] });
  const arguments_ = JSON.parse(result.input[0].arguments), nested = JSON.parse(arguments_.nested);
  assert.match(nested.password, /^\{\{SHOGGOTH_SECRET_/u); assert.equal(nested.note, "public");
}));
test("opaque and signed history is rejected before a request can be sent", async () => fixture(async ({ projection }) => {
  for (const input of [
    { input: [{ type: "reasoning", encrypted_content: "opaque-old-content", summary: [] }] },
    { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "safe summary", signature: "opaque" }] }] },
  ]) await assert.rejects(projection.project(SCOPE, input), { code: "SECRET_MODEL_SIGNED_CONTEXT_UNSAFE" });
}));
test("remote media reports a processing failure while inline media uses actual processed bytes", async () => fixture(async ({ secrets }) => {
  const seen = [];
  const projection = new ModelSecretProjection({ secrets, media: { async projectInline(scope, item) {
    seen.push({ scope, ...item }); return { mimeType: "image/png", data: Buffer.from("masked-pixels"), text: "Public text" };
  } } });
  const original = { input: [{ role: "user", content: [
    { type: "input_image", image_url: "https://example.invalid/private.png" },
    { type: "input_image", image_url: `data:image/png;base64,${Buffer.from("raw-pixels").toString("base64")}` },
  ] }] };
  await assert.rejects(projection.project(SCOPE, original), { code: "SECRET_MEDIA_UNAVAILABLE" });
  const safe = await projection.project(SCOPE, { input: [{ role: "user", content: original.input[0].content.slice(1) }] });
  assert(!JSON.stringify(safe).includes("example.invalid"));
  assert.equal(safe.input[0].content[0].image_url, `data:image/png;base64,${Buffer.from("masked-pixels").toString("base64")}`);
  assert.deepEqual(seen[0].scope, SCOPE); assert.equal(seen.length, 2);
  assert.equal(Buffer.from(seen[1].data, "base64").toString(), "masked-pixels",
    "the final known-value pass must examine the processed image, not release the original");
}));
test("later labels protect earlier echoes across request fields and dynamic metadata", async () => fixture(async ({ projection }) => {
  const safe = await projection.project(SCOPE, { input: "Earlier echo: FixtureSecret987", metadata: { note: "FixtureSecret987" },
    extra_body: { secret_note: "password: FixtureSecret987" } });
  assert(!JSON.stringify(safe).includes("FixtureSecret987"));
  assert(safe.input.includes("Earlier echo:"));
}));
test("nested tool-result media cannot bypass pixels or opaque-history validation", async () => fixture(async ({ secrets }) => {
  const seen = [];
  const projection = new ModelSecretProjection({ secrets, media: { async projectInline(_scope, item) {
    seen.push(item); return { mimeType: "image/png", data: Buffer.from("processed-pixels") };
  } } });
  const safe = await projection.project(SCOPE, { input: [{ type: "function_call_output", call_id: "c", output: {
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("original-pixels").toString("base64") } }],
    name: "password: FixtureSecret987", public: "receipt-17",
  } }] });
  assert(!JSON.stringify(safe).includes(Buffer.from("original-pixels").toString("base64")));
  assert(!JSON.stringify(safe).includes("FixtureSecret987"));
  assert.equal(safe.input[0].output.public, "receipt-17"); assert.equal(seen.length, 2);
  await assert.rejects(projection.project(SCOPE, { input: [{ type: "function_call_output", call_id: "c",
    output: { content: [{ type: "thinking", thinking: "public", signature: "untrusted-history" }] } }] }),
  { code: "SECRET_MODEL_SIGNED_CONTEXT_UNSAFE" });
}));
test("cancellation during asynchronous projection cannot publish a partial request", async () => {
  const controller = new AbortController(); let checks = 0;
  const projection = new ModelSecretProjection({ secrets: { async project(_scope, text) { controller.abort(); return text; } } });
  await assert.rejects(projection.project(SCOPE, { input: "public" }, { signal: controller.signal, assertCurrent() { checks++; } }),
    { code: "SECRET_MODEL_CANCELED" });
  assert(checks >= 2);
});
