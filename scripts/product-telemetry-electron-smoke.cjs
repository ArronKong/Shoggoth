"use strict";

// Real production React bundle + production preload/IPC/collector/transport.
// All API state and telemetry receivers are local fixtures; no backend/runtime
// is started, no user's profile is read, and no PostHog request reaches the web.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const phases = ["open-and-quit", "first", "restart", "disabled", "environment"];

if (!process.versions.electron) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-telemetry-electron-"));
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    for (const phase of phases) {
      const child = spawnSync(require("electron"), [__filename, "--fixture", root, phase], {
        env, encoding: "utf8", timeout: 40_000,
      });
      // Child errors concern only synthetic state, never user payloads.
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.status !== 0) throw new Error(`Electron ${phase} failed: ${child.stderr || child.error || child.status}`);
    }
    console.log("Desktop telemetry: open-only DAU, two-row settings, local diagnostics, feature use, legacy preferences and blocked builds/environments passed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const http = require("node:http");
  const { EventEmitter } = require("node:events");
  const { app, BrowserWindow, ipcMain, powerMonitor } = require("electron");
  const { createConfigStore } = require("../app/core/config-store");
  const { createProductTelemetry } = require("../app/core/product-telemetry");
  const { createPostHogTransport, ENDPOINTS } = require("../app/core/product-telemetry-posthog");
  const { registerDesktopTelemetryIpc } = require("../app/desktop-telemetry-ipc");
  const { localDiagnosticSummary } = require("../app/bootstrap-diagnostics");
  const { BUILD, fakeClock } = require("./helpers/product-telemetry-fixtures.cjs");
  const at = process.argv.indexOf("--fixture");
  const root = process.argv[at + 1];
  const phase = process.argv[at + 2];
  assert.ok(root && phases.includes(phase));
  const profile = path.join(root, ["disabled", "environment"].includes(phase) ? phase : "enabled-profile");
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath("userData", profile);
  app.setName("Shoggoth telemetry isolated test");
  app.on("window-all-closed", () => {});

  const uiDir = path.join(__dirname, "../app/manage-ui/dist");
  const configStore = createConfigStore(path.join(profile, "config.json"));
  const statePath = path.join(profile, "product-telemetry/state.json");
  const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitUntil = async (predicate, label) => {
    const deadline = Date.now() + 10_000;
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error(`timeout: ${label}`);
      await delay(40);
    }
  };
  const listen = async (handler) => {
    const server = http.createServer(handler);
    server.on("upgrade", (_req, socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  };

  app.whenReady().then(async () => {
    let w;
    let ui;
    let sink;
    let telemetry;
    let dispose;
    let passed = false;
    const timeout = setTimeout(() => { console.error("telemetry fixture hard deadline"); app.exit(1); }, 32_000);
    try {
      if (process.platform === "darwin") {
        app.setActivationPolicy("regular");
        await app.dock.show();
      }
      if (phase !== "restart") configStore.write({ locale: "en", setupCompletedAt: 1, gatewayUrl: "", token: "", notifications: { chat: false, cron: false, task: false } });
      else {
        configStore.write({ locale: "zh-CN", theme: "dark", setupCompletedAt: 1, token: "synthetic-local-token" });
        configStore.writeTelemetryPreferences("detailedEnabled", false); // old basic-only installation
      }
      const clock = fakeClock(phase === "restart" ? "2026-09-11T02:00:00Z" : "2026-09-10T23:59:59.999Z");
      const previousOpen = phase === "first" && fs.existsSync(statePath) ? readState().outbox[0]?.event : null;
      const batches = [];
      const notes = [];
      sink = await listen((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          assert.equal(req.method, "POST");
          assert.equal(req.url, "/batch/");
          assert.equal(req.headers.cookie, undefined);
          assert.equal(req.headers.authorization, undefined);
          assert.equal(body.includes("SECRET_CANARY"), false);
          batches.push(JSON.parse(body));
          res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"Ok"}');
        });
      });
      ui = await listen((req, res) => {
        const url = new URL(req.url, "http://fixture.test");
        const json = (value, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
        if (url.pathname === "/__api/config") {
          if (req.method === "PUT") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => json({ config: configStore.write(JSON.parse(body)) }));
            return;
          }
          return json({ config: configStore.read() });
        }
        if (["/__api/backends", "/__api/status", "/__api/versions", "/__api/self-updates"].includes(url.pathname)) return json({ backends: [] });
        if (url.pathname === "/__api/inspirations") {
          if (req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
              const input = JSON.parse(body);
              const note = { id: `fixture-${notes.length + 1}`, body: input.body, title: null, attachments: [],
                status: "saved", revision: 1, paperTone: 0, createdAt: clock.now(), updatedAt: clock.now(),
                archivedAt: null, favorite: false, latestExecution: null };
              notes.push(note);
              json({ idea: note });
            });
            return;
          }
          return json({ items: notes, total: notes.length, nextCursor: null });
        }
        if (url.pathname.startsWith("/__api/")) return json({ error: "synthetic backend unavailable" }, 501);
        const file = path.resolve(uiDir, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
        if (!file.startsWith(`${uiDir}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json({ error: "fixture resource missing" }, 404);
        const type = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp" })[path.extname(file)] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        fs.createReadStream(file).pipe(res);
      });
      telemetry = createProductTelemetry({ statePath, configStore, clock,
        buildConfig: { ...BUILD, officialRelease: phase !== "disabled" },
        environmentOverride: phase === "environment" ? "environment" : null,
        transport: createPostHogTransport({ projectToken: BUILD.projectToken, region: "us", fetchImpl(url, options) {
          assert.equal(url, ENDPOINTS.us);
          // Test dependency injection only. Production has no custom endpoint switch.
          return fetch(`${sink.url}/batch/`, options);
        } }),
      });
      const power = new EventEmitter();
      power.getSystemIdleState = (threshold) => powerMonitor.getSystemIdleState(threshold);
      const diagnosticPath = path.join(profile, `test-diagnostics-${phase}.txt`);
      const diagnosticTime = "2026-09-10T21:15:00.000Z";
      if (phase === "restart") {
        fs.writeFileSync(path.join(profile, "bootstrap-diagnostics.json"), JSON.stringify({ version: 1, records: [
          { timeMs: Date.parse(diagnosticTime), role: "mcp", errors: [{ code: "MCP_HELPER_SERVICE_UNAVAILABLE" }] },
        ] }), { mode: 0o600 });
      }
      let cancelDiagnostic = false, dialogs = 0;
      const ipc = registerDesktopTelemetryIpc({ ipcMain, getMainWindow: () => w, getUiOrigin: () => ui.url,
        powerMonitor: power, telemetry, now: clock.now, diagnosticSummary: () => localDiagnosticSummary(profile, BUILD.appVersion, "darwin"),
        dialog: { async showSaveDialog(owner) { assert.equal(owner, w); dialogs++; return { canceled: cancelDiagnostic, filePath: diagnosticPath }; } } });
      dispose = ipc.dispose;
      ipcMain.on("openclaw:get-config", (event) => { event.returnValue = { ...configStore.read(), effectiveLocale: configStore.read().locale }; });
      w = new BrowserWindow({ show: true, width: 1200, height: 850, title: "Shoggoth telemetry isolated test",
        webPreferences: { preload: path.join(__dirname, "../app/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
      ipc.observeWindow(w);
      if (phase === "open-and-quit") {
        w.show(); app.focus({ steal: true }); w.focus();
        await waitUntil(() => fs.existsSync(statePath), "native open persisted before the renderer loads");
        const saved = readState();
        assert.deepEqual(saved.outbox.map(row => row.event.event), ["shoggoth_app_active"]);
        assert.equal(saved.detail.draft, null);
        assert.equal(batches.length, 0);
        console.log("Electron telemetry open-and-quit: PASS (closed before loading the UI or sending)");
        passed = true;
        return;
      }
      const blocked = [];
      w.webContents.session.webRequest.onBeforeRequest((details, done) => {
        const url = new URL(details.url);
        const allowed = url.origin === ui.url || ["data:", "blob:"].includes(url.protocol);
        if (!allowed) blocked.push(url.origin);
        done({ cancel: !allowed });
      });
      const page = `${ui.url}/#/settings?probe=SECRET_CANARY`;
      const ready = async () => {
        await waitUntil(() => w.webContents.executeJavaScript('Boolean(document.querySelector(".app .sidebar"))'), "real App mounted");
        // The test controls both clocks to cross UTC midnight instantly. The
        // production bundle is otherwise unmodified and uses real DOM inputs.
        await w.webContents.executeJavaScript(`window.__fixtureNow=${clock.now()};
          if (!window.__realDate) { window.__realDate=Date; window.Date=class extends window.__realDate {
            constructor(...args) { super(...(args.length?args:[window.__fixtureNow])); }
            static now() { return window.__fixtureNow; }
          }; } void 0;`);
      };
      const focus = async () => {
        w.show(); app.focus({ steal: true }); w.focus(); w.webContents.focus();
        try { await waitUntil(() => w.isFocused(), "fixture focus"); }
        catch (error) {
          console.error("fixture native state", { visible: w.isVisible(), focused: w.isFocused(),
            minimized: w.isMinimized(), idle: powerMonitor.getSystemIdleState(1),
            document: await w.webContents.executeJavaScript('({visible:document.visibilityState,focused:document.hasFocus()})') });
          throw error;
        }
      };
      const input = async () => {
        // The previous step may leave focus inside the excluded statistics UI.
        await w.webContents.executeJavaScript("document.activeElement?.blur()");
        w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
        w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
        await delay(100);
      };
      const evalUi = source => w.webContents.executeJavaScript(source);
      const checked = selector => evalUi(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked')`);
      const master = '[aria-labelledby="settings-telemetry-enabled"]';
      const diagnostics = '#settings-telemetry button:not([role="switch"])';
      const settingsSection = "#settings-telemetry";
      const click = async selector => {
        let position;
        await waitUntil(async () => {
          position = await evalUi(`(async () => {
            const node = document.querySelector(${JSON.stringify(selector)});
            if (!node || node.matches(':disabled, [data-disabled], [aria-disabled="true"]')) return null;
            node.scrollIntoView({block:'center', behavior:'instant'});
            await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
            const r = node.getBoundingClientRect();
            const x = Math.round(r.left+r.width/2), y = Math.round(r.top+r.height/2);
            return node.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
          })()`);
          return Boolean(position);
        }, `clickable ${selector}`);
        w.webContents.sendInputEvent({ type: "mouseMove", ...position });
        w.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...position });
        w.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...position });
      };
      const press = keyCode => {
        w.webContents.sendInputEvent({ type: "keyDown", keyCode });
        w.webContents.sendInputEvent({ type: "keyUp", keyCode });
      };
      await w.loadURL(page); await ready(); await focus();
      const previousId = phase === "restart" ? readState().distinctId : null;
      const before = phase === "restart" ? fs.readFileSync(statePath, "utf8") : null;
      const blockedBuild = phase === "disabled" || phase === "environment";
      await waitUntil(() => evalUi(`document.querySelector(${JSON.stringify(master)})?.matches('[aria-checked="${phase === "first" ? "true" : "false"}"]${blockedBuild ? "[data-disabled]" : ":not([data-disabled])"}')`), "effective master setting");
      const rows = await evalUi(`Array.from(document.querySelectorAll('${settingsSection} .settings-list-row'),
        row => row.querySelector('[role="switch"]')?.getAttribute('aria-labelledby') ?? null)`);
      assert.deepEqual(rows, ["settings-telemetry-enabled", null]);
      assert.equal(await evalUi(`document.querySelector('${settingsSection} a')?.href.endsWith('${phase === "restart" ? "privacy.md" : "privacy.en.md"}')`), true);
      await click(diagnostics);
      await waitUntil(() => fs.existsSync(diagnosticPath), "user-selected local export");
      const expectedDetails = phase === "restart" ? [{ code: "MCP_HELPER_SERVICE_UNAVAILABLE", count: 1, last_seen_at: diagnosticTime,
        stages: [{ stage: "mcp.startup", count: 1, last_seen_at: diagnosticTime }] }] : [];
      assert.deepEqual(JSON.parse(fs.readFileSync(diagnosticPath)), { app_version: BUILD.appVersion, os_family: "macos",
        error_codes: expectedDetails.map(entry => entry.code), record_limit_per_source: 8, error_details: expectedDetails });
      await waitUntil(() => evalUi(`!document.querySelector('${diagnostics}').disabled && document.querySelector('${settingsSection} [role="status"]').textContent.includes('${phase === "restart" ? "已保存" : "Saved"}')`), "export acknowledged in settings");
      cancelDiagnostic = true;
      await focus();
      // The first export exercised a native pointer click. Activate that same
      // button through the DOM to test cancellation independently of pointer focus.
      await evalUi(`document.querySelector('${diagnostics}').click()`);
      try { await waitUntil(() => dialogs === 2, "canceled export"); }
      catch (error) {
        console.error("fixture diagnostic state", { dialogs, visible: w.isVisible(), focused: w.isFocused(),
          idle: powerMonitor.getSystemIdleState(1), status: await evalUi(`document.querySelector('${settingsSection} [role="status"]').textContent`) });
        throw error;
      }
      assert.equal(batches.length, 0);
      await w.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent("keydown", {key:"SECRET_CANARY",bubbles:true}));
        document.dispatchEvent(new Event("scroll", {bubbles:true}));
        window.scrollTo(0,200);`);
      await delay(200);
      if (phase === "restart") assert.equal(fs.readFileSync(statePath, "utf8"), before);
      if (blockedBuild) assert.equal(fs.existsSync(statePath), false);
      if (phase === "first") {
        assert.equal(readState().outbox.length, 1, "open before any page interaction");
        assert.ok(previousOpen?.uuid, "the first process left the quick-open event on disk");
        assert.equal(readState().outbox[0].event.uuid, previousOpen.uuid, "same-day restart preserves that event exactly once");
        assert.equal(readState().detail.draft, null, "opening and diagnostics do not imply feature use");
        await w.webContents.executeJavaScript('location.hash="/glass"');
        await delay(250); await input();
        assert.equal(readState().detail.draft, null, "lab activity is excluded");
        await w.webContents.executeJavaScript('location.hash="/settings?probe=SECRET_CANARY"');
        await delay(250);
        assert.equal(configStore.getTelemetryPreferences().preferences.enabled, true);
        assert.equal(readState().outbox.length, 1);
      }
      if (blockedBuild) {
        await input();
        await telemetry.flush();
        assert.equal(fs.existsSync(statePath), false);
        assert.equal(batches.length, 0);
      } else if (phase === "restart") {
        await telemetry.flush();
        assert.equal(readState().distinctId, previousId);
        assert.equal(readState().outbox.length, 0);
        assert.equal(batches.length, 0, "restart preserves master opt-out");
        await click(master);
        await waitUntil(async () => await checked(master) === "true", "re-enable master");
        assert.equal(configStore.getTelemetryPreferences().preferences.detailedEnabled, false);
        assert.ok(await evalUi(`document.querySelector('${settingsSection}').textContent.includes("仅统计 App 活跃")`));
        await input();
        await telemetry.flush();
        assert.equal(batches.length, 0, "same-day re-enable cannot duplicate activity");
      } else {
        await waitUntil(() => fs.existsSync(statePath), "first window open");
        const first = readState().outbox[0].event;
        assert.equal(first.properties.report_day, "2026-09-10");
        assert.equal(readState().outbox.length, 1);
        assert.equal(readState().detail.draft, null);
        // Host may flush already-recorded events while the window is hidden.
        w.hide(); await telemetry.flush();
        assert.equal(batches.length, 1);
        assert.deepEqual(batches[0].batch, [first]);
        await focus();
        await evalUi('location.hash="/inspirations"');
        await waitUntil(() => evalUi(`!!document.querySelector('textarea[aria-keyshortcuts="Enter"]')`), "production Inspiration composer");
        await focus();
        await evalUi(`document.querySelector('textarea[aria-keyshortcuts="Enter"]').focus()`);
        await w.webContents.insertText("SECRET_CANARY synthetic Inspiration note");
        await waitUntil(() => evalUi(`document.querySelector('textarea[aria-keyshortcuts="Enter"]')?.value.startsWith('SECRET_CANARY')`), "real Inspiration input");
        press("Enter");
        await waitUntil(() => notes.length === 1, "real Inspiration action reached local fixture");
        await delay(120);
        await telemetry.flush();
        assert.equal(batches.length, 1, "current-day details are not sent individually");
        clock.advance(1);
        const epoch = telemetry.getSettings().basicEpoch;
        const signal = `window.openclawDesktop.productTelemetry.record(${JSON.stringify({ kind: "activity", collectionEpoch: epoch, payload: {} })});`;
        w.hide();
        await w.webContents.executeJavaScript(`window.__fixtureNow=${clock.now()};${signal}`);
        await delay(100);
        assert.equal(readState().outbox.length, 0, "even a forged bridge call fails while hidden");
        power.emit("suspend");
        await focus();
        await w.webContents.executeJavaScript(signal);
        await delay(100);
        power.emit("resume");
        assert.equal(readState().outbox.length, 0);
        w.hide(); await focus();
        await waitUntil(() => readState().outbox.length === 2, "next-day activity and sealed previous-day details");
        assert.equal(readState().distinctId, first.distinct_id);
        assert.ok(readState().outbox.some(row => row.event.event === "shoggoth_app_active" && row.event.properties.report_day === "2026-09-11"));
        await telemetry.flush();
        await telemetry.flush();
        assert.equal(batches.length, 3);
        assert.equal(batches[1].batch.length, 1);
        assert.equal(batches[1].batch[0].properties.$geoip_disable, true);
        assert.equal(batches[1].batch[0].properties.$process_person_profile, false);
        const daily = batches[2].batch[0];
        assert.equal(daily.event, "shoggoth_daily_feature_usage");
        assert.equal(daily.properties.report_day, "2026-09-10");
        assert.equal(daily.properties.used_inspiration, true);
        assert.equal(daily.properties.inspiration_create_attempt_count, 1);
        assert.equal(daily.properties.inspiration_create_success_count, 1);
        await evalUi('location.hash="/settings"');
        await waitUntil(async () => await checked(master) === "true", "settings after navigation");
        await click(master);
        await waitUntil(async () => await checked(master) === "false", "total opt-out saved");
        clock.advance(86_400_000);
        await evalUi(`window.__fixtureNow=${clock.now()}`);
        await input(); await telemetry.flush();
        assert.equal(readState().outbox.length, 0);
        assert.equal(readState().detail.draft, null);
        assert.equal(batches.length, 3);
        assert.equal(JSON.stringify(readState()).includes("SECRET_CANARY"), false);
      }
      assert.equal(blocked.filter(origin => origin.includes("posthog")).length, 0, "renderer never attempts PostHog");
      console.log(`Electron telemetry ${phase}: PASS (${batches.length} synthetic local batches; zero live telemetry)`);
      passed = true;
    } catch (error) { console.error(error.stack); }
    finally {
      clearTimeout(timeout);
      dispose?.(); telemetry?.close();
      if (w && !w.isDestroyed()) w.destroy();
      for (const server of [ui?.server, sink?.server]) {
        if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
      }
      app.exit(passed ? 0 : 1);
    }
  }).catch((error) => { console.error(error.stack); app.exit(1); });
}
