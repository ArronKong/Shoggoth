"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const {
  validateChatServiceRequest,
} = require("../app/agent-service/chat-service-protocol");
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("../app/agent-service/runtime-account");
const {
  LAUNCH_AGENT_LABEL,
  createLaunchAgentController,
} = require("../app/agent-service/launch-agent");
const {
  createProductHostController,
  projectSafeProvider,
} = require("../app/product-host-controller");

const PROFILE = {
  id: "profile-default",
  backendId: "shoggoth",
  agentId: "shoggoth-profile-default",
  name: "Shoggoth",
  runtime: "codex",
  runtimeProfileId: "shoggoth-profile-default",
  runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  providerRef: "provider-openrouter",
  defaultModel: "openai/gpt-5",
  defaultCwd: null,
  permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
  isDefault: true,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function healthyServiceStatus(serviceVersion = "0.8.41") {
  return {
    healthy: true,
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion,
    startedAt: 100,
    domainAvailability: { kanban: true, cron: true },
    pendingCommandsLocked: false,
    mcpCredentialsLocked: false,
  };
}

function rawProvider(overrides = {}) {
  return {
    id: "provider-openrouter",
    kind: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://user:password@openrouter.ai:443/api/v1?private=query",
    model: "openai/gpt-5",
    credentialRef: "credential-internal-id",
    headers: { "X-Safe": "internal-header-value" },
    awsRegion: null,
    awsProfile: null,
    validationStatus: "protocol_valid",
    ...overrides,
  };
}

async function testSafeProviderProjectionNeverLeaksStorageFieldsOrUrlSecrets() {
  const projected = projectSafeProvider(rawProvider());
  assert.deepEqual(projected, {
    id: "provider-openrouter",
    kind: "openrouter",
    displayName: "OpenRouter",
    baseUrlHost: "openrouter.ai",
    authState: "configured",
    defaultModel: "openai/gpt-5",
    validationStatus: "protocol_valid",
  });
  const encoded = JSON.stringify(projected);
  for (const secret of ["credential-internal-id", "internal-header-value", "user", "password", "private=query"]) {
    assert.ok(!encoded.includes(secret), secret);
  }
  const hostile = Object.create(Object.prototype, {
    id: { enumerable: true, value: "provider-hostile" },
    kind: { enumerable: true, value: "openrouter" },
    name: { enumerable: true, get() { throw new Error("getter ran"); } },
  });
  assert.throws(() => projectSafeProvider(hostile), (error) => error.code === "HOST_PROVIDER_RESPONSE_INVALID");
}

async function testProductHostCombinesSafeServiceBackgroundAndProviderAuthority() {
  const calls = [];
  const serviceRequest = async (method, params) => {
    calls.push({ method, params });
    if (method === "service.status") return {
      healthy: true,
      pid: 999,
      ppid: 1,
      protocolVersion: 1,
      serviceVersion: "test",
      startedAt: 100,
      instanceNonce: "internal-nonce",
      domainAvailability: { kanban: true, cron: false },
      pendingCommandsLocked: true,
      mcpCredentialsLocked: false,
      internalPath: "/private/path",
    };
    if (method === "provider.list") return [rawProvider()];
    if (method === "profile.list") return { profiles: [PROFILE], nextCursor: null, hasMore: false };
    if (method === "auth.read") return {
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
      login: null,
    };
    if (method === "profile.models.list") return {
      models: [{ id: "gpt-5", displayName: "GPT-5", description: "Current model", isDefault: true }],
      nextCursor: null,
      hasMore: false,
    };
    throw new Error(`unexpected ${method}`);
  };
  const launch = {
    async status() {
      return { supported: true, installed: true, enabled: true, loaded: true, needsRepair: false };
    },
    async repair() { calls.push({ method: "launch.repair" }); },
  };
  const host = createProductHostController({ serviceRequest, launchAgent: launch });
  const status = await host.getStatus();
  assert.deepEqual(status, {
    service: {
      healthy: true,
      protocolVersion: 1,
      serviceVersion: "test",
      startedAt: 100,
      domainAvailability: { kanban: true, cron: false },
      pendingCommandsLocked: true,
      mcpCredentialsLocked: false,
    },
    background: { supported: true, installed: true, enabled: true, loaded: true, needsRepair: false },
  });
  assert.ok(!JSON.stringify(status).includes("internal-nonce"));
  assert.ok(!JSON.stringify(status).includes("/private/path"));

  const providers = await host.listProviders();
  assert.equal(providers.profile.configuredProviderId, "provider-openrouter");
  assert.equal(providers.profile.defaultModel, "openai/gpt-5");
  assert.equal(providers.providers.length, 2);
  const chatgpt = providers.providers.find((item) => item.kind === "chatgpt");
  assert.deepEqual(chatgpt, {
    id: "chatgpt",
    kind: "chatgpt",
    displayName: "ChatGPT",
    authState: "authenticated",
  });
  assert.ok(!JSON.stringify(providers).includes(PROFILE.runtimeProfileId));

  const models = await host.listChatGptModels();
  assert.deepEqual(models, {
    models: [{ id: "gpt-5", displayName: "GPT-5", description: "Current model", isDefault: true }],
  });
  assert.equal(calls.some((call) => call.method === "profile.models.list"), true);

  const repaired = await host.runBackgroundAction("repair");
  assert.equal(calls.some((call) => call.method === "launch.repair"), true);
  assert.equal(repaired.background.loaded, true);
  await assert.rejects(
    () => host.runBackgroundAction("delete"),
    (error) => error.code === "HOST_BACKGROUND_ACTION_INVALID",
  );
}

async function testProductHostInstallActionStartsServiceInOneStep() {
  const actions = [];
  let loaded = false;
  const host = createProductHostController({
    serviceRequest: async (method) => {
      assert.equal(method, "service.status");
      if (!loaded) throw new Error("service not started");
      return {
        healthy: true,
        protocolVersion: 1,
        serviceVersion: "0.8.41",
        startedAt: 100,
        domainAvailability: { kanban: true, cron: true },
        pendingCommandsLocked: false,
        mcpCredentialsLocked: false,
      };
    },
    launchAgent: {
      async status() {
        return {
          supported: true,
          installed: loaded,
          enabled: loaded,
          loaded,
          needsRepair: false,
        };
      },
      async install() { actions.push("install-only"); },
      async start() { actions.push("start"); loaded = true; },
    },
  });

  const status = await host.runBackgroundAction("install");
  assert.deepEqual(actions, ["start"]);
  assert.equal(status.service.healthy, true);
  assert.equal(status.background.loaded, true);
}

async function testProductHostAutoStartsBackgroundServiceIdempotently() {
  const actions = [];
  let loaded = false;
  const host = createProductHostController({
    serviceRequest: async () => ({
      healthy: loaded,
      protocolVersion: 1,
      serviceVersion: "0.8.41",
      startedAt: 100,
      domainAvailability: { kanban: loaded, cron: loaded },
      pendingCommandsLocked: !loaded,
      mcpCredentialsLocked: true,
    }),
    launchAgent: {
      async status() {
        return {
          supported: true,
          installed: loaded,
          enabled: loaded,
          loaded,
          needsRepair: false,
        };
      },
      async start() {
        actions.push("start");
        loaded = true;
      },
    },
  });

  await host.ensureBackgroundRunning();
  await host.ensureBackgroundRunning();
  assert.deepEqual(actions, ["start"]);
}

async function testProductHostAutoRecoversLoadedButUnhealthyBackgroundService() {
  const actions = [];
  let serviceHealthy = false;
  const host = createProductHostController({
    serviceRequest: async (method) => {
      assert.equal(method, "service.status");
      if (!serviceHealthy) throw new Error("fixture stale socket after app replacement");
      return {
        healthy: true,
        protocolVersion: 1,
        serviceVersion: "0.8.41",
        startedAt: 100,
        domainAvailability: { kanban: true, cron: true },
        pendingCommandsLocked: false,
        mcpCredentialsLocked: false,
      };
    },
    launchAgent: {
      async status() {
        return { supported: true, installed: true, enabled: true, loaded: true, needsRepair: false };
      },
      async start() {
        actions.push("start");
        serviceHealthy = true;
      },
    },
  });

  await host.ensureBackgroundRunning();
  await host.ensureBackgroundRunning();

  assert.deepEqual(actions, ["start"]);
}

async function testProductHostDelegatesAStartFailureWithoutOpeningASecondHealthWindow() {
  const actions = [];
  const host = createProductHostController({
    serviceRequest: async () => ({
      healthy: false,
      protocolVersion: 1,
      serviceVersion: "0.8.41",
      startedAt: 100,
      domainAvailability: { kanban: false, cron: false },
      pendingCommandsLocked: true,
      mcpCredentialsLocked: true,
    }),
    launchAgent: {
      async status() {
        return { supported: true, installed: true, enabled: true, loaded: false, needsRepair: false };
      },
      async start() {
        actions.push("start");
        throw new Error("launchd replacement window");
      },
    },
  });

  await assert.rejects(host.ensureBackgroundRunning(), /launchd replacement window/);
  assert.deepEqual(actions, ["start"]);
}

async function testManualStopSupersedesPendingAutomaticStartWithoutReloadingStoppedBackend() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-phase11-intent-stop-"));
  const homeDir = path.join(root, "home");
  const applicationsRoot = path.join(root, "Applications");
  fs.mkdirSync(applicationsRoot, { recursive: true });
  const bundle = makeTempBundle(applicationsRoot);
  const launchd = { enabled: false, loaded: false, executable: null };
  const healthEntered = deferred();
  const healthRelease = deferred();
  const disableEntered = deferred();
  const disableRelease = deferred();
  let blockHealth = false;
  let blockDisable = false;
  let serviceHealthy = true;
  const runner = async (_command, args) => {
    if (args[0] === "print-disabled") {
      return { code: 0, stdout: `"${LAUNCH_AGENT_LABEL}" => ${launchd.enabled ? "false" : "true"}\n` };
    }
    if (args[0] === "print") {
      if (!launchd.loaded) {
        const error = new Error("Could not find service");
        error.stderr = "Could not find service";
        throw error;
      }
      return { code: 0, stdout: `program = ${launchd.executable}\n` };
    }
    if (args[0] === "enable") launchd.enabled = true;
    if (args[0] === "bootstrap") {
      launchd.loaded = true;
      launchd.executable = bundle.executablePath;
    }
    if (args[0] === "disable") {
      if (blockDisable) {
        disableEntered.resolve();
        await disableRelease.promise;
      }
      launchd.enabled = false;
    }
    if (args[0] === "bootout") {
      launchd.loaded = false;
      launchd.executable = null;
      serviceHealthy = false;
    }
    return { code: 0, stdout: "" };
  };
  const launchAgent = createLaunchAgentController({
    platform: "darwin",
    homeDir,
    uid: 501,
    applicationsRoot,
    ...bundle,
    runner,
    clearExtendedAttributes() {},
    serviceVersion: "test",
    healthProbe: async () => {
      if (blockHealth) {
        healthEntered.resolve();
        return healthRelease.promise;
      }
      return healthyServiceStatus("test");
    },
  });
  await launchAgent.start();
  blockHealth = true;
  blockDisable = true;
  serviceHealthy = false;
  const readyEvents = [];
  const host = createProductHostController({
    launchAgent,
    onBackgroundReady(status) { readyEvents.push(status); },
    serviceRequest: async () => {
      if (!serviceHealthy) throw new Error("fixture Service unavailable");
      return healthyServiceStatus("test");
    },
  });

  const automatic = host.ensureBackgroundRunning();
  await healthEntered.promise;
  const stop = host.runBackgroundAction("stop");
  serviceHealthy = true;
  blockHealth = false;
  healthRelease.resolve(healthyServiceStatus("test"));
  await disableEntered.promise;
  const automaticResult = await automatic;
  disableRelease.resolve();
  const stopped = await stop;

  assert.equal(automaticResult, null);
  assert.equal(host.isBackgroundStartupCurrent(automaticResult), false);
  assert.equal(readyEvents.length, 0);
  assert.equal(stopped.background.enabled, false);
  assert.equal(stopped.background.loaded, false);
  assert.deepEqual(await launchAgent.status(), {
    supported: true, installed: true, enabled: false, loaded: false, needsRepair: false,
  });
}

async function testCurrentAutomaticStartCarriesAnOpaqueReloadAuthority() {
  let loaded = false;
  const host = createProductHostController({
    launchAgent: {
      async status() {
        return { supported: true, installed: loaded, enabled: loaded, loaded, needsRepair: false };
      },
      async start() { loaded = true; },
      async stop() { loaded = false; },
    },
    serviceRequest: async () => healthyServiceStatus(),
  });

  const result = await host.ensureBackgroundRunning();
  let reloads = 0;
  if (host.isBackgroundStartupCurrent(result)
    && result.supported === true && result.loaded === true
    && result.enabled === true && result.needsRepair === false) reloads += 1;

  assert.equal(reloads, 1);
  assert.deepEqual(Object.keys(result).sort(), ["enabled", "installed", "loaded", "needsRepair", "supported"]);
  const stop = host.runBackgroundAction("stop");
  assert.equal(
    host.isBackgroundStartupCurrent(result),
    false,
    "ensure 返回后、UI continuation 前的新手动意图必须同步撤销 reload authority",
  );
  await stop;
}

async function testManualRepairSupersedesAutomaticStartAndSignalsReadyExactlyOnce() {
  const autoEntered = deferred();
  const autoRelease = deferred();
  let loaded = false;
  let serviceHealthy = false;
  const readyEvents = [];
  const host = createProductHostController({
    launchAgent: {
      async status() {
        return { supported: true, installed: loaded, enabled: loaded, loaded, needsRepair: false };
      },
      async start() {
        autoEntered.resolve();
        await autoRelease.promise;
        loaded = true;
        serviceHealthy = true;
      },
      async repair() {
        loaded = true;
        serviceHealthy = true;
      },
    },
    onBackgroundReady(status) { readyEvents.push(status.service.healthy); },
    serviceRequest: async () => {
      if (!serviceHealthy) throw new Error("fixture Service unavailable");
      return healthyServiceStatus();
    },
  });

  const automatic = host.ensureBackgroundRunning();
  await autoEntered.promise;
  const repaired = await host.runBackgroundAction("repair");
  autoRelease.resolve();
  const automaticResult = await automatic;

  assert.equal(automaticResult, null);
  assert.equal(repaired.service.healthy, true);
  assert.deepEqual(readyEvents, [true]);
}

