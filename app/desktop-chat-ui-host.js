"use strict";
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { wrapperHtml, WRAPPER_CSP, PERMISSIONS_POLICY } = require("./native-chat-ui-renderer");
const { createChatUiDiagnostics } = require("./agent-service/chat-ui-diagnostics");
const { performance } = require("node:perf_hooks");
const CHANNEL = "shoggoth-chat-ui:bridge";
const TYPES = new Set(["ready", "state.local", "state.patch", "resize", "requestAction", "heartbeat", "flushed", "status", "focus.return", "historyPrompt"]);
function hostError(code) { return Object.assign(new Error(code), { code }); }
const finite = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 100_000;
function rectangle(value) {
  if (!value || !["x", "y", "width", "height"].every(key => finite(value[key])) || value.width < 0 || value.height < 0) throw hostError("UI_LAYOUT_INVALID");
  return value;
}
function clippedLayout(rect, clip, zoom = 1) {
  rectangle(rect); rectangle(clip);
  if (!finite(zoom) || zoom < 0.25 || zoom > 5) throw hostError("UI_LAYOUT_INVALID");
  const left = Math.max(rect.x, clip.x), top = Math.max(rect.y, clip.y);
  const right = Math.min(rect.x + rect.width, clip.x + clip.width), bottom = Math.min(rect.y + rect.height, clip.y + clip.height);
  return { bounds: { x: Math.round(left * zoom), y: Math.round(top * zoom), width: Math.max(0, Math.floor((right - left) * zoom)), height: Math.max(0, Math.floor((bottom - top) * zoom)) },
    document: { width: rect.width, height: rect.height, offsetX: Math.max(0, left - rect.x), offsetY: Math.max(0, top - rect.y) } };
}

class DesktopChatUiHost {
  constructor({ WebContentsView, ipcMain, session, webContents, now = Date.now, heartbeatMs = 2000, heartbeatTimeoutMs = 8000, diagnosticSink }) {
    this.diagnostics = createChatUiDiagnostics({ plane: "renderer", sink: diagnosticSink });
    Object.assign(this, { WebContentsView, ipcMain, session, webContents, now, heartbeatMs, heartbeatTimeoutMs });
    this.entries = new Map(); this.byContents = new Map(); this.pending = new Set(); this.disposals = new Set();
    this.mountTail = Promise.resolve(); this.closed = false;
    ipcMain.handle(CHANNEL, async (event, value) => {
      const entry = this.byContents.get(event.sender.id);
      if (!entry || entry.closed || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== entry.url) throw hostError("UI_SCOPE_MISMATCH");
      if (!value || Object.getPrototypeOf(value) !== Object.prototype || !TYPES.has(value.type)
        || Buffer.byteLength(JSON.stringify(value)) > 12 * 1024) throw hostError("UI_BRIDGE_REJECTED");
      const at = this.now(); entry.requests = entry.requests.filter(time => at - time < 1000);
      if (entry.requests.length >= 30) throw hostError("UI_RATE_LIMITED"); entry.requests.push(at);
      if (value.type === "heartbeat") { entry.lastHeartbeat = at; return { ok: true, result: null }; }
      if (value.type === "focus.return") {
        entry.ownerWindow.webContents.focus(); entry.onNotify({ mountId: entry.mountId, type: "focus-return" });
        return { ok: true, result: null };
      }
      const firstReady = value.type === "ready" && !entry.ready;
      if (value.type === "ready") { entry.ready = true; entry.lastHeartbeat = at; }
      try {
        const result = await entry.onMessage(value);
        if (firstReady) this.diagnostics.emit("renderer.ready", { mountId: entry.mountId, code: "OK",
          durationMs: performance.now() - entry.startedAt, htmlBytes: entry.htmlBytes });
        return { ok: true, result };
      }
      catch (error) { return { ok: false, error: { code: /^[A-Z0-9_]{1,96}$/u.test(error?.code || "") ? error.code : "UI_BRIDGE_REJECTED",
        ...(error?.state ? { state: error.state } : {}) } }; }
    });
  }

