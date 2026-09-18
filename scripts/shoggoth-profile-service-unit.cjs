"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  DEFAULT_AGENT_PROFILE_ID,
  defaultAgentProfile,
} = require("../app/agent-service/product-store");
const {
  createProfileServiceController,
} = require("../app/agent-service/profile-service-controller");
const {
  validateProfileServiceParams,
  validateProfileServiceResult,
} = require("../app/agent-service/profile-service-protocol");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("../app/agent-service/runtime-account");

const NOW = 1_800_000_000_000;
const PROVIDER_ID = "provider-openrouter";

function provider(overrides = {}) {
  return {
    id: PROVIDER_ID,
    kind: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5",
    credentialRef: "credential-safe",
    headers: null,
    awsRegion: null,
    awsProfile: null,
    validationStatus: "protocol_valid",
    ...overrides,
  };
}

function fixture(options = {}) {
  const initialProfile = defaultAgentProfile(NOW - 1000);
  const shared = options.shared || {
    currentProfile: initialProfile,
    otherProfiles: structuredClone(options.otherProfiles || []),
    currentAccount: structuredClone(DEFAULT_RUNTIME_ACCOUNTS.find(
      (account) => account.id === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    )),
    providers: new Map([[PROVIDER_ID, provider()], [
    "provider-openai",
    provider({
      id: "provider-openai",
      kind: "openai-api-key",
      name: "OpenAI API Key",
      baseUrl: null,
      credentialRef: null,
      model: "gpt-5",
    }),
    ]]),
    ledger: new Map(),
    completeError: null,
  };
  if (!Array.isArray(shared.otherProfiles)) shared.otherProfiles = [];
  if (!shared.currentAccount) {
    shared.currentAccount = structuredClone(DEFAULT_RUNTIME_ACCOUNTS.find(
      (account) => account.id === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ));
  }
  const providers = shared.providers;
  const calls = [];
  let nowCalls = 0;
  const productStore = {
    getAgentProfile(id) {
      calls.push(["getAgentProfile", id]);
      const selected = [shared.currentProfile, ...shared.otherProfiles]
        .find((candidate) => candidate.id === id);
      return structuredClone(selected || null);
    },
    listAgentProfiles() {
      calls.push(["listAgentProfiles"]);
      return structuredClone([shared.currentProfile, ...shared.otherProfiles]);
    },
    getRuntimeAccount(id) {
      calls.push(["getRuntimeAccount", id]);
      return id === shared.currentAccount.id ? structuredClone(shared.currentAccount) : null;
    },
    getModelProvider(id) {
      calls.push(["getModelProvider", id]);
      return structuredClone(providers.get(id) || null);
    },
    putAgentProfile(value) {
      calls.push(["putAgentProfile", structuredClone(value)]);
      if (options.putError) throw options.putError;
      const saved = { ...structuredClone(value), updatedAt: NOW };
      if (value.id === shared.currentProfile.id) shared.currentProfile = saved;
      else {
        const index = shared.otherProfiles.findIndex((profile) => profile.id === value.id);
        if (index < 0) throw new Error("unknown profile");
        shared.otherProfiles[index] = saved;
      }
      return structuredClone(saved);
    },
    lookupMcpToolCall(input) {
      calls.push(["ledger.lookup", structuredClone(input)]);
      const existing = shared.ledger.get(`${input.profileId}\0${input.callId}`) || null;
      if (existing && (existing.name !== input.name || existing.fingerprint !== input.fingerprint)) {
        throw Object.assign(new Error("ledger conflict"), { code: "MCP_TOOL_CALL_CONFLICT" });
      }
      return structuredClone(existing);
    },
    beginMcpToolCall(input) {
      calls.push(["ledger.begin", structuredClone(input)]);
      const key = `${input.profileId}\0${input.callId}`;
      const existing = shared.ledger.get(key);
      if (existing) return structuredClone(existing);
      const record = {
        id: `mcp-call-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 48)}`,
        profileId: input.profileId,
        callId: input.callId,
        name: input.name,
        fingerprint: input.fingerprint,
        operationId: `mcp-v1-${crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 48)}`,
        binding: structuredClone(input.binding),
        createdAt: input.createdAt,
        status: "pending",
        result: null,
      };
      shared.ledger.set(key, record);
      return structuredClone(record);
    },
    completeMcpToolCall(input) {
      calls.push(["ledger.complete", structuredClone(input)]);
      if (shared.completeError) throw shared.completeError;
      const entry = [...shared.ledger.entries()].find(([, value]) => value.id === input.id);
      if (!entry) throw Object.assign(new Error("missing"), { code: "MCP_TOOL_CALL_NOT_FOUND" });
      entry[1].status = "completed";
      entry[1].result = structuredClone(input.outcome);
      return structuredClone(entry[1]);
    },
  };
  const runtimePool = {
    async get(runtimeProfileId) {
      calls.push(["runtime.get", runtimeProfileId]);
      return {
        ...(options.authenticationState
          ? {
              authenticationState() {
                calls.push(["runtime.authenticationState"]);
                return structuredClone(options.authenticationState);
              },
            }
          : {
              async accountRead() {
                calls.push(["runtime.accountRead"]);
                return structuredClone(options.runtimeAccountResult || {
                  account: { type: "chatgpt", planType: "plus" },
                  requiresOpenaiAuth: true,
                });
              },
            }),
        async modelList(params) {
          calls.push(["runtime.modelList", structuredClone(params)]);
          const models = options.models || [{
            id: "gpt-5",
            model: "gpt-5",
            displayName: "GPT-5",
            description: "ChatGPT fixture model",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [],
          }];
          return { data: structuredClone(models), nextCursor: null };
        },
      };
    },
  };
  const runtimeManager = {
    async acquire(binding) {
      return runtimePool.get(binding.runtimeProfileId);
    },
    async stop(binding) {
      calls.push(["runtime.stop", structuredClone(binding)]);
      if (options.stopError) throw options.stopError;
    },
  };
  const accountAuthManager = {
    async read(input) {
      calls.push(["auth.read", structuredClone(input)]);
      return options.authResult || {
        account: { type: "chatgpt", planType: "plus" },
        requiresOpenaiAuth: true,
        login: null,
      };
    },
  };
  const bootstrap = {
    async configureOpenAiApiKey(input) {
      calls.push(["bootstrap.configure", {
        profileId: input.profile.id,
        providerId: input.provider.id,
        defaultModel: input.defaultModel,
        secret: input.secret,
      }]);
      input.assertCurrent();
      if (options.bootstrapError) throw options.bootstrapError;
      return {
        provider: provider({
          id: "provider-openai",
          kind: "openai-api-key",
          name: "OpenAI API Key",
          baseUrl: null,
          credentialRef: null,
          model: "gpt-5",
          validationStatus: "protocol_valid",
        }),
        async commit() {
          calls.push(["bootstrap.commit"]);
          if (options.commitError) throw options.commitError;
        },
        async compensate() {
          calls.push(["bootstrap.compensate"]);
          if (options.compensateError) throw options.compensateError;
        },
      };
    },
    async clearUnreferencedOpenAiApiKey(input) {
      calls.push(["bootstrap.clear", {
        profileId: input.profile.id,
        providerRef: input.providerRef,
      }]);
      input.assertCurrent();
      if (options.clearError) throw options.clearError;
      return { cleared: true };
    },
  };
  const controller = createProfileServiceController({
    productStore,
    runtimeManager,
    accountAuthManager,
    providerBootstrap: bootstrap,
    ...(options.runtimeAccountAdmission
      ? { runtimeAccountAdmission: options.runtimeAccountAdmission }
      : {}),
    now: () => {
      nowCalls += 1;
      if (options.nowError && nowCalls > (options.nowErrorAfter ?? 0)) throw options.nowError;
      return NOW;
    },
    maxOperations: 8,
  });
  controller.open();
  return {
    controller,
    calls,
    providers,
    shared,
    get profile() { return structuredClone(shared.currentProfile); },
    get nowCalls() { return nowCalls; },
  };
}

