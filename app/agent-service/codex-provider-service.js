"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  managedConfigFor,
  safelyDecodeUrlPathname,
  validateRuntimeConfig,
} = require("./codex-runtime-config");
const { providerCredentialEnvName } = require("./provider-runtime-bridge");
const { resolveCodexRuntimeLayout } = require("./codex-runtime-paths");
const { validateModelProvider } = require("./product-store");
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("./runtime-account");
const { serviceError } = require("./security");

const PRESET_KINDS = new Set([
  "openai-api-key", "openrouter", "ollama", "lmstudio", "custom-responses",
  "amazon-bedrock",
]);
const CUSTOM_SECRET_KINDS = new Set(["openai-api-key", "openrouter", "custom-responses"]);
const CONFIG_FIELDS = Object.freeze([
  "id", "kind", "name", "baseUrl", "model", "headers", "awsRegion", "awsProfile",
]);

function providerError(code, message) {
  return serviceError(code, message);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertNoFields(input, fields) {
  if (fields.some((field) => own(input, field))) {
    throw providerError("PROVIDER_PRESET_OVERRIDE_FORBIDDEN", "Provider preset fixed fields cannot be overridden");
  }
}

function normalizedPublicProductUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw providerError("PROVIDER_PUBLIC_PRODUCT_URL_REQUIRED", "OpenRouter requires the official HTTPS product URL");
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw providerError("PROVIDER_PUBLIC_PRODUCT_URL_REQUIRED", "OpenRouter requires the official HTTPS product URL");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password
    || parsed.search || parsed.hash
    || parsed.hostname.toLowerCase().split(".").at(-1) === "example") {
    throw providerError("PROVIDER_PUBLIC_PRODUCT_URL_REQUIRED", "OpenRouter requires the official HTTPS product URL");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function normalizedApiRoot(value) {
  if (typeof value !== "string") {
    throw providerError("PROVIDER_BASE_URL_REQUIRED", "Custom Responses requires an API root URL");
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw providerError("PROVIDER_BASE_URL_INVALID", "Custom Responses API root URL is invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw providerError("PROVIDER_BASE_URL_INVALID", "Custom Responses API root URL is invalid");
  }
  let decodedPathname;
  try { decodedPathname = safelyDecodeUrlPathname(value); } catch {
    throw providerError("PROVIDER_BASE_URL_INVALID", "Custom Responses API root URL is invalid");
  }
  const pathname = decodedPathname.replace(/\/+$/u, "") || "/";
  if (/(?:^|\/)responses$/iu.test(pathname) || /(?:^|\/)chat\/completions$/iu.test(pathname)) {
    throw providerError(
      "PROVIDER_BASE_URL_ENDPOINT_FORBIDDEN",
      "Custom Responses base URL must be an API root, not a request endpoint",
    );
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/u, "");
}

function buildProviderPreset(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype || !PRESET_KINDS.has(input.kind)) {
    throw providerError("PROVIDER_PRESET_INVALID", "Provider preset input is invalid");
  }
  assertNoFields(input, ["credentialRef", "validationStatus"]);
  const commonAllowed = ["id", "kind", "name", "model"];
  let allowed;
  let fixed;
  if (input.kind === "openrouter") {
    allowed = commonAllowed;
    assertNoFields(input, ["baseUrl", "headers", "awsRegion", "awsProfile"]);
    fixed = {
      baseUrl: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": normalizedPublicProductUrl(options.publicProductUrl),
        "X-OpenRouter-Title": "Shoggoth",
      },
      awsRegion: null,
      awsProfile: null,
    };
  } else if (input.kind === "custom-responses") {
    allowed = [...commonAllowed, "baseUrl", "headers"];
    assertNoFields(input, ["awsRegion", "awsProfile"]);
    fixed = {
      baseUrl: normalizedApiRoot(input.baseUrl),
      headers: input.headers ?? null,
      awsRegion: null,
      awsProfile: null,
    };
  } else if (input.kind === "amazon-bedrock") {
    allowed = [...commonAllowed, "awsRegion", "awsProfile"];
    assertNoFields(input, ["baseUrl", "headers"]);
    fixed = {
      baseUrl: null,
      headers: null,
      awsRegion: input.awsRegion ?? null,
      awsProfile: input.awsProfile ?? null,
    };
  } else {
    allowed = commonAllowed;
    assertNoFields(input, ["baseUrl", "headers", "awsRegion", "awsProfile"]);
    fixed = {
      baseUrl: input.kind === "ollama" ? "http://127.0.0.1:11434/v1"
        : input.kind === "lmstudio" ? "http://127.0.0.1:1234/v1" : null,
      headers: null,
      awsRegion: null,
      awsProfile: null,
    };
  }
  const unknown = Object.keys(input).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    throw providerError("PROVIDER_PRESET_OVERRIDE_FORBIDDEN", "Provider preset fixed fields cannot be overridden");
  }
  return validateModelProvider({
    id: input.id,
    kind: input.kind,
    name: input.name,
    baseUrl: fixed.baseUrl,
    model: input.model ?? null,
    credentialRef: options.credentialRef ?? null,
    headers: fixed.headers,
    awsRegion: fixed.awsRegion,
    awsProfile: fixed.awsProfile,
    validationStatus: options.validationStatus ?? "unverified",
  });
}

