"use strict";

// Preload for the official Control UI page. Runs before the bundle's own
// scripts, so anything written to localStorage/sessionStorage here is visible
// to the UI's loadSettings(). We do NOT modify any UI source.
//
// Why this exists:
//  - The UI derives its DEFAULT gateway URL from window.location. Inside this
//    desktop app the page is served by our loopback static server, so that
//    default would wrongly point at our own server. On first run we seed the
//    user's configured gateway URL into the UI's persisted-settings key.
//  - The gateway TOKEN is stored by the UI in sessionStorage *by design*
//    ("auth is intentionally in-memory only"), so it is lost on every app
//    quit. For a desktop app we re-seed it from userData on every load so the
//    connection survives restarts.
//  - The UI ships an i18n module that reads localStorage["openclaw.i18n.locale"]
//    on boot. We seed that key from our config.locale so the desktop language
//    switch (Gateway settings dialog / menu) drives the official UI's strings,
//    our skin scripts, and the Electron menus from a single source.

const { contextBridge, ipcRenderer } = require("electron");

const SETTINGS_LEGACY_KEY = "openclaw.control.settings.v1";
const SETTINGS_KEY_PREFIX = "openclaw.control.settings.v1:";
const TOKEN_KEY_PREFIX = "openclaw.control.token.v1:";
const I18N_LOCALE_KEY = "openclaw.i18n.locale";

/** Mirror of storage.ts normalizeGatewayTokenScope (pinned upstream). */
function normalizeGatewayTokenScope(gatewayUrl) {
  const trimmed = (gatewayUrl || "").trim();
  if (!trimmed) {
    return "default";
  }
  try {
    const base = `${location.protocol}//${location.host}${location.pathname || "/"}`;
    const parsed = new URL(trimmed, base);
    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "") || parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return trimmed;
  }
}

function applyConfig(config) {
  const gatewayUrl = (config && config.gatewayUrl ? String(config.gatewayUrl) : "").trim();
  const proxyUrl = (config && config.proxyUrl ? String(config.proxyUrl) : "").trim();
  // The UI always talks to the local federating proxy, which relays to the real
  // gateway (gatewayUrl) and injects foreign agents. Fall back to the direct
  // gateway only if the proxy URL is somehow missing.
  const gatewayForUi = proxyUrl || gatewayUrl;
  const token = config && config.token ? String(config.token) : "";
  // effectiveLocale comes from main and already collapsed "" → system fallback.
  const effectiveLocale =
    config && typeof config.effectiveLocale === "string" ? config.effectiveLocale : "";
  const storedLocale = config && typeof config.locale === "string" ? config.locale : "";

  // Seed the i18n locale BEFORE the official UI bundle reads it. We always
  // overwrite with our resolved value: if the user picks "follow system" we
  // remove the key so the UI's own detector (navigator.language) runs; if
  // they explicitly chose zh-CN/en we pin that.
  try {
    if (storedLocale === "" || !effectiveLocale) {
      // Follow-system mode: clear so official UI re-detects via navigator.
      // (Removing also signals our skin i18n.js to fall back to navigator.)
      localStorage.removeItem(I18N_LOCALE_KEY);
    } else {
      localStorage.setItem(I18N_LOCALE_KEY, effectiveLocale);
    }
  } catch {
    /* best-effort */
  }

  if (gatewayForUi) {
    // Point the UI at the proxy, overwriting any previously-stored gateway so
    // existing installs move onto it. Merge with existing settings so theme /
    // layout prefs survive. loadSettings() reads the "default"/legacy keys here
    // because the page-derived scoped key is never written in this desktop app.
    try {
      const existingRaw =
        localStorage.getItem(SETTINGS_KEY_PREFIX + "default") ??
        localStorage.getItem(SETTINGS_LEGACY_KEY);
      const base = existingRaw ? JSON.parse(existingRaw) : {};
      base.gatewayUrl = gatewayForUi;
      const payload = JSON.stringify(base);
      localStorage.setItem(SETTINGS_LEGACY_KEY, payload);
      localStorage.setItem(SETTINGS_KEY_PREFIX + "default", payload);
    } catch {
      /* best-effort */
    }
    // Re-seed token every launch (sessionStorage is cleared on quit), scoped to
    // the proxy URL the UI now connects to. The token still reaches the real
    // gateway via the proxy's transparent handshake passthrough.
    if (token) {
      try {
        const key = `${TOKEN_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayForUi)}`;
        sessionStorage.setItem(key, token);
      } catch {
        /* best-effort */
      }
    }
  }
}

let currentConfig = { gatewayUrl: "", token: "", locale: "", effectiveLocale: "" };
try {
  currentConfig = ipcRenderer.sendSync("openclaw:get-config") || currentConfig;
} catch {
  /* main not ready — non-fatal */
}
applyConfig(currentConfig);

if (process.platform === "darwin") {
  const markMacTitleBar = () => {
    document.documentElement.classList.add("electron-macos-hidden-inset");
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", markMacTitleBar, { once: true });
  } else {
    markMacTitleBar();
  }
}

