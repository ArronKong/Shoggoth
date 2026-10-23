"use strict";
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict"), fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const [root, temp, outputDir] = process.argv.slice(2);
const { startStaticServer } = require(path.join(root, "app/static-server.js"));
const { createConfigStore } = require(path.join(root, "app/core/config-store.js"));
const { createManagedOpenClawProductHost } = require(path.join(root, "app/managed-openclaw-product-host.js"));
app.setPath("userData", path.join(temp, "profile"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const endpoint = "/__api/plugins/host-runtime/openclaw";
app.whenReady().then(async () => {
  let win, server, web, unsupportedWeb, complete = false;
  let releasePreparation, stopFailure = false, hostState = "absent", candidate = null;
  let sourceUnavailable = false, dropAfterAccept = false, dropBeforeAccept = false;
  const requests = [], actions = [], counts = { clients: 0, copies: 0, activations: 0, stops: 0 };
  try {
    const store = createConfigStore(path.join(temp, "config.json")); store.ensure();
    const host = createManagedOpenClawProductHost({
      getMode: () => store.read().openclawPluginHostMode,
      setManagedMode: () => store.write({ openclawPluginHostMode: "managed" }),
      createClient() {
        counts.clients += 1;
        return { ready: Promise.resolve(), getStatus: () => ({ state: hostState, ownership: hostState === "running" ? "managed" : "absent", selectionSupported: true }),
          getEndpoint: () => hostState === "running" ? { url: "ws://127.0.0.1:1", token: "PRIVATE_ONLY" } : null,
          getExecution: () => hostState === "running" ? { home: path.join(temp, "private-home") } : null,
          controller: {
            getCandidate: async () => candidate,
            prepareCandidate: async () => { counts.copies += 1; await new Promise(resolve => { releasePreparation = resolve; });
              return candidate = { candidateId: "a".repeat(64) }; },
            activateCandidate: async () => { counts.activations += 1; await delay(60); hostState = "running"; return { healthVerified: true }; },
            stopOwned: async () => { counts.stops += 1; await delay(60); if (stopFailure) {
              hostState = "unknown_writer"; throw Object.assign(new Error("PRIVATE_ONLY"), { code: "MANAGED_HOST_WRITER_OWNER_UNKNOWN" });
            } hostState = "absent"; return { ownership: "absent" }; },
          }, close: async () => { hostState = "absent"; },
        };
      },
    });
    const exposed = {};
    for (const key of ["getStatus", "getOperationStatus"]) exposed[key] = host[key];
    for (const key of ["prepare", "restart", "stop"]) exposed[key] = input => { actions.push({ action: key, operationId: input.operationId }); return host[key](input); };
    const options = { registry: { backends: new Map() }, configStore: store, homeDir: temp, userDataRoot: temp };
    web = await startStaticServer(0, { ...options, managedOpenClawHost: exposed });
    unsupportedWeb = await startStaticServer(0, options);
    server = http.createServer((req, res) => {
      if (req.url.startsWith("/__api/")) {
        requests.push({ method: req.method, path: req.url });
        if (req.method === "POST" && dropBeforeAccept) {
          dropBeforeAccept = false; req.resume();
          res.writeHead(202, { "content-type": "application/json", "content-length": "4096" });
          res.write("{"); setTimeout(() => res.destroy(), 50); return;
        }
        const dropped = req.method === "POST" && dropAfterAccept; if (dropped) dropAfterAccept = false;
        const upstream = new URL(req.url, sourceUnavailable ? unsupportedWeb.url : web.url);
        const forward = http.request(upstream, { method: req.method, headers: req.headers }, response => {
          if (dropped) { response.resume(); response.on("end", () => {
            // Truncate a response after its headers: Chromium may transparently
            // retry a reused socket that closes before any response headers.
            res.writeHead(202, { "content-type": "application/json", "content-length": "4096" });
            res.write("{"); setTimeout(() => res.destroy(), 50);
          }); return; }
          res.writeHead(response.statusCode, response.headers); response.pipe(res);
        });
        forward.on("error", () => res.destroy()); req.pipe(forward); return;
      }
      const name = req.url === "/" ? "index.html" : req.url.slice(1);
      if (!["index.html", "fixture.js", "fixture.css"].includes(name)) { res.writeHead(404).end(); return; }
      res.setHeader("content-type", name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, name)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    win = new BrowserWindow({ show: false, width: 900, height: 900, webPreferences: { backgroundThrottling: false } });
    await win.loadURL(url); win.show(); win.focus();
    const evaluate = source => win.webContents.executeJavaScript(source, true);
    async function wait(source, message) {
      const deadline = Date.now() + 6000;
      while (!await evaluate(source)) { if (Date.now() > deadline) throw new Error(message); await delay(25); }
    }
    const button = name => `Array.from(document.querySelectorAll('section button')).find(b=>b.textContent===${JSON.stringify(name)})`;
    const click = async name => {
      await wait(`(${button(name)}) && !(${button(name)}).disabled`, `button unavailable: ${name}`);
      await evaluate(`(${button(name)}).click()`);
    };
    const statusText = text => `document.querySelector('[role=status]')?.textContent===${JSON.stringify(text)}`;
    const checks = [];
    await wait(statusText("尚未准备"), "initial status absent");
    assert.equal(counts.clients, 0); assert.equal(actions.length, 0);
    assert.equal(await evaluate("document.body.innerText.includes('PRIVATE_ONLY')"), false);
    checks.push("initial status is read-only and private metadata is absent");
    await click("准备插件环境");
    await wait(statusText("正在准备…"), "preparation not visible");
    assert.equal(await evaluate(`!(${button("准备插件环境")}) || (${button("准备插件环境")}).disabled`), true);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('section button')).some(b=>!b.disabled&&b.textContent!=='重新检查')"), false);
    assert.equal(counts.copies, 1); releasePreparation();
    await wait(statusText("插件环境已就绪"), "real product-controller receipt not rendered");
    assert.equal(store.read().openclawPluginHostMode, "managed"); assert.equal(counts.activations, 1);
    checks.push("prepare persists managed mode, disables duplicate actions and requires verified activation");
    dropAfterAccept = true;
    await click("重新启动");
    await wait(statusText("状态需要核实"), "lost acknowledgement incorrectly reports ready");
    assert.equal(await evaluate(`!(${button("重新启动")}) || (${button("重新启动")}).disabled`), true);
    await wait(statusText("插件环境已就绪"), "original restart was not observed");
    assert.equal(counts.activations, 2); assert.equal(actions.length, 2);
    assert(requests.some(row => row.path === `${endpoint}/operations/${actions[1].operationId}`));
    checks.push("lost POST acknowledgement queries only the original operation and performs no second activation");
    stopFailure = true;
    await click("停止"); await wait(statusText("状态需要核实"), "failed stop was reported as stopped");
    assert.equal(await evaluate(`${button("启动插件环境")}!=null`), false);
    assert.equal(await evaluate(`${button("准备插件环境")}!=null`), false);
    assert.equal(await evaluate("document.body.innerText.includes('PRIVATE_ONLY')"), false);
    checks.push("unknown writer is non-ready and cannot trigger a replacement preparation");
    stopFailure = false;
    await click("停止"); await wait(statusText("插件环境已停止"), "explicit verified stop not rendered");
    assert.equal(counts.stops, 2); assert.equal(actions.length, 4);
    checks.push("explicit owned-stop retry yields stopped without a new worker or copy");
    await evaluate("window.remountManagedHostPanel()"); await wait(statusText("插件环境已停止"), "persisted managed mode absent after remount");
    dropBeforeAccept = true;
    await click("启动插件环境"); await wait(statusText("状态需要核实"), "unknown original operation did not fail closed");
    await delay(1750); await click("重新检查"); await delay(150);
    assert.equal(actions.length, 4); assert.equal(counts.activations, 2);
    assert.equal(await evaluate(`${button("启动插件环境")}!=null`), false);
    checks.push("an unobserved original operation remains non-ready after GET 404 without resending");
    await evaluate("window.remountManagedHostPanel()");
    await wait(statusText("状态需要核实"), "uncertain original operation was forgotten after remount");
    await delay(200); assert.equal(actions.length, 4); assert.equal(counts.activations, 2);
    assert.equal(await evaluate(`${button("启动插件环境")}!=null`), false);
    const persisted = await evaluate("JSON.parse(localStorage.getItem('shoggoth:managed-plugin-host-operation:openclaw'))");
    assert.equal(persisted.backendId, "openclaw");
    assert(requests.some(row => row.path === `${endpoint}/operations/${persisted.operationId}`));
    checks.push("uncertain operation persists across remount and only its exact ID is observed");
    await evaluate("document.activeElement?.blur()");
    let focused = false;
    for (let i = 0; i < 6; i++) {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" }); await delay(20);
      if (await evaluate("document.activeElement?.tagName==='BUTTON' && document.querySelector('section')?.contains(document.activeElement)")) focused = true;
    }
    assert(focused); checks.push("settings actions remain keyboard reachable");
    const geometry = [];
    for (const width of [900, 390]) { win.setContentSize(width, 900); for (const theme of ["light", "dark"]) {
      const item = await evaluate(`window.captureManagedHostPanel(${JSON.stringify(theme)})`);
      assert.deepEqual(item.errors, []); assert.equal(item.colorScheme, theme);
      assert(item.scrollWidth <= width); assert(item.section.left >= 0 && item.section.right <= width);
      assert(item.buttons.every(button => button.height >= 28 && button.width > 0)); geometry.push(item);
      fs.writeFileSync(path.join(outputDir, `managed-host-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    } }
    sourceUnavailable = true;
    await evaluate("window.remountManagedHostPanel()"); await delay(200);
    assert.equal(await evaluate("document.querySelector('section')!==null"), true);
    assert.equal(await evaluate(statusText("状态需要核实")), true);
    assert.equal(actions.length, 4);
    checks.push("501 after an uncertain dispatch keeps the original observation visible without resending");
    const report = { ok: true, checks, geometry, counts, actionCount: actions.length, requests,
      boundary: "production React + fetch + loopback HTTP + static-server + product controller; controlled trusted Worker client, no real Host or model", modelCalls: 0, remoteCalls: 0 };
    fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report)); complete = true;
  } catch (error) {
    console.error(error);
    console.error(JSON.stringify({ requests, actions, counts }));
    if (win && !win.isDestroyed()) {
      console.error(await win.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText})"));
      fs.writeFileSync(path.join(outputDir, "failure.png"), (await win.webContents.capturePage()).toPNG());
    }
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (server) await new Promise(resolve => server.close(resolve)); await web?.close(); await unsupportedWeb?.close();
    app.exit(complete ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });
