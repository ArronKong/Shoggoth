#!/usr/bin/env node
"use strict";

// Real installed CLI and loopback protocol, isolated XDG data/config and no model traffic.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeAccountResolver } = require("../app/agent-service/runtime-account-resolver");
const { DEFAULT_RUNTIME_ACCOUNTS, NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { OpenCodeRuntimeHost } = require("../app/agent-service/opencode-runtime-host");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-opencode-contract-"));
  const workspace = path.join(root, "workspace");
  for (const name of ["home", "data", "state", "workspace", "config", "config/opencode"]) {
    fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  }
  const nativeConfig = path.join(root, "config", "opencode", "opencode.jsonc");
  const nativeConfigContent = '{\n  // Native model selection should survive the private config copy.\n'
    + '  "model": "opencode/mimo-v2.6-flash-free",\n  "permission": { "*": "allow" }\n}\n';
  fs.writeFileSync(nativeConfig, nativeConfigContent);
  // A project may try to loosen global rules. Shoggoth's inline rules must win.
  fs.writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({ permission: { "*": "allow" } }));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  const binding = { runtime: "opencode", runtimeProfileId: "contract-smoke",
    runtimeAccountId: NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID };
  const account = DEFAULT_RUNTIME_ACCOUNTS.find(item => item.id === NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID);
  const parentEnv = { PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root };
  const resolver = new RuntimeAccountResolver({ paths, parentEnv, homedir: path.join(root, "home") });
  const environment = resolver.resolve(binding, account);
  const permissionPolicy = { approvalPolicy: "on-request", sandbox: "danger-full-access" };
  const makeHost = () => new OpenCodeRuntimeHost({ paths, runtimeBinding: binding,
    runtimeEnvironment: environment, workspace, permissionPolicy, parentEnv });
  const first = makeHost();
  let second = null, sessionId = null;
  try {
    await first.initialize();
    const configuration = (await first.client.request("GET", "/config")).data;
    assert.equal(configuration.permission?.["*"], "ask");
    assert.equal(configuration.model, "opencode/mimo-v2.6-flash-free");
    const created = await first.sessionStart({ source: "contract-smoke", cwd: workspace, permissionPolicy });
    sessionId = created.session.id;
    await first.stop();
    second = makeHost();
    await second.initialize();
    const resumed = await second.sessionResume({ sessionId, cwd: workspace, permissionPolicy });
    assert.equal(resumed.session.id, sessionId);
    const native = (await second.client.request("GET", `/session/${sessionId}`)).data;
    assert.deepEqual(native.permission, [{ permission: "*", pattern: "*", action: "ask" }],
      "resume must not append duplicate permission rules");
    const read = await second.sessionRead({ sessionId, includeTurns: true });
    assert.equal(read.session.id, sessionId);
    await second.sessionDelete({ sessionId });
    sessionId = null;
    assert.equal((await second.sessionList()).data.length, 0);
    assert.equal(fs.readFileSync(nativeConfig, "utf8"), nativeConfigContent);
    assert.deepEqual(fs.readdirSync(path.dirname(nativeConfig)), ["opencode.jsonc"]);
    console.log("PASS OpenCode native contract: authenticated private server, effective ask, session restart and deletion");
  } finally {
    if (sessionId && second?.state === "ready") await second.sessionDelete({ sessionId }).catch(() => {});
    await second?.stop().catch(() => {});
    await first.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => {
  console.error(`${error?.code || "OPENCODE_CONTRACT_FAILED"}: ${error?.message || "contract failed"}`);
  process.exitCode = 1;
});
module.exports = { main };