contextBridge.exposeInMainWorld("openclawDesktop", {
  readClipboardFiles: () => ipcRenderer.invoke("shoggoth:chat:clipboard-files"),
  requestMicrophoneAccess: () => ipcRenderer.invoke("shoggoth:microphone:request"),
  getMicrophoneAccessStatus: () => ipcRenderer.invoke("shoggoth:microphone:status"),
  ...(process.platform === "darwin" ? { typewriterSound: {
    start: () => ipcRenderer.send("shoggoth:typewriter-sound:start"),
    stop: () => ipcRenderer.send("shoggoth:typewriter-sound:stop"),
  } } : {}),
  desktopInspiration: {
    getPreferences: () => ipcRenderer.invoke("shoggoth:desktop-inspiration:preferences"),
    captureShortcut: value => ipcRenderer.invoke("shoggoth:desktop-inspiration:capture-shortcut", value),
    setShortcut: value => ipcRenderer.invoke("shoggoth:desktop-inspiration:set-shortcut", value),
  },
  saveInspirationArchive: input => ipcRenderer.invoke("shoggoth:inspiration:save-archive", input),
  getConfig: () => ({ ...currentConfig }),
  // Empty activity signal only. Main owns identity, timestamp, health/release
  // gates and collection; detailed statistics are not implemented in phase A.
  productTelemetry: {
    recordActivity: () => ipcRenderer.send("shoggoth:telemetry:activity"),
  },
  appUpdate: {
    getState: () => ipcRenderer.invoke("shoggoth:app-update:get-state"),
    check: () => ipcRenderer.invoke("shoggoth:app-update:check"),
    install: () => ipcRenderer.invoke("shoggoth:app-update:install"),
    onState: (cb) => {
      const handler = (_event, state) => {
        try { cb(state); } catch { /* best-effort */ }
      };
      ipcRenderer.on("shoggoth:app-update:state", handler);
      return () => ipcRenderer.removeListener("shoggoth:app-update:state", handler);
    },
  },
  // Convenience accessor used by the skin layer's i18n bootstrap.
  getLocale: () => currentConfig.effectiveLocale || currentConfig.locale || "",
  scanCliTools: () => ipcRenderer.invoke("openclaw:scan-cli-tools"),
  resolveCliVersion: (cliPath) => ipcRenderer.invoke("openclaw:resolve-cli-version", cliPath),
  // Secret reveal is intentionally unavailable on the loopback HTTP management plane.
  // Only this isolated preload can ask main, which additionally pins the caller to the
  // current BrowserWindow and its main frame.
  revealModelProviderKey: (backend, providerKey) => ipcRenderer.invoke(
    "shoggoth:secret:reveal-model-provider", { backend, providerKey },
  ),
  revealEnvVar: (backend, key) => ipcRenderer.invoke(
    "shoggoth:secret:reveal-env", { backend, key },
  ),
  // Persistent Board HTML never crosses the management HTTP plane. Main first
  // revalidates the exact widget, then returns a short-lived second-origin URL.
  mintSessionBoardHtmlWidget: (backend, agentId, sessionKey, spec) => ipcRenderer.invoke(
    "shoggoth:board-widget:mint", { backend, agentId, sessionKey, spec },
  ),
  readySessionBoardHtmlWidget: (ticketId, nonce) => ipcRenderer.invoke(
    "shoggoth:board-widget:ready", { ticketId, nonce },
  ),
  revokeSessionBoardHtmlWidget: (ticketId) => ipcRenderer.invoke(
    "shoggoth:board-widget:revoke", { ticketId },
  ),
  getComputerPermissions: () => ipcRenderer.invoke("shoggoth:computer:permissions-status"),
  requestComputerPermissions: () => ipcRenderer.invoke("shoggoth:computer:permissions-request"),
  openComputerScreenRecordingSettings: () => ipcRenderer.invoke(
    "shoggoth:computer:open-screen-recording-settings",
  ),
  // Desktop notifications: the renderer-side Notifier hands a {category,title,body,target}
  // to the main process, which gates on config + window focus and fires a native
  // macOS Notification. onOpenTarget delivers the click-through back to the renderer.
  notify: (opts) => ipcRenderer.invoke("openclaw:notify", opts),
  onOpenTarget: (cb) => {
    const handler = (_e, payload) => {
      try { cb(payload); } catch { /* best-effort */ }
    };
    ipcRenderer.on("openclaw:open-target", handler);
    return () => ipcRenderer.removeListener("openclaw:open-target", handler);
  },
  // Menu「设置连接…」routes here so connection settings open the SPA's 设置 page
  // (the native gateway-config dialog is retired). Payload is an in-app path.
  onNavigate: (cb) => {
    const handler = (_e, path) => {
      try { cb(path); } catch { /* best-effort */ }
    };
    ipcRenderer.on("openclaw:navigate", handler);
    return () => ipcRenderer.removeListener("openclaw:navigate", handler);
  },
});
