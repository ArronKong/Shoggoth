#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { projectKeyDigests, readCanonicalKeyDigests } = require("../app/core/openclaw-key-digests");

const config = { models: { providers: {
  configured: { apiKey: "sk-configured-fixture-1234" },
  named: { apiKey: "profile:named:team" },
  external: { apiKey: { source: "env", id: "EXTERNAL_KEY" } },
  unresolved: { apiKey: "profile:missing:default" },
  redacted: { apiKey: "__OPENCLAW_REDACTED__" },
} } };
const store = { profiles: {
  "configured:default": { provider: "configured", type: "api_key", key: "sk-old-fixture-0000" },
  "named:default": { provider: "named", type: "api_key", key: "sk-other-fixture-0000" },
  "named:team": { provider: "named", type: "api_key", key: "sk-named-fixture-5678" },
  "renamed:team": { provider: "renamed", type: "api_key", key: "sk-other-fixture-0000" },
  "renamed:default": { provider: "renamed", type: "api_key", key: "sk-renamed-fixture-9012" },
  "external:default": { provider: "external", type: "api_key", key: "sk-other-fixture-0000" },
  "short:default": { provider: "short", type: "api_key", key: "short" },
  "login:default": { provider: "login", type: "oauth", key: "must-not-show-login-token" },
} };
const expected = new Map([
  ["configured", "sk-c...1234"], ["named", "sk-n...5678"], ["renamed", "sk-r...9012"], ["short", "••••••"],
]);

(async () => {
  const before = JSON.stringify({ config, store });
  assert.deepEqual(new Map(projectKeyDigests(config, store)), expected);
  assert.equal(JSON.stringify({ config, store }), before, "preview projection must not change credentials");
  assert.equal(JSON.stringify(projectKeyDigests(config, store)).includes("fixture"), false);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "provider-key-preview-"));
  try {
    fs.writeFileSync(path.join(home, "openclaw.json"), JSON.stringify(config));
    const sdk = path.join(home, "fixture-sdk.mjs");
    fs.writeFileSync(sdk, `export function loadAuthProfileStoreForSecretsRuntime() { return ${JSON.stringify(store)}; }`);
    assert.deepEqual(await readCanonicalKeyDigests({ sdk, home, agentId: "main" }), expected);
    fs.writeFileSync(sdk, 'throw new Error("private-error-must-not-leak");');
    await assert.rejects(readCanonicalKeyDigests({ sdk, home, agentId: "main" }),
      error => error.message === "Provider key previews unavailable" && !JSON.stringify(error).includes("private-error"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("OpenClaw key digests unit: PASS");
})().catch(error => { console.error(error); process.exitCode = 1; });