async function testSupersededManualActionNeverSignalsReady() {
  const repairRelease = deferred();
  const readyEvents = [];
  const host = createProductHostController({
    launchAgent: {
      async status() {
        return { supported: true, installed: true, enabled: true, loaded: true, needsRepair: false };
      },
      async repair() { await repairRelease.promise; },
    },
    onBackgroundReady(status) { readyEvents.push(status.service.healthy); },
    serviceRequest: async () => healthyServiceStatus(),
  });

  const older = host.runBackgroundAction("repair");
  const current = host.runBackgroundAction("repair");
  repairRelease.resolve();
  await Promise.all([older, current]);

  assert.deepEqual(readyEvents, [true]);
}

async function testManualReadyAuthorityIsRevokedSynchronouslyByNewerStop() {
  const readyEntered = deferred();
  const readyRelease = deferred();
  let loaded = true;
  let readyAuthority;
  let readyCalls = 0;
  const host = createProductHostController({
    launchAgent: {
      async status() {
        return { supported: true, installed: true, enabled: loaded, loaded, needsRepair: false };
      },
      async repair() {},
      async stop() { loaded = false; },
    },
    async onBackgroundReady(_status, stillCurrent) {
      readyCalls += 1;
      readyAuthority = stillCurrent;
      readyEntered.resolve();
      await readyRelease.promise;
    },
    serviceRequest: async () => healthyServiceStatus(),
  });

  const repair = host.runBackgroundAction("repair");
  await readyEntered.promise;
  const wasFunction = typeof readyAuthority === "function";
  const wasCurrent = wasFunction ? readyAuthority() : null;
  const stop = host.runBackgroundAction("stop");
  const currentAfterStop = wasFunction ? readyAuthority() : null;
  readyRelease.resolve();
  await Promise.all([repair, stop]);

  assert.equal(wasFunction, true);
  assert.equal(wasCurrent, true);
  assert.equal(currentAfterStop, false);
  assert.equal(readyCalls, 1);
}

