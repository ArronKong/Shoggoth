"use strict";

const { modelCapabilities } = require("./chat-model-settings");

const crypto = require("node:crypto");
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("./runtime-account");
const {
  readRuntimeAuthenticationState,
  runtimeBinding,
} = require("./runtime-adapter");
const { serviceError } = require("./security");
const {
  PUBLIC_MESSAGES,
  mapProfileServiceError,
  validateProfileServiceParams,
  validateProfileServiceResult,
} = require("./profile-service-protocol");

const READY_PROVIDER_STATUSES = new Set(["protocol_valid", "agent_compatible"]);
const MAX_OPERATION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_MODEL_PAGES = 16;
const MAX_MODEL_ITEMS = 512;
const MAX_MODEL_BYTES = 1024 * 1024;

function profileError(code, message) {
  return serviceError(code, message);
}

function operationIdentity(method, params) {
  const secretDigest = method === "profile.configure"
    ? crypto.createHash("sha256").update(params.secret, "utf8").digest("hex") : null;
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    method,
    operationId: params.operationId,
    profileId: params.profileId,
    providerRef: params.providerRef,
    defaultModel: params.defaultModel,
    createdAt: params.createdAt,
    secretDigest,
  })).digest("hex");
  const bytes = crypto.createHash("sha256")
    .update("shoggoth-profile-service-v1\0", "utf8")
    .update(params.operationId, "utf8")
    .digest().subarray(0, 16);
  // Version 8 is reserved for this deterministic namespace; external MCP calls use random UUIDs.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const callId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { fingerprint, secretDigest, callId };
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dataErrorCode(error) {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && typeof descriptor.value === "string" && descriptor.value.length <= 128
      ? descriptor.value : null;
  } catch {
    return null;
  }
}

function requireMethods(value, methods, label) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw profileError("PROFILE_CONTROLLER_DEPENDENCY_REQUIRED", `${label} dependency is invalid`);
  }
}

