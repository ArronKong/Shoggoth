"use strict";

const { validateChatServiceResult } = require("./agent-service/chat-service-protocol");
const { validateProfileServiceResult } = require("./agent-service/profile-service-protocol");
const { serviceError } = require("./agent-service/security");

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
  if (["openai-api-key", "amazon-bedrock"].includes(provider.kind)) return "authority";
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
  return {
    id: provider.id,
    kind: provider.kind,
    displayName: provider.name,
    ...(host ? { baseUrlHost: host } : {}),
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
    name: profile.name,
    configuredProviderId: profile.providerRef,
    defaultModel: profile.defaultModel,
    ready,
  };
}

function validateMutationIdentity(input, fields) {
  if (!exactObject(input, fields) || !safeString(data(input, "operationId"), 128)
    || !OPAQUE_ID_PATTERN.test(data(input, "operationId"))
    || !Number.isSafeInteger(data(input, "createdAt")) || data(input, "createdAt") < 0) {
    throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Provider onboarding parameters are invalid");
  }
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

function createProductHostController(options = {}) {
  if (typeof options.serviceRequest !== "function" || !options.launchAgent
    || typeof options.launchAgent.status !== "function") {
    throw hostError("HOST_CONTROLLER_DEPENDENCY_REQUIRED", "Product host dependencies are required");
  }
  const serviceRequest = options.serviceRequest;
  const launchAgent = options.launchAgent;

  async function readProfiles() {
    const profiles = [];
    const cursors = new Set();
    let cursor = null;
    let bytes = 0;
    for (let pageIndex = 0; pageIndex < 256; pageIndex += 1) {
      const raw = await serviceRequest("profile.list", { cursor, limit: 100, enabledOnly: false });
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

  async function defaultProfileAndAuth() {
    const profiles = await readProfiles();
    const defaults = profiles.filter((profile) => profile.isDefault === true && profile.enabled === true);
    if (defaults.length !== 1) {
      throw hostError("HOST_PROFILE_RESPONSE_INVALID", "Default Shoggoth profile is ambiguous");
    }
    const profile = defaults[0];
    const auth = await serviceRequest("auth.read", { runtimeProfileId: profile.runtimeProfileId });
    if (!ownDataObject(auth) || !Object.prototype.hasOwnProperty.call(auth, "account")) {
      throw hostError("HOST_AUTH_RESPONSE_INVALID", "Account authority response is invalid");
    }
    const account = data(auth, "account");
    const type = account === null ? null : data(account, "type");
    if (type !== null && !["chatgpt", "apiKey", "amazonBedrock"].includes(type)) {
      throw hostError("HOST_AUTH_RESPONSE_INVALID", "Account authority response is invalid");
    }
    return { profile, accountType: type };
  }

  async function defaultProfile() {
    const profiles = await readProfiles();
    const defaults = profiles.filter((profile) => profile.isDefault === true && profile.enabled === true);
    if (defaults.length !== 1) {
      throw hostError("HOST_PROFILE_RESPONSE_INVALID", "Default Shoggoth profile is ambiguous");
    }
    return defaults[0];
  }

  const controller = {
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

    async listProviders() {
      const [raw, authority] = await Promise.all([
        serviceRequest("provider.list", {}),
        defaultProfileAndAuth(),
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
        ...(authority.profile.providerRef === null && authority.profile.defaultModel
          ? { defaultModel: authority.profile.defaultModel } : {}),
      };
      return {
        profile: {
          name: authority.profile.name,
          configuredProviderId: authority.profile.providerRef,
          defaultModel: authority.profile.defaultModel,
          ready: authority.profile.providerRef === null
            ? authority.accountType === "chatgpt" && authority.profile.defaultModel !== null
            : providers.some((provider) => provider.id === authority.profile.providerRef
              && ["protocol_valid", "agent_compatible"].includes(provider.validationStatus)),
        },
        providers: [chatgpt, ...providers],
      };
    },

    async runBackgroundAction(action) {
      if (!BACKGROUND_ACTIONS.has(action) || typeof launchAgent[action] !== "function") {
        throw hostError("HOST_BACKGROUND_ACTION_INVALID", "Background action is invalid");
      }
      await launchAgent[action]();
      return controller.getStatus();
    },

    async configureProvider(input) {
      validateMutationIdentity(input, ["operationId", "createdAt", "secret", "provider"]);
      const providerInput = normalizeProviderConfiguration(data(input, "provider"));
      const secret = data(input, "secret");
      const requiresSecret = new Set(["openai-api-key", "openrouter", "custom-responses"])
        .has(providerInput.kind);
      if ((requiresSecret && !safeString(secret, 64 * 1024))
        || (!requiresSecret && secret !== null)) {
        throw hostError("HOST_PROVIDER_PARAMS_INVALID", "Provider credential input is invalid");
      }
      const profile = await defaultProfile();
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
      return {
        profile: profileSummary(configured, true),
        provider: projected,
      };
    },

    async bindChatGpt(input) {
      validateMutationIdentity(input, ["operationId", "defaultModel", "createdAt"]);
      if (!safeString(data(input, "defaultModel"), 1024)) {
        throw hostError("HOST_PROVIDER_PARAMS_INVALID", "ChatGPT model is invalid");
      }
      const authority = await defaultProfileAndAuth();
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
      return { profile: profileSummary(configured, true) };
    },

    async startChatGptLogin(input) {
      if (!exactObject(input, ["mode"]) || data(input, "mode") !== "browser") {
        throw hostError("HOST_AUTH_PARAMS_INVALID", "ChatGPT login parameters are invalid");
      }
      const profile = await defaultProfile();
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