function bindParams(overrides = {}) {
  return {
    operationId: "profile-bind-one",
    profileId: DEFAULT_AGENT_PROFILE_ID,
    providerRef: PROVIDER_ID,
    defaultModel: "openai/gpt-5",
    createdAt: NOW - 10,
    ...overrides,
  };
}

async function testProtocolIsExactDescriptorSafeAndNeverReturnsSecrets() {
  assert.deepEqual(validateProfileServiceParams("profile.models.list", {
    profileId: DEFAULT_AGENT_PROFILE_ID,
    cursor: null,
    limit: 100,
  }), {
    profileId: DEFAULT_AGENT_PROFILE_ID,
    cursor: null,
    limit: 100,
  });
  assert.deepEqual(validateProfileServiceParams("profile.auth.read", {
    profileId: DEFAULT_AGENT_PROFILE_ID,
  }), { profileId: DEFAULT_AGENT_PROFILE_ID });
  assert.deepEqual(validateProfileServiceResult("profile.auth.read", {
    status: "authenticated",
  }), { status: "authenticated" });
  assert.throws(
    () => validateProfileServiceResult("profile.auth.read", { status: "maybe" }),
    (error) => error.code === "PROFILE_RESPONSE_INVALID",
  );
  assert.deepEqual(validateProfileServiceParams("profile.bind", bindParams()), bindParams());
  assert.throws(
    () => validateProfileServiceParams("profile.bind", { ...bindParams(), enabled: true }),
    (error) => error.code === "INVALID_PARAMS",
  );
  const hostile = Object.create(Object.prototype, {
    operationId: { enumerable: true, get() { throw new Error("getter ran"); } },
    profileId: { enumerable: true, value: DEFAULT_AGENT_PROFILE_ID },
    providerRef: { enumerable: true, value: PROVIDER_ID },
    defaultModel: { enumerable: true, value: "openai/gpt-5" },
    createdAt: { enumerable: true, value: NOW },
  });
  assert.throws(
    () => validateProfileServiceParams("profile.bind", hostile),
    (error) => error.code === "INVALID_PARAMS",
  );
  const configured = validateProfileServiceParams("profile.configure", {
    ...bindParams({
      operationId: "profile-configure-one",
      providerRef: "provider-openai",
      defaultModel: "gpt-5",
    }),
    secret: "sk-test-not-a-real-secret",
  });
  assert.equal(configured.secret, "sk-test-not-a-real-secret");
  assert.deepEqual(validateProfileServiceParams("profile.clear", {
    operationId: "profile-clear-one",
    profileId: DEFAULT_AGENT_PROFILE_ID,
    providerRef: "provider-openai",
    defaultModel: "gpt-5",
    createdAt: NOW,
  }), {
    operationId: "profile-clear-one",
    profileId: DEFAULT_AGENT_PROFILE_ID,
    providerRef: "provider-openai",
    defaultModel: "gpt-5",
    createdAt: NOW,
  });
  assert.throws(
    () => validateProfileServiceParams("profile.clear", {
      operationId: "profile-clear-invalid",
      profileId: DEFAULT_AGENT_PROFILE_ID,
      providerRef: null,
      defaultModel: "gpt-5",
      createdAt: NOW,
    }),
    (error) => error.code === "INVALID_PARAMS",
  );
  const output = validateProfileServiceResult("profile.configure", {
    profile: defaultAgentProfile(NOW),
  });
  assert.ok(!JSON.stringify(output).includes("secret"));
  assert.deepEqual(validateProfileServiceResult("profile.models.list", {
    models: [{ id: "gpt-5", displayName: "GPT-5", description: "Model", isDefault: true }],
    nextCursor: null,
    hasMore: false,
  }), {
    models: [{ id: "gpt-5", displayName: "GPT-5", description: "Model", isDefault: true }],
    nextCursor: null,
    hasMore: false,
  });
}

