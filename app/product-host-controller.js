"use strict";

const { validateChatServiceResult } = require("./agent-service/chat-service-protocol");
const { validateProfileServiceResult } = require("./agent-service/profile-service-protocol");
const {
  validateRuntimeAccountServiceParams,
  validateRuntimeAccountServiceResult,
} = require("./agent-service/runtime-account-service-protocol");
const { serviceError } = require("./agent-service/security");
const { validStopImpact } = require("./agent-service/stop-impact");
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("./agent-service/runtime-account");

const PROVIDER_KINDS = new Set([
  "openai-api-key", "openrouter", "ollama", "lmstudio", "custom-responses",
  "amazon-bedrock",
]);
const VALIDATION_STATUSES = new Set([
  "unverified", "protocol_valid", "agent_compatible", "invalid",
]);
const BACKGROUND_ACTIONS = new Set(["install", "start", "stop", "repair"]);
const BACKGROUND_UNAVAILABLE_REASONS = new Set([
  "unsupported-platform",
  "unstable-install-location",
  "status-unavailable",
]);
const MAX_PROVIDER_ROWS = 256;
const MAX_PROVIDER_BYTES = 1024 * 1024;
const MAX_MODEL_PAGES = 16;
const MAX_MODEL_ROWS = 512;
const MAX_MODEL_BYTES = 1024 * 1024;
const MAX_RUNTIME_ACCOUNT_PAGES = 16;
const MAX_RUNTIME_ACCOUNT_ROWS = 512;
const MAX_RUNTIME_ACCOUNT_BYTES = 2 * 1024 * 1024;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function hostError(code, message) {
  return serviceError(code, message);
}

function ownDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}