function providerConfigFingerprint(provider) {
  return JSON.stringify(Object.fromEntries(CONFIG_FIELDS.map((field) => [field, provider[field]])));
}

class CodexProviderProtocolValidator {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.spawnSync = options.spawnSync || spawnSync;
    this.layout = options.layout || null;
    this.layoutOptions = {
      repoRoot: options.repoRoot,
      packaged: options.packaged,
      resourcesPath: options.resourcesPath,
    };
    this.tempRoot = options.tempRoot || os.tmpdir();
  }

  validate(provider) {
    const layout = this.layout || resolveCodexRuntimeLayout(this.layoutOptions);
    const runtimeConfig = validateRuntimeConfig({
      provider: {
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        baseUrl: provider.baseUrl,
        model: provider.model,
        headers: provider.headers,
        awsRegion: provider.awsRegion,
        awsProfile: provider.awsProfile,
        credentialEnv: provider.credentialRef === null ? null : providerCredentialEnvName(provider),
      },
    });
    const codexHome = this.fs.mkdtempSync(path.join(this.tempRoot, "shoggoth-provider-validate-"));
    try {
      this.fs.chmodSync(codexHome, 0o700);
      this.fs.writeFileSync(path.join(codexHome, "config.toml"), managedConfigFor(runtimeConfig), {
        mode: 0o600,
        flag: "wx",
      });
      const result = this.spawnSync(layout.runtimePath, ["features", "list"], {
        cwd: codexHome,
        env: {
          HOME: codexHome,
          PATH: process.env.PATH || "/usr/bin:/bin",
          TMPDIR: this.tempRoot,
          CODEX_HOME: codexHome,
        },
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        shell: false,
        windowsHide: true,
      });
      if (result.status !== 0 || result.signal !== null || result.error) {
        const error = providerError(
          "PROVIDER_PROTOCOL_CONFIG_INVALID",
          "Codex rejected the generated provider configuration",
        );
        error.deterministic = result.signal === null && !result.error;
        throw error;
      }
      return { parsedBy: `codex-${layout.version}` };
    } finally {
      this.fs.rmSync(codexHome, { recursive: true, force: true });
    }
  }
}

