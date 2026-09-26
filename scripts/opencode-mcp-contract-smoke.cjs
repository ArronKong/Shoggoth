#!/usr/bin/env node
"use strict";

// Real OpenCode server and Shoggoth MCP helper, no model call or user account data.
// The helper anchors Service paths to os.userInfo(), so this isolated test injects
// its temporary home into the helper process before the normal bootstrap runs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

async function main() {
  // Keep the Unix socket below macOS's sockaddr_un path limit.
  const root = fs.mkdtempSync("/private/tmp/so-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const paths = resolveServicePaths({ homeDir: root });
  const preload = path.join(root, "isolated-user-home.cjs");
  fs.writeFileSync(preload, `const os = require("node:os");\n`
    + `const original = os.userInfo;\n`
    + `os.userInfo = (...args) => ({ ...original(...args), homedir: ${JSON.stringify(root)} });\n`,
  { mode: 0o600 });
  const issuer = new RuntimeMcpGateIssuer({ paths,
    mcpHelperLaunch: { command: process.execPath, argsPrefix: [] } });
  const reserve = issuer.reserveMcpServer.bind(issuer);
  issuer.reserveMcpServer = (input) => {
    const gate = reserve(input);
    return { ...gate, args: ["--require", preload, ...gate.args] };
  };
  const service = createAgentService({ paths, runtimeMcpGateIssuer: issuer,
    runtimeStorageHomedir: () => root, parentEnv: process.env,
    version: "opencode-mcp-contract-smoke", builtinCliProfiles: true,
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => Buffer.from(value).toString("utf8") } });
  try {
    await service.start();
    const host = await service.openCodeRuntimePool.get({ runtime: "opencode",
      runtimeProfileId: "shoggoth-opencode-cli-v1",
      runtimeAccountId: NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID },
    { workspace, permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" } });
    let state = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      state = (await host.client.request("GET", "/mcp")).data?.shoggoth?.status ?? null;
      if (state === "connected" || state === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(state, "connected", "OpenCode must connect to the authenticated Shoggoth MCP gate");
    console.log("PASS OpenCode MCP contract: isolated helper and authenticated Service bridge connected");
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => {
  console.error(`${error?.code || "OPENCODE_MCP_CONTRACT_FAILED"}: ${error?.message || "contract failed"}`);
  process.exitCode = 1;
});
module.exports = { main };
