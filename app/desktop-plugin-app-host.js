"use strict";
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

const CHANNEL = "shoggoth-plugin-app:request";
const MAX_HTML = 192 * 1024;

function wrapperHtml(html, csp, initialNotifications = []) {
  const literal = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  // Untrusted HTML exists only inside the opaque child. JSON encoding prevents
  // closing the wrapper script or creating sibling elements in the Host.
  return `<!doctype html><html><head><meta charset="utf-8"><title>MCP App</title>
<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{overflow:hidden}</style></head>
<body><iframe id="app" sandbox="allow-scripts" referrerpolicy="no-referrer" title="MCP App"></iframe>
<script>
const frame=document.getElementById('app');
const policy=${literal(csp)};
const html=${literal(html)};
let loads=0;
let seeded=false;
const initialNotifications=${literal(initialNotifications)};
frame.addEventListener('load',()=>{if(++loads>1){frame.remove();}});
window.addEventListener('message',async event=>{
  if(event.source!==frame.contentWindow||event.origin!=='null')return;
  try{const response=await window.pluginAppBridge.request(event.data);
    if(response)frame.contentWindow?.postMessage(response,'*');
    if(event.data?.method==='ui/notifications/initialized'&&!seeded){
      seeded=true;
      for(const notification of initialNotifications)frame.contentWindow?.postMessage(notification,'*');
    }
  }catch{frame.remove();}
});
// An additional child policy can only restrict the response header.
const doc=new DOMParser().parseFromString(html,'text/html');
const meta=doc.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content=policy;
doc.head.prepend(meta);frame.srcdoc='<!doctype html>'+doc.documentElement.outerHTML;
</script></body></html>`;
}

class DesktopPluginAppHost {
  constructor({ BrowserWindow, ipcMain, session }) {
    Object.assign(this, { BrowserWindow, ipcMain, session });
    this.windows = new Map();
    this.opening = 0;
    this.pending = new Set();
    this.closing = new Set();
    this.stopped = false;
    ipcMain.handle(CHANNEL, async (event, message) => {
      const entry = this.windows.get(event.sender.id);
      if (!entry || event.senderFrame !== event.sender.mainFrame
        || event.senderFrame.url !== entry.url || entry.closed) throw new Error("MCP App frame unavailable");
      try { return await entry.message(message); }
      catch (error) {
        if (!entry.window.isDestroyed()) entry.window.destroy();
        await entry.dispose();
        throw error;
      }
    });
  }

  open(options) {
    if (this.stopped) return Promise.reject(new Error("MCP App host closed"));
    const task = this._open(options);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }

