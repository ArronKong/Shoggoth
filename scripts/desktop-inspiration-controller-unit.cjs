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
  getBounds() { return this.bounds; }
  setBounds(value) { this.bounds = value; }
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
  setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
  show() { this.visible = true; }
  showInactive() { this.visible = true; this.presentedInactive = true; }
  hide() { this.visible = false; }
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
let config = normalizeConfig({}), failWrite = false, shown = 0, tray;
const controller = createDesktopInspirationController({ BrowserWindow: Window,
  Tray: class extends StatusItem { constructor(image) { super(image); tray = this; } }, Menu: { buildFromTemplate: x => x },
  nativeImage: { createFromPath: file => ({ resize: size => ({ file, ...size }) }) }, globalShortcut, screen, ipcMain,
  configStore: { read: () => config, write: patch => { if (failWrite) throw new Error('disk full'); config = normalizeConfig({ ...config, ...patch }); } },
  getMainWindow: () => main, showMainWindow: () => { shown++; main.minimized = false; main.show(); },
  getUiOrigin: () => 'http://127.0.0.1:18799', getLocale: () => 'zh-CN', quit() {} });
const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
const call = (name, window, input) => handlers.get(CHANNELS[name])(event(window), input);
try {
  assert.equal(config.inspirationShortcut, 'Alt+S');
  assert.equal(normalizeInspirationShortcut('Option+s'), 'Alt+S');
  assert.equal(normalizeInspirationShortcut('cmd+shift+K'), 'Shift+Command+K');
  for (const value of ['S', 'Shift+S', 'Alt+Alt+S', 'Alt+/', 'Alt+F25', {}, 'Alt+S+K']) assert.equal(normalizeInspirationShortcut(value), null);
  assert.equal(tray.image.width, 18);
  shortcuts.get('Alt+S')();
  const panel = controller.getWindow();
  assert.equal(panel.options.transparent, true); assert.equal(panel.options.webPreferences.sandbox, true);
  if (process.platform === 'darwin') assert.equal(panel.options.enableLargerThanScreen, true, 'the native frameless panel can reach behind the menu bar');
  assert.equal(call('ready', panel).top, 0, 'the cropped housing attaches to the display edge without a menu-bar gap');
  assert.equal(panel.presentedInactive, true, 'presenting the panel must not activate the main window');
  assert.equal(panel.visible, true); assert.equal(main.minimized, true); assert.equal(shown, 0, 'opening desktop capture must not restore the main app');
  assert.deepEqual(call('tray-target', panel), { x: 1772, y: 12 });
  const primaryDisplay = currentDisplay;
  for (const menuBarHeight of [0, 24, 38]) {
    currentDisplay = { bounds: { x: -1920, y: -1080, width: 1920, height: 1080 },
      workArea: { x: -1920, y: -1080 + menuBarHeight, width: 1920, height: 1080 - menuBarHeight } };
    screen.emit('display-metrics-changed');
    const [channel, geometry] = panel.messages.at(-1);
    assert.equal(channel, 'shoggoth:desktop-inspiration:show');
    assert.equal(geometry.top, 0, 'secondary displays and menu-bar visibility keep the printer flush to the top');
    assert.equal(geometry.center, 960);
  }
  panel.setBounds({ ...currentDisplay.bounds, y: currentDisplay.bounds.y + 24 });
  assert.equal(call('ready', panel).top, 0, 'showing again restores the panel to the display bounds');
  currentDisplay = primaryDisplay;
  screen.emit('display-metrics-changed');
  assert.equal(panel.openHandler({ url: 'https://example.com' }).action, 'deny');
  const subframe = { sender: panel.webContents, senderFrame: {} };
  assert.throws(() => handlers.get(CHANNELS.ready)(subframe), /Untrusted/);
  ipcMain.emit(CHANNELS.interaction, subframe, true); assert.equal(panel.ignoreMouse, true);
  ipcMain.emit(CHANNELS.interaction, event(panel), true); assert.equal(panel.ignoreMouse, false);
  ipcMain.emit(CHANNELS.busy, event(panel), true);
  controller.toggle(); call('dismiss', panel); assert.equal(panel.visible, true, 'do not discard an active recording or save');
  ipcMain.emit(CHANNELS.busy, event(panel), false);
  call('dismiss', panel); assert.equal(panel.visible, false);
  controller.toggle(); assert.equal(panel.visible, true);
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
  const foreign = new Window(); foreign.url = 'https://example.com';
  assert.throws(() => call('set-shortcut', foreign, 'Alt+P'), /Untrusted/);
} finally { controller.dispose(); }
assert.equal(shortcuts.size, 0); assert.equal(handlers.size, 0); assert.equal(tray.destroyed, true);
console.log('PASS desktop inspiration: background/minimized capture, tray target, click-through, busy protection, trusted frames, shortcut conflicts, persistence rollback and cleanup');
