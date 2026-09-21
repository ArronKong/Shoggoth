#!/usr/bin/env node
// --serve exposes the same production-component fixture for frame-by-frame UI review.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const uiRoot = path.join(root, 'app/manage-ui');
const require = createRequire(path.join(root, 'package.json'));
const { build } = createRequire(path.join(uiRoot, 'package.json'))('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoggoth-printer-motion-'));
let server;
const close = () => { server?.close(); server?.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); };
try {
  await build({ entryPoints: [path.join(root, 'scripts/fixtures/desktop-printer-motion.tsx')], bundle: true, format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    outfile: path.join(temp, 'fixture.js'), external: ['/fonts/*'], nodePaths: [path.join(uiRoot, 'node_modules')], logLevel: 'silent' });
  fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>灵感打印机动效预览</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}html[data-desktop-inspiration] body{background:#c1c8cb!important}button{font-family:inherit}</style><div id="root"></div><script type="module" src="fixture.js"></script></html>');
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    const mapped = ({ '/': 'index.html', '/fixture.js': 'fixture.js', '/fixture.css': 'fixture.css' })[pathname];
    const fonts = path.join(uiRoot, 'public/fonts');
    const font = pathname.startsWith('/fonts/') ? path.resolve(fonts, pathname.slice(7)) : null;
    const file = mapped ? path.join(temp, mapped) : font?.startsWith(fonts + path.sep) ? font : null;
    if (!file || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (process.argv.includes('--serve')) {
    console.log(JSON.stringify({ url }));
    process.on('SIGTERM', () => { close(); process.exit(); });
    process.on('SIGINT', () => { close(); process.exit(); });
  } else {
    const probe = path.join(temp, 'electron.cjs');
    fs.writeFileSync(probe, process.argv.includes('--native') ? `
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { createDesktopInspirationController, CHANNELS } = require(${JSON.stringify(path.join(root, 'app/desktop-inspiration-controller.js'))});
app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const main = new BrowserWindow({ show: false });
  let controller;
  const prepared = [], concealed = [], events = [], shortcuts = new Map();
  ipcMain.handle('shoggoth:microphone:status', () => 'granted');
  const wait = async (label, predicate) => {
    const deadline = Date.now() + 7000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw Error('Native printer timeout: ' + label + ' ' + JSON.stringify({ prepared, events }));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    controller = createDesktopInspirationController({ BrowserWindow, Tray, Menu, nativeImage, screen,
      ipcMain: {
        handle: (channel, callback) => ipcMain.handle(channel, async (event, ...args) => {
          events.push([channel, ...args]);
          if (channel === CHANNELS.reveal) prepared.push(await event.sender.executeJavaScript('({bottom:document.querySelector("[data-typewriter-housing]").getBoundingClientRect().bottom, states:document.getAnimations().filter(a=>a.id.startsWith("desktop-printer-")).map(a=>a.playState)})'));
          if (channel === CHANNELS.conceal) concealed.push(await event.sender.executeJavaScript('({bottom:document.querySelector("[data-typewriter-housing]").getBoundingClientRect().bottom, paperBottom:document.querySelector("[data-paper]").getBoundingClientRect().bottom})'));
          return callback(event, ...args);
        }),
        on: ipcMain.on.bind(ipcMain), removeHandler: ipcMain.removeHandler.bind(ipcMain), removeListener: ipcMain.removeListener.bind(ipcMain),
      },
      globalShortcut: { register: (key, fn) => { shortcuts.set(key, fn); return true; }, isRegistered: key => shortcuts.has(key), unregister: key => shortcuts.delete(key) },
      configStore: { read: () => ({ inspirationShortcut: 'Alt+S' }) }, getMainWindow: () => main,
      showMainWindow: () => main.show(), getUiOrigin: () => ${JSON.stringify(url.slice(0, -1))}, getLocale: () => 'zh-CN', stopBackend: async () => {}, quit: () => app.quit(),
    });
    shortcuts.get('Alt+S')();
    const panel = controller.getWindow();
    for (const event of ['show', 'hide', 'focus', 'blur']) panel.on(event, () => events.push([event, panel.isVisible(), panel.isFocused()]));
    assert.equal(panel.isVisible(), false);
    await wait('cold reveal', () => panel.isVisible());
    assert.equal(main.isVisible(), false, 'shortcut never activates the main app');
    assert.ok(prepared[0].bottom < 0, 'real preload acknowledges the off-screen first frame');
    assert.deepEqual(prepared[0].states, ['paused', 'paused']);
    await wait('animation completion', () => panel.webContents.executeJavaScript('document.getAnimations().every(a=>!a.id.startsWith("desktop-printer-"))'));
    controller.toggle();
    assert.equal(panel.isVisible(), true, 'the native window stays visible throughout the exit');
    await wait('animated conceal', () => !panel.isVisible());
    assert.equal(concealed.length, 1, 'the renderer completes exit before the fallback timeout');
    assert.ok(concealed[0].bottom < 0 && concealed[0].paperBottom < 0, 'hold the off-screen final frame until native conceal');
    controller.toggle();
    assert.equal(panel.isVisible(), false, 'warm reveal also waits for its own prepared frame');
    await wait('warm reveal', () => panel.isVisible() && prepared.length >= 2);
    assert.ok(prepared[1].bottom < 0);
    await wait('warm animation completion', () => panel.webContents.executeJavaScript('document.getAnimations().every(a=>!a.id.startsWith("desktop-printer-"))'));
    controller.toggle();
    await wait('exit starts', () => panel.webContents.executeJavaScript('document.getAnimations().some(a=>a.id==="desktop-printer-exit" && a.currentTime >= 30)'));
    controller.toggle();
    await wait('interrupted exit reopens', () => prepared.length >= 3);
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(panel.isVisible(), true, 'old exit completion and fallback cannot conceal a reopened printer');
    assert.equal(concealed.length, 1);
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait('Escape exit', () => !panel.isVisible());
    assert.equal(concealed.length, 2, 'Escape uses the same completed exit');
    controller.toggle(); controller.toggle();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(panel.isVisible(), false, 'canceling a pending reveal rejects late IPC acknowledgements');
    assert.equal(main.isVisible(), false);
    console.log('PASS native desktop printer: actual preload/IPC, cold/warm entry, animated conceal, interruption, Escape, shortcut cancellation and hidden main app');
  } finally { controller?.dispose(); main.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
` : `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { backgroundThrottling: false } });
  const execute = source => window.webContents.executeJavaScript(source);
  const wait = condition => execute('new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const poll=()=>{if('+condition+')return resolve();if(Date.now()>deadline)return reject(Error("Printer fixture timeout"));setTimeout(poll,10)};poll()})');
  try {
    await window.loadURL(${JSON.stringify(url)});
    await wait('window.__desktopPrinterFixture?.acknowledged.length > 0');
    const initial = await execute('__desktopPrinterFixture.acknowledged[0]');
    assert.ok(initial.machine.bottom <= 0, 'the native acknowledgement sees a fully off-screen machine');
    assert.ok(initial.paper.bottom < initial.outlet.top, 'the initial paper is retracted behind the outlet');
    assert.equal(initial.animations.length, 2);
    assert.ok(initial.animations.every(a => a.state === 'paused'), 'prepare both layers before revealing the native window');
    const reset = async () => {
      await execute('__desktopPrinterFixture.hide()'); await wait('!__desktopPrinterFixture.inspect().active');
      await execute('__desktopPrinterFixture.show()'); await wait('__desktopPrinterFixture.inspect().animations.length === 2');
    };
    await execute('__desktopPrinterFixture.setManual(true)');
    await reset();
    const start = await execute('__desktopPrinterFixture.at(0)');
    const machine = await execute('__desktopPrinterFixture.at(100)');
    const feed = await execute('__desktopPrinterFixture.at(220)');
    const end = await execute('__desktopPrinterFixture.at(540)');
    assert.ok(machine.machine.bottom > start.machine.bottom && machine.machine.bottom < end.machine.bottom, 'machine continuously slides down');
    assert.ok(machine.paper.bottom < machine.outlet.top, 'paper remains inside while the machine enters');
    assert.ok(feed.paper.bottom > feed.outlet.top && feed.paper.bottom < end.paper.bottom, 'paper emerges from the clipped outlet');
    assert.ok(Math.abs(end.paper.top - end.outlet.top) < 1, 'paper lands at the unchanged default position');
    assert.equal(end.focused, 'TEXTAREA', 'typing is available without waiting for the animation');
    assert.equal(end.draft, '记下一闪而过的想法。');
    const frames = [start, machine, feed, end].map((value, i) => ({ ms: [0,100,220,540][i], machineBottom: value.machine.bottom, paperBottom: value.paper.bottom, outletTop: value.outlet.top }));
    console.log('FRAMES ' + JSON.stringify(frames));
    const waitExit = () => wait('__desktopPrinterFixture.inspect().animations.some(a=>a.id==="desktop-printer-exit")');
    const sameFrame = (a, b, message) => {
      assert.ok(Math.abs(a.machine.bottom - b.machine.bottom) < 0.5 && Math.abs(a.paper.bottom - b.paper.bottom) < 0.5, message);
    };
    await execute('__desktopPrinterFixture.dismiss()'); await waitExit();
    const exitStart = await execute('__desktopPrinterFixture.at(0)');
    sameFrame(exitStart, end, 'exit begins at the resting geometry without snapping');
    assert.equal(exitStart.visible, true, 'keep the surface visible until the renderer completes exit');
    assert.equal(await execute('document.querySelector("[data-desktop-printer]").inert'), true, 'closing controls cannot capture input');
    const retract = await execute('__desktopPrinterFixture.at(60)');
    assert.equal(retract.machine.bottom, end.machine.bottom, 'paper retracts before the machine leaves');
    assert.ok(retract.paper.bottom > retract.outlet.top && retract.paper.bottom < end.paper.bottom, 'paper slides back through the outlet');
    const exitMiddle = await execute('__desktopPrinterFixture.at(200)');
    assert.ok(exitMiddle.machine.bottom < end.machine.bottom && exitMiddle.machine.bottom > -48, 'machine then slides upward continuously');
    assert.ok(exitMiddle.paper.bottom < exitMiddle.outlet.top, 'paper is inside before the machine leaves');
    const exitEnd = await execute('__desktopPrinterFixture.at(300)');
    assert.ok(exitEnd.machine.bottom < 0 && exitEnd.paper.bottom < 0, 'both layers clear the screen before native hide');
    await execute('document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
    assert.equal(await execute('__desktopPrinterFixture.inspect().saved'), 0, 'Enter cannot submit a note while closing');
    console.log('EXIT_FRAMES ' + JSON.stringify([exitStart, retract, exitMiddle, exitEnd].map((value, i) => ({ ms: [0,60,200,300][i], machineBottom: value.machine.bottom, paperBottom: value.paper.bottom, outletTop: value.outlet.top }))));
    await execute('__desktopPrinterFixture.finish()'); await wait('!__desktopPrinterFixture.inspect().active');
    assert.equal(await execute('__desktopPrinterFixture.inspect().draft'), end.draft, 'exit preserves the unsaved draft');
    assert.equal(await execute('__desktopPrinterFixture.inspect().visible'), false);
    await reset();
    const interruptedEntry = await execute('__desktopPrinterFixture.at(220)');
    await execute('__desktopPrinterFixture.dismiss()'); await waitExit();
    sameFrame(await execute('__desktopPrinterFixture.at(0)'), interruptedEntry, 'dismissing mid-entry continues from its current frame');
    const interruptedExit = await execute('__desktopPrinterFixture.at(200)');
    await execute('__desktopPrinterFixture.show()');
    await wait('__desktopPrinterFixture.inspect().animations.some(a=>a.id==="desktop-printer-enter")');
    sameFrame(await execute('__desktopPrinterFixture.at(0)'), interruptedExit, 'reopening mid-exit continues from its current frame');
    await execute('__desktopPrinterFixture.finish()'); await wait('__desktopPrinterFixture.inspect().animations.length === 0');
    assert.equal(await execute('document.querySelector("[data-desktop-printer]").inert'), false);
    assert.equal(await execute('__desktopPrinterFixture.inspect().focused'), 'TEXTAREA');
    await execute('__desktopPrinterFixture.dismiss()'); await waitExit();
    await execute('__desktopPrinterFixture.setReduced(true)'); await wait('!__desktopPrinterFixture.inspect().active');
    assert.equal(await execute('__desktopPrinterFixture.inspect().visible'), false, 'enabling reduced motion during exit immediately completes conceal');
    await execute('__desktopPrinterFixture.setReduced(false)');
    await reset(); await execute('__desktopPrinterFixture.at(220); __desktopPrinterFixture.hide()');
    await wait('!__desktopPrinterFixture.inspect().active');
    let state = await execute('__desktopPrinterFixture.inspect()');
    assert.equal(state.workbench.visibility, 'hidden'); assert.equal(state.animations.length, 0);
    for (let i = 0; i < 5; i++) { await reset(); await execute('__desktopPrinterFixture.at(100)'); }
    assert.equal((await execute('__desktopPrinterFixture.inspect()')).draft, end.draft, 'repeated calls preserve the same draft');
    await execute('__desktopPrinterFixture.setReduced(true)');
    await wait('__desktopPrinterFixture.inspect().animations.length === 0');
    state = await execute('__desktopPrinterFixture.inspect()');
    assert.ok(Math.abs(state.paper.top - state.outlet.top) < 1, 'enabling reduced motion during entry settles immediately');
    await execute('__desktopPrinterFixture.dismiss()'); await wait('!__desktopPrinterFixture.inspect().active');
    await execute('__desktopPrinterFixture.show()'); await wait('__desktopPrinterFixture.inspect().active');
    assert.equal((await execute('__desktopPrinterFixture.inspect()')).animations.length, 0);
    await execute('__desktopPrinterFixture.setReduced(false)'); await reset();
    const before = await execute('__desktopPrinterFixture.inspect().acknowledged');
    await execute('__desktopPrinterFixture.reposition()');
    assert.equal(await execute('__desktopPrinterFixture.inspect().acknowledged'), before, 'display geometry updates do not replay the animation');
    window.setContentSize(600, 700);
    await wait('__desktopPrinterFixture.inspect().animations.length === 0 && __desktopPrinterFixture.inspect().machine.width < 500');
    state = await execute('__desktopPrinterFixture.inspect()');
    assert.ok(Math.abs(state.paper.top - state.outlet.top) < 1, 'resizing settles into the scaled resting layout');
    await reset(); await execute('__desktopPrinterFixture.at(220)');
    await execute('document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
    await wait('__desktopPrinterFixture.inspect().saved === 1 && __desktopPrinterFixture.inspect().draft === ""');
    state = await execute('__desktopPrinterFixture.inspect()');
    assert.equal(state.animations.length, 0, 'saving mid-entry clears entrance transforms before the print animation');
    assert.deepEqual(state.errors, []);
    console.log('PASS desktop printer motion: staged entry/exit, default geometry, input safety, interruption continuity, draft, reduced motion, resize and save');
  } finally { window.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [probe], { env, stdio: 'inherit' });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
    const [code, signal] = await new Promise(resolve => child.once('exit', (...result) => resolve(result)));
    clearTimeout(timeout);
    assert.equal(code, 0, `Printer renderer regression failed: ${signal || code}`);
    close();
  }
} catch (error) { close(); throw error; }
