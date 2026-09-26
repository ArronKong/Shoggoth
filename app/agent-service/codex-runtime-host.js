"use strict";

const { spawn } = require("node:child_process");
const { probeCodexBinaryVersion } = require("./codex-binary-probe");
const { CodexJsonlRpcClient, rpcError } = require("./codex-jsonl-rpc");
const { validateRegisteredSecrets } = require("./codex-rpc-safety");
const { normalizeCodexEvent } = require("./codex-event-normalizer");
const { CodexSchemaContract } = require("./codex-schema-contract");
const { runtimeBinding } = require("./runtime-adapter");
const { validateResolvedEnvironment } = require("./runtime-account-resolver");
const { nativeChatGptTokens } = require("./codex-native-auth");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
const { CODEX_SESSION_START_TIMEOUT_MS } = require("./codex-startup-timeouts");
const {
  DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
  isApprovalRequestMethod,
} = require("./interactive-timeouts");
const {
  assertRuntimeProfileId,
  buildCodexSpawnEnv,
  runtimeError,
} = require("./codex-runtime-paths");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultKillProcessGroup(pid, signal) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function defaultProcessGroupExists(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function exactObject(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function wellFormedString(value, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function accountProtocolError(message = "Codex account response is invalid") {
  return runtimeError("CODEX_ACCOUNT_PROTOCOL_INVALID", message);
}

function safeAccountUrl(value) {
  if (!wellFormedString(value, 4096)) throw accountProtocolError();
  let parsed;
  try { parsed = new URL(value); } catch { throw accountProtocolError(); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname
    || parsed.username || parsed.password) throw accountProtocolError();
  return value;
}

function normalizeAccountReadResponse(response) {
  if (!exactObject(response, ["account", "requiresOpenaiAuth"], ["requiresOpenaiAuth"])
    || typeof response.requiresOpenaiAuth !== "boolean") throw accountProtocolError();
  const account = response.account ?? null;
  if (account === null) return { account: null, requiresOpenaiAuth: response.requiresOpenaiAuth };
  if (!account || typeof account !== "object" || Array.isArray(account)) throw accountProtocolError();
  if (account.type === "apiKey" && exactObject(account, ["type"])) {
    return { account: { type: "apiKey" }, requiresOpenaiAuth: response.requiresOpenaiAuth };
  }
  if (account.type === "chatgpt" && exactObject(account, ["type", "email", "planType"], ["type", "planType"])) {
    return {
      account: { type: "chatgpt", planType: account.planType },
      requiresOpenaiAuth: response.requiresOpenaiAuth,
    };
  }
  if (account.type === "amazonBedrock"
    && exactObject(account, ["type", "usesCodexManagedCredentials"], ["type"])) {
    return {
      account: {
        type: "amazonBedrock",
        usesCodexManagedCredentials: account.usesCodexManagedCredentials === true,
      },
      requiresOpenaiAuth: response.requiresOpenaiAuth,
    };
  }
  throw accountProtocolError();
}

function normalizeAccountLoginResponse(response) {
  if (response?.type === "chatgptAuthTokens" && exactObject(response, ["type"])) {
    return { type: "chatgptAuthTokens" };
  }
  if (response?.type === "apiKey" && exactObject(response, ["type"])) {
    return { type: "apiKey" };
  }
  if (response?.type === "chatgpt"
    && exactObject(response, ["type", "loginId", "authUrl"])
    && wellFormedString(response.loginId, 256)) {
    return { type: "chatgpt", loginId: response.loginId, authUrl: safeAccountUrl(response.authUrl) };
  }
  if (response?.type === "chatgptDeviceCode"
    && exactObject(response, ["type", "loginId", "verificationUrl", "userCode"])
    && wellFormedString(response.loginId, 256) && wellFormedString(response.userCode, 256)) {
    return {
      type: "chatgptDeviceCode",
      loginId: response.loginId,
      verificationUrl: safeAccountUrl(response.verificationUrl),
      userCode: response.userCode,
    };
  }
  throw accountProtocolError();
}

class CodexRuntimeHost {
  constructor(options) {
    const ownedSpawnEnv = options.spawnEnv && typeof options.spawnEnv === "object"
      && !Array.isArray(options.spawnEnv) ? { ...options.spawnEnv } : options.spawnEnv;
    const ownedRegisteredSecrets = Array.isArray(options.registeredSecrets)
      ? [...options.registeredSecrets] : options.registeredSecrets;
    this.options = {
      ...options,
      spawnEnv: ownedSpawnEnv,
      registeredSecrets: ownedRegisteredSecrets,
    };
    this.binding = runtimeBinding(options.runtimeBinding || {
      runtime: "codex",
      runtimeProfileId: options.runtimeProfileId,
      runtimeAccountId: options.runtimeAccountId,
    });
    this.runtimeProfileId = assertRuntimeProfileId(this.binding.runtimeProfileId);
    this.runtimeAccountId = this.binding.runtimeAccountId;
    this.runtimeEnvironment = validateResolvedEnvironment(options.runtimeEnvironment, this.binding);
    this.paths = options.paths;
    this.packageVersion = String(options.packageVersion || "0.0.0");
    this.schemaContract = options.schemaContract || new CodexSchemaContract({ repoRoot: options.repoRoot });
    this.spawnProcess = options.spawnProcess || spawn;
    this.probeBinary = options.probeBinary || probeCodexBinaryVersion;
    this.killProcessGroup = options.killProcessGroup || defaultKillProcessGroup;
    this.processGroupExists = options.processGroupExists || defaultProcessGroupExists;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.sessionStartTimeoutMs = options.sessionStartTimeoutMs
      ?? options.requestTimeoutMs ?? CODEX_SESSION_START_TIMEOUT_MS;
    this.serverRequestTimeoutMs = options.serverRequestTimeoutMs
      ?? DEFAULT_SERVER_REQUEST_TIMEOUT_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 30_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.state = "idle";
    this.nativeAuth = this.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
      ? options.nativeAuth || null : null;
    this.nativeAuthEligible = true;
    this.nativeAuthPending = null;
    this.nativeAccountId = null;
    this.nativeAccessToken = null;
    this.child = null;
    this.rpc = null;
    this.starting = null;
    this.stopping = null;
    this.startupAbortController = null;
    this.startupGeneration = 0;
    this.stopRequested = false;
    this.initializedResponse = null;
    this.fatalError = null;
    this.cleanupIncomplete = false;
    this.startupStage = "process_spawn";
    this.subscribers = new Set();
    this.accountAuthSubscribers = new Set();
    this.serverRequestHandlers = new Map();
    this.registeredSecrets = validateRegisteredSecrets([
      ...(this.options.registeredSecrets || []),
      ...Object.values(this.options.spawnEnv || {}).filter((value) => typeof value === "string" && value.length >= 8),
    ]);
    this.terminated = new Promise((resolve, reject) => {
      this._resolveTerminated = resolve;
      this._rejectTerminated = reject;
    });
    this.terminated.catch(() => {});
  }

  initialize() {
    if (this.state === "ready") return Promise.resolve(this.initializedResponse);
    if (this.starting) return this.starting;
    if (this.state !== "idle") {
      return Promise.reject(runtimeError("CODEX_HOST_NOT_STARTABLE", "Codex runtime host cannot be started"));
    }
    this.state = "starting";
    this.stopRequested = false;
    const generation = ++this.startupGeneration;
    this.startupAbortController = new AbortController();
    this.starting = this._start(generation).catch(async (error) => {
      if (error?.cleanupIncomplete) this.cleanupIncomplete = true;
      if (this.stopRequested) {
        const cancelled = runtimeError("CODEX_HOST_START_CANCELLED", "Codex runtime startup was cancelled");
        if (this.cleanupIncomplete) cancelled.cleanupIncomplete = true;
        throw cancelled;
      }
      await this._markFatal(error);
      throw error;
    });
    return this.starting;
  }

  start() {
    return this.initialize();
  }

  _assertStartupCurrent(generation) {
    if (this.stopRequested || this.state !== "starting" || generation !== this.startupGeneration) {
      throw runtimeError("CODEX_HOST_START_CANCELLED", "Codex runtime startup was cancelled");
    }
  }

  async _start(generation) {
    const codexHome = this.runtimeEnvironment.home;
    // packaged repoRoot 指向 app.asar：Electron 能读取其中资源，但操作系统不能把
    // ASAR 文件作为子进程 cwd。使用已创建的私有 CODEX_HOME 启动探针/app-server；
    // 具体任务仍由 thread/start 的显式 cwd 决定，不会改变工作区权限边界。
    const runtimeCwd = this.options.cwd || (this.runtimeEnvironment.installationKind === "system"
      ? this.runtimeEnvironment.spawnEnv.HOME
      : this.options.packaged ? codexHome
        : (this.options.repoRoot || this.runtimeEnvironment.spawnEnv.HOME));
    // 版本探针只需要基础隔离环境。必须在 prepareRuntime 解密 Provider/AWS
    // 凭据之前完成，防止短命的 `--version` 子进程意外继承任何凭据。
    const probeEnv = buildCodexSpawnEnv({
      codexHome,
      installationKind: this.runtimeEnvironment.installationKind,
      parentEnv: this.options.parentEnv,
      spawnEnv: {},
    });
    const probe = await this.probeBinary(this.runtimeEnvironment.binaryPath, {
      installationKind: this.runtimeEnvironment.installationKind,
      cwd: runtimeCwd,
      env: probeEnv,
      execFileImpl: this.options.probeExecFile,
      signal: this.startupAbortController.signal,
    });
    this.runtimeVersion = probe?.version ?? null;
    this._assertStartupCurrent(generation);
    const prepared = this.options.prepareRuntime
      ? await this.options.prepareRuntime({
        runtimeProfileId: this.runtimeProfileId,
        runtimeAccountId: this.runtimeAccountId,
        codexHome,
        configurationMode: this.runtimeEnvironment.configurationMode,
        executionContract: this.options.executionContract,
      })
      : null;
    this._assertStartupCurrent(generation);
    if (prepared !== null && (typeof prepared !== "object" || Array.isArray(prepared)
      || !prepared.spawnEnv || typeof prepared.spawnEnv !== "object" || Array.isArray(prepared.spawnEnv)
      || !Array.isArray(prepared.registeredSecrets)
      || (prepared.configArgs !== undefined && (!Array.isArray(prepared.configArgs)
        || prepared.configArgs.length % 2 !== 0
        || prepared.configArgs.some((value, index) => typeof value !== "string"
          || value.includes("\0") || (index % 2 === 0 && value !== "-c")))))) {
      throw runtimeError("CODEX_RUNTIME_PREPARE_INVALID", "Codex runtime preparation is invalid");
    }
    const preparedSpawnEnv = prepared?.spawnEnv || {};
    if (prepared?.runtimeConfig?.provider
      && prepared.runtimeConfig.provider.kind !== "chatgpt") this.nativeAuthEligible = false;
    const explicitSpawnEnv = this.options.spawnEnv || {};
    for (const key of Object.keys(preparedSpawnEnv)) {
      if (Object.prototype.hasOwnProperty.call(explicitSpawnEnv, key)
        && explicitSpawnEnv[key] !== preparedSpawnEnv[key]) {
        throw runtimeError("CODEX_RUNTIME_PREPARE_INVALID", "Codex runtime environment conflicts");
      }
    }
    const spawnEnv = { ...explicitSpawnEnv, ...preparedSpawnEnv };
    this.registeredSecrets = validateRegisteredSecrets([
      ...this.registeredSecrets,
      ...(prepared?.registeredSecrets || []),
      ...Object.values(spawnEnv).filter((value) => typeof value === "string" && value.length >= 8),
    ]);
    const env = buildCodexSpawnEnv({
      codexHome,
      installationKind: this.runtimeEnvironment.installationKind,
      parentEnv: this.options.parentEnv,
      spawnEnv,
    });
    const launchArgs = [...this.runtimeEnvironment.launchArgs];
    const commandIndex = launchArgs.indexOf("app-server");
    if (commandIndex < 0) {
      throw runtimeError("CODEX_RUNTIME_PREPARE_INVALID", "Codex app-server launch is invalid");
    }
    launchArgs.splice(commandIndex, 0, ...(prepared?.configArgs || []));
    prepared?.assertCurrent?.();
    this.assertExecutionProviderCurrent = prepared?.assertCurrent || (() => {});
    const child = this.spawnProcess(this.runtimeEnvironment.binaryPath, launchArgs, {
      cwd: runtimeCwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) {
      throw runtimeError("CODEX_PROCESS_INVALID", "Codex app-server did not provide a safe pid");
    }
    this.child = child;
    this.childClose = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    this.rpc = new CodexJsonlRpcClient(child, {
      requestTimeoutMs: this.requestTimeoutMs,
      writeTimeoutMs: this.options.writeTimeoutMs,
      serverRequestTimeoutMs: this.serverRequestTimeoutMs,
      maxFrameBytes: this.options.maxFrameBytes,
      maxStderrBytes: this.options.maxStderrBytes,
      registeredSecrets: this.registeredSecrets,
      notificationGuard: (message) => {
        this.schemaContract.validateNotification(message);
        const loginId = message?.params?.loginId;
        if (message?.method === "account/login/completed"
          && loginId !== undefined && loginId !== null && !wellFormedString(loginId, 256)) {
          throw runtimeError("CODEX_ACCOUNT_PROTOCOL_INVALID", "Codex account notification is invalid");
        }
      },
      serverRequestGuard: (message) => this.schemaContract.validateServerRequest(message),
      onDiagnostic: (diagnostic) => this.options.onDiagnostic?.(diagnostic),
    });
    this.rpc.subscribe((message) => this._publish(message));
    for (const [method, handler] of this.serverRequestHandlers) {
      this._registerRpcServerHandler(method, handler);
    }
    this.rpc.terminated.catch((error) => {
      if (this.state !== "stopping" && this.state !== "stopped") void this._markFatal(error);
    });
    const initializeParams = {
      clientInfo: { name: "shoggoth", title: "Shoggoth", version: this.packageVersion },
      capabilities: this.nativeAuth && this.nativeAuthEligible ? { experimentalApi: true } : null,
    };
    this.startupStage = "rpc_initialize";
    this.schemaContract.validateParams("initialize", initializeParams);
    const response = await this.rpc.request(
      this.schemaContract.operations.initialize.method,
      initializeParams,
      { timeoutMs: this.initializeTimeoutMs },
    );
    this.schemaContract.validateResponse("initialize", response);
    await this.rpc.notify("initialized");
    this.initializedResponse = response;
    this.startupStage = "running";
    this.state = "ready";
    if (this.nativeAuth && this.nativeAuthEligible) {
      this.registerServerRequestHandler("account/chatgptAuthTokens/refresh", async (params) => {
        if (!this.nativeAccountId || !this.nativeAuth.enabled(this.runtimeEnvironment.home)
          || (params.previousAccountId && params.previousAccountId !== this.nativeAccountId)) {
          throw runtimeError("RUNTIME_AUTH_REQUIRED", "Local Codex sign-in is unavailable");
        }
        const tokens = await this.nativeAuth.read({
          refreshToken: true, previousAccountId: this.nativeAccountId,
        });
        this._assertReady();
        if (!tokens || !this.nativeAuth.enabled(this.runtimeEnvironment.home)) {
          throw runtimeError("RUNTIME_AUTH_REQUIRED", "Local Codex sign-in is unavailable");
        }
        this._registerAccountSecret(tokens.accessToken);
        this.nativeAccessToken = tokens.accessToken;
        return this._externalTokenParams(tokens);
      });
    }
    return response;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw runtimeError("CODEX_SUBSCRIBER_INVALID", "Codex subscriber must be a function");
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  subscribeAccountAuth(listener) {
    if (typeof listener !== "function") {
      throw runtimeError("CODEX_SUBSCRIBER_INVALID", "Codex subscriber must be a function");
    }
    this.accountAuthSubscribers.add(listener);
    return () => this.accountAuthSubscribers.delete(listener);
  }

  _publish(message) {
    if (message?.method === "account/login/completed"
      && wellFormedString(message.params?.loginId, 256)) {
      const event = {
        type: "account_login",
        method: "account/login/completed",
        loginId: message.params.loginId,
        status: message.params.success === true ? "succeeded" : "failed",
        errorCode: message.params.success === true ? undefined : "ACCOUNT_LOGIN_FAILED",
      };
      for (const listener of this.accountAuthSubscribers) {
        try { listener(event); } catch { this.options.onDiagnostic?.({ code: "CODEX_SUBSCRIBER_FAILED" }); }
      }
    }
    const normalized = normalizeCodexEvent(message, {
      registeredSecrets: this.registeredSecrets,
      maxDiagnosticBytes: this.options.maxDiagnosticBytes,
      maxSnapshotArrayItems: this.options.maxSnapshotArrayItems,
      maxSnapshotBytes: this.options.maxSnapshotBytes,
      maxSnapshotDepth: this.options.maxSnapshotDepth,
      maxSnapshotKeys: this.options.maxSnapshotKeys,
      maxSnapshotStringBytes: this.options.maxSnapshotStringBytes,
    });
    for (const listener of this.subscribers) {
      try { listener(normalized); } catch { this.options.onDiagnostic?.({ code: "CODEX_SUBSCRIBER_FAILED" }); }
    }
  }

  registerServerRequestHandler(method, handler) {
    if (!this.schemaContract.serverRequests[method]) {
      throw runtimeError("CODEX_SERVER_METHOD_UNKNOWN", "Codex server request method is not generated");
    }
    if (typeof handler !== "function") throw runtimeError("CODEX_SERVER_HANDLER_INVALID", "Codex server handler must be a function");
    this.serverRequestHandlers.set(method, handler);
    const unregisterRpc = this.rpc ? this._registerRpcServerHandler(method, handler) : null;
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method);
      unregisterRpc?.();
    };
  }

  _registerRpcServerHandler(method, handler) {
    return this.rpc.registerServerRequestHandler(method, async (params, context) => {
      this._publish({ id: context.id, method: context.method, params });
      const response = await handler(params, context);
      try {
        this.schemaContract.validateServerResponse(method, response === undefined ? null : response);
      } catch (error) {
        await this._markFatal(error);
        throw error;
      }
      return response;
    }, {
      // MCP elicitation can be an approval or a finite user form. The Coordinator
      // owns that content-sensitive deadline, so the transport must not race it.
      timeoutMs: isApprovalRequestMethod(method) || method === "mcpServer/elicitation/request"
        ? null : this.serverRequestTimeoutMs,
    });
  }

  async waitFor(method, options) {
    this._assertReady();
    return normalizeCodexEvent(await this.rpc.waitFor(method, options), {
      registeredSecrets: this.registeredSecrets,
      maxDiagnosticBytes: this.options.maxDiagnosticBytes,
    });
  }

  _assertReady() {
    if (this.state !== "ready" || !this.rpc) throw runtimeError("CODEX_HOST_NOT_READY", "Codex runtime host is not ready");
  }

  async _request(operationName, params, options) {
    this._assertReady();
    const operation = this.schemaContract.operations[operationName];
    this.schemaContract.validateParams(operationName, params);
    const response = await this.rpc.request(operation.method, params, options);
    try {
      this.schemaContract.validateResponse(operationName, response);
    } catch (error) {
      await this._markFatal(error);
      throw error;
    }
    return response;
  }

  threadStart(params, options) {
    return this._request("threadStart", params, { timeoutMs: this.sessionStartTimeoutMs, ...options });
  }
  threadResume(params, options) {
    return this._request("threadResume", params, { timeoutMs: this.sessionStartTimeoutMs, ...options });
  }
  threadRead(params, options) { return this._request("threadRead", params, options); }
  threadInjectItems(params, options) { return this._request("threadInjectItems", params, options); }
  threadList(params, options) { return this._request("threadList", params, options); }
  threadSetName(params, options) { return this._request("threadSetName", params, options); }
  threadArchive(params, options) { return this._request("threadArchive", params, options); }
  threadUnarchive(params, options) { return this._request("threadUnarchive", params, options); }
  threadDelete(params, options) { return this._request("threadDelete", params, options); }
  threadCompactStart(params, options) { return this._request("threadCompactStart", params, options); }
  threadGoalSet(params, options) { return this._request("threadGoalSet", params, options); }
  threadGoalGet(params, options) { return this._request("threadGoalGet", params, options); }
  threadGoalClear(params, options) { return this._request("threadGoalClear", params, options); }
  turnStart(params, options) { return this._request("turnStart", params, options); }
  turnSteer(params, options) { return this._request("turnSteer", params, options); }
  turnInterrupt(params, options) { return this._request("turnInterrupt", params, options); }
  modelList(params, options) { return this._request("modelList", params, options); }
  mcpServerStatusList(params, options) { return this._request("mcpServerStatusList", params, options); }
  skillsList(params, options) { return this._request("skillsList", params, options); }

  async _accountRequest(operationName, params, options, normalize) {
    const response = await this._request(operationName, params, options);
    try { return normalize(response); } catch (error) {
      await this._markFatal(error);
      throw error;
    }
  }

  async accountRead(params = { refreshToken: false }, options) {
    if (!exactObject(params, ["refreshToken"], [])
      || (params.refreshToken !== undefined && typeof params.refreshToken !== "boolean")) {
      return Promise.reject(runtimeError("CODEX_ACCOUNT_PARAMS_INVALID", "Codex account read params are invalid"));
    }
    await this._ensureNativeAuth();
    const result = await this._accountRequest("accountRead", params, options, normalizeAccountReadResponse);
    return this.nativeAccessToken && result.account?.type === "chatgpt"
      ? { ...result, authSource: "native-codex" } : result;
  }

  _registerAccountSecret(secret) {
    const updated = validateRegisteredSecrets([...this.registeredSecrets, secret]);
    this.rpc?.registerSecret(secret);
    this.registeredSecrets = updated;
  }

  // Private compatibility bridge for the pinned bundled CLI. getAuthStatus is
  // deprecated and omitted from its public v2 JSON schema; validate the exact
  // generated GetAuthStatusResponse shape here. Never expose it via Service IPC.
  async readNativeChatGptTokens(refreshToken) {
    this._assertReady();
    if (this.options.nativeAuthSource !== true || typeof refreshToken !== "boolean") {
      throw runtimeError("CODEX_ACCOUNT_PARAMS_INVALID", "Native auth source is unavailable");
    }
    const account = await this._accountRequest("accountRead", { refreshToken: false },
      undefined, normalizeAccountReadResponse);
    if (account.account?.type !== "chatgpt") return null;
    const response = await this.rpc.request("getAuthStatus", {
      includeToken: true, refreshToken,
    });
    if (!exactObject(response, ["authMethod", "authToken", "requiresOpenaiAuth"])
      || (response.authMethod !== null && ![
        "apikey", "chatgpt", "chatgptAuthTokens", "headers", "agentIdentity",
        "personalAccessToken", "bedrockApiKey",
      ].includes(response.authMethod))
      || (response.authToken !== null
        && (typeof response.authToken !== "string" || response.authToken.length > 64 * 1024))
      || (response.requiresOpenaiAuth !== null && typeof response.requiresOpenaiAuth !== "boolean")) {
      throw accountProtocolError();
    }
    if (response.authToken) this._registerAccountSecret(response.authToken);
    return nativeChatGptTokens(response);
  }

  _externalTokenParams(tokens) {
    return {
      accessToken: tokens.accessToken, chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    };
  }

  async _ensureNativeAuth() {
    if (!this.nativeAuth || !this.nativeAuthEligible) return;
    if (this.nativeAuthPending) return this.nativeAuthPending;
    const pending = this._syncNativeAuth();
    this.nativeAuthPending = pending;
    try { await pending; } finally {
      if (this.nativeAuthPending === pending) this.nativeAuthPending = null;
    }
  }

  async _syncNativeAuth() {
    this._assertReady();
    const enabled = this.nativeAuth.enabled(this.runtimeEnvironment.home);
    if (!this.nativeAccountId) {
      if (!enabled) return;
      const current = await this._accountRequest("accountRead", { refreshToken: false },
        undefined, normalizeAccountReadResponse);
      if (current.account !== null || !current.requiresOpenaiAuth) return;
    }
    let tokens = null;
    if (enabled) {
      try {
        tokens = await this.nativeAuth.read({ previousAccountId: this.nativeAccountId });
      } catch {
        // Missing, expired, locked or incompatible native auth falls back to
        // the existing independent login. Raw upstream errors are not exposed.
      }
    }
    this._assertReady();
    if (!this.nativeAuth.enabled(this.runtimeEnvironment.home)) tokens = null;
    if (!tokens) {
      if (this.nativeAccessToken) await this._logoutAccount();
      this.nativeAccessToken = null;
      return;
    }
    if (tokens.accessToken === this.nativeAccessToken) return;
    this._registerAccountSecret(tokens.accessToken);
    await this._accountRequest("accountLoginStart", {
      type: "chatgptAuthTokens", ...this._externalTokenParams(tokens),
    }, undefined, normalizeAccountLoginResponse);
    this.nativeAccountId = tokens.chatgptAccountId;
    this.nativeAccessToken = tokens.accessToken;
  }

  async accountLoginStart(params, options) {
    const browser = params?.type === "chatgpt"
      && exactObject(params, ["type", "codexStreamlinedLogin", "useHostedLoginSuccessPage", "appBrand"], ["type"])
      && (params.codexStreamlinedLogin === undefined || typeof params.codexStreamlinedLogin === "boolean")
      && (params.useHostedLoginSuccessPage === undefined || typeof params.useHostedLoginSuccessPage === "boolean")
      && (params.appBrand === undefined || params.appBrand === null
        || params.appBrand === "codex" || params.appBrand === "chatgpt");
    const device = params?.type === "chatgptDeviceCode" && exactObject(params, ["type"]);
    if (!browser && !device) {
      return Promise.reject(runtimeError(
        "CODEX_ACCOUNT_LOGIN_TYPE_UNSUPPORTED",
        "Only Codex-managed ChatGPT browser or device-code login is supported",
      ));
    }
    this.nativeAuth?.disable(this.runtimeEnvironment.home);
    if (this.nativeAuthPending) await this.nativeAuthPending;
    if (this.nativeAccessToken) await this._logoutAccount();
    this.nativeAccessToken = null;
    return this._accountRequest("accountLoginStart", params, options, normalizeAccountLoginResponse);
  }

  accountLoginApiKey(apiKey, options) {
    if (!wellFormedString(apiKey, 64 * 1024) || Buffer.byteLength(apiKey, "utf8") < 4) {
      return Promise.reject(runtimeError(
        "CODEX_ACCOUNT_PARAMS_INVALID",
        "Codex API key login parameters are invalid",
      ));
    }
    let updated;
    try {
      updated = validateRegisteredSecrets([...this.registeredSecrets, apiKey]);
      this.rpc?.registerSecret(apiKey);
    } catch (error) {
      return Promise.reject(error);
    }
    this.registeredSecrets = updated;
    return this._accountRequest(
      "accountLoginStart",
      { type: "apiKey", apiKey },
      options,
      normalizeAccountLoginResponse,
    );
  }

  accountLoginCancel(params, options) {
    if (!exactObject(params, ["loginId"]) || !wellFormedString(params.loginId, 256)) {
      return Promise.reject(runtimeError("CODEX_ACCOUNT_PARAMS_INVALID", "Codex account cancel params are invalid"));
    }
    return this._accountRequest("accountLoginCancel", params, options, (response) => {
      if (!exactObject(response, ["status"])
        || (response.status !== "canceled" && response.status !== "notFound")) throw accountProtocolError();
      return { status: response.status };
    });
  }

  async accountLogout(options) {
    this.nativeAuth?.disable(this.runtimeEnvironment.home);
    if (this.nativeAuthPending) await this.nativeAuthPending;
    const result = await this._logoutAccount(options);
    this.nativeAccessToken = null;
    return result;
  }

  _logoutAccount(options) {
    return this._accountRequest("accountLogout", undefined, options, (response) => {
      if (!exactObject(response, [], [])) throw accountProtocolError();
      return {};
    });
  }

  async _markFatal(error) {
    if (this.fatalError) return this.stopping;
    this.fatalError = error?.code ? error : rpcError("CODEX_PROTOCOL_FAILED", "Codex protocol failed");
    let cleanupError = null;
    try { await this._stop(true); } catch (error_) { cleanupError = error_; }
    if (!cleanupError) {
      this._rejectTerminated(this.fatalError);
      return;
    }
    const cleanupErrors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
    this.cleanupIncomplete = this.cleanupIncomplete
      || cleanupErrors.some((entry) => entry?.code === "CODEX_PROCESS_CLOSE_TIMEOUT");
    const aggregate = new AggregateError(
      [this.fatalError, ...cleanupErrors],
      "Codex runtime failed and process cleanup did not complete",
    );
    aggregate.code = "CODEX_RUNTIME_FATAL_CLEANUP_FAILED";
    aggregate.cleanupIncomplete = this.cleanupIncomplete;
    this._rejectTerminated(aggregate);
  }

  stop() {
    return this._stop(false);
  }

  _clearSecretReferences() {
    this.nativeAccessToken = null;
    this.registeredSecrets = [];
    try {
      if (this.options.spawnEnv && typeof this.options.spawnEnv === "object") {
        for (const key of Object.keys(this.options.spawnEnv)) {
          try { this.options.spawnEnv[key] = null; } catch {}
        }
      }
    } catch {}
    this.options.spawnEnv = {};
    this.options.registeredSecrets = [];
  }

  async _waitForProcessGroupExit(pid) {
    const deadline = Date.now() + this.killGraceMs;
    while (true) {
      let exists;
      try {
        exists = this.processGroupExists(pid);
      } catch {
        throw runtimeError(
          "CODEX_PROCESS_GROUP_PROBE_FAILED",
          "Codex process group cleanup could not be verified",
        );
      }
      if (!exists) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(10, remaining));
    }
  }

  _stop(fromFatal) {
    if (this.stopping) return this.stopping;
    if (!fromFatal) {
      this.stopRequested = true;
      this.startupGeneration += 1;
      this.startupAbortController?.abort();
    }
    const pendingStartup = !fromFatal && this.starting && !this.child && !this.rpc
      ? this.starting
      : null;
    if (!this.child && !this.rpc && !pendingStartup) {
      this.state = "stopped";
      this._clearSecretReferences();
      if (!fromFatal && !this.fatalError) this._resolveTerminated();
      this.stopping = Promise.resolve();
      return this.stopping;
    }
    this.state = "stopping";
    this.stopping = (async () => {
      const errors = [];
      const child = this.child;
      const rpc = this.rpc;
      let processClosed = !child?.pid;
      try {
        if (pendingStartup) await pendingStartup.catch(() => {});
        try { await rpc?.terminate("host stopping"); } catch (error) { errors.push(error); }
        try { child?.stdin?.end(); } catch (error) { errors.push(error); }
        if (child?.pid) {
          try {
            this.killProcessGroup(child.pid, "SIGTERM");
          } catch {
            this.cleanupIncomplete = true;
            errors.push(runtimeError("CODEX_PROCESS_TERMINATION_FAILED", "Codex process group termination failed"));
          }
          const closedAfterTerm = await Promise.race([
            (this.childClose || Promise.resolve()).then(() => true),
            delay(this.shutdownGraceMs).then(() => false),
          ]);
          let groupExists = true;
          try {
            groupExists = this.processGroupExists(child.pid);
          } catch {
            this.cleanupIncomplete = true;
            errors.push(runtimeError("CODEX_PROCESS_GROUP_PROBE_FAILED", "Codex process group cleanup could not be verified"));
          }
          if (groupExists) {
            try {
              this.killProcessGroup(child.pid, "SIGKILL");
            } catch {
              this.cleanupIncomplete = true;
              errors.push(runtimeError("CODEX_PROCESS_TERMINATION_FAILED", "Codex process group termination failed"));
            }
          }
          if (groupExists) {
            try {
              const groupClosed = await this._waitForProcessGroupExit(child.pid);
              if (!groupClosed) {
                this.cleanupIncomplete = true;
                errors.push(runtimeError(
                  "CODEX_PROCESS_GROUP_CLOSE_TIMEOUT",
                  "Codex process group still exists after SIGKILL",
                ));
              }
            } catch (error) {
              this.cleanupIncomplete = true;
              errors.push(error);
            }
          }
          const closedAfterKill = closedAfterTerm || await Promise.race([
            (this.childClose || Promise.resolve()).then(() => true),
            delay(this.killGraceMs).then(() => false),
          ]);
          processClosed = closedAfterKill;
          if (!closedAfterKill) {
            this.cleanupIncomplete = true;
            errors.push(runtimeError("CODEX_PROCESS_CLOSE_TIMEOUT", "Codex app-server did not close after termination"));
          }
        }
      } catch (error) {
        errors.push(error);
      } finally {
        this.child = processClosed ? null : child;
        this.rpc = null;
        this._clearSecretReferences();
        this.state = this.fatalError ? "failed" : "stopped";
        if (!this.fatalError) this._resolveTerminated();
      }
      if (errors.length > 0) {
        const aggregate = new AggregateError(errors, "Codex runtime shutdown failed");
        aggregate.code = "CODEX_RUNTIME_STOP_FAILED";
        throw aggregate;
      }
    })();
    return this.stopping;
  }
}

module.exports = {
  CodexRuntimeHost,
  defaultKillProcessGroup,
  defaultProcessGroupExists,
};
