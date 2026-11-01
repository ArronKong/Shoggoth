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
    headless: settings.headless, chromiumSandbox: true, timeout: 60_000 };
  let browser, context, server, client;
  const secretValues = new Map(), secretConfig = Object.create(null);
  const setSecrets = bindings => {
    for (const { reference, value } of bindings) {
      if (secretValues.has(reference)) continue;
      const bytes = Buffer.from(value); secretValues.set(reference, bytes);
      const variants = [() => bytes.toString(), () => encodeURIComponent(bytes.toString()), () => bytes.toString("base64")];
      variants.forEach((read, index) => Object.defineProperty(secretConfig, `${reference}:${index}`, {
        enumerable: true, configurable: true, get: read,
      }));
    }
  };
  const close = async () => {
    const results = await Promise.allSettled([client?.close(), server?.close(), context?.close(), browser?.close()]);
    if (results.some(result => result.status === "rejected")) throw browserError("BROWSER_SESSION_CLOSE_FAILED");
    for (const bytes of secretValues.values()) bytes.fill(0);
    secretValues.clear(); for (const name of Object.keys(secretConfig)) delete secretConfig[name];
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
      // 0.0.82 writes automatic snapshots to files. Explicit snapshots without a
      // filename are inline. The locked engine also applies secrets before its
      // console/file writes; the broker separately projects the model response.
      snapshot: { mode: "none" }, saveSession: false, secrets: secretConfig,
      timeouts: { action: 15_000, navigation: 120_000 },
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
      setSecrets,
      callTool: async (name, args) => {
        if (secretValues.size && Object.hasOwn(args, "filename")) { args = { ...args }; delete args.filename; }
        const result = await client.callTool({ name, arguments: args }, { timeout: 150_000 });
        if (["browser_navigate", "browser_navigate_back", "browser_click", "browser_type", "browser_fill_form", "browser_tabs"].includes(name)
          && !result.isError) {
          try {
            assertCurrent();
            const snapshot = await client.callTool({ name: "browser_snapshot", arguments: {} }, { timeout: 15_000 });
            result.content = [...(result.content || []), ...(snapshot.content || [])];
          } catch {
            result.content = [...(result.content || []), { type: "text", text: "The browser operation completed; its follow-up snapshot is unavailable. Do not repeat the operation." }];
          }
        }
        // Retain the engine's credential references. This generic result may
        // reach a Runtime directly and must never restore plaintext.
        return result;
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

module.exports = { loadPlaywrightMcp, browserExecutable, createPlaywrightMcpClient };