async function testChatGptModelCatalogAndBindingUseSameRuntimeAuthority() {
  const ctx = fixture();
  const page = await ctx.controller.handle("profile.models.list", {
    profileId: DEFAULT_AGENT_PROFILE_ID,
    cursor: null,
    limit: 100,
  });
  assert.deepEqual(page, {
    models: [{ id: "gpt-5", displayName: "GPT-5", description: "ChatGPT fixture model", isDefault: true }],
    nextCursor: null,
    hasMore: false,
  });
  assert.equal(ctx.calls.some(([kind]) => kind === "runtime.modelList"), true);

  const unavailable = fixture();
  await assert.rejects(
    () => unavailable.controller.handle("profile.bind", bindParams({
      operationId: "profile-chatgpt-model-unavailable",
      providerRef: null,
      defaultModel: "gpt-not-in-catalog",
    })),
    (error) => error.code === "PROFILE_MODEL_NOT_AVAILABLE",
  );
  assert.equal(unavailable.calls.some(([kind]) => kind === "putAgentProfile"), false);
}

async function testNonCodexProfileModelCatalogUsesBoundRuntimeWithoutChatGptAuthority() {
  const grokProfile = {
    ...defaultAgentProfile(NOW - 1000),
    id: "profile-grok",
    backendId: "grok-build",
    agentId: "shoggoth-grok",
    name: "Grok",
    runtime: "grok-build",
    runtimeProfileId: "shoggoth-grok",
    isDefault: false,
  };
  const ctx = fixture({
    shared: {
      currentProfile: grokProfile,
      providers: new Map(),
      ledger: new Map(),
      completeError: null,
    },
    models: [{
      model: "grok-4.6",
      displayName: "Grok 4.6",
      description: "Grok Build fixture model",
      hidden: false,
      isDefault: true,
    }],
  });
  const page = await ctx.controller.handle("profile.models.list", {
    profileId: grokProfile.id,
    cursor: null,
    limit: 100,
  });
  assert.deepEqual(page, {
    models: [{
      id: "grok-4.6",
      displayName: "Grok 4.6",
      description: "Grok Build fixture model",
      isDefault: true,
    }],
    nextCursor: null,
    hasMore: false,
  });
  assert.equal(ctx.calls.some(([kind]) => kind === "runtime.modelList"), true);
  assert.equal(ctx.calls.some(([kind]) => kind === "auth.read"), false);
}

