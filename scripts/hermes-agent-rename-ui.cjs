#!/usr/bin/env electron
"use strict";

// npm run build:manage && node_modules/.bin/electron scripts/hermes-agent-rename-ui.cjs
// On macOS, append -ApplePersistenceIgnoreState YES if a prior crash prompts to restore windows.
// Full production AgentsPage -> REST -> HermesBackend -> isolated upstream fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { createFixture } = require("./fixtures/hermes-agent-rename.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-rename-ui-"));
app.setPath("userData", path.join(root, "electron"));
app.setPath("sessionData", path.join(root, "session"));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let fixture, window, passed = false;
  const timer = setTimeout(() => { console.error("Hermes rename UI timed out"); app.exit(1); }, 45_000);
  try {
    fixture = await createFixture();
    window = new BrowserWindow({ show: false, width: 1200, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.session.webRequest.onBeforeRequest((details, done) => {
      done({ cancel: !details.url.startsWith(fixture.server.url + "/") });
    });
    const js = code => window.webContents.executeJavaScript(code, true);
    const input = "document.querySelector('[data-agent-overview-panel] input[aria-label=\"名称\"]')";
    async function until(code, label) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await js(code)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw Error(`Timed out: ${label}`);
    }
    async function rename(name) {
      await js(`(() => {
        const field = ${input};
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(name)});
        field.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until("Array.from(document.querySelectorAll('[data-agent-overview-panel] button')).some(button => button.textContent === '保存' && !button.disabled)", "enabled Save");
      await js("Array.from(document.querySelectorAll('[data-agent-overview-panel] button')).find(button => button.textContent === '保存').click()");
    }
    await window.loadURL(`${fixture.server.url}/#/agents?backend=hermes&agent=hermes-default`);
    await until(`${input}?.value === 'default'`, "default Agent detail");
    assert.equal(await js(`${input}.readOnly`), false);
    await rename("中文 Hermes 助理");
    await until(`${input}?.value === '中文 Hermes 助理' && !document.querySelector('[data-agent-overview-panel] button[class*="saveBtn"]')`, "successful save and detail reload");
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.profiles[0].display_name, "中文 Hermes 助理");
    assert.equal(fixture.backend.profileById.get("hermes-default"), "default");
    assert.match(await js("document.querySelector('[data-agent-overview-panel]').innerText"), /中文 Hermes 助理/);

    // A fresh document re-reads the saved upstream display name with the same ID.
    await window.loadURL(`${fixture.server.url}/?reload=1#/agents?backend=hermes&agent=hermes-default`);
    await until(`${input}?.value === '中文 Hermes 助理'`, "saved name survives page reload");
    await rename("default");
    await until(`${input}?.value === 'default' && !document.querySelector('[data-agent-overview-panel] button[class*="saveBtn"]')`, "reset name to default");
    assert.equal(fixture.writes.length, 2);

    fixture.state.rejectRename = true;
    await rename("Rejected name");
    await until("Array.from(document.querySelectorAll('[class*=toastTitle]')).some(node => node.textContent.includes('Profile rename rejected'))", "rename failure toast");
    assert.equal(await js(`${input}.value`), "Rejected name", "failed save retains the draft");
    assert.equal(fixture.profiles[0].display_name, "default");
    assert.equal(fixture.writes.length, 3);

    // Clear the rejected draft before navigating; the production unsaved guard
    // correctly cancels a document reload while that draft is still dirty.
    await js(`(() => {
      const field = ${input};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'default');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until("!document.querySelector('[data-agent-overview-panel] button[class*=saveBtn]')", "discard failed draft");
    fixture.state.rejectRename = false;
    await window.loadURL(`${fixture.server.url}/?reload=2#/agents?backend=hermes&agent=hermes-writer`);
    await until(`${input}?.value === 'writer'`, "named Agent detail");
    await rename("Editor");
    await until(`${input}?.value === 'editor' && !document.querySelector('[data-agent-overview-panel] button[class*="saveBtn"]')`, "named profile saved and new dashboard loaded");
    assert.deepEqual(fixture.state.startedProfiles, ["editor"]);
    assert.equal(fixture.backend.dashboards.has("writer"), false);
    await window.loadURL(`${fixture.server.url}/?reload=3#/agents?backend=hermes&agent=hermes-editor`);
    await until(`${input}?.value === 'editor'`, "renamed Agent reload");
    console.log(JSON.stringify({ verified: true, fullProductionAgentsPage: true, realRestBackend: true,
      chineseRename: true, stableDefaultId: true, reload: true, resetName: true, rejectedSavePreservesDraft: true,
      namedProfileRename: true, namedDashboardRebound: true, realHermesHost: false, userDataWrites: 0 }));
    passed = true;
  } catch (error) {
    console.error(error);
    if (window) console.error(await window.webContents.executeJavaScript("document.body.innerText.slice(0, 2500)").catch(String));
  } finally {
    clearTimeout(timer);
    window?.destroy();
    await fixture?.close();
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(passed ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });
