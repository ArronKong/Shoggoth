"use strict";

const path = require("node:path");
const { DEFAULT_INSPIRATION_SHORTCUT, normalizeInspirationShortcut } = require("./desktop-inspiration-shortcut");

const PREFIX = "shoggoth:desktop-inspiration:";
const CHANNELS = Object.fromEntries(["preferences", "capture-shortcut", "set-shortcut", "ready", "reveal", "conceal", "dismiss", "interaction", "busy", "tray-target"]
  .map(name => [name, PREFIX + name]));

function createDesktopInspirationController({ BrowserWindow, Tray, Menu, nativeImage, globalShortcut, screen, ipcMain,
  configStore, getMainWindow, showMainWindow, getUiOrigin, getLocale, stopBackend, quit }) {
  let window = null, tray = null, disposed = false, busy = false, loaded = false, presenting = false;
  let stoppingBackend = false;
  let visibleRequested = false, presentationId = 0;
  let hideTimer = null;
  let registered = null, captureTimer = null, captureOwner = null;
  const handles = [], listeners = [];
  const configured = () => normalizeInspirationShortcut(configStore.read().inspirationShortcut) || DEFAULT_INSPIRATION_SHORTCUT;
  const trustedWindow = (event, candidate) => {
    if (!candidate || candidate.isDestroyed() || candidate.webContents.isDestroyed()) return false;
    if (event?.sender !== candidate.webContents || event.senderFrame !== candidate.webContents.mainFrame) return false;
    try { return new URL(candidate.webContents.getURL()).origin === new URL(getUiOrigin()).origin; } catch { return false; }
  };
  const state = () => ({ accelerator: configured(), registered: registered === configured() && globalShortcut.isRegistered(configured()) });
  const display = () => {
    const bounds = tray?.getBounds();
    return bounds?.width > 0 && bounds?.height > 0 ? screen.getDisplayMatching(bounds) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  };
  const geometry = () => {
    const bounds = window?.getBounds() || display().bounds;
    const currentDisplay = screen.getDisplayMatching(bounds);
    const monitor = currentDisplay.bounds;
    const icon = tray?.getBounds();
    return { top: monitor.y - bounds.y, center: monitor.x + monitor.width / 2 - bounds.x,
      tray: icon?.width > 0 && icon?.height > 0 ? { x: icon.x + icon.width / 2 - bounds.x, y: icon.y + icon.height / 2 - bounds.y }
        : { x: monitor.x + monitor.width - 32 - bounds.x, y: monitor.y + 12 - bounds.y } };
  };
  const finishHide = id => {
    if (disposed || !window || window.isDestroyed() || visibleRequested || id !== presentationId) return false;
    clearTimeout(hideTimer); hideTimer = null;
    window.webContents.send(PREFIX + "hidden");
    window.hide();
    window.setIgnoreMouseEvents(true, { forward: true });
    return true;
  };
  const hide = () => {
    if (!window || window.isDestroyed() || busy || !visibleRequested) return;
    visibleRequested = false;
    const id = ++presentationId;
    window.setIgnoreMouseEvents(true, { forward: true });
    if (!loaded || !window.isVisible()) { finishHide(id); return; }
    window.webContents.send(PREFIX + "hide", id);
    // A stalled renderer must not leave an invisible, focused panel behind.
    hideTimer = setTimeout(() => finishHide(id), 750);
  };
  const present = () => {
    if (!window || window.isDestroyed() || !loaded || disposed || !visibleRequested) return;
    clearTimeout(hideTimer); hideTimer = null;
    window.setBounds(display().bounds);
    window.setAlwaysOnTop(true, "screen-saver");
    window.setIgnoreMouseEvents(true, { forward: true });
    // The renderer prepares the off-screen machine and retracted paper before
    // acknowledging this generation. Never expose its previous resting frame.
    window.webContents.send(PREFIX + "show", { ...geometry(), presentationId: ++presentationId });
  };
  const createWindow = () => {
    const instance = new BrowserWindow({ ...display().bounds, title: "Shoggoth — Spark Notes", show: false,
      frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      // Frameless macOS panels otherwise get clamped below the menu bar.
      ...(process.platform === "darwin" ? { type: "panel", enableLargerThanScreen: true } : {}),
      webPreferences: { preload: path.join(__dirname, "desktop-inspiration-preload.js"), contextIsolation: true,
        nodeIntegration: false, sandbox: true, spellcheck: false } });
    window = instance; loaded = false;
    instance.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    instance.setIgnoreMouseEvents(true, { forward: true });
    instance.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    instance.webContents.on("will-navigate", event => event.preventDefault());
    instance.webContents.on("will-frame-navigate", event => event.preventDefault());
    instance.webContents.on("render-process-gone", () => { if (!instance.isDestroyed()) instance.destroy(); });
    // macOS can deliver the blur from hide() after the next shortcut has
    // already requested a reveal. Only dismiss an actually visible panel.
    instance.on("blur", () => { if (instance.isVisible() && !instance.isFocused()) hide(); });
    instance.on("closed", () => { if (window === instance) {
      clearTimeout(hideTimer); hideTimer = null;
      window = null; loaded = false; busy = false; visibleRequested = false; presentationId++;
    } });
    void instance.loadURL(`${getUiOrigin()}/#/desktop-inspiration`).catch(() => { if (!instance.isDestroyed()) instance.destroy(); });
  };
  const toggle = () => {
    if (disposed || captureOwner) return;
    if (visibleRequested) { hide(); return; }
    visibleRequested = true;
    if (!window || window.isDestroyed()) createWindow();
    else present();
  };
  const register = accelerator => {
    try {
      if (registered === accelerator && globalShortcut.isRegistered(accelerator)) return true;
      if (!globalShortcut.register(accelerator, toggle)) return false;
      registered = accelerator;
      return true;
    } catch { return false; }
  };
  const stopCapture = () => {
    clearTimeout(captureTimer); captureTimer = null;
    captureOwner?.removeListener("blur", stopCapture);
    captureOwner?.removeListener("closed", stopCapture);
    captureOwner = null;
    if (!disposed) register(configured());
  };
  const bind = (name, forDesktop, callback) => {
    ipcMain.handle(CHANNELS[name], (event, input) => {
      if (!trustedWindow(event, forDesktop ? window : getMainWindow())) throw new Error("Untrusted inspiration window");
      return callback(input, event);
    });
    handles.push(CHANNELS[name]);
  };
  const listen = (name, callback) => {
    const handler = (event, input) => { if (trustedWindow(event, window)) callback(input); };
    ipcMain.on(CHANNELS[name], handler); listeners.push([CHANNELS[name], handler]);
  };
  bind("preferences", false, state);
  bind("capture-shortcut", false, (active, event) => {
    if (active === false) { stopCapture(); return state(); }
    if (active !== true) throw new Error("Invalid shortcut capture");
    stopCapture(); captureOwner = getMainWindow();
    if (registered) globalShortcut.unregister(registered);
    registered = null;
    captureOwner.once("blur", stopCapture); captureOwner.once("closed", stopCapture);
    captureTimer = setTimeout(stopCapture, 30_000);
    return state();
  });
  bind("set-shortcut", false, input => {
    const accelerator = normalizeInspirationShortcut(input);
    const previous = configured(), previousRegistration = registered;
    if (!accelerator) { stopCapture(); return { ok: false, error: "invalid", ...state() }; }
    if (!register(accelerator)) { stopCapture(); return { ok: false, error: "unavailable", ...state() }; }
    try { configStore.write({ inspirationShortcut: accelerator }); }
    catch {
      if (accelerator !== previousRegistration) globalShortcut.unregister(accelerator);
      registered = previousRegistration;
      stopCapture(); register(previous);
      return { ok: false, error: "saveFailed", ...state() };
    }
    if (previousRegistration && previousRegistration !== accelerator) globalShortcut.unregister(previousRegistration);
    stopCapture(); tray?.setToolTip(`Shoggoth · ${accelerator}`);
    return { ok: true, ...state() };
  });
  bind("ready", true, () => { loaded = true; present(); return geometry(); });
  bind("reveal", true, id => {
    if (disposed || !loaded || !visibleRequested || id !== presentationId) return false;
    presenting = true;
    try { window.showInactive(); window.focus(); }
    finally { presenting = false; }
    return true;
  });
  bind("dismiss", true, () => { hide(); return true; });
  bind("conceal", true, finishHide);
  bind("tray-target", true, () => geometry().tray);
  listen("interaction", interactive => { if (typeof interactive === "boolean" && visibleRequested && window?.isVisible()) window.setIgnoreMouseEvents(!interactive, { forward: true }); });
  listen("busy", value => { if (typeof value === "boolean") busy = value; });
  const onDisplayChange = () => { if (visibleRequested && window && !window.isDestroyed()) {
    window.setBounds(display().bounds); window.webContents.send(PREFIX + "geometry", geometry());
  } };
  screen.on("display-metrics-changed", onDisplayChange); screen.on("display-removed", onDisplayChange);
  // Dedicated 14pt transparent white (90%) artwork, with an @2x representation for
  // Retina. Keep it non-template so macOS preserves the requested color/alpha.
  const image = nativeImage.createFromPath(path.join(__dirname, "assets/tray/shoggoth.png"));
  tray = new Tray(image);
  tray.setToolTip(`Shoggoth · ${configured()}`);
  const openMainWindow = () => { hide(); showMainWindow(); };
  const stopBackendFromTray = async () => {
    if (disposed || stoppingBackend) return;
    stoppingBackend = true;
    try { await stopBackend(); }
    finally { stoppingBackend = false; }
  };
  tray.on("click", openMainWindow);
  tray.on("right-click", () => {
    const zh = getLocale() === "zh-CN";
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: zh ? "记录灵感" : "Capture a thought", click: toggle },
      { label: zh ? "打开 Shoggoth" : "Open Shoggoth", click: openMainWindow },
      { type: "separator" },
      { label: stoppingBackend ? (zh ? "正在退出后端…" : "Stopping backend…") : (zh ? "退出后端" : "Stop backend"),
        enabled: !stoppingBackend, click: stopBackendFromTray },
      { label: zh ? "退出 Shoggoth" : "Quit Shoggoth", click: quit },
    ]));
  });
  register(configured());
  return { toggle, getWindow: () => window, isPresenting: () => presenting, getTrayBounds: () => tray?.getBounds(), state,
    dispose() {
      disposed = true; stopCapture();
      clearTimeout(hideTimer); hideTimer = null;
      if (registered) globalShortcut.unregister(registered);
      registered = null;
      handles.forEach(channel => ipcMain.removeHandler(channel));
      listeners.forEach(([channel, handler]) => ipcMain.removeListener(channel, handler));
      screen.removeListener("display-metrics-changed", onDisplayChange); screen.removeListener("display-removed", onDisplayChange);
      if (window && !window.isDestroyed()) window.destroy();
      tray?.destroy(); tray = null;
    } };
}

module.exports = { createDesktopInspirationController, CHANNELS, PREFIX };
