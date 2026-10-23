"use strict";

const BRIDGE_API_VERSION = 1;
const RESOURCE_BUNDLE_ID = "native-chat-ui-v1";
const CHILD_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const WRAPPER_CSP = CHILD_CSP.replace("frame-src 'none'", "frame-src 'self'");
const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), bluetooth=()";
const literal = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

// This script lives inside the opaque generated document. Its port can only
// reach the state/lifecycle bridge; it never carries host action authority.
function installBridgeSdk() {
  "use strict";
  const pending = new Map(), stateListeners = new Set(), themeListeners = new Set();
  let port = null, sequence = 0, confirmed = null, local = null, baseRevision = 0;
  let batch = {}, waiters = [], timer = null, saving = Promise.resolve(), generation = 0;
  const jobs = [];
  let connectResolve;
  const connected = new Promise(resolve => { connectResolve = resolve; });
  const clone = value => JSON.parse(JSON.stringify(value));
  const errorOf = code => Object.assign(new Error(code), { code });
  const emit = (listeners, value) => {
    for (const listener of listeners) { try { listener(clone(value)); } catch {} }
  };
  const request = async (type, payload = {}) => {
    await connected;
    if (pending.size >= 128) throw errorOf("UI_RATE_LIMITED");
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(errorOf("UI_BRIDGE_TIMEOUT")); }, 15000);
      pending.set(id, { resolve, reject, timeout }); port.postMessage({ id, type, ...payload });
    });
  };
  const apply = value => {
    if (!value || !Number.isSafeInteger(value.stateRevision) || value.stateRevision < baseRevision) return;
    confirmed = clone(value.state); baseRevision = value.stateRevision;
    local = { ...confirmed };
    for (const job of jobs) if (job.generation === generation) Object.assign(local, job.patch);
    Object.assign(local, batch); emit(stateListeners, local);
  };
  const discard = error => {
    generation++; clearTimeout(timer); timer = null; batch = {};
    for (const item of waiters.splice(0)) item.reject(error);
    if (error.state) apply(error.state);
    else if (confirmed) apply({ state: confirmed, stateRevision: baseRevision });
  };
  const flush = () => {
    clearTimeout(timer); timer = null;
    const patch = batch, batchWaiters = waiters; batch = {}; waiters = [];
    if (!Object.keys(patch).length) return saving.then(() => ({ stateRevision: baseRevision }));
    const job = { patch, generation }; jobs.push(job);
    const task = saving.catch(() => {}).then(async () => {
      if (job.generation !== generation) throw errorOf("UI_STATE_CONFLICT");
      const result = await request("state.patch", { patch, baseStateRevision: baseRevision });
      if (job.generation !== generation) throw errorOf("UI_STATE_CONFLICT");
      jobs.splice(jobs.indexOf(job), 1); apply(result); return { stateRevision: result.stateRevision };
    });
    saving = task;
    task.then(value => { for (const item of batchWaiters) item.resolve(value); }, error => {
      const index = jobs.indexOf(job); if (index >= 0) jobs.splice(index, 1);
      for (const item of batchWaiters) item.reject(error);
      if (job.generation === generation) discard(error);
      request("status", { code: error.code || "UI_STORAGE_FAILED" }).catch(() => {});
    });
    return task;
  };
  let initialized = null;
  const ready = () => initialized || (initialized = request("ready").then(value => { apply(value); return clone(value); }));
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "shoggoth-ui-connect" || event.ports.length !== 1 || port) return;
    port = event.ports[0];
    port.onmessage = event => {
      const value = event.data;
      if (value?.type === "heartbeat") { port.postMessage({ type: "heartbeat" }); return; }
      if (value?.type === "state") {
        // External synchronization cannot silently rebase unconfirmed edits.
        if (jobs.length || Object.keys(batch).length) discard(Object.assign(errorOf("UI_STATE_CONFLICT"), { state: value.value }));
        else apply(value.value);
        return;
      }
      if (value?.type === "commit") { apply(value.value); return; }
      if (value?.type === "theme") { document.documentElement.dataset.theme = value.value; emit(themeListeners, value.value); return; }
      if (value?.type === "flush") {
        flush().then(result => request("flushed", { flushId: value.flushId, stateRevision: result.stateRevision }),
          error => request("flushed", { flushId: value.flushId, errorCode: error.code || "UI_STORAGE_FAILED" })).catch(() => {});
        return;
      }
      const item = pending.get(value?.id); if (!item) return;
      pending.delete(value.id); clearTimeout(item.timeout);
      if (value.error) item.reject(Object.assign(errorOf(value.error.code), value.error));
      else item.resolve(value.result);
    };
    port.start(); connectResolve();
  });
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
    try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  Object.defineProperty(globalThis, "shoggothUi", { value: Object.freeze({
    ready,
    setState: async patch => {
      await ready();
      if (!patch || Object.getPrototypeOf(patch) !== Object.prototype
        || Object.keys(patch).some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw errorOf("UI_STATE_INVALID");
      const copy = clone(patch); Object.assign(batch, copy); local = { ...local, ...copy }; clearTimeout(timer);
      const observed = {};
      for (const job of jobs) if (job.generation === generation) Object.assign(observed, job.patch);
      Object.assign(observed, batch);
      request("state.local", { patch: clone(observed), baseStateRevision: baseRevision }).catch(() => {});
      return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); timer = setTimeout(() => { flush().catch(() => {}); }, 250); });
    },
    onStateChange: listener => {
      stateListeners.add(listener);
      // Generated pages often subscribe after awaiting ready(). Restore the
      // latest view state for them as well, including current local edits.
      if (local !== null) emit([listener], local);
      return () => stateListeners.delete(listener);
    },
    onThemeChange: listener => { themeListeners.add(listener); return () => themeListeners.delete(listener); },
    resize: height => { request("resize", { height }).catch(() => {}); },
    requestAction: actionId => { request("requestAction", { actionId }).catch(() => {}); },
  }), writable: false, configurable: false });
  Object.defineProperty(globalThis, "sendPrompt", { value: text => {
    if (typeof text !== "string") return Promise.reject(errorOf("UI_REQUEST_INVALID"));
    return request("historyPrompt", { text });
  }, writable: false, configurable: false });
  addEventListener("error", () => { request("status", { code: "UI_SCRIPT_ERROR" }).catch(() => {}); });
  addEventListener("unhandledrejection", () => { request("status", { code: "UI_SCRIPT_ERROR" }).catch(() => {}); });
  addEventListener("keydown", event => {
    if (event.key !== "Escape" || !event.isTrusted || event.isComposing) return;
    queueMicrotask(() => { if (!event.defaultPrevented) request("focus.return").catch(() => {}); });
  });
  parent.postMessage({ type: "shoggoth-ui-bootstrap" }, "*");
}
function bridgeSdk() { return `(${installBridgeSdk.toString()})();`; }