async function testRuntimeAuthStatusIsVerifiedByOwningRuntime() {
  const codex = fixture();
  assert.deepEqual(await codex.controller.handle("profile.auth.read", {
    profileId: DEFAULT_AGENT_PROFILE_ID,
  }), { status: "authenticated" });
  assert.equal(codex.calls.some(([kind]) => kind === "runtime.accountRead"), true);

  const codexWithoutRequiredOpenAiAuth = fixture({
    runtimeAccountResult: { account: null, requiresOpenaiAuth: false, login: null },
  });
  assert.deepEqual(await codexWithoutRequiredOpenAiAuth.controller.handle("profile.auth.read", {
    profileId: DEFAULT_AGENT_PROFILE_ID,
  }), { status: "authenticated" });

  const codexMissingAuth = fixture({
    runtimeAccountResult: { account: null, requiresOpenaiAuth: true, login: null },
  });
  assert.deepEqual(await codexMissingAuth.controller.handle("profile.auth.read", {
    profileId: DEFAULT_AGENT_PROFILE_ID,
  }), { status: "unauthenticated" });

  const grokProfile = {
    ...defaultAgentProfile(NOW - 1000),
    id: "profile-grok-auth",
    backendId: "grok-build",
    agentId: "shoggoth-grok",
    name: "Grok",
    runtime: "grok-build",
    runtimeProfileId: "shoggoth-grok-auth",
    isDefault: false,
  };
  const grok = fixture({
    shared: {
      currentProfile: grokProfile,
      providers: new Map(),
      ledger: new Map(),
      completeError: null,
    },
    authenticationState: {
      authenticated: false, credentialPresent: true, methodId: null, methods: [],
    },
  });
  assert.deepEqual(await grok.controller.handle("profile.auth.read", {
    profileId: grokProfile.id,
  }), { status: "unverified" });
  assert.equal(grok.calls.some(([kind]) => kind === "runtime.authenticationState"), true);

  const grokMissingAuth = fixture({
    shared: {
      currentProfile: grokProfile,
      providers: new Map(),
      ledger: new Map(),
      completeError: null,
    },
    authenticationState: {
      authenticated: false, credentialPresent: false, methodId: null, methods: [],
    },
  });
  assert.deepEqual(await grokMissingAuth.controller.handle("profile.auth.read", {
    profileId: grokProfile.id,
  }), { status: "unauthenticated" });

  const malformed = fixture({
    runtimeAccountResult: { account: null, requiresOpenaiAuth: "yes", login: null },
  });
  await assert.rejects(
    () => malformed.controller.handle("profile.auth.read", {
      profileId: DEFAULT_AGENT_PROFILE_ID,
    }),
    (error) => error.code === "PROFILE_AUTH_STATUS_UNAVAILABLE"
      && error.message === "Runtime auth status is unavailable",
  );
}

async function testBindValidatedProviderAndInvalidateRuntime() {
  const ctx = fixture();
  const result = await ctx.controller.handle("profile.bind", bindParams());
  assert.equal(result.profile.id, DEFAULT_AGENT_PROFILE_ID);
  assert.equal(result.profile.providerRef, PROVIDER_ID);
  assert.equal(result.profile.defaultModel, "openai/gpt-5");
  assert.equal(ctx.nowCalls, 1, "mutation timestamp fence samples now once");
  assert.deepEqual(
    ctx.calls.filter(([kind]) => kind === "putAgentProfile"
      || kind === "runtime.stop").map(([kind]) => kind),
    ["putAgentProfile", "runtime.stop"],
  );
}

async function testSharedRuntimeAccountKeepsProviderProfileScoped() {
  const second = {
    ...defaultAgentProfile(NOW - 900),
    id: "agent-profile-shared-two",
    agentId: "agent-shared-two",
    runtimeProfileId: "agent-shared-two",
    name: "Shared two",
    providerRef: "provider-openai",
    defaultModel: "gpt-5",
    isDefault: false,
  };
  const ctx = fixture({ otherProfiles: [second] });
  const result = await ctx.controller.handle("profile.bind", bindParams({
    operationId: "profile-bind-shared-account",
  }));
  assert.equal(result.profile.providerRef, PROVIDER_ID);
  assert.equal(ctx.shared.currentAccount.providerRef, null);
  assert.equal(ctx.shared.otherProfiles[0].providerRef, "provider-openai");
  assert.equal(ctx.shared.otherProfiles[0].defaultModel, "gpt-5");
  assert.deepEqual(
    ctx.calls.filter(([kind]) => kind === "runtime.stop").map(([, binding]) => binding),
    [
      {
        runtime: "codex",
        runtimeProfileId: result.profile.runtimeProfileId,
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      },
    ],
  );
}

