#!/usr/bin/env node
"use strict";

// Inspect the actual installed Electron renderer through a temporary loopback
// debugger. Only reads native APIs and navigates the existing settings screen.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

async function main() {
  const [port, output, enabled = "false"] = process.argv.slice(2);
  assert.match(port || "", /^\d{4,5}$/u);
  assert.ok(path.isAbsolute(output || ""));
  assert.ok(["true", "false"].includes(enabled));
  assert.ok(!fs.existsSync(output), "new output required");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5000),
  })).json();
  const target = targets.find(row => row.type === "page" && row.url.startsWith("http://127.0.0.1:18799/"));
  assert.ok(target, "installed renderer must be present");
  const url = new URL(target.webSocketDebuggerUrl);
  assert.equal(url.hostname, "127.0.0.1");
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let seq = 0;
  const pending = new Map();
  ws.on("message", data => {
    const result = JSON.parse(data.toString());
    const entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id); clearTimeout(entry.timer);
    if (result.error) entry.reject(new Error("Installed renderer protocol error"));
    else entry.resolve(result.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Installed renderer timeout")); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, "installed renderer evaluation failed");
    return result.result.value;
  };
  try {
    const result = await evaluate(`(async () => {
      const read = async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error('API status ' + response.status);
        return response.json();
      };
      const backends = (await read('/__api/backends')).backends;
      const capacity = await read('/__api/native-capacity');
      const agentResult = await read('/__api/agents?backend=shoggoth');
      const agents = agentResult.agents || [];
      return { evidence: 'installed-electron-renderer', origin: location.origin,
        nativeFacadeCount: backends.filter(row => row.id === 'shoggoth').length,
        legacyNativeFacadeCount: backends.filter(row => ['codex','claude-code','pi','grok-build','antigravity','deepseek-harness'].includes(row.id)).length,
        nativeAgentCount: agents.length, capacity,
        viewport: { width: innerWidth, height: innerHeight },
        documentReady: document.readyState, rootRendered: !!document.querySelector('#root')?.children.length };
    })()`);
    assert.equal(result.nativeFacadeCount, 1);
    assert.equal(result.legacyNativeFacadeCount, 0);
    assert.ok(result.nativeAgentCount > 0);
    assert.ok(result.rootRendered);
    assert.equal(result.capacity.enabled, enabled === "true");
    if (enabled === "true") { assert.equal(result.capacity.maxActive, 100); assert.equal(result.capacity.startupConcurrency, 8); }
    await evaluate(`(() => { if (location.hash !== '#/settings') {
      location.hash = '#/settings'; }
      return true; })()`);
    let settings;
    for (let i = 0; i < 50; i++) {
      settings = await evaluate(`(() => ({
        hasRuntimeCapacity: /原生.*并发|Native runtime|Native capacity/i.test(document.body.innerText),
        has100: document.body.innerText.includes('100') || [...document.querySelectorAll('input')].some(input => input.value === '100'),
        enabled: document.querySelector('#settings-native-capacity [role="switch"]')?.getAttribute('aria-checked'),
        limits: [...document.querySelectorAll('#settings-native-capacity input[type="number"]')].map(input => input.value),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      }))()`);
      if (settings.hasRuntimeCapacity && settings.limits.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    result.settings = settings;
    assert.ok(settings.hasRuntimeCapacity, "capacity UI must render in installed Settings");
    assert.equal(settings.horizontalOverflow, false);
    assert.equal(settings.enabled, enabled);
    if (enabled === "true") assert.deepEqual(settings.limits, ["100", "8"]);
    const screenshotReady = await evaluate(`(async () => {
      const control = document.querySelector('#settings-native-capacity');
      control?.scrollIntoView({ block: 'center' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return !!control?.isConnected && location.hash === '#/settings';
    })()`);
    assert.ok(screenshotReady, "Settings changed during audit; retain DOM checks and retry screenshot later");
    const screenshot = await call("Page.captureScreenshot", { format: "png" });
    const screenshotPath = output.replace(/\.json$/u, "") + ".png";
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"), { flag: "wx", mode: 0o600 });
    result.screenshotPath = screenshotPath;
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ output, nativeAgentCount: result.nativeAgentCount,
      enabled: result.capacity.enabled, maxActive: result.capacity.maxActive, rendered: true }));
  } finally { ws.close(); for (const entry of pending.values()) clearTimeout(entry.timer); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