async function testBackgroundRecoveryRefreshesDesktopBackendOnce() {
  const readyEvents = [];
  let serviceHealthy = false;
  const host = createProductHostController({
    onBackgroundReady(status) { readyEvents.push(status.service.healthy); },
    serviceRequest: async (method) => {
      assert.equal(method, "service.status");
      if (!serviceHealthy) throw new Error("fixture service unavailable");
      return {
        healthy: true,
        protocolVersion: 1,
        serviceVersion: "0.8.41",
        startedAt: 100,
        domainAvailability: { kanban: true, cron: true },
        pendingCommandsLocked: false,
        mcpCredentialsLocked: false,
      };
    },
    launchAgent: {
      async status() {
        return { supported: true, installed: true, enabled: true, loaded: true, needsRepair: false };
      },
      async repair() { serviceHealthy = true; },
    },
  });

  const status = await host.runBackgroundAction("repair");

  assert.equal(status.service.healthy, true);
  assert.deepEqual(readyEvents, [true]);
}

async function testStoppedServiceStillExposesBackgroundRecoveryWithoutInternalErrors() {
  const actions = [];
  const host = createProductHostController({
    serviceRequest: async () => {
      const error = new Error("connect ENOENT /private/agent.sock");
      error.code = "ENOENT";
      throw error;
    },
    launchAgent: {
      async status() {
        return { supported: true, installed: true, enabled: true, loaded: false, needsRepair: false };
      },
      async start() { actions.push("start"); },
      async stop() { actions.push("stop"); },
    },
  });
  const status = await host.getStatus();
  assert.deepEqual(status, {
    service: {
      healthy: false,
      domainAvailability: { kanban: false, cron: false },
      pendingCommandsLocked: true,
      mcpCredentialsLocked: true,
    },
    background: { supported: true, installed: true, enabled: true, loaded: false, needsRepair: false },
  });
  assert.ok(!JSON.stringify(status).includes("agent.sock"));
  const stopped = await host.runBackgroundAction("stop");
  assert.deepEqual(actions, ["stop"]);
  assert.equal(stopped.service.healthy, false);
}