function exactObject(value, fields) {
  return ownDataObject(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function data(value, key) {
  if (!ownDataObject(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function safeString(value, maxBytes, nullable = false) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function providerAuthState(provider) {
  if (["ollama", "lmstudio"].includes(provider.kind)) return "not_required";
  if (["chatgpt", "amazon-bedrock"].includes(provider.kind)) return "authority";
  return provider.credentialRef === null ? "missing" : "configured";
}

function baseUrlHost(value) {
  if (value === null) return null;
  let parsed;
  try { parsed = new URL(value); } catch {
    throw hostError("HOST_PROVIDER_RESPONSE_INVALID", "Provider URL is invalid");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname) {
    throw hostError("HOST_PROVIDER_RESPONSE_INVALID", "Provider URL is invalid");
  }
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
}

function projectSafeProvider(value) {
  const fields = [
    "id", "kind", "name", "baseUrl", "model", "credentialRef", "headers",
    "awsRegion", "awsProfile", "validationStatus",
  ];
  if (!exactObject(value, fields)) {
    throw hostError("HOST_PROVIDER_RESPONSE_INVALID", "Provider response is invalid");
  }
  const provider = Object.fromEntries(fields.map((field) => [field, data(value, field)]));
  if (!safeString(provider.id, 128) || !PROVIDER_KINDS.has(provider.kind)
    || !safeString(provider.name, 512) || !safeString(provider.baseUrl, 4096, true)
    || !safeString(provider.model, 1024, true)
    || !safeString(provider.credentialRef, 128, true)
    || !VALIDATION_STATUSES.has(provider.validationStatus)) {
    throw hostError("HOST_PROVIDER_RESPONSE_INVALID", "Provider response is invalid");
  }
  const host = baseUrlHost(provider.baseUrl);
  // The custom endpoint editor needs the full API root. Never project URL
  // credentials, query strings or fragments from legacy/malformed records.
  const customUrl = provider.kind === "custom-responses" && provider.baseUrl
    ? new URL(provider.baseUrl) : null;
  const editableBaseUrl = customUrl && !customUrl.username && !customUrl.password
    && !customUrl.search && !customUrl.hash ? provider.baseUrl : null;
  return {
    id: provider.id,
    kind: provider.kind,
    displayName: provider.name,
    ...(host ? { baseUrlHost: host } : {}),
    ...(editableBaseUrl ? { baseUrl: editableBaseUrl } : {}),
    authState: providerAuthState(provider),
    ...(provider.model ? { defaultModel: provider.model } : {}),
    validationStatus: provider.validationStatus,
  };
}

function projectServiceStatus(value) {
  if (!ownDataObject(value) || data(value, "healthy") !== true
    || !Number.isSafeInteger(data(value, "protocolVersion"))
    || !safeString(data(value, "serviceVersion"), 128)
    || !Number.isSafeInteger(data(value, "startedAt"))) {
    throw hostError("HOST_SERVICE_STATUS_INVALID", "Service status response is invalid");
  }
  const domain = data(value, "domainAvailability");
  const domainAvailable = (name) => {
    const entry = data(domain, name);
    if (typeof entry === "boolean") return entry;
    return ownDataObject(entry) && typeof data(entry, "available") === "boolean"
      ? data(entry, "available") : null;
  };
  const kanbanAvailable = ownDataObject(domain) ? domainAvailable("kanban") : null;
  const cronAvailable = ownDataObject(domain) ? domainAvailable("cron") : null;
  if (kanbanAvailable === null || cronAvailable === null) {
    throw hostError("HOST_SERVICE_STATUS_INVALID", "Service domain status is invalid");
  }
  return {
    healthy: true,
    protocolVersion: data(value, "protocolVersion"),
    serviceVersion: data(value, "serviceVersion"),
    startedAt: data(value, "startedAt"),
    domainAvailability: {
      kanban: kanbanAvailable,
      cron: cronAvailable,
    },
    pendingCommandsLocked: data(value, "pendingCommandsLocked") === true,
    mcpCredentialsLocked: data(value, "mcpCredentialsLocked") === true,
  };
}

function unavailableServiceStatus() {
  return {
    healthy: false,
    domainAvailability: { kanban: false, cron: false },
    // Service 不可达时无法证明持久敏感状态已解锁，必须按锁定处理。
    pendingCommandsLocked: true,
    mcpCredentialsLocked: true,
  };
}

function unavailableBackgroundStatus(reason = "status-unavailable") {
  return {
    supported: false,
    reason: BACKGROUND_UNAVAILABLE_REASONS.has(reason) ? reason : "status-unavailable",
  };
}

function projectBackgroundStatus(value) {
  if (!ownDataObject(value) || typeof data(value, "supported") !== "boolean") {
    throw hostError("HOST_BACKGROUND_STATUS_INVALID", "Background status response is invalid");
  }
  if (data(value, "supported") === false) {
    const reason = data(value, "reason");
    return unavailableBackgroundStatus(typeof reason === "string" ? reason : "unsupported-platform");
  }
  for (const field of ["installed", "enabled", "loaded", "needsRepair"]) {
    if (typeof data(value, field) !== "boolean") {
      throw hostError("HOST_BACKGROUND_STATUS_INVALID", "Background status response is invalid");
    }
  }
  return {
    supported: true,
    installed: data(value, "installed"),
    enabled: data(value, "enabled"),
    loaded: data(value, "loaded"),
    needsRepair: data(value, "needsRepair"),
  };
}

function profileSummary(profile, ready) {
  return {
    id: profile.id,
    name: profile.name,
    isDefault: profile.isDefault === true,
    configuredProviderId: profile.providerRef,
    defaultModel: profile.defaultModel,
    ready,
  };
}

function validateMutationIdentity(input, fields) {
  const targetedFields = [...fields, "profileId"];
  const profileId = exactObject(input, fields) ? null
    : exactObject(input, targetedFields) ? data(input, "profileId") : undefined;
  if (profileId === undefined || (profileId !== null
    && (!safeString(profileId, 128) || !OPAQUE_ID_PATTERN.test(profileId)))
    || !safeString(data(input, "operationId"), 128)
    || !OPAQUE_ID_PATTERN.test(data(input, "operationId"))
    || !Number.isSafeInteger(data(input, "createdAt")) || data(input, "createdAt") < 0) {
    throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Provider onboarding parameters are invalid");
  }
  return profileId;
}

function normalizeProviderConfiguration(input) {
  const fields = ["id", "kind", "name", "model", "baseUrl", "awsRegion", "awsProfile"];
  if (!exactObject(input, fields)) {
    throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Provider onboarding parameters are invalid");
  }
  const provider = Object.fromEntries(fields.map((field) => [field, data(input, field)]));
  if (!safeString(provider.id, 128) || !OPAQUE_ID_PATTERN.test(provider.id)
    || !PROVIDER_KINDS.has(provider.kind) || !safeString(provider.name, 512)
    || !safeString(provider.model, 1024) || !safeString(provider.baseUrl, 4096, true)
    || !safeString(provider.awsRegion, 128, true) || !safeString(provider.awsProfile, 128, true)) {
    throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Provider onboarding parameters are invalid");
  }
  const common = { id: provider.id, kind: provider.kind, name: provider.name, model: provider.model };
  if (provider.kind === "custom-responses") {
    if (provider.baseUrl === null || provider.awsRegion !== null || provider.awsProfile !== null) {
      throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Custom Responses configuration is invalid");
    }
    return { ...common, baseUrl: provider.baseUrl };
  }
  if (provider.kind === "amazon-bedrock") {
    if (provider.baseUrl !== null) {
      throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Bedrock configuration is invalid");
    }
    return { ...common, awsRegion: provider.awsRegion, awsProfile: provider.awsProfile };
  }
  if (provider.baseUrl !== null || provider.awsRegion !== null || provider.awsProfile !== null) {
    throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Provider preset configuration is invalid");
  }
  return common;
}

function safeAuthUrl(value) {
  if (!safeString(value, 4096)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch { return false; }
}

function validateRuntimeHostInput(method, input) {
  try { return validateRuntimeAccountServiceParams(method, input); } catch {
    throw hostError("HOST_RUNTIME_ACCOUNT_PARAMS_INVALID", "Runtime account parameters are invalid");
  }
}

function projectRuntimeResult(method, value) {
  try { return validateRuntimeAccountServiceResult(method, value); } catch {
    throw hostError("HOST_RUNTIME_ACCOUNT_RESPONSE_INVALID", "Runtime account response is invalid");
  }
}

function createProductHostController(options = {}) {
  if (typeof options.serviceRequest !== "function" || !options.launchAgent
    || typeof options.launchAgent.status !== "function") {
    throw hostError("HOST_CONTROLLER_DEPENDENCY_REQUIRED", "Product host dependencies are required");
  }
  if (options.onProfileConfigured !== undefined
    && typeof options.onProfileConfigured !== "function") {
    throw hostError("HOST_CONTROLLER_DEPENDENCY_REQUIRED", "Profile refresh callback is invalid");
  }
  if (options.onBackgroundReady !== undefined
    && typeof options.onBackgroundReady !== "function") {
    throw hostError("HOST_CONTROLLER_DEPENDENCY_REQUIRED", "Background refresh callback is invalid");
  }
  const serviceRequest = options.serviceRequest;
  const launchAgent = options.launchAgent;
  const onProfileConfigured = options.onProfileConfigured || (() => {});
  const onBackgroundReady = options.onBackgroundReady || (() => {});
  let backgroundIntentGeneration = 0;
  let backgroundMaintenance = false;
  const backgroundStartupAuthorities = new WeakMap();

  function backgroundIntentIsCurrent(generation) {
    return generation === backgroundIntentGeneration;
  }

  function authorizeBackgroundStartup(status, generation) {
    backgroundStartupAuthorities.set(status, generation);
    return status;
  }

  async function readProfiles() {
    const profiles = [];
    const cursors = new Set();
    let cursor = null;
    let bytes = 0;
    for (let pageIndex = 0; pageIndex < 256; pageIndex += 1) {
      const raw = await serviceRequest("profile.list", {
        backendId: "shoggoth",
        cursor,
        limit: 100,
        enabledOnly: false,
      });
      let page;
      try { page = validateChatServiceResult("profile.list", raw); } catch {
        throw hostError("HOST_PROFILE_RESPONSE_INVALID", "Profile list response is invalid");
      }
      for (const profile of page.profiles) {
        bytes += Buffer.byteLength(JSON.stringify(profile), "utf8");
        profiles.push(profile);
        if (profiles.length > MAX_PROVIDER_ROWS || bytes > MAX_PROVIDER_BYTES) {
          throw hostError("HOST_PROFILE_RESPONSE_INVALID", "Profile list exceeds host budget");
        }
      }
      if (!page.hasMore) return profiles;
      if (page.nextCursor === null || page.nextCursor === cursor || cursors.has(page.nextCursor)) {
        throw hostError("HOST_PROFILE_RESPONSE_INVALID", "Profile cursor does not advance");
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw hostError("HOST_PROFILE_RESPONSE_INVALID", "Profile page limit exceeded");
  }

  async function profileAndAuth(profileId = null) {
    const profile = await configurableProfile(profileId);
    const auth = await serviceRequest("auth.read", { runtimeProfileId: profile.runtimeProfileId });
    if (!ownDataObject(auth) || !Object.prototype.hasOwnProperty.call(auth, "account")) {
      throw hostError("HOST_AUTH_RESPONSE_INVALID", "Account authority response is invalid");
    }
    const account = data(auth, "account");
    const type = account === null ? null : data(account, "type");
    if (type !== null && !["chatgpt", "apiKey", "amazonBedrock"].includes(type)) {
      throw hostError("HOST_AUTH_RESPONSE_INVALID", "Account authority response is invalid");
    }
    const authSource = data(auth, "authSource");
    return { profile, accountType: type,
      ...(type === "chatgpt" && authSource === "native-codex" ? { authSource } : {}),
    };
  }

  async function configurableProfile(profileId = null) {
    const profiles = await readProfiles();
    const candidates = profiles.filter((profile) => profile.enabled === true
      && profile.backendId === "shoggoth" && profile.runtime === "codex"
      && profile.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
    const matches = profileId === null
      ? candidates.filter((profile) => profile.isDefault === true)
      : candidates.filter((profile) => profile.id === profileId);
    if (matches.length !== 1) {
      throw hostError("HOST_PROFILE_RESPONSE_INVALID", "Shoggoth Codex profile is unavailable or ambiguous");
    }
    return matches[0];
  }

  async function assertProfileProviderMutationIsExclusive(profile, providerId) {
    const profiles = await readProfiles();
    if (profiles.some((candidate) => candidate.id !== profile.id
      && candidate.providerRef === providerId)) {
      throw hostError(
        "HOST_PROVIDER_TARGET_FORBIDDEN",
        "Provider configuration belongs to another Agent profile",
      );
    }
  }

  async function runtimeRequest(method, params) {
    const input = validateRuntimeHostInput(method, params);
    return projectRuntimeResult(method, await serviceRequest(method, input));
  }

  async function readAllRuntimePages(method, key, runtimeAccountId = undefined) {
    const items = [];
    const itemIds = new Set();
    const cursors = new Set();
    let cursor = null;
    let bytes = 0;
    for (let pageIndex = 0; pageIndex < MAX_RUNTIME_ACCOUNT_PAGES; pageIndex += 1) {
      const params = method === "runtime.account.list"
        || method === "runtime.account.backups.list"
        ? { cursor, limit: 100 }
        : { runtimeAccountId, cursor, limit: 100 };
      const page = await runtimeRequest(method, params);
      for (const item of page[key]) {
        if (itemIds.has(item.id)) {
          throw hostError(
            "HOST_RUNTIME_ACCOUNT_RESPONSE_INVALID",
            "Runtime account response contains duplicate identities",
          );
        }
        itemIds.add(item.id);
        bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
        items.push(item);
        if (items.length > MAX_RUNTIME_ACCOUNT_ROWS || bytes > MAX_RUNTIME_ACCOUNT_BYTES) {
          throw hostError(
            "HOST_RUNTIME_ACCOUNT_RESPONSE_INVALID",
            "Runtime account response exceeds host budget",
          );
        }
      }
      if (!page.hasMore) return items;
      if (page.nextCursor === null || page.nextCursor === cursor
        || cursors.has(page.nextCursor)) {
        throw hostError(
          "HOST_RUNTIME_ACCOUNT_RESPONSE_INVALID",
          "Runtime account cursor does not advance",
        );
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw hostError("HOST_RUNTIME_ACCOUNT_RESPONSE_INVALID", "Runtime account page limit exceeded");
  }

  const controller = {
    suspendBackgroundActions() {
      if (backgroundMaintenance) throw hostError("SERVICE_MAINTENANCE_BUSY", "Background maintenance is active");
      backgroundMaintenance = true;
      backgroundIntentGeneration += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        backgroundMaintenance = false;
        backgroundIntentGeneration += 1;
      };
    },
    async ensureBackgroundRunning() {
      if (backgroundMaintenance) throw hostError("SERVICE_QUIESCED", "Background maintenance is active");
      const intentGeneration = backgroundIntentGeneration;
      let initialRaw;
      try {
        initialRaw = await launchAgent.status();
      } catch (error) {
        if (!backgroundIntentIsCurrent(intentGeneration)) return null;
        throw error;
      }
      if (!backgroundIntentIsCurrent(intentGeneration)) return null;
      const current = projectBackgroundStatus(initialRaw);
      if (current.supported === false) {
        return authorizeBackgroundStartup(current, intentGeneration);
      }
      if (current.loaded === true && current.enabled === true && current.needsRepair === false) {
        try {
          const service = projectServiceStatus(await serviceRequest("service.status", {}));
          if (!backgroundIntentIsCurrent(intentGeneration)) return null;
          if (service.healthy === true) {
            return authorizeBackgroundStartup(current, intentGeneration);
          }
        } catch {
          if (!backgroundIntentIsCurrent(intentGeneration)) return null;
          // loaded 仅代表 launchd job 已注册；覆盖安装期间进程可能已退出或 socket 已失效。
        }
      }
      if (typeof launchAgent.start !== "function") {
        throw hostError("HOST_BACKGROUND_ACTION_INVALID", "Background start action is unavailable");
      }
      // 已安装应用首次打开即建立后台 Service；start() 同时覆盖安装、修复、启用与健康等待。
      // LaunchAgent 自身拥有唯一健康预算和一次有界重注册；Host 不能再叠加
      // 第二个 start 窗口，否则单次 UI 恢复可被放大到 90 秒以上。
      try {
        await launchAgent.start();
      } catch (error) {
        if (!backgroundIntentIsCurrent(intentGeneration)) return null;
        throw error;
      }
      if (!backgroundIntentIsCurrent(intentGeneration)) return null;
      let finalRaw;
      try {
        finalRaw = await launchAgent.status();
      } catch (error) {
        if (!backgroundIntentIsCurrent(intentGeneration)) return null;
        throw error;
      }
      if (!backgroundIntentIsCurrent(intentGeneration)) return null;
      return authorizeBackgroundStartup(projectBackgroundStatus(finalRaw), intentGeneration);
    },

    isBackgroundStartupCurrent(result) {
      return Boolean(result && typeof result === "object"
        && backgroundStartupAuthorities.get(result) === backgroundIntentGeneration);
    },

    async getStatus() {
      const [serviceResult, backgroundResult] = await Promise.allSettled([
        serviceRequest("service.status", {}),
        launchAgent.status(),
      ]);
      return {
        service: serviceResult.status === "fulfilled"
          ? projectServiceStatus(serviceResult.value)
          : unavailableServiceStatus(),
        // 后台安装状态和 Service 健康状态是两个独立信号，任一失败都不能遮蔽另一侧。
        background: backgroundResult.status === "fulfilled"
          ? projectBackgroundStatus(backgroundResult.value)
          : unavailableBackgroundStatus(),
      };
    },

    async listProviders(input = { profileId: null }) {
      if (!exactObject(input, ["profileId"]) || !safeString(data(input, "profileId"), 128, true)
        || (data(input, "profileId") !== null && !OPAQUE_ID_PATTERN.test(data(input, "profileId")))) {
        throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Provider profile selector is invalid");
      }
      const [raw, authority] = await Promise.all([
        serviceRequest("provider.list", {}),
        profileAndAuth(data(input, "profileId")),
      ]);
      if (!Array.isArray(raw)) {
        throw hostError("HOST_PROVIDER_RESPONSE_INVALID", "Provider list response is invalid");
      }
      const source = raw;
      if (source.length > MAX_PROVIDER_ROWS) {
        throw hostError("HOST_PROVIDER_RESPONSE_INVALID", "Provider list exceeds host budget");
      }
      const providers = source.map(projectSafeProvider);
      const chatgpt = {
        id: "chatgpt",
        kind: "chatgpt",
        displayName: "ChatGPT",
        authState: authority.accountType === "chatgpt" ? "authenticated" : "missing",
        ...(authority.authSource ? { authSource: authority.authSource } : {}),
        ...(authority.profile.providerRef === null && authority.profile.defaultModel
          ? { defaultModel: authority.profile.defaultModel } : {}),
      };
      return {
        profile: profileSummary(authority.profile, authority.profile.providerRef === null
            // A null model delegates to Codex's own default, just as chat does.
            // An authenticated account does not need another login/configuration.
            ? authority.accountType === "chatgpt"
            : providers.some((provider) => provider.id === authority.profile.providerRef
              && ["protocol_valid", "agent_compatible"].includes(provider.validationStatus))),
        providers: [chatgpt, ...providers],
      };
    },

    async listRuntimeAccounts() {
      const accounts = await readAllRuntimePages("runtime.account.list", "accounts");
      // The Service scans synchronously. Concurrent requests would spend their
      // timeout waiting behind other Homes, even when each scan is bounded.
      const storage = [];
      for (const account of accounts) {
        storage.push(await runtimeRequest("runtime.account.storage.read", {
          runtimeAccountId: account.id,
        }));
      }
      if (storage.some((item, index) => item.runtimeAccountId !== accounts[index].id)) {
        throw hostError(
          "HOST_RUNTIME_ACCOUNT_RESPONSE_INVALID",
          "Runtime account storage references are inconsistent",
        );
      }
      return { accounts: accounts.map((account, index) => ({ ...account, storage: storage[index] })) };
    },

    async readRuntimeAccount(input) {
      const params = validateRuntimeHostInput("runtime.account.read", input);
      const [{ account }, storage] = await Promise.all([
        runtimeRequest("runtime.account.read", params),
        runtimeRequest("runtime.account.storage.read", params),
      ]);
      if (account.id !== params.runtimeAccountId
        || storage.runtimeAccountId !== params.runtimeAccountId) {
        throw hostError(
          "HOST_RUNTIME_ACCOUNT_RESPONSE_INVALID",
          "Runtime account detail references are inconsistent",
        );
      }
      return { account, storage };
    },

    async readRuntimeAccountAuth(input) {
      const params = validateRuntimeHostInput("runtime.account.auth.read", input);
      return runtimeRequest("runtime.account.auth.read", params);
    },

    async startRuntimeAccountLogin(input) {
      const params = validateRuntimeHostInput("runtime.account.login.start", input);
      return runtimeRequest("runtime.account.login.start", params);
    },

    async cancelRuntimeAccountLogin(input) {
      const params = validateRuntimeHostInput("runtime.account.login.cancel", input);
      return runtimeRequest("runtime.account.login.cancel", params);
    },

    async logoutRuntimeAccount(input) {
      const params = validateRuntimeHostInput("runtime.account.logout", input);
      return runtimeRequest("runtime.account.logout", params);
    },

    async readRuntimeAccountStorage(input) {
      const params = validateRuntimeHostInput("runtime.account.storage.read", input);
      const storage = await runtimeRequest("runtime.account.storage.read", params);
      if (storage.runtimeAccountId !== params.runtimeAccountId) {
        throw hostError(
          "HOST_RUNTIME_ACCOUNT_RESPONSE_INVALID",
          "Runtime account storage reference is inconsistent",
        );
      }
      return storage;
    },

    async listChatGptModels(input = { profileId: null }) {
      if (!exactObject(input, ["profileId"]) || !safeString(data(input, "profileId"), 128, true)
        || (data(input, "profileId") !== null && !OPAQUE_ID_PATTERN.test(data(input, "profileId")))) {
        throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Provider profile selector is invalid");
      }
      const authority = await profileAndAuth(data(input, "profileId"));
      if (authority.accountType !== "chatgpt") {
        throw hostError("HOST_AUTH_REQUIRED", "ChatGPT is not authenticated");
      }
      const models = [];
      const cursors = new Set();
      let cursor = null;
      let bytes = 0;
      for (let pageIndex = 0; pageIndex < MAX_MODEL_PAGES; pageIndex += 1) {
        const raw = await serviceRequest("profile.models.list", {
          profileId: authority.profile.id,
          cursor,
          limit: 100,
        });
        let page;
        try { page = validateProfileServiceResult("profile.models.list", raw); } catch {
          throw hostError("HOST_MODEL_RESPONSE_INVALID", "ChatGPT model catalog response is invalid");
        }
        for (const model of page.models) {
          bytes += Buffer.byteLength(JSON.stringify(model), "utf8");
          models.push(model);
          if (models.length > MAX_MODEL_ROWS || bytes > MAX_MODEL_BYTES) {
            throw hostError("HOST_MODEL_RESPONSE_INVALID", "ChatGPT model catalog exceeds host budget");
          }
        }
        if (!page.hasMore) return { models };
        if (page.nextCursor === null || page.nextCursor === cursor || cursors.has(page.nextCursor)) {
          throw hostError("HOST_MODEL_RESPONSE_INVALID", "ChatGPT model catalog cursor does not advance");
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw hostError("HOST_MODEL_RESPONSE_INVALID", "ChatGPT model catalog page limit exceeded");
    },

    async getBackgroundStopImpact() {
      try {
        const impact = await serviceRequest("service.stopImpact", {});
        if (!validStopImpact(impact)) throw hostError("HOST_STOP_IMPACT_INVALID", "Invalid stop impact");
        return impact;
      } catch {
        // An unreachable/older Service is unknown, never evidence of zero runs.
        return { availability: "unavailable", revision: "unavailable", totalCount: null, runs: [] };
      }
    },

    async stopBackground(input) {
      if (!exactObject(input, ["revision"]) || typeof input.revision !== "string"
        || (input.revision !== "unavailable" && !/^[a-f0-9]{64}$/u.test(input.revision))) {
        throw hostError("SHOGGOTH_STOP_CONFIRMATION_REQUIRED", "Stop confirmation is required");
      }
      const intentGeneration = ++backgroundIntentGeneration;
      const latest = await controller.getBackgroundStopImpact();
      if (!backgroundIntentIsCurrent(intentGeneration) || latest.revision !== input.revision) {
        throw hostError("SHOGGOTH_STOP_IMPACT_CHANGED", "Stop impact changed; confirm again");
      }
      return controller.runBackgroundAction("stop");
    },

    async runBackgroundAction(action) {
      if (backgroundMaintenance) throw hostError("SERVICE_QUIESCED", "Background maintenance is active");
      // 手动操作代表新的用户意图；必须在任何 await 前同步失效自动启动和旧手动结果。
      const intentGeneration = ++backgroundIntentGeneration;
      const launchAction = action === "install" ? "start" : action;
      if (!BACKGROUND_ACTIONS.has(action) || typeof launchAgent[launchAction] !== "function") {
        throw hostError("HOST_BACKGROUND_ACTION_INVALID", "Background action is invalid");
      }
      // start() 自身先安全安装 plist，再 enable/bootstrap 并等待健康确认。
      // UI 的首次“安装后台运行”因此一次完成，不会停在已安装但仍未启动的中间态。
      await launchAgent[launchAction]();
      const status = await controller.getStatus();
      const canSignalReady = launchAction === "start" || action === "repair";
      const stillCurrent = () => backgroundIntentIsCurrent(intentGeneration);
      if (stillCurrent() && canSignalReady && status.service.healthy === true) {
        // 第二参数是 Host 内部代际 authority；旧的一参 callback 会自然忽略它。
        await Promise.resolve(onBackgroundReady(status, stillCurrent)).catch(() => {});
      }
      return status;
    },

    async configureProvider(input) {
      const profileId = validateMutationIdentity(
        input,
        ["operationId", "createdAt", "secret", "provider"],
      );
      const providerInput = normalizeProviderConfiguration(data(input, "provider"));
      const secret = data(input, "secret");
      const requiresSecret = new Set(["openai-api-key", "openrouter", "custom-responses"])
        .has(providerInput.kind);
      if ((requiresSecret && !safeString(secret, 64 * 1024))
        || (!requiresSecret && secret !== null)) {
        throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Provider credential input is invalid");
      }
      const profile = await configurableProfile(profileId);
      await assertProfileProviderMutationIsExclusive(profile, providerInput.id);
      const savedRaw = await serviceRequest("provider.save", { provider: providerInput });
      let projected = projectSafeProvider(savedRaw);
      let result;
      if (providerInput.kind === "openai-api-key") {
        result = await serviceRequest("profile.configure", {
          operationId: data(input, "operationId"),
          profileId: profile.id,
          providerRef: providerInput.id,
          defaultModel: providerInput.model,
          secret,
          createdAt: data(input, "createdAt"),
        });
        projected = {
          ...projected,
          authState: "configured",
          validationStatus: "protocol_valid",
        };
      } else {
        if (requiresSecret) {
          await serviceRequest("provider.secret.set", {
            providerId: providerInput.id,
            secret,
          });
        }
        await serviceRequest("provider.validate", {
          providerId: providerInput.id,
          level: "protocol",
        });
        result = await serviceRequest("profile.bind", {
          operationId: data(input, "operationId"),
          profileId: profile.id,
          providerRef: providerInput.id,
          defaultModel: providerInput.model,
          createdAt: data(input, "createdAt"),
        });
        projected = {
          ...projected,
          authState: requiresSecret ? "configured" : projected.authState,
          validationStatus: "protocol_valid",
        };
      }
      const configured = validateProfileServiceResult(
        providerInput.kind === "openai-api-key" ? "profile.configure" : "profile.bind",
        result,
      ).profile;
      await Promise.resolve(onProfileConfigured(configured)).catch(() => {});
      return {
        profile: profileSummary(configured, true),
        provider: projected,
      };
    },

    async bindChatGpt(input) {
      const profileId = validateMutationIdentity(
        input,
        ["operationId", "defaultModel", "createdAt"],
      );
      if (!safeString(data(input, "defaultModel"), 1024)) {
        throw hostError("HOST_PROVIDER_PARAMS_INVALID", "ChatGPT model is invalid");
      }
      const authority = await profileAndAuth(profileId);
      if (authority.accountType !== "chatgpt") {
        throw hostError("HOST_AUTH_REQUIRED", "ChatGPT is not authenticated");
      }
      const result = await serviceRequest("profile.bind", {
        operationId: data(input, "operationId"),
        profileId: authority.profile.id,
        providerRef: null,
        defaultModel: data(input, "defaultModel"),
        createdAt: data(input, "createdAt"),
      });
      const configured = validateProfileServiceResult("profile.bind", result).profile;
      await Promise.resolve(onProfileConfigured(configured)).catch(() => {});
      return { profile: profileSummary(configured, true) };
    },

    async clearProfileProvider(input) {
      const profileId = validateMutationIdentity(input, ["operationId", "createdAt"]);
      const profile = await configurableProfile(profileId);
      const result = await serviceRequest("profile.clear", {
        operationId: data(input, "operationId"),
        profileId: profile.id,
        providerRef: profile.providerRef,
        defaultModel: profile.defaultModel,
        createdAt: data(input, "createdAt"),
      });
      const configured = validateProfileServiceResult("profile.clear", result).profile;
      await Promise.resolve(onProfileConfigured(configured)).catch(() => {});
      return { profile: profileSummary(configured, false) };
    },

    async startChatGptLogin(input) {
      const profileId = exactObject(input, ["mode"]) ? null
        : exactObject(input, ["mode", "profileId"]) ? data(input, "profileId") : undefined;
      if (profileId === undefined || (profileId !== null
        && (!safeString(profileId, 128) || !OPAQUE_ID_PATTERN.test(profileId)))
        || data(input, "mode") !== "browser") {
        throw hostError("HOST_AUTH_PARAMS_INVALID", "ChatGPT login parameters are invalid");
      }
      const profile = await configurableProfile(profileId);
      const result = await serviceRequest("auth.login.start", {
        runtimeProfileId: profile.runtimeProfileId,
        mode: "browser",
      });
      if (!ownDataObject(result) || data(result, "mode") !== "browser"
        || !["waiting", "succeeded", "failed"].includes(data(result, "status"))
        || !safeAuthUrl(data(result, "authUrl"))) {
        throw hostError("HOST_AUTH_RESPONSE_INVALID", "ChatGPT login response is invalid");
      }
      return {
        mode: "browser",
        status: data(result, "status"),
        authUrl: data(result, "authUrl"),
      };
    },
  };
  return controller;
}

module.exports = {
  createProductHostController,
  projectSafeProvider,
};