function wrapperHtml(html, { title = "Shoggoth", layout, theme = "light", locale = "zh-CN" } = {}) {
  const { stylesheet } = require("./native-chat-ui-resources").loadChatUiResources();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
    <title>${String(title).replace(/[<>&"']/gu, "")}</title>
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{position:absolute;border:0;display:block}</style></head>
    <body><iframe id="ui" sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" title="交互内容"></iframe>
    <script>(()=>{'use strict';const frame=document.getElementById('ui');let port=null,loads=0;
      const renderLayout=value=>{if(!value)return;frame.style.width=value.width+'px';frame.style.height=value.height+'px';
        frame.style.left=-value.offsetX+'px';frame.style.top=-value.offsetY+'px';};
      renderLayout(${literal(layout || { width: 400, height: 300, offsetX: 0, offsetY: 0 })});
      window.nativeChatUiBridge.subscribe(value=>{
        if(value.type==='layout'){renderLayout(value.value);return;}
        if(value.type==='flush'&&port){port.postMessage(value);return;}
        if(port)port.postMessage(value);
      });
      frame.addEventListener('load',()=>{if(++loads>1){window.nativeChatUiBridge.request({type:'status',code:'UI_NAVIGATION_BLOCKED'}).catch(()=>{});frame.remove();}});
      window.addEventListener('message',event=>{
        if(event.source!==frame.contentWindow||event.origin!=='null'||event.ports.length||event.data?.type!=='shoggoth-ui-bootstrap'||port)return;
        const channel=new MessageChannel();port=channel.port1;
        port.onmessage=async event=>{const value=event.data;try{
          const result=await window.nativeChatUiBridge.request(value);if(value?.id)port.postMessage({id:value.id,result});
        }catch(error){if(value?.id)port.postMessage({id:value.id,error:{code:error.code||'UI_BRIDGE_REJECTED',message:error.message,...(error.state?{state:error.state}:{})}});}};
        port.start();frame.contentWindow.postMessage({type:'shoggoth-ui-connect'},'*',[channel.port2]);
      });
      const doc=new DOMParser().parseFromString(${literal(html)},'text/html');
      const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content=${literal(CHILD_CSP)};doc.head.prepend(policy);
      const sdk=doc.createElement('script');sdk.textContent=${literal(bridgeSdk())};doc.head.insertBefore(sdk,policy.nextSibling);
      const sharedStyle=doc.createElement('style');sharedStyle.textContent=${literal(stylesheet)};doc.head.insertBefore(sharedStyle,sdk.nextSibling);
      const style=doc.createElement('style');style.textContent=':root{--shoggoth-background:#fff;--shoggoth-text:#202124;--shoggoth-muted:#6b7280;--shoggoth-accent:#4775e9;--shoggoth-border:#dfe3e8;font-family:system-ui,sans-serif;color:var(--shoggoth-text);color-scheme:light dark}html[data-theme="dark"]{--shoggoth-background:#17191e;--shoggoth-text:#e8e9ed;--shoggoth-muted:#a4a9b4;--shoggoth-border:#343944}body{background:var(--shoggoth-background)}';doc.head.append(style);
      doc.documentElement.dataset.theme=${literal(theme)};doc.documentElement.lang=${literal(locale)};
      frame.srcdoc='<!doctype html>'+doc.documentElement.outerHTML;
    })();</script></body></html>`;
}

module.exports = { BRIDGE_API_VERSION, RESOURCE_BUNDLE_ID, CHILD_CSP, WRAPPER_CSP, PERMISSIONS_POLICY, wrapperHtml, bridgeSdk };
