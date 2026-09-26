"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { QUESTIONS } = require("./runtime-handoff-dialogue.cjs");
const home = process.env.HOME;
assert.ok(home.startsWith("/tmp/sghandoff-pi-"));
assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(home));
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.CODEX_HOME, undefined);
if (process.env.SHOGGOTH_HANDOFF_PROXY) {
  assert.equal(process.env.HTTP_PROXY, process.env.SHOGGOTH_HANDOFF_PROXY);
  assert.equal(process.env.HTTPS_PROXY, process.env.SHOGGOTH_HANDOFF_PROXY);
  assert.equal(process.env.NODE_USE_ENV_PROXY, "1");
} else assert.equal(process.env.HTTP_PROXY, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(home, "agent"));
const providers = JSON.parse(fs.readFileSync(path.join(home, "agent", "models.json"))).providers;
const providerId = Object.keys(providers)[0];
const provider = providers[providerId];
if (providerId === "openai-codex") {
  const authPath = path.join(home, "agent", "auth.json");
  const credentials = JSON.parse(fs.readFileSync(authPath));
  assert.deepEqual(Object.keys(credentials), ["openai-codex"]);
  assert.equal(credentials["openai-codex"].type, "oauth");
  assert.equal(process.env.SHOGGOTH_HANDOFF_OAUTH, "openai-codex");
  // Simulated refresh may only rewrite the temporary credential copy.
  credentials["openai-codex"].access = "refreshed-isolated-fixture-access";
  fs.writeFileSync(authPath, JSON.stringify(credentials));
}
const model = { ...provider.models[0], provider: providerId, baseUrl: provider.baseUrl };
let received = 0;
const reader = readline.createInterface({ input: process.stdin });
const send = event => process.stdout.write(`${JSON.stringify(event)}\n`);
reader.on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "get_state") { send({ type: "response", id: request.id, success: true, data: { model } }); return; }
  const question = QUESTIONS[received++];
  assert.equal(request.id, question.id);
  assert.ok(request.message.includes(question.question));
  if (received === 1) assert.ok(request.message.includes("Museum Atlas"));
  else assert.equal(request.message.includes("BEGIN UNTRUSTED PRIOR TRANSCRIPT DATA"), false);
  send({ type: "response", id: request.id, success: true });
  send({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: question.answer }] }] });
});
reader.on("close", () => {
  assert.equal(received, 5);
  if (model.id === "fake-failing-exit") process.exitCode = 7;
});