  async _open({ create, readChunk, message, close }) {
    if (this.windows.size + this.opening >= 8) throw new Error("Too many MCP Apps");
    this.opening += 1;
    const sourceId = crypto.randomUUID();
    const requestPath = `/app/${crypto.randomBytes(32).toString("hex")}`;
    let entry = null;
    let descriptor = null;
    let content = null;
    let origin = null;
    const server = http.createServer((request, response) => {
      if (request.method !== "GET" || request.url !== requestPath
        || request.headers.host !== new URL(origin).host || content === null) {
        response.writeHead(404); response.end(); return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": descriptor.policy.contentSecurityPolicy.replace("frame-src 'none'", "frame-src 'self'"),
        "Permissions-Policy": descriptor.policy.permissionsPolicy,
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      response.end(content);
    });
    let disposePromise = null;
    const dispose = () => {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
      if (entry) { entry.closed = true; this.windows.delete(entry.webContentsId); }
      server.closeAllConnections?.();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (descriptor) { try { await close(descriptor.transport); } catch { /* Authority may already be revoked. */ } }
      })();
      this.closing.add(disposePromise);
      void disposePromise.finally(() => this.closing.delete(disposePromise)).catch(() => {});
      return disposePromise;
    };
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
      const result = await create({ sandboxOrigin: origin, sourceId });
      if (result.canceled) { await dispose(); return { opened: false }; }
      descriptor = result.descriptor;
      if (this.stopped) throw new Error("MCP App host closed");
      if (!descriptor || descriptor.sandboxOrigin !== origin
        || descriptor.transport?.sourceId !== sourceId
        || descriptor.resource?.encoding !== "base64"
        || !Number.isSafeInteger(descriptor.resource.byteLength) || descriptor.resource.byteLength < 1
        || descriptor.resource.byteLength > MAX_HTML
        || typeof descriptor.resource.contentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.resource.contentDigest)
        || !Number.isSafeInteger(descriptor.resource.chunkCount) || descriptor.resource.chunkCount < 1
        || descriptor.resource.chunkCount > 16) throw new Error("Invalid MCP App descriptor");
      const parts = [];
      for (let index = 0; index < descriptor.resource.chunkCount; index++) {
        const chunk = await readChunk(descriptor.transport, index);
        if (this.stopped) throw new Error("MCP App host closed");
        const data = chunk.data ?? chunk.text;
        if (chunk.index !== index || chunk.total !== descriptor.resource.chunkCount
          || typeof data !== "string" || !data || data.length > 24 * 1024
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
          || (index < descriptor.resource.chunkCount - 1 && data.includes("="))) throw new Error("Invalid MCP App chunk");
        parts.push(data);
      }
      const bytes = Buffer.from(parts.join(""), "base64");
      if (bytes.length !== descriptor.resource.byteLength || bytes.length > MAX_HTML
        || crypto.createHash("sha256").update(bytes).digest("hex") !== descriptor.resource.contentDigest) {
        throw new Error("Invalid MCP App resource size or digest");
      }
      const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      content = wrapperHtml(html, descriptor.policy.contentSecurityPolicy, descriptor.initialNotifications);
      const url = `${origin}${requestPath}`;
      const partition = this.session.fromPartition(`plugin-app-${sourceId}`, { cache: false });
      // No cookies from the main App, no persistent session, and no outbound
      // network even if untrusted JS navigates instead of using fetch.
      partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
      partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== url }));
      partition.on("will-download", event => event.preventDefault());
      const window = new this.BrowserWindow({ width: 800, height: 640, minWidth: 360, minHeight: 320,
        title: "Shoggoth · MCP App", show: false,
        webPreferences: { session: partition, preload: path.join(__dirname, "desktop-plugin-app-preload.js"),
          nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false,
          devTools: false, safeDialogs: true } });
      entry = { window, webContentsId: window.webContents.id, url, closed: false,
        message: payload => message(descriptor.transport, payload), dispose };
      this.windows.set(window.webContents.id, entry);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", event => event.preventDefault());
      window.webContents.on("will-frame-navigate", event => {
        // The initial opaque srcdoc is the only subframe navigation.
        const target = event.url;
        if (target !== "about:srcdoc") event.preventDefault();
      });
      window.webContents.on("will-attach-webview", event => event.preventDefault());
      const failClosed = () => {
        if (!window.isDestroyed()) window.destroy();
        void dispose();
      };
      window.webContents.on("did-navigate", (_event, target) => {
        if (target !== url) failClosed();
      });
      let childFrame = null;
      let childLoaded = false;
      window.webContents.on("did-frame-navigate", (_event, target, _code, _status, isMainFrame, processId, routingId) => {
        if (isMainFrame) { if (target !== url) failClosed(); return; }
        const main = window.webContents.mainFrame;
        const child = main.frames.find(frame => frame.processId === processId && frame.routingId === routingId);
        if (main.frames.length !== 1 || !child || child.parent !== main) { failClosed(); return; }
        const identity = child.frameTreeNodeId;
        if (childFrame === null && target === "about:blank") { childFrame = identity; return; }
        // Opaque srcdoc can change renderer process during its first commit.
        // Only one blank + one srcdoc commit are allowed, regardless of PID.
        if (!childLoaded && target === "about:srcdoc" && (childFrame === null || childFrame === identity)) {
          childFrame = identity; childLoaded = true; return;
        }
        failClosed();
      });
      window.webContents.on("did-fail-load", failClosed);
      window.webContents.on("render-process-gone", failClosed);
      window.on("closed", () => { void dispose(); });
      const remaining = descriptor.expiresAt - Date.now();
      if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 300_000) throw new Error("MCP App session expired");
      const timer = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, remaining);
      timer.unref?.();
      window.on("closed", () => clearTimeout(timer));
      await window.loadURL(url);
      if (this.stopped || entry.closed) throw new Error("MCP App host closed");
      window.show();
      return { opened: true };
    } catch (error) {
      if (entry && !entry.window.isDestroyed()) entry.window.destroy();
      await dispose();
      throw error;
    } finally { this.opening -= 1; }
  }

  async closeAll() {
    this.stopped = true;
    await Promise.all([...this.windows.values()].map(async entry => {
      if (!entry.window.isDestroyed()) entry.window.destroy();
      await entry.dispose();
    }));
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.closing]);
  }
}

module.exports = { DesktopPluginAppHost, wrapperHtml };