async function testProfileMutationDoesNotAdvanceRuntimeAccountAdmission() {
  const admissionCalls = [];
  const admission = {
    beginMutation(value) { admissionCalls.push(["begin", structuredClone(value)]); },
    finishMutation(value) { admissionCalls.push(["finish", structuredClone(value)]); },
    cancelMutation(value) { admissionCalls.push(["cancel", structuredClone(value)]); },
  };
  const success = fixture({ runtimeAccountAdmission: admission });
  await success.controller.handle("profile.bind", bindParams({
    operationId: "profile-bind-admission",
  }));
  assert.deepEqual(admissionCalls, []);
}

async function testBindRejectsUnvalidatedMismatchedOrUnauthorizedTargets() {
  for (const [label, mutate, expectedCode] of [
    ["unverified", (ctx) => ctx.providers.set(PROVIDER_ID, provider({ validationStatus: "unverified" })), "PROFILE_PROVIDER_NOT_READY"],
    ["invalid", (ctx) => ctx.providers.set(PROVIDER_ID, provider({ validationStatus: "invalid" })), "PROFILE_PROVIDER_NOT_READY"],
    ["model mismatch", () => {}, "PROFILE_MODEL_MISMATCH"],
  ]) {
    const ctx = fixture();
    mutate(ctx);
    const params = label === "model mismatch" ? bindParams({ defaultModel: "wrong-model" }) : bindParams();
    await assert.rejects(() => ctx.controller.handle("profile.bind", params), (error) => error.code === expectedCode);
    assert.equal(ctx.calls.some(([kind]) => kind === "putAgentProfile"), false, label);
  }
  const ctx = fixture();
  await assert.rejects(
    () => ctx.controller.handle("profile.bind", bindParams({ profileId: "some-other-profile" })),
    (error) => error.code === "PROFILE_NOT_FOUND",
  );
  for (const unauthorized of [{ backendId: "codex" }, { runtime: "grok-build" }, {
    runtimeAccountId: "native-codex-default-v1",
  }]) {
    const profile = {
      ...defaultAgentProfile(NOW - 900),
      id: `unauthorized-${Object.keys(unauthorized)[0]}`,
      agentId: `unauthorized-${Object.keys(unauthorized)[0]}`,
      runtimeProfileId: `unauthorized-${Object.keys(unauthorized)[0]}`,
      isDefault: false,
      ...unauthorized,
    };
    const denied = fixture({ otherProfiles: [profile] });
    await assert.rejects(
      () => denied.controller.handle("profile.bind", bindParams({
        operationId: `deny-${Object.keys(unauthorized)[0]}`,
        profileId: profile.id,
      })),
      (error) => error.code === "PROFILE_TARGET_FORBIDDEN",
    );
  }
}

async function testNonDefaultManagedProfileCanBindWithoutChangingDefaultSibling() {
  const second = {
    ...defaultAgentProfile(NOW - 900),
    id: "agent-profile-configurable-two",
    agentId: "agent-configurable-two",
    runtimeProfileId: "agent-configurable-two-runtime",
    name: "Configurable two",
    isDefault: false,
  };
  const ctx = fixture({ otherProfiles: [second] });
  const defaultBefore = ctx.profile;
  const result = await ctx.controller.handle("profile.bind", bindParams({
    operationId: "profile-bind-non-default",
    profileId: second.id,
  }));
  assert.equal(result.profile.id, second.id);
  assert.equal(result.profile.providerRef, PROVIDER_ID);
  assert.deepEqual(ctx.profile, defaultBefore);
  assert.equal(ctx.shared.otherProfiles[0].providerRef, PROVIDER_ID);
  assert.deepEqual(
    ctx.calls.filter(([kind]) => kind === "runtime.stop").map(([, binding]) => binding.runtimeProfileId),
    [second.runtimeProfileId],
  );
}

async function testOpenAiBindRejectsProviderOwnedByAnotherProfile() {
  const owner = {
    ...defaultAgentProfile(NOW - 900),
    id: "agent-profile-openai-owner",
    agentId: "agent-openai-owner",
    runtimeProfileId: "agent-openai-owner-runtime",
    name: "OpenAI owner",
    providerRef: "provider-openai",
    defaultModel: "gpt-5",
    isDefault: false,
  };
  const denied = fixture({ otherProfiles: [owner] });
  await assert.rejects(
    () => denied.controller.handle("profile.bind", bindParams({
      operationId: "profile-bind-openai-foreign-owner",
      providerRef: "provider-openai",
      defaultModel: "gpt-5",
    })),
    (error) => error.code === "PROFILE_PROVIDER_TARGET_FORBIDDEN",
  );
  assert.equal(denied.calls.some(([kind]) => kind === "putAgentProfile"), false);
  assert.equal(denied.calls.some(([kind]) => kind === "runtime.stop"), false);

  const own = fixture({ otherProfiles: [owner] });
  const rebound = await own.controller.handle("profile.bind", bindParams({
    operationId: "profile-bind-openai-existing-owner",
    profileId: owner.id,
    providerRef: "provider-openai",
    defaultModel: "gpt-5",
  }));
  assert.equal(rebound.profile.id, owner.id);
  assert.equal(rebound.profile.providerRef, "provider-openai");
}

