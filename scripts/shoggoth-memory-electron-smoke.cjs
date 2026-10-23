#!/usr/bin/env node
"use strict";

// Real Service/REST/proxy and built React renderer in an isolated Electron
// profile. Only the external model process is the existing local Codex fake.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const option = name => process.argv[process.argv.indexOf(name) + 1];
const note = "Memory core Electron fixture: violet telescope calibration.";
const prompt = "Memory core isolated chat roundtrip.";
const memorySettings = process.argv.includes("--memory-settings");
const memoryStatus = process.argv.includes("--memory-status");
async function until(read, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error(`Timed out: ${label}`);
}

async function parent() {
  const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
  const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
  const output = path.resolve(option("--output")); fs.mkdirSync(output, { recursive: true });
  // Nine pages also start bounded model/auth metadata reads (up to 20s). Let
  // those existing requests drain; do not force the real Service to exit.
  const configRoot = memorySettings || memoryStatus ? fs.mkdtempSync("/private/tmp/sg-memory-settings-") : null;
  const configStore = configRoot ? require("../app/core/config-store").createConfigStore(path.join(configRoot, "config.json")) : null;
  if (configStore) configStore.writeNativeMemoryConfig({ expectedRevision: 0, config: {
    memory: { search: { provider: "none" } }, plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } } } });
  let f;
  try {
    f = await startInspirationFixture({ ...(configStore ? { configStore } : {}),
      serviceOptions: { memoryCore: true, prewarmMcpAuth: false, closeTimeoutMs: 30000 } });
    if (process.argv.includes("--diagnostic")) {
      const factory = f.service.runtimePool.hostFactory;
      f.service.runtimePool.hostFactory = options => {
        const host = factory(options), initialize = host.initialize.bind(host);
        host.initialize = () => initialize().catch(error => { console.error("Fixture host startup", error); throw error; });
        return host;
      };
    }
    await f.service.memoryEngine.propose({ profileId: DEFAULT_AGENT_PROFILE_ID, scope: "agent", type: "semantic", classification: "explicit",
      content: note, sourceRefs: ["user-edit:electron-fixture"] });
    const profile = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    const publicSessionKey = await f.backend.createSession(profile.agentId);
    const sessionKey = f.backend.getSessionRows().find(row => row.key === publicSessionKey).sessionId;
    const sent = await f.ipc("chat.send", { sessionKey, operationId: "memory-electron-send", prompt, createdAt: Date.now() });
    const waiting = await until(async () => {
      const { run } = await f.ipc("run.get", { runId: sent.run.id });
      if (["failed", "interrupted"].includes(run.status)) {
        throw new Error(JSON.stringify(run));
      }
      return run.status === "waiting_input" && run.waitingRequestId ? run : null;
    }, "isolated runtime input");
    await f.ipc("run.input.respond", { operationId: "memory-electron-answer", createdAt: Date.now(), runId: waiting.id,
      requestId: waiting.waitingRequestId, action: "submit", answers: { choice: "Alpha" } });
    await f.service.workRunCoordinator.waitForTerminal(waiting.id);
    const history = await f.ipc("chat.history", { sessionKey, cursor: null, limit: 100 });
    assert.match(JSON.stringify(history), /Memory core isolated chat roundtrip/);
    assert.match(JSON.stringify(history), /Alpha/);
    let statusModelCalls = 0, readMemoryStatus;
    if (memoryStatus) {
      const before = configStore.read().nativeMemory;
      configStore.writeNativeMemoryConfig({ expectedRevision: before.revision, config: {
        ...before.config, memory: { search: { provider: "none", rememberAcrossConversations: false } },
        plugins: { entries: { ...before.config.plugins.entries, "active-memory": {
          enabled: true, config: { agents: [DEFAULT_AGENT_PROFILE_ID], mode: "always", model: "fixture-model" } } } } } });
      await f.backend.applyNativeMemoryConfig(configStore.read().nativeMemory);
      const owner = f.service.memoryEngine;
      require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(owner);
      owner.complete = async () => ({ text: JSON.stringify(++statusModelCalls % 2
        ? { tool: "memory_get", arguments: { path: "MEMORY.md" } } : { summary: note }) });
      const input = { profile, run: { id: "memory-status-ui", profileId: DEFAULT_AGENT_PROFILE_ID,
        source: "chat", sourceId: sessionKey, workspace: f.service.chatSessionStore.getSession(sessionKey).workspace }, query: "Recall the telescope" };
      await owner.prepareActiveMemory(input); assert.match(owner.takeActiveMemory(input)?.content || "", /violet telescope/u);
      await owner.finishActiveMemoryRun(input.run);
      owner.complete = async () => assert.fail("status UI must never generate memory");
      assert.equal(owner.activeMemory.pending.size, 0);
      assert.equal(owner.activeMemory.runtimes.size, 0);
      assert.equal(owner.activeMemory.runs.size, 0);
      assert.equal(owner.host(DEFAULT_AGENT_PROFILE_ID).database.db.prepare(
        "SELECT count(*) AS n FROM memory_state WHERE namespace='active-memory-runtime' AND value IS NOT NULL").get().n, 0,
      "completed background recall clears its private scratch state");
      const statusUrl = `${f.url}/__api/agents/${profile.agentId}/memory-status?backend=shoggoth&sessionKey=${encodeURIComponent(publicSessionKey)}`;
      readMemoryStatus = async (includeTrace = false) => {
        const response = await fetch(`${statusUrl}&trace=${includeTrace ? "1" : "0"}`);
        assert.equal(response.status, 200); return response.json();
      };
      const metadata = await readMemoryStatus();
      assert.equal(metadata.phase, "complete"); assert.equal(metadata.outcome, "ok");
      assert.deepEqual(metadata.traceLines, []);
      assert.ok(!JSON.stringify(metadata).includes(note), "ordinary status reads omit recall details");
      assert.match((await readMemoryStatus(true)).traceLines.join(" "), /violet telescope/u);
      const { METHOD } = require("../app/agent-service/active-memory-status-protocol");
      await assert.rejects(f.ipc(METHOD, { profileId: "wrong-profile", sessionKey, includeTrace: true }), { code: "MEMORY_STATUS_UNAVAILABLE" });
      await assert.rejects(f.ipc(METHOD, { profileId: DEFAULT_AGENT_PROFILE_ID,
        sessionKey: require("node:crypto").randomUUID(), includeTrace: true }), { code: "MEMORY_STATUS_UNAVAILABLE" });
    }
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    assert.match(JSON.stringify(await f.backend.getHistory(publicSessionKey)), /Memory core isolated chat roundtrip/);
    const child = spawn(require("electron"), [__filename, "--renderer", "--url", f.url, "--session", publicSessionKey,
      "--profile", path.join(f.root, "electron"), "--output", output, "--service-node", process.versions.node,
      ...(memorySettings ? ["--memory-settings", "--memory-profile", DEFAULT_AGENT_PROFILE_ID] : []),
      ...(memoryStatus ? ["--memory-status"] : [])], { env, stdio: "inherit" });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, "isolated Electron must exit naturally with success");
    if (memoryStatus) {
      assert.equal((await readMemoryStatus()).phase, "complete", "hiding the status UI preserves background recall");
      await f.ipc("memory.active.command", { sessionKey, text: "/active-memory off" });
      const cleared = await readMemoryStatus(true);
      assert.equal(cleared.phase, "disabled"); assert.deepEqual(cleared.traceLines, []);
      assert.equal(statusModelCalls, 2, "status reads and the hidden UI never generate memory");
      fs.writeFileSync(path.join(output, "memory-status-service-evidence.json"), JSON.stringify({ verified: true,
        backgroundRecall: true, modelCalls: statusModelCalls, statusPermissions: true,
        metadataOmitsTrace: true, explicitTrace: true, scratchCleared: true, commandClearsTrace: true,
        liveProvider: false, installedApp: false }, null, 2) + "\n");
    }
    if (memorySettings) {
      const saved = configStore.read().nativeMemory;
      assert.equal(saved.config.memory.search.query.maxResults, 9);
      assert.equal(saved.config.memory.search.query.minScore, 0.8);
      assert.equal(saved.config.agents.entries[DEFAULT_AGENT_PROFILE_ID].memory.search.query.maxResults, 7);
      assert.equal(saved.config.agents.defaults.models["fixture-model"].alias, "remember-global");
      assert.equal(saved.config.agents.entries[DEFAULT_AGENT_PROFILE_ID].models["fixture-model"].alias, "remember-agent");
      assert.equal(saved.config.plugins.entries["active-memory"].config.modelFallback, "fixture-model");
      assert.equal(saved.config.plugins.entries["active-memory"].config.thinking, "max");
      assert.equal(saved.config.plugins.entries["active-memory"].config.fastMode, "auto");
      assert.equal(saved.config.plugins.entries["active-memory"].config.persistTranscripts, false);
      assert.equal(saved.config.plugins.entries["active-memory"].config.transcriptDir, "recall/diagnostics");
      assert.notEqual(saved.config.plugins.entries["active-memory"].enabled, true);
      assert.deepEqual(f.service.nativeMemoryConfig.read(), saved, "UI save reaches Core and authenticated Service");
      assert.equal(saved.config.plugins.entries["memory-core"].config.dreaming.enabled, false);
    }
  } finally { try { await f?.close(); } finally { if (configRoot) fs.rmSync(configRoot, { recursive: true, force: true }); } }
  console.log("PASS isolated memory Service + model-process fixture chat + Electron renderer + natural shutdown; live provider/package/install untested");
}

