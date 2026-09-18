#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(root, "app/manage-ui");
const source = path.join(uiRoot, "src/lib/chatHistoryCache.ts");
if (!fs.existsSync(source)) { console.error("FAIL missing chatHistoryCache module"); process.exit(1); }
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-cache-"));
try {
  const bundle = path.join(temp, "cache.mjs");
  // Read-only before/after comparison without replacing dirty workspace files.
  const sourceRef = process.env.CHAT_CACHE_SOURCE_REF;
  const cacheSource = sourceRef ? path.join(temp, "baseline.ts") : source;
  if (sourceRef) fs.writeFileSync(cacheSource, execFileSync("git", ["show", `${sourceRef}:app/manage-ui/src/lib/chatHistoryCache.ts`], { cwd: root }));
  execFileSync(path.join(uiRoot, "node_modules/.bin/esbuild"), [cacheSource, "--bundle", "--platform=browser", "--format=esm", `--outfile=${bundle}`], { stdio: "pipe" });
  const renderer = `(async () => {
    const fail = (message) => { throw new Error(message); };
    const equal = (actual, expected, message) => actual === expected || fail(message + ": " + actual);
    const deep = (actual, expected, message) => JSON.stringify(actual) === JSON.stringify(expected) || fail(message);
    const api = await import(${JSON.stringify(pathToFileURL(bundle).href)});
    for (const name of ["getCachedChatHistory", "putCachedChatHistory", "deleteCachedChatHistory", "clearCachedChatHistoryExcept"]) equal(typeof api[name], "function", "missing chatHistoryCache export " + name);
    const dense = Array.from({ length: 300 }, (_, i) => ({ id: String(i), text: '多字节🙂\\\\\\"'.repeat(70) }));
    const originalEncode = TextEncoder.prototype.encode;
    let encodedBytes = 0;
    TextEncoder.prototype.encode = function(value) {
      const result = originalEncode.call(this, value);
      encodedBytes += result.byteLength;
      return result;
    };
    const started = performance.now();
    let preparationMs;
    try {
      const write = api.putCachedChatHistory("performance", "agent:dense:main", dense);
      preparationMs = performance.now() - started;
      await write;
    }
    finally { TextEncoder.prototype.encode = originalEncode; }
    console.log(JSON.stringify({ cachePreparationMs: Math.round(preparationMs), cacheWriteMs: Math.round(performance.now() - started), encodedBytes }));
    ${sourceRef || process.env.CHAT_PERF_BASELINE === "1" ? "" : 'equal(encodedBytes <= 1024 * 1024, true, "history preparation must have a bounded serialization budget");'}
    const retainedDense = await api.getCachedChatHistory("performance", "agent:dense:main");
    deep(retainedDense, dense, "multibyte and escaped history round-trips without truncation");
    const scope = "profile-a", key = "agent:hermes-owl:main";
    const messages = Array.from({ length: 301 }, (_, i) => ({ id: String(i), text: "m" + i, nested: { preview: "data:image/png;base64,secret", media: [{ url: "data:audio/wav;base64,secret" }, { url: "https://safe" }] } }));
    await api.putCachedChatHistory(scope, key, messages);
    const cached = await api.getCachedChatHistory(scope, key);
    equal(cached.length, 300, "history keeps the newest 300 messages"); deep(cached.map((m) => m.id), messages.slice(-300).map((m) => m.id), "300-message suffix is authoritative");
    equal(JSON.stringify(cached).includes("data:"), false, "nested data/media URLs are stripped");
    await api.putCachedChatHistory(scope, "agent:media:main", [{ id: "media", source: { type: "base64", media_type: "image/png", data: "naked-base64-secret" }, ordinary: { data: "business-data" }, rawArrayBuffer: new ArrayBuffer(8), rawTypedArray: new Uint8Array([1, 2, 3]), rawBlob: new Blob(["secret"]) }]);
    const mediaCached = await api.getCachedChatHistory(scope, "agent:media:main");
    equal(mediaCached[0].source.data, undefined, "bare base64 source.data is stripped"); equal(mediaCached[0].source.type, "base64", "media metadata is retained"); equal(mediaCached[0].ordinary.data, "business-data", "ordinary data fields are retained");
    equal(mediaCached[0].rawArrayBuffer, undefined, "ArrayBuffer payload is stripped"); equal(mediaCached[0].rawTypedArray, undefined, "TypedArray payload is stripped"); equal(mediaCached[0].rawBlob, undefined, "Blob payload is stripped");
    equal((await api.getCachedChatHistory("profile-b", key)), undefined, "cache miss is strictly undefined");
    await api.putCachedChatHistory(scope, "agent:empty:main", []); deep(await api.getCachedChatHistory(scope, "agent:empty:main"), [], "empty canonical history is authoritative");
    const old = [{ id: "old", text: "preserve" }]; await api.putCachedChatHistory(scope, "agent:atomic:main", old);
    const originalPut = IDBObjectStore.prototype.put; let failure = "";
    IDBObjectStore.prototype.put = function(value) { if (failure === "abort") { this.transaction.abort(); return originalPut.call(this, value); } if (failure === "quota") throw new DOMException("quota", "QuotaExceededError"); return originalPut.call(this, value); };
    failure = "abort"; await api.putCachedChatHistory(scope, "agent:atomic:main", [{ text: "new" }]); deep(await api.getCachedChatHistory(scope, "agent:atomic:main"), old, "transaction abort retains old value");
    failure = "quota"; await api.putCachedChatHistory(scope, "agent:atomic:main", [{ text: "quota" }]); deep(await api.getCachedChatHistory(scope, "agent:atomic:main"), old, "quota failure retains old value"); failure = ""; IDBObjectStore.prototype.put = originalPut;
    const db = await new Promise((resolve,reject)=>{ const request=indexedDB.open("shoggoth-chat",1); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); const done=(tx)=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error)}); const raw=async(key)=>{const tx=db.transaction("images","readonly"),request=tx.objectStore("images").get(key);await done(tx);return request.result}; equal((await raw("history::v1::"+scope+"::"+key)).version,1,"raw history envelope has version 1"); let tx=db.transaction("images","readwrite"); const images=tx.objectStore("images"); images.put({ value:"image-sentinel" },"images::sentinel"); images.put({ value:"file-sentinel" },"files::sentinel"); images.put({ envelope:"broken" },"history::v1::"+scope+"::agent:corrupt:main"); await done(tx); equal(await api.getCachedChatHistory(scope, "agent:corrupt:main"), undefined, "corrupt envelope is ignored");
    const payload = "x".repeat(512 * 1024 + 1); await api.putCachedChatHistory(scope, "agent:large:main", [{ text: payload }]); equal(await api.getCachedChatHistory(scope, "agent:large:main"), undefined, "entry over 512 KiB is not committed");
    for (let i = 0; i < 25; i++) await api.putCachedChatHistory("session-limit", "agent:session-" + i + ":main", [{ text: "x".repeat(64 * 1024) }]);
    equal(await api.getCachedChatHistory("session-limit", "agent:session-0:main"), undefined, "24-session limit evicts oldest history");
    equal(Array.isArray(await api.getCachedChatHistory("session-limit", "agent:session-24:main")), true, "newest history survives 24-session eviction");
    for (let i = 0; i < 20; i++) await api.putCachedChatHistory("byte-limit", "agent:bytes-" + i + ":main", [{ text: "x".repeat(450 * 1024) }]);
    equal(await api.getCachedChatHistory("byte-limit", "agent:bytes-0:main"), undefined, "8 MiB limit evicts oldest sub-512KiB entries");
    tx=db.transaction("images","readonly"); const check=tx.objectStore("images"); const image=check.get("images::sentinel"), file=check.get("files::sentinel"); await done(tx); deep(image.result,{ value:"image-sentinel" },"history capacity eviction preserves images"); deep(file.result,{ value:"file-sentinel" },"history capacity eviction preserves files");
    const suffix = [{ text: "x".repeat(300 * 1024) }, { id:"newest", text: "x".repeat(300 * 1024) }]; await api.putCachedChatHistory(scope,"agent:suffix:main",suffix); deep((await api.getCachedChatHistory(scope,"agent:suffix:main")).map((m)=>m.id),["newest"],"over-512KiB multi-message history retains newest fitting suffix");
    await api.putCachedChatHistory("keep-scope", "agent:keep:main", [{ id: "keep" }]); await api.putCachedChatHistory("clear-scope", "agent:clear:main", [{ id: "clear" }]);
    const originalOpenCursor = IDBObjectStore.prototype.openCursor; let historyCursorRange;
    IDBObjectStore.prototype.openCursor = function(query, direction) { historyCursorRange = query; return originalOpenCursor.call(this, query, direction); };
    await api.clearCachedChatHistoryExcept("keep-scope"); IDBObjectStore.prototype.openCursor = originalOpenCursor;
    equal(historyCursorRange instanceof IDBKeyRange, true, "clear-except constrains its cursor to history keys"); equal(historyCursorRange.lower, "history::v1::", "history cursor has the expected lower bound"); equal(historyCursorRange.upper, "history::v1::\uffff", "history cursor has the expected upper bound");
    deep(await api.getCachedChatHistory("keep-scope", "agent:keep:main"), [{ id: "keep" }], "clear-except preserves the requested scope"); equal(await api.getCachedChatHistory("clear-scope", "agent:clear:main"), undefined, "clear-except clears other scopes"); equal(await raw("history::v1::clear-scope::agent:clear:main"),undefined,"clear physically deletes raw history");
    await api.deleteCachedChatHistory("keep-scope", "agent:keep:main"); equal(await api.getCachedChatHistory("keep-scope", "agent:keep:main"), undefined, "delete removes one history entry"); equal(await raw("history::v1::keep-scope::agent:keep:main"),undefined,"delete physically removes raw history"); db.close();
    await api.clearCachedChatHistoryExcept("lru-scope");
    for (let i = 0; i < 23; i++) await api.putCachedChatHistory("lru-scope", "agent:lru-" + i + ":main", [{ id: "lru-" + i }]);
    await api.putCachedChatHistory("discard-scope", "agent:discard:main", [{ id: "discard" }]);
    await api.getCachedChatHistory("lru-scope", "agent:lru-0:main");
    await api.clearCachedChatHistoryExcept("lru-scope");
    await api.putCachedChatHistory("lru-scope", "agent:lru-23:main", [{ id: "lru-23" }]);
    await api.putCachedChatHistory("lru-scope", "agent:lru-24:main", [{ id: "lru-24" }]);
    deep(await api.getCachedChatHistory("lru-scope", "agent:lru-0:main"), [{ id: "lru-0" }], "clear-except preserves touched LRU recency");
    equal(await api.getCachedChatHistory("lru-scope", "agent:lru-1:main"), undefined, "post-clear capacity eviction removes the true LRU entry");
  })()`;
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, "<!doctype html><meta charset=\"utf-8\"><title>cache</title>");
  const fixture = path.join(temp, "fixture.mjs");
  fs.writeFileSync(fixture, `import { app, BrowserWindow } from "electron";
app.setPath("userData", ${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async () => { const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, sandbox: false } }); window.webContents.on("console-message", (_event, _level, message) => console.log(message)); try { await window.loadFile(${JSON.stringify(page)}); await window.webContents.executeJavaScript(${JSON.stringify(renderer)}); console.log("chat history cache regression: PASS"); } finally { window.destroy(); app.quit(); } }).catch((error) => { console.error(error); app.exit(1); });`);
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [fixture], { encoding: "utf8", env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.equal(result.status, 0, "Electron IndexedDB fixture failed");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