async function testProfileClearIsCasBoundAndClearsOnlyTargetOpenAiProvider() {
  const second = {
    ...defaultAgentProfile(NOW - 900),
    id: "agent-profile-clear-two",
    agentId: "agent-clear-two",
    runtimeProfileId: "agent-clear-two-runtime",
    name: "Clear two",
    providerRef: "provider-openai",
    defaultModel: "gpt-5",
    isDefault: false,
  };
  const ctx = fixture({ otherProfiles: [second] });
  const defaultBefore = ctx.profile;
  const result = await ctx.controller.handle("profile.clear", {
    operationId: "profile-clear-non-default",
    profileId: second.id,
    providerRef: "provider-openai",
    defaultModel: "gpt-5",
    createdAt: NOW - 10,
  });
  assert.equal(result.profile.providerRef, null);
  assert.equal(result.profile.defaultModel, null);
  assert.deepEqual(ctx.profile, defaultBefore);
  assert.deepEqual(ctx.calls.filter(([kind]) => kind === "bootstrap.clear"), [[
    "bootstrap.clear",
    { profileId: second.id, providerRef: "provider-openai" },
  ]]);
  const putCount = ctx.calls.filter(([kind]) => kind === "putAgentProfile").length;
  const stopCount = ctx.calls.filter(([kind]) => kind === "runtime.stop").length;
  const clearCount = ctx.calls.filter(([kind]) => kind === "bootstrap.clear").length;
  assert.deepEqual(await ctx.controller.handle("profile.clear", {
    operationId: "profile-clear-non-default",
    profileId: second.id,
    providerRef: "provider-openai",
    defaultModel: "gpt-5",
    createdAt: NOW - 10,
  }), result);
  assert.equal(ctx.calls.filter(([kind]) => kind === "putAgentProfile").length, putCount);
  assert.equal(ctx.calls.filter(([kind]) => kind === "runtime.stop").length, stopCount);
  assert.equal(ctx.calls.filter(([kind]) => kind === "bootstrap.clear").length, clearCount);

  const stale = fixture({ otherProfiles: [second] });
  await assert.rejects(
    () => stale.controller.handle("profile.clear", {
      operationId: "profile-clear-stale-provider",
      profileId: second.id,
      providerRef: PROVIDER_ID,
      defaultModel: "openai/gpt-5",
      createdAt: NOW - 10,
    }),
    (error) => error.code === "PROFILE_OPERATION_CONFLICT",
  );
  assert.equal(stale.calls.some(([kind]) => kind === "putAgentProfile"), false);
}

async function testChatGptNullBindingRequiresAuthenticatedAuthority() {
  const ctx = fixture();
  const result = await ctx.controller.handle("profile.bind", bindParams({
    operationId: "profile-chatgpt-one",
    providerRef: null,
    defaultModel: "gpt-5",
  }));
  assert.equal(result.profile.providerRef, null);
  assert.equal(result.profile.defaultModel, "gpt-5");
  assert.equal(ctx.calls.some(([kind]) => kind === "auth.read"), true);

  const unauthenticated = fixture({
    authResult: { account: null, requiresOpenaiAuth: true, login: null },
  });
  await assert.rejects(
    () => unauthenticated.controller.handle("profile.bind", bindParams({
      operationId: "profile-chatgpt-two",
      providerRef: null,
      defaultModel: "gpt-5",
    })),
    (error) => error.code === "PROFILE_AUTH_REQUIRED",
  );
}

async function testExactReplayAndConflictDoNotRepeatSideEffects() {
  const ctx = fixture();
  const first = await ctx.controller.handle("profile.bind", bindParams());
  const second = await ctx.controller.handle("profile.bind", bindParams());
  assert.deepEqual(second, first);
  assert.equal(ctx.calls.filter(([kind]) => kind === "putAgentProfile").length, 1);
  assert.equal(ctx.calls.filter(([kind]) => kind === "runtime.stop").length, 1);
  assert.equal(ctx.nowCalls, 1, "exact replay occurs before consulting the mutable clock");
  await assert.rejects(
    () => ctx.controller.handle("profile.bind", bindParams({ defaultModel: "different" })),
    (error) => error.code === "PROFILE_OPERATION_CONFLICT",
  );
}

async function testReplaySurvivesClockFailureAndDoesNotRetainSecret() {
  const ctx = fixture({ nowError: new Error("clock unavailable"), nowErrorAfter: 1 });
  const input = {
    ...bindParams({
      operationId: "profile-configure-replay-clock",
      providerRef: "provider-openai",
      defaultModel: "gpt-5",
    }),
    secret: "sk-test-not-a-real-secret",
  };
  const first = await ctx.controller.handle("profile.configure", input);
  const second = await ctx.controller.handle("profile.configure", input);
  assert.deepEqual(second, first);
  assert.equal(ctx.nowCalls, 1);
  assert.ok(!JSON.stringify(ctx.controller.debugSnapshot?.() || {}).includes(input.secret));
}