async function testBackgroundProbeFailureDoesNotHideServiceStatus() {
  const host = createProductHostController({
    serviceRequest: async (method) => {
      assert.equal(method, "service.status");
      return {
        healthy: true,
        protocolVersion: 1,
        serviceVersion: "0.8.41",
        startedAt: 100,
        domainAvailability: { kanban: true, cron: true },
        pendingCommandsLocked: false,
        mcpCredentialsLocked: false,
      };
    },
    launchAgent: {
      async status() {
        const error = new Error("LaunchAgent status unavailable at /private/path");
        error.code = "UNSTABLE_INSTALL_LOCATION";
        throw error;
      },
    },
  });

  const status = await host.getStatus();
  assert.deepEqual(status, {
    service: {
      healthy: true,
      protocolVersion: 1,
      serviceVersion: "0.8.41",
      startedAt: 100,
      domainAvailability: { kanban: true, cron: true },
      pendingCommandsLocked: false,
      mcpCredentialsLocked: false,
    },
    background: { supported: false, reason: "status-unavailable" },
  });
  assert.equal(JSON.stringify(status).includes("/private/path"), false);
}

async function testProviderOnboardingUsesServiceSagaAndReturnsOnlySafeProjection() {
  const calls = [];
  const configuredEvents = [];
  const openai = rawProvider({
    id: "provider-openai", kind: "openai-api-key", name: "OpenAI API Key",
    baseUrl: null, model: "gpt-5", credentialRef: null, headers: null,
    validationStatus: "unverified",
  });
  const profile = { ...PROFILE, providerRef: null, defaultModel: null };
  const serviceRequest = async (method, params) => {
    calls.push([method, structuredClone(params)]);
    if (method === "profile.list") return { profiles: [profile], nextCursor: null, hasMore: false };
    if (method === "provider.save") return openai;
    if (method === "profile.configure") return {
      profile: { ...profile, providerRef: openai.id, defaultModel: openai.model, updatedAt: params.createdAt },
    };
    if (method === "auth.read") return {
      account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true, login: null,
    };
    if (method === "auth.login.start") return {
      requestId: "request-chatgpt", mode: "browser", status: "waiting",
      loginId: "login-chatgpt", authUrl: "https://auth.openai.test/device",
    };
    if (method === "profile.bind") return {
      profile: { ...profile, providerRef: null, defaultModel: params.defaultModel, updatedAt: params.createdAt },
    };
    throw new Error(`unexpected ${method}`);
  };
  const host = createProductHostController({
    serviceRequest,
    launchAgent: { async status() { return { supported: false }; } },
    async onProfileConfigured(profile) { configuredEvents.push(profile.defaultModel); },
  });
  const secret = "host-openai-secret-canary-000001";
  const configured = await host.configureProvider({
    operationId: "configure-openai-1", createdAt: 1_800_000_000_000, secret,
    provider: {
      id: openai.id, kind: openai.kind, name: openai.name, model: openai.model,
      baseUrl: null, awsRegion: null, awsProfile: null,
    },
  });
  assert.deepEqual(configured.provider, {
    id: openai.id, kind: openai.kind, displayName: openai.name,
    authState: "configured", defaultModel: openai.model, validationStatus: "protocol_valid",
  });
  assert.equal(configured.profile.ready, true);
  assert.equal(JSON.stringify(configured).includes(secret), false);
  const configureCall = calls.find(([method]) => method === "profile.configure");
  assert.equal(configureCall[1].secret, secret);
  assert.equal(configureCall[1].profileId, PROFILE.id);

  const chatgpt = await host.bindChatGpt({
    operationId: "bind-chatgpt-1", defaultModel: "gpt-5", createdAt: 1_800_000_000_001,
  });
  assert.equal(chatgpt.profile.configuredProviderId, null);
  assert.equal(chatgpt.profile.ready, true);
  assert.deepEqual(configuredEvents, [openai.model, "gpt-5"]);
  assert.ok(!JSON.stringify(chatgpt).includes(PROFILE.runtimeProfileId));
  const login = await host.startChatGptLogin({ mode: "browser" });
  assert.deepEqual(login, {
    mode: "browser", status: "waiting", authUrl: "https://auth.openai.test/device",
  });
  assert.ok(!JSON.stringify(login).includes("login-chatgpt"));
}

