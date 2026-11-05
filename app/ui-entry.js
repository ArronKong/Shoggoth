"use strict";

// Silently swallow EPIPE on stdio. A Finder-launched app may not have a durable
// parent stdio pipe; native diagnostics must never turn that into an app crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (!err || err.code !== "EPIPE") throw err;
  });
}

const { app, BrowserWindow, WebContentsView, webContents, Menu, shell, ipcMain, dialog, Notification, nativeTheme, powerMonitor, Tray, nativeImage, globalShortcut, screen, session, systemPreferences, clipboard } = require("electron");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { startStaticServer } = require("./static-server");
const { revealHostPath } = require("./host-path-reveal");
const { createDesktopSystemIssueReporter } = require("./desktop-system-issue");
const { resolveDesktopProxyPort } = require("./desktop-dev-proxy-port");
const { assertUiHostOpsCoverage } = require("./host-capability-manifest");
const { DesktopChatUiHost } = require("./desktop-chat-ui-host");
const { registerDesktopChatUiIpc } = require("./desktop-chat-ui-ipc");
const chatUiHost = new DesktopChatUiHost({ WebContentsView, ipcMain, session, webContents });
const { scanInstalledClis, resolveCliVersion } = require("./cli-scanner");
const { startProxyGateway } = require("./core/proxy-gateway");
const { HermesBackend, agentIdForProfile } = require("./core/hermes-backend");
const { ShoggothBackend } = require("./core/shoggoth-backend");
const { BackendRegistry } = require("./core/backend-registry");
const { OpenClawBackend, resolveOpenclawBin } = require("./core/openclaw-backend");
const { getBootstrappedDesktopPaths } = require("./desktop-data-bootstrap");
const { createRuntimeCliAuth } = require("./runtime-cli-auth");
const { requestService, readClientToken } = require("./agent-service/client");
const { createLaunchAgentController } = require("./agent-service/launch-agent");
const { PROTOCOL_VERSION } = require("./agent-service/server");
const { createProductHostController } = require("./product-host-controller");
const { createFederationHostServer } = require("./federation-host-server");
const { notificationPolicy } = require("./agent-service/notification-policy");
const { showNativeNotification } = require("./agent-service/native-notification-sender");
const { ExternalInspirationRunner } = require("./external-inspiration-runner");
const { createFederationMcpRegistrar } = require("./federation-mcp-registrar");
const { createExternalPluginAdapterRegistrar } = require("./external-plugin-adapter-registrar");
const { createManagedOpenClawProductHost } = require("./managed-openclaw-product-host");
const { createManagedOpenClawProviderCredentialBroker } = require("./managed-openclaw-provider-credential-broker");
const { createManagedOpenClawProductAuth } = require("./managed-openclaw-product-auth");
const { createManagedOpenClawEndpointGeneration } = require("./managed-openclaw-endpoint-generation");
const { resolveManagedOpenClawProductInputs } = require("./managed-openclaw-product-inputs");
const { createManagedHermesProductHost } = require("./managed-hermes-product-host");
const { createManagedHermesProductAuth } = require("./managed-hermes-product-auth");
const { resolveManagedHermesProductInputs } = require("./managed-hermes-product-inputs");
const { installManagedPluginHostQuitGate } = require("./managed-plugin-host-quit");
const {
  createFederatedAgentTaskRunner,
  runFederatedAgentViaBroker,
} = require("./federated-agent-runner");
const { createConfigStore, MIN_WINDOW_BOUNDS } = require("./core/config-store");
const { createChatReadStateStore } = require("./core/chat-read-state-store");
const { createAuthResolver } = require("./core/device-auth");
const { createDashboardJournal } = require("./core/dashboard-journal");
const { createKanbanProjectStore } = require("./core/kanban-project-store");
const { createModelChangeJournal } = require("./core/model-change-journal");
const { ModelChangeCoordinator } = require("./core/model-change-coordinator");
const { ModelOperationRecoveryStore } = require("./model-operation-recovery-store");
const { registerDesktopModelOperationRecoveryIpc } = require("./desktop-model-operation-recovery-ipc");
const { DesktopGroupSendJournalStore } = require("./desktop-group-send-journal-store");
const { registerDesktopGroupSendJournalIpc } = require("./desktop-group-send-journal-ipc");
const { createWorkAdmissionGate } = require("./core/work-admission-gate");
const { createOpenClawRuntimeApply } = require("./core/openclaw-runtime-apply");
const { createOpenClawModelChange } = require("./core/openclaw-model-change");
const { createManagedOpenClawModelApply } = require("./core/managed-openclaw-model-apply");
const { createOpenclawHostController } = require("./openclaw-host");
const { createHermesModelMutationGate } = require("./core/hermes-model-mutation");
const { createHermesModelChange } = require("./core/hermes-model-change");
const { registerDesktopSecretIpc } = require("./desktop-secret-ipc");
const { registerDesktopComputerIpc } = require("./desktop-computer-ipc");
const { registerDesktopBrowserIpc } = require("./desktop-browser-ipc");
const { createDesktopComputerServiceRestart } = require("./desktop-computer-service-restart");
const { registerDesktopInspirationIpc } = require("./desktop-inspiration-ipc");
const { createDesktopInspirationController } = require("./desktop-inspiration-controller");
const { createAppIconController } = require("./desktop-app-icon");
const { createDesktopBackendStopAction } = require("./desktop-backend-stop");
const { registerDesktopMicrophoneIpc } = require("./desktop-microphone-ipc");
const { registerDesktopTypewriterSoundIpc } = require("./desktop-typewriter-sound-ipc");
const { registerDesktopChatClipboardIpc } = require("./desktop-chat-clipboard-ipc");
const { registerDesktopTelemetryIpc } = require("./desktop-telemetry-ipc");
const { createDesktopAppUpdateController } = require("./desktop-app-update");
const { createDesktopAppInstallPreparation } = require("./desktop-app-install-preparation");
const { createProductTelemetry } = require("./core/product-telemetry");
const productTelemetryBuildConfig = require("./product-telemetry-build-config");
const { createBoardWidgetHost } = require("./board-widget-host");
const { registerDesktopBoardWidgetIpc } = require("./desktop-board-widget-ipc");
const {
  createBoardWidgetNavigationGuard,
  shouldOpenExternalUrl,
} = require("./board-widget-navigation");