async function testOpenAiConfigureUsesNarrowBootstrapThenBinds() {
  const ctx = fixture();
  const input = {
    ...bindParams({
      operationId: "profile-configure-openai",
      providerRef: "provider-openai",
      defaultModel: "gpt-5",
    }),
    secret: "sk-test-not-a-real-secret",
  };
  const result = await ctx.controller.handle("profile.configure", input);
  assert.equal(result.profile.providerRef, "provider-openai");
  assert.equal(result.profile.defaultModel, "gpt-5");
  assert.deepEqual(
    ctx.calls.filter(([kind]) => kind.startsWith("bootstrap") || kind === "putAgentProfile" || kind === "runtime.stop")
      .map(([kind]) => kind),
    ["bootstrap.configure", "putAgentProfile", "runtime.stop", "bootstrap.commit"],
  );
  assert.ok(!JSON.stringify(result).includes(input.secret));
}

async function testKnownBindFailureCompensatesButUncertainFailurePoisons() {
  const known = fixture({ putError: Object.assign(new Error("known"), { code: "STORE_WRITE_FAILED" }) });
  await assert.rejects(
    () => known.controller.handle("profile.configure", {
      ...bindParams({
        operationId: "profile-configure-known",
        providerRef: "provider-openai",
        defaultModel: "gpt-5",
      }),
      secret: "sk-test-not-a-real-secret",
    }),
    (error) => error.code === "INTERNAL_ERROR",
  );
  assert.equal(known.calls.some(([kind]) => kind === "bootstrap.compensate"), true);

  const uncertain = fixture({
    putError: Object.assign(new Error("uncertain"), { code: "STORE_COMMIT_UNCERTAIN" }),
  });
  await assert.rejects(
    () => uncertain.controller.handle("profile.configure", {
      ...bindParams({
        operationId: "profile-configure-uncertain",
        providerRef: "provider-openai",
        defaultModel: "gpt-5",
      }),
      secret: "sk-test-not-a-real-secret",
    }),
    (error) => error.code === "PROFILE_COMMIT_UNCERTAIN",
  );
  assert.equal(uncertain.calls.some(([kind]) => kind === "bootstrap.compensate"), false);
  await assert.rejects(
    () => uncertain.controller.handle("profile.bind", bindParams({ operationId: "after-poison" })),
    (error) => error.code === "PROFILE_COMMIT_UNCERTAIN",
  );
}

async function testRuntimeInvalidationFailurePoisonsController() {
  const admissionCalls = [];
  const ctx = fixture({
    stopError: new Error("stop failed"),
    runtimeAccountAdmission: {
      beginMutation(value) { admissionCalls.push(["begin", structuredClone(value)]); },
      finishMutation(value) { admissionCalls.push(["finish", structuredClone(value)]); },
      cancelMutation(value) { admissionCalls.push(["cancel", structuredClone(value)]); },
    },
  });
  await assert.rejects(
    () => ctx.controller.handle("profile.bind", bindParams()),
    (error) => error.code === "PROFILE_COMMIT_UNCERTAIN",
  );
  assert.deepEqual(admissionCalls, []);
  await assert.rejects(
    () => ctx.controller.handle("profile.bind", bindParams({ operationId: "after-stop-failure" })),
    (error) => error.code === "PROFILE_COMMIT_UNCERTAIN",
  );
}

async function testPostBindingBootstrapCommitFailurePoisonsWithoutCompensation() {
  const ctx = fixture({ commitError: new Error("credential cleanup failed") });
  await assert.rejects(
    () => ctx.controller.handle("profile.configure", {
      ...bindParams({
        operationId: "profile-configure-commit-failure",
        providerRef: "provider-openai",
        defaultModel: "gpt-5",
      }),
      secret: "sk-test-not-a-real-secret",
    }),
    (error) => error.code === "PROFILE_COMMIT_UNCERTAIN",
  );
  assert.equal(ctx.profile.providerRef, "provider-openai");
  assert.equal(ctx.calls.some(([kind]) => kind === "bootstrap.compensate"), false);
}

