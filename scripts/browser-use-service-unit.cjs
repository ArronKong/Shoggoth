"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { createConfigStore } = require("../app/core/config-store");
const { browserError } = require("../app/agent-service/browser-use-protocol");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-bu-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "data"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const config = createConfigStore(path.join(paths.userDataRoot, "config.json"));
  config.ensure();
  let launches = 0, installed = true;
  const service = createAgentService({ paths, parentEnv: {}, prewarmMcpAuth: false,
    browserEngineStatus: () => "0.0.82", browserExecutable: browser => {
      assert.equal(browser, "chrome");
      if (!installed) throw browserError("BROWSER_EXECUTABLE_UNAVAILABLE"); return "/fake/chrome";
    }, browserClientFactory: () => { launches++; throw new Error("status must not launch"); } });
  const rpc = (params = {}, token = readClientToken(paths)) => requestService(paths,
    { token, version: SERVICE_PROTOCOL_VERSION, method: "browser.status", params }, { timeoutMs: 10_000 });
  try {
    await service.start();
    await assert.rejects(rpc({}, "untrusted"), { code: "AUTH_FAILED" });
    await assert.rejects(rpc({ profileId: "forged" }), { code: "INVALID_PARAMS" });
    assert.equal((await rpc()).available, true);
    config.write({ browserUse: { enabled: false, browser: "chrome", headless: false, isolated: true } });
    assert.equal((await rpc()).reason, "BROWSER_DISABLED");
    config.write({ browserUse: { enabled: true, browser: "msedge", headless: true, isolated: false } });
    assert.equal((await rpc()).browser, "chrome", "macOS config must keep Chrome fixed");
    installed = false;
    const missing = await rpc();
    assert.equal(missing.browser, "chrome"); assert.equal(missing.reason, "BROWSER_EXECUTABLE_UNAVAILABLE");
    assert.equal(launches, 0); assert.deepEqual(missing.sessions, []);
    console.log("PASS Browser Use Service: authenticated global status, exact params, live shared config, no browser launch");
  } finally {
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
