#!/usr/bin/env electron
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const { startStaticServer } = require('../app/static-server');
const { UI_CONTENT_SECURITY_POLICY } = require('../app/ui-content-security');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shoggoth-ui-security-'));
app.setPath('userData', path.join(root, 'electron'));
app.setPath('sessionData', path.join(root, 'session'));
const timer = setTimeout(() => { console.error('UI security smoke timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  let server, window;
  try {
    ipcMain.on('openclaw:get-config', event => { event.returnValue = { locale: 'en', effectiveLocale: 'en' }; });
    server = await startStaticServer(0, { homeDir: root, userDataRoot: path.join(root, 'data') });
    const response = await fetch(server.url);
    assert.equal(response.headers.get('content-security-policy'), UI_CONTENT_SECURITY_POLICY);
    window = new BrowserWindow({ show: false, webPreferences: {
      preload: path.resolve(__dirname, '../app/preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    const preloadErrors = [];
    window.webContents.on('preload-error', (_event, _file, error) => preloadErrors.push(String(error)));
    await window.loadURL(server.url);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !await window.webContents.executeJavaScript('document.querySelector("#root")?.children.length > 0')) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = await window.webContents.executeJavaScript(`(async () => {
      const injected = document.createElement('script'); injected.textContent = 'window.__inlineExecuted = true';
      document.head.append(injected);
      let evalBlocked = false; try { window.eval('window.__evalExecuted=true'); } catch { evalBlocked = true; }
      return { mounted: document.querySelector('#root')?.children.length > 0,
        bridge: typeof window.openclawDesktop, node: typeof window.require,
        inlineBlocked: !window.__inlineExecuted, evalBlocked, theme: document.documentElement.dataset.theme || null };
    })()`);
    assert.deepEqual(preloadErrors, []);
    assert.equal(result.mounted, true);
    assert.equal(result.bridge, 'object');
    assert.equal(result.node, 'undefined');
    assert.equal(result.inlineBlocked, true);
    assert.equal(result.evalBlocked, true);
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
    console.log('PASS production React UI, sandboxed preload, context isolation, CSP inline/eval blocking', JSON.stringify(result));
  } finally {
    window?.destroy();
    await server?.close();
    clearTimeout(timer);
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(root, { recursive: true, force: true }));
