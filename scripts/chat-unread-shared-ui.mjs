#!/usr/bin/env node
// Two actual ChatPages in independent browser profiles, sharing one App store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";
const root = path.resolve(import.meta.dirname, ".."), ui = path.join(root, "app/manage-ui");
const require = createRequire(path.join(root, "package.json"));
const { createChatReadStateStore } = require("./app/core/chat-read-state-store");
const { build } = createRequire(path.join(ui, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-unread-shared-"));
const output = path.resolve(process.env.CHAT_UNREAD_SHARED_OUTPUT || path.join(temp, "output"));
fs.mkdirSync(output, { recursive: true });
let store = createChatReadStateStore({ trustedRoot: temp });
store.ensure();
const initial = store.read();
let server;
let available = true;
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-sidebar-order.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [path.join(ui, "node_modules")], loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), logLevel: "silent", plugins: [viteArtworkFixturePlugin(root)] });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/__api/chat-read-state") {
      if (!available) { res.writeHead(503); res.end("Unavailable"); return; }
      let state;
      if (req.method === "POST") {
        const body = []; for await (const chunk of req) body.push(chunk);
        state = store.merge(JSON.parse(Buffer.concat(body)));
      } else state = store.read();
      const unchanged = req.method === "GET" && url.searchParams.get("installationId") === state.installationId
        && url.searchParams.get("revision") === String(state.revision);
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ state: unchanged ? null : state })); return;
    }
    if (url.pathname === "/fixture/restart") {
      store = createChatReadStateStore({ trustedRoot: temp, now: () => Date.now() + 100000 });
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(store.read())); return;
    }
    if (url.pathname === "/fixture/availability") {
      available = url.searchParams.get("available") !== "false";
      res.end("ok"); return;
    }
    const file = { "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" }[url.pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/?scenario=unread-shared#/chat`;
  const run = async ({ temp, output, url, initial }) => {
    const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
    const assert = require("node:assert/strict");
    app.setPath("userData", path.join(temp, "profiles"));
    await app.whenReady();
    const windows = ["a", "b"].map(name => new BrowserWindow({ show: false, width: 1200, height: 850,
      webPreferences: { partition: "unread-" + name, backgroundThrottling: false } }));
    const evaluate = (w, code) => w.webContents.executeJavaScript(code, true);
    const wait = async (w, code, label) => {
      const until = Date.now() + 12000;
      while (!await evaluate(w, code)) {
        if (Date.now() > until) throw Error(label);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    };
    const stages = [];
    let success = false;
    try {
      const [a, b] = windows;
      await Promise.all(windows.map(w => w.loadURL(url)));
      for (const w of windows) await wait(w, "window.sharedUnreadFixture?.ready()", "ChatPage did not load shared baseline");
      for (const w of windows) {
        const state = await evaluate(w, "window.sharedUnreadFixture.stored()");
        assert.equal(state.since, initial.since);
        assert.equal(state.installationId, initial.installationId);
        assert.equal(await evaluate(w, "window.sharedUnreadFixture.badge()"), false);
      }
      stages.push("two independent profiles ignore old v2 dots and historical sessions");
      fs.writeFileSync(path.join(output, "historical-no-dots.png"), (await a.webContents.capturePage()).toPNG());
      const first = Date.now();
      for (const w of windows) await evaluate(w, `window.sharedUnreadFixture.publish("NEW_AFTER_INSTALL", ${first})`);
      for (const w of windows) await wait(w, "window.sharedUnreadFixture.badge()", "new reply must mark both clients unread");
      stages.push("a post-install reply produces a dot in both clients");
      fs.writeFileSync(path.join(output, "new-reply-dot.png"), (await b.webContents.capturePage()).toPNG());
      await evaluate(a, "window.sharedUnreadFixture.read()");
      await wait(a, "!window.sharedUnreadFixture.badge()", "reading must clear first client");
      await wait(b, "!window.sharedUnreadFixture.badge()", "shared acknowledgement must clear second client without opening its session");
      assert.ok(!(await evaluate(b, "document.querySelector('.chat-thread').textContent")).includes("NEW_AFTER_INSTALL"));
      stages.push("reading in App clears the other client's dot within the refresh interval");
      for (const w of windows) await evaluate(w, "window.sharedUnreadFixture.main()");
      const second = Date.now();
      for (const w of windows) await evaluate(w, `window.sharedUnreadFixture.publish("NEWER_UNREAD_REPLY", ${second})`);
      for (const w of windows) await wait(w, "window.sharedUnreadFixture.badge()", "newer unread must survive the old acknowledgement");
      const restarted = await evaluate(a, "fetch('/fixture/restart').then(r => r.json())");
      assert.equal(restarted.since, initial.since);
      assert.equal(restarted.installationId, initial.installationId);
      await b.loadURL(url);
      await wait(b, "window.sharedUnreadFixture?.ready()", "reopened browser must load App state");
      await evaluate(b, `window.sharedUnreadFixture.publish("NEWER_UNREAD_REPLY", ${second})`);
      await wait(b, "window.sharedUnreadFixture.badge()", "restart must preserve newer unread");
      stages.push("restart and a fresh browser retain the original cutoff and genuinely newer unread");
      await evaluate(b, "window.sharedUnreadFixture.read()");
      await wait(a, "!window.sharedUnreadFixture.badge()", "reverse-direction acknowledgement must propagate");
      stages.push("read synchronization works in both directions");
      fs.writeFileSync(path.join(output, "shared-read-cleared.png"), (await a.webContents.capturePage()).toPNG());
      await evaluate(a, "fetch('/fixture/availability?available=false')");
      const unavailable = new BrowserWindow({ show: false, width: 1200, height: 850,
        webPreferences: { partition: "unread-unavailable", backgroundThrottling: false } });
      windows.push(unavailable);
      await unavailable.loadURL(url.replace("#/chat", "&longHistory=1#/chat"));
      await wait(unavailable, `(() => {
        const thread = document.querySelector('.chat-thread');
        return thread?.textContent.includes('UNREAD_SERVICE_HISTORY_49')
          && thread.scrollHeight > thread.clientHeight
          && Math.abs(thread.scrollHeight - thread.scrollTop - thread.clientHeight) < 2;
      })()`, "unavailable read state must still land at the end of a long transcript");
      assert.equal(await evaluate(unavailable, "window.sharedUnreadFixture.badge()"), false);
      await evaluate(a, "fetch('/fixture/availability?available=true')");
      await evaluate(unavailable, "window.sharedUnreadFixture.focus()");
      await wait(unavailable, "window.sharedUnreadFixture.ready()", "read state must recover after temporary unavailability");
      assert.equal((await evaluate(unavailable, "window.sharedUnreadFixture.stored()")).since, initial.since);
      stages.push("an unavailable read-state service preserves long-chat scrolling and recovers the same cutoff");
      fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ passed: true, stages, initial }, null, 2));
      console.log(JSON.stringify({ passed: true, stages })); success = true;
    } catch (error) { console.error(error.stack); }
    finally { for (const w of windows) w.destroy(); app.exit(success ? 0 : 1); }
  };
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `(${run.toString()})(${JSON.stringify({ temp, output, url, initial })}).catch(e => { console.error(e); require('electron').app.exit(1); });`);
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [main], { env, stdio: "inherit" });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60000);
  const code = await new Promise(resolve => child.on("exit", resolve)); clearTimeout(timeout);
  assert.equal(code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "results.json"))).passed, true);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
}
