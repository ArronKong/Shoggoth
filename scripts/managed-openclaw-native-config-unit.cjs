"use strict";

// Explicit source fixture only: a fresh private HOME/state, never the user's
// Gateway, auth DB or installed config. Set the root to an audited 2026.9.5 tree.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { runNativeModelMethod } = require("../app/managed-openclaw-native-config");

const runtimeRoot = process.env.SHOGGOTH_TEST_NATIVE_OPENCLAW_ROOT;
test("owned bridge rejects arbitrary Gateway methods before starting a child", async () => {
  await assert.rejects(runNativeModelMethod({ method: "chat.send", params: {}, deadlineAt: Date.now() + 10000, assertCurrent: () => true }),
    error => error.code === "MANAGED_NATIVE_METHOD_INVALID");
});

test("pinned official unified credentials replace a local builtin override and clear API Keys while retaining token auth", {
  skip: !runtimeRoot && "explicit audited OpenClaw source fixture required", timeout: 120000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-native-unified-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["home", "state", "workspace"]) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
  const execution = { interpreterPath: process.env.SHOGGOTH_TEST_OPENCLAW_NODE || path.join(os.homedir(), ".local/share/node/v24.21.0/bin/node"),
    home: path.join(root, "home"), stateDir: path.join(root, "state"), workspace: path.join(root, "workspace"), configPath: path.join(root, "openclaw.json") };
  const otherDir = path.join(execution.stateDir, "agents", "other", "agent");
  fs.mkdirSync(otherDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(execution.configPath, JSON.stringify({ gateway: { mode: "local", reload: { mode: "off" } },
    agents: { ownership: "explicit", defaults: { workspace: execution.workspace }, entries: { main: {}, other: { agentDir: otherDir } } },
    models: { catalogRefresh: { enabled: false }, providers: {} } }), { mode: 0o600 });
  const inspect = action => {
    const source = `
      import path from 'node:path';import {pathToFileURL} from 'node:url';
      console.log=console.info=console.warn=console.error=()=>{};
      const root=process.argv[1],agentDir=process.argv[2];
      const profiles=await import(pathToFileURL(path.join(root,'dist/profiles-DrvuyPw9.mjs')));
      const stores=await import(pathToFileURL(path.join(root,'dist/store-runtime-D8__yyKr.mjs')));
      if(process.argv[3]==='seed'){
        await profiles.u({agentDir,profileId:'groq:local',credential:{type:'api_key',provider:'groq',key:'synthetic-old-local-key'}});
        await profiles.u({agentDir,profileId:'groq:token',credential:{type:'token',provider:'groq',token:'synthetic-preserved-token'}});
        await profiles.o({agentDir,provider:'groq',order:['groq:local','groq:token']});
      }
      const store=stores.c(agentDir);
      process.stdout.write(JSON.stringify({localUpdated:store.profiles['groq:local']?.key==='synthetic-unified-key',
        apiKeys:Object.values(store.profiles).filter(row=>row.provider==='groq'&&row.type==='api_key').length,
        tokenPreserved:store.profiles['groq:token']?.token==='synthetic-preserved-token'}));`;
    const result = spawnSync(execution.interpreterPath, ["--input-type=module", "-e", source, runtimeRoot, otherDir, action], {
      encoding: "utf8", timeout: 30000, cwd: execution.workspace, env: { HOME: execution.home,
        PATH: `${path.dirname(execution.interpreterPath)}:/usr/bin:/bin`, LANG: "en_US.UTF-8", TMPDIR: "/private/tmp",
        OPENCLAW_STATE_DIR: execution.stateDir, OPENCLAW_CONFIG_PATH: execution.configPath, OPENCLAW_NO_AUTO_UPDATE: "1" },
    });
    assert.equal(result.status, 0, "isolated official credential store fixture must succeed");
    return JSON.parse(result.stdout);
  };
  assert.equal(inspect("seed").tokenPreserved, true);
  const call = (method, params) => runNativeModelMethod({ runtimeRoot, dataRoot: root, execution, method, params,
    deadlineAt: Date.now() + 90000, assertCurrent: () => true });
  const scope = { provider: "groq", credentialScope: "provider", agentIds: ["main", "other"], configuredConnection: false };
  const saved = await call("models.authSetApiKey", { ...scope, apiKey: "synthetic-unified-key" });
  assert.equal(saved.complete, true);
  assert.deepEqual(saved.agentIds, ["main", "other"]);
  assert.equal(inspect("read").localUpdated, true);
  assert.equal(inspect("read").tokenPreserved, true);
  const cleared = await call("models.authLogout", scope);
  assert.equal(cleared.complete, true);
  assert.deepEqual(cleared.agentIds, ["main", "other"]);
  assert.equal(inspect("read").apiKeys, 0);
  assert.equal(inspect("read").tokenPreserved, true);
  const actual = JSON.parse(fs.readFileSync(execution.configPath, "utf8"));
  assert.deepEqual(actual.models.providers, {});
});