  mount(options) {
    if (this.closed) return Promise.reject(hostError("UI_HOST_CLOSED"));
    const task = this.mountTail.catch(() => {}).then(() => this._mount(options));
    this.mountTail = task; this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {}); return task;
  }

  async _mount(options) {
    return this.diagnostics.measure("renderer.mount", { mountId: options.mountId,
      htmlBytes: typeof options.html === "string" ? Buffer.byteLength(options.html) : 0 }, () => this._createMount(options));
  }
  async _createMount({ ownerWindow, mountId, html, descriptor, onMessage, onClose = async () => {}, onNotify = () => {} }) {
    const startedAt = performance.now();
    if (this.closed) throw hostError("UI_HOST_CLOSED");
    if (this.entries.has(mountId)) throw hostError("UI_MOUNT_CONFLICT");
    if (!ownerWindow || ownerWindow.isDestroyed() || typeof mountId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(mountId)
      || typeof html !== "string" || Buffer.byteLength(html) > 2 * 1024 * 1024 || typeof onMessage !== "function") throw hostError("UI_MOUNT_INVALID");
    for (const entry of this.entries.values()) if (entry.ownerWindow === ownerWindow) await this.close(entry.mountId);
    if (this.entries.size >= 8) throw hostError("UI_HOST_CAPACITY");
    const requestPath = `/native-ui/${crypto.randomBytes(32).toString("hex")}`;
    let url = null, entry = null;
    const body = Buffer.from(wrapperHtml(html, descriptor));
    const server = http.createServer((request, response) => {
      if (!url || request.url !== requestPath || request.method !== "GET" || request.headers.host !== new URL(url).host) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length,
        "Content-Security-Policy": WRAPPER_CSP, "Permissions-Policy": PERMISSIONS_POLICY,
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }); response.end(body);
    });
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      url = `http://127.0.0.1:${server.address().port}${requestPath}`;
      if (this.closed || ownerWindow.isDestroyed()) throw hostError("UI_HOST_CLOSED");
      const partition = this.session.fromPartition(`native-chat-ui-${crypto.randomUUID()}`, { cache: false });
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); partition.setPermissionCheckHandler(() => false);
      partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== url }));
      partition.on("will-download", event => event.preventDefault());
      const view = new this.WebContentsView({ webPreferences: { session: partition,
        preload: path.join(__dirname, "desktop-chat-ui-preload.js"), nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, webviewTag: false, devTools: false, safeDialogs: true,
        backgroundThrottling: false, webRTCIPHandlingPolicy: "disable_non_proxied_udp" } });
      entry = { mountId, ownerWindow, ownerContents: ownerWindow.webContents, view, url, server, onMessage, onClose, onNotify, closed: false, generation: 0,
        startedAt, htmlBytes: Buffer.byteLength(html), ready: false, lastHeartbeat: this.now(), requests: [], visible: false, childIdentity: null, childLoaded: false, timer: null };
      this.entries.set(mountId, entry); this.byContents.set(view.webContents.id, entry);
      ownerWindow.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 1, height: 1 }); view.setVisible(false);
      view.setBackgroundColor("#00000000");
      const fail = code => {
        this.diagnostics.emit("renderer.failure", { mountId, code, durationMs: performance.now() - startedAt, htmlBytes: entry.htmlBytes });
        onNotify({ mountId, code }); void this.close(mountId);
      };
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      view.webContents.on("will-navigate", event => event.preventDefault());
      view.webContents.on("will-frame-navigate", event => { if (event.url !== "about:srcdoc") event.preventDefault(); });
      view.webContents.on("will-attach-webview", event => event.preventDefault());
      view.webContents.on("did-navigate", (_event, target) => { if (target !== url) fail("UI_NAVIGATION_BLOCKED"); });
      view.webContents.on("did-frame-navigate", (_event, target, _code, _status, isMain, processId, routingId) => {
        if (isMain) { if (target !== url) fail("UI_NAVIGATION_BLOCKED"); return; }
        const main = view.webContents.mainFrame, child = main.frames.find(frame => frame.processId === processId && frame.routingId === routingId);
        if (!child || main.frames.length !== 1 || child.parent !== main) { fail("UI_NAVIGATION_BLOCKED"); return; }
        if (target === "about:blank" && !entry.childLoaded && entry.childIdentity === null) { entry.childIdentity = child.frameTreeNodeId; return; }
        if (target === "about:srcdoc" && !entry.childLoaded && (entry.childIdentity === null || entry.childIdentity === child.frameTreeNodeId)) {
          entry.childIdentity = child.frameTreeNodeId; entry.childLoaded = true; return;
        }
        fail("UI_NAVIGATION_BLOCKED");
      });
      view.webContents.on("did-fail-load", (_event, code) => { if (code !== -3) fail("UI_LOAD_FAILED"); });
      view.webContents.on("render-process-gone", () => fail("UI_RENDERER_GONE"));
      view.webContents.on("unresponsive", () => this.stop(mountId));
      view.webContents.on("before-input-event", (event, input) => {
        if (input.key !== "Escape" || input.isComposing || input.type !== "keyDown") return;
        event.preventDefault(); ownerWindow.webContents.focus(); onNotify({ mountId, type: "focus-return" });
      });
      entry.ownerClosed = () => { void this.close(mountId); }; ownerWindow.once("closed", entry.ownerClosed);
      entry.ownerNavigation = (details, _url, legacySameDocument, legacyMainFrame) => {
        const mainFrame = typeof details?.isMainFrame === "boolean" ? details.isMainFrame : legacyMainFrame;
        const sameDocument = typeof details?.isSameDocument === "boolean" ? details.isSameDocument : legacySameDocument;
        if (mainFrame === true && sameDocument === false) void this.close(mountId);
      };
      // A new main document owns new React/IPC mounts. Hash/history navigation
      // keeps the current document and must retain the existing interaction.
      ownerWindow.webContents.on("did-start-navigation", entry.ownerNavigation);
      await view.webContents.loadURL(url);
      if (entry.closed) throw hostError("UI_LOAD_FAILED");
      if (view.webContents.getOSProcessId() === ownerWindow.webContents.getOSProcessId()) throw hostError("UI_RENDERER_NOT_ISOLATED");
      entry.timer = setInterval(() => {
        if (entry.closed || !entry.ready) return;
        if (this.now() - entry.lastHeartbeat > this.heartbeatTimeoutMs) { this.stop(mountId); return; }
        view.webContents.send("shoggoth-chat-ui:update", { type: "heartbeat" });
      }, this.heartbeatMs); entry.timer.unref();
      return { mountId, rendererProcessId: view.webContents.getOSProcessId(), ownerProcessId: ownerWindow.webContents.getOSProcessId() };
    } catch (error) {
      if (entry) await this.close(mountId);
      else { server.closeAllConnections?.(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
      throw error;
    }
  }

  layout(mountId, { generation, rect, clip, occluded = false }) {
    const entry = this.entries.get(mountId); if (!entry || entry.closed) throw hostError("UI_MOUNT_EXPIRED");
    if (!Number.isSafeInteger(generation) || generation < entry.generation) return false;
    entry.generation = generation;
    const zoom = entry.ownerWindow.webContents.getZoomFactor(), result = clippedLayout(rect, clip, zoom);
    if (!result.bounds.width || !result.bounds.height) {
      entry.visible = false; entry.view.setVisible(false); return true;
    }
    const size = entry.ownerWindow.getContentBounds();
    if (result.bounds.x < 0 || result.bounds.y < 0 || result.bounds.x + result.bounds.width > size.width + 1 || result.bounds.y + result.bounds.height > size.height + 1) throw hostError("UI_LAYOUT_INVALID");
    entry.view.webContents.setZoomFactor(zoom); entry.view.setBounds(result.bounds);
    entry.visible = !occluded && result.bounds.width > 0 && result.bounds.height > 0; entry.view.setVisible(entry.visible);
    entry.view.webContents.send("shoggoth-chat-ui:update", { type: "layout", value: result.document }); return true;
  }

  update(mountId, value) {
    const entry = this.entries.get(mountId); if (!entry || entry.closed) return false;
    entry.view.webContents.send("shoggoth-chat-ui:update", value); return true;
  }

  stop(mountId) {
    const entry = this.entries.get(mountId); if (!entry || entry.closed) return;
    // Chromium can put the opaque srcdoc into an OOPIF. Crashing only the
    // wrapper leaves that CPU-bound process alive. Electron supplies its OS
    // identity; never accept a PID through the bridge or from generated HTML.
    const child = entry.view.webContents.mainFrame.frames.find(frame => frame.frameTreeNodeId === entry.childIdentity);
    const childPid = child?.url === "about:srcdoc" ? child.osProcessId : 0;
    const others = this.webContents?.getAllWebContents?.();
    if (childPid > 0 && Array.isArray(others) && childPid !== entry.ownerWindow.webContents.getOSProcessId()
      && !others.some(contents => {
        if (contents === entry.view.webContents || contents.isDestroyed()) return false;
        const frames = [contents.mainFrame];
        for (let i = 0; i < frames.length; i++) {
          if (frames[i].osProcessId === childPid) return true;
          frames.push(...frames[i].frames);
        }
        return false;
      })) {
      try { process.kill(childPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") entry.onNotify({ mountId, code: "UI_RENDERER_STOP_FAILED" }); }
    }
    const pid = entry.view.webContents.getOSProcessId();
    if (pid !== entry.ownerWindow.webContents.getOSProcessId()
      && ![...this.entries.values()].some(other => other !== entry && other.view.webContents.getOSProcessId() === pid)) {
      entry.view.webContents.forcefullyCrashRenderer();
    }
    this.diagnostics.emit("renderer.failure", { mountId, code: "UI_RENDERER_UNRESPONSIVE",
      durationMs: performance.now() - entry.startedAt, htmlBytes: entry.htmlBytes });
    entry.onNotify({ mountId, code: "UI_RENDERER_UNRESPONSIVE" }); void this.close(mountId);
  }

  async close(mountId) {
    const entry = this.entries.get(mountId); if (!entry) return;
    if (entry.disposing) return entry.disposing;
    entry.closed = true; clearInterval(entry.timer); this.entries.delete(mountId); this.byContents.delete(entry.view.webContents.id);
    this.diagnostics.emit("renderer.close", { mountId, code: "OK", durationMs: performance.now() - entry.startedAt, htmlBytes: entry.htmlBytes });
    entry.ownerWindow.removeListener("closed", entry.ownerClosed);
    entry.ownerContents.removeListener("did-start-navigation", entry.ownerNavigation);
    if (!entry.ownerWindow.isDestroyed()) entry.ownerWindow.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false });
    entry.disposing = (async () => { entry.server.closeAllConnections?.(); if (entry.server.listening) await new Promise(resolve => entry.server.close(resolve)); await entry.onClose(); })();
    this.disposals.add(entry.disposing);
    void entry.disposing.finally(() => this.disposals.delete(entry.disposing)).catch(() => {});
    return entry.disposing;
  }

  async closeAll() {
    this.closed = true;
    await Promise.allSettled([...this.entries.keys()].map(id => this.close(id)));
    await Promise.allSettled([...this.pending]); await Promise.allSettled([...this.disposals]);
  }
}
module.exports = { DesktopChatUiHost, clippedLayout };
