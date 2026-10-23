"use strict";
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict"), fs = require("node:fs"), http = require("node:http"), path = require("node:path"), crypto = require("node:crypto");
const [root, temp, outputDir] = process.argv.slice(2);
const SOURCE_FILES = ["app/static-server.js", "app/core/config-store.js", "app/manage-ui/src/lib/managedPluginHostApi.ts",
  "app/manage-ui/src/lib/managedPluginHostRecovery.ts", "app/manage-ui/src/components/ManagedPluginHostPanel.tsx",
  "app/manage-ui/src/components/ManagedPluginHostPanel.module.css", "app/manage-ui/src/i18n/locales/zh-CN.ts", "app/manage-ui/src/i18n/locales/en.ts",
  "app/manage-ui/src/pages/SettingsPage.tsx", "app/managed-openclaw-product-host.js", "app/managed-openclaw-product-model-api.js", "app/managed-hermes-product-host.js",
  "scripts/plugin-managed-hosts-panel-ui.mjs", "scripts/fixtures/managed-plugin-hosts-panel.tsx", "scripts/fixtures/managed-plugin-hosts-panel-driver.cjs"];
const sourceHashes = () => Object.fromEntries(SOURCE_FILES.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));
const capturedHashes = sourceHashes();
const { startStaticServer } = require(path.join(root, "app/static-server.js"));
const { createConfigStore } = require(path.join(root, "app/core/config-store.js"));
const { createManagedOpenClawProductHost } = require(path.join(root, "app/managed-openclaw-product-host.js"));
const { createManagedHermesProductHost } = require(path.join(root, "app/managed-hermes-product-host.js"));
app.setPath("userData", path.join(temp, "profile"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
app.whenReady().then(async () => {
  let win, server, web, complete = false;
  const requests = [], actions = [], controls = {}, hosts = {}, exposed = {}, checks = [], geometry = [];
  try {
    const store = createConfigStore(path.join(temp, "config.json")); store.ensure();
    for (const backendId of ["openclaw", "hermes"]) {
      const control = controls[backendId] = { state: "absent", candidate: null, clients: 0, copies: 0, activations: 0, stops: 0,
        releasePreparation: null, stopFailure: false, dropAfterAccept: false, dropBeforeAccept: false, holdNextRead: null, readHeld: false };
      const dataRoot = path.join(temp, `${backendId}-private-data`), runtimeRoot = path.join(temp, `${backendId}-immutable-runtime`);
      const identity = { pid: 1234, nonce: hash(`${backendId}-synthetic-owned-nonce`), startIdentity: "synthetic-not-real-process" };
      const endpoint = { baseUrl: "http://127.0.0.1:9", url: "ws://127.0.0.1:9", token: hash(`${backendId}-private-fixture-token`),
        identity, dataRoot, runtimeRoot, interpreterPath: path.join(runtimeRoot, "venv/bin/python"), entryPath: path.join(runtimeRoot, "hermes_cli/main.py") };
      const factory = backendId === "openclaw" ? createManagedOpenClawProductHost : createManagedHermesProductHost;
      const modeKey = `${backendId}PluginHostMode`;
      const host = hosts[backendId] = factory({ getMode: () => store.read()[modeKey], setManagedMode: () => store.write({ [modeKey]: "managed" }),
        createClient() {
          control.clients++;
          return { ready: Promise.resolve(),
            getStatus: () => ({ state: control.state, ownership: control.state === "running" ? "managed" : "absent", selectionSupported: true,
              generation: hash(`${backendId}-fixture-generation`), adapterGeneration: "fixture-adapter-generation", identity, dataRoot, runtimeRoot }),
            getEndpoint: () => control.state === "running" ? endpoint : null,
            getExecution: () => control.state === "running" ? { home: dataRoot, stateDir: dataRoot, runtimeRoot,
              interpreterPath: endpoint.interpreterPath, entryPath: endpoint.entryPath } : null,
            controller: { getCandidate: async () => control.candidate,
              prepareCandidate: async () => { control.copies++; await new Promise(resolve => { control.releasePreparation = resolve; }); return control.candidate = { candidateId: hash(`${backendId}-fixture-candidate`) }; },
              activateCandidate: async () => { control.activations++; await delay(50); control.state = "running"; return { healthVerified: true }; },
              stopOwned: async () => { control.stops++; await delay(50); if (control.stopFailure) { control.state = "unknown_writer"; throw Object.assign(new Error("PRIVATE_ONLY"), { code: "MANAGED_HOST_WRITER_OWNER_UNKNOWN" }); } control.state = "absent"; return { ownership: "absent" }; },
            }, close: async () => { control.state = "closed"; },
          };
        },
      });
      exposed[backendId] = { getStatus: host.getStatus, getOperationStatus: host.getOperationStatus };
      for (const action of ["prepare", "restart", "stop"]) exposed[backendId][action] = input => { actions.push({ backendId, action, operationId: input.operationId }); return host[action](input); };
    }
    web = await startStaticServer(0, { registry: { backends: new Map() }, configStore: store, homeDir: temp, userDataRoot: temp,
      managedOpenClawHost: exposed.openclaw, managedHermesHost: exposed.hermes });
    server = http.createServer((req, res) => {
      if (req.url.startsWith("/__api/")) {
        requests.push({ method: req.method, path: req.url });
        const match = req.url.match(/^\/__api\/plugins\/host-runtime\/(openclaw|hermes)(?:\/|$)/u), control = match && controls[match[1]];
        if (req.method === "POST" && control?.dropBeforeAccept) {
          control.dropBeforeAccept = false; req.resume(); res.writeHead(202, { "content-type": "application/json", "content-length": "4096" });
          res.write("{"); setTimeout(() => res.destroy(), 40); return;
        }
        const dropped = req.method === "POST" && control?.dropAfterAccept; if (dropped) control.dropAfterAccept = false;
        const held = req.method === "GET" && control?.holdNextRead;
        if (held) { control.holdNextRead = null; control.readHeld = true; }
        const forward = http.request(new URL(req.url, web.url), { method: req.method, headers: req.headers }, response => {
          if (dropped) { response.resume(); response.on("end", () => { res.writeHead(202, { "content-type": "application/json", "content-length": "4096" }); res.write("{"); setTimeout(() => res.destroy(), 40); }); return; }
          if (held) { const chunks = []; response.on("data", value => chunks.push(value)); response.on("end", async () => {
            await held.promise; if (!res.destroyed) { res.writeHead(response.statusCode, response.headers); res.end(Buffer.concat(chunks)); }
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
    win = new BrowserWindow({ show: false, width: 900, height: 1000, webPreferences: { backgroundThrottling: false } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}`); win.show(); win.focus();
    const evaluate = source => win.webContents.executeJavaScript(source, true);
    async function wait(source, message) { const deadline = Date.now() + 6000; while (!await evaluate(source)) { if (Date.now() > deadline) throw new Error(message); await delay(25); } }
    const section = backendId => `document.querySelector('[data-managed-plugin-host=${backendId}]')`;
    const button = (backendId, name) => `Array.from(${section(backendId)}?.querySelectorAll('button')||[]).find(b=>b.textContent===${JSON.stringify(name)})`;
    const status = (backendId, text) => `${section(backendId)}?.querySelector('[role=status]')?.textContent===${JSON.stringify(text)}`;
    async function click(backendId, name) { await wait(`(${button(backendId, name)}) && !(${button(backendId, name)}).disabled`, `${backendId} button unavailable: ${name}`); await evaluate(`(${button(backendId, name)}).click()`); }
    await wait(`${status("openclaw", "尚未准备")} && ${status("hermes", "尚未准备")}`, "two initial states absent");
    assert.equal(await evaluate("document.querySelectorAll('[data-managed-plugin-host]').length"), 2);
    assert.equal(await evaluate("document.querySelector('#managed-hermes-title')?.textContent"), "Hermes 公共插件环境");
    assert.equal(actions.length, 0); assert.equal(controls.openclaw.clients + controls.hermes.clients, 0);
    checks.push("both actual panels start with read-only status, distinct labels and zero Worker clients");
    for (const backendId of ["openclaw", "hermes"]) {
      await click(backendId, "准备插件环境"); await wait(status(backendId, "正在准备…"), `${backendId} preparation absent`);
      assert.equal(await evaluate(`Array.from(${section(backendId)}.querySelectorAll('button')).some(b=>!b.disabled&&b.textContent!=='重新检查')`), false);
      assert.equal(controls[backendId].copies, 1); controls[backendId].releasePreparation();
      await wait(status(backendId, "插件环境已就绪"), `${backendId} verified controller receipt absent`);
      assert.equal(store.read()[`${backendId}PluginHostMode`], "managed");
      checks.push(`${backendId} preparation persists only its mode and requires the actual ProductController admission/receipt`);
      controls[backendId].dropAfterAccept = true;
      await click(backendId, "重新启动"); await wait(status(backendId, "状态需要核实"), `${backendId} lost ACK incorrectly ready`);
      await wait(status(backendId, "插件环境已就绪"), `${backendId} original restart not observed`);
      assert.equal(controls[backendId].activations, 2);
      const original = actions.findLast(row => row.backendId === backendId);
      assert(requests.some(row => row.path === `/__api/plugins/host-runtime/${backendId}/operations/${original.operationId}`));
      checks.push(`${backendId} lost accepted ACK performs one restart and reads only the original operation`);
    }
    const held = deferred(); controls.openclaw.holdNextRead = held;
    await evaluate("window.showManagedHostPanels('openclaw')");
    for (let n = 0; !controls.openclaw.readHeld && n < 100; n++) await delay(10);
    assert.equal(controls.openclaw.readHeld, true);
    await evaluate("window.showManagedHostPanels('hermes')"); await wait(status("hermes", "插件环境已就绪"), "single Hermes panel absent");
    held.resolve(); await delay(100);
    assert.equal(await evaluate("document.querySelectorAll('[data-managed-plugin-host]').length"), 1);
    assert.equal(await evaluate("document.querySelector('[data-managed-plugin-host]')?.dataset.managedPluginHost"), "hermes");
    assert.equal(await evaluate("document.querySelector('h3')?.textContent"), "Hermes 公共插件环境");
    await evaluate("window.showManagedHostPanels('both')"); await wait(status("openclaw", "插件环境已就绪"), "dual remount absent");
    checks.push("late old-backend HTTP completion cannot mutate a reused panel's new backend scope");
    controls.hermes.stopFailure = true;
    await click("hermes", "停止"); await wait(status("hermes", "状态需要核实"), "unknown Hermes writer reported stopped");
    assert.equal(await evaluate(`${button("hermes", "启动插件环境")}!=null`), false);
    assert.equal(await evaluate(status("openclaw", "插件环境已就绪")), true);
    controls.hermes.stopFailure = false; await click("hermes", "停止"); await wait(status("hermes", "插件环境已停止"), "explicit Hermes owned stop absent");
    assert.equal(controls.hermes.stops, 2); checks.push("Hermes unknown writer cannot start a replacement; accurate explicit stop affects only Hermes");
    await evaluate("document.activeElement?.blur()"); let focused = false;
    for (let n = 0; n < 8; n++) { win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" }); await delay(20);
      if (await evaluate("document.activeElement?.tagName==='BUTTON'")) focused = true;
    }
    assert(focused);
    for (const width of [900, 390]) { win.setContentSize(width, 1000); for (const theme of ["light", "dark"]) {
      const item = await evaluate(`window.captureManagedHostPanels(${JSON.stringify(theme)})`);
      assert.deepEqual(item.errors, []); assert.equal(item.colorScheme, theme); assert(item.scrollWidth <= width); assert.equal(item.sections.length, 2);
      assert.equal(new Set(item.sections.map(row => row.labelledBy)).size, 2);
      assert(item.sections.every(row => row.left >= 0 && row.right <= width && row.buttons.every(button => button.height >= 28 && button.width > 0)));
      geometry.push(item); fs.writeFileSync(path.join(outputDir, `managed-hosts-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    } }
    checks.push("both cards remain labelled, keyboard reachable, scrollable and contained in desktop/mobile light/dark layouts");
    await evaluate("window.setManagedHostLocale('en')");
    await wait("document.querySelector('#managed-hermes-title')?.textContent==='Hermes shared plugin environment'", "English Hermes title absent");
    const english = await evaluate("window.captureManagedHostPanels('light')");
    assert.equal(english.sections.length, 2); assert(english.scrollWidth <= 390); assert.deepEqual(english.errors, []);
    geometry.push(english); fs.writeFileSync(path.join(outputDir, "managed-hosts-390-en-light.png"), (await win.webContents.capturePage()).toPNG());
    await evaluate("window.setManagedHostLocale('zh-CN')");
    await wait("document.querySelector('#managed-hermes-title')?.textContent==='Hermes 公共插件环境'", "Chinese locale restoration absent");
    checks.push("both backend titles and actions localize to English without mobile overflow");
    for (const backendId of ["hermes", "openclaw"]) {
      if (backendId === "openclaw") { await click(backendId, "停止"); await wait(status(backendId, "插件环境已停止"), "OpenClaw stop absent"); }
      const before = actions.length, activations = controls[backendId].activations;
      controls[backendId].dropBeforeAccept = true; await click(backendId, "启动插件环境"); await wait(status(backendId, "状态需要核实"), `${backendId} unknown action not held`);
      await delay(1650); await click(backendId, "重新检查"); await delay(100);
      assert.equal(actions.length, before); assert.equal(controls[backendId].activations, activations);
      const saved = await evaluate(`JSON.parse(localStorage.getItem('shoggoth:managed-plugin-host-operation:${backendId}'))`);
      assert.equal(saved.backendId, backendId); assert.equal(Object.keys(saved).length, 3);
      assert(requests.some(row => row.path === `/__api/plugins/host-runtime/${backendId}/operations/${saved.operationId}`));
      await evaluate("window.remountManagedHostPanels()"); await wait(status(backendId, "状态需要核实"), `${backendId} original operation forgotten on remount`);
      assert.equal(await evaluate(`${button(backendId, "启动插件环境")}!=null`), false); assert.equal(actions.length, before);
      checks.push(`${backendId} unobserved original operation remains persisted and read-only across GET 404 and remount`);
    }
    const pending = await evaluate("['openclaw','hermes'].map(id=>JSON.parse(localStorage.getItem('shoggoth:managed-plugin-host-operation:'+id)))");
    assert.notEqual(pending[0].operationId, pending[1].operationId);
    assert.deepEqual(pending.map(row => row.backendId), ["openclaw", "hermes"]);
    assert.equal(await evaluate("document.body.innerText.includes('PRIVATE_ONLY')"), false);
    const hashes = sourceHashes(); assert.deepEqual(hashes, capturedHashes, "source changed during actual UI proof; rerun required");
    const report = { verified: true, checks, geometry, controls: Object.fromEntries(Object.entries(controls).map(([id, row]) => [id, { clients: row.clients, copies: row.copies, activations: row.activations, stops: row.stops }])),
      sourceHashes: hashes, actions, requests, pending,
      boundary: "actual dual React panels + fetch + loopback HTTP + static-server + two ProductControllers; controlled Worker/client, no real Host/model", realHostProcesses: 0, modelCalls: 0, userCredentials: 0, pausedSkillsRun: 0 };
    fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ verified: true, groups: checks.length, actions: actions.length, controls: report.controls, realHostProcesses: 0, modelCalls: 0, userCredentials: 0 })); complete = true;
  } catch (error) {
    console.error(error); console.error(JSON.stringify({ requests, actions }));
    if (win && !win.isDestroyed()) { console.error(await win.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText})")); fs.writeFileSync(path.join(outputDir, "failure.png"), (await win.webContents.capturePage()).toPNG()); }
  } finally {
    for (const control of Object.values(controls)) control.releasePreparation?.();
    if (win && !win.isDestroyed()) win.destroy(); if (server) await new Promise(resolve => server.close(resolve)); await web?.close();
    for (const host of Object.values(hosts)) await host.close(); app.exit(complete ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });
