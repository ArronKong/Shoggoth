"use strict";

const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startStaticServer } = require("./static-server");

const CONTROL_UI_DIR = path.join(__dirname, "control-ui");
// Fixed port -> stable http://127.0.0.1:<port> origin so the official UI's
// localStorage settings and ed25519 device identity persist across launches
// (and the user can allowlist a single origin on remote gateways).
const UI_PORT = 18799;
// Default gateway for first-run config. Editable by the user afterwards via
// the Gateway settings menu or directly in userData/config.json.
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18792";
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");

let mainWindow = null;
let settingsWindow = null;
let staticServer = null;
let serverOrigin = null;

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      gatewayUrl: typeof parsed.gatewayUrl === "string" ? parsed.gatewayUrl : "",
      token: typeof parsed.token === "string" ? parsed.token : "",
    };
  } catch {
    return { gatewayUrl: "", token: "" };
  }
}

// First run: drop an editable config.json so the user only ever fills the
// token once (URL is pre-filled). Token intentionally not shipped in the app.
function ensureConfigFile() {
  if (fs.existsSync(CONFIG_PATH)) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ gatewayUrl: DEFAULT_GATEWAY_URL, token: "" }, null, 2),
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
}

function writeConfig(config) {
  const next = {
    gatewayUrl: typeof config.gatewayUrl === "string" ? config.gatewayUrl.trim() : "",
    token: typeof config.token === "string" ? config.token : "",
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function isInternalUrl(target) {
  if (!serverOrigin) {
    return false;
  }
  try {
    return new URL(target).origin === new URL(serverOrigin).origin;
  } catch {
    return false;
  }
}

function createMainWindow() {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: "",
    backgroundColor: "#ffffff",
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 12 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  // Open http(s) links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Keep in-app navigation confined to our loopback origin.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(serverOrigin);
}

function openGatewaySettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    title: "Gateway 连接设置",
    backgroundColor: "#151b21",
    webPreferences: {
      preload: path.join(__dirname, "gateway-config.preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  void settingsWindow.loadFile(path.join(__dirname, "gateway-config.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Gateway",
      submenu: [
        {
          label: "设置连接…",
          accelerator: "CmdOrCtrl+,",
          click: () => openGatewaySettings(),
        },
        {
          label: "重新连接 / 刷新",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow && mainWindow.webContents.reload(),
        },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "窗口",
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ role: "front" }] : [])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC ---------------------------------------------------------------

ipcMain.on("openclaw:get-config", (event) => {
  event.returnValue = readConfig();
});

ipcMain.on("openclaw:open-gateway-settings", () => openGatewaySettings());

ipcMain.handle("openclaw:get-config-async", () => readConfig());

ipcMain.handle("openclaw:save-config", (_event, config) => {
  const saved = writeConfig(config || {});
  if (settingsWindow) {
    settingsWindow.close();
  }
  if (mainWindow) {
    mainWindow.webContents.reload();
  }
  return saved;
});

ipcMain.handle("openclaw:cancel-config", () => {
  if (settingsWindow) {
    settingsWindow.close();
  }
});

// --- App lifecycle -----------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (!fs.existsSync(path.join(CONTROL_UI_DIR, "index.html"))) {
      dialog.showErrorBox(
        "Control UI 缺失",
        `未找到 ${CONTROL_UI_DIR}/index.html。\n请先运行: npm run build:ui`,
      );
      app.quit();
      return;
    }
    ensureConfigFile();
    staticServer = await startStaticServer(CONTROL_UI_DIR, UI_PORT);
    serverOrigin = staticServer.url;
    buildMenu();
    createMainWindow();

    // First run (or token cleared): prompt for the token exactly once.
    // Afterwards it persists in config.json and preload re-injects it.
    if (!readConfig().token) {
      mainWindow.webContents.once("did-finish-load", () => openGatewaySettings());
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", async () => {
    if (staticServer) {
      await staticServer.close().catch(() => {});
      staticServer = null;
    }
  });
}
