"use strict";

// `${secret:NAME}` declarations: grammar, standard-package parser, Codex
// converter and the Service-owned per-installation secret store.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { declaredSecrets, secretReference } = require("../app/core/plugin-secret-placeholders");
const { previewPluginDirectory } = require("../app/agent-service/plugin-package-parser");
const { convertLegacyPluginContents } = require("../app/core/legacy-plugin-content-adapter");
const { PluginSecretStore } = require("../app/agent-service/plugin-secret-store");
const { PluginPackageDeclarations } = require("../app/agent-service/plugin-package-declarations");

const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

// Grammar.
assert.deepEqual(secretReference("${secret:API_TOKEN}"), { name: "API_TOKEN", prefix: "" });
assert.equal(secretReference("Bearer ${secret:API_TOKEN}"), null, "env values have no Bearer prefix");
assert.deepEqual(secretReference("Bearer ${secret:API_TOKEN}", { allowBearer: true }),
  { name: "API_TOKEN", prefix: "Bearer " });
for (const value of ["${secret:api_token}", "prefix-${secret:A}", "${secret:A}-suffix", "${SECRET:A}", "${secret:}"]) {
  assert.equal(secretReference(value, { allowBearer: true }), null, value);
}
assert.deepEqual(declaredSecrets({ type: "stdio", command: "node", args: ["./s.mjs"],
  env: { LUCKIN_MCP_TOKEN: "${secret:LUCKIN_MCP_TOKEN}", MODE: "live" } }).map(item => item.name),
["LUCKIN_MCP_TOKEN"]);
assert.deepEqual(declaredSecrets({ type: "streamable-http", url: "https://mcp.example/mcp",
  headers: { Authorization: "Bearer ${secret:TOKEN}", "X-Workspace": "${secret:WORKSPACE_KEY}" } })
  .map(item => [item.name, item.target, item.key]),
[["TOKEN", "header", "Authorization"], ["WORKSPACE_KEY", "header", "X-Workspace"]]);
for (const record of [
  { type: "stdio", command: "node", args: ["${secret:TOKEN}"] },
  { type: "stdio", command: "node", env: { NODE_OPTIONS: "${secret:TOKEN}" } },
  { type: "stdio", command: "node", env: { TOKEN: "Bearer ${secret:TOKEN}" } },
  { type: "streamable-http", url: "https://x.example/${secret:TOKEN}" },
  { type: "streamable-http", url: "https://x.example/mcp", headers: { Cookie: "${secret:TOKEN}" } },
  { type: "streamable-http", url: "https://x.example/mcp", headers: { Authorization: "token ${secret:TOKEN}" } },
]) assert.equal(declaredSecrets(record), null, JSON.stringify(record));

// Standard package: references are accepted, literal credential headers are not.
function preview(mcpServers) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-secret-parser-"));
  try {
    fs.writeFileSync(path.join(temp, "plugin.json"), JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "secret-demo" }));
    fs.writeFileSync(path.join(temp, "mcp.json"), JSON.stringify({ $schema: MCP_SCHEMA, mcpServers }));
    fs.mkdirSync(path.join(temp, "scripts"));
    fs.writeFileSync(path.join(temp, "scripts/server.mjs"), "export {};\n");
    return previewPluginDirectory(temp);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
const accepted = preview({
  remote: { type: "streamable-http", url: "https://mcp.example/mcp",
    headers: { Authorization: "Bearer ${secret:REMOTE_TOKEN}" } },
  local: { type: "stdio", command: "node", args: ["./scripts/server.mjs"],
    env: { LOCAL_TOKEN: "${secret:LOCAL_TOKEN}" } },
});
assert.deepEqual(accepted.mcpServers.map(item => item.name).sort(), ["local", "remote"]);
assert.equal(accepted.diagnostics.length, 0);
const rejected = preview({
  literal: { type: "streamable-http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer abc123456789" } },
  partial: { type: "stdio", command: "node", args: ["./scripts/server.mjs"], env: { TOKEN: "x-${secret:TOKEN}" } },
});
assert.deepEqual(rejected.mcpServers, []);
assert.deepEqual(rejected.diagnostics.map(item => [item.name, item.reasonCode]).sort(),
  [["literal", "COMPONENT_INVALID"], ["partial", "COMPONENT_INVALID"]]);

