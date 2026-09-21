'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDesktopInspirationController, CHANNELS } = require('../app/desktop-inspiration-controller');
const { normalizeInspirationShortcut } = require('../app/desktop-inspiration-shortcut');
const { normalizeConfig } = require('../app/core/config-store');

class Window extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.visible = false; this.destroyed = false; this.focused = false;
    this.bounds = { x: 0, y: 0, width: 1920, height: 1080 }; this.messages = [];
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => this.destroyed, getURL: () => this.url || 'http://127.0.0.1:18799/',
      send: (...args) => this.messages.push(args), setWindowOpenHandler: fn => { this.openHandler = fn; } });
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  getBounds() { return this.bounds; }
  setBounds(value) { this.bounds = value; }
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
  setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
  show() { this.visible = true; }
  showInactive() { this.visible = true; this.presentedInactive = true; }
  hide() { this.visible = false; this.focused = false; }
  focus() { this.focused = true; }
  loadURL(value) { this.url = value; return Promise.resolve(); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
class StatusItem extends EventEmitter {
  constructor(image) { super(); this.image = image; }
  getBounds() { return { x: 1760, y: 0, width: 24, height: 24 }; }
  setToolTip(value) { this.tooltip = value; }
  popUpContextMenu(value) { this.menu = value; }
  destroy() { this.destroyed = true; }
}
const ipcMain = new EventEmitter(), handlers = new Map();
ipcMain.handle = (key, fn) => handlers.set(key, fn); ipcMain.removeHandler = key => handlers.delete(key);
const shortcuts = new Map(), occupied = new Set();
const globalShortcut = { isRegistered: key => shortcuts.has(key), unregister: key => shortcuts.delete(key),
  register: (key, fn) => { if (occupied.has(key)) return false; shortcuts.set(key, fn); return true; } };
const screen = new EventEmitter();
let currentDisplay = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 30, width: 1920, height: 1050 } };
screen.getDisplayMatching = screen.getDisplayNearestPoint = () => currentDisplay;
screen.getCursorScreenPoint = () => ({ x: 700, y: 300 });
const main = new Window(); main.minimized = true;
let config = normalizeConfig({}), failWrite = false, shown = 0, quits = 0, backendStops = 0, finishStop, tray, locale = 'zh-CN';
const controller = createDesktopInspirationController({ BrowserWindow: Window,
  Tray: class extends StatusItem { constructor(image) { super(image); tray = this; } }, Menu: { buildFromTemplate: x => x },
  nativeImage: { createFromPath: file => ({ file, width: 14, height: 14 }) }, globalShortcut, screen, ipcMain,
  configStore: { read: () => config, write: patch => { if (failWrite) throw new Error('disk full'); config = normalizeConfig({ ...config, ...patch }); } },
  getMainWindow: () => main, showMainWindow: () => { shown++; main.minimized = false; main.show(); },
  getUiOrigin: () => 'http://127.0.0.1:18799', getLocale: () => locale, quit() { quits++; },
  stopBackend: () => { backendStops++; return new Promise(resolve => { finishStop = resolve; }); } });