async function testProductHostScopesProfileEnumerationToShoggothBackend() {
  const profileListParams = [];
  const host = createProductHostController({
    serviceRequest: async (method, params) => {
      if (method === "profile.list") {
        const request = validateChatServiceRequest({
          id: "product-host-profile-list",
          token: "test-token",
          version: PROTOCOL_VERSION,
          method,
          params,
        });
        profileListParams.push(request.params);
        return { profiles: [{ ...PROFILE, providerRef: null, defaultModel: null }], nextCursor: null, hasMore: false };
      }
      if (method === "auth.login.start") {
        return {
          requestId: "request-scoped-login",
          mode: "browser",
          status: "waiting",
          loginId: "login-scoped",
          authUrl: "https://auth.openai.test/device",
        };
      }
      throw new Error(`unexpected ${method}`);
    },
    launchAgent: { async status() { return { supported: false }; } },
  });

  await host.startChatGptLogin({ mode: "browser" });
  assert.deepEqual(profileListParams, [{
    backendId: "shoggoth",
    cursor: null,
    limit: 100,
    enabledOnly: false,
  }]);
}

async function testProviderHostTargetsNonDefaultManagedProfileAndClearsItIndependently() {
  const calls = [];
  const defaultProfile = { ...PROFILE, providerRef: null, defaultModel: null };
  const secondProfile = {
    ...defaultProfile,
    id: "profile-second",
    agentId: "agent-second",
    runtimeProfileId: "runtime-second",
    name: "Second",
    isDefault: false,
  };
  const openai = rawProvider({
    id: "provider-openai-profile-second",
    kind: "openai-api-key",
    name: "OpenAI API Key",
    baseUrl: null,
    model: "gpt-5-mini",
    credentialRef: null,
    headers: null,
    validationStatus: "unverified",
  });
  let second = secondProfile;
  const host = createProductHostController({
    serviceRequest: async (method, params) => {
      calls.push([method, structuredClone(params)]);
      if (method === "profile.list") {
        return { profiles: [defaultProfile, second], nextCursor: null, hasMore: false };
      }
      if (method === "auth.read") return {
        account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true, login: null,
      };
      if (method === "provider.list") return [openai];
      if (method === "provider.save") return openai;
      if (method === "profile.configure") {
        second = {
          ...second,
          providerRef: openai.id,
          defaultModel: openai.model,
          updatedAt: params.createdAt,
        };
        return { profile: second };
      }
      if (method === "profile.clear") {
        second = { ...second, providerRef: null, defaultModel: null, updatedAt: params.createdAt };
        return { profile: second };
      }
      throw new Error(`unexpected ${method}`);
    },
    launchAgent: { async status() { return { supported: false }; } },
  });

  const snapshot = await host.listProviders({ profileId: second.id });
  assert.deepEqual(snapshot.profile, {
    id: second.id,
    name: second.name,
    isDefault: false,
    configuredProviderId: null,
    defaultModel: null,
    ready: true,
  });
  await host.configureProvider({
    operationId: "configure-second-profile",
    profileId: second.id,
    createdAt: 1_800_000_000_010,
    secret: "second-profile-openai-key",
    provider: {
      id: openai.id,
      kind: openai.kind,
      name: openai.name,
      model: openai.model,
      baseUrl: null,
      awsRegion: null,
      awsProfile: null,
    },
  });
  assert.equal(calls.find(([method]) => method === "profile.configure")[1].profileId, second.id);
  assert.equal(defaultProfile.providerRef, null);

  const savesBeforeCrossProfileAttempt = calls.filter(([method]) => method === "provider.save").length;
  await assert.rejects(
    () => host.configureProvider({
      operationId: "configure-default-with-second-provider",
      profileId: defaultProfile.id,
      createdAt: 1_800_000_000_011,
      secret: "must-not-rotate-second-profile-key",
      provider: {
        id: openai.id,
        kind: openai.kind,
        name: openai.name,
        model: openai.model,
        baseUrl: null,
        awsRegion: null,
        awsProfile: null,
      },
    }),
    (error) => error.code === "HOST_PROVIDER_TARGET_FORBIDDEN",
  );
  assert.equal(
    calls.filter(([method]) => method === "provider.save").length,
    savesBeforeCrossProfileAttempt,
  );

  const cleared = await host.clearProfileProvider({
    operationId: "clear-second-profile",
    profileId: second.id,
    createdAt: 1_800_000_000_011,
  });
  assert.equal(cleared.profile.configuredProviderId, null);
  assert.equal(cleared.profile.defaultModel, null);
  const clearCall = calls.find(([method]) => method === "profile.clear");
  assert.deepEqual(clearCall[1], {
    operationId: "clear-second-profile",
    profileId: second.id,
    providerRef: openai.id,
    defaultModel: openai.model,
    createdAt: 1_800_000_000_011,
  });

  await assert.rejects(
    () => host.listProviders({ profileId: "missing-profile" }),
    (error) => error.code === "HOST_PROFILE_RESPONSE_INVALID",
  );
}

