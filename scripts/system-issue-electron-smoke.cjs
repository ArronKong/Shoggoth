#!/usr/bin/env electron
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { startStaticServer } = require("../app/static-server");
const { BackendRegistry } = require("../app/core/backend-registry");
const { createDesktopSystemIssueReporter } = require("../app/desktop-system-issue");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-system-issue-ui-"));
app.setPath("userData", path.join(root, "electron"));
app.setPath("sessionData", path.join(root, "session"));
app.disableHardwareAcceleration();
process.on("uncaughtException", error => { console.error(error); app.exit(1); });
process.on("unhandledRejection", error => { console.error(error); app.exit(1); });
const timer = setTimeout(() => { console.error("System issue UI smoke timed out"); app.exit(1); }, 45_000);

app.whenReady().then(async () => {
  let server, window, reporter, fileError = null, failWrite = false, writes = 0, now = 100_000, dialogs = 0, generation = 0;
  const evidence = [], originalReadFile = fs.readFile, originalDialog = dialog.showErrorBox;
  const config = { locale: "zh-CN", theme: "light", setupCompletedAt: 1, gatewayUrl: "", token: "" };
  const canary = "PRIVATE_STORAGE_FAILURE_CANARY";
  const assetDirectory = path.resolve(__dirname, "../app/manage-ui/dist/assets");
  const page = fs.readdirSync(assetDirectory).find(name => /^AgentsPage-.*\.js$/.test(name));
  assert.ok(page, "build the production UI before running this smoke");
  const asset = path.join(assetDirectory, page);
  const chatAsset = path.join(assetDirectory, fs.readdirSync(assetDirectory).find(name => /^ChatPage-.*\.js$/.test(name)));
  let failedAsset = asset;
  const error = code => Object.assign(new Error(`${canary}: ${asset}`), { code });
  const js = code => window.webContents.executeJavaScript(code);
  async function until(code, label) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function inspect(title) {
    await until(`Array.from(document.querySelectorAll('[class*="toastTitle"]')).some(node => node.textContent === ${JSON.stringify(title)})`, title);
    const result = await js(`(() => {
      const nodes = Array.from(document.querySelectorAll('[class*="toastTitle"]'));
      const matching = nodes.filter(node => node.textContent === ${JSON.stringify(title)});
      const rect = matching[0].parentElement.getBoundingClientRect();
      return { titles: nodes.map(node => node.textContent), count: matching.length,
        top: rect.top, right: innerWidth - rect.right, width: rect.width,
        shell: !!document.querySelector('.sidebar'),
        fallback: !!document.querySelector('main [role="status"] button'),
        leaked: document.body.innerText.includes(${JSON.stringify(canary)}) };
    })()`);
    assert.equal(result.count, 1);
    assert.equal(result.shell, true); assert.equal(result.leaked, false);
    assert.ok(result.top >= 0 && result.top <= 40, "toast must be at the top");
    assert.ok(result.right >= 0 && result.right <= 40, "toast must be on the right");
    assert.ok(result.width <= 360, "toast must fit the existing stack width");
    evidence.push({ title, ...result });
    return result;
  }
  async function reload() {
    now += 30_000;
    fileError = null; failWrite = false;
    // A hash-only loadURL can reuse the old document and its rejected lazy
    // import. A new query forces a fresh document, like the user's Reload action.
    await window.loadURL(`${server.url}/?fixture=${++generation}#/components`);
    await until("!!document.querySelector('.sidebar') && typeof window.openclawDesktop.onSystemIssue === 'function'", "React shell and notification bridge");
    // Let effects register the preload subscription before fault injection.
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  }
  try {
    dialog.showErrorBox = () => { dialogs++; };
    ipcMain.on("openclaw:get-config", event => { event.returnValue = { ...config, effectiveLocale: config.locale }; });
    reporter = createDesktopSystemIssueReporter({ ipcMain, getMainWindow: () => window,
      getUiOrigin: () => server?.url, now: () => now });
    server = await startStaticServer(0, { registry: new BackendRegistry(), homeDir: path.join(root, "home"),
      userDataRoot: path.join(root, "data"), onSystemIssue: (fault, fallback) => reporter.report(fault, fallback),
      configStore: { read: () => ({ ...config }), write: patch => {
        writes++; if (failWrite) throw error("ENOSPC"); Object.assign(config, patch); return { ...config };
      } },
    });
    window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
      preload: path.resolve(__dirname, "../app/preload.js"), sandbox: true,
      contextIsolation: true, nodeIntegration: false,
    } });
    const preloadErrors = [];
    window.webContents.on("preload-error", (_event, _file, fault) => preloadErrors.push(String(fault)));
    window.webContents.on("did-start-navigation", (details, _url, sameDocument, mainFrame) => {
      if ((details.isMainFrame ?? mainFrame) && !(details.isSameDocument ?? sameDocument)) reporter.reset();
    });
    fs.readFile = function (file, ...args) {
      if (file === failedAsset && fileError) { process.nextTick(args.at(-1), error(fileError)); return; }
      return originalReadFile.call(this, file, ...args);
    };

    // A failure before React is ready still appears once after its subscriber mounts.
    reporter.report(error("ENOSPC"));
    await reload();
    const chinese = "磁盘空间不足。请释放空间后重试。";
    await inspect(chinese);
    failWrite = true;
    const responses = await js(`(async () => {
      const results = [];
      for (let i = 0; i < 3; i++) {
        const response = await fetch('/__api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"theme":"dark"}' });
        results.push({ status: response.status, body: await response.json() });
      }
      return results;
    })()`);
    assert.equal(writes, 3, "only the three explicit requests may attempt a write");
    for (const response of responses) {
      assert.equal(response.status, 500); assert.equal(response.body.systemIssue, "STORAGE_FULL");
      assert.equal(JSON.stringify(response).includes(canary), false);
    }
    await inspect(chinese);
    const output = process.env.SHOGGOTH_SYSTEM_ISSUE_SCREENSHOT;
    if (output) {
      assert.ok(path.isAbsolute(output));
      fs.writeFileSync(output, (await window.webContents.capturePage({ x: 600, y: 0, width: 500, height: 120 })).toPNG());
    }

    await reload(); fileError = "ENOSPC";
    await js("location.hash = '#/agents'");
    await until("!!document.querySelector('main [role=\"status\"] button')", "failed lazy page fallback");
    const diskFailure = await inspect(chinese);
    assert.equal(diskFailure.fallback, true);
    fileError = null; await js("location.hash = '#/components'");
    await until("!document.querySelector('main [role=\"status\"] button')", "navigation recovery");

    await reload(); fileError = "ENOENT";
    await js("location.hash = '#/agents'");
    await until("!!document.querySelector('main [role=\"status\"] button')", "missing-resource fallback");
    const missing = await inspect("界面资源读取失败，请重试。");
    assert.equal(missing.titles.includes(chinese), false, "ENOENT alone must not claim that disk is full");

    await reload(); failedAsset = chatAsset; fileError = "ENOSPC";
    await js("location.hash = '#/chat'");
    await until("!!document.querySelector('main [role=\"status\"] button')", "failed Chat resource");
    await inspect(chinese);
    await js("location.hash = '#/components'");
    await until("!!document.querySelector('h1') && getComputedStyle(document.querySelector('main [role=\"status\"]').parentElement).display === 'none'", "hidden Chat failure and usable other page");

    config.locale = "en"; await reload();
    reporter.report(error("EDQUOT"));
    await inspect("Disk space is insufficient. Free up space and try again.");
    assert.deepEqual(preloadErrors, []); assert.equal(dialogs, 0);
    console.log("PASS production React UI, real preload/IPC, queued notice, repeated disk-full writes, lazy-page/Chat fallback, navigation recovery, ENOENT classification and English locale");
    console.log(JSON.stringify({ electron: process.versions.electron, dialogs, writes, evidence }));
  } finally {
    fs.readFile = originalReadFile; dialog.showErrorBox = originalDialog;
    reporter?.dispose(); window?.destroy(); await server?.close(); clearTimeout(timer);
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
app.on("will-quit", () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