async function renderer() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const output = path.resolve(option("--output"));
  app.setPath("userData", option("--profile"));
  app.setName("Shoggoth isolated memory verification");
  const deadline = setTimeout(() => { console.error("Memory Electron fixture timed out"); app.exit(1); }, memorySettings || memoryStatus ? 120000 : 70000);
  await app.whenReady();
  ipcMain.on("openclaw:get-config", event => { event.returnValue = { locale: "zh-CN", effectiveLocale: "zh-CN" }; });
  const window = new BrowserWindow({ show: false, width: 1360, height: 980, webPreferences: {
    preload: path.resolve(__dirname, "../app/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const evaluate = expression => window.webContents.executeJavaScript(expression);
  const memoryStatusRequests = [];
  if (memoryStatus) window.webContents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (new URL(details.url).pathname.endsWith("/memory-status")) memoryStatusRequests.push(details.url);
    callback({});
  });
  const errors = [];
  window.webContents.on("preload-error", (_event, _file, error) => errors.push(String(error)));
  window.webContents.on("render-process-gone", (_event, details) => errors.push(JSON.stringify(details)));
  try {
    const routes = { dashboard: "总览", inspirations: "灵感", cron: "定时任务", tasks: "工作板|Kanban", agents: "AI 助理",
      token: "Token 用量", skills: "技能", plugins: "插件", settings: "设置" };
    const evidence = [];
    for (const [route, title] of Object.entries(routes)) {
      await window.loadURL(`${option("--url")}#/${route}`);
      if ((memorySettings || memoryStatus) && route === "dashboard") {
        await until(() => evaluate("!!document.querySelector('[aria-labelledby=setup-title] button')"), "fixture first-run setup");
        await evaluate("[...document.querySelectorAll('[aria-labelledby=setup-title] button')].find(button => button.textContent.trim() === '进入控制台').click()");
        await until(() => evaluate("!document.getElementById('setup-title')"), "leave setup through its normal action");
      }
      await until(() => evaluate(`!![...document.querySelectorAll('main h1')].find(element => new RegExp(${JSON.stringify(title)}).test(element.textContent)) && !document.querySelector('.page-loading')`), `render ${route}`);
      evidence.push({ route, heading: await evaluate("[...document.querySelectorAll('main h1')].map(element => element.textContent).join(' / ')"),
        textLength: await evaluate("document.querySelector('main').innerText.trim().length") });
    }
    if (memorySettings) {
      await evaluate("document.querySelector('#settings-memory').open = true");
      const maxId = "memory-setting-memory-search-query-maxResults";
      await until(() => evaluate(`!!document.getElementById(${JSON.stringify(maxId)})`), "memory settings config");
      const edit = async (id, value) => evaluate(`(() => {
        const input = document.getElementById(${JSON.stringify(id)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const save = () => evaluate("document.querySelector('#settings-memory form').requestSubmit()");
      const saved = () => evaluate("document.querySelector('#settings-memory').innerText.includes('记忆设置已保存并由后台服务确认')");
      await edit(maxId, "9"); await save(); await until(saved, "memory config acknowledgement");
      await edit(maxId, "4");
      // A concurrent Core writer changes another field; the stale UI must keep
      // its draft, refuse to overwrite that writer, then reload explicitly.
      await evaluate(`(async () => { const url = '/__api/native-memory-config';
        const previous = await (await fetch(url)).json();
        const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRevision: previous.revision, config: { ...previous.config,
            memory: { search: { ...previous.config.memory.search, query: { ...previous.config.memory.search.query, minScore: 0.8 } } } } }) });
        if (!response.ok) throw Error('Concurrent fixture write failed');
      })()`);
      await save();
      await until(() => evaluate("document.querySelector('#settings-memory [role=alert]')?.textContent.includes('其他窗口')"), "memory CAS conflict");
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify(maxId)}).value`), "4");
      await evaluate("document.querySelector('#settings-memory').scrollIntoView()");
      fs.writeFileSync(path.join(output, "memory-settings-conflict.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate("[...document.querySelectorAll('#settings-memory button')].find(button => button.textContent.includes('放弃修改并重新载入')).click()");
      await until(() => evaluate(`!document.querySelector('#settings-memory [role=alert]') && document.getElementById(${JSON.stringify(maxId)}).value === '9'`), "memory settings reload");
      await evaluate("document.querySelector('#settings-memory button[title=\"设置范围\"]').click()");
      await until(() => evaluate("[...document.querySelectorAll('[role=option]')].some(option => option.textContent.trim() === 'Shoggoth')"), "memory scope options");
      await evaluate("[...document.querySelectorAll('[role=option]')].find(option => option.textContent.trim() === 'Shoggoth').click()");
      const agentMaxId = `memory-setting-agents-entries-${option("--memory-profile")}-memory-search-query-maxResults`;
      await until(() => evaluate(`!!document.getElementById(${JSON.stringify(agentMaxId)})`), "memory Agent scope");
      await edit(agentMaxId, "7"); await save(); await until(saved, "Agent memory override acknowledgement");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until(() => evaluate("document.querySelector('#settings-memory button[title=\"设置范围\"]').getAttribute('aria-expanded') === 'false' && ![...document.querySelectorAll('[role=option]')].some(option => option.checkVisibility())"), "memory scope menu closed");
      assert.equal(await evaluate("!!document.querySelector('[aria-modal=true]')"), false, "memory controls must be accessible without an overlay");
      const fallbackId = "memory-setting-plugins-entries-active-memory-config-modelFallback";
      await evaluate(`document.getElementById(${JSON.stringify(fallbackId)}).closest('details').open = true`);
      const choose = async (title, label) => {
        const selector = `#settings-memory button[title=${JSON.stringify(title)}]`;
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await until(() => evaluate(`[...document.querySelectorAll('[role=option]')].some(option => option.textContent.trim() === ${JSON.stringify(label)} && option.checkVisibility())`), `${title} options`);
        await evaluate(`[...document.querySelectorAll('[role=option]')].find(option => option.textContent.trim() === ${JSON.stringify(label)} && option.checkVisibility()).click()`);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await until(() => evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded') === 'false'
          && ![...document.querySelectorAll('[role=option]')].some(option => option.checkVisibility())`), `${title} selection and popup exit`);
      };
      await edit(fallbackId, "fixture-model");
      await choose("召回思考级别", "最高"); await choose("召回快速模式", "自动（前 60 秒）");
      await choose("保留召回诊断记录", "开启");
      const transcriptDirId = "memory-setting-plugins-entries-active-memory-config-transcriptDir";
      await edit(transcriptDirId, "recall/diagnostics");
      await save(); await until(saved, "memory model options acknowledgement");
      assert.equal(await evaluate("(async () => (await (await fetch('/__api/native-memory-config')).json()).config.plugins.entries['active-memory'].config.persistTranscripts)()"), true);
      await evaluate(`document.getElementById(${JSON.stringify(transcriptDirId)}).scrollIntoView({ block: 'center' })`);
      fs.writeFileSync(path.join(output, "memory-settings-transcripts.png"), (await window.webContents.capturePage()).toPNG());
      await choose("保留召回诊断记录", "关闭"); await save(); await until(saved, "diagnostic retention disabled acknowledgement");
      const aliasTargetId = "memory-setting-alias-target", aliasValueId = "memory-setting-alias-value-fixture-model";
      const addAlias = async value => {
        await edit(aliasTargetId, "fixture-model");
        assert.equal(await evaluate("document.querySelector('#settings-memory button[type=submit]').disabled"), true,
          "unadded alias target blocks saving");
        await evaluate("[...document.querySelectorAll('#settings-memory button')].find(button => button.textContent === '添加模型').click()");
        await until(() => evaluate(`!!document.getElementById(${JSON.stringify(aliasValueId)})`), "alias editor row");
        await edit(aliasValueId, value);
      };
      await addAlias("remember-global"); await save(); await until(saved, "global alias acknowledgement");
      await edit(aliasTargetId, "fixture-model");
      assert.equal(await evaluate("[...document.querySelectorAll('#settings-memory button')].find(button => button.textContent === '添加模型').disabled"), true,
        "duplicate target cannot replace an existing alias");
      await edit(aliasTargetId, "");
      await choose("模型别名范围", "Shoggoth");
      assert.equal(await evaluate(`!!document.getElementById(${JSON.stringify(aliasValueId)})`), false,
        "global aliases are not misrepresented as explicit Agent overrides");
      await addAlias("remember-agent"); await save(); await until(saved, "Agent alias acknowledgement");
      await edit(aliasValueId, ""); await save(); await until(saved, "Agent alias clear acknowledgement");
      const readAgentAliases = () => evaluate(`(async () => (await (await fetch('/__api/native-memory-config')).json()).config.agents.entries[${JSON.stringify(option("--memory-profile"))}].models)()`);
      assert.deepEqual(await readAgentAliases(), { "fixture-model": { alias: "" } });
      await evaluate("document.querySelector('.settings-memory-alias button').click()");
      await save(); await until(saved, "Agent alias inheritance acknowledgement");
      assert.equal(await readAgentAliases(), undefined, "removing an override restores global inheritance");
      await addAlias("remember-agent"); await save(); await until(saved, "final Agent alias acknowledgement");
      for (const [width, filename] of [[1360, "memory-settings-aliases.png"], [720, "memory-settings-aliases-narrow.png"]]) {
        window.setContentSize(width, 980);
        await evaluate(`document.getElementById(${JSON.stringify(aliasValueId)}).closest('fieldset').scrollIntoView({ block: 'center', behavior: 'instant' })`);
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        assert.equal(await evaluate(`(() => { const field = document.getElementById(${JSON.stringify(aliasValueId)}), rect = field.getBoundingClientRect();
          const section = field.closest('fieldset'); return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth
            && section.scrollWidth <= section.clientWidth + 1 && ![...document.querySelectorAll('[role=option]')].some(option => option.checkVisibility()); })()`), true,
          "alias editor is visible, fits the window, and has no open popup");
        fs.writeFileSync(path.join(output, filename), (await window.webContents.capturePage()).toPNG());
      }
      window.setContentSize(1360, 980);
      await evaluate(`document.getElementById(${JSON.stringify(fallbackId)}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert.equal(await evaluate(`(() => { const rect = document.getElementById(${JSON.stringify(fallbackId)}).getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight; })()`), true, "fallback field is visible before capture");
      fs.writeFileSync(path.join(output, "memory-settings-model-options.png"), (await window.webContents.capturePage()).toPNG());
      window.setContentSize(720, 980);
      await evaluate(`document.getElementById(${JSON.stringify(fallbackId)}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert.equal(await evaluate(`(() => { const rect = document.getElementById(${JSON.stringify(fallbackId)}).getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth; })()`), true, "fallback field fits the narrow window");
      fs.writeFileSync(path.join(output, "memory-settings-model-options-narrow.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.getElementById(${JSON.stringify(transcriptDirId)}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert.equal(await evaluate(`(() => { const fields = [document.getElementById(${JSON.stringify(transcriptDirId)}),
        document.querySelector('#settings-memory button[title="保留召回诊断记录"]')];
        return fields.every(field => { const rect = field.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; }); })()`), true,
        "both diagnostic controls are visible and fit the narrow window");
      fs.writeFileSync(path.join(output, "memory-settings-transcripts-narrow.png"), (await window.webContents.capturePage()).toPNG());
      window.setContentSize(1360, 980);
      await evaluate("document.querySelector('#settings-memory').scrollIntoView()");
      fs.writeFileSync(path.join(output, "memory-settings.png"), (await window.webContents.capturePage()).toPNG());
      window.setContentSize(720, 980);
      await evaluate("document.querySelector('#settings-memory').scrollIntoView()");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert.equal(await evaluate("(() => { const panel = document.querySelector('#settings-memory'); return panel.scrollWidth <= panel.clientWidth + 1; })()"), true,
        "memory settings must fit a narrow window");
      fs.writeFileSync(path.join(output, "memory-settings-narrow.png"), (await window.webContents.capturePage()).toPNG());
      window.setContentSize(1360, 980);
    }
    await window.loadURL(`${option("--url")}#/agents`);
    await until(() => evaluate("!!document.querySelector('button[data-agent-id]')"), "Agent card");
    await evaluate("document.querySelector('button[data-agent-id]').click()");
    await until(() => evaluate("[...document.querySelectorAll('button')].find(button => /^(设定|Settings|Setup)$/.test(button.textContent.trim()))?.click() || !!document.querySelector('button[title=\"MEMORY.md\"]')"), "settings tab");
    await until(() => evaluate("!!document.querySelector('button[title=\"MEMORY.md\"]')"), "memory file");
    const files = await evaluate("[...document.querySelector('button[title=\"MEMORY.md\"]').parentElement.querySelectorAll('button')].map(button => button.title)");
    assert.deepEqual(files, ["IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md", "HEARTBEAT.md", "MEMORY.md"]);
    await evaluate("document.querySelector('button[title=\"MEMORY.md\"]').click()");
    await until(() => evaluate(`document.querySelector('main')?.innerText.includes(${JSON.stringify(note)})`), "canonical memory contents");
    await until(() => evaluate("!document.querySelector('[class*=panelMorphing]')"), "Agent panel animation");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    fs.writeFileSync(path.join(output, "memory-page.png"), (await window.webContents.capturePage()).toPNG());
    await window.loadURL(`${option("--url")}#/chat?backend=shoggoth&session=${encodeURIComponent(option("--session"))}`);
    await until(() => evaluate(`document.querySelector('main')?.innerText.includes(${JSON.stringify(prompt)})`), "chat history renderer");
    if (memoryStatus) {
      const assertStatusUnmounted = async label => {
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        assert.equal(await evaluate("document.querySelector('[data-memory-status]') === null"), true, `${label}: no memory badge is mounted`);
        assert.equal(await evaluate("document.querySelector('button[aria-label=\"记忆召回状态\"]') === null"), true,
          `${label}: no memory details trigger is mounted`);
        assert.equal(await evaluate("[...document.querySelectorAll('[role=dialog]')].some(dialog => dialog.textContent.includes('记忆召回状态'))"), false,
          `${label}: no memory details dialog is mounted`);
        assert.equal(memoryStatusRequests.length, 0, `${label}: no hidden status component polls the Service`);
      };
      await assertStatusUnmounted("ordinary chat");
      fs.writeFileSync(path.join(output, "memory-status.png"), (await window.webContents.capturePage()).toPNG());
      window.setContentSize(720, 980);
      await assertStatusUnmounted("narrow ordinary chat");
      fs.writeFileSync(path.join(output, "memory-status-narrow.png"), (await window.webContents.capturePage()).toPNG());
      window.setContentSize(1360, 980);
      // This existing entry is currently hidden by product policy. Exercise its
      // retained view through the real handler without re-enabling the entry.
      await evaluate("document.querySelector('button[title=\"沉浸模式\"]').click()");
      await until(() => evaluate("document.body.hasAttribute('data-immersive')"), "retained immersive view");
      await assertStatusUnmounted("immersive chat");
      fs.writeFileSync(path.join(output, "memory-status-immersive.png"), (await window.webContents.capturePage()).toPNG());
      window.setContentSize(720, 980);
      await assertStatusUnmounted("narrow immersive chat");
      fs.writeFileSync(path.join(output, "memory-status-immersive-narrow.png"), (await window.webContents.capturePage()).toPNG());
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "electron-evidence.json"), JSON.stringify({ verified: true, electron: process.versions.electron,
      node: process.versions.node, routes: evidence, files, memoryRendered: true, chatHistoryRendered: true,
      memorySettings: memorySettings ? { saved: true, conflictPreserved: true, profileOverride: true, narrowLayout: true,
        modelAliases: { global: true, agent: true, duplicateRejected: true, clearAndRemove: true },
        diagnosticRetention: { enabledAndDisabled: true, directorySaved: true, narrowLayout: true } } : null,
      memoryStatus: memoryStatus ? { ordinaryUnmounted: true, immersiveUnmounted: true,
        narrowUnmounted: true, statusRequests: memoryStatusRequests.length, retainedImmersiveView: true } : null,
      serviceNode: option("--service-node"),
      modelProcess: "isolated Codex fake", liveProvider: false, installedApp: false }, null, 2) + "\n");
    console.log("PASS nine production pages, canonical MEMORY.md order/content, actual chat history in sandboxed Electron");
  } catch (error) {
    fs.writeFileSync(path.join(output, "renderer-failure.png"), (await window.webContents.capturePage()).toPNG());
    console.error("Renderer controls", await evaluate("[...document.querySelectorAll('[aria-expanded=true],[role=option]')].map(element => ({ role: element.getAttribute('role'), title: element.title, text: element.textContent.slice(0, 80), visible: element.checkVisibility(), expanded: element.getAttribute('aria-expanded') }))"));
    console.error("Renderer state", await evaluate("document.body.innerText")); throw error;
  } finally { window.destroy(); clearTimeout(deadline); app.quit(); }
}

(process.argv.includes("--renderer") ? renderer() : parent()).catch(error => {
  console.error(error); process.exitCode = 1;
  if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) require("electron").app.exit(1);
});
