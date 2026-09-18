"use strict";

// Real production React bundle + production preload/IPC/collector/transport.
// All API state and telemetry receivers are local fixtures; no backend/runtime
// is started, no user's profile is read, and no PostHog request reaches the web.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (!process.versions.electron) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-telemetry-electron-"));
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    for (const phase of ["first", "restart", "disabled"]) {
      const child = spawnSync(require("electron"), [__filename, "--fixture", root, phase], {
        env, encoding: "utf8", timeout: 40_000,
      });
      // Child errors concern only synthetic state, never user payloads.
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.status !== 0) throw new Error(`Electron ${phase} failed: ${child.stderr || child.error || child.status}`);
    }
    console.log("Product telemetry Electron smoke: fresh/legacy setup, no idle or synthetic activity, real input, private persistence, restart, UTC and disabled build passed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const http = require("node:http");
  const { EventEmitter } = require("node:events");
  const { app, BrowserWindow, ipcMain, powerMonitor } = require("electron");
  const { createConfigStore } = require("../app/core/config-store");
  const { createProductTelemetry } = require("../app/core/product-telemetry");
  const { createPostHogTransport, ENDPOINTS } = require("../app/core/product-telemetry-posthog");
  const { registerDesktopTelemetryIpc } = require("../app/desktop-telemetry-ipc");
  const { BUILD, fakeClock } = require("./helpers/product-telemetry-fixtures.cjs");
  const at = process.argv.indexOf("--fixture");
  const root = process.argv[at + 1];
  const phase = process.argv[at + 2];
  assert.ok(root && ["first", "restart", "disabled"].includes(phase));
  const profile = path.join(root, phase === "disabled" ? "disabled-profile" : "enabled-profile");
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
      if (phase !== "restart") configStore.write({ locale: "en", setupCompletedAt: 0, gatewayUrl: "", token: "", notifications: { chat: false, cron: false, task: false } });
      else configStore.write({ setupCompletedAt: 1, token: "synthetic-local-token" });
      const clock = fakeClock(phase === "restart" ? "2026-09-11T02:00:00Z" : "2026-09-10T23:59:59.999Z");
      const batches = [];
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
        if (url.pathname.startsWith("/__api/")) return json({ error: "synthetic backend unavailable" }, 501);
        const file = path.resolve(uiDir, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
        if (!file.startsWith(`${uiDir}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json({ error: "fixture resource missing" }, 404);
        const type = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp" })[path.extname(file)] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        fs.createReadStream(file).pipe(res);
      });
      telemetry = createProductTelemetry({ statePath, readConfigStatus: configStore.getReadStatus, clock,
        buildConfig: { ...BUILD, exportEnabled: phase !== "disabled" },
        transport: createPostHogTransport({ projectToken: BUILD.projectToken, region: "us", fetchImpl(url, options) {
          assert.equal(url, ENDPOINTS.us);
          // Test dependency injection only. Production has no custom endpoint switch.
          return fetch(`${sink.url}/batch/`, options);
        } }),
      });
      const power = new EventEmitter();
      power.getSystemIdleState = (threshold) => powerMonitor.getSystemIdleState(threshold);
      dispose = registerDesktopTelemetryIpc({ ipcMain, getMainWindow: () => w, getUiOrigin: () => ui.url,
        powerMonitor: power, telemetry, now: clock.now });
      ipcMain.on("openclaw:get-config", (event) => { event.returnValue = { ...configStore.read(), effectiveLocale: "en" }; });
      w = new BrowserWindow({ show: true, width: 1200, height: 850, title: "Shoggoth telemetry isolated test",
        webPreferences: { preload: path.join(__dirname, "../app/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
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
        w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
        w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
        await delay(100);
      };
      await w.loadURL(page); await ready(); await focus();
      const previousId = phase === "restart" ? readState().distinctId : null;
      const before = phase === "restart" ? fs.readFileSync(statePath, "utf8") : null;
      await w.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent("keydown", {key:"SECRET_CANARY",bubbles:true}));
        document.dispatchEvent(new Event("scroll", {bubbles:true}));
        window.scrollTo(0,200);`);
      await delay(200);
      if (phase !== "restart") assert.equal(fs.existsSync(statePath), false, "startup and synthetic input must not create identity");
      else assert.equal(fs.readFileSync(statePath, "utf8"), before);
      if (phase === "first") {
        // Formal navigation itself is not activity; test an actual excluded route
        // with trusted input before any event has been generated.
        await w.webContents.executeJavaScript('location.hash="/glass"');
        await delay(250); await input();
        assert.equal(fs.existsSync(statePath), false, "lab activity is excluded");
        await w.webContents.executeJavaScript('location.hash="/settings?probe=SECRET_CANARY"');
        await delay(250);
      }
      await input();
      if (phase === "disabled") {
        await telemetry.flush();
        assert.equal(fs.existsSync(statePath), false);
        assert.equal(batches.length, 0);
      } else if (phase === "restart") {
        await telemetry.flush();
        assert.equal(readState().distinctId, previousId);
        assert.equal(readState().outbox.length, 0);
        assert.equal(batches.length, 0, "same-day app restart must not duplicate activity");
      } else {
        await waitUntil(() => fs.existsSync(statePath), "first trusted activity");
        const first = readState().outbox[0].event;
        assert.equal(first.properties.report_day, "2026-09-10");
        assert.equal(readState().outbox.length, 1);
        // Host may flush already-recorded events while the window is hidden.
        w.hide(); await telemetry.flush();
        assert.equal(batches.length, 1);
        assert.deepEqual(batches[0].batch, [first]);
        clock.advance(1);
        await w.webContents.executeJavaScript(`window.__fixtureNow=${clock.now()};window.openclawDesktop.productTelemetry.recordActivity();`);
        await delay(100);
        assert.equal(readState().outbox.length, 0, "even a forged bridge call fails while hidden");
        await focus();
        power.emit("suspend");
        await w.webContents.executeJavaScript("window.openclawDesktop.productTelemetry.recordActivity()");
        await delay(100);
        power.emit("resume");
        assert.equal(readState().outbox.length, 0);
        await input();
        await waitUntil(() => readState().outbox.length === 1, "next-day activity");
        assert.equal(readState().distinctId, first.distinct_id);
        assert.equal(readState().outbox[0].event.properties.report_day, "2026-09-11");
        await telemetry.flush();
        assert.equal(batches.length, 2);
        assert.equal(batches[1].batch.length, 1);
        assert.equal(batches[1].batch[0].properties.$geoip_disable, true);
        assert.equal(batches[1].batch[0].properties.$process_person_profile, false);
        assert.equal(JSON.stringify(readState()).includes("SECRET_CANARY"), false);
      }
      assert.equal(blocked.filter((origin) => origin.includes("posthog")).length, 0, "renderer never attempts PostHog");
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
