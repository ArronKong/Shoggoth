"use strict";
// Actual installed renderer. Reads state, opens controls, never switches a user's
// runtime, adds a binding, sends a message, or changes a connection.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { MAX_PAGE_LIMIT } = require("../app/agent-service/chat-service-protocol");

async function existingNativeSession() {
  // Selecting a local test target must not depend on an unauthenticated socket
  // to an external Gateway. Use the normal authenticated, read-only Service API.
  const paths = resolveCanonicalServicePaths();
  const token = readClientToken(paths);
  const call = (method, params) => requestService(paths, { token, version: SERVICE_PROTOCOL_VERSION, method, params });
  const { profiles } = await call("profile.list", { backendId: "shoggoth", enabledOnly: true, cursor: null, limit: MAX_PAGE_LIMIT });
  for (const profile of profiles) {
    const { sessions } = await call("chat.session.list", { profileId: profile.id, includeArchived: false, cursor: null, limit: MAX_PAGE_LIMIT });
    const session = sessions.find(row => row.runtimeBindingId);
    if (session) return `agent:${profile.agentId}:${session.sessionKey}`;
  }
  throw Error("no existing native session");
}
async function main() {
  const [port, output] = process.argv.slice(2);
  assert.match(port || "", /^\d{4,5}$/u);
  assert.ok(path.isAbsolute(output || "") && !fs.existsSync(output));
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(row => row.type === "page" && row.url.startsWith("http://127.0.0.1:18799/"));
  assert.ok(target);
  assert.equal(new URL(target.webSocketDebuggerUrl).hostname, "127.0.0.1");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let seq = 0;
  const pending = new Map();
  ws.on("message", data => {
    const result = JSON.parse(data.toString()), entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id); clearTimeout(entry.timer);
    if (result.error) entry.reject(Error("Installed renderer protocol error")); else entry.resolve(result.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error("Installed renderer timeout")); }, 40_000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, "renderer evaluation failed"); return result.result.value;
  };
  const screenshot = async name => {
    const result = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(output.replace(/\.json$/u, `-${name}.png`), Buffer.from(result.data, "base64"), { flag: "wx", mode: 0o600 });
  };
  const wait = async expression => {
    for (let i = 0; i < 120; i++) {
      const value = await evaluate(expression); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error("Installed UI did not reach expected state");
  };
  let original;
  try {
    original = await evaluate(`({ hash:location.hash, lastActive:localStorage.getItem('shoggoth.chat.lastActive.v1') })`);
    const status = await evaluate(`(async()=>{
      const runtimes = (await (await fetch('/__api/runtime-status')).json()).runtimes;
      const backends = (await (await fetch('/__api/backends')).json()).backends;
      const service = await (await fetch('/__api/shoggoth/status')).json();
      return {runtimes, backends:backends.map(b=>b.id),version:service.service.serviceVersion};
    })()`);
    assert.equal(status.version, "0.8.132"); assert.equal(status.runtimes.length, 6);
    assert.ok(status.backends.includes("shoggoth") && !status.backends.includes("codex"));
    await evaluate(`location.hash='#/settings'`);
    await wait(`document.querySelectorAll('#settings-local-runtimes [data-runtime]').length===6`);
    const settings = await evaluate(`(()=>{
      const list=document.querySelector('#settings-local-runtimes'); list.scrollIntoView({block:'start'});
      return {rows:[...list.querySelectorAll('[data-runtime]')].map(row=>({runtime:row.dataset.runtime,
        status:row.querySelector('.settings-health').innerText,action:row.querySelector('button')?.innerText||null})),
        overflow:document.documentElement.scrollWidth>innerWidth+1};
    })()`);
    assert.equal(settings.overflow, false);
    assert.equal(settings.rows.find(row => row.runtime === "pi").status, "已断开");
    assert.equal(settings.rows.find(row => row.runtime === "claude-code").status, "此版本暂未开放");
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await screenshot("settings");
    const key = await existingNativeSession();
    assert.ok(typeof key === "string");
    await evaluate(`location.hash=${JSON.stringify(`#/chat?backend=shoggoth&session=${encodeURIComponent(key)}`)}`);
    // Chat stays mounted; restoring a saved preference after an earlier audit
    // need not re-run its persistence effect when the same session is selected.
    // The rendered entry and dialog are the acceptance targets, not that cache.
    await wait(`(()=>{const b=document.querySelector('button[aria-label="切换 Runtime"]');return b?.getBoundingClientRect().height>=28
      && location.hash===${JSON.stringify(`#/chat?backend=shoggoth&session=${encodeURIComponent(key)}`)};})()`);
    const chat = await evaluate(`(()=>{
      const button=document.querySelector('button[aria-label="切换 Runtime"]');
      const rect=button.getBoundingClientRect();
      const visible=rect.width>0 && rect.height>=28 && rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight;
      const clickable=button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));
      const spans=[...button.children].filter(el=>el.getBoundingClientRect().width>0).map(el=>el.getBoundingClientRect());
      const gaps=spans.slice(1).map((rect,i)=>rect.left-spans[i].right);
      button.click(); return {visible,clickable,gaps,immersive:!!document.querySelector('[data-testid="immersive-chat"]')};
    })()`);
    assert.ok(chat.visible && chat.clickable, "real header button must be visible and clickable");
    assert.ok(chat.gaps.length>0 && chat.gaps.every(gap=>gap>=5), "header label and runtime have visible spacing");
    await wait(`!!document.querySelector('[role="dialog"] button[aria-pressed]')`);
    const dialog = await evaluate(`(()=>{
      const modal=document.querySelector('[role="dialog"]'); const rect=modal.getBoundingClientRect();
      return {candidateCount:modal.querySelectorAll('button[aria-pressed]').length,
        manageEntry:[...modal.querySelectorAll('button')].some(button=>button.textContent==='添加或管理运行环境'),
        onTop:modal.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))};
    })()`);
    assert.ok(dialog.candidateCount >= 1 && dialog.manageEntry && dialog.onTop);
    await evaluate(`new Promise(resolve=>setTimeout(resolve,350))`);
    await screenshot("chat-runtime");
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent==='添加或管理运行环境').click()`);
    await wait(`!!document.querySelector('[role="dialog"] [role="combobox"]')`);
    const manager = await evaluate(`({ accountsVisible:!!document.querySelector('[role="dialog"] [role="combobox"]'),
      addEntry:[...document.querySelectorAll('[role="dialog"] button')].some(button=>button.textContent==='添加绑定') })`);
    assert.ok(manager.accountsVisible && manager.addEntry);
    await evaluate(`document.querySelector('[role="dialog"] button[aria-label="关闭"]').click()`);
    fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), evidence: "installed-full-renderer", status, settings, chat, dialog, manager,
      businessMutations: 0, passed: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ output, version: status.version, runtimeRows: settings.rows.length, chat, dialog, manager, businessMutations: 0 }));
  } finally {
    if (original) await evaluate(`(()=>{
      document.querySelector('[role="dialog"] button[aria-label="关闭"]')?.click();
      location.hash=${JSON.stringify(original.hash)};
      ${original.lastActive ? `localStorage.setItem('shoggoth.chat.lastActive.v1',${JSON.stringify(original.lastActive)});` : "localStorage.removeItem('shoggoth.chat.lastActive.v1');"}
    })()`).catch(() => {});
    ws.close(); for (const entry of pending.values()) clearTimeout(entry.timer);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