function makeTempBundle(applicationsRoot) {
  const appPath = path.join(applicationsRoot, "Shoggoth.app");
  const executablePath = path.join(appPath, "Contents", "MacOS", "Shoggoth");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const bootstrapPath = path.join(resourcesPath, "app.asar", "app", "bootstrap.js");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(executablePath, "fixture");
  fs.writeFileSync(path.join(resourcesPath, "app.asar"), "fixture");
  return { appPath, executablePath, resourcesPath, bootstrapPath };
}

async function testLaunchAgentStatusUsesLaunchdTruthWithoutLeakingPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-phase11-launch-"));
  const homeDir = path.join(root, "home");
  const applicationsRoot = path.join(root, "Applications");
  fs.mkdirSync(applicationsRoot, { recursive: true });
  const bundle = makeTempBundle(applicationsRoot);
  const launchd = { enabled: false, loaded: false, executable: null };
  const runner = async (_command, args) => {
    if (args[0] === "print-disabled") {
      return { code: 0, stdout: `"${LAUNCH_AGENT_LABEL}" => ${launchd.enabled ? "false" : "true"}\n` };
    }
    if (args[0] === "print") {
      if (!launchd.loaded) {
        const error = new Error("Could not find service");
        error.stderr = "Could not find service";
        throw error;
      }
      return { code: 0, stdout: `program = ${launchd.executable}\n` };
    }
    if (args[0] === "enable") launchd.enabled = true;
    if (args[0] === "bootstrap") {
      launchd.loaded = true;
      launchd.executable = bundle.executablePath;
    }
    return { code: 0, stdout: "" };
  };
  const controller = createLaunchAgentController({
    platform: "darwin",
    homeDir,
    uid: 501,
    applicationsRoot,
    ...bundle,
    runner,
    serviceVersion: "test",
    healthProbe: async () => ({
      healthy: true,
      protocolVersion: PROTOCOL_VERSION,
      serviceVersion: "test",
    }),
  });
  assert.deepEqual(await controller.status(), {
    supported: true,
    installed: false,
    enabled: false,
    loaded: false,
    needsRepair: false,
  });
  await controller.start();
  const status = await controller.status();
  assert.deepEqual(status, {
    supported: true,
    installed: true,
    enabled: true,
    loaded: true,
    needsRepair: false,
  });
  assert.ok(!JSON.stringify(status).includes(root));
}