// GUI-launched macOS apps inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin)
// with no Homebrew/npm/cargo/… dirs, so the CLI page's $PATH scan finds 0
// user-installed tools (only system binaries, which are filtered out). Resolve
// the login-shell PATH once at startup so scanInstalledClis — and any host
// command we run — sees what the user actually has installed. Best-effort:
// on timeout/failure keep the inherited PATH (page degrades, app never hangs).
//
// Proxy vars ride along: the Hermes ACP subprocess inherits our env, and
// without the shell's http(s)_proxy it can't reach direct-international APIs
// (api.anthropic.com → 403 here) — Hermes then silently fails over to the
// default provider, so a chat `/model` switch LOOKS applied but answers still
// come from the old model. no_proxy comes too so loopback (dashboards, local
// proxies) never routes through the proxy. Only fill vars the GUI env lacks.
if (process.platform === "darwin") {
  try {
    const { execSync } = require("node:child_process");
    const loginShell = process.env.SHELL || "/bin/zsh";
    const MARK = "__OCC_ENV__";
    const PROXY_VARS = [
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    ];
    const lines = ["PATH=$PATH", ...PROXY_VARS.map((v) => `${v}=$${v}`)]
      .map((kv) => `"${kv}"`)
      .join(" ");
    const out = execSync(`${loginShell} -ilc 'printf "%s\\n" "${MARK}" ${lines}'`, {
      timeout: 4000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const markAt = out.lastIndexOf(MARK);
    const body = markAt >= 0 ? out.slice(markAt + MARK.length) : "";
    for (const line of body.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === "PATH") {
        if (value.includes(path.sep)) process.env.PATH = value;
      } else if (PROXY_VARS.includes(key) && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    /* keep the inherited env */
  }
}

const MANAGE_UI_DIR = path.join(__dirname, "manage-ui", "dist");
// Fixed port -> stable http://127.0.0.1:<port> origin so the official UI's
// localStorage settings and ed25519 device identity persist across launches
// (and the user can allowlist a single origin on remote gateways).
const UI_PORT = 18799;
// Default gateway for first-run config. Editable by the user afterwards via
// the Gateway settings menu or directly in userData/config.json.
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18792";
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
// Single source of truth for config.json (schema incl. hermesMode/hermesRemotes).
const configStore = createConfigStore(CONFIG_PATH, { defaultGatewayUrl: "ws://127.0.0.1:18792" });
const chatReadStateStore = createChatReadStateStore({ trustedRoot: app.getPath("userData") });

// Local federating gateway proxy. The Control UI connects here instead of
// straight to the gateway; the proxy relays every frame to the real gateway
// (config.gatewayUrl) and injects foreign (Hermes) agents into agents.list so
// they appear in the contact list. OpenClaw traffic is otherwise untouched.
const GATEWAY_PROXY_PORT = resolveDesktopProxyPort({ isPackaged: app.isPackaged });
const APP_VERSION = require("../package.json").version;

// Supported UI languages. "" means "follow system" (we resolve via app.getLocale
// at read time and pass that through to renderers/preload).
const SUPPORTED_LOCALES = new Set(["", "zh-CN", "en"]);

// Tiny i18n table for the Electron native chrome (menus and error dialogs).
const NATIVE_STRINGS = {
  "zh-CN": {
    "menu.gateway": "Gateway",
    "menu.gateway.settings": "设置连接…",
    "menu.gateway.reload": "重新连接 / 刷新",
    "menu.language": "语言 / Language",
    "menu.language.auto": "跟随系统",
    "menu.language.zh": "简体中文",
    "menu.language.en": "English",
    "menu.edit": "编辑",
    "menu.view": "视图",
    "menu.window": "窗口",
    "settings.missingPath": "缺少 CLI 路径",
    "controlUi.missing.title": "Control UI 缺失",
    "controlUi.missing.body": "未找到 {path}/index.html。\n请先运行: npm run build:manage",
    "proxy.failed.title": "本地安全代理启动失败",
    "proxy.failed.body": "Shoggoth 无法安全连接后端。应用将退出，请重启后再试。",
    "appUpdate.ready.title": "Shoggoth 更新已就绪",
    "appUpdate.ready.body": "版本 {version} 已下载。打开设置即可重新启动并安装。",
  },
  en: {
    "menu.gateway": "Gateway",
    "menu.gateway.settings": "Connection Settings…",
    "menu.gateway.reload": "Reconnect / Reload",
    "menu.language": "Language / 语言",
    "menu.language.auto": "Follow System",
    "menu.language.zh": "简体中文",
    "menu.language.en": "English",
    "menu.edit": "Edit",
    "menu.view": "View",
    "menu.window": "Window",
    "settings.missingPath": "Missing CLI path",
    "controlUi.missing.title": "Control UI missing",
    "controlUi.missing.body":
      "{path}/index.html was not found.\nRun: npm run build:manage first.",
    "proxy.failed.title": "Local security proxy failed",
    "proxy.failed.body": "Shoggoth cannot connect to backends safely. The app will quit; please restart it and try again.",
    "appUpdate.ready.title": "Shoggoth update ready",
    "appUpdate.ready.body": "Version {version} is downloaded. Open Settings to restart and install it.",
  },
};

function resolveLocale(stored) {
  if (stored && SUPPORTED_LOCALES.has(stored) && stored !== "") {
    return stored;
  }
  // app.getLocale returns BCP-47 like "zh-CN" / "en-US". Fold to our two buckets.
  const sys = (app.getLocale() || "").toLowerCase();
  return sys.startsWith("zh") ? "zh-CN" : "en";
}

function nativeT(locale, key, params) {
  const table = NATIVE_STRINGS[locale] || NATIVE_STRINGS.en;
  const value = table[key] ?? NATIVE_STRINGS.en[key] ?? key;
  if (!params) {
    return value;
  }
  return value.replace(/\{(\w+)\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`,
  );
}

let mainWindow = null;
let desktopSystemIssues = null;
let desktopInspiration = null;
let appIconController = null;
let disposeMicrophoneIpc = null;
let disposeTypewriterSoundIpc = null;
let disposeChatClipboardIpc = null;
let appIsQuitting = false;
let staticServer = null;
let federationHost = null;
// 最近一次 shoggoth MCP 静默注册的结果：群聊据此判断外部成员有没有群工具通道（D2）。
let federationMcpRegistration = null;
let serverOrigin = null;
let gatewayProxy = null;
let gatewayProxyUrl = null;
let appBackendRegistry = null;
let modelOperationRecoveryStore = null;
let modelOperationRecoveryOpening = null;
let groupSendJournalStore = null;
let groupSendJournalOpening = null;
let managedOpenClawProductHost = null;
let managedOpenClawCredentialBroker = null;
let managedHermesProductHost = null;
let openClawEndpointGeneration = 0;
const openClawCredentialGeneration = createManagedOpenClawEndpointGeneration({
  getConfig: () => readConfig(), isManaged: () => managedOpenClawProductHost?.isManaged() === true,
  getOwnerGeneration: () => openClawEndpointGeneration,
});
let boardWidgetHost = null;
let productTelemetry = null;
let disposeTelemetryIpc = null;
let appUpdateController = null;
const boardWidgetNavigation = createBoardWidgetNavigationGuard();

// Config read/write/ensure delegate to the shared store (config-store.js), which
// owns the schema (gatewayUrl/token/locale + hermesMode/hermesRemotes).
function readConfig() {
  return configStore.read();
}

// First run: drop an editable config.json so the user only ever fills the
// token once (URL is pre-filled). Token intentionally not shipped in the app.
function ensureConfigFile() {
  configStore.ensure();
  try { chatReadStateStore.ensure(); }
  catch { console.warn("[chat] shared read state unavailable; unread badges wait for recovery"); }
}

function writeConfig(config) {
  return configStore.write(config);
}

// Snapshot of the config the live backends are currently running against, so a
// save can reconnect ONLY what actually changed. Seeded at startup, refreshed at
// the end of every applyConfigChange.
let appliedConfig = null;
let configApplyQueue = Promise.resolve();

// Which expensive reactions a config change actually requires. A null prev
// (first apply) conservatively marks everything changed.
function connectionFieldsChanged(prev, next) {
  return {
    // URL or shared-token changes retire the old credential namespace.
    gateway: !prev || prev.gatewayUrl !== next.gatewayUrl || prev.token !== next.token,
    // Hermes re-spawns / re-points on a mode switch or an edited remote list.
    hermes:
      !prev ||
      prev.hermesMode !== next.hermesMode ||
      JSON.stringify(prev.hermesRemotes) !== JSON.stringify(next.hermesRemotes),
    // 断开/重连只停启对应实例；renderer 原位更新启用集合与连接状态。
    backends:
      !prev || JSON.stringify(prev.disabledBackends) !== JSON.stringify(next.disabledBackends),
  };
}

// Called after the 设置 page (or native dialog) saves config. Re-points ONLY the
// live connections whose settings actually changed. Auto-saved settings must
// apply in place without killing the page
// (or an in-flight chat stream) with a full reconnect + reload. Best-effort: a
// failed reconnect surfaces on the next request.
async function applyConfigChange() {
  const next = configStore.read();
  const applying = configApplyQueue.then(async () => {
    const diff = connectionFieldsChanged(appliedConfig, next);

    // Native chrome (titlebar, scrollbars, dialogs) tracks the theme every time —
    // cheap, and needs neither a reconnect nor a reload.
    try {
      nativeTheme.themeSource = next.theme || "light";
    } catch {
      /* ignore */
    }
    void appIconController?.apply(next.appIcon);

    if (appBackendRegistry && diff.gateway && !managedOpenClawProductHost?.isManaged()) {
      openClawEndpointGeneration += 1;
      gatewayProxy?.invalidateOpenClawUpstream?.();
      const oc = appBackendRegistry.backends.get("openclaw");
      // Drop the OpenClaw socket; the next RPC lazily reconnects using the fresh
      // gatewayUrl/origin (getUpstreamUrl reads config live).
      if (oc && typeof oc.stop === "function") {
        try { await oc.stop(); } catch { /* ignore */ }
      }
    }
    if (appBackendRegistry && diff.hermes && !managedHermesProductHost?.isManaged() && !next.disabledBackends.includes("hermes")) {
      const hb = appBackendRegistry.backends.get("hermes");
      // Hermes switches between local-spawn and remote-dashboard mode / edited remotes.
      // 已断开时跳过——reconfigure 内部 start() 会把用户刚停掉的 dashboards 又拉起来。
      if (hb && typeof hb.reconfigure === "function") {
        try { await hb.reconfigure(); } catch { console.error("[hermes] reconfigure failed"); }
      }
    }
    if (appBackendRegistry && diff.backends) {
      // 断开 → stop（openclaw 断 WS、hermes 停 dashboards/ACP；registry 过滤保证
      // 之后无人再触达它）；重新连接 → start（openclaw 的 start 是空操作，之后
      // 首个 RPC 惰性重连）。逐后端 diff，未变的不动。
      const prevDisabled = new Set(appliedConfig?.disabledBackends || []);
      const nextDisabled = new Set(next.disabledBackends);
      for (const [id, backend] of appBackendRegistry.backends) {
        let disconnectable = false;
        try { disconnectable = backend.getBackendDescriptor()?.disconnectable === true; } catch {}
        // A disconnected built-in service is only hidden; it keeps running.
        if (!disconnectable || appBackendRegistry.keepsRunningWhenDisconnected(id)) continue;
        const was = prevDisabled.has(id);
        const is = nextDisabled.has(id);
        if (was === is) continue;
        try {
          if (id === "openclaw") {
            openClawEndpointGeneration += 1;
            gatewayProxy?.invalidateOpenClawUpstream?.();
          }
          if (is) {
            if (id === "openclaw" && managedOpenClawProductHost?.isManaged()) {
              await managedOpenClawProductHost.suspend({ operationId: `backend-disable-${crypto.randomUUID()}`, timeoutMs: 60000 });
            } else if (id === "hermes" && managedHermesProductHost?.isManaged()) {
              await managedHermesProductHost.suspend({ operationId: `backend-disable-${crypto.randomUUID()}`, timeoutMs: 60000 });
            } else await backend.stop();
          } else if (id === "openclaw" && managedOpenClawProductHost?.isManaged()) {
            managedOpenClawProductHost.prepare({ operationId: `backend-enable-${crypto.randomUUID()}` });
          } else if (id === "hermes" && managedHermesProductHost?.isManaged()) {
            managedHermesProductHost.prepare({ operationId: `backend-enable-${crypto.randomUUID()}` });
          } else await appBackendRegistry.start(id);
        } catch {
          console.error("[registry] backend lifecycle update failed");
        }
      }
      appBackendRegistry.notifyConnectionsChanged();
    }

    buildMenu(); // menu labels may depend on locale; cheap to always rebuild.

    // stop/reconfigure above refresh the affected transports. Keep the renderer
    // mounted so an automatic save cannot interrupt later edits or queued writes.

    appliedConfig = next;
  });
  // Preserve every captured save in order. A failed owned stop remains visible
  // in its host controller, while later saves cannot bypass or overwrite it.
  configApplyQueue = applying.catch(() => {});
  return await applying;
}

// Capabilities the loopback REST plane needs from the Electron host (file
// reveal/open plus CLI actions). Omitted in the dev harness.
const hostOps = {
  reveal: (p) => revealHostPath(p, (absolute) => shell.showItemInFolder(absolute)),
  // Open a path with the OS default handler (agent workspace → Finder). Agent
  // workspaces can be stored tilde-form (Hermes: ~/.hermes/profiles/<p>), which
  // only the shell expands — do it here, the host owns filesystem semantics.
  // Resolves to "" on success / an error message on failure (shell.openPath).
  openPath: async (p) => {
    const raw = String(p || "");
    if (!raw) return "empty path";
    const abs = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
    try { return await shell.openPath(abs); } catch (e) { return e?.message || String(e); }
  },
  openExternal: async (url) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) { await shell.openExternal(url); return true; }
    return false;
  },
  selectSkillPackage: async () => {
    const kind = await dialog.showMessageBox(mainWindow || undefined, {
      type: "question",
      title: "安装 Shoggoth Skill",
      message: "请选择 Skill 包的来源格式",
      detail: "支持通用 SKILL.md 格式的本地目录、ZIP 包或单个 SKILL.md 文件。",
      buttons: ["选择目录", "选择 ZIP", "选择 SKILL.md", "取消"],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    });
    if (kind.response === 3) return null;
    const result = await dialog.showOpenDialog(mainWindow || undefined, kind.response === 0 ? {
      title: "选择 Shoggoth Skill 包目录",
      properties: ["openDirectory"],
      buttonLabel: "选择 Skill",
    } : {
      title: kind.response === 1 ? "选择 Skill ZIP 包" : "选择 SKILL.md 文件",
      properties: ["openFile"],
      filters: kind.response === 1 ? [{ name: "Skill ZIP", extensions: ["zip"] }]
        : [{ name: "SKILL.md", extensions: ["md"] }],
      buttonLabel: "选择 Skill",
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    return result.filePaths[0];
  },
  // 在系统终端里跑一条命令（external provider 的 `claude setup-token` / 断开命令）。
  // 官方桌面版有内置终端，我们没有 → 借 Terminal.app，用户能看见执行的是什么。
  // **调用方必须已做白名单**（static-server 只接受 {provider,kind}，命令由服务端从
  // oauth 目录解析）——这里不做二次校验，只负责把字符串安全地塞进 AppleScript。
  runInTerminal: (command) => {
    const cmd = String(command || "").trim();
    if (!cmd) return "empty command";
    if (process.platform !== "darwin") return "runInTerminal is macOS-only";
    // AppleScript 字面量转义：反斜杠与双引号。命令是白名单来的，但转义不能省——
    // 少了它带引号的命令（disconnectCommand 的 -s "Claude Code-credentials"）会
    // 把 AppleScript 语法弄断。
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      const { execFileSync } = require("node:child_process");
      execFileSync("/usr/bin/osascript", [
        "-e", `tell application "Terminal" to do script "${esc(cmd)}"`,
        "-e", 'tell application "Terminal" to activate',
      ], { timeout: 10_000 });
      return "";
    } catch (e) {
      return e?.stderr?.toString().trim() || e?.message || String(e);
    }
  },
  resolveCliVersion: (p) => resolveCliVersion(p),
};
assertUiHostOpsCoverage(hostOps);

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
  // 尺寸从配置来：首启是 schema 默认的 1512×982，之后是用户上次留下的大小。
  const { width, height } = configStore.read().windowBounds;
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    // Hide the native title string; macOS uses a transparent inset title bar.
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
      sandbox: true,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });
  const windowForRecovery = mainWindow;
  const windowWebContentsId = windowForRecovery.webContents.id;
  let rendererRecoveryAttempts = 0;
  let rendererRecoveryTimer = null;
  const closeAfterRendererFailure = () => {
    if (mainWindow !== windowForRecovery || windowForRecovery.isDestroyed()) return;
    if (appIsQuitting) {
      windowForRecovery.close();
      return;
    }
    try {
      dialog.showErrorBox(
        "Shoggoth",
        "The interface stopped unexpectedly. Please reopen Shoggoth.",
      );
    } catch { /* closing the failed window is still required */ }
    windowForRecovery.close();
  };

  // Open http(s) links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Normal UI links deliberately use noreferrer. Board frames cannot reach
    // this handler because neither sandbox grants allow-popups; the Electron
    // smoke exercises that boundary with a real outer frame.
    if (shouldOpenExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Persistent Board documents live on a separate loopback origin. Their one
  // initial ticket navigation and one nested srcdoc load are allowlisted; every
  // subsequent navigation from that subtree is blocked before any request.
  mainWindow.webContents.on("will-frame-navigate", (details) => {
    boardWidgetNavigation.handle(details, {
      ownerId: windowWebContentsId,
      mainFrame: windowForRecovery.webContents.mainFrame,
    });
  });

  // Keep in-app navigation confined to our loopback origin.
  mainWindow.webContents.on("will-navigate", (event, legacyUrl) => {
    const url = typeof event?.url === "string" ? event.url : legacyUrl;
    if (boardWidgetNavigation.isBoardFrame(event?.initiator)) {
      event.preventDefault();
      return;
    }
    if (!isInternalUrl(url)) {
      event.preventDefault();
      if (event?.initiator === windowForRecovery.webContents.mainFrame && /^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
    }
  });

  // Programmatic reloads do not emit will-navigate. Revoke every document as
  // soon as a new main-frame navigation starts so a crashed/reloaded renderer
  // cannot inherit its predecessor's active lease.
  mainWindow.webContents.on("did-start-navigation", (details, _url, _sameDocument, legacyMainFrame) => {
    const isMainFrame = typeof details?.isMainFrame === "boolean"
      ? details.isMainFrame
      : legacyMainFrame;
    const isSameDocument = typeof details?.isSameDocument === "boolean"
      ? details.isSameDocument
      : _sameDocument;
    if (isMainFrame && isSameDocument !== true
      && !boardWidgetNavigation.isBoardFrame(details?.initiator)) {
      notificationTargetReceiver = null;
      desktopSystemIssues?.reset();
      void desktopBoardWidgetIpc.revokeOwner(windowWebContentsId);
    }
  });
  mainWindow.webContents.on("did-finish-load", flushNotificationTarget);

  // Renderer text/source URLs are untrusted and may contain prompts or secrets.
  // Keep native diagnostics fixed instead of forwarding the raw console payload.
  mainWindow.webContents.on("did-fail-load", () => {
    console.error("[Renderer] page load failed");
  });

  // A renderer crash gets one bounded recovery attempt per BrowserWindow. A
  // second crash closes the window instead of entering an unbounded reload loop.
  mainWindow.webContents.on("render-process-gone", () => {
    void desktopBoardWidgetIpc.revokeOwner(windowWebContentsId);
    if (appIsQuitting) return;
    if (mainWindow !== windowForRecovery || windowForRecovery.isDestroyed()) return;
    if (rendererRecoveryAttempts >= 1) {
      closeAfterRendererFailure();
      return;
    }
    rendererRecoveryAttempts += 1;
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = null;
      if (mainWindow !== windowForRecovery || windowForRecovery.isDestroyed()) return;
      try {
        const loading = windowForRecovery.loadURL(serverOrigin);
        void Promise.resolve(loading).catch(closeAfterRendererFailure);
      } catch {
        closeAfterRendererFailure();
      }
    }, 250);
  });

  // 记住用户调整后的窗口大小。拖动过程中防抖（每一帧都写盘没必要），最大化/全屏/
  // 最小化时跳过——那几种状态的 getSize 是屏幕尺寸，存下去会让下次启动"卡"成满屏，
  // 而不是还原用户真正拖出来的大小。关闭前补存一次，兜住最后一次没落盘的拖动。
  let boundsSaveTimer = null;
  const persistWindowBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized() || mainWindow.isFullScreen() || mainWindow.isMinimized()) return;
    const [width, height] = mainWindow.getSize();
    try {
      // write 是 read-merge-write：只覆盖 windowBounds，用户在设置页刚存的字段不受影响。
      configStore.write({ windowBounds: { width, height } });
    } catch (error) {
      desktopSystemIssues?.report(error);
      // 尺寸记忆是锦上添花，写失败不该影响使用。
      console.warn("[window] persist bounds failed");
    }
  };
  mainWindow.on("resize", () => {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(persistWindowBounds, 400);
  });
  mainWindow.on("close", () => {
    clearTimeout(boundsSaveTimer);
    persistWindowBounds();
  });

  mainWindow.on("closed", () => {
    void desktopBoardWidgetIpc.revokeOwner(windowWebContentsId);
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = null;
    notificationTargetReceiver = null;
    mainWindow = null;
  });

  void mainWindow.loadURL(serverOrigin).then(() => {
    const id = pendingProactiveNotice; pendingProactiveNotice = null;
    if (id) void openProactiveNotice(id).catch(() => {});
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Connection settings live in the SPA's 设置 page (fields + hints + 测试连接).
// The old native gateway-config dialog was retired: it duplicated those fields
// with worse copy and re-prompted on every launch while token was empty.
function openGatewaySettings() {
  if (!mainWindow) {
    createMainWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      if (mainWindow) mainWindow.webContents.send("openclaw:navigate", "/settings");
    });
    return;
  }
  mainWindow.focus();
  mainWindow.webContents.send("openclaw:navigate", "/settings");
}

function showUpdateReadyNotification(state) {
  if (!Notification.isSupported()) return;
  const locale = resolveLocale(readConfig().locale);
  const version = state?.availableVersion || "";
  showNativeNotification(Notification, {
    title: nativeT(locale, "appUpdate.ready.title"),
    body: nativeT(locale, "appUpdate.ready.body", { version }),
  }, openGatewaySettings);
}

function setLocaleAndApply(localeRaw) {
  const value = SUPPORTED_LOCALES.has(localeRaw) ? localeRaw : "";
  const current = readConfig();
  if (current.locale === value) {
    return;
  }
  // 原生菜单直接写配置时不会经过 applyConfigChange；同步运行态快照，避免
  // 下一次仅保存主题/通知时把旧 locale 误判成新变化并重复 reload。
  writeConfig({ ...current, locale: value });
  appliedConfig = { ...(appliedConfig || current), locale: value };
  buildMenu();
  if (mainWindow) {
    mainWindow.webContents.reload();
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const cfg = readConfig();
  const storedLocale = cfg.locale || "";
  const effectiveLocale = resolveLocale(storedLocale);
  const T = (key) => nativeT(effectiveLocale, key);

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
      label: T("menu.gateway"),
      submenu: [
        {
          label: T("menu.gateway.settings"),
          accelerator: "CmdOrCtrl+,",
          click: () => openGatewaySettings(),
        },
        {
          label: T("menu.gateway.reload"),
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow && mainWindow.webContents.reload(),
        },
        { type: "separator" },
        {
          label: T("menu.language"),
          submenu: [
            {
              label: T("menu.language.auto"),
              type: "radio",
              checked: storedLocale === "",
              click: () => setLocaleAndApply(""),
            },
            {
              label: T("menu.language.zh"),
              type: "radio",
              checked: storedLocale === "zh-CN",
              click: () => setLocaleAndApply("zh-CN"),
            },
            {
              label: T("menu.language.en"),
              type: "radio",
              checked: storedLocale === "en",
              click: () => setLocaleAndApply("en"),
            },
          ],
        },
      ],
    },
    {
      label: T("menu.edit"),
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
      label: T("menu.view"),
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(!app.isPackaged ? [{ role: "toggleDevTools" }] : []),
      ],
    },
    {
      label: T("menu.window"),
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ role: "front" }] : [])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC ---------------------------------------------------------------

// Synchronous config read for the main UI preload. Returns both the raw
// stored locale ("" = follow system) and the resolved locale string so the
// preload can seed localStorage["openclaw.i18n.locale"] without re-doing the
// system fallback logic.
ipcMain.on("openclaw:get-config", (event) => {
  const cfg = readConfig();
  event.returnValue = {
    ...cfg,
    effectiveLocale: resolveLocale(cfg.locale),
    proxyUrl: gatewayProxyUrl,
  };
});

const modelOperationRecoveryIpc = registerDesktopModelOperationRecoveryIpc({
  ipcMain,
  getMainWindow: () => mainWindow,
  getUiOrigin: () => serverOrigin,
  async getStore() {
    const store = modelOperationRecoveryStore, opening = modelOperationRecoveryOpening;
    if (appIsQuitting || !store || !opening) throw new Error("model recovery store unavailable");
    await opening;
    if (appIsQuitting || modelOperationRecoveryStore !== store) throw new Error("model recovery store retired");
    return store;
  },
});

const groupSendJournalIpc = registerDesktopGroupSendJournalIpc({
  ipcMain, getMainWindow: () => mainWindow, getUiOrigin: () => serverOrigin,
  async getStore({ readonlyRecovery = false } = {}) {
    const store = groupSendJournalStore, opening = groupSendJournalOpening;
    if (appIsQuitting || !store || !opening) throw new Error("group journal unavailable");
    try { await opening; } catch (error) { if (!readonlyRecovery || store.mode !== "failed") throw error; }
    if (appIsQuitting || groupSendJournalStore !== store) throw new Error("group journal retired");
    return store;
  },
  async getAuthorityScope({ groupId }) {
    if (!appBackendRegistry) throw new Error("group owner unavailable");
    const result = await appBackendRegistry.lookupGroupChatSend(groupId,
      { clientMessageId: `journal-observation:${crypto.randomUUID()}` });
    return result.ownerScope;
  },
  async lookupSend({ groupId, ...query }) {
    if (!appBackendRegistry) throw new Error("group owner unavailable");
    return appBackendRegistry.lookupGroupChatSend(groupId, query);
  },
});

registerDesktopSecretIpc({
  ipcMain, dialog,
  localSpeech: request => require("./local-media-permission").localMediaPermission(path.join(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", ".vendor"), "local-media", "shoggoth-secret-media"), request),
  getMainWindow: () => mainWindow,
  getRegistry: () => appBackendRegistry,
});
registerDesktopInspirationIpc({ ipcMain, dialog, getMainWindow: () => mainWindow,
  getDesktopWindow: () => desktopInspiration?.getWindow() });
const desktopBoardWidgetIpc = registerDesktopBoardWidgetIpc({
  ipcMain,
  getMainWindow: () => mainWindow,
  getRegistry: () => appBackendRegistry,
  getHost: () => boardWidgetHost,
  navigationGuard: boardWidgetNavigation,
});

const desktopChatUiIpc = registerDesktopChatUiIpc({ ipcMain, getMainWindow: () => mainWindow,
  getUiOrigin: () => serverOrigin, getRegistry: () => appBackendRegistry, host: chatUiHost });

ipcMain.handle("openclaw:scan-cli-tools", async () => {
  try {
    const tools = await scanInstalledClis();
    return { ok: true, tools, scannedAt: Date.now() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, tools: [], scannedAt: Date.now() };
  }
});

ipcMain.handle("openclaw:resolve-cli-version", async (_event, cliPath) => {
  const target = typeof cliPath === "string" ? cliPath.trim() : "";
  if (!target) {
    const locale = resolveLocale(readConfig().locale);
    return { ok: false, error: nativeT(locale, "settings.missingPath") };
  }
  try {
    const version = await resolveCliVersion(target);
    return { ok: true, version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, version: null };
  }
});

// Desktop notifications. The renderer-side Notifier detects a notify-worthy event
// (chat reply / cron run / task or Inspiration change) and asks main to fire a native macOS
// notification. Main is the authoritative gate: it re-checks the per-category
// config toggle (config-store is the single source) and suppresses while the
// window is focused (you're already looking at the app). A click routes back to
// the renderer via "openclaw:open-target" so the Notifier can navigate.
let notificationTargetReceiver = null;
let pendingNotificationTarget = null;
function flushNotificationTarget() {
  if (!pendingNotificationTarget || !mainWindow || mainWindow.isDestroyed()
    || notificationTargetReceiver !== mainWindow.webContents.mainFrame
    || mainWindow.webContents.isLoadingMainFrame()) return;
  const payload = pendingNotificationTarget;
  pendingNotificationTarget = null;
  mainWindow.webContents.send("openclaw:open-target", payload);
}
function openNotificationTarget(payload) {
  // The most recent click wins while a window/renderer is starting up. React's
  // Notifier subscribes after load, so did-finish-load alone cannot deliver it.
  pendingNotificationTarget = payload;
  showMainWindow();
  flushNotificationTarget();
}
ipcMain.on("openclaw:open-target-ready", (event) => {
  if (!mainWindow || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
    || !isInternalUrl(event.senderFrame?.url)) return;
  notificationTargetReceiver = event.senderFrame;
  flushNotificationTarget();
});

function proactiveNoticeArgument(argv) {
  const value = argv.find(arg => typeof arg === "string" && /^--shoggoth-open-notice=notice-[a-f0-9]{64}$/u.test(arg));
  return value ? value.slice("--shoggoth-open-notice=".length) : null;
}
let pendingProactiveNotice = proactiveNoticeArgument(process.argv);
let proactiveUiRegistry = null;
async function openProactiveNotice(id) {
  if (!proactiveUiRegistry || !id) return;
  const { notice } = await proactiveUiRegistry.proactiveCall("proactive.notice.get", { id });
  if (!notice.sessionKey) return;
  let cursor = null, profile = null;
  for (let page = 0; page < 82; page++) {
    const result = await proactiveUiRegistry.proactiveCall("proactive.agents.list", { cursor, limit: 50 });
    profile = result.agents.find(agent => agent.id === notice.profileId);
    if (profile || !result.nextCursor) break; cursor = result.nextCursor;
  }
  if (!profile) return;
  openNotificationTarget({ category: "proactive", target: { kind: "chat", backendId: profile.backendId,
    agentId: profile.agentId, sessionKey: notice.sessionKey } });
}

ipcMain.handle("openclaw:notify", (_event, opts) => {
  const o = opts && typeof opts === "object" ? opts : {};
  const category = typeof o.category === "string" ? o.category : "";
  if (!["chat", "cron", "task", "proactive"].includes(category)) return false;
  if (!Notification.isSupported()) return false;
  if (!notificationPolicy({ config: readConfig(), category, focused: mainWindow?.isFocused() === true }).allowed) return false;
  const title = typeof o.title === "string" && o.title ? o.title : "OpenClaw";
  const body = typeof o.body === "string" ? o.body : "";
  showNativeNotification(Notification, { title, body }, () => openNotificationTarget({ category, target: o.target ?? null }));
  return true;
});

// --- App lifecycle -----------------------------------------------------

// desktop-data-bootstrap acquired the canonical-root lock before any writer.
const gotLock = app.hasSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let hostStopping = false;
  let hostGeneration = 0;
  const systemIssues = createDesktopSystemIssueReporter({
    ipcMain, getMainWindow: () => mainWindow, getUiOrigin: () => {
      try { return new URL(serverOrigin).origin; } catch { return null; }
    },
  });
  desktopSystemIssues = systemIssues;
  app.on("second-instance", (_event, argv) => {
    const noticeId = proactiveNoticeArgument(argv || []);
    if (noticeId) void openProactiveNotice(noticeId).catch(() => {});
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // The shared bundle starts as an agent so Service/MCP launches never become
    // a second foreground App. Only the single-instance UI owner is promoted.
    if (process.platform === "darwin") app.setActivationPolicy("regular");
    const startupGeneration = ++hostGeneration;
    // UI role + single-instance owner only. Inspect config BEFORE ensure() so a
    // lost config alongside existing telemetry state is not mistaken for setup.
    try {
      productTelemetry = createProductTelemetry({
        statePath: path.join(app.getPath("userData"), "product-telemetry", "state.json"),
        readConfigStatus: configStore.getReadStatus,
        buildConfig: { ...productTelemetryBuildConfig, isPackaged: app.isPackaged,
          appVersion: APP_VERSION, platform: process.platform, arch: process.arch },
      });
      disposeTelemetryIpc = registerDesktopTelemetryIpc({
        ipcMain, getMainWindow: () => mainWindow, getUiOrigin: () => serverOrigin,
        powerMonitor, telemetry: productTelemetry,
      });
    } catch {
      productTelemetry?.close();
      productTelemetry = null;
    }
    ensureConfigFile();
    // Seed the applied-config snapshot so the first save diffs against reality
    // (see applyConfigChange) instead of reconnecting everything unconditionally.
    appliedConfig = configStore.read();
    try {
      nativeTheme.themeSource = configStore.read().theme || "light";
    } catch {
      /* ignore */
    }
    // Early, so the Dock shows the chosen icon right after launch.
    appIconController = createAppIconController({ app, nativeImage });
    void appIconController.apply(appliedConfig.appIcon);

    // 统一认证解析器:管理面(OpenClawBackend)与聊天面(chat broker)共用一份
    // 凭证(config.token / 本机 operator 身份 / loopback 网关 token / 已存设备令牌)。
    const shoggothServicePaths = getBootstrappedDesktopPaths(app);
    const legacyOpenClawAuth = createAuthResolver({
      getConfig: () => readConfig(),
      credentialsDir: path.join(app.getPath("userData"), "credentials"),
    });

    // Backend registry: manages all agent backends (OpenClaw, Hermes, future).
    // Created before the static server so /__api/* can query it. Backends start
    // in parallel later (a slow backend doesn't block others).
    // 组合根先创建 gate/supervisor，再创建 backend/runtime；core 模块不反向 import host。
    const workAdmissionGate = createWorkAdmissionGate();
    const openclawHostController = createOpenclawHostController();
    const hermesModelMutationGate = createHermesModelMutationGate();
    const registry = new BackendRegistry();
    proactiveUiRegistry = registry;
    let openclawBackend, managedOpenClawModelChange;
    const withdrawOpenClawEndpoint = async () => {
      openClawEndpointGeneration += 1;
      gatewayProxy?.invalidateOpenClawUpstream?.();
      await openclawBackend?.stop();
    };
    managedOpenClawProductHost = createManagedOpenClawProductHost({
      getMode: () => readConfig().openclawPluginHostMode,
      getEnabled: () => !readConfig().disabledBackends.includes("openclaw"),
      setManagedMode: () => configStore.write({ openclawPluginHostMode: "managed" }),
      createClient: () => {
        const input = resolveManagedOpenClawProductInputs({ openclawBin: resolveOpenclawBin() });
        require("./agent-service/external-host-pairing").ensureCredential(shoggothServicePaths, "openclaw");
        return require("./managed-openclaw-host-client").createManagedOpenClawHostClient({
          ...input, stateDir: shoggothServicePaths.stateDir,
          serviceUserDataRoot: shoggothServicePaths.userDataRoot,
          resourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "external-plugin-host-patches")
            : path.join(__dirname, "..", "resources", "external-plugin-host-patches"),
          adapterResourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "external-plugin-adapters")
            : path.join(__dirname, "..", "resources", "external-plugin-adapters"),
          gatewayConfiguration: { tools: { alsoAllow: [...require("../resources/external-plugin-adapters/openclaw/mcp-tools.json").tools.map(tool=>tool.name),
            "shoggoth_capability_search", "shoggoth_skill_read", "shoggoth_skill_file_read"] } },
        });
      },
      onUnavailable: async () => {
        managedOpenClawModelChange?.runtimeApply.invalidateConnectionGeneration();
        await withdrawOpenClawEndpoint();
      },
      // The transaction's own pause withdraws the ordinary Gateway socket but
      // keeps the private operation lease valid. Foreign lifecycle changes use
      // onUnavailable above and retire the Core scope as well.
      onModelUnavailable: withdrawOpenClawEndpoint,
      onOwnedExit: proof => managedOpenClawModelChange?.releaseAfterOwnedExit(proof),
      onReady: async () => { await registry.start("openclaw"); },
    });
    const authResolver = createManagedOpenClawProductAuth({ host: managedOpenClawProductHost,
      legacyResolver: legacyOpenClawAuth,
      getGatewayGeneration: () => openClawCredentialGeneration.current(),
      credentialsDir: path.join(app.getPath("userData"), "credentials", "managed-openclaw"),
      dataRoot: path.join(shoggothServicePaths.stateDir, "external-plugin-host-data", "openclaw", "v1"),
    });
    const openClawUpstreamUrl = () => managedOpenClawProductHost.isManaged()
      ? managedOpenClawProductHost.getEndpoint()?.url || "" : readConfig().gatewayUrl;
    openclawBackend = new OpenClawBackend({
      getUpstreamUrl: openClawUpstreamUrl,
      getOrigin: () => serverOrigin,
      authResolver,
      getManagedExecution: () => managedOpenClawProductHost.getExecution(),
      restartManagedHost: async () => {
        const operationId = `model-restart-${crypto.randomUUID()}`;
        managedOpenClawProductHost.restart({ operationId });
        const result = await managedOpenClawProductHost.waitForOperation(operationId);
        if (result.state !== "running") throw Object.assign(new Error("受管 OpenClaw 重启未验证"), {
          code: result.errorCode || "MANAGED_HOST_ENDPOINT_UNVERIFIED",
        });
      },
    });
    const legacyOpenClawRuntimeApply = createOpenClawRuntimeApply({
      backend: openclawBackend, admissionGate: workAdmissionGate, supervisor: openclawHostController,
    });
    const legacyOpenClawModelChange = createOpenClawModelChange({
      backend: openclawBackend, runtimeApply: legacyOpenClawRuntimeApply,
    });
    const nativeOpenClawModelChange = createOpenClawModelChange({
      backend: openclawBackend, runtimeApply: legacyOpenClawRuntimeApply, configurationMode: "native-config",
    });
    const managedOpenClawModelApi = managedOpenClawProductHost.getModelApplyApi();
    managedOpenClawCredentialBroker = createManagedOpenClawProviderCredentialBroker({
      paths: shoggothServicePaths, modelController: managedOpenClawModelApi,
    });
    managedOpenClawModelChange = createManagedOpenClawModelApply({
      backend: openclawBackend, modelController: managedOpenClawModelApi,
      admissionGate: workAdmissionGate, credentialBroker: managedOpenClawCredentialBroker,
      configurationMode: "native-config",
    });
    const selectedModelChange = () => managedOpenClawProductHost.isManaged()
      ? managedOpenClawModelChange : nativeOpenClawModelChange;
    const selectedRuntimeApply = () => managedOpenClawProductHost.isManaged()
      ? managedOpenClawModelChange.runtimeApply : legacyOpenClawRuntimeApply;
    // Route complete transactions at the trusted composition root. The managed
    // facade does not replace ordinary backend.request or config-only methods.
    openclawBackend.attachModelRuntimeApply(Object.freeze({
      inspect: (...args) => selectedRuntimeApply().inspect(...args),
      acquireForApply: (...args) => selectedRuntimeApply().acquireForApply(...args),
      recoverLease: (...args) => selectedRuntimeApply().recoverLease(...args),
      verifyTarget: (...args) => selectedRuntimeApply().verifyTarget(...args),
      convergeAfterRetire: (...args) => selectedRuntimeApply().convergeAfterRetire(...args),
      invalidateConnectionGeneration: () => {
        legacyOpenClawRuntimeApply.invalidateConnectionGeneration?.();
        // Private managed leases bind to their owned Host, not this ordinary
        // WS connection. Product lifecycle retirement invalidates them above.
      },
    }));
    openclawBackend.attachModelChangeAdapter(Object.freeze({
      configurationSemantics: "native-config",
      getCapabilities: (...args) => selectedModelChange().getCapabilities(...args),
      preview: (...args) => selectedModelChange().preview(...args),
      apply: (spec, context, secret) => !managedOpenClawProductHost.isManaged() && context.journalEntry?.mode !== "native-config"
        ? legacyOpenClawModelChange.apply(spec, context, secret) : selectedModelChange().apply(spec, context, secret),
      recover: (entry, context) => !managedOpenClawProductHost.isManaged() && entry.mode !== "native-config"
        ? legacyOpenClawModelChange.recover(entry, context) : selectedModelChange().recover(entry, context),
    }));
    let managedHermesAuth;
    const hermesBackend = new HermesBackend({
      getConfig: () => readConfig(),
      modelMutationGate: hermesModelMutationGate,
      getManagedExecution: () => managedHermesProductHost ? managedHermesProductHost.getExecution()
        : readConfig().hermesPluginHostMode === "managed" ? null : undefined,
      getManagedEndpoint: () => managedHermesAuth.resolveEndpoint(),
    });
    managedHermesProductHost = createManagedHermesProductHost({
      getMode: () => readConfig().hermesPluginHostMode,
      getEnabled: () => !readConfig().disabledBackends.includes("hermes"),
      setManagedMode: () => configStore.write({ hermesPluginHostMode: "managed" }),
      createClient: () => {
        const input = resolveManagedHermesProductInputs({ hermesBin: hermesBackend.bin });
        require("./agent-service/external-host-pairing").ensureCredential(shoggothServicePaths, "hermes");
        return require("./managed-hermes-host-client").createManagedHermesHostClient({
          ...input, stateDir: shoggothServicePaths.stateDir,
          serviceUserDataRoot: shoggothServicePaths.userDataRoot,
          resourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "external-plugin-host-patches")
            : path.join(__dirname, "..", "resources", "external-plugin-host-patches"),
          adapterResourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "external-plugin-adapters")
            : path.join(__dirname, "..", "resources", "external-plugin-adapters"),
        });
      },
      onUnavailable: async () => { await hermesBackend.stop(); },
      onReady: async () => { await registry.start("hermes"); },
    });
    managedHermesAuth = createManagedHermesProductAuth({ host: managedHermesProductHost });
    // The UI process owns only this lightweight adapter and its polling loops;
    // the background Agent Service has a separate lifecycle/role and is never
    // terminated when the registry or desktop window stops.
    const federationMcpRegistrar = createFederationMcpRegistrar({
      paths: shoggothServicePaths,
      packaged: app.isPackaged,
      executablePath: process.execPath,
      bootstrapPath: path.join(app.getAppPath(), "app", "bootstrap.js"),
      openclawBin: resolveOpenclawBin(),
      hermesBin: hermesBackend.bin,
      getOpenClawMode: () => readConfig().openclawPluginHostMode,
      getHermesMode: () => managedHermesProductHost.isManaged() ? "managed" : readConfig().hermesMode,
    });
    const externalPluginAdapterRegistrar = createExternalPluginAdapterRegistrar({
      paths: shoggothServicePaths,
      resourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "external-plugin-adapters")
        : path.join(__dirname, "..", "resources", "external-plugin-adapters"),
      packaged: app.isPackaged,
      openclawBin: resolveOpenclawBin(),
      hermesBin: hermesBackend.bin,
      reconcileHermesAdapter: options => hermesBackend.reconcileSharedCapabilityAdapter(options),
      getOpenClawMode: () => readConfig().openclawPluginHostMode,
      getHermesMode: () => managedHermesProductHost.isManaged() ? "managed" : readConfig().hermesMode,
    });
    // Authentication and CLI commands are keyed by RuntimeAccount, never by
    // Agent/Profile. Native accounts point at the user's existing CLI Home;
    // resolving this catalog performs no import, copy, pnpm install, or mkdir.
    const getRuntimeCliAuth = () => createRuntimeCliAuth({
      paths: shoggothServicePaths,
      parentEnv: process.env,
      homedir: os.homedir,
      repoRoot: path.join(__dirname, ".."),
      executablePath: process.execPath,
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    const memoryCommandConfigController = require("./core/native-memory-config-controller")
      .createNativeMemoryConfigController({ configStore, registry });
    const shoggothBackend = new ShoggothBackend({
      paths: shoggothServicePaths,
      runtimeCliAuth: getRuntimeCliAuth(),
      getRuntimeCliAuth,
      getNativeRuntimeConfig: () => require("./core/config-store").projectNativeRuntimeConfig(configStore.read()),
      getNativeChatUiConfig: () => require("./core/config-store").projectNativeChatUiConfig(configStore.read()),
      getNativeMemoryConfig: () => require("./core/config-store").projectNativeMemoryConfig(configStore.read()),
      getNativeMemorySharingConfig: () => require("./core/config-store").projectNativeMemorySharingConfig(configStore.read()),
      updateNativeMemoryConfig: input => memoryCommandConfigController.update(input),
      getLocale: () => resolveLocale(readConfig().locale),
      id: "shoggoth",
      name: "Shoggoth",
      connectionMode: "builtin-service",
      version: APP_VERSION,
    });
    const nativeBackends = [shoggothBackend];
    const shoggothLaunchAgent = createLaunchAgentController({
      homeDir: os.userInfo().homedir,
      servicePaths: shoggothServicePaths,
      serviceVersion: APP_VERSION,
      runtimePath: process.env.PATH,
    });
    const hostCanReload = () => !hostStopping && startupGeneration === hostGeneration;
    const reloadNativeBackends = async (stillCurrent = () => true) => {
      const canReload = () => hostCanReload() && stillCurrent();
      // Service 或默认模型恢复后必须丢弃适配器旧快照；否则设置页已经健康，
      // 聊天、Dashboard 与 Kanban 仍可能继续显示启动时缓存的未就绪状态。
      if (!canReload()) return;
      await Promise.all(nativeBackends.map((backend) => backend.stop()));
      if (!canReload()) return;
      await registry.start(shoggothBackend.id);
    };
    const shoggothServiceRequest = async (method, params) => {
      let token;
      try {
        token = readClientToken(shoggothServicePaths);
        return await requestService(shoggothServicePaths, {
          id: crypto.randomUUID(),
          token,
          version: PROTOCOL_VERSION,
          method,
          params,
        });
      } finally {
        token = null;
      }
    };
    const shoggothProductHost = createProductHostController({
      launchAgent: shoggothLaunchAgent,
      onProfileConfigured: () => reloadNativeBackends(),
      onBackgroundReady: (_status, stillCurrent) => reloadNativeBackends(stillCurrent),
      serviceRequest: shoggothServiceRequest,
    });
    const reportBackgroundStartupFailure = () => {
      console.error("[shoggoth] background service auto-start unavailable");
      return null;
    };
    // 后台修复最长可等待代码身份校验完成，但不能因此推迟本地页面和窗口出现。
    const backgroundStartup = app.isPackaged
      ? shoggothProductHost.ensureBackgroundRunning().catch(reportBackgroundStartupFailure)
      : Promise.resolve(null);
    registerDesktopComputerIpc({
      ipcMain,
      getMainWindow: () => mainWindow,
      serviceRequest: shoggothServiceRequest,
      restartService: createDesktopComputerServiceRestart({
        launchAgent: shoggothLaunchAgent,
        serviceRequest: shoggothServiceRequest,
        backgroundStartup,
        suspendBackgroundActions: () => shoggothProductHost.suspendBackgroundActions(),
        onRestarted: () => reloadNativeBackends(),
      }),
      openSettings: (kind) => shell.openExternal(kind === "accessibility"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
    });
    registerDesktopBrowserIpc({ ipcMain, getMainWindow: () => mainWindow, serviceRequest: shoggothServiceRequest });
    const hermesModelChange = createHermesModelChange({
      backend: hermesBackend,
      mutationGate: hermesModelMutationGate,
    });
    hermesBackend.attachModelChangeAdapter(hermesModelChange);
    registry.register(openclawBackend);
    registry.register(hermesBackend);
    registry.register(shoggothBackend);
    registry.setInspirationOwner(shoggothBackend);
    registry.setChatSecretOwner(shoggothBackend);
    // 设置页「断开连接」的后端：registry 聚合/路由/健康采样全部跳过（实时读
    // config，与 getUpstreamUrl 同款拉模型），startup 也不启动它们。
    registry.setDisabledBackendsProvider(() => readConfig().disabledBackends);
    appBackendRegistry = registry;
    try {
      groupSendJournalStore = new DesktopGroupSendJournalStore({ userDataRoot: app.getPath("userData") });
      groupSendJournalOpening = groupSendJournalStore.open();
      void groupSendJournalOpening.catch(() => console.warn("[Group journal] send recovery unavailable"));
    } catch {
      groupSendJournalOpening = null;
      console.warn("[Group journal] send recovery unavailable");
    }
    // Dashboard journal（健康事件 + kanban cursor 留存）：路径由入口注入
    //（core 不碰 electron）；写失败/损坏都在 journal 内降级，不阻断启动。
    registry.attachDashboardJournal(
      createDashboardJournal(path.join(app.getPath("userData"), "dashboard-journal.json")),
    );
    registry.attachKanbanProjectStore(
      createKanbanProjectStore(path.join(app.getPath("userData"), "kanban-projects.json")),
    );
    // 模型变更使用独立、不可降级的持久 journal；coordinator 在恢复完成前保持未 ready。
    const modelChangeCoordinator = new ModelChangeCoordinator({
      registry,
      journal: createModelChangeJournal(path.join(app.getPath("userData"), "model-change-journal.json")),
      workAdmissionGate,
    });
    // Safety identities are Main-owned and independent of the loopback port.
    // Failure locks managed model mutations in the UI; it never becomes empty.
    try {
      modelOperationRecoveryStore = new ModelOperationRecoveryStore({
        userDataRoot: app.getPath("userData"), coordinator: modelChangeCoordinator,
      });
      modelOperationRecoveryOpening = modelOperationRecoveryStore.open();
      void modelOperationRecoveryOpening.catch(() => console.warn("[Model recovery] identity store unavailable"));
    } catch {
      modelOperationRecoveryOpening = null;
      console.warn("[Model recovery] identity store unavailable");
    }


    // Always start the static server (serves the React UI + /__api, /avatar,
    // and the /__chatws chat broker). chatUpstreamUrl wires the native React
    // chat's /__chatws broker to the federating proxy (started just below); the
    // broker connects lazily per browser session, so the proxy is listening by
    // the time chat opens.
    staticServer = await startStaticServer(UI_PORT, {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataRoot: app.getPath("userData"),
      registry,
      chatUpstreamUrl: `ws://127.0.0.1:${GATEWAY_PROXY_PORT}`,
      configStore,
      hostOps,
      productHost: shoggothProductHost,
      chatReadStateStore,
      managedOpenClawHost: managedOpenClawProductHost,
      managedHermesHost: managedHermesProductHost,
      onConfigChanged: applyConfigChange,
      onSystemIssue: (error, fallbackCode) => systemIssues.report(error, fallbackCode),
      authResolver,
      modelChangeCoordinator,
      workAdmissionGate,
    });

    if (process.env.UI_DEV_URL) {
      serverOrigin = process.env.UI_DEV_URL;
      console.log("[Dev] Using external UI dev server");
    } else {
      if (!fs.existsSync(path.join(MANAGE_UI_DIR, "index.html"))) {
        const locale = resolveLocale(readConfig().locale);
        dialog.showErrorBox(
          nativeT(locale, "controlUi.missing.title"),
          nativeT(locale, "controlUi.missing.body", { path: MANAGE_UI_DIR }),
        );
        app.quit();
        return;
      }
      serverOrigin = staticServer.url;
    }

    // Board HTML is never served from the management origin. The independent
    // host is optional at app level: failure keeps chat/Board metadata usable,
    // while individual HTML cards fail closed with a retry state.
    try {
      boardWidgetHost = createBoardWidgetHost({ uiOrigin: new URL(serverOrigin).origin });
      await boardWidgetHost.start();
    } catch {
      boardWidgetHost = null;
      console.error("[board-widget] safe host unavailable");
    }

    // Federating proxy sits between the UI and the real gateway. Started after
    // serverOrigin is known so the upstream connection can mirror the page Origin
    // (some gateways enforce an Origin allowlist). The proxy is a security
    // boundary for foreign namespaces, so bind failure must abort UI startup;
    // a direct gateway fallback would bypass its auth and orphan guards.
    try {
      gatewayProxy = await startProxyGateway({
        port: GATEWAY_PROXY_PORT,
        getUpstreamGeneration: () => openClawCredentialGeneration.current(),
        // OpenClaw 断开时上游 URL 视作未配置：proxy 现有的降级路径（本地握手 +
        // 外籍 list 合成）就是「只剩 Hermes」的正确形态，重连开关翻回即恢复透传。
        getUpstreamUrl: () => {
          const cfg = readConfig();
          return cfg.disabledBackends.includes("openclaw") ? "" : openClawUpstreamUrl();
        },
        origin: serverOrigin,
        registry,
        workAdmissionGate,
      });
      gatewayProxyUrl = gatewayProxy.url;
    } catch {
      console.error("[proxy] failed to start; aborting UI startup");
      const locale = resolveLocale(readConfig().locale);
      dialog.showErrorBox(
        nativeT(locale, "proxy.failed.title"),
        nativeT(locale, "proxy.failed.body"),
      );
      app.quit();
      return;
    }

    // Shoggoth 后台 Service 只通过这个私有、类型化 UDS 访问桌面进程持有的
    // OpenClaw/Hermes registry；绝不回连无鉴权的 loopback /__api。
    try {
      federationHost = createFederationHostServer({
        appleDeviceHost: require("./apple-device-host").createAppleDeviceHost({
          native: require("./apple-device-native").createAppleDeviceNative({
            addonPath: app.isPackaged ? path.join(process.resourcesPath, "apple-device", "apple-device.node")
              : path.join(__dirname, "../.vendor/apple-device/apple-device.node"),
          }),
          openExternal: url => shell.openExternal(url),
        }),
    mcpConnectionOrigin: staticServer.url,
        paths: shoggothServicePaths,
        registry,
        verifyChatUiClick: value => desktopChatUiIpc.verifyClick(value),
        getNotificationContext: () => ({ focused: mainWindow?.isFocused() === true }),
        inspirationRunner: new ExternalInspirationRunner({ registry, origin: staticServer.url }),
        // 群聊外部成员：同一外部执行合同的并列实例，OpenClaw 会话按群用途命名。
        groupRunner: new (require("./group-runtime-router").GroupRuntimeRouter)({ registry, paths: shoggothServicePaths,
          localRunner: new ExternalInspirationRunner({ registry, origin: staticServer.url, adapterOptions: { sessionPurpose: "group" } }),
          // 用户 2026-10-12 明确跳过远程；本轮仅启用经过本机证明的宿主。
          allowRemote: false,
          invokeTool: params => shoggothServiceRequest("group.remote.tool", params),
          readTerminalReceipt: params => shoggothServiceRequest("group.execution.receipt", params),
          isLocal: ({ backendId, agentId }) => {
            const backend = registry.getBackend(backendId);
            if (backendId === "hermes") {
              if (backend._localRuntime.isManaged()) return true;
              const profile = backend.profileById.get(agentId), dash = backend.dashboards.get(profile);
              return !!dash && backend._getConfig().hermesMode !== "remote" && require("./group-local-runtime-proof").verifyLocalGroupRuntime({ backendId, url: dash.baseUrl });
            }
            if (backend?._localRuntimeScope.isManaged()) return true;
            return require("./group-local-runtime-proof").verifyLocalGroupRuntime({ backendId, url: openClawUpstreamUrl() });
          } }),
        groupToolCapability: ({ backendId, agentId }) => backendId === "openclaw"
          ? federationMcpRegistration?.openclaw === true
          : (federationMcpRegistration?.hermes || []).some((profile) => agentIdForProfile(profile) === agentId),
        taskRunner: createFederatedAgentTaskRunner({ origin: staticServer.url }),
        delegateRun: ({ agentId, prompt, timeoutMs, signal }) => runFederatedAgentViaBroker({
          origin: staticServer.url,
          agentId,
          prompt,
          timeoutMs,
          signal,
        }),
      });
      await federationHost.start();
    } catch {
      federationHost = null;
      console.error("[federation] private App host unavailable");
    }

    // 后台预热 backend，但必须在 proxy 监听 backend.ready 之后再启动。
    // static server 已先提供只读页面；只有 backend ready + journal 全量恢复成功后
    // 才开放模型 mutation。恢复失败仅保持未 ready，不关闭 UI 或伪装成功。
    if (managedOpenClawProductHost.isManaged() && !readConfig().disabledBackends.includes("openclaw")) {
      managedOpenClawProductHost.prepare({ operationId: `desktop-start-${crypto.randomUUID()}` });
    }
    if (managedHermesProductHost.isManaged() && !readConfig().disabledBackends.includes("hermes")) {
      managedHermesProductHost.prepare({ operationId: `desktop-start-${crypto.randomUUID()}` });
    }
    registry.start()
      .then(async () => {
        await modelChangeCoordinator.recoverPending();
        modelChangeCoordinator.markReady();
      })
      .catch(() => console.error("[registry] model change startup incomplete"))
      // 健康采样在后端预热/恢复尝试后开跑；registry.stop() 时清理定时器。
      .finally(() => {
        registry.startDashboardHealthSampler();
        void (async () => {
          try { federationMcpRegistration = await federationMcpRegistrar.reconcile(); }
          catch { console.error("[federation] silent MCP registration incomplete"); }
          try {
            const adapters = await externalPluginAdapterRegistrar.reconcile();
            if (Object.keys(adapters.errors || {}).length) {
              console.error("[federation] shared plugin adapter registration incomplete");
            }
          } catch { console.error("[federation] shared plugin adapter registration incomplete"); }
        })();
      });

    buildMenu();
    desktopInspiration = createDesktopInspirationController({ BrowserWindow, Tray, Menu, nativeImage, globalShortcut, screen, ipcMain,
      configStore, getMainWindow: () => mainWindow, showMainWindow, getUiOrigin: () => serverOrigin,
      stopBackend: createDesktopBackendStopAction({ dialog, productHost: shoggothProductHost,
        getLocale: () => resolveLocale(readConfig().locale) }),
      getLocale: () => resolveLocale(readConfig().locale), quit: () => app.quit() });
    disposeMicrophoneIpc = registerDesktopMicrophoneIpc({ ipcMain, session: session.defaultSession, systemPreferences,
      getWindows: () => [mainWindow, desktopInspiration?.getWindow()], getUiOrigin: () => serverOrigin });
    if (process.platform === "darwin") disposeTypewriterSoundIpc = registerDesktopTypewriterSoundIpc({ ipcMain,
      getWindows: () => [mainWindow, desktopInspiration?.getWindow()], getUiOrigin: () => serverOrigin,
      audioPath: app.isPackaged
        ? path.join(process.resourcesPath, "app.asar.unpacked", "app", "manage-ui", "public", "audio", "typewriter-loop.wav")
        : path.join(__dirname, "manage-ui", "public", "audio", "typewriter-loop.wav") });
    disposeChatClipboardIpc = registerDesktopChatClipboardIpc({ ipcMain, clipboard,
      getWindows: () => [mainWindow], getUiOrigin: () => serverOrigin });
    const appInstallPreparation = createDesktopAppInstallPreparation({
      launchAgent: shoggothLaunchAgent,
      serviceRequest: shoggothServiceRequest,
      backgroundStartup,
      suspendBackgroundActions: () => shoggothProductHost.suspendBackgroundActions(),
    });
    appUpdateController = createDesktopAppUpdateController({
      app,
      ipcMain,
      getMainWindow: () => mainWindow,
      automaticUpdates: readConfig().autoAppUpdates,
      saveAutomaticUpdates: (enabled) => configStore.write({ autoAppUpdates: enabled }),
      onDownloaded: showUpdateReadyNotification,
      ...appInstallPreparation,
    });
    createMainWindow();
    void backgroundStartup.then((status) => {
      if (!hostCanReload()) return;
      const stillCurrent = () => shoggothProductHost.isBackgroundStartupCurrent(status);
      if (!stillCurrent()) return;
      if (status?.supported === true
        && status.loaded === true
        && status.enabled === true
        && status.needsRepair === false) return reloadNativeBackends(stillCurrent);
    }).catch(reportBackgroundStartupFailure);
    // First-run onboarding is the SPA's SetupOverlay (auto-detects backends,
    // shows only while config.setupCompletedAt===0 && token===""), not a native
    // prompt — the old dialog re-opened on every launch for token-less users.

    app.on("activate", () => {
      if (!desktopInspiration?.isPresenting() && !desktopInspiration?.getWindow()?.isFocused()) showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  const managedQuitGate = installManagedPluginHostQuitGate({ app, getHosts: () => [managedOpenClawProductHost, managedHermesProductHost],
    onFailure: () => {
      showMainWindow();
      dialog.showErrorBox("Shoggoth", "暂时无法确认插件后台已停止。请稍后重试退出；原任务不会重复启动。");
    },
  });
  app.on("before-quit", async (event) => {
    if ([managedOpenClawProductHost, managedHermesProductHost].some(host => host?.isManaged()) && !managedQuitGate.complete()) return;
    if (appUpdateController?.handleBeforeQuit(event)) return;
    appIsQuitting = true;
    groupSendJournalIpc.dispose();
    const sendJournalStore = groupSendJournalStore;
    groupSendJournalStore = null; groupSendJournalOpening = null;
    if (sendJournalStore) await sendJournalStore.close().catch(() => {});
    modelOperationRecoveryIpc.dispose();
    const recoveryStore = modelOperationRecoveryStore;
    modelOperationRecoveryStore = null;
    modelOperationRecoveryOpening = null;
    if (recoveryStore) await recoveryStore.close().catch(() => {});
    managedOpenClawCredentialBroker?.retire();
    managedOpenClawCredentialBroker = null;
    await desktopChatUiIpc.close();
    desktopInspiration?.dispose(); desktopInspiration = null;
    disposeMicrophoneIpc?.(); disposeMicrophoneIpc = null;
    disposeTypewriterSoundIpc?.(); disposeTypewriterSoundIpc = null;
    disposeChatClipboardIpc?.(); disposeChatClipboardIpc = null;
    appUpdateController?.dispose(); appUpdateController = null;
    disposeTelemetryIpc?.();
    productTelemetry?.close();
    systemIssues.dispose();
    desktopSystemIssues = null;
    hostStopping = true;
    hostGeneration += 1;
    await desktopBoardWidgetIpc.dispose().catch(() => {});
    if (boardWidgetHost) {
      await boardWidgetHost.close().catch(() => {});
      boardWidgetHost = null;
    }
    if (federationHost) {
      await federationHost.stop().catch(() => {});
      federationHost = null;
    }
    if (appBackendRegistry) {
      // 正常退出是唯一传 keepProcesses 的路径：开了 hermesKeepAlive 就把 spawn 的
      // dashboard 留给下次启动认领复用（冷启动最贵的一段）。断开连接 / 自更新 /
      // 模式切换都不传——那三处的语义就是"真的要停掉"。
      const keepProcesses = readConfig().hermesKeepAlive === true;
      await appBackendRegistry.stop({ keepProcesses }).catch(() => {});
      appBackendRegistry = null;
    }
    if (gatewayProxy) {
      await gatewayProxy.close().catch(() => {});
      gatewayProxy = null;
    }
    if (staticServer) {
      await staticServer.close().catch(() => {});
      staticServer = null;
    }
  });
}