class ProviderService {
  constructor(options = {}) {
    if (!options.productStore || !options.secretStore) {
      throw providerError("PROVIDER_SERVICE_DEPENDENCY_REQUIRED", "ProviderService dependencies are required");
    }
    this.productStore = options.productStore;
    this.secretStore = options.secretStore;
    this.runtimePool = options.runtimePool || null;
    this.publicProductUrl = options.publicProductUrl;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    if (options.protocolValidator) {
      this.protocolValidator = options.protocolValidator;
    } else {
      this.protocolValidatorOwner = new CodexProviderProtocolValidator({
        repoRoot: options.repoRoot,
        packaged: options.packaged,
        resourcesPath: options.resourcesPath,
      });
      this.protocolValidator = this.protocolValidatorOwner.validate.bind(this.protocolValidatorOwner);
    }
    this.commitUncertain = false;
    this.closing = false;
    this.closed = false;
    this.closePromise = null;
    this.providerTails = new Map();
    this.providerGenerations = new Map();
    this.deleteFlights = new Map();
    // 该 capability 仅交给 Service 内部的 ProfileController；它把 OpenAI key
    // 暂存为 Provider credential，待 Profile durable bind 成功后再清理旧密文。
    this.profileBootstrapCapability = Object.freeze({
      configureOpenAiApiKey: (input) => this.#acceptProviderOperation(
        input?.provider?.id,
        (assertCurrent) => this.#configureOpenAiApiKey(input, assertCurrent),
      ),
      clearUnreferencedOpenAiApiKey: (input) => this.#acceptProviderOperation(
        input?.providerRef,
        (assertCurrent) => this.#clearUnreferencedOpenAiApiKey(input, assertCurrent),
      ),
    });
  }

  open() {
    if (this.closePromise && !this.closed) {
      throw providerError("PROVIDER_SERVICE_CLOSING", "ProviderService is closing");
    }
    this.closePromise = null;
    this.closing = false;
    this.closed = false;
    return this;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const tails = [...this.providerTails.values()];
    this.closePromise = Promise.all(tails).then(() => {
      this.closed = true;
      this.providerTails.clear();
      this.deleteFlights.clear();
    });
    return this.closePromise;
  }

  list() {
    this.#assertAccepting();
    return this.productStore.listModelProviders();
  }

  save(input) {
    return this.#acceptProviderOperation(input?.id, async (assertCurrent) => {
      assertCurrent();
      const existing = typeof input?.id === "string" ? this.productStore.getModelProvider(input.id) : null;
      if (existing && existing.kind !== input.kind) {
        throw providerError(
          "PROVIDER_KIND_IMMUTABLE",
          "Provider kind cannot change in place; delete and recreate the provider",
        );
      }
      const draft = buildProviderPreset(input, {
        publicProductUrl: this.publicProductUrl,
        credentialRef: existing?.credentialRef ?? null,
        validationStatus: "unverified",
      });
      if (existing && providerConfigFingerprint(existing) === providerConfigFingerprint(draft)) {
        draft.validationStatus = existing.validationStatus;
      }
      const configChanged = existing !== null
        && providerConfigFingerprint(existing) !== providerConfigFingerprint(draft);
      const saved = this.#put(draft);
      if (configChanged) {
        await this.#stopBoundRuntimes(saved.id);
        assertCurrent();
      }
      return saved;
    });
  }

  delete(input) {
    let providerId;
    try {
      this.#assertAccepting();
      providerId = input?.providerId;
      if (typeof providerId !== "string") {
        throw providerError("PROVIDER_PARAMS_INVALID", "Provider parameters are invalid");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const existingFlight = this.deleteFlights.get(providerId);
    if (existingFlight) return existingFlight;
    // 删除请求入队即推进代际，让更早排队或正在等待 I/O 的操作在提交前失效。
    const deleteGeneration = this.#bumpGeneration(providerId);
    const operation = this.#enqueueProviderOperation(providerId, async (assertCurrent) => {
      assertCurrent();
      const existing = this.#get(providerId);
      let deleted;
      try { deleted = this.productStore.deleteModelProvider(providerId); } catch (error) {
        if (error?.code === "STORE_COMMIT_UNCERTAIN") this.commitUncertain = true;
        throw error;
      }
      if (existing.credentialRef !== null) {
        await this.#deleteObsoleteSecret(existing.credentialRef);
      }
      return deleted;
    });
    const flight = operation.finally(() => {
      if (this.deleteFlights.get(providerId)?.generation === deleteGeneration) {
        this.deleteFlights.delete(providerId);
      }
    });
    flight.generation = deleteGeneration;
    this.deleteFlights.set(providerId, flight);
    return flight;
  }

  setSecret(input) {
    return this.#acceptProviderOperation(
      input?.providerId,
      (assertCurrent) => this.#setSecret(input, assertCurrent),
    );
  }

  async #setSecret(input, assertCurrent) {
    assertCurrent();
    if (!input || typeof input !== "object" || Array.isArray(input)
      || typeof input.secret !== "string") {
      throw providerError("PROVIDER_SECRET_PARAMS_INVALID", "Provider secret parameters are invalid");
    }
    const existing = this.#get(input.providerId);
    const hasLegacyRuntimeProfile = existing.kind === "openai-api-key"
      && Object.keys(input).length === 3 && typeof input.runtimeProfileId === "string";
    if (Object.keys(input).length !== 2 && !hasLegacyRuntimeProfile) {
      throw providerError("PROVIDER_SECRET_PARAMS_INVALID", "Provider secret parameters are invalid");
    }
    if (!CUSTOM_SECRET_KINDS.has(existing.kind)) {
      throw providerError("PROVIDER_SECRET_AUTHORITY_FORBIDDEN", "This provider secret is managed by its authority");
    }
    if (hasLegacyRuntimeProfile) this.#assertRuntimeProfileBinding(existing, input.runtimeProfileId);
    const oldRef = existing.credentialRef;
    const newRef = `provider-credential-${this.randomUUID()}`;
    let secret = input.secret;
    try {
      try {
        await this.secretStore.put(newRef, secret, { kind: existing.kind });
      } catch (error) {
        if (error?.code === "SECRET_COMMIT_UNCERTAIN") {
          this.commitUncertain = true;
          throw providerError(
            "PROVIDER_COMMIT_UNCERTAIN",
            "Provider credential write is uncertain; Service restart is required",
          );
        }
        throw error;
      }
    } finally {
      secret = null;
    }
    try { assertCurrent(); } catch (error) {
      await this.#rollbackNewSecret(newRef, error);
      throw error;
    }
    let saved;
    try {
      saved = this.#put({ ...existing, credentialRef: newRef, validationStatus: "unverified" });
    } catch (error) {
      if (error?.code === "STORE_COMMIT_UNCERTAIN") {
        this.commitUncertain = true;
        throw providerError(
          "PROVIDER_COMMIT_UNCERTAIN",
          "Provider credential switch is uncertain; Service restart is required",
        );
      }
      await this.#rollbackNewSecret(newRef, error);
      throw error;
    }
    await this.#stopBoundRuntimes(existing.id);
    await this.#finishConvergedSecretCleanup(oldRef, assertCurrent);
    return saved;
  }

  clearSecret(input) {
    return this.#acceptProviderOperation(
      input?.providerId,
      (assertCurrent) => this.#clearSecret(input, assertCurrent),
    );
  }

  async #clearSecret(input, assertCurrent) {
    assertCurrent();
    if (!input || typeof input !== "object" || Array.isArray(input)
      || typeof input.providerId !== "string") {
      throw providerError("PROVIDER_SECRET_PARAMS_INVALID", "Provider secret parameters are invalid");
    }
    const { providerId } = input;
    const existing = this.#get(providerId);
    const hasLegacyRuntimeProfile = existing.kind === "openai-api-key"
      && Object.keys(input).length === 2 && typeof input.runtimeProfileId === "string";
    if (Object.keys(input).length !== 1 && !hasLegacyRuntimeProfile) {
      throw providerError("PROVIDER_SECRET_PARAMS_INVALID", "Provider secret parameters are invalid");
    }
    if (!CUSTOM_SECRET_KINDS.has(existing.kind)) {
      throw providerError("PROVIDER_SECRET_AUTHORITY_FORBIDDEN", "This provider secret is managed by its authority");
    }
    if (hasLegacyRuntimeProfile) this.#assertRuntimeProfileBinding(existing, input.runtimeProfileId);
    if (existing.credentialRef === null) return existing;
    const saved = this.#put({ ...existing, credentialRef: null, validationStatus: "unverified" });
    await this.#stopBoundRuntimes(existing.id);
    await this.#finishConvergedSecretCleanup(existing.credentialRef, assertCurrent);
    return saved;
  }

  #openAiBootstrapFence(input, assertProviderCurrent) {
    assertProviderCurrent();
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).length !== 5
      || typeof input.assertCurrent !== "function"
      || typeof input.secret !== "string" || input.secret.length < 4
      || typeof input.defaultModel !== "string" || input.defaultModel.length === 0
      || !input.profile || !input.provider) {
      throw providerError("PROVIDER_SECRET_PARAMS_INVALID", "Provider bootstrap parameters are invalid");
    }
    input.assertCurrent();
    const currentProfile = this.productStore.getAgentProfile(input.profile.id);
    const currentProvider = this.productStore.getModelProvider(input.provider.id);
    const profiles = this.productStore.listAgentProfiles();
    if (!currentProfile || !currentProvider
      || currentProfile.backendId !== "shoggoth" || currentProfile.runtime !== "codex"
      || currentProfile.runtimeAccountId !== SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
      || currentProfile.enabled !== true
      || profiles.filter((profile) => profile.runtimeProfileId === currentProfile.runtimeProfileId).length !== 1
      || profiles.some((profile) => profile.id !== currentProfile.id
        && profile.providerRef === currentProvider.id)
      || currentProvider.kind !== "openai-api-key"
      || currentProvider.model !== input.defaultModel
      || JSON.stringify(currentProfile) !== JSON.stringify(input.profile)
      || JSON.stringify(currentProvider) !== JSON.stringify(input.provider)) {
      throw providerError(
        "PROVIDER_RUNTIME_PROFILE_MISMATCH",
        "OpenAI bootstrap requires an exclusive Shoggoth Codex profile/provider binding",
      );
    }
    const profileSnapshot = JSON.stringify(currentProfile);
    return (expectedProvider) => {
      assertProviderCurrent();
      input.assertCurrent();
      const profile = this.productStore.getAgentProfile(currentProfile.id);
      const provider = this.productStore.getModelProvider(currentProvider.id);
      if (!profile || !provider || JSON.stringify(profile) !== profileSnapshot
        || JSON.stringify(provider) !== JSON.stringify(expectedProvider)) {
        throw providerError("PROVIDER_OPERATION_STALE", "OpenAI bootstrap authority changed");
      }
      return { profile, provider };
    };
  }

  async #compensateOpenAiBootstrap(
    providerBefore,
    providerPrepared,
    newCredentialRef,
    primaryError = null,
  ) {
    const errors = [];
    try {
      const current = this.productStore.getModelProvider(providerBefore.id);
      if (current && JSON.stringify(current) === JSON.stringify(providerPrepared)) {
        this.#put(providerBefore);
        await this.#stopBoundRuntimes(providerBefore.id);
      }
      else if (current && JSON.stringify(current) !== JSON.stringify(providerBefore)) {
        errors.push(providerError("PROVIDER_OPERATION_STALE", "OpenAI provider changed before compensation"));
      }
    } catch (error) { errors.push(error); }
    try { await this.#deleteSecretIfUnowned(newCredentialRef, true); } catch (error) { errors.push(error); }
    if (errors.length > 0) {
      this.commitUncertain = true;
      const aggregate = new AggregateError(
        [...(primaryError ? [primaryError] : []), ...errors],
        "OpenAI bootstrap compensation is uncertain",
      );
      aggregate.code = "PROVIDER_COMMIT_UNCERTAIN";
      throw aggregate;
    }
    if (primaryError) throw primaryError;
  }

  async #configureOpenAiApiKey(input, assertProviderCurrent) {
    const assertAuthorityCurrent = this.#openAiBootstrapFence(input, assertProviderCurrent);
    const { provider } = assertAuthorityCurrent(input.provider);
    const oldCredentialRef = provider.credentialRef;
    const newCredentialRef = `provider-credential-${this.randomUUID()}`;
    let secret = input.secret;
    let secretStored = false;
    let prepared = null;
    try {
      try {
        await this.secretStore.put(newCredentialRef, secret, { kind: provider.kind });
      } catch (error) {
        if (error?.code === "SECRET_COMMIT_UNCERTAIN") {
          this.commitUncertain = true;
          throw providerError(
            "PROVIDER_COMMIT_UNCERTAIN",
            "Provider credential write is uncertain; Service restart is required",
          );
        }
        throw error;
      }
      secretStored = true;
      assertAuthorityCurrent(provider);
      prepared = this.#put({
        ...provider,
        credentialRef: newCredentialRef,
        validationStatus: "unverified",
      });
      await this.#stopBoundRuntimes(provider.id);
      assertAuthorityCurrent(prepared);
      await this.protocolValidator(prepared);
      assertAuthorityCurrent(prepared);
      prepared = this.#put({ ...prepared, validationStatus: "protocol_valid" });
      return Object.freeze({
        provider: prepared,
        commit: () => this.#acceptProviderOperation(prepared.id, async (assertCurrent) => {
          assertCurrent();
          const latest = this.productStore.getModelProvider(prepared.id);
          if (!latest || JSON.stringify(latest) !== JSON.stringify(prepared)) {
            throw providerError("PROVIDER_OPERATION_STALE", "OpenAI provider changed before commit");
          }
          await this.#finishConvergedSecretCleanup(oldCredentialRef, assertCurrent);
        }),
        compensate: () => this.#acceptProviderOperation(prepared.id, async (assertCurrent) => {
          assertCurrent();
          const latest = this.productStore.getModelProvider(prepared.id);
          if (!latest || JSON.stringify(latest) !== JSON.stringify(prepared)) {
            throw providerError("PROVIDER_OPERATION_STALE", "OpenAI provider changed before compensation");
          }
          return this.#compensateOpenAiBootstrap(
            provider,
            prepared,
            newCredentialRef,
          );
        }),
      });
    } catch (error) {
      if (prepared) {
        return this.#compensateOpenAiBootstrap(
          provider,
          prepared,
          newCredentialRef,
          error,
        );
      }
      if (secretStored) await this.#rollbackNewSecret(newCredentialRef, error);
      throw error;
    } finally {
      secret = null;
    }
  }

  async #clearUnreferencedOpenAiApiKey(input, assertProviderCurrent) {
    assertProviderCurrent();
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).length !== 3
      || typeof input.assertCurrent !== "function"
      || typeof input.providerRef !== "string" || !input.profile) {
      throw providerError("PROVIDER_SECRET_PARAMS_INVALID", "Provider clear parameters are invalid");
    }
    input.assertCurrent();
    const profile = this.productStore.getAgentProfile(input.profile.id);
    if (!profile || JSON.stringify(profile) !== JSON.stringify(input.profile)
      || profile.backendId !== "shoggoth" || profile.runtime !== "codex"
      || profile.runtimeAccountId !== SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
      || profile.enabled !== true || profile.providerRef !== null || profile.defaultModel !== null) {
      throw providerError("PROVIDER_RUNTIME_PROFILE_MISMATCH", "Cleared Shoggoth profile changed");
    }
    const provider = this.productStore.getModelProvider(input.providerRef);
    if (!provider || provider.kind !== "openai-api-key"
      || this.productStore.listAgentProfiles().some((candidate) => (
        candidate.providerRef === input.providerRef
      ))) {
      return Object.freeze({ cleared: false });
    }
    if (provider.credentialRef === null) return Object.freeze({ cleared: false });
    const saved = this.#put({
      ...provider,
      credentialRef: null,
      validationStatus: "unverified",
    });
    assertProviderCurrent();
    input.assertCurrent();
    const currentProfile = this.productStore.getAgentProfile(profile.id);
    if (!currentProfile || JSON.stringify(currentProfile) !== JSON.stringify(profile)) {
      throw providerError("PROVIDER_OPERATION_STALE", "Cleared Shoggoth profile changed");
    }
    await this.#finishConvergedSecretCleanup(provider.credentialRef, assertProviderCurrent);
    return Object.freeze({ cleared: saved.credentialRef === null });
  }

  validate(input) {
    return this.#acceptProviderOperation(
      input?.providerId,
      (assertCurrent) => this.#validate(input, assertCurrent),
    );
  }

  async #validate(input, assertCurrent) {
    assertCurrent();
    if (!input || typeof input !== "object" || Array.isArray(input)
      || typeof input.providerId !== "string" || !["protocol", "agent"].includes(input.level)) {
      throw providerError("PROVIDER_VALIDATION_PARAMS_INVALID", "Provider validation parameters are invalid");
    }
    if (input.level === "agent") {
      if (input.allowPaidModelRequest !== true) {
        throw providerError(
          "PROVIDER_AGENT_VALIDATION_OPT_IN_REQUIRED",
          "Agent validation requires explicit paid model request opt-in",
        );
      }
      throw providerError(
        "PROVIDER_AGENT_VALIDATION_NOT_RUN",
        "Agent-compatible validation is not run in this phase",
      );
    }
    if (own(input, "allowPaidModelRequest") && input.allowPaidModelRequest !== false) {
      throw providerError("PROVIDER_VALIDATION_PARAMS_INVALID", "Protocol validation never makes paid model requests");
    }
    const provider = this.#get(input.providerId);
    if (provider.model === null || provider.model.trim().length === 0) {
      assertCurrent();
      this.#put({ ...provider, validationStatus: "invalid" });
      throw providerError("PROVIDER_MODEL_REQUIRED", "Protocol validation requires a model");
    }
    const before = JSON.stringify(provider);
    if ((provider.kind === "openrouter" || provider.kind === "openai-api-key")
      && provider.credentialRef === null) {
      assertCurrent();
      this.#put({ ...provider, validationStatus: "invalid" });
      throw providerError("PROVIDER_CREDENTIAL_REQUIRED", "Provider requires a stored credential");
    }
    if (provider.credentialRef !== null) {
      const metadata = this.secretStore.listMetadata()
        .find((entry) => entry.credentialRef === provider.credentialRef);
      if (!metadata || metadata.kind !== provider.kind) {
        assertCurrent();
        this.#put({ ...provider, validationStatus: "invalid" });
        throw providerError("PROVIDER_CREDENTIAL_INVALID", "Provider credential metadata is invalid");
      }
      let plaintext = await this.secretStore.get(provider.credentialRef);
      assertCurrent();
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        plaintext = null;
        this.#put({ ...provider, validationStatus: "invalid" });
        throw providerError("PROVIDER_CREDENTIAL_INVALID", "Provider credential is unavailable");
      }
      plaintext = null;
    }
    if (typeof this.protocolValidator !== "function") {
      throw providerError("PROVIDER_PROTOCOL_VALIDATOR_REQUIRED", "Provider protocol validator is unavailable");
    }
    let details;
    try {
      details = await this.protocolValidator(provider);
    } catch (error) {
      assertCurrent();
      const currentAfterFailure = this.#get(provider.id);
      if (error?.deterministic === true && JSON.stringify(currentAfterFailure) === before) {
        this.#put({ ...currentAfterFailure, validationStatus: "invalid" });
      }
      throw error;
    }
    assertCurrent();
    const current = this.#get(provider.id);
    if (JSON.stringify(current) !== before) {
      throw providerError("PROVIDER_VALIDATION_STALE", "Provider changed during validation");
    }
    this.#put({ ...current, validationStatus: "protocol_valid" });
    return { providerId: provider.id, validationStatus: "protocol_valid", ...details };
  }

  #get(providerId) {
    if (typeof providerId !== "string") {
      throw providerError("PROVIDER_PARAMS_INVALID", "Provider parameters are invalid");
    }
    const provider = this.productStore.getModelProvider(providerId);
    if (!provider) throw providerError("PROVIDER_NOT_FOUND", "Provider was not found");
    return provider;
  }

  #put(provider) {
    try {
      return this.productStore.putModelProvider(provider);
    } catch (error) {
      if (error?.code === "STORE_COMMIT_UNCERTAIN") this.commitUncertain = true;
      throw error;
    }
  }

  async #deleteObsoleteSecret(credentialRef) {
    return this.#deleteSecretIfUnowned(credentialRef, false);
  }

  async #finishConvergedSecretCleanup(credentialRef, assertCurrent) {
    let staleError = null;
    try { assertCurrent(); } catch (error) { staleError = error; }
    if (credentialRef !== null) {
      try {
        await this.#deleteObsoleteSecret(credentialRef);
      } catch (cleanupError) {
        if (!staleError) throw cleanupError;
        const aggregate = new AggregateError(
          [staleError, cleanupError],
          "Provider operation became stale after runtime convergence and secret cleanup is uncertain",
        );
        aggregate.code = "PROVIDER_COMMIT_UNCERTAIN";
        throw aggregate;
      }
    }
    if (staleError) throw staleError;
  }

  async #rollbackNewSecret(credentialRef, primaryError) {
    try {
      await this.#deleteSecretIfUnowned(credentialRef, true);
    } catch (rollbackError) {
      const aggregate = new AggregateError(
        [primaryError, rollbackError],
        "Provider credential switch failed and rollback is uncertain",
      );
      aggregate.code = "PROVIDER_COMMIT_UNCERTAIN";
      throw aggregate;
    }
  }

  async #deleteSecretIfUnowned(credentialRef, rawUncertain) {
    const referenced = this.productStore.listModelProviders()
      .some((provider) => provider.credentialRef === credentialRef);
    if (referenced) return false;
    try {
      await this.secretStore.delete(credentialRef);
    } catch (error) {
      if (error?.code === "SECRET_COMMIT_UNCERTAIN") {
        this.commitUncertain = true;
        if (rawUncertain) throw error;
        throw providerError(
          "PROVIDER_COMMIT_UNCERTAIN",
          "Provider credential cleanup is uncertain; Service restart is required",
        );
      }
      // Provider 引用已经安全切换；已知未提交的清理失败只会留下不可达密文。
    }
    return true;
  }

  #assertRuntimeProfileBinding(provider, runtimeProfileId) {
    const profiles = this.productStore.listAgentProfiles()
      .filter((profile) => profile.runtimeProfileId === runtimeProfileId);
    if (provider.kind !== "openai-api-key" || profiles.length !== 1
      || profiles[0].providerRef !== provider.id) {
      throw providerError(
        "PROVIDER_RUNTIME_PROFILE_MISMATCH",
        "Runtime profile is not bound to the target OpenAI provider",
      );
    }
    return profiles[0];
  }

  async #stopBoundRuntimes(providerId) {
    const stopped = new Set();
    for (let pass = 0; pass < 8; pass += 1) {
      const pending = [...new Set(this.productStore.listAgentProfiles()
        .filter((profile) => profile.providerRef === providerId)
        .map((profile) => profile.runtimeProfileId))]
        .filter((runtimeProfileId) => !stopped.has(runtimeProfileId));
      if (pending.length === 0) return;
      if (typeof this.runtimePool?.stop !== "function") {
        this.commitUncertain = true;
        throw providerError(
          "PROVIDER_COMMIT_UNCERTAIN",
          "Provider changed but bound runtime cleanup is unavailable; Service restart is required",
        );
      }
      const results = await Promise.allSettled(
        pending.map((runtimeProfileId) => this.runtimePool.stop(runtimeProfileId)),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        this.commitUncertain = true;
        throw providerError(
          "PROVIDER_COMMIT_UNCERTAIN",
          "Provider changed but bound runtime cleanup is uncertain; Service restart is required",
        );
      }
      for (const runtimeProfileId of pending) stopped.add(runtimeProfileId);
    }
    this.commitUncertain = true;
    throw providerError(
      "PROVIDER_COMMIT_UNCERTAIN",
      "Provider bindings changed repeatedly during runtime cleanup; Service restart is required",
    );
  }

  #generation(providerId) {
    return this.providerGenerations.get(providerId) || 0;
  }

  #bumpGeneration(providerId) {
    const next = this.#generation(providerId) + 1;
    this.providerGenerations.set(providerId, next);
    return next;
  }

  #acceptProviderOperation(providerId, action) {
    try {
      this.#assertAccepting();
      if (typeof providerId !== "string") {
        throw providerError("PROVIDER_PARAMS_INVALID", "Provider parameters are invalid");
      }
      if (this.deleteFlights.has(providerId)) {
        throw providerError("PROVIDER_OPERATION_STALE", "Provider deletion is already in progress");
      }
      return this.#enqueueProviderOperation(providerId, action, this.#generation(providerId));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #enqueueProviderOperation(providerId, action, generation = this.#generation(providerId)) {
    // 每个 Provider 共用一条 tail；不同 Provider 仍可并行，close 只需等待这些 tail。
    const previous = this.providerTails.get(providerId) || Promise.resolve();
    const assertCurrent = () => {
      if (this.#generation(providerId) !== generation) {
        throw providerError("PROVIDER_OPERATION_STALE", "Provider operation became stale");
      }
    };
    const operation = previous.then(() => action(assertCurrent));
    const tail = operation.catch(() => {});
    this.providerTails.set(providerId, tail);
    void tail.finally(() => {
      if (this.providerTails.get(providerId) === tail) this.providerTails.delete(providerId);
    });
    return operation;
  }

  #assertAccepting() {
    this.#assertUsable();
    if (this.closing || this.closed) {
      throw providerError("PROVIDER_SERVICE_CLOSING", "ProviderService is closing");
    }
  }

  #assertUsable() {
    if (this.commitUncertain) {
      throw providerError("PROVIDER_COMMIT_UNCERTAIN", "Provider state is uncertain; Service restart is required");
    }
  }
}

module.exports = {
  CodexProviderProtocolValidator,
  CONFIG_FIELDS,
  PRESET_KINDS,
  ProviderService,
  buildProviderPreset,
  normalizedApiRoot,
  normalizedPublicProductUrl,
  providerConfigFingerprint,
  providerError,
};