// Codex-format source package conversion.
function codexFiles(mcp) {
  return [{ path: ".codex-plugin/plugin.json", content: Buffer.from(JSON.stringify({ name: "codex-secret", version: "1.0.0",
    description: "demo", mcpServers: "./.mcp.json" })), executable: false },
  { path: ".mcp.json", content: Buffer.from(JSON.stringify({ mcpServers: mcp })), executable: false }];
}
function convert(mcp) {
  const result = convertLegacyPluginContents({ format: "codex-plugin", components: ["mcp-servers"], files: codexFiles(mcp) });
  const generated = result.generatedFiles.find(file => file.path === "mcp.json");
  return { servers: generated ? JSON.parse(generated.content.toString("utf8")).mcpServers : {},
    reasons: result.diagnostics.map(item => item.reasonCode) };
}
assert.deepEqual(convert({ shop: { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer ${secret:SHOP_TOKEN}" } } }).servers.shop,
  { type: "streamable-http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer ${secret:SHOP_TOKEN}" } });
assert.deepEqual(convert({ local: { command: "node", args: ["./server.mjs"], env: { API_KEY: "${secret:API_KEY}" } } }).servers.local.env,
  { API_KEY: "${secret:API_KEY}" });
assert.deepEqual(convert({ local: { command: "node", env: { API_KEY: "literal-value" } } }),
  { servers: {}, reasons: ["LEGACY_CREDENTIAL_UNSUPPORTED"] });
assert.deepEqual(convert({ shop: { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer literal" } } }),
  { servers: {}, reasons: ["LEGACY_CREDENTIAL_UNSUPPORTED"] });
// A host environment variable stays unsupported outside the pinned bundled GitHub source.
assert.deepEqual(convert({ shop: { type: "http", url: "https://mcp.example/mcp", bearer_token_env_var: "SHOP_TOKEN" } }).reasons,
  ["LEGACY_MCP_FIELD_UNSUPPORTED"]);

// Per-installation encrypted store (in-memory double of EncryptedSecretStore).
(async () => {
  const values = new Map();
  const secretStore = {
    async get(ref) { return values.get(ref) ?? null; },
    async put(ref, value, metadata) { assert.deepEqual(metadata, { kind: "plugin-secret" }); values.set(ref, value); return { revision: 1 }; },
    async delete(ref) { return values.delete(ref); },
    getCredentialRevision(ref) { return values.has(ref) ? 1 : null; },
  };
  const packages = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-secret-store-"));
  try {
    const digest = "a".repeat(64);
    fs.mkdirSync(path.join(packages, digest));
    fs.writeFileSync(path.join(packages, digest, "mcp.json"), JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: {
      remote: { type: "streamable-http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer ${secret:TOKEN}" } } } }));
    const store = new PluginSecretStore({ secretStore, declarations: new PluginPackageDeclarations({ packagesDir: packages }) });
    assert.deepEqual(store.missing("inst-a", digest, "remote"), ["TOKEN"]);
    await assert.rejects(store.put({ installationId: "inst-a", name: "TOKEN", value: "short" }), { code: "PLUGIN_SECRET_VALUE_INVALID" });
    await assert.rejects(store.put({ installationId: "inst-a", name: "TOKEN", value: "two\nlines-value" }), { code: "PLUGIN_SECRET_VALUE_INVALID" });
    await store.put({ installationId: "inst-a", name: "TOKEN", value: "  sk-live-1234567890  " });
    assert.equal(await store.read("inst-a", "TOKEN"), "sk-live-1234567890", "surrounding whitespace is trimmed");
    assert.deepEqual(store.missing("inst-a", digest, "remote"), []);
    assert.deepEqual(store.missing("inst-b", digest, "remote"), ["TOKEN"], "another installation does not see it");
    assert.notEqual(PluginSecretStore.credentialRef("inst-a", "TOKEN"), PluginSecretStore.credentialRef("inst-b", "TOKEN"));
    await store.delete({ installationId: "inst-a", name: "TOKEN" });
    assert.equal(store.configured("inst-a", "TOKEN"), false);
    await assert.rejects(store.read("inst-a", "lowercase"), { code: "PLUGIN_SECRET_INVALID" });
  } finally { fs.rmSync(packages, { recursive: true, force: true }); }

  // Documentation and declarations that name a credential are not secrets, but
  // whatever follows a placeholder on the same line is still checked.
  const { hasSecret } = require("../app/agent-service/memory-engine");
  for (const text of ["`Authorization: Bearer ${secret:LUCKIN_MCP_TOKEN}`，不再需要桥接脚本。",
    '"headers": { "Authorization": "Bearer ${secret:SERVICE_TOKEN}" }', 'env: { TOKEN: "${secret:SERVICE_TOKEN}" }',
    "token: <token>", "password: ********", "Authorization: Bearer xxx...yyy"]) assert.equal(hasSecret(text), false, text);
  for (const text of ["${secret:X} password: hunter2hunter2", "token: ${secret:A_TOKEN} password: hunter2hunter2",
    "Authorization: Bearer ${secret:A_TOKEN}abcdef123456", "Authorization: Bearer abcdefghijklmnop"]) {
    assert.equal(hasSecret(text), true, text);
  }
  console.log("plugin secret placeholder unit: ok");
})().catch(error => { console.error(error); process.exitCode = 1; });
