"use strict";

const CHANNELS = Object.freeze({
  modelProvider: "shoggoth:secret:reveal-model-provider",
  env: "shoggoth:secret:reveal-env",
});
const BACKEND_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PROVIDER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u;
const MODEL_REASONS = new Set(["none", "env", "managed", "remote"]);
const MAX_SECRET_BYTES = 1024 * 1024;

function ownDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && descriptor.value !== undefined;
  });
}

function data(value, key) {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function safeText(value, maxBytes, nullable = false) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function trustedRenderer(event, getMainWindow) {
  let window;
  try { window = getMainWindow(); } catch { return false; }
  if (!window || window.isDestroyed?.() === true || !window.webContents
    || window.webContents.isDestroyed?.() === true) return false;
  if (event?.sender !== window.webContents) return false;
  // 只接受主 frame；同一窗口中被植入的子 frame 也不能读取明文凭据。
  return Boolean(event.senderFrame && event.senderFrame === window.webContents.mainFrame);
}

function resolveBackend(raw, getRegistry) {
  const backendId = data(raw, "backend");
  if (!BACKEND_ID.test(backendId)) return { error: "invalid" };
  let registry;
  try { registry = getRegistry(); } catch { return { error: "unavailable" }; }
  const backend = registry?.backends instanceof Map ? registry.backends.get(backendId) : null;
  return backend ? { backend } : { error: "unavailable" };
}

function projectModelSecret(value) {
  if (!ownDataObject(value)) throw new TypeError("invalid model secret response");
  const apiKey = data(value, "apiKey");
  const baseUrl = data(value, "baseUrl");
  const reason = data(value, "reason");
  const envVar = data(value, "envVar");
  if (!safeText(apiKey, MAX_SECRET_BYTES, true)
    || (baseUrl !== undefined && !safeText(baseUrl, 4096))
    || (reason !== undefined && !MODEL_REASONS.has(reason))
    || (envVar !== undefined && !ENV_KEY.test(envVar))) {
    throw new TypeError("invalid model secret response");
  }
  return {
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(envVar !== undefined ? { envVar } : {}),
  };
}

function projectEnvSecret(value) {
  if (!ownDataObject(value)) throw new TypeError("invalid env secret response");
  const secret = data(value, "value");
  if (!safeText(secret, MAX_SECRET_BYTES)) throw new TypeError("invalid env secret response");
  return { value: secret };
}

function registerDesktopSecretIpc(options = {}) {
  const { ipcMain, getMainWindow, getRegistry } = options;
  if (!ipcMain || typeof ipcMain.handle !== "function"
    || typeof ipcMain.removeHandler !== "function"
    || typeof getMainWindow !== "function" || typeof getRegistry !== "function") {
    throw new TypeError("registerDesktopSecretIpc 需要 IPC 与宿主依赖");
  }

  const authorize = (event) => trustedRenderer(event, getMainWindow)
    ? null
    : failure("PRIVILEGED_RENDERER_REQUIRED", "仅桌面应用可读取凭据");

  ipcMain.handle(CHANNELS.modelProvider, async (event, raw) => {
    const denied = authorize(event);
    if (denied) return denied;
    if (!ownDataObject(raw) || Object.keys(raw).length !== 2
      || !PROVIDER_KEY.test(data(raw, "providerKey"))) {
      return failure("INVALID_SECRET_REQUEST", "凭据请求参数无效");
    }
    const resolved = resolveBackend(raw, getRegistry);
    if (resolved.error === "invalid") {
      return failure("INVALID_SECRET_REQUEST", "凭据请求参数无效");
    }
    if (!resolved.backend || typeof resolved.backend.revealModelProviderKey !== "function") {
      return failure("SECRET_BACKEND_UNAVAILABLE", "目标后端不可用");
    }
    try {
      const value = await resolved.backend.revealModelProviderKey(data(raw, "providerKey"));
      return { ok: true, value: projectModelSecret(value) };
    } catch {
      return failure("SECRET_REVEAL_FAILED", "无法读取凭据");
    }
  });

  ipcMain.handle(CHANNELS.env, async (event, raw) => {
    const denied = authorize(event);
    if (denied) return denied;
    if (!ownDataObject(raw) || Object.keys(raw).length !== 2 || !ENV_KEY.test(data(raw, "key"))) {
      return failure("INVALID_SECRET_REQUEST", "凭据请求参数无效");
    }
    const resolved = resolveBackend(raw, getRegistry);
    if (resolved.error === "invalid") {
      return failure("INVALID_SECRET_REQUEST", "凭据请求参数无效");
    }
    if (!resolved.backend || typeof resolved.backend.revealEnvVar !== "function") {
      return failure("SECRET_BACKEND_UNAVAILABLE", "目标后端不可用");
    }
    try {
      const value = await resolved.backend.revealEnvVar(data(raw, "key"));
      return { ok: true, value: projectEnvSecret(value) };
    } catch {
      return failure("SECRET_REVEAL_FAILED", "无法读取凭据");
    }
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeHandler(CHANNELS.modelProvider);
    ipcMain.removeHandler(CHANNELS.env);
  };
}

module.exports = {
  CHANNELS,
  registerDesktopSecretIpc,
};