const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
const call = (name, window, input) => handlers.get(CHANNELS[name])(event(window), input);
const reveal = panel => call('reveal', panel, panel.messages.findLast(([channel]) => channel === 'shoggoth:desktop-inspiration:show')[1].presentationId);
const conceal = panel => call('conceal', panel, panel.messages.findLast(([channel]) => channel === 'shoggoth:desktop-inspiration:hide')[1]);
(async () => { try {
  assert.equal(config.inspirationShortcut, 'Alt+S');
  assert.equal(normalizeInspirationShortcut('Option+s'), 'Alt+S');
  assert.equal(normalizeInspirationShortcut('cmd+shift+K'), 'Shift+Command+K');
  for (const value of ['S', 'Shift+S', 'Alt+Alt+S', 'Alt+/', 'Alt+F25', {}, 'Alt+S+K']) assert.equal(normalizeInspirationShortcut(value), null);
  assert.equal(tray.image.width, 14);
  assert.ok(tray.image.file.endsWith('/assets/tray/shoggoth.png'));
  tray.emit('click');
  assert.equal(controller.getWindow(), null, 'a tray click must not create the inspiration printer');
  assert.equal(main.visible, true); assert.equal(main.minimized, false); assert.equal(shown, 1);
  shown = 0; main.minimized = true; main.hide();
  shortcuts.get('Alt+S')();
  const panel = controller.getWindow();
  assert.equal(panel.options.transparent, true); assert.equal(panel.options.webPreferences.sandbox, true);
  if (process.platform === 'darwin') assert.equal(panel.options.enableLargerThanScreen, true, 'the native frameless panel can reach behind the menu bar');
  assert.equal(call('ready', panel).top, 0, 'the cropped housing attaches to the display edge without a menu-bar gap');
  assert.equal(panel.visible, false, 'wait for the renderer to prepare the first animation frame');
  assert.equal(call('reveal', panel, -1), false, 'stale presentation acknowledgements cannot expose old content');
  assert.equal(reveal(panel), true);
  assert.equal(panel.presentedInactive, true, 'presenting the panel must not activate the main window');
  assert.equal(panel.visible, true); assert.equal(main.minimized, true); assert.equal(shown, 0, 'opening desktop capture must not restore the main app');
  assert.deepEqual(call('tray-target', panel), { x: 1772, y: 12 });
  const primaryDisplay = currentDisplay;
  for (const menuBarHeight of [0, 24, 38]) {
    currentDisplay = { bounds: { x: -1920, y: -1080, width: 1920, height: 1080 },
      workArea: { x: -1920, y: -1080 + menuBarHeight, width: 1920, height: 1080 - menuBarHeight } };
    screen.emit('display-metrics-changed');
    const [channel, geometry] = panel.messages.at(-1);
    assert.equal(channel, 'shoggoth:desktop-inspiration:geometry', 'display changes reposition without replaying the entrance');
    assert.equal(geometry.top, 0, 'secondary displays and menu-bar visibility keep the printer flush to the top');
    assert.equal(geometry.center, 960);
  }
  panel.setBounds({ ...currentDisplay.bounds, y: currentDisplay.bounds.y + 24 });
  assert.equal(call('ready', panel).top, 0, 'showing again restores the panel to the display bounds');
  reveal(panel);
  currentDisplay = primaryDisplay;
  screen.emit('display-metrics-changed');
  assert.equal(panel.openHandler({ url: 'https://example.com' }).action, 'deny');
  const subframe = { sender: panel.webContents, senderFrame: {} };
  assert.throws(() => handlers.get(CHANNELS.ready)(subframe), /Untrusted/);
  assert.throws(() => handlers.get(CHANNELS.reveal)(subframe, 1), /Untrusted/);
  assert.throws(() => handlers.get(CHANNELS.conceal)(subframe, 1), /Untrusted/);
  ipcMain.emit(CHANNELS.interaction, subframe, true); assert.equal(panel.ignoreMouse, true);
  ipcMain.emit(CHANNELS.interaction, event(panel), true); assert.equal(panel.ignoreMouse, false);
  ipcMain.emit(CHANNELS.busy, event(panel), true);
  controller.toggle(); call('dismiss', panel); assert.equal(panel.visible, true, 'do not discard an active recording or save');
  ipcMain.emit(CHANNELS.busy, event(panel), false);
  call('dismiss', panel); assert.equal(panel.visible, true, 'keep the panel visible until paper and machine have left');
  const exitId = panel.messages.at(-1)[1];
  const beforeBlur = panel.messages.length;
  panel.focused = false; panel.emit('blur');
  assert.equal(panel.messages.length, beforeBlur, 'repeated blur does not restart the exit');
  ipcMain.emit(CHANNELS.interaction, event(panel), true);
  assert.equal(panel.ignoreMouse, true, 'a closing printer cannot capture new pointer events');
  assert.equal(call('conceal', panel, exitId - 1), false);
  controller.toggle(); reveal(panel);
  assert.equal(call('conceal', panel, exitId), false, 'a late exit acknowledgement cannot hide a reopened printer');
  assert.equal(panel.visible, true);
  call('dismiss', panel); assert.equal(conceal(panel), true); assert.equal(panel.visible, false);
  controller.toggle(); assert.equal(panel.visible, false);
  const interrupted = panel.messages.at(-1)[1].presentationId;
  controller.toggle();
  assert.equal(call('reveal', panel, interrupted), false, 'a second shortcut cancels an in-flight reveal');
  assert.equal(panel.visible, false);
  controller.toggle();
  panel.emit('blur');
  assert.equal(reveal(panel), true, 'a delayed blur from hide must not cancel the next reveal');
  assert.equal(panel.visible, true);
  panel.emit('blur'); assert.equal(panel.visible, true, 'a stale blur must not hide an already focused panel');
  panel.focused = false; panel.emit('blur');
  assert.equal(panel.messages.at(-1)[0], 'shoggoth:desktop-inspiration:hide', 'losing focus starts the exit');
  conceal(panel); assert.equal(panel.visible, false);
  controller.toggle(); reveal(panel);
  assert.equal(shown, 0); assert.equal(main.minimized, true, 'desktop capture keeps the main app minimized');
  call('capture-shortcut', main, true); assert.equal(shortcuts.has('Alt+S'), false);
  occupied.add('Command+K');
  assert.equal(call('set-shortcut', main, 'Command+K').error, 'unavailable');
  assert.equal(config.inspirationShortcut, 'Alt+S'); assert.equal(shortcuts.has('Alt+S'), true);
  call('capture-shortcut', main, true);
  assert.equal(call('set-shortcut', main, 'Cmd+Shift+K').ok, true);
  assert.equal(config.inspirationShortcut, 'Shift+Command+K'); assert.equal(shortcuts.has('Alt+S'), false);
  failWrite = true;
  assert.equal(call('set-shortcut', main, 'Alt+P').error, 'saveFailed');
  assert.equal(shortcuts.has('Alt+P'), false); assert.equal(shortcuts.has('Shift+Command+K'), true);
  failWrite = false;
  call('capture-shortcut', main, true); main.emit('blur');
  assert.equal(shortcuts.has('Shift+Command+K'), true, 'leaving the recorder restores the shortcut');
  call('dismiss', panel); conceal(panel);
  tray.emit('click'); assert.equal(panel.visible, false, 'the menu bar icon opens the main app');
  assert.equal(main.visible, true); assert.equal(main.minimized, false); assert.equal(shown, 1);
  tray.emit('click'); assert.equal(panel.visible, false, 'repeated clicks keep the main app visible');
  assert.equal(shown, 2);
  tray.emit('right-click');
  assert.deepEqual(tray.menu.filter(item => item.label).map(item => item.label), ['记录灵感', '打开 Shoggoth', '退出后端', '退出 Shoggoth']);
  tray.menu[0].click(); reveal(panel); assert.equal(panel.visible, true);
  tray.emit('click'); conceal(panel); assert.equal(panel.visible, false, 'opening the app dismisses an idle printer');
  tray.menu[1].click(); assert.equal(shown, 4); assert.equal(main.minimized, false);
  const stopping = tray.menu[3].click();
  assert.equal(backendStops, 1); assert.equal(quits, 0, 'stopping the backend does not quit the app');
  tray.emit('right-click'); assert.equal(tray.menu[3].enabled, false); assert.equal(tray.menu[3].label, '正在退出后端…');
  await tray.menu[3].click(); assert.equal(backendStops, 1, 'duplicate clicks cannot start a second stop');
  finishStop(); await stopping;
  locale = 'en'; tray.emit('right-click');
  assert.equal(tray.menu[3].enabled, true); assert.equal(tray.menu[3].label, 'Stop backend');
  tray.menu[4].click(); assert.equal(quits, 1, 'the tray quit action uses the app lifecycle');
  const foreign = new Window(); foreign.url = 'https://example.com';
  assert.throws(() => call('set-shortcut', foreign, 'Alt+P'), /Untrusted/);
  panel.destroy(); controller.toggle();
  const coldPanel = controller.getWindow();
  controller.toggle(); call('ready', coldPanel);
  assert.equal(coldPanel.visible, false, 'canceling before the first renderer load must not reopen the printer');
  assert.equal(coldPanel.messages.some(([channel]) => channel === 'shoggoth:desktop-inspiration:show'), false);
  controller.toggle(); reveal(coldPanel); assert.equal(coldPanel.visible, true);
  controller.toggle();
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(coldPanel.visible, false, 'a stalled renderer still closes via the native fallback');
} finally { controller.dispose(); }
assert.equal(shortcuts.size, 0); assert.equal(handlers.size, 0); assert.equal(tray.destroyed, true);
console.log('PASS desktop inspiration: main-window tray clicks, backend stop menu, background capture, busy protection, trusted frames, shortcuts and cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