function createProfileServiceController(options = {}) {
  requireMethods(
    options.productStore,
    [
      "getAgentProfile", "getModelProvider", "putAgentProfile", "getRuntimeAccount",
      "listAgentProfiles", "lookupMcpToolCall", "beginMcpToolCall",
      "completeMcpToolCall",
    ],
    "ProductStore",
  );
  const runtimeManager = options.runtimeManager || (options.runtimePool && {
    acquire: ({ runtimeProfileId }) => options.runtimePool.get(runtimeProfileId),
    stop: ({ runtimeProfileId }) => options.runtimePool.stop(runtimeProfileId),
  });
  requireMethods(runtimeManager, ["acquire", "stop"], "RuntimeManager");
  requireMethods(options.accountAuthManager, ["read"], "AccountAuthManager");
  requireMethods(
    options.providerBootstrap,
    ["configureOpenAiApiKey", "clearUnreferencedOpenAiApiKey"],
    "ProviderBootstrap",
  );
  if (options.now !== undefined && typeof options.now !== "function") {
    throw profileError("PROFILE_CONTROLLER_DEPENDENCY_REQUIRED", "now dependency is invalid");
  }
  const maxOperations = options.maxOperations ?? 1024;
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 8192) {
    throw profileError("PROFILE_CONTROLLER_DEPENDENCY_REQUIRED", "maxOperations is invalid");
  }
  const productStore = options.productStore;
  const accountAuthManager = options.accountAuthManager;
  const providerBootstrap = options.providerBootstrap;
  const now = options.now || Date.now;
  const inFlight = new Map();
  let lifecycleGeneration = 0;
  let state = "closed";
  let tail = Promise.resolve();
  let poisonError = null;

  function assertAccepting(generation = lifecycleGeneration) {
    if (poisonError) throw poisonError;
    if (state !== "open" || generation !== lifecycleGeneration) {
      throw profileError("PROFILE_SERVICE_CLOSED", "Profile controller is closed");
    }
  }

  function poison(primaryError, errors = []) {
    if (!poisonError) {
      const error = errors.length > 0
        ? new AggregateError([primaryError, ...errors], "Profile mutation commit is uncertain")
        : profileError("PROFILE_COMMIT_UNCERTAIN", "Profile mutation commit is uncertain");
      error.code = "PROFILE_COMMIT_UNCERTAIN";
      poisonError = error;
    }
    return poisonError;
  }

  function assertTimestamp(createdAt, timestamp) {
    if (createdAt < timestamp - MAX_OPERATION_AGE_MS || createdAt > timestamp + MAX_FUTURE_SKEW_MS) {
      throw profileError("PROFILE_OPERATION_EXPIRED", "Profile operation timestamp is outside the replay window");
    }
  }

  function loadEnabledProfile(profileId) {
    const profile = productStore.getAgentProfile(profileId);
    if (!profile) throw profileError("PROFILE_NOT_FOUND", "Agent profile was not found");
    if (profile.enabled !== true) {
      throw profileError("PROFILE_TARGET_FORBIDDEN", "Agent profile is not available");
    }
    try {
      runtimeBinding({
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
      });
    } catch {
      throw profileError("PROFILE_TARGET_FORBIDDEN", "Agent profile runtime binding is invalid");
    }
    return profile;
  }

  function loadConfigurableProfile(profileId) {
    const profile = loadEnabledProfile(profileId);
    if (profile.backendId !== "shoggoth" || profile.runtime !== "codex"
      || profile.runtimeAccountId !== SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
      || profile.enabled !== true) {
      throw profileError("PROFILE_TARGET_FORBIDDEN", "Shoggoth Codex profile identity is invalid");
    }
    return profile;
  }

  function loadReadyProvider(providerRef, defaultModel) {
    const provider = productStore.getModelProvider(providerRef);
    if (!provider) throw profileError("PROFILE_PROVIDER_NOT_FOUND", "Provider was not found");
    if (!READY_PROVIDER_STATUSES.has(provider.validationStatus)) {
      throw profileError("PROFILE_PROVIDER_NOT_READY", "Provider has not passed protocol validation");
    }
    if (provider.model !== defaultModel && !(provider.kind === "custom-responses" && provider.models?.includes(defaultModel))) {
      throw profileError("PROFILE_MODEL_MISMATCH", "Default model does not match provider configuration");
    }
    return provider;
  }

  function assertOpenAiProviderIsExclusive(profileId, provider) {
    if (provider?.kind !== "openai-api-key") return;
    const foreignOwner = productStore.listAgentProfiles()
      .find((candidate) => candidate.id !== profileId && candidate.providerRef === provider.id);
    if (foreignOwner) {
      throw profileError(
        "PROFILE_PROVIDER_TARGET_FORBIDDEN",
        "OpenAI provider is already bound to another Profile",
      );
    }
  }

  function assertProfileStillCurrent(snapshot, generation) {
    assertAccepting(generation);
    const current = productStore.getAgentProfile(snapshot.id);
    if (!current || !sameSnapshot(current, snapshot)) {
      throw profileError("PROFILE_OPERATION_CONFLICT", "Profile changed during configuration");
    }
    return current;
  }

  async function stopRuntimeProfile(profile) {
    try {
      await runtimeManager.stop(runtimeBinding({
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
      }));
    } catch (error) {
      throw poison(error);
    }
  }

  function ownDataValue(value, key) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value : undefined;
  }

  function normalizeModelPage(raw) {
    const data = ownDataValue(raw, "data");
    const rawCursor = ownDataValue(raw, "nextCursor");
    const nextCursor = rawCursor === undefined ? null : rawCursor;
    if (!Array.isArray(data) || data.length > 100
      || (nextCursor !== null && (typeof nextCursor !== "string"
        || Buffer.byteLength(nextCursor, "utf8") > 1024))) {
      throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog response is invalid");
    }
    const models = data.flatMap((model) => {
      const id = ownDataValue(model, "model");
      const displayName = ownDataValue(model, "displayName");
      const description = ownDataValue(model, "description");
      const isDefault = ownDataValue(model, "isDefault");
      const hidden = ownDataValue(model, "hidden");
      if (typeof id !== "string" || id.length === 0 || !id.isWellFormed() || id.includes("\0")
        || Buffer.byteLength(id, "utf8") > 512
        || typeof displayName !== "string" || displayName.length === 0
        || !displayName.isWellFormed() || displayName.includes("\0")
        || Buffer.byteLength(displayName, "utf8") > 512
        || typeof description !== "string" || !description.isWellFormed() || description.includes("\0")
        || Buffer.byteLength(description, "utf8") > 4096
        || typeof isDefault !== "boolean" || typeof hidden !== "boolean") {
        throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog item is invalid");
      }
      const capabilities = modelCapabilities(model);
      return hidden ? [] : [{ id, displayName, description, isDefault,
        ...(capabilities.thinkingOptions.length || capabilities.fastTier ? { capabilities } : {}) }];
    });
    return validateProfileServiceResult("profile.models.list", {
      models,
      nextCursor,
      hasMore: nextCursor !== null,
    });
  }

  async function readAuthorityModelPage(profile, pageParams, generation) {
    let auth;
    try {
      auth = await accountAuthManager.read({ runtimeProfileId: profile.runtimeProfileId });
    } catch {
      throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "ChatGPT authority could not be read");
    }
    assertProfileStillCurrent(profile, generation);
    if (auth?.account?.type !== "chatgpt") {
      throw profileError("PROFILE_AUTH_REQUIRED", "ChatGPT authority is not authenticated");
    }
    let host;
    let raw;
    try {
      host = await runtimeManager.acquire(runtimeBinding({
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
      }), { permissionPolicy: profile.permissionPolicy });
      const listModels = typeof host.modelsList === "function"
        ? host.modelsList.bind(host) : host.modelList?.bind(host);
      if (!listModels) throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "Runtime model catalog is unavailable");
      raw = await listModels({
        cursor: pageParams.cursor,
        limit: pageParams.limit,
        includeHidden: false,
      });
    } catch {
      throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is unavailable");
    }
    assertProfileStillCurrent(profile, generation);
    return normalizeModelPage(raw);
  }

  async function readRuntimeModelPage(profile, pageParams, generation) {
    if (profile.runtime === "codex" && profile.providerRef !== null) {
      const provider = productStore.getModelProvider(profile.providerRef);
      if (provider?.kind === "custom-responses") {
        loadReadyProvider(provider.id, profile.defaultModel);
        const models = provider.models ?? [provider.model];
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify(models)).digest("hex").slice(0, 16);
        const prefix = `custom-${fingerprint}-`;
        const cursor = pageParams.cursor;
        const offset = cursor === null ? 0 : Number(cursor.slice(prefix.length));
        if (cursor !== null && (!cursor.startsWith(prefix) || !Number.isSafeInteger(offset)
          || offset < 0 || offset >= models.length || cursor !== `${prefix}${offset}`)) {
          throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "Custom model catalog cursor is invalid");
        }
        const page = models.slice(offset, offset + pageParams.limit);
        const nextCursor = offset + page.length < models.length ? `${prefix}${offset + page.length}` : null;
        return { models: page.map((id) => ({ id, displayName: id, description: "", isDefault: id === profile.defaultModel })),
          nextCursor, hasMore: nextCursor !== null };
      }
    }
    if (profile.runtime === "codex") {
      return readAuthorityModelPage(profile, pageParams, generation);
    }
    let host;
    let raw;
    try {
      host = await runtimeManager.acquire(runtimeBinding({
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
      }), { permissionPolicy: profile.permissionPolicy });
      const listModels = typeof host.modelsList === "function"
        ? host.modelsList.bind(host) : host.modelList?.bind(host);
      if (!listModels) {
        throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "Runtime model catalog is unavailable");
      }
      raw = await listModels({
        cursor: pageParams.cursor,
        limit: pageParams.limit,
        includeHidden: false,
      });
    } catch {
      throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "Runtime model catalog is unavailable");
    }
    assertProfileStillCurrent(profile, generation);
    return normalizeModelPage(raw);
  }

  async function readRuntimeAuth(profile, generation) {
    let host;
    let auth;
    try {
      host = await runtimeManager.acquire(runtimeBinding({
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
      }), { permissionPolicy: profile.permissionPolicy });
      auth = await readRuntimeAuthenticationState(host);
      if (auth.status === "unsupported") {
        throw profileError("PROFILE_AUTH_STATUS_UNAVAILABLE", "Runtime auth status is unavailable");
      }
    } catch {
      throw profileError("PROFILE_AUTH_STATUS_UNAVAILABLE", "Runtime auth status is unavailable");
    }
    assertProfileStillCurrent(profile, generation);
    return validateProfileServiceResult("profile.auth.read", { status: auth.status });
  }

  async function assertAuthorityModelAvailable(profile, modelId, generation) {
    let cursor = null;
    let items = 0;
    let bytes = 0;
    const cursors = new Set();
    for (let pageIndex = 0; pageIndex < MAX_MODEL_PAGES; pageIndex += 1) {
      const page = await readAuthorityModelPage(profile, { cursor, limit: 100 }, generation);
      for (const model of page.models) {
        items += 1;
        bytes += Buffer.byteLength(JSON.stringify(model), "utf8");
        if (items > MAX_MODEL_ITEMS || bytes > MAX_MODEL_BYTES) {
          throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog exceeds safety limits");
        }
        if (model.id === modelId) return;
      }
      if (!page.hasMore) break;
      if (page.nextCursor === null || page.nextCursor === cursor || cursors.has(page.nextCursor)) {
        throw profileError("PROFILE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog cursor is invalid");
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw profileError("PROFILE_MODEL_NOT_AVAILABLE", "Selected model is not available for ChatGPT authority");
  }

  function putBinding(profile, providerRef, defaultModel) {
    const account = productStore.getRuntimeAccount(profile.runtimeAccountId);
    if (!account || account.runtime !== profile.runtime || account.id !== profile.runtimeAccountId) {
      throw profileError("PROFILE_TARGET_FORBIDDEN", "RuntimeAccount binding is invalid");
    }
    let saved;
    try {
      saved = productStore.putAgentProfile({
        ...profile,
        providerRef,
        defaultModel,
      });
    } catch (error) {
      if (dataErrorCode(error) === "STORE_COMMIT_UNCERTAIN") throw poison(error);
      throw error;
    }
    if (!saved || saved.id !== profile.id || saved.backendId !== profile.backendId
      || saved.agentId !== profile.agentId || saved.runtime !== profile.runtime
      || saved.runtimeProfileId !== profile.runtimeProfileId
      || saved.runtimeAccountId !== profile.runtimeAccountId || saved.name !== profile.name
      || saved.providerRef !== providerRef || saved.defaultModel !== defaultModel
      || saved.defaultCwd !== profile.defaultCwd
      || !sameSnapshot(saved.permissionPolicy, profile.permissionPolicy)
      || !sameSnapshot(saved.concurrency, profile.concurrency)
      || saved.isDefault !== profile.isDefault || saved.enabled !== profile.enabled
      || saved.createdAt !== profile.createdAt) {
      throw poison(profileError("PROFILE_RESPONSE_INVALID", "Stored Profile response is rebound"));
    }
    return saved;
  }

  async function bind(params, generation, recovering = false) {
    const profile = loadConfigurableProfile(params.profileId);
    if (recovering && profile.providerRef === params.providerRef
      && profile.defaultModel === params.defaultModel) {
      if (params.providerRef !== null) {
        assertOpenAiProviderIsExclusive(
          profile.id,
          productStore.getModelProvider(params.providerRef),
        );
      }
      await stopRuntimeProfile(profile);
      return validateProfileServiceResult("profile.bind", { profile });
    }
    if (params.providerRef === null) {
      await assertAuthorityModelAvailable(profile, params.defaultModel, generation);
    } else {
      const provider = loadReadyProvider(params.providerRef, params.defaultModel);
      assertOpenAiProviderIsExclusive(profile.id, provider);
      assertProfileStillCurrent(profile, generation);
    }
    const saved = putBinding(profile, params.providerRef, params.defaultModel);
    await stopRuntimeProfile(profile);
    return validateProfileServiceResult("profile.bind", { profile: saved });
  }

  async function compensateKnownFailure(prepared, primaryError) {
    if (!prepared || typeof prepared.compensate !== "function") throw primaryError;
    try {
      await prepared.compensate();
    } catch (cleanupError) {
      throw poison(primaryError, [cleanupError]);
    }
    throw primaryError;
  }

  async function configure(params, generation, recovering = false) {
    const profile = loadConfigurableProfile(params.profileId);
    const provider = productStore.getModelProvider(params.providerRef);
    if (!provider) throw profileError("PROFILE_PROVIDER_NOT_FOUND", "Provider was not found");
    if (provider.kind !== "openai-api-key" || provider.model !== params.defaultModel) {
      throw profileError("PROFILE_MODEL_MISMATCH", "OpenAI bootstrap provider/model is invalid");
    }
    let secret = params.secret;
    let prepared;
    let bindingCommitted = false;
    try {
      prepared = await providerBootstrap.configureOpenAiApiKey({
        profile: structuredClone(profile),
        provider: structuredClone(provider),
        defaultModel: params.defaultModel,
        secret,
        assertCurrent: () => assertProfileStillCurrent(profile, generation),
      });
    } finally {
      secret = null;
    }
    try {
      assertProfileStillCurrent(profile, generation);
      if (!prepared || typeof prepared.commit !== "function" || typeof prepared.compensate !== "function"
        || prepared.provider?.id !== provider.id || prepared.provider.kind !== "openai-api-key"
        || prepared.provider.model !== params.defaultModel
        || !READY_PROVIDER_STATUSES.has(prepared.provider.validationStatus)) {
        throw profileError("PROFILE_PROVIDER_NOT_READY", "OpenAI bootstrap did not validate provider");
      }
      const currentProvider = loadReadyProvider(params.providerRef, params.defaultModel);
      if (!sameSnapshot(currentProvider, prepared.provider)) {
        throw profileError("PROFILE_OPERATION_CONFLICT", "OpenAI provider changed during bootstrap");
      }
      const saved = putBinding(profile, params.providerRef, params.defaultModel);
      bindingCommitted = true;
      await stopRuntimeProfile(profile);
      await prepared.commit();
      return validateProfileServiceResult("profile.configure", { profile: saved });
    } catch (error) {
      if (poisonError || dataErrorCode(error) === "PROFILE_COMMIT_UNCERTAIN") throw error;
      if (bindingCommitted) throw poison(error);
      return compensateKnownFailure(prepared, error);
    }
  }

  async function clear(params, generation, recovering = false) {
    const profile = loadConfigurableProfile(params.profileId);
    if (!recovering) {
      if (profile.providerRef !== params.providerRef || profile.defaultModel !== params.defaultModel) {
        throw profileError("PROFILE_OPERATION_CONFLICT", "Profile provider changed before clear");
      }
    } else if ((profile.providerRef !== null || profile.defaultModel !== null)
      && (profile.providerRef !== params.providerRef || profile.defaultModel !== params.defaultModel)) {
      throw profileError("PROFILE_OPERATION_CONFLICT", "Profile provider changed during clear recovery");
    }
    const saved = profile.providerRef === null && profile.defaultModel === null
      ? profile : putBinding(profile, null, null);
    await stopRuntimeProfile(saved);
    if (params.providerRef !== null) {
      try {
        await providerBootstrap.clearUnreferencedOpenAiApiKey({
          profile: structuredClone(saved),
          providerRef: params.providerRef,
          assertCurrent: () => assertProfileStillCurrent(saved, generation),
        });
      } catch (error) {
        throw poison(error);
      }
    }
    return validateProfileServiceResult("profile.clear", { profile: saved });
  }

  function replayOutcome(method, outcome) {
    if (outcome && Object.getPrototypeOf(outcome) === Object.prototype
      && Object.keys(outcome).length === 2 && outcome.ok === true
      && Object.prototype.hasOwnProperty.call(outcome, "result")) {
      return validateProfileServiceResult(method, outcome.result);
    }
    if (outcome && Object.getPrototypeOf(outcome) === Object.prototype
      && Object.keys(outcome).length === 2 && outcome.ok === false
      && typeof outcome.publicCode === "string"
      && Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, outcome.publicCode)) {
      throw profileError(outcome.publicCode, PUBLIC_MESSAGES[outcome.publicCode]);
    }
    throw poison(profileError("PROFILE_RESPONSE_INVALID", "Durable Profile outcome is invalid"));
  }

  function mapLedgerError(error) {
    const code = dataErrorCode(error);
    if (code === "MCP_TOOL_CALL_CONFLICT") {
      return profileError("PROFILE_OPERATION_CONFLICT", "operationId was used for a different Profile configuration");
    }
    if (code === "STORE_COMMIT_UNCERTAIN" || code?.endsWith("COMMIT_UNCERTAIN")) {
      return poison(error);
    }
    const safe = mapProfileServiceError(error);
    return profileError(safe.code, safe.message);
  }

  function durableBinding(method, params, secretDigest) {
    return {
      method,
      operationId: params.operationId,
      profileId: params.profileId,
      providerRef: params.providerRef,
      defaultModel: params.defaultModel,
      createdAt: params.createdAt,
      secretDigest,
    };
  }

  function paramsFromBinding(method, binding, secret) {
    const fields = [
      "method", "operationId", "profileId", "providerRef", "defaultModel", "createdAt", "secretDigest",
    ];
    if (!binding || Object.getPrototypeOf(binding) !== Object.prototype
      || Object.keys(binding).length !== fields.length
      || fields.some((field) => !Object.prototype.hasOwnProperty.call(binding, field))
      || binding.method !== method) {
      throw poison(profileError("PROFILE_RESPONSE_INVALID", "Durable Profile binding is invalid"));
    }
    return {
      operationId: binding.operationId,
      profileId: binding.profileId,
      providerRef: binding.providerRef,
      defaultModel: binding.defaultModel,
      createdAt: binding.createdAt,
      ...(method === "profile.configure" ? { secret } : {}),
    };
  }

  const controller = {
    open() {
      if (state === "open") return controller;
      if (poisonError) throw poisonError;
      lifecycleGeneration += 1;
      state = "open";
      return controller;
    },

    close() {
      if (state === "closed") return tail;
      lifecycleGeneration += 1;
      state = "closed";
      return tail;
    },

    handle(method, rawParams) {
      let params;
      try {
        params = validateProfileServiceParams(method, rawParams);
      } catch (error) {
        return Promise.reject(error);
      }
      if (method === "profile.models.list" || method === "profile.auth.read") {
        let generation;
        let profile;
        try {
          generation = lifecycleGeneration;
          assertAccepting(generation);
          profile = loadEnabledProfile(params.profileId);
        } catch (error) {
          return Promise.reject(error);
        }
        const read = method === "profile.models.list"
          ? readRuntimeModelPage(profile, params, generation)
          : readRuntimeAuth(profile, generation);
        return read
          .then((result) => validateProfileServiceResult(method, result));
      }
      const identity = operationIdentity(method, params);
      const lookup = {
        profileId: params.profileId,
        callId: identity.callId,
        name: method,
        fingerprint: identity.fingerprint,
      };
      let durable;
      try {
        durable = productStore.lookupMcpToolCall(lookup);
      } catch (error) {
        if (method === "profile.configure") params.secret = null;
        return Promise.reject(mapLedgerError(error));
      }
      if (durable?.status === "completed") {
        if (method === "profile.configure") params.secret = null;
        try { return Promise.resolve(structuredClone(replayOutcome(method, durable.result))); }
        catch (error) { return Promise.reject(error); }
      }
      const active = inFlight.get(identity.callId);
      if (active) {
        if (method === "profile.configure") params.secret = null;
        return active.then(structuredClone);
      }
      let timestamp;
      try {
        timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
          throw profileError("PROFILE_SERVICE_CLOSED", "Profile controller clock is invalid");
        }
        assertAccepting();
      } catch (error) {
        if (method === "profile.configure") params.secret = null;
        return Promise.reject(error);
      }
      try { assertTimestamp(params.createdAt, timestamp); } catch (error) {
        if (method === "profile.configure") params.secret = null;
        return Promise.reject(error);
      }
      const resumedPending = durable?.status === "pending";
      if (durable === null) {
        try {
          durable = productStore.beginMcpToolCall({
            ...lookup,
            binding: durableBinding(method, params, identity.secretDigest),
            createdAt: params.createdAt,
          });
        } catch (error) {
          if (method === "profile.configure") params.secret = null;
          return Promise.reject(mapLedgerError(error));
        }
        if (durable.status === "completed") {
          if (method === "profile.configure") params.secret = null;
          try { return Promise.resolve(structuredClone(replayOutcome(method, durable.result))); }
          catch (error) { return Promise.reject(error); }
        }
      }
      const generation = lifecycleGeneration;
      const expectedBinding = durableBinding(method, params, identity.secretDigest);
      if (!sameSnapshot(durable.binding, expectedBinding)) {
        if (method === "profile.configure") params.secret = null;
        return Promise.reject(poison(profileError(
          "PROFILE_RESPONSE_INVALID", "Durable Profile binding does not match the request",
        )));
      }
      const recovering = resumedPending;
      const routeParams = paramsFromBinding(method, durable.binding, method === "profile.configure" ? params.secret : null);
      const operation = tail.then(async () => {
        assertAccepting(generation);
        try {
          const result = method === "profile.configure"
            ? await configure(routeParams, generation, recovering)
            : method === "profile.clear"
              ? await clear(routeParams, generation, recovering)
              : await bind(routeParams, generation, recovering);
          let completed;
          try {
            completed = productStore.completeMcpToolCall({
              id: durable.id,
              outcome: { ok: true, result },
            });
          } catch (error) {
            throw poison(error);
          }
          return replayOutcome(method, completed.result);
        } catch (error) {
          if (poisonError || dataErrorCode(error) === "PROFILE_COMMIT_UNCERTAIN"
            || dataErrorCode(error) === "STORE_COMMIT_UNCERTAIN") throw poisonError || poison(error);
          const publicCode = mapProfileServiceError(error).code;
          let completed;
          try {
            completed = productStore.completeMcpToolCall({
              id: durable.id,
              outcome: { ok: false, publicCode },
            });
          } catch (completionError) {
            throw poison(completionError);
          }
          return replayOutcome(method, completed.result);
        }
      }).finally(() => {
        if (method === "profile.configure") {
          params.secret = null;
          routeParams.secret = null;
        }
        inFlight.delete(identity.callId);
      });
      inFlight.set(identity.callId, operation);
      tail = operation.catch(() => {});
      return operation.then(structuredClone);
    },
  };
  return controller;
}

module.exports = {
  READY_PROVIDER_STATUSES,
  createProfileServiceController,
};
