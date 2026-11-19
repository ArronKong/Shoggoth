"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assertPrivateDirectory } = require("../../app/agent-service/security");
const { readPrivateFile } = require("../../app/agent-service/private-file");
const { resolveServicePaths } = require("../../app/agent-service/paths");

// The launcher pins this directory in its bootstrap. Native CLIs may replace HOME.
module.exports = async function startHelper(root) {
  if (path.dirname(root) !== "/private/tmp" || !/^sgbg-[A-Za-z0-9]{6}$/u.test(path.basename(root))
    || fs.realpathSync(root) !== root) throw new Error("BACKGROUND_LIVE_ROOT_INVALID");
  assertPrivateDirectory(root);
  if (process.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE !== undefined) {
    return require("../../app/bootstrap-role").main(process.argv.slice(1), process.env,
      { userInfo: () => ({ homedir: root }) });
  }

  const key = readPrivateFile(path.join(root, "mcp-key.bin"), { maxBytes: 32 });
  try {
    if (key.length !== 32) throw new Error("BACKGROUND_LIVE_KEY_INVALID");
    const { startShoggothMcpHelper } = require("../../app/shoggoth-mcp-helper");
    const { makeSafeStorage } = require("../group-collaboration-live-worker.cjs");
    await startShoggothMcpHelper({ paths: resolveServicePaths({ homeDir: root }),
      safeStorage: makeSafeStorage(key), electronApp: { whenReady: async () => {}, quit() {} },
      serviceVersion: "background-live" });
  } finally {
    key.fill(0);
  }
};
