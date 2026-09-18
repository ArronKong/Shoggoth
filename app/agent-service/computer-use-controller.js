"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u;
const MAX_SESSIONS = 2;
const MAX_SESSION_SECONDS = 900;
const MIN_SESSION_SECONDS = 60;
const MAX_ELEMENTS = 300;
const MAX_TREE_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 36 * 1024;
const TAKEOVER_TOLERANCE_SECONDS = 2;
const ALLOWED_CUA_TOOLS = Object.freeze([
  "start_session", "end_session", "list_apps", "list_windows", "get_window_state",
  "bring_to_front", "click", "double_click", "drag", "type_text", "press_key",
  "hotkey", "scroll",
]);
const SAFE_KEYS = new Set([
  "return", "tab", "escape", "backspace", "delete", "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown", "space", "f1", "f2", "f3", "f4", "f5",
  "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
const SAFE_MODIFIERS = new Set(["cmd", "shift", "option", "alt", "ctrl", "fn"]);

function computerError(code, message = "Computer Use 暂时不可用") {
  return serviceError(code, message);
}

function removePrivateTree(target) {
  const stat = lstatIfExists(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) { fs.unlinkSync(target); return; }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) removePrivateTree(path.join(target, name));
    fs.rmdirSync(target);
    return;
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    throw computerError("COMPUTER_UNSAFE_PATH", "Computer 目录包含特殊文件或 hardlink");
  }
  fs.unlinkSync(target);
}

function sha256File(target) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function validateDriverBinary(binaryPath, manifest) {
  const stat = lstatIfExists(binaryPath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (stat.mode & 0o111) === 0 || !manifest || manifest.version !== "0.22.0"
    || manifest.contractVersion !== "0.7.0"
    || !Number.isSafeInteger(manifest.binarySizeBytes) || stat.size !== manifest.binarySizeBytes
    || !/^[a-f0-9]{64}$/u.test(manifest.binarySha256)
    || sha256File(binaryPath) !== manifest.binarySha256) {
    throw computerError("COMPUTER_DRIVER_INVALID", "Computer Use Driver 完整性校验失败");
  }
}

function makeCapabilityManifest(allowedApplications, expiresInSeconds) {
  return {
    version: 3,
    expires_after: `${expiresInSeconds}s`,
    idle_timeout: `${Math.min(expiresInSeconds, 120)}s`,
    allow: { tools: [...ALLOWED_CUA_TOOLS] },
    resources: {
      apps: allowedApplications.map((bundleId) => ({
        bundle_id: bundleId,
        launch: false,
        windows: "all",
      })),
      // Cua 0.22 将 list_apps/list_windows 归类为 desktop display observation。
      // Worker 需要该资源位才能发现 PID/Window；Shoggoth 不开放 get_desktop_state，
      // 且在返回模型前再次按 bundle ID 过滤，所有输入仍固定携带 app pid/window。
      desktop: { display: true },
    },
  };
}

function boundedString(value, maxBytes) {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = value;
  while (output.length > 0 && Buffer.byteLength(output, "utf8") > maxBytes) {
    output = output.slice(0, Math.floor(output.length * 0.9));
  }
  return output;
}

function parseStructured(result, code = "COMPUTER_DRIVER_RESPONSE_INVALID") {
  if (!result || typeof result !== "object" || result.isError === true) {
    const upstream = typeof result?.errorCode === "string" ? result.errorCode : "";
    if (/stale|snapshot/i.test(upstream)) throw computerError("COMPUTER_SNAPSHOT_STALE");
    if (/permission|accessibility|screen_record/i.test(upstream)) {
      throw computerError("COMPUTER_PERMISSION_REQUIRED", "Computer Use 需要系统权限");
    }
    if (/outside_manifest|resource/i.test(upstream)) throw computerError("COMPUTER_TARGET_FORBIDDEN");
    throw computerError("COMPUTER_ACTION_FAILED");
  }
  if (typeof result.structuredJson !== "string" || result.structuredJson.length > 2 * 1024 * 1024) {
    throw computerError(code);
  }
  let value;
  try { value = JSON.parse(result.structuredJson); } catch { throw computerError(code); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw computerError(code);
  return value;
}

function normalizePublic(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 8192 || depth > 20) throw computerError("COMPUTER_DRIVER_RESPONSE_INVALID");
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return boundedString(value, 4096);
  if (Array.isArray(value)) return value.slice(0, 300).map((entry) => normalizePublic(entry, state, depth + 1));
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) => (
    [boundedString(key, 128), normalizePublic(entry, state, depth + 1)]
  )));
}