async function testLaunchAgentStatusExplainsUnstableInstallWithoutProbingLaunchd() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-phase11-unstable-"));
  const applicationsRoot = path.join(root, "Applications");
  const bundle = makeTempBundle(path.join(root, "Downloads"));
  fs.mkdirSync(applicationsRoot, { recursive: true });
  let runnerCalls = 0;
  const controller = createLaunchAgentController({
    platform: "darwin",
    homeDir: path.join(root, "home"),
    uid: 501,
    applicationsRoot,
    ...bundle,
    runner: async () => {
      runnerCalls += 1;
      throw new Error("launchctl must not run for an unstable bundle");
    },
  });

  assert.deepEqual(await controller.status(), {
    supported: false,
    reason: "unstable-install-location",
  });
  assert.equal(runnerCalls, 0);
  await assert.rejects(
    () => controller.install(),
    (error) => error.code === "UNSTABLE_INSTALL_LOCATION",
  );
}

async function testLaunchAgentCleanFirstRunStatusDoesNotDependOnLaunchdQuery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-phase11-first-run-"));
  const applicationsRoot = path.join(root, "Applications");
  fs.mkdirSync(applicationsRoot, { recursive: true });
  const bundle = makeTempBundle(applicationsRoot);
  let runnerCalls = 0;
  const controller = createLaunchAgentController({
    platform: "darwin",
    homeDir: path.join(root, "home"),
    uid: 501,
    applicationsRoot,
    ...bundle,
    runner: async () => {
      runnerCalls += 1;
      const error = new Error("launchd state unavailable on a clean first run");
      error.code = "EIO";
      throw error;
    },
  });

  assert.deepEqual(await controller.status(), {
    supported: true,
    installed: false,
    enabled: false,
    loaded: false,
    needsRepair: false,
  });
  assert.equal(runnerCalls, 0);
}

async function testAuthenticatedCodexDefaultModelDoesNotRequireProviderSetup() {
  for (const authenticated of [true, false]) {
    const host = createProductHostController({
      serviceRequest: async (method) => {
        if (method === "profile.list") return { profiles: [{ ...PROFILE, providerRef: null, defaultModel: null }], nextCursor: null, hasMore: false };
        if (method === "provider.list") return [];
        if (method === "auth.read") return { account: authenticated ? { type: "chatgpt", planType: "plus" } : null,
          requiresOpenaiAuth: true, login: null };
        throw new Error(`unexpected ${method}`);
      },
      launchAgent: { async status() { return { supported: false }; } },
    });
    const snapshot = await host.listProviders();
    assert.equal(snapshot.profile.ready, authenticated);
    assert.equal(snapshot.profile.defaultModel, null);
    assert.equal(snapshot.providers[0].authState, authenticated ? "authenticated" : "missing");
  }
}

const tests = [
  testAuthenticatedCodexDefaultModelDoesNotRequireProviderSetup,
  testSafeProviderProjectionNeverLeaksStorageFieldsOrUrlSecrets,
  testProductHostCombinesSafeServiceBackgroundAndProviderAuthority,
  testProductHostInstallActionStartsServiceInOneStep,
  testProductHostAutoStartsBackgroundServiceIdempotently,
  testProductHostAutoRecoversLoadedButUnhealthyBackgroundService,
  testProductHostDelegatesAStartFailureWithoutOpeningASecondHealthWindow,
  testManualStopSupersedesPendingAutomaticStartWithoutReloadingStoppedBackend,
  testCurrentAutomaticStartCarriesAnOpaqueReloadAuthority,
  testManualRepairSupersedesAutomaticStartAndSignalsReadyExactlyOnce,
  testSupersededManualActionNeverSignalsReady,
  testManualReadyAuthorityIsRevokedSynchronouslyByNewerStop,
  testBackgroundRecoveryRefreshesDesktopBackendOnce,
  testStoppedServiceStillExposesBackgroundRecoveryWithoutInternalErrors,
  testBackgroundProbeFailureDoesNotHideServiceStatus,
  testProviderOnboardingUsesServiceSagaAndReturnsOnlySafeProjection,
  testProductHostScopesProfileEnumerationToShoggothBackend,
  testProviderHostTargetsNonDefaultManagedProfileAndClearsItIndependently,
  testLaunchAgentStatusUsesLaunchdTruthWithoutLeakingPaths,
  testLaunchAgentStatusExplainsUnstableInstallWithoutProbingLaunchd,
  testLaunchAgentCleanFirstRunStatusDoesNotDependOnLaunchdQuery,
];

(async () => {
  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  process.stdout.write(`${tests.length}/${tests.length} Phase11 host tests passed\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
