#!/usr/bin/env node
"use strict";

// Real Electron rendering with disposable profiles, an isolated production
// server, and the existing synthetic ChatPage fixture. No Agent is started.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "..");
const preview = process.argv.includes("--preview");
const output = process.env.WINDOW_DRAG_REVIEW_DIR || path.join(root, ".artifacts/window-drag-review");

if (!process.versions.electron) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-window-drag-"));
  (async () => {
    try {
      const uiRoot = path.join(root, "app/manage-ui");
      await createRequire(path.join(uiRoot, "package.json"))("esbuild").build({
        entryPoints: [path.join(root, "scripts/fixtures/chat-agent-capsule.tsx")],
        bundle: true, format: "esm", jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
        loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
        outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent",
      });
      fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>Shoggoth · 窗口拖动隔离预览</title><link rel="stylesheet" href="fixture.css"><style>#root{flex-direction:column}</style><div id="root" class="app"></div><script type="module" src="fixture.js"></script>');
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require("node:child_process").spawn(require("electron"),
        [__filename, "--electron-fixture", temp, ...(preview ? ["--preview"] : [])], { env });
      let stdout = "", stderr = "";
      child.stdout.on("data", value => { stdout += value; process.stdout.write(value); });
      child.stderr.on("data", value => { stderr += value; });
      const deadline = setTimeout(() => child.kill("SIGKILL"), preview ? 600_000 : 60_000);
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
      }).finally(() => clearTimeout(deadline));
      if (result.status !== 0) process.stderr.write(result.stderr || String(result.signal));
      assert.equal(result.status, 0, "window drag fixture must exit naturally with success");
      assert.match(result.stdout, /"verified":true/);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const temp = process.argv[process.argv.indexOf("--electron-fixture") + 1];
  const { startStaticServer } = require("../app/static-server");
  const { createConfigStore } = require("../app/core/config-store");
  app.setPath("userData", path.join(temp, "profile"));
  app.setPath("sessionData", path.join(temp, "session"));
  app.setName("Shoggoth window drag preview");
  app.on("window-all-closed", () => {});
  const timeout = setTimeout(() => { console.error("window drag fixture timed out"); app.exit(1); }, preview ? 540_000 : 45_000);
  let server, window;
  app.whenReady().then(async () => {
    const configStore = createConfigStore(path.join(temp, "config.json"), { defaultGatewayUrl: "ws://127.0.0.1:1" });
    configStore.write({ locale: "zh-CN", theme: "light", setupCompletedAt: 1 });
    ipcMain.on("openclaw:get-config", event => { event.returnValue = configStore.read(); });
    server = await startStaticServer(0, { configStore, homeDir: temp, userDataRoot: path.join(temp, "data") });
    window = new BrowserWindow({ show: false, width: 1200, height: 820, title: "Shoggoth · 窗口拖动隔离预览",
      ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 12 } } : {}),
      webPreferences: { preload: path.join(root, "app/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    fs.mkdirSync(output, { recursive: true });
    const evaluate = code => window.webContents.executeJavaScript(code, true);
    const waitFor = async code => {
      const deadline = Date.now() + 10_000;
      while (!await evaluate(code)) {
        assert.ok(Date.now() < deadline, `timed out: ${code}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const style = selector => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).webkitAppRegion`);
    const click = async selector => {
      // Electron ignores synthetic input while its window is hidden/unfocused.
      window.show(); window.focus();
      await waitFor("document.hasFocus()");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const rect = await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
      assert.ok(rect.width > 0 && rect.height > 0, `${selector} must have a visible hit target`);
      const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      assert.ok(await evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x}, ${point.y}))`), `${selector} must not be covered`);
      window.webContents.sendInputEvent({ type: "mouseMove", ...point });
      window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
      await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
    };
    const shot = async name => fs.writeFileSync(path.join(output, name + ".png"), (await window.webContents.capturePage()).toPNG());
    const mac = process.platform === "darwin";
    const checks = [];
    await window.loadURL(`${server.url}/#/dashboard`);
    for (const route of ["dashboard", "settings", "cli", "plugins", "chat"]) {
      await evaluate(`window.location.hash = ${JSON.stringify("/" + route)}`);
      const header = route === "chat" ? ".chat-aside__title-row" : ".page-head";
      await waitFor(`Boolean(document.querySelector(${JSON.stringify(header)})) && document.querySelector('.nav-link.active')?.getAttribute('href') === ${JSON.stringify("#/" + route)}`);
      assert.equal(await style(header), mac ? "drag" : "none", `${route} header must be draggable only in the macOS desktop window`);
      const gutter = await evaluate(`(() => { const s = getComputedStyle(document.querySelector('.app'), '::before'); return { region: s.webkitAppRegion, top: s.top, left: s.left, right: s.right, height: s.height, pointer: s.pointerEvents }; })()`);
      if (mac) assert.deepEqual(gutter, { region: "drag", top: "6px", left: "80px", right: "6px", height: "30px", pointer: "none" });
      else assert.equal(gutter.region, "none");
      if (route === "cli") {
        assert.equal(await style(".page-head-actions"), mac ? "no-drag" : "none");
        assert.equal(await style(".page-head-actions input"), mac ? "no-drag" : "none");
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.page-head-actions input')).userSelect"), mac ? "text" : "auto");
      }
      if (route === "dashboard") {
        const geometry = await evaluate("JSON.stringify([...document.querySelectorAll('.sidebar, .page-head, .content')].map(e => e.getBoundingClientRect().toJSON()))");
        await shot("dashboard-light");
        await evaluate("document.documentElement.dataset.theme = 'dark'");
        await shot("dashboard-dark");
        await evaluate("document.documentElement.classList.remove('electron-macos-hidden-inset')");
        assert.equal(await style(header), "none", "browser/native-titlebar layouts must not get drag regions");
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.app'), '::before').content"), "none");
        assert.equal(await evaluate("JSON.stringify([...document.querySelectorAll('.sidebar, .page-head, .content')].map(e => e.getBoundingClientRect().toJSON()))"), geometry, "native dragging must not change page layout");
        if (mac) await evaluate("document.documentElement.classList.add('electron-macos-hidden-inset')");
        await evaluate("document.documentElement.dataset.theme = 'light'");
      }
      checks.push(route);
      console.log(`PASS production ${route} header and top gutter`);
    }
    console.log("CHECK synthetic ChatPage native chrome");
    await window.loadFile(path.join(temp, "index.html"), { hash: "/chat" });
    await waitFor("Boolean(document.querySelector('.chat-header__row'))");
    for (const [width, height] of [[1200, 820], [800, 640]]) {
      window.setSize(width, height);
      assert.equal(await style(".chat-header__row"), mac ? "drag" : "none");
      for (const selector of [".chat-aside__search", ".chat-header__name", ".chat-header__avatar-trigger", ".chat-header__tools", ".chat-composer textarea"])
        assert.equal(await style(selector), mac ? "no-drag" : "none", `${selector} must remain interactive`);
      await click(".chat-header__name");
      await waitFor("document.querySelector('.chat-header__name').getAttribute('aria-expanded') === 'true'");
      assert.equal(await style("#chat-agent-panel"), "none", "expanded profile content must remain selectable");
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await waitFor("document.querySelector('.chat-header__name').getAttribute('aria-expanded') === 'false'");
      await waitFor("document.getElementById('chat-agent-panel').getBoundingClientRect().height < 1");
      await shot(`chat-${width}`);
      console.log(`PASS chat ${width}px header, actions and profile toggle`);
    }
    // A control scrolled into the gutter still wins both DOM hit testing and
    // Electron's no-drag exclusion, even though the gutter is painted above it.
    await evaluate(`(() => { const b = document.createElement('button'); b.id = 'gutter-control'; b.textContent = '顶部按钮'; b.style.cssText = 'position:fixed;top:10px;left:260px;width:100px;height:24px;z-index:50'; window.gutterClicks = 0; b.onclick = () => { window.gutterClicks++; }; document.body.append(b); })()`);
    assert.equal(await style("#gutter-control"), mac ? "no-drag" : "none");
    assert.equal(await evaluate("document.elementFromPoint(310, 22).id"), "gutter-control");
    await click("#gutter-control");
    await waitFor("window.gutterClicks === 1");
    await evaluate("document.getElementById('gutter-control').remove()");
    console.log(JSON.stringify({ verified: true, checks, chatSizes: [1200, 800], output }));
    if (preview) {
      window.setSize(1200, 820);
      const record = () => fs.writeFileSync(path.join(output, "native-state.json"), JSON.stringify({ bounds: window.getBounds(), url: window.webContents.getURL() }, null, 2));
      window.on("move", record); window.on("resize", record);
      record(); window.show(); window.focus();
      window.once("closed", () => app.quit());
    } else { window.destroy(); await server.close(); clearTimeout(timeout); app.quit(); }
  }).catch(async error => { console.error(error); window?.destroy(); await server?.close(); clearTimeout(timeout); app.exit(1); });
  app.on("will-quit", () => { clearTimeout(timeout); void server?.close(); });
}