function isSecureElement(element) {
  const identity = `${element?.role || ""} ${element?.label || ""}`.toLowerCase();
  return /secure|password|passcode|密码|口令|验证码/u.test(identity);
}

function publicSession(record) {
  return {
    id: record.id,
    profileId: record.profileId,
    workRunId: record.workRunId,
    allowedApplications: [...record.allowedApplications],
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    pauseReason: record.pauseReason,
  };
}

class ComputerUseController {
  constructor(options = {}) {
    if (!options.paths?.computerEphemeralDir || !options.paths?.computerArtifactsDir
      || !options.paths?.trustedRoot || !path.isAbsolute(options.binaryPath || "")) {
      throw new TypeError("ComputerUseController 配置无效");
    }
    this.paths = options.paths;
    this.binaryPath = path.resolve(options.binaryPath);
    this.binaryManifest = options.binaryManifest || null;
    this.verifyBinary = options.verifyBinary !== false;
    this.hostBundleId = options.hostBundleId || "ai.shoggoth.desktop";
    this.sdkLoader = options.sdkLoader || (() => import("@trycua/cua-driver"));
    this.permissionStatus = options.permissionStatus || null;
    this.getSystemIdleTime = options.getSystemIdleTime || (() => Number.POSITIVE_INFINITY);
    this.isScreenLocked = options.isScreenLocked || (() => false);
    this.imageTransformer = options.imageTransformer || null;
    this.scheduleExpiry = options.scheduleExpiry || setTimeout;
    this.cancelExpiry = options.cancelExpiry || clearTimeout;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.maxSessions = options.maxSessions || MAX_SESSIONS;
    this.sessions = new Map();
    this.sdk = null;
    this.opened = false;
    this.availabilityCode = null;
  }

  open() {
    this.opened = true;
    this.availabilityCode = null;
    try {
      if (this.verifyBinary) validateDriverBinary(this.binaryPath, this.binaryManifest);
      ensurePrivateDirectoryTree(this.paths.computerEphemeralDir, this.paths.trustedRoot);
      ensurePrivateDirectoryTree(this.paths.computerArtifactsDir, this.paths.trustedRoot);
      for (const name of fs.readdirSync(this.paths.computerEphemeralDir)) {
        removePrivateTree(path.join(this.paths.computerEphemeralDir, name));
      }
    } catch (error) {
      this.availabilityCode = typeof error?.code === "string" && error.code.startsWith("COMPUTER_")
        ? error.code : "COMPUTER_DRIVER_UNAVAILABLE";
    }
    return this;
  }

