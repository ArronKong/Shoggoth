"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { browserError } = require("./browser-use-protocol");

// Playwright reads and executes package assets using physical paths in packaged Apps.
function loadPlaywrightMcp() {
  try {
    const packagePath = require.resolve("@playwright/mcp/package.json").replace(/app\.asar(?=[/\\])/u, "app.asar.unpacked");
    const localRequire = createRequire(packagePath);
    const version = localRequire("./package.json").version;
    if (version !== "0.0.82") throw new Error("unexpected engine version");
    return { version, createConnection: localRequire("@playwright/mcp").createConnection,
      chromium: localRequire("playwright-core").chromium };
  } catch { throw browserError("BROWSER_ENGINE_UNAVAILABLE"); }
}

function browserExecutable(browser, platform = process.platform) {
  const locations = platform === "darwin" ? {
    chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    msedge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  } : platform === "linux" ? { chrome: "/opt/google/chrome/chrome", msedge: "/opt/microsoft/msedge/msedge" } : {};
  const target = locations[browser];
  try {
    if (!target || !fs.statSync(target).isFile()) throw new Error("missing browser");
    fs.accessSync(target, fs.constants.X_OK);
    return target;
  } catch { throw browserError("BROWSER_EXECUTABLE_UNAVAILABLE"); }
}

async function createPlaywrightMcpClient({ settings, workspace, profileDirectory, sessionId, assertCurrent }) {
  const { Client, InMemoryTransport } = require("@modelcontextprotocol/client");
  const api = loadPlaywrightMcp();
  const launchOptions = { executablePath: browserExecutable(settings.browser),
    headless: settings.headless, chromiumSandbox: true, timeout: 20_000 };
  let browser, context, server, client;
  const close = async () => {
    const results = await Promise.allSettled([client?.close(), server?.close(), context?.close(), browser?.close()]);
    if (results.some(result => result.status === "rejected")) throw browserError("BROWSER_SESSION_CLOSE_FAILED");
  };
  try {
    if (settings.isolated) {
      browser = await api.chromium.launch(launchOptions);
      context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    } else context = await api.chromium.launchPersistentContext(profileDirectory, {
      ...launchOptions, viewport: { width: 1280, height: 800 },
    });
    server = await api.createConnection({
      // The owned context already determines persistence. SimpleBrowser must reuse it.
      browser: { isolated: false }, capabilities: ["core"], webmcp: false,
      allowUnrestrictedFileAccess: false, imageResponses: "omit", filePaths: "absolute",
      outputDir: path.join(workspace, "browser-output", sessionId), codegen: "none",
      timeouts: { action: 5000, navigation: 30_000 },
    }, async () => context);
    const [local, remote] = InMemoryTransport.createLinkedPair();
    const send = local.send.bind(local);
    local.send = (message, options) => {
      if (message.method === "tools/call") assertCurrent();
      return send(message, options);
    };
    client = new Client({ name: "shoggoth-browser-use", version: "1" }, {
      capabilities: { roots: { listChanged: false } },
      cachePartition: sessionId, versionNegotiation: { mode: "auto" },
      inputRequired: { autoFulfill: false },
    });
    client.setRequestHandler("roots/list", async () => ({ roots: [{ uri: pathToFileURL(workspace).href, name: "workspace" }] }));
    await server.connect(remote);
    await client.connect(local);
    return {
      listTools: async () => (await client.listTools(undefined, { timeout: 15_000, cacheMode: "refresh" })).tools,
      callTool: async (name, args) => client.callTool({ name, arguments: args }, { timeout: 40_000 }),
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

module.exports = { loadPlaywrightMcp, browserExecutable, createPlaywrightMcpClient };