test("pinned official config and auth handlers preserve bindings, save one scoped Key and clear it", { skip: !runtimeRoot && "explicit audited OpenClaw source fixture required", timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-native-handler-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["home", "state", "workspace"]) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
  const execution = { interpreterPath: process.env.SHOGGOTH_TEST_OPENCLAW_NODE || path.join(os.homedir(), ".local/share/node/v24.21.0/bin/node"),
    home: path.join(root, "home"), stateDir: path.join(root, "state"), workspace: path.join(root, "workspace"), configPath: path.join(root, "openclaw.json") };
  const initial = { gateway: { mode: "local", reload: { mode: "off" } },
    agents: { ownership: "explicit", defaults: { workspace: execution.workspace, model: { primary: "xmxm/old" } }, entries: { main: {}, other: {} } },
    models: { catalogRefresh: { enabled: false }, providers: { xmxm: { baseUrl: "https://fixture.invalid/v1", api: "openai-completions", models: [
      { id: "old", name: "Old", input: ["text", "image"], contextTokens: 64000 },
    ] } } } };
  fs.writeFileSync(execution.configPath, JSON.stringify(initial), { mode: 0o600 });
  const call = (method, params) => runNativeModelMethod({ runtimeRoot, dataRoot: root, execution, method, params,
    deadlineAt: Date.now() + 90000, assertCurrent: () => true }).catch(error => {
      if (error.code === "MANAGED_NATIVE_OUTCOME_UNKNOWN") console.error("native fixture diagnostic", error.nativeStage, error.nativeCode);
      throw error;
    });
  const draft = structuredClone(initial);
  draft.models.providers.xmxm.models = [];
  const baseHash = crypto.createHash("sha256").update(fs.readFileSync(execution.configPath)).digest("hex");
  assert.equal((await call("config.set", { raw: JSON.stringify(draft), baseHash })).ok, true);
  let actual = JSON.parse(fs.readFileSync(execution.configPath, "utf8"));
  assert.deepEqual(actual.models.providers.xmxm.models, []);
  assert.equal(actual.agents.defaults.model.primary, "xmxm/old");
  await assert.rejects(call("config.set", { raw: JSON.stringify(initial), baseHash }), error => error.code === "INVALID_REQUEST" && error.gatewayResponse === true);
  const saved = await call("models.authSetApiKey", { provider: "xmxm", agentId: "other", apiKey: "fixture-key-no-real-account" });
  assert.equal(saved.provider, "xmxm");
  assert.equal(typeof saved.profileId, "string");
  actual = JSON.parse(fs.readFileSync(execution.configPath, "utf8"));
  assert.equal(actual.models.providers.xmxm.apiKey, saved.profileId);
  assert.equal(actual.agents.defaults.model.primary, "xmxm/old");
  const cleared = await call("models.authLogout", { provider: "xmxm", agentId: "other", credentialType: "api_key" });
  assert.equal(cleared.provider, "xmxm");
  assert.ok(cleared.removedProfiles.includes(saved.profileId));
  actual = JSON.parse(fs.readFileSync(execution.configPath, "utf8"));
  assert.ok(actual.models.providers.xmxm);
  assert.equal(actual.agents.defaults.model.primary, "xmxm/old");
  const { buildOpenClawModelDraft } = require("../app/core/openclaw-model-config-draft");
  const { nativeTargetMatches } = require("../app/managed-openclaw-model-policy");
  const spec = { kind: "create", providerKey: "xmxm", providerMode: "existing", model: { id: "minimal", name: "Minimal" } };
  const plan = buildOpenClawModelDraft(actual, spec), beforeAdd = actual;
  const freshHash = crypto.createHash("sha256").update(fs.readFileSync(execution.configPath)).digest("hex");
  await call("config.set", { raw: JSON.stringify(plan.config), baseHash: freshHash });
  actual = JSON.parse(fs.readFileSync(execution.configPath, "utf8"));
  assert.equal(nativeTargetMatches(actual, spec, beforeAdd), true, "official normalization must match the managed loaded target contract");
});
