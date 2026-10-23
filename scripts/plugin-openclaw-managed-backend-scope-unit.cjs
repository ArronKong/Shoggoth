#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const root = fs.mkdtempSync("/private/tmp/sg-backend-owned-scope-");
fs.chmodSync(root, 0o700);
const makeDir = name => { const dir = path.join(root, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; };
const runtimeRoot = makeDir("runtime"), home = makeDir("home"), stateDir = makeDir("state"), workspace = makeDir("workspace");
const configPath = path.join(stateDir, "openclaw.json"), entryPath = path.join(runtimeRoot, "openclaw.mjs");
const trace = path.join(root, "private-cli-observations.jsonl");
fs.writeFileSync(configPath, JSON.stringify({ agents: { entries: [{ id: "private-agent" }] },
  env: { vars: { SCOPE_CANARY: "private-config-only" } } }), { mode: 0o600 });
fs.writeFileSync(entryPath, `import fs from 'node:fs';
const observation={args:process.argv.slice(2),home:process.env.HOME,state:process.env.OPENCLAW_STATE_DIR,
config:process.env.OPENCLAW_CONFIG_PATH,trace:${JSON.stringify(trace)},cwd:process.cwd(),parentCanary:process.env.PARENT_SCOPE_CANARY||null};
fs.appendFileSync(observation.trace,JSON.stringify(observation)+'\\n');
process.stdout.write(JSON.stringify(observation));`, { mode: 0o400 });
const env = Object.freeze({ HOME: home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
  PATH: "/usr/bin:/bin", NODE_OPTIONS: "", NODE_PATH: "" });
let execution = Object.freeze({ runtimeRoot, interpreterPath: fs.realpathSync(process.execPath),
  entryPath, home, stateDir, configPath, workspace, env });
const backend = new OpenClawBackend({ getManagedExecution: () => execution,
  getUpstreamUrl: () => "ws://127.0.0.1:9", authResolver: {} });
const observations = () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const oldCanary = process.env.PARENT_SCOPE_CANARY;
async function main() {
  try {
    process.env.PARENT_SCOPE_CANARY = "must-not-enter-private-cli";
    assert.equal(backend._localStateRoot(), stateDir);
    assert.equal(backend._localUserHome(), home);
    assert.equal(backend._authProfilesPath(), path.join(stateDir, "agents/auth-profiles.json"));
    backend._authProfilesPathOverride = "/private/tmp/old-user-auth.json";
    backend._registryPathOverride = "/private/tmp/old-user-models.json";
    assert.equal(backend._authProfilesPath(), path.join(stateDir, "agents/auth-profiles.json"));
    assert.equal(backend._registryPath(), path.join(stateDir, "agents/models.json"));
    assert.deepEqual(await backend.revealEnvVar("SCOPE_CANARY"), { value: "private-config-only" });
    const observed = await backend._runModelAuthCli(["models", "auth", "list"], { json: true });
    assert.equal(observed.home, home); assert.equal(observed.state, stateDir);
    assert.equal(observed.config, configPath); assert.equal(observed.cwd, workspace);
    assert.equal(observed.parentCanary, null);
    assert.deepEqual(observed.args, ["--no-color", "models", "auth", "list"]);
    assert.deepEqual(backend.getSelfUpdateStatus(), { supported: false, reason: "managed-runtime" });
    await assert.rejects(backend.activateModelConfig(), { code: "managed_model_transaction_required" });
    assert.equal(observations().length, 1, "unowned restart/update must never execute the old global CLI");
    console.log("PASS actual private CLI/config/auth roots, isolated env, and no global updater/restart");

    execution = null;
    backend._modelConfigCache = { providers: [{ key: "old-private-provider" }] };
    backend._canonicalAuthProfiles = [{ id: "old-private-profile" }];
    backend._openClawCliVersion = "old-private-version";
    assert.throws(() => backend._localStateRoot(), { code: "MANAGED_PLUGIN_HOST_UNAVAILABLE" });
    assert.equal(backend._modelConfigCache, null);
    assert.equal(backend._canonicalAuthProfiles, null);
    assert.equal(backend._openClawCliVersion, undefined);
    await assert.rejects(backend._connect(), { code: "MANAGED_PLUGIN_HOST_UNAVAILABLE" });
    await assert.rejects(backend._runModelAuthCli(["models", "auth", "list"]));
    assert.equal(observations().length, 1, "unverified managed scope must not fall back or launch");
    console.log("PASS unavailable managed scope has zero global fallback/CLI/WebSocket");

    const siblingConfig = path.join(root, "openclaw.json");
    fs.copyFileSync(configPath, siblingConfig); fs.chmodSync(siblingConfig, 0o600);
    execution = { runtimeRoot, interpreterPath: fs.realpathSync(process.execPath), entryPath,
      home, stateDir, configPath: siblingConfig, workspace,
      env: { ...env, OPENCLAW_CONFIG_PATH: siblingConfig } };
    assert.equal(backend._localConfigPath(), siblingConfig);
    assert.deepEqual(await backend.revealEnvVar("SCOPE_CANARY"), { value: "private-config-only" });
    const foreignConfig = path.join(fs.realpathSync(require("node:os").tmpdir()), `sgh-foreign-config-${process.pid}.json`);
    fs.copyFileSync(configPath, foreignConfig); fs.chmodSync(foreignConfig, 0o600);
    try {
      execution = { ...execution, configPath: foreignConfig, env: { ...execution.env, OPENCLAW_CONFIG_PATH: foreignConfig } };
      assert.throws(() => backend._localConfigPath(), { code: "MANAGED_PLUGIN_HOST_UNAVAILABLE" });
    } finally { fs.unlinkSync(foreignConfig); }
    console.log("PASS real Supervisor sibling config belongs to the common private root; foreign config rejects");

    const linkedState = path.join(root, "linked-state"); fs.symlinkSync(stateDir, linkedState);
    execution = { runtimeRoot, interpreterPath: fs.realpathSync(process.execPath), entryPath,
      home, stateDir: linkedState, configPath, workspace,
      env: { ...env, OPENCLAW_STATE_DIR: linkedState } };
    await assert.rejects(backend._runModelAuthCli(["models", "auth", "list"]));
    assert.equal(observations().length, 1);
    console.log("PASS substituted/symlinked private scope refuses launch");

    execution = undefined;
    assert.equal(backend._localUserHome(), require("node:os").homedir());
    assert.throws(() => new OpenClawBackend({ getManagedExecution: () => null }), /App-private authentication/u);
    console.log("PASS explicit legacy selection retained; managed requires explicit App auth");
    console.log(JSON.stringify({ ok: true, groups: 5, actualPrivateCliExecutions: 1, globalCliExecutions: 0, remoteCalls: 0 }));
  } finally {
    if (oldCanary === undefined) delete process.env.PARENT_SCOPE_CANARY; else process.env.PARENT_SCOPE_CANARY = oldCanary;
    await backend.stop(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