async function testDurableCompletedReplayPrecedesClockAndMutableDependenciesAcrossRestart() {
  const first = fixture();
  const params = bindParams({ operationId: "profile-durable-restart" });
  const result = await first.controller.handle("profile.bind", params);
  const record = [...first.shared.ledger.values()][0];
  assert.equal(record.status, "completed");
  assert.match(record.callId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  first.shared.currentProfile.enabled = false;
  first.shared.providers.clear();
  const restarted = fixture({
    shared: first.shared,
    nowError: new Error("clock must not run during completed replay"),
  });
  assert.deepEqual(await restarted.controller.handle("profile.bind", params), result);
  assert.equal(restarted.nowCalls, 0);
  assert.equal(restarted.calls.some(([kind]) => kind === "getAgentProfile" || kind === "getModelProvider"), false);
}

async function testPendingConfigureRecoversWithRetrySecretAndNeverPersistsRawSecret() {
  const first = fixture();
  first.shared.completeError = Object.assign(new Error("ledger completion uncertain"), { code: "STORE_COMMIT_UNCERTAIN" });
  const input = {
    ...bindParams({
      operationId: "profile-configure-pending-restart",
      providerRef: "provider-openai",
      defaultModel: "gpt-5",
    }),
    secret: "sk-test-not-a-real-secret",
  };
  await assert.rejects(
    () => first.controller.handle("profile.configure", input),
    (error) => error.code === "PROFILE_COMMIT_UNCERTAIN",
  );
  const pending = [...first.shared.ledger.values()][0];
  assert.equal(pending.status, "pending");
  assert.equal(JSON.stringify(pending).includes(input.secret), false);
  assert.match(pending.binding.secretDigest, /^[a-f0-9]{64}$/u);
  first.shared.completeError = null;
  const restarted = fixture({ shared: first.shared });
  await assert.rejects(
    () => restarted.controller.handle("profile.configure", { ...input, secret: "different-secret" }),
    (error) => error.code === "PROFILE_OPERATION_CONFLICT",
  );
  assert.equal(restarted.calls.some(([kind]) => kind === "bootstrap.configure"), false);
  const recovered = await restarted.controller.handle("profile.configure", input);
  assert.equal(recovered.profile.providerRef, "provider-openai");
  assert.equal(restarted.calls.some(([kind]) => kind === "bootstrap.configure"), true,
    "pending recovery 必须重放 key bootstrap；相同 binding 也可能是一次轮换");
  assert.equal(restarted.calls.filter(([kind]) => kind === "runtime.stop").length, 1,
    "pending recovery 必须再次确认 runtime generation 已失效");
  assert.equal([...first.shared.ledger.values()][0].status, "completed");
}

async function testKnownFailureIsDurablyReplayedAsFixedPublicCode() {
  const first = fixture({ putError: Object.assign(new Error("private path /secret"), { code: "STORE_WRITE_FAILED" }) });
  const params = bindParams({ operationId: "profile-known-failure-restart" });
  await assert.rejects(() => first.controller.handle("profile.bind", params), (error) => error.code === "INTERNAL_ERROR");
  const completed = [...first.shared.ledger.values()][0];
  assert.deepEqual(completed.result, { ok: false, publicCode: "INTERNAL_ERROR" });
  const restarted = fixture({ shared: first.shared, nowError: new Error("clock must not run") });
  await assert.rejects(() => restarted.controller.handle("profile.bind", params), (error) => error.code === "INTERNAL_ERROR");
  assert.equal(restarted.nowCalls, 0);
}

const tests = [
  testProtocolIsExactDescriptorSafeAndNeverReturnsSecrets,
  testChatGptModelCatalogAndBindingUseSameRuntimeAuthority,
  testNonCodexProfileModelCatalogUsesBoundRuntimeWithoutChatGptAuthority,
  testRuntimeAuthStatusIsVerifiedByOwningRuntime,
  testBindValidatedProviderAndInvalidateRuntime,
  testSharedRuntimeAccountKeepsProviderProfileScoped,
  testProfileMutationDoesNotAdvanceRuntimeAccountAdmission,
  testBindRejectsUnvalidatedMismatchedOrUnauthorizedTargets,
  testNonDefaultManagedProfileCanBindWithoutChangingDefaultSibling,
  testOpenAiBindRejectsProviderOwnedByAnotherProfile,
  testProfileClearIsCasBoundAndClearsOnlyTargetOpenAiProvider,
  testChatGptNullBindingRequiresAuthenticatedAuthority,
  testExactReplayAndConflictDoNotRepeatSideEffects,
  testReplaySurvivesClockFailureAndDoesNotRetainSecret,
  testOpenAiConfigureUsesNarrowBootstrapThenBinds,
  testKnownBindFailureCompensatesButUncertainFailurePoisons,
  testRuntimeInvalidationFailurePoisonsController,
  testPostBindingBootstrapCommitFailurePoisonsWithoutCompensation,
  testDurableCompletedReplayPrecedesClockAndMutableDependenciesAcrossRestart,
  testPendingConfigureRecoversWithRetrySecretAndNeverPersistsRawSecret,
  testKnownFailureIsDurablyReplayedAsFixedPublicCode,
];

(async () => {
  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  process.stdout.write(`${tests.length}/${tests.length} profile service tests passed\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
