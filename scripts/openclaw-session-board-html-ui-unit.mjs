#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "app/manage-ui/src/pages/chat-session-board/sessionBoardWidgetHost.ts");
const componentPath = path.join(root, "app/manage-ui/src/pages/chat-session-board/SessionBoardHtmlWidget.tsx");
const preloadPath = path.join(root, "app/preload.js");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-board-html-ui-"));
const outFile = path.join(outDir, "host.cjs");

try {
  execFileSync(path.join(root, "app/manage-ui/node_modules/.bin/esbuild"), [
    sourcePath, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outFile}`,
  ], { stdio: "pipe" });
  const host = createRequire(import.meta.url)(outFile);
  const ticketId = "T".repeat(43);
  const nonce = "N".repeat(32);
  const widget = {
    name: "weather", tabId: "main", content: { kind: "html", supported: false },
    grantState: "none", revision: 4, instanceId: "a".repeat(32),
    sizeW: 6, sizeH: 4, position: 0,
  };
  const calls = [];
  global.window = {
    openclawDesktop: {
      async mintSessionBoardHtmlWidget(...args) {
        calls.push(["mint", ...args]);
        return { ok: true, value: {
          frameUrl: `http://127.0.0.1:43123/v1/board-widget/${ticketId}`,
          ticketId, nonce,
          widgetIdentity: { name: widget.name, revision: widget.revision, instanceId: widget.instanceId },
        } };
      },
      async readySessionBoardHtmlWidget(...args) { calls.push(["ready", ...args]); return { ok: true, value: { ready: true } }; },
      async revokeSessionBoardHtmlWidget(...args) { calls.push(["revoke", ...args]); return { ok: true, value: { revoked: true } }; },
    },
  };
  assert.equal(host.hostableSessionBoardWidget(widget), true);
  assert.equal(host.hostableSessionBoardWidget({ ...widget, grantState: "pending" }), false);
  assert.equal(host.hostableSessionBoardWidget({ ...widget, content: { kind: "plugin", supported: false } }), false);
  const lease = await host.mintSessionBoardWidget("openclaw", "main", "agent:main:main", widget);
  assert.equal(lease.ticketId, ticketId);
  await host.markSessionBoardWidgetReady(lease);
  await host.revokeSessionBoardWidget(ticketId);
  assert.deepEqual(calls.map(([kind]) => kind), ["mint", "ready", "revoke"]);
  assert.equal(host.clampSessionBoardWidgetHeight(-100), 160);
  assert.equal(host.clampSessionBoardWidgetHeight(5000), 1200);

  global.window.openclawDesktop.mintSessionBoardHtmlWidget = async () => ({
    ok: true,
    value: {
      frameUrl: `http://evil.example/v1/board-widget/${ticketId}`,
      ticketId, nonce,
      widgetIdentity: { name: widget.name, revision: widget.revision, instanceId: widget.instanceId },
    },
  });
  await assert.rejects(
    () => host.mintSessionBoardWidget("openclaw", "main", "agent:main:main", widget),
    /BOARD_WIDGET_INVALID_LEASE/,
  );

  function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }

  function lifecycleHarness(readyPromise) {
    const order = [];
    const windowListeners = new Map();
    const timers = new Map();
    let timerId = 0;
    let readyCount = 0;
    let failureCount = 0;
    let revokeCount = 0;
    class FakePort {
      constructor() { this.peer = null; this.listener = null; this.closed = false; }
      addEventListener(type, listener) { if (type === "message") this.listener = listener; }
      start() {}
      close() { this.closed = true; }
      postMessage(data) {
        if (!this.closed && !this.peer?.closed) this.peer?.listener?.({ data, ports: [] });
      }
    }
    global.MessageChannel = class {
      constructor() {
        this.port1 = new FakePort();
        this.port2 = new FakePort();
        this.port1.peer = this.port2;
        this.port2.peer = this.port1;
      }
    };
    global.MutationObserver = class {
      observe() { order.push("observe-theme"); }
      disconnect() { order.push("disconnect-theme"); }
    };
    global.document = { documentElement: {} };
    const contentWindow = {
      postMessage(message, _target, ports) {
        assert.equal(message.type, "shoggoth:board-widget-connect");
        ports[0].postMessage({ type: "ready", nonce });
      },
    };
    const frameListeners = new Map();
    const frame = {
      contentWindow,
      addEventListener(type, listener) { frameListeners.set(type, listener); },
      removeEventListener(type) { frameListeners.delete(type); },
      setAttribute(name, value) {
        order.push(`set-${name}`);
        assert.equal(name, "src");
        assert.equal(value, lease.frameUrl);
        const listener = windowListeners.get("message");
        assert.equal(typeof listener, "function", "bootstrap listener must exist before src is assigned");
        listener({
          source: contentWindow,
          origin: "null",
          ports: [],
          data: { type: "shoggoth:board-widget-bootstrap", nonce },
        });
      },
    };
    global.window = {
      openclawDesktop: {
        readySessionBoardHtmlWidget: async () => readyPromise,
        revokeSessionBoardHtmlWidget: async () => {
          revokeCount += 1;
          return { ok: true, value: { revoked: true } };
        },
      },
      addEventListener(type, listener) { order.push(`listen-${type}`); windowListeners.set(type, listener); },
      removeEventListener(type) { windowListeners.delete(type); },
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    };
    const cleanup = host.mountSessionBoardWidgetLease({
      frame,
      lease,
      getTheme: () => ({ mode: "light", tokens: {} }),
      onReady: () => { readyCount += 1; },
      onHeight: () => {},
      onFailure: () => { failureCount += 1; },
    });
    return {
      cleanup,
      order,
      timers,
      counts: () => ({ readyCount, failureCount, revokeCount }),
    };
  }

  const instant = lifecycleHarness(Promise.resolve({ ok: true, value: { ready: true } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(instant.order.indexOf("listen-message") < instant.order.indexOf("set-src"));
  assert.equal(instant.counts().readyCount, 1, "an immediate bootstrap must not be missed");
  instant.cleanup();

  const lateReady = deferred();
  const timedOut = lifecycleHarness(lateReady.promise);
  const readyDeadline = [...timedOut.timers.values()].find(({ delay }) => delay === 9_000);
  assert.ok(readyDeadline);
  readyDeadline.callback();
  assert.equal(timedOut.counts().failureCount, 1);
  lateReady.resolve({ ok: true, value: { ready: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timedOut.counts().readyCount, 0, "a late ready must not resurrect a timed-out lease");
  timedOut.cleanup();

  const unmountedReady = deferred();
  const unmounted = lifecycleHarness(unmountedReady.promise);
  unmounted.cleanup();
  unmountedReady.resolve({ ok: true, value: { ready: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unmounted.counts(), { readyCount: 0, failureCount: 0, revokeCount: 1 },
    "an unmounted lease must be revoked and ignore its late ready acknowledgement");

  const component = fs.readFileSync(componentPath, "utf8");
  const lifecycle = fs.readFileSync(sourcePath, "utf8");
  assert.match(lifecycle, /event\.source !== frameWindow \|\| event\.origin !== "null"/);
  assert.match(lifecycle, /event\.ports\.length !== 0/);
  assert.match(lifecycle, /Object\.keys\(message\)\.length !== 2/);
  assert.match(lifecycle, /new MessageChannel\(\)/);
  assert.match(component, /useLayoutEffect/);
  assert.match(component, /mountSessionBoardWidgetLease/);
  assert.match(lifecycle, /window\.addEventListener\("message", onWindowMessage\)[\s\S]*frame\.setAttribute\("src", lease\.frameUrl\)/,
    "the bootstrap listener must be installed before the one-shot iframe navigation starts");
  assert.doesNotMatch(component, /src=\{lease\.frameUrl\}/,
    "React commit must not start the ticket navigation before the layout effect installs listeners");
  assert.match(lifecycle, /if \(closed\) return/,
    "late ready acknowledgements must not resurrect a failed or revoked iframe");
  assert.match(lifecycle, /if \(!readyAcknowledged\) fail\(\)/,
    "the timeout must cover the trusted-main ready acknowledgement, not just the untrusted message");
  assert.match(component, /sandbox="allow-scripts"/);
  assert.match(component, /allow=""/);
  assert.match(component, /referrerPolicy="origin"/);
  assert.match(component, /revokeSessionBoardWidget\(issued\.ticketId\)/,
    "late or unmounted mint results must be revoked");
  assert.match(component, /hostGeneration/,
    "gateway generation changes must rotate the hosted document");
  assert.doesNotMatch(component, /dangerouslySetInnerHTML|allow-same-origin|widget-prompt|cron|action|data\.read/i);

  const preload = fs.readFileSync(preloadPath, "utf8");
  assert.match(preload, /mintSessionBoardHtmlWidget:[\s\S]*shoggoth:board-widget:mint/);
  assert.match(preload, /readySessionBoardHtmlWidget:[\s\S]*shoggoth:board-widget:ready/);
  assert.match(preload, /revokeSessionBoardHtmlWidget:[\s\S]*shoggoth:board-widget:revoke/);
  assert.doesNotMatch(preload, /fetchSessionBoardHtmlWidget/,
    "preload may mint a local ticket but must never receive raw HTML");

  console.log("openclaw-session-board-html-ui-unit: PASS");
} finally {
  delete global.window;
  delete global.document;
  delete global.MessageChannel;
  delete global.MutationObserver;
  fs.rmSync(outDir, { recursive: true, force: true });
}