  #assertOpen() {
    if (!this.opened) throw computerError("COMPUTER_CONTROLLER_CLOSED");
  }

  #assertAvailable() {
    this.#assertOpen();
    if (this.availabilityCode) throw computerError("COMPUTER_DRIVER_UNAVAILABLE");
  }

  async #loadSdk() {
    if (this.sdk) return this.sdk;
    let sdk;
    try { sdk = await this.sdkLoader(); } catch { throw computerError("COMPUTER_DRIVER_UNAVAILABLE"); }
    const required = [
      "CuaDriver", "RuntimeAuthorizationOptions", "ConfiguredDriverOptions",
      "PrivateWorkerOptions", "EmbeddedEnvironmentVariable", "SessionPermissionMode",
      "StartSessionInput", "EndSessionInput",
    ];
    if (!sdk || required.some((name) => !sdk[name])) throw computerError("COMPUTER_DRIVER_UNAVAILABLE");
    this.sdk = sdk;
    return sdk;
  }

  async #permissions() {
    try {
      const value = this.permissionStatus
        ? await this.permissionStatus()
        : (await this.#loadSdk()).currentMacOsPermissionStatus();
      return {
        accessibility: value?.accessibility === true,
        screenRecording: value?.screenRecording === true,
      };
    } catch {
      return { accessibility: false, screenRecording: false };
    }
  }

  async status(profileId = null) {
    this.#assertOpen();
    if (this.availabilityCode) {
      return {
        available: false,
        reason: this.availabilityCode,
        driverVersion: this.binaryManifest?.version || null,
        contractVersion: this.binaryManifest?.contractVersion || null,
        permissions: { accessibility: false, screenRecording: false },
        sessions: [],
      };
    }
    return {
      available: true,
      driverVersion: this.binaryManifest?.version || "0.22.0",
      contractVersion: this.binaryManifest?.contractVersion || "0.7.0",
      permissions: await this.#permissions(),
      sessions: this.list(profileId),
    };
  }

  list(profileId = null) {
    this.#assertOpen();
    if (this.availabilityCode) return [];
    return [...this.sessions.values()]
      .filter((record) => profileId === null || record.profileId === profileId)
      .map(publicSession);
  }

  #record(sessionId, profileId, workRunId = undefined) {
    this.#assertOpen();
    const record = this.sessions.get(sessionId);
    if (!record || record.profileId !== profileId) throw computerError("COMPUTER_SESSION_NOT_FOUND");
    if (workRunId !== undefined && record.workRunId !== workRunId) {
      throw computerError("COMPUTER_SESSION_FORBIDDEN");
    }
    if (this.now() >= record.expiresAt) {
      this.sessions.delete(record.id);
      record.status = "closed";
      record.snapshot = null;
      if (record.expiryTimer) this.cancelExpiry(record.expiryTimer);
      Promise.resolve(record.driver.shutdown()).catch(() => {});
      try { removePrivateTree(record.sessionRoot); } catch {}
      throw computerError("COMPUTER_SESSION_EXPIRED");
    }
    return record;
  }

  async create(input) {
    this.#assertAvailable();
    if (!input || !SAFE_ID.test(input.profileId || "") || !SAFE_ID.test(input.workRunId || "")
      || !Array.isArray(input.allowedApplications) || input.allowedApplications.length < 1
      || input.allowedApplications.length > 8
      || input.allowedApplications.some((value) => !BUNDLE_ID.test(value))
      || new Set(input.allowedApplications).size !== input.allowedApplications.length
      || !Number.isSafeInteger(input.expiresInSeconds)
      || input.expiresInSeconds < MIN_SESSION_SECONDS
      || input.expiresInSeconds > MAX_SESSION_SECONDS) {
      throw computerError("COMPUTER_ARGUMENTS_INVALID");
    }
    if (this.sessions.size >= this.maxSessions) throw computerError("COMPUTER_SESSION_CAPACITY");
    const permissions = await this.#permissions();
    if (!permissions.accessibility || !permissions.screenRecording) {
      throw computerError("COMPUTER_PERMISSION_REQUIRED", "请先在 Shoggoth 设置中授予辅助功能和屏幕录制权限");
    }
    const sdk = await this.#loadSdk();
    const sessionId = this.randomUUID();
    if (!SAFE_ID.test(sessionId) || this.sessions.has(sessionId)) throw computerError("COMPUTER_SESSION_CAPACITY");
    const sessionRoot = path.join(this.paths.computerEphemeralDir, sessionId);
    ensurePrivateDirectoryTree(sessionRoot, this.paths.trustedRoot);
    const manifestPath = path.join(sessionRoot, "capabilities.yaml");
    atomicWritePrivateFile(manifestPath, `${JSON.stringify(
      makeCapabilityManifest(input.allowedApplications, input.expiresInSeconds), null, 2,
    )}\n`, { trustedRoot: this.paths.trustedRoot });
    let driver;
    try {
      const authorization = sdk.RuntimeAuthorizationOptions.new({
        allowedModes: [sdk.SessionPermissionMode.Bounded],
        compatibilityMode: sdk.SessionPermissionMode.Bounded,
        compatibilityCapabilityManifestPath: manifestPath,
        unrestrictedAcknowledged: false,
        maxSessionTtlSeconds: BigInt(input.expiresInSeconds),
        maxIdleTtlSeconds: BigInt(Math.min(input.expiresInSeconds, 120)),
      });
      const configuredDriver = sdk.ConfiguredDriverOptions.new({
        claudeCodeCompatibility: false,
        authorization,
      });
      const environment = [
        ["CUA_DRIVER_RS_TELEMETRY_ENABLED", "false"],
      ].map(([name, value]) => sdk.EmbeddedEnvironmentVariable.new({ name, value }));
      driver = sdk.CuaDriver.createPrivateWorker(sdk.PrivateWorkerOptions.new({
        binaryPath: this.binaryPath,
        hostBundleId: this.hostBundleId,
        startupTimeoutMs: 10_000n,
        shutdownTimeoutMs: 3_000n,
        configuredDriver,
        environment,
        inheritStderr: process.env.NODE_ENV === "test",
      }));
      const metadata = await driver.metadata();
      if (!metadata || metadata.driverVersion !== (this.binaryManifest?.version || "0.22.0")
        || metadata.contractVersion !== (this.binaryManifest?.contractVersion || "0.7.0")
        || metadata.embedded !== true || !Number.isSafeInteger(metadata.pid) || metadata.pid <= 0) {
        throw computerError("COMPUTER_DRIVER_INVALID");
      }
      const sessionLabel = `shoggoth-${sessionId}`;
      await driver.startSession(sdk.StartSessionInput.new({ session: sessionLabel }));
      const createdAt = this.now();
      const record = {
        id: sessionId,
        profileId: input.profileId,
        workRunId: input.workRunId,
        allowedApplications: [...input.allowedApplications],
        status: "ready",
        pauseReason: null,
        createdAt,
        updatedAt: createdAt,
        expiresAt: createdAt + input.expiresInSeconds * 1000,
        sessionRoot,
        manifestPath,
        sessionLabel,
        driver,
        sdk,
        snapshot: null,
        idleSeconds: this.getSystemIdleTime(),
        expiryTimer: null,
      };
      this.sessions.set(sessionId, record);
      record.expiryTimer = this.scheduleExpiry(() => {
        Promise.resolve(this.closeSession({ sessionId: record.id, profileId: record.profileId }))
          .catch(() => {});
      }, input.expiresInSeconds * 1000);
      record.expiryTimer?.unref?.();
      return publicSession(record);
    } catch (error) {
      try { if (driver) await driver.shutdown(); } catch {}
      try { removePrivateTree(sessionRoot); } catch {}
      if (typeof error?.code === "string" && error.code.startsWith("COMPUTER_")) throw error;
      throw computerError("COMPUTER_DRIVER_START_FAILED");
    }
  }

  async #call(record, name, args) {
    let result;
    try { result = await record.driver.callTool(name, JSON.stringify(args)); } catch {
      record.status = "failed";
      record.pauseReason = "driver_crashed";
      record.snapshot = null;
      throw computerError("COMPUTER_DRIVER_CRASHED");
    }
    try {
      return { result, value: parseStructured(result) };
    } catch (error) {
      if (error?.code === "COMPUTER_PERMISSION_REQUIRED") {
        Promise.resolve(this.closeSession({
          sessionId: record.id, profileId: record.profileId,
        })).catch(() => {});
      }
      throw error;
    }
  }

  async #allowedApps(record) {
    const { value } = await this.#call(record, "list_apps", {});
    if (!Array.isArray(value.apps) || value.apps.length > 10_000) {
      throw computerError("COMPUTER_DRIVER_RESPONSE_INVALID");
    }
    const allow = new Set(record.allowedApplications);
    return value.apps.filter((app) => app && allow.has(app.bundle_id)
      && Number.isSafeInteger(app.pid) && app.pid >= 0);
  }

  async applicationList(input) {
    const record = this.#record(input.sessionId, input.profileId, input.workRunId);
    const apps = await this.#allowedApps(record);
    return {
      sessionId: record.id,
      applications: apps.slice(0, 100).map((app) => ({
        name: boundedString(app.name, 256),
        bundleId: app.bundle_id,
        pid: app.pid,
        running: app.running === true,
        active: app.active === true,
      })),
    };
  }

  async #allowedWindows(record, onScreenOnly = false) {
    const apps = await this.#allowedApps(record);
    const pids = new Set(apps.filter((app) => app.running === true && app.pid > 0).map((app) => app.pid));
    const { value } = await this.#call(record, "list_windows", { on_screen_only: onScreenOnly });
    if (!Array.isArray(value.windows) || value.windows.length > 10_000) {
      throw computerError("COMPUTER_DRIVER_RESPONSE_INVALID");
    }
    return value.windows.filter((window) => window && pids.has(window.pid)
      && Number.isSafeInteger(window.window_id) && window.window_id >= 0);
  }

  async windowList(input) {
    const record = this.#record(input.sessionId, input.profileId, input.workRunId);
    const windows = await this.#allowedWindows(record, input.onScreenOnly === true);
    return {
      sessionId: record.id,
      windows: windows.slice(0, 100).map((window) => ({
        pid: window.pid,
        windowId: window.window_id,
        application: boundedString(window.app_name, 256),
        title: boundedString(window.title, 512),
        bounds: normalizePublic(window.bounds || null),
        onScreen: window.is_on_screen === true,
      })),
    };
  }

  async #assertWindow(record, pid, windowId) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(windowId) || windowId < 0) {
      throw computerError("COMPUTER_ARGUMENTS_INVALID");
    }
    const windows = await this.#allowedWindows(record, false);
    const found = windows.find((window) => window.pid === pid && window.window_id === windowId);
    if (!found) throw computerError("COMPUTER_TARGET_FORBIDDEN");
    return found;
  }

  async snapshot(input) {
    const record = this.#record(input.sessionId, input.profileId, input.workRunId);
    if (this.isScreenLocked()) {
      this.#pause(record, "screen_locked");
      throw computerError("COMPUTER_SCREEN_LOCKED");
    }
    if (record.status !== "ready") throw computerError("COMPUTER_SESSION_PAUSED");
    await this.#assertWindow(record, input.pid, input.windowId);
    const { result, value } = await this.#call(record, "get_window_state", {
      session: record.sessionLabel,
      pid: input.pid,
      window_id: input.windowId,
      max_elements: MAX_ELEMENTS,
      max_depth: 20,
      include_screenshot: true,
    });
    if (!Array.isArray(value.elements) || value.elements.length > MAX_ELEMENTS
      || typeof value.snapshot_id !== "string") {
      throw computerError("COMPUTER_DRIVER_RESPONSE_INVALID");
    }
    const revision = this.randomUUID();
    const refs = new Map();
    const elements = value.elements.map((element, index) => {
      const ref = `c${index + 1}`;
      const secure = isSecureElement(element);
      refs.set(ref, {
        token: typeof element.element_token === "string" ? element.element_token : null,
        index: Number.isSafeInteger(element.element_index) ? element.element_index : null,
        secure,
      });
      return {
        ref,
        role: boundedString(element.role, 128),
        label: boundedString(element.label, 512),
        value: secure ? "" : boundedString(element.value, 1024),
        frame: normalizePublic(element.frame || null),
        secure,
      };
    });
    record.snapshot = {
      revision,
      cuaSnapshotId: value.snapshot_id,
      pid: input.pid,
      windowId: input.windowId,
      refs,
    };
    record.updatedAt = this.now();
    record.idleSeconds = this.getSystemIdleTime();
    const image = await this.#storeSnapshotImage(record, result.images);
    return {
      sessionId: record.id,
      snapshotRevision: revision,
      pid: input.pid,
      windowId: input.windowId,
      tree: boundedString(value.tree_markdown, MAX_TREE_BYTES),
      elements,
      degraded: value.degraded === true || result.degraded === true,
      image,
    };
  }

  async #storeSnapshotImage(record, images) {
    if (!Array.isArray(images) || images.length === 0) return null;
    const source = images[0];
    if (!source || !["image/png", "image/jpeg"].includes(source.mimeType)
      || typeof source.dataBase64 !== "string") throw computerError("COMPUTER_DRIVER_RESPONSE_INVALID");
    const data = Buffer.from(source.dataBase64, "base64");
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES
      || data.toString("base64") !== source.dataBase64) throw computerError("COMPUTER_DRIVER_RESPONSE_INVALID");
    const directoryName = crypto.createHash("sha256").update(record.profileId).digest("hex").slice(0, 32);
    const directory = path.join(this.paths.computerArtifactsDir, directoryName);
    ensurePrivateDirectoryTree(directory, this.paths.trustedRoot);
    const artifactId = this.randomUUID();
    const extension = source.mimeType === "image/png" ? "png" : "jpg";
    atomicWritePrivateFile(path.join(directory, `${artifactId}.${extension}`), data, {
      trustedRoot: this.paths.trustedRoot,
    });
    let thumbnail = null;
    if (this.imageTransformer) {
      const transformed = await this.imageTransformer({ data, mimeType: source.mimeType });
      if (!transformed || transformed.mimeType !== "image/jpeg" || !Buffer.isBuffer(transformed.data)
        || transformed.data.length === 0 || transformed.data.length > MAX_THUMBNAIL_BYTES) {
        throw computerError("COMPUTER_IMAGE_TRANSFORM_FAILED");
      }
      thumbnail = transformed.data.toString("base64");
    } else if (data.length <= MAX_THUMBNAIL_BYTES) {
      thumbnail = data.toString("base64");
    }
    return {
      mimeType: source.mimeType,
      thumbnailMimeType: thumbnail ? (this.imageTransformer ? "image/jpeg" : source.mimeType) : null,
      thumbnail,
      artifact: {
        id: artifactId,
        storageKey: `${directoryName}/${artifactId}.${extension}`,
        sizeBytes: data.length,
        sha256: crypto.createHash("sha256").update(data).digest("hex"),
      },
    };
  }

  #assertActionReady(record, input) {
    if (this.isScreenLocked()) {
      this.#pause(record, "screen_locked");
      throw computerError("COMPUTER_SCREEN_LOCKED");
    }
    if (record.status !== "ready") throw computerError("COMPUTER_SESSION_PAUSED");
    const idle = this.getSystemIdleTime();
    if (Number.isFinite(idle) && Number.isFinite(record.idleSeconds)
      && idle + TAKEOVER_TOLERANCE_SECONDS < record.idleSeconds) {
      this.#pause(record, "user_takeover");
      throw computerError("COMPUTER_USER_TAKEOVER");
    }
    const snapshot = record.snapshot;
    if (!snapshot || input.snapshotRevision !== snapshot.revision
      || input.pid !== snapshot.pid || input.windowId !== snapshot.windowId) {
      throw computerError("COMPUTER_SNAPSHOT_STALE");
    }
    return snapshot;
  }

  #pause(record, reason) {
    record.status = "paused";
    record.pauseReason = reason;
    record.snapshot = null;
    record.updatedAt = this.now();
  }

  #targetArgs(snapshot, input, { allowCoordinates = true, requireRef = false } = {}) {
    const common = {
      session: input.sessionLabel,
      pid: snapshot.pid,
      window_id: snapshot.windowId,
      delivery_mode: "background",
    };
    if (typeof input.ref === "string") {
      const target = snapshot.refs.get(input.ref);
      if (!target || (!target.token && target.index === null)) throw computerError("COMPUTER_SNAPSHOT_STALE");
      return {
        ...common,
        ...(target.token ? { element_token: target.token } : {
          element_index: target.index,
          snapshot_id: snapshot.cuaSnapshotId,
        }),
        _secure: target.secure,
      };
    }
    if (!requireRef && allowCoordinates && Number.isFinite(input.x) && Number.isFinite(input.y)
      && input.x >= 0 && input.y >= 0 && input.x <= 20_000 && input.y <= 20_000) {
      return { ...common, x: input.x, y: input.y, _secure: false };
    }
    throw computerError("COMPUTER_ARGUMENTS_INVALID");
  }

  async action(input) {
    const record = this.#record(input.sessionId, input.profileId, input.workRunId);
    const snapshot = this.#assertActionReady(record, input);
    let name;
    let args;
    try {
      if (input.action === "click" || input.action === "double_click") {
        name = input.action;
        args = this.#targetArgs(snapshot, { ...input, sessionLabel: record.sessionLabel });
      } else if (input.action === "drag") {
        name = "drag";
        args = {
          session: record.sessionLabel, pid: snapshot.pid, window_id: snapshot.windowId,
          delivery_mode: "background", from_x: input.fromX, from_y: input.fromY,
          to_x: input.toX, to_y: input.toY, duration_ms: input.durationMs,
        };
      } else if (input.action === "scroll") {
        name = "scroll";
        args = input.ref ? this.#targetArgs(snapshot, {
          ...input, sessionLabel: record.sessionLabel,
        }) : {
          session: record.sessionLabel, pid: snapshot.pid, window_id: snapshot.windowId,
          delivery_mode: "background",
        };
        Object.assign(args, { direction: input.direction, amount: input.amount, by: input.by });
      } else if (input.action === "type") {
        name = "type_text";
        args = this.#targetArgs(snapshot, { ...input, sessionLabel: record.sessionLabel }, {
          allowCoordinates: false, requireRef: true,
        });
        if (args._secure) throw computerError("COMPUTER_SECURE_INPUT_FORBIDDEN");
        args.text = input.text;
      } else if (input.action === "key") {
        name = input.modifiers.length > 0 ? "hotkey" : "press_key";
        args = input.ref ? this.#targetArgs(snapshot, {
          ...input, sessionLabel: record.sessionLabel,
        }) : {
          session: record.sessionLabel, pid: snapshot.pid, window_id: snapshot.windowId,
          delivery_mode: "background",
        };
        if (name === "hotkey") args.keys = [...input.modifiers, input.key];
        else args.key = input.key;
      } else {
        throw computerError("COMPUTER_ARGUMENTS_INVALID");
      }
      delete args._secure;
      const { result } = await this.#call(record, name, args);
      return {
        sessionId: record.id,
        action: input.action,
        attempted: true,
        result: normalizePublic(result.action || null),
        degraded: result.degraded === true,
        requiresFreshSnapshot: true,
      };
    } finally {
      record.snapshot = null;
      record.updatedAt = this.now();
      record.idleSeconds = this.getSystemIdleTime();
    }
  }

  async focus(input) {
    const record = this.#record(input.sessionId, input.profileId, input.workRunId);
    if (this.isScreenLocked()) {
      this.#pause(record, "screen_locked");
      throw computerError("COMPUTER_SCREEN_LOCKED");
    }
    const apps = await this.#allowedApps(record);
    const app = apps.find((entry) => entry.bundle_id === input.bundleId && entry.pid === input.pid
      && entry.running === true);
    if (!app) throw computerError("COMPUTER_TARGET_FORBIDDEN");
    if (input.windowId !== null) await this.#assertWindow(record, input.pid, input.windowId);
    const { result } = await this.#call(record, "bring_to_front", {
      pid: input.pid,
      ...(input.windowId === null ? {} : { window_id: input.windowId }),
    });
    record.snapshot = null;
    record.updatedAt = this.now();
    record.idleSeconds = this.getSystemIdleTime();
    return {
      sessionId: record.id,
      bundleId: input.bundleId,
      pid: input.pid,
      windowId: input.windowId,
      result: normalizePublic(result.action || null),
      requiresFreshSnapshot: true,
    };
  }

  resume(input) {
    const record = this.#record(input.sessionId, input.profileId, input.workRunId);
    if (this.isScreenLocked()) throw computerError("COMPUTER_SCREEN_LOCKED");
    if (record.status !== "paused") throw computerError("COMPUTER_SESSION_STATE_INVALID");
    record.status = "ready";
    record.pauseReason = null;
    record.snapshot = null;
    record.updatedAt = this.now();
    record.idleSeconds = this.getSystemIdleTime();
    return publicSession(record);
  }

  pauseAll(reason = "system_suspended") {
    if (!this.opened) return;
    for (const record of this.sessions.values()) this.#pause(record, reason);
  }

  async closeSession(input) {
    this.#assertOpen();
    const record = this.sessions.get(input.sessionId);
    if (!record || record.profileId !== input.profileId) {
      throw computerError("COMPUTER_SESSION_NOT_FOUND");
    }
    this.sessions.delete(record.id);
    record.status = "closed";
    record.snapshot = null;
    if (record.expiryTimer) this.cancelExpiry(record.expiryTimer);
    record.expiryTimer = null;
    try { await record.driver.endSession(record.sdk.EndSessionInput.new({ session: record.sessionLabel })); } catch {}
    try { await record.driver.shutdown(); } catch {}
    try { removePrivateTree(record.sessionRoot); } catch {}
    return { sessionId: record.id, closed: true };
  }

  async closeForWorkRun(profileId, workRunId) {
    if (!this.opened) return;
    const records = [...this.sessions.values()].filter((record) => (
      record.profileId === profileId && record.workRunId === workRunId
    ));
    await Promise.allSettled(records.map((record) => this.closeSession({
      sessionId: record.id, profileId: record.profileId,
    })));
  }

  async closeForProfile(profileId) {
    if (!this.opened) return;
    const records = [...this.sessions.values()].filter((record) => record.profileId === profileId);
    await Promise.allSettled(records.map((record) => this.closeSession({
      sessionId: record.id, profileId: record.profileId,
    })));
  }

  async close() {
    if (!this.opened) return;
    const records = [...this.sessions.values()];
    await Promise.allSettled(records.map((record) => this.closeSession({
      sessionId: record.id, profileId: record.profileId,
    })));
    this.sessions.clear();
    this.opened = false;
  }
}

function validComputerKey(key) {
  return typeof key === "string" && (SAFE_KEYS.has(key) || /^[a-z0-9]$/u.test(key));
}

function validComputerModifiers(modifiers) {
  return Array.isArray(modifiers) && modifiers.length <= 4
    && new Set(modifiers).size === modifiers.length
    && modifiers.every((value) => SAFE_MODIFIERS.has(value));
}

module.exports = {
  ALLOWED_CUA_TOOLS,
  ComputerUseController,
  makeCapabilityManifest,
  parseStructured,
  validateDriverBinary,
  validComputerKey,
  validComputerModifiers,
};
