"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { detectSecrets, replaceSecrets } = require("../app/agent-service/secret-detector");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { SecretExecutionBroker } = require("../app/agent-service/secret-execution-broker");
const { secretReferences } = require("../app/core/chat-secret-contract");
const SCOPE = { profileId: "profile-a", sessionId: "session-a" };
const marker = "{{SHOGGOTH_SECRET_0123456789abcdef0123456789abcdef}}";
test("secure schema fields use literal selection while ordinary answers remain intact", async () => {
  const { secretAnswerInput } = require("../app/core/chat-secret-contract");
  const input = secretAnswerInput({ field1: '12"34', note: "an ordinary answer" }, {
    properties: { field1: { type: "string", writeOnly: true }, note: { type: "string" } },
  });
  const result = JSON.parse(await mask(input.text, { selections: input.selections }));
  assert.equal(result.field1, marker); assert.equal(result.note, "an ordinary answer");
});
test("trusted configuration classification never exempts a same-valued credential", () => {
  const { classificationFor } = require("../app/agent-service/credential-classification");
  const { mcpEnvelopeSensitiveValues } = require("../app/agent-service/encrypted-secret-store");
  const spec = { id: "n8n", transport: { kind: "stdio-package", registryType: "npm", identifier: "n8n-mcp" } };
  const values = mcpEnvelopeSensitiveValues(Buffer.from(JSON.stringify({ env: { LOG_LEVEL: "error", API_KEY: "true", DISABLE_CONSOLE_OUTPUT: "true" } })), classificationFor(spec));
  assert.deepEqual(values, ["true"]);
  assert(classificationFor({ ...spec, transport: { ...spec.transport, identifier: "unknown" } }).isPublic("env", "LOG_LEVEL", "error") === false);
  const remote = classificationFor({ id: "remote", transport: { kind: "remote", url: "http://127.0.0.1" } });
  const headers = mcpEnvelopeSensitiveValues(Buffer.from(JSON.stringify({ headers: { Accept: "application/json", "X-Api-Key": "application/json" } })), remote);
  assert.deepEqual(headers, ["application/json"]);
});
async function mask(value, options) { return replaceSecrets(value, detectSecrets(value, options), () => marker); }
function encryptedBroker() {
  const key = crypto.randomBytes(32);
  return {
    async encrypt(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    async decrypt(value) {
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]);
    },
  };
}
async function fixture(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-secret-unit-"));
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  const broker = encryptedBroker(); let now = new Date(2026, 9, 29, 12).getTime();
  let store;
  const open = async (options = {}) => {
    store = new TemporarySecretStore({ paths, cryptoBroker: broker, now: () => now, ...options });
    await store.open(); return store;
  };
  try { await open(); await action({ store, open, paths, broker, setNow: value => { now = value; }, now: () => now }); }
  finally { await store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test("label and structured detection preserve neighbouring text and short passwords", async () => {
  for (const [input, expected] of [
    ["账号 alice，密码是 123456，打开网站", `账号 alice，密码是 ${marker}，打开网站`],
    ["password: error", `password: ${marker}`], ["密码：true", `密码：${marker}`],
    ["API_KEY=opaque-value", `API_KEY=${marker}`], ["apiKey: opaque-value", `apiKey: ${marker}`],
    ['{"password":"12\\"34\\\\56", "count": 3}', `{"password":${JSON.stringify(marker)}, "count": 3}`],
    ['{"password":123456,"nested":{"access_token":"opaque"}}', `{"password":${JSON.stringify(marker)},"nested":{"access_token":${JSON.stringify(marker)}}}`],
    ["Authorization: Bearer fake-token-value", `Authorization: Bearer ${marker}`],
    ["postgres://alice:short@localhost/db", `postgres://alice:${marker}@localhost/db`],
    ["密码是 \"带 空格!密码\"", `密码是 "${marker}"`],
    ["琥珀望远镜每天傍晚校准，校准口令是 SYNTHETICTELESCOPE。", `琥珀望远镜每天傍晚校准，校准口令是 ${marker}。`],
  ]) assert.equal(await mask(input), expected, input);
});
test("ordinary numbers, budgets, generic keys, variable names and references remain intact", async () => {
  for (const value of ["123456", "订单号：123456", "token 预算：3000", "token budget: 3000", 'key: user_name',
    "琥珀望远镜每天傍晚校准，校准编号是 SYNTHETICTELESCOPE。",
    "API_KEY=${API_KEY}", "password = process.env.PASSWORD", marker, '{"errorCode":"boom","ok":true}', "setPassword(foo)"]) {
    assert.equal(await mask(value), value, value);
  }
});
test("English password prose and shell paths do not declare a credential", async () => {
  for (const text of [
    "Sign in with your email and password to enjoy reading.",
    "Enter a password and continue.",
    "Reset your password using the account page.",
    "pwd /tmp/llama-stories.html",
    "Open /tmp/password reports/llama-stories.html",
  ]) {
    assert.deepEqual(detectSecrets(text), { matches: [], ambiguous: [] });
    assert.equal(await mask(text), text);
  }
  for (const text of ['password "to"', "password is to", "password: to", "app --password to", "app -db-password to", "密码 to", "密码是 to"]) {
    assert.equal(secretReferences(await mask(text)).length, 1, text);
  }
});
test("known short words match whole tokens without changing longer filenames or encoded names", async () => {
  const known = [{ value: "to", kind: "password", reference: marker }];
  for (const text of [
    "llama-stories.html",
    "[llama-stories.html](/tmp/llama-stories.html)",
    "file:///tmp/llama-stories.html",
    "https://example.invalid/stories.html?next=tomorrow",
    '{"path":"/tmp/llama-stories.html","name":"llama-stories.html"}',
    "photo_to_share.html prefixdG8=suffix",
  ]) assert.equal(await mask(text, { known }), text, text);
  assert.equal(await mask("echo to / dG8= / password: to", { known }), `echo ${marker} / ${marker} / password: ${marker}`);
  assert.equal(await mask("stories", { known, selections: [{ start: 1, end: 3 }] }), `s${marker}ries`,
    "an explicit selection still protects a short substring");
  assert.equal(await mask("password: stories", { known }), `password: ${marker}`,
    "a labelled password still protects its complete value");
  for (const value of ["123456", "true", "error"]) {
    const options = { known: [{ value, kind: "password", reference: marker }] };
    assert.equal(await mask(`x${value}x`, options), `x${value}x`);
    assert.equal(await mask(`echo ${value}`, options), `echo ${marker}`);
  }
  const long = "SyntheticSecret123";
  assert.equal(await mask(`prefix${long}suffix`, { known: [{ value: long, kind: "password" }] }), `prefix${marker}suffix`);
});
test("book browsing does not poison the vault, and an existing short password keeps file links usable", async () => fixture(async ({ store, open }) => {
  const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
  const { projectChatEvent, projectTranscriptContent } = require("../app/agent-service/chat-event-projection");
  const prose = "Sign in with your email and password to enjoy reading.";
  const link = "[llama-stories.html](/tmp/llama-stories.html)", title = "Llama Llama Time to Share";
  assert.equal(await store.project(SCOPE, prose), prose);
  const prepared = await store.prepare({ scope: SCOPE, operationId: "book-request", text: title });
  assert.equal(prepared.text, title); assert.deepEqual(prepared.references, []);
  assert.equal(await store.project(SCOPE, link), link);
  assert.equal(store.list(SCOPE).length, 0, "reading public prose must not create a reusable password");
  const secret = await store.prepare({ scope: SCOPE, operationId: "actual-short-password", text: "password: to" });
  const reference = secret.references[0].reference;
  const verify = async secrets => {
    const display = text => secrets.projectText(SCOPE, text);
    assert.equal(display(link), link);
    assert.equal(secrets.redactKnown(SCOPE, link), link);
    assert.equal(secrets.redactKnown(SCOPE, "echo to / dG8="), `echo ${reference} / ${reference}`);
    assert.equal(await secrets.project(SCOPE, link), link);
    const event = { text: link, phase: "final" };
    assert.deepEqual(projectChatEvent(event, { kind: "event", type: "text" }, display), event);
    const transcript = { transcriptType: "text", ...event };
    assert.deepEqual(projectTranscriptContent(transcript, display), transcript);
    const request = { input: [{ role: "assistant", content: link }, { type: "function_call_output", call_id: "file", output: { path: "/tmp/llama-stories.html" } }] };
    assert.deepEqual(await new ModelSecretProjection({ secrets }).project(SCOPE, request), request);
    assert.equal(display("echo to"), `echo ${reference}`);
    assert.equal(await secrets.project(SCOPE, "echo to"), `echo ${reference}`);
    assert.equal(secrets.list(SCOPE).length, 1);
  };
  await verify(store);
  await store.close();
  await verify(await open());
}));
test("known short values and encoded echoes are replaced without changing references", async () => {
  const known = [{ value: "123456", kind: "password", reference: marker }];
  assert.equal(await mask(`echo 123456 / MTIzNDU2 / ${marker}`, { known }), `echo ${marker} / ${marker} / ${marker}`);
  assert.equal(await mask('{"message":"echo 123456"}', { known }), JSON.stringify({ message: `echo ${marker}` }));
});
test("ambiguous ranges require local review; explicit selection defines the bytes", async () => {
  const value = "password: abcdef.";
  assert.equal(detectSecrets(value).ambiguous.length, 1);
  const selected = detectSecrets(value, { selections: [{ start: 10, end: value.length }] });
  assert.equal(selected.ambiguous.length, 0); assert.equal(await replaceSecrets(value, selected, () => marker), `password: ${marker}`);
});
test("multiple secrets, multiline private keys and explicit Unicode selections", async () => {
  const value = 'a password: "a b\\\"c"; API_KEY=other-secret';
  const result = await mask(value); assert.equal(secretReferences(result).length, 2);
  const pem = "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----";
  assert.equal(await mask(pem), marker);
  assert.equal(await mask("汉字🔑秘密", { selections: [{ start: 0, end: 6 }] }), marker);
});
test("malformed and oversized input is rejected without reflecting its contents", () => {
  for (const value of ["a\0b", "\ud800", "x".repeat(8 * 1024 * 1024 + 1)]) assert.throws(() => detectSecrets(value), { code: "SECRET_INPUT_INVALID" });
  assert.throws(() => detectSecrets("text", { selections: [{ start: 1, end: 99 }] }), { code: "SECRET_INPUT_INVALID" });
});
test("link parameters do not become credentials merely because their names contain token", async () => {
  for (const value of [
    'link "note" url="https://example.invalid/note?xsec_token=page-signature&xsec_source=feed"',
    "[Next page](/search?next_page_token=cursor-value&limit=20)",
    "https://example.invalid/view?token=opaque-link-value#section",
    "../items?cursorToken=next-cursor&sort=date",
    "?tracking_token=site-generated-value&view=list",
    "https://example.invalid/?xsec_token=value.with.trailing.dot.",
    JSON.stringify({ url: "https://example.invalid/?xsec_token=page-signature&source=feed" }),
  ]) {
    assert.deepEqual(detectSecrets(value).ambiguous, [], value);
    assert.equal(await mask(value), value);
  }
});
test("link credential boundaries preserve following parameters, fragments and surrounding text", async () => {
  for (const [input, expected] of [
    ['link url="https://example.invalid/?access_token=synthetic-auth&source=feed#heading"',
      `link url="https://example.invalid/?access_token=${marker}&source=feed#heading"`],
    ["[Login](/callback#refresh_token=synthetic-refresh&state=public)",
      `[Login](/callback#refresh_token=${marker}&state=public)`],
    ["https://example.invalid/?access%5Ftoken=synthetic-auth&next=public", `https://example.invalid/?access%5Ftoken=${marker}&next=public`],
    ["https://example.invalid/?password=literal?value%26tail&amp;view=public", `https://example.invalid/?password=${marker}&amp;view=public`],
    ['https://example.invalid/?password="quoted secret"&view=public', `https://example.invalid/?password="${marker}"&view=public`],
    ["https://example.invalid/?access_token= synthetic-auth", `https://example.invalid/?access_token= ${marker}`],
    ["https://example.invalid/?redirect=https://other.invalid/?api_key=synthetic-key&view=public",
      `https://example.invalid/?redirect=https://other.invalid/?api_key=${marker}&view=public`],
    ["password: literal&value#tail", `password: ${marker}`],
  ]) assert.equal(await mask(input), expected);
});
test("link parameter exemptions never override known credentials, explicit selection or key formats", async () => {
  const value = "https://example.invalid/?xsec_token=synthetic-known&source=feed";
  const expected = `https://example.invalid/?xsec_token=${marker}&source=feed`;
  assert.equal(await mask(value, { known: [{ value: "synthetic-known", kind: "password", reference: marker }] }), expected);
  const start = value.indexOf("synthetic-known");
  assert.equal(await mask(value, { selections: [{ start, end: start + "synthetic-known".length }] }), expected);
  const apiKey = `sk-${"synthetic".repeat(5)}`, jwt = "eyJabcdefghijk.eyJlmnopqrstuv.wxyz0123456789";
  for (const secret of [apiKey, jwt]) {
    assert.equal(await mask(`https://example.invalid/?xsec_token=${secret}&source=feed`),
      `https://example.invalid/?xsec_token=${marker}&source=feed`);
  }
});
test("many browsing tasks leave link values intact without growing the temporary credential store", async () => fixture(async ({ store, open, paths }) => {
  const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
  const projection = new ModelSecretProjection({ secrets: store });
  for (let page = 0; page < 75; page++) {
    const text = Array.from({ length: 60 }, (_, i) =>
      `link "Note ${i}" url="https://example.invalid/note/${i}?xsec_token=page-${page}-signature-${i}&source=feed"`).join("\n");
    const snapshot = { content: [{ type: "text", text }] };
    assert.deepEqual(await store.project(SCOPE, snapshot, { keys: true, model: true }), snapshot);
    const request = { input: [{ type: "function_call_output", call_id: `snapshot-${page}`, output: snapshot }] };
    assert.deepEqual(await projection.project(SCOPE, request), request, "the model's final projection must also leave links intact");
  }
  assert.equal(store.list(SCOPE).length, 0);
  assert.equal(fs.existsSync(path.join(paths.stateDir, "temporary-secrets/state-v1.json")), false,
    "observing 4,500 distinct link parameters should perform no credential-state writes");
  const pasted = "Open https://example.invalid/?xsec_token=pasted-page-signature&source=feed";
  const prepared = await store.prepare({ scope: SCOPE, operationId: "pasted-link", text: pasted });
  assert.equal(prepared.text, pasted); assert.equal(prepared.references.length, 0);
  await store.close(); const reopened = await open(); assert.equal(reopened.list(SCOPE).length, 0);
}));
test("real URL credentials deduplicate by value and retain the original URL when executed", async () => fixture(async ({ store }) => {
  for (const source of ["feed", "search"]) {
    const url = `https://example.invalid/?access_token=synthetic-auth&source=${source}#details`;
    const result = await store.project(SCOPE, { url });
    assert.equal(store.list(SCOPE).length, 1);
    assert.equal(secretReferences(result.url).length, 1);
    assert.equal(store.resolve(SCOPE, result.url), url);
    assert(result.url.endsWith(`&source=${source}#details`));
  }
}));
test("browsing keeps page parameters ordinary while an actual user credential echo stays protected", async () => fixture(async ({ store }) => {
  const known = await store.prepare({ scope: SCOPE, operationId: "user-password", text: "password: synthetic-known" });
  const ordinary = "https://example.invalid/?xsec_token=unrelated-page-signature&source=feed";
  const protectedUrl = "https://example.invalid/?xsec_token=synthetic-known&source=feed";
  const result = await store.project(SCOPE, { links: [ordinary, protectedUrl] });
  assert.equal(result.links[0], ordinary);
  assert.equal(result.links[1], `https://example.invalid/?xsec_token=${known.references[0].reference}&source=feed`);
  assert.equal(store.list(SCOPE).length, 1);
  const connected = await store.project(SCOPE, { url: "https://example.invalid/?xsec_token=connected-auth&source=feed" },
    { known: [{ value: "connected-auth", kind: "token" }] });
  assert.equal(connected.url, "https://example.invalid/?xsec_token=[CONNECTED_CREDENTIAL_REDACTED]&source=feed");
  assert.equal(store.list(SCOPE).length, 1, "connector authentication must not be copied into the chat vault");
}));
test("temporary values are encrypted, stable within one session and absent from plaintext files", async () => fixture(async ({ store, paths }) => {
  const prepared = await store.prepare({ scope: SCOPE, operationId: "message-a", text: "密码是 123456" });
  assert(!prepared.text.includes("123456")); assert.equal(prepared.references.length, 1);
  assert.equal(store.resolve(SCOPE, prepared.text), "密码是 123456");
  assert.deepEqual(await store.prepare({ scope: SCOPE, operationId: "message-a", text: "密码是 123456" }), prepared);
  assert.deepEqual(await store.prepare({ scope: SCOPE, operationId: "message-a", text: prepared.text }), prepared);
  await assert.rejects(store.prepare({ scope: SCOPE, operationId: "message-a", text: "密码是 different" }), { code: "SECRET_OPERATION_CONFLICT" });
  const later = await store.prepare({ scope: SCOPE, operationId: "message-b", text: "repeat 123456" });
  assert.equal(later.references[0].reference, prepared.references[0].reference);
  for (const name of fs.readdirSync(path.join(paths.stateDir, "temporary-secrets"))) {
    assert(!fs.readFileSync(path.join(paths.stateDir, "temporary-secrets", name)).includes(Buffer.from("123456")));
  }
}));
test("same-valued secrets in other sessions never share references or read authority", async () => fixture(async ({ store }) => {
  const a = await store.prepare({ scope: SCOPE, operationId: "m", text: "密码是 123456" });
  const scopeB = { ...SCOPE, sessionId: "session-b" };
  const b = await store.prepare({ scope: scopeB, operationId: "m", text: "密码是 123456" });
  assert.notEqual(a.references[0].reference, b.references[0].reference);
  assert.throws(() => store.resolve(scopeB, a.text), { code: "SECRET_REFERENCE_FORBIDDEN" });
  await assert.rejects(store.prepare({ scope: scopeB, operationId: "forged", text: a.text }), { code: "SECRET_REFERENCE_FORBIDDEN" });
}));
test("fresh process restores encrypted entries and the original admission receipt", async () => fixture(async ({ store, open }) => {
  const a = await store.prepare({ scope: SCOPE, operationId: "m", text: "密码是 123456" });
  await store.close(); const next = await open();
  assert.equal(next.resolve(SCOPE, a.text), "密码是 123456");
  assert.deepEqual(await next.prepare({ scope: SCOPE, operationId: "m", text: "密码是 123456" }), a);
}));
test("midnight, restart and clock rollback cannot revive an expired credential", async () => fixture(async ({ store, open, setNow }) => {
  const a = await store.prepare({ scope: SCOPE, operationId: "m", text: "密码是 123456" });
  setNow(a.references[0].expiresAt); assert.equal(await store.expire(), 1);
  assert.throws(() => store.resolve(SCOPE, a.text), { code: "SECRET_REFERENCE_EXPIRED" });
  await store.close(); const next = await open(); setNow(1);
  assert.throws(() => next.resolve(SCOPE, a.text), { code: "SECRET_REFERENCE_EXPIRED" });
  const replay = await next.prepare({ scope: SCOPE, operationId: "m", text: "密码是 123456" });
  assert.equal(replay.text, a.text); assert.equal(replay.references[0].available, false);
  assert.equal((await next.prepare({ scope: SCOPE, operationId: "ordinary", text: `继续解释这段历史：${a.text}` })).text, `继续解释这段历史：${a.text}`);
}));
test("revoke erases one credential without deleting the message or another credential", async () => fixture(async ({ store }) => {
  const a = await store.prepare({ scope: SCOPE, operationId: "m", text: 'password: "first"; API_KEY=second' });
  const first = a.references[0].reference, second = a.references[1].reference;
  assert.deepEqual(await store.revoke(SCOPE, first), { revoked: 1 });
  assert.throws(() => store.resolve(SCOPE, first), { code: "SECRET_REFERENCE_EXPIRED" });
  assert.equal(store.resolve(SCOPE, second), "second");
  assert.equal((await store.prepare({ scope: SCOPE, operationId: "m", text: 'password: "first"; API_KEY=second' })).text, a.text);
}));
test("first preparation and object projection protect an echo before its label", async () => fixture(async ({ store }) => {
  const prepared = await store.prepare({ scope: SCOPE, operationId: "earlier-echo", text: "An earlier echo: EchoSecret987. password: EchoSecret987" });
  assert(!prepared.text.includes("EchoSecret987"));
  assert.equal(prepared.references.length, 1);
  const object = await store.project(SCOPE, { earlier: "ObjectSecret654", nested: { password: "ObjectSecret654" } });
  assert(!JSON.stringify(object).includes("ObjectSecret654"));
}));

test("model projection masks new tool credentials and every known short echo without changing data facts", async () => fixture(async ({ store }) => {
  await store.prepare({ scope: SCOPE, operationId: "m", text: "密码是 123456" });
  const value = { status: "completed", count: 2, content: [{ type: "text", text: "echo 123456; API_KEY=new-value" }] };
  const projected = await store.project(SCOPE, value);
  assert.equal(projected.status, "completed"); assert.equal(projected.count, 2);
  assert(!JSON.stringify(projected).includes("123456")); assert(!JSON.stringify(projected).includes("new-value"));
  assert.equal(value.content[0].text, "echo 123456; API_KEY=new-value", "display original is not mutated");
  const structured = await store.project(SCOPE, { password: "short", access_token: "opaque", Authorization: "Bearer other-value" });
  for (const value of Object.values(structured)) assert.equal(secretReferences(value).length, 1);
}));
test("pausing discovery preserves ordinary content, existing references and explicit selections", async () => fixture(async ({ store, open }) => {
  const legacy = await store.prepare({ scope: SCOPE, operationId: "legacy", text: "password: 123456" });
  const oldReference = legacy.references[0].reference;
  await store.close();
  const paused = await open({ autoDetect: false, getKnownSecrets: () => [{ value: "ConnectorFixture777", kind: "token" }] });
  const ordinary = "See an example of password: ordinary-value. Authorization: Bearer unmarked-value";
  const fresh = await paused.prepare({ scope: SCOPE, operationId: "ordinary", text: ordinary });
  assert.equal(fresh.text, ordinary);
  assert.deepEqual(fresh.references, []);
  assert.equal(paused.projectText(SCOPE, ordinary), ordinary);
  const output = { password: "public-sample", nested: { access_token: "unmarked-value" }, content: ordinary };
  assert.deepEqual(await paused.project(SCOPE, output, { keys: true, model: true }), output);
  assert.deepEqual(await paused.prepare({ scope: SCOPE, operationId: "legacy", text: legacy.text }), legacy);
  assert.equal(paused.resolve(SCOPE, oldReference), "123456");
  assert.equal(await paused.project(SCOPE, "echo 123456 and ConnectorFixture777"),
    `echo ${oldReference} and [CONNECTED_CREDENTIAL_REDACTED]`);
  const selected = await paused.prepare({ scope: SCOPE, operationId: "explicit", text: "select 987654",
    selections: [{ start: 7, end: 13, kind: "password" }] });
  const newReference = selected.references[0].reference;
  assert.equal(selected.text, `select ${newReference}`);
  assert.equal(paused.resolve(SCOPE, newReference), "987654");
  assert.equal(paused.projectText(SCOPE, "echo 987654"), `echo ${newReference}`);
  assert.equal(paused.list(SCOPE).length, 2);
}));
test("cancellation is checked at actual injection, without granting read capabilities", async () => fixture(async ({ store }) => {
  const a = await store.prepare({ scope: SCOPE, operationId: "m", text: "密码是 123456" });
  assert.throws(() => store.resolve(SCOPE, a.text, () => { throw Object.assign(new Error("canceled"), { code: "CANCELED" }); }), { code: "CANCELED" });
  assert(store.list(SCOPE).every(item => !Object.hasOwn(item, "value")));
}));
test("tampering with ciphertext never emits plaintext or silently creates fresh authority", async () => fixture(async ({ store, open, paths }) => {
  await store.prepare({ scope: SCOPE, operationId: "m", text: "密码是 123456" }); await store.close();
  const file = path.join(paths.stateDir, "temporary-secrets/state-v1.json"), state = JSON.parse(fs.readFileSync(file));
  Object.values(state.entries)[0].tag = crypto.randomBytes(16).toString("base64"); fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const next = await open();
  await assert.rejects(next.prepare({ scope: SCOPE, operationId: "next", text: "继续" }), { code: "SECRET_PROCESSING_UNAVAILABLE" });
}));

async function executionFixture(action) {
  await fixture(async context => {
    const displays = []; let broker;
    const create = async overrides => {
      broker = new SecretExecutionBroker({ paths: context.paths, cryptoBroker: context.broker, secrets: context.store,
        now: context.now, onDisplay: event => displays.push(event), ...overrides });
      await broker.open(); return broker;
    };
    try { await create(); await action({ ...context, broker, create, displays }); }
    finally { await broker?.close(); }
  });
}

test("execution injects at the endpoint, projects model content, and restores completion across two restarts", async () => executionFixture(async ({ store, broker, create, displays, paths }) => {
  const prepared = await store.prepare({ scope: SCOPE, operationId: "input", text: "password: 123456" });
  const reference = prepared.references[0].reference; let executions = 0;
  const request = { scope: SCOPE, tool: "mcp.test", callId: "call-a", args: { password: reference }, assertCurrent() {},
    async invoke(args) { executions++; assert.equal(args.password, "123456"); return { success: true, content: [{ type: "text", text: "echo 123456" }] }; } };
  const first = await broker.execute(request);
  assert.equal(executions, 1); assert.equal(displays[0].result.content[0].text, "echo 123456");
  assert.equal(first.result.success, true); assert.equal(first.result.content[0].text, `echo ${reference}`);
  assert.equal(JSON.stringify(first).includes("123456"), false);
  assert.equal(fs.readFileSync(path.join(paths.stateDir, "secret-tool-receipts-v1.json"), "utf8").includes("123456"), false);
  for (let i = 0; i < 2; i++) {
    await broker.close(); broker = await create();
    assert.equal((await broker.execute(request)).recovered, true); assert.equal(executions, 1);
    assert.equal((await broker.display(SCOPE, first.receiptId)).result.content[0].text, "echo 123456");
  }
  await assert.rejects(broker.execute({ ...request, args: { password: reference, altered: true } }), { code: "SECRET_OPERATION_CONFLICT" });
  await assert.rejects(broker.display({ ...SCOPE, sessionId: "other" }, first.receiptId), { code: "SECRET_REFERENCE_FORBIDDEN" });
}));

test("projection and display failure preserve successful execution without asking the model to retry", async () => executionFixture(async ({ broker, create, store }) => {
  await broker.close(); let executions = 0;
  broker = await create({ secrets: { project() { throw Error("offline"); }, resolve: store.resolve.bind(store) }, onDisplay() { throw Error("ui offline"); } });
  const request = { scope: SCOPE, callId: "completed-projection-failed", tool: "fixture", args: {}, assertCurrent() {},
    invoke() { executions++; return { success: true, output: "original result" }; } };
  const result = await broker.execute(request);
  assert.equal(result.result.operationStatus, "completed"); assert.equal(result.result.retryAllowed, false);
  assert.equal((await broker.display(SCOPE, result.receiptId)).result.output, "original result");
  await broker.close(); broker = await create(); await broker.execute(request); assert.equal(executions, 1);
}));

test("masking failure delivers original result once and never persists it in the plaintext receipt", async () => executionFixture(async ({ broker, create, paths, store, setNow, now }) => {
  await broker.close(); let executions = 0;
  const unavailable = { project() { throw Object.assign(Error("offline"), { code: "SECRET_PROCESSING_UNAVAILABLE" }); }, resolve: store.resolve.bind(store) };
  broker = await create({ secrets: unavailable });
  const raw = { success: true, output: "password: SyntheticOnly987" };
  const request = { scope: SCOPE, callId: "original-completed-once", tool: "fixture", args: {}, assertCurrent() {},
    invoke() { executions++; return raw; } };
  assert.deepEqual((await broker.execute(request)).result, raw);
  assert(!fs.readFileSync(path.join(paths.stateDir, "secret-tool-receipts-v1.json"), "utf8").includes("SyntheticOnly987"));
  for (let i = 0; i < 2; i++) {
    await broker.close(); broker = await create({ secrets: unavailable });
    const recovered = await broker.execute(request); assert.equal(recovered.recovered, true); assert.deepEqual(recovered.result, raw);
  }
  setNow(now() + 24 * 3600000);
  const expired = await broker.execute(request); assert.equal(expired.result.operationStatus, "completed");
  assert(!JSON.stringify(expired).includes("SyntheticOnly987")); assert.equal(executions, 1);
}));

test("revocation while a recovered original is being projected cannot release the retired value", async () => executionFixture(async ({ broker, create, store }) => {
  await broker.close();
  const prepared = await store.prepare({ scope: SCOPE, operationId: "recover-revoke-input", text: "password: RetiredFixture987" });
  const reference = prepared.references[0].reference;
  let entered, release, waiting = false, executions = 0;
  const blocked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  broker = await create({ media: { async projectResult() {
    if (waiting) { entered(); await gate; }
    throw Object.assign(Error("offline"), { code: "SECRET_PROCESSING_UNAVAILABLE" });
  } } });
  const request = { scope: SCOPE, callId: "recover-revocation", tool: "fixture", args: { password: reference }, assertCurrent() {},
    invoke() { executions++; return { output: "RetiredFixture987" }; } };
  await broker.execute(request); waiting = true;
  const recovered = broker.execute(request); await blocked;
  await broker.revokeReference(SCOPE, reference); release();
  assert(!JSON.stringify(await recovered).includes("RetiredFixture987"));
  assert.equal(executions, 1);
}));

test("cancellation after completed execution remains terminal without replay or original delivery", async () => executionFixture(async ({ broker, create }) => {
  await broker.close(); let canceled = false, executions = 0;
  broker = await create({ media: { projectResult() {
    canceled = true;
    throw Object.assign(Error("offline"), { code: "SECRET_PROCESSING_UNAVAILABLE" });
  } } });
  const request = { scope: SCOPE, callId: "cancel-completed-original", tool: "fixture", args: {},
    assertCurrent() { if (canceled) throw Object.assign(Error("canceled"), { code: "SECRET_MODEL_CANCELED" }); },
    invoke() { executions++; return { output: "PrivateFixture987" }; } };
  await assert.rejects(broker.execute(request), { code: "SECRET_MODEL_CANCELED" });
  canceled = false;
  const recovered = await broker.execute(request);
  assert.equal(recovered.recovered, true); assert.equal(executions, 1);
  assert(!JSON.stringify(recovered).includes("PrivateFixture987"));
}));

test("unknown dispatch never replays after restart and an unrelated scope continues", async () => executionFixture(async ({ broker, create }) => {
  let executions = 0;
  const request = { scope: SCOPE, callId: "lost", tool: "fixture", args: {}, assertCurrent() {}, invoke() { executions++; throw Error("lost connection"); } };
  await assert.rejects(broker.execute(request), { code: "SECRET_TOOL_OUTCOME_UNKNOWN" });
  await broker.close(); broker = await create();
  await assert.rejects(broker.execute(request), { code: "SECRET_TOOL_OUTCOME_UNKNOWN" });
  assert.equal(executions, 1);
  const result = await broker.execute({ ...request, scope: { ...SCOPE, sessionId: "unrelated" }, invoke() { return { ok: true }; } });
  assert.equal(result.result.ok, true);
}));

test("tool receipts recover from disk exhaustion without a Service restart or replaying dispatched calls", async t => {
  for (const stage of ["before-dispatch", "after-dispatch"]) await t.test(stage, async t => executionFixture(async ({ broker }) => {
    const originalOpen = fs.openSync, originalWrite = fs.writeSync, receiptFds = new Set();
    let diskFull = stage === "before-dispatch", executions = 0;
    t.mock.method(fs, "openSync", (file, ...args) => {
      const fd = originalOpen(file, ...args); receiptFds.delete(fd);
      if (file === `${broker.file}.tmp`) receiptFds.add(fd);
      return fd;
    });
    t.mock.method(fs, "writeSync", (fd, ...args) => {
      if (diskFull && receiptFds.has(fd)) throw Object.assign(Error("disk full"), { code: "ENOSPC" });
      return originalWrite(fd, ...args);
    });
    const request = { scope: SCOPE, callId: "disk-full-call", tool: "fixture", args: {}, assertCurrent() {},
      invoke() { executions++; diskFull = true; return { ok: true }; } };
    await assert.rejects(broker.execute(request), {
      code: stage === "before-dispatch" ? "SECRET_PROCESSING_UNAVAILABLE" : "SECRET_TOOL_OUTCOME_UNKNOWN",
    });
    assert.equal(executions, stage === "before-dispatch" ? 0 : 1);
    diskFull = false;
    if (stage === "after-dispatch") {
      await assert.rejects(broker.execute(request), { code: "SECRET_TOOL_OUTCOME_UNKNOWN" });
      assert.equal(executions, 1, "missing completion receipt must not repeat an executed action");
    }
    const resumed = await broker.execute({ ...request, callId: "new-call-after-space-restored",
      invoke() { executions++; return { ok: true }; } });
    assert.equal(resumed.result.ok, true);
    assert.equal(broker.uncertain, false);
    if (stage === "after-dispatch") {
      await assert.rejects(broker.execute(request), { code: "SECRET_TOOL_OUTCOME_UNKNOWN" });
      assert.equal(executions, 2);
    }
  }));
});

test("a confirmed receipt rollback allows later calls after storage recovery", async t => executionFixture(async ({ broker }) => {
  const originalSync = fs.fsyncSync;
  let failSync = true, executions = 0;
  t.mock.method(fs, "fsyncSync", fd => {
    if (failSync && fs.fstatSync(fd).isDirectory()) {
      failSync = false;
      throw Object.assign(Error("disk quota exhausted"), { code: "EDQUOT" });
    }
    return originalSync(fd);
  });
  const request = { scope: SCOPE, callId: "rolled-back", tool: "fixture", args: {}, assertCurrent() {},
    invoke() { executions++; return { ok: true }; } };
  await assert.rejects(broker.execute(request), { code: "SECRET_PROCESSING_UNAVAILABLE" });
  assert.equal(executions, 0);
  assert.equal(broker.uncertain, false);
  assert.equal((await broker.execute({ ...request, callId: "after-rollback" })).result.ok, true);
  assert.equal(executions, 1);
}));

test("uncertain receipt commit remains fenced after space returns", async t => executionFixture(async ({ broker }) => {
  const originalSync = fs.fsyncSync;
  let failSync = true;
  t.mock.method(fs, "fsyncSync", fd => {
    if (failSync && fs.fstatSync(fd).isDirectory()) throw Object.assign(Error("disk full"), { code: "ENOSPC" });
    return originalSync(fd);
  });
  let executions = 0;
  const request = { scope: SCOPE, callId: "uncertain-commit", tool: "fixture", args: {}, assertCurrent() {},
    invoke() { executions++; return { ok: true }; } };
  await assert.rejects(broker.execute(request), { code: "SECRET_STORE_UNCERTAIN" });
  failSync = false;
  await assert.rejects(broker.execute({ ...request, callId: "another-operation" }), { code: "SECRET_STORE_UNCERTAIN" });
  assert.equal(executions, 0, "free space is not proof of an uncertain commit");
}));

test("concurrent exact calls execute once and expiry removes only encrypted raw result", async () => executionFixture(async ({ store, broker, paths, setNow, now }) => {
  const prepared = await store.prepare({ scope: SCOPE, operationId: "input", text: "password: true" });
  let executions = 0, release;
  const request = { scope: SCOPE, tool: "fixture", callId: "parallel", args: { password: prepared.references[0].reference }, assertCurrent() {},
    async invoke() { executions++; await new Promise(resolve => { release = resolve; }); return { output: "true" }; } };
  const a = broker.execute(request), b = broker.execute(request);
  await new Promise(resolve => setImmediate(resolve)); release();
  const [first, second] = await Promise.all([a, b]); assert.equal(executions, 1); assert.deepEqual(first, second);
  setNow(now() + 25 * 60 * 60 * 1000); await store.expire(); broker.expire();
  assert.equal(fs.existsSync(path.join(paths.stateDir, "temporary-secrets", "outcomes", `${first.receiptId}.json`)), false);
  assert.equal((await broker.execute(request)).recovered, true); assert.equal(executions, 1);
  assert.equal((await broker.display(SCOPE, first.receiptId)).status, "completed");
}));

test("forged, revoked, cancelled references cannot reach an execution endpoint", async () => executionFixture(async ({ store, broker }) => {
  const p = await store.prepare({ scope: SCOPE, operationId: "source", text: "password: short" });
  let executions = 0;
  const request = { scope: SCOPE, tool: "fixture", callId: "blocked", args: { input: p.references[0].reference }, assertCurrent() {}, invoke() { executions++; return {}; } };
  await assert.rejects(broker.execute({ ...request, scope: { ...SCOPE, sessionId: "forged" } }), { code: "SECRET_REFERENCE_FORBIDDEN" });
  await assert.rejects(broker.execute({ ...request, assertCurrent() { throw Object.assign(Error("cancel"), { code: "CANCELLED" }); } }), { code: "CANCELLED" });
  await store.revoke(SCOPE, p.references[0].reference);
  await assert.rejects(broker.execute(request), { code: "SECRET_REFERENCE_EXPIRED" });
  assert.equal(executions, 0);
}));

test("explicit JSON selections decode strings and retain valid numeric JSON", async () => {
  for (const input of ['{"password":123456}', '{"password":"12\\"34"}']) {
    const start = input.indexOf(":") + 1, end = input.length - 1;
    const result = await mask(input, { selections: [{ start, end, kind: "password" }] });
    assert.equal(JSON.parse(result).password, marker);
  }
});
test("ordinary-text decisions are scoped and cannot exempt a known credential", async () => fixture(async ({ store, now, setNow }) => {
  const text = "password: ordinary-example";
  const prepared = await store.prepare({ scope: SCOPE, operationId: "ordinary", text, ordinary: [{ start: 10, end: text.length }] });
  assert.equal(prepared.text, text); assert.equal(store.projectText(SCOPE, text), text);
  assert(!store.projectText({ ...SCOPE, sessionId: "another" }, text).includes("ordinary-example"));
  const known = await store.prepare({ scope: SCOPE, operationId: "explicit-secret", text: "ordinary-example", selections: [{ start: 0, end: 16, kind: "password" }] });
  const stillProtected = await store.prepare({ scope: SCOPE, operationId: "cannot-exempt", text, ordinary: [{ start: 10, end: text.length }] });
  assert(stillProtected.text.includes(known.references[0].reference));
  const tomorrow = new Date(now()); tomorrow.setDate(tomorrow.getDate() + 1); setNow(tomorrow.getTime()); await store.expire();
  assert(!store.projectText(SCOPE, text).includes("ordinary-example"));
}));
test("same-value credentials in different roles retain different references", async () => fixture(async ({ store }) => {
  const a = await store.prepare({ scope: SCOPE, operationId: "pwd", text: 'password: "same-value"' });
  const b = await store.prepare({ scope: SCOPE, operationId: "api", text: 'api_key: "same-value"' });
  assert.notEqual(a.references[0].reference, b.references[0].reference);
}));
test("revocation removes only the selected credential from stored results and preserves other facts", async () => fixture(async ({ store, paths, broker, now }) => {
  const engine = new SecretExecutionBroker({ paths, cryptoBroker: broker, secrets: store, now }); await engine.open();
  try {
    const p = await store.prepare({ scope: SCOPE, operationId: "two", text: 'password: "first-secret"; api_key: "second-secret"' });
    const [a, b] = p.references.map(item => item.reference); let calls = 0;
    const one = await engine.execute({ scope: SCOPE, callId: "one", tool: "fixture", args: { a, b }, assertCurrent() {},
      invoke: args => { calls++; return { message: `order 777: ${args.a}, ${args.b}`, count: 17 }; } });
    const two = await engine.execute({ scope: SCOPE, callId: "two", tool: "fixture", args: {}, assertCurrent() {}, invoke: () => ({ message: "unrelated result", count: 18 }) });
    await engine.revokeReference(SCOPE, a);
    const shown = await engine.display(SCOPE, one.receiptId), other = await engine.display(SCOPE, two.receiptId);
    assert(!JSON.stringify(shown).includes("first-secret")); assert(JSON.stringify(shown).includes("second-secret"));
    assert.equal(shown.result.count, 17); assert.equal(other.result.message, "unrelated result"); assert.equal(calls, 1);
    assert.equal(store.resolve(SCOPE, b), "second-secret"); assert.throws(() => store.resolve(SCOPE, a));
  } finally { await engine.close(); }
}));
test("revocation racing an external response does not recreate plaintext result authority", async () => fixture(async ({ store, paths, broker, now }) => {
  const engine = new SecretExecutionBroker({ paths, cryptoBroker: broker, secrets: store, now }); await engine.open();
  try {
    const p = await store.prepare({ scope: SCOPE, operationId: "pending-secret", text: "password: pending-value" });
    const ref = p.references[0].reference; let finish, started;
    const dispatched = new Promise(resolve => { started = resolve; });
    const task = engine.execute({ scope: SCOPE, callId: "pending", tool: "fixture", args: { value: ref }, assertCurrent() {}, invoke: args => {
      started(); return new Promise(resolve => { finish = () => resolve({ value: args.value, normal: "order complete" }); });
    } });
    await dispatched; await engine.revokeReference(SCOPE, ref); finish();
    const result = await task; assert(!JSON.stringify(result).includes("pending-value"));
    const display = await engine.display(SCOPE, result.receiptId); assert(!JSON.stringify(display).includes("pending-value"));
    assert.equal(display.result.normal, "order complete");
  } finally { await engine.close(); }
}));
test("a result read that crosses expiry cannot return or later revive its original bytes", async () => fixture(async ({ store, paths, broker, now, setNow }) => {
  const engine = new SecretExecutionBroker({ paths, cryptoBroker: broker, secrets: store, now }); await engine.open();
  const decrypt = broker.decrypt.bind(broker);
  try {
    const input = await store.prepare({ scope: SCOPE, operationId: "expiry-read", text: "password: expiry-race-value" });
    const ref = input.references[0].reference;
    const receipt = await engine.execute({ scope: SCOPE, callId: "expiry-read", tool: "fixture", args: { value: ref }, assertCurrent() {},
      invoke: args => ({ value: args.value, order: 312 }) });
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    broker.decrypt = async value => { entered(); await gate; return decrypt(value); };
    const originalTime = now(), reading = engine.display(SCOPE, receipt.receiptId); await waiting;
    setNow(input.references[0].expiresAt + 1); release();
    const shown = await reading;
    assert(!JSON.stringify(shown).includes("expiry-race-value")); assert.equal(shown.result.order, 312);
    setNow(originalTime); broker.decrypt = decrypt;
    await engine.close(); await engine.open();
    assert(!JSON.stringify(await engine.display(SCOPE, receipt.receiptId)).includes("expiry-race-value"));
  } finally { broker.decrypt = decrypt; await engine.close(); }
}));
test("revocation invalidates an already decrypting local result read", async () => fixture(async ({ store, paths, broker, now }) => {
  const engine = new SecretExecutionBroker({ paths, cryptoBroker: broker, secrets: store, now }); await engine.open();
  const decrypt = broker.decrypt.bind(broker);
  try {
    const input = await store.prepare({ scope: SCOPE, operationId: "revoke-read", text: "password: revoke-race-value" });
    const ref = input.references[0].reference;
    const receipt = await engine.execute({ scope: SCOPE, callId: "revoke-read", tool: "fixture", args: { value: ref }, assertCurrent() {},
      invoke: args => ({ value: args.value, order: 313 }) });
    let entered, release, first = true;
    const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    broker.decrypt = async value => { if (first) { first = false; entered(); await gate; } return decrypt(value); };
    const reading = engine.display(SCOPE, receipt.receiptId); await waiting;
    await engine.revokeReference(SCOPE, ref); release();
    const shown = await reading;
    assert(!JSON.stringify(shown).includes("revoke-race-value")); assert.equal(shown.result.order, 313);
  } finally { broker.decrypt = decrypt; await engine.close(); }
}));
test("an observed expiry at injection is durable across clock rollback and restart", async () => fixture(async ({ store, open, now, setNow }) => {
  const input = await store.prepare({ scope: SCOPE, operationId: "expiry-observed", text: "password: observed-value" });
  const ref = input.references[0].reference, originalTime = now();
  setNow(input.references[0].expiresAt + 1);
  assert.throws(() => store.resolve(SCOPE, ref), { code: "SECRET_REFERENCE_EXPIRED" });
  setNow(originalTime);
  assert.throws(() => store.resolve(SCOPE, ref), { code: "SECRET_REFERENCE_EXPIRED" });
  await store.close(); store = await open();
  assert.throws(() => store.resolve(SCOPE, ref), { code: "SECRET_REFERENCE_EXPIRED" });
}));
test("authenticated saved output recovers completion when the later ledger commit was interrupted", async () => fixture(async ({ store, paths, broker, now }) => {
  let engine = new SecretExecutionBroker({ paths, cryptoBroker: broker, secrets: store, now }); await engine.open(); let calls = 0;
  const input = { scope: SCOPE, callId: "cut-after-result", tool: "fixture", args: {}, assertCurrent() {}, invoke: () => { calls++; return { count: 9, message: "finished once" }; } };
  const record = engine._record.bind(engine);
  engine._record = (id, row) => { if (row.status === "completed") throw Error("simulated ledger cut"); return record(id, row); };
  await assert.rejects(engine.execute(input)); await engine.close();
  for (let restart = 0; restart < 2; restart++) {
    engine = new SecretExecutionBroker({ paths, cryptoBroker: broker, secrets: store, now }); await engine.open();
    const restored = await engine.execute(input); assert.equal(restored.recovered, true); assert.equal(calls, 1);
    assert.equal((await engine.display(SCOPE, restored.receiptId)).result.count, 9); await engine.close();
  }
}));
test("executable source references are rejected before dispatch without affecting ordinary parameters", async () => fixture(async ({ store, paths, broker, now }) => {
  const engine = new SecretExecutionBroker({ paths, cryptoBroker: broker, secrets: store, now }); await engine.open();
  try {
    const p = await store.prepare({ scope: SCOPE, operationId: "source-ref", text: "password: a-longer-value" });
    let calls = 0;
    await assert.rejects(engine.execute({ scope: SCOPE, callId: "source", tool: "fixture", args: { command: p.references[0].reference }, assertCurrent() {}, invoke: () => { calls++; } }), { code: "SECRET_TOOL_NOT_SUPPORTED" });
    assert.equal(calls, 0); assert.equal(engine.list(SCOPE).length, 0);
  } finally { await engine.close(); }
}));
test("private event projection keeps the scanner active for business values and unknown fields", async () => fixture(async ({ store }) => {
  const { projectChatEvent, checkProjectedChatEvent } = require("../app/agent-service/chat-event-projection");
  const { createRunEventStream } = require("../app/agent-service/run-event-stream");
  await store.prepare({ scope: SCOPE, operationId: "short-error", text: "password: error" });
  const check = value => !JSON.stringify(value).includes("error");
  const stream = createRunEventStream({ runId: "event-run", getSnapshot: () => ({}),
    projectSnapshot: (value, context) => projectChatEvent(value, context, text => store.projectText(SCOPE, text)),
    assertSecretSafe: (value, context) => checkProjectedChatEvent(value, context, check) });
  const event = stream.append("tool.result", { tool: { name: "echo", resultSummary: "error occurred; order 111", errorCode: null, success: true } });
  assert(event.payload.tool.resultSummary.includes("order 111")); assert(!event.payload.tool.resultSummary.includes("error"));
  assert.equal(stream.append("terminal", { status: "completed", errorCode: null, resultSummary: "all done" }).payload.status, "completed");
  assert.throws(() => stream.append("tool.result", { unknownField: "error" }), { code: "RUN_EVENT_SECRET_REJECTED" });
  assert.throws(() => stream.append("diagnostic", { text: "error" }), { code: "RUN_EVENT_SECRET_REJECTED" }); stream.close();
}));
