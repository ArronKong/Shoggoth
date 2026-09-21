"use strict";

const crypto = require("node:crypto");
const { OPENAI_API_KEY_ENV } = require("./codex-runtime-config");
const { assertRuntimeProfileId, runtimeError } = require("./codex-runtime-paths");
const { validRuntimeAccountId } = require("./runtime-adapter");

const AWS_CREDENTIAL_CHAIN_ENV_KEYS = Object.freeze([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_BEARER_TOKEN_BEDROCK",
]);
const AWS_SECRET_ENV_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
]);
const MAX_AWS_ENV_VALUE_BYTES = 64 * 1024;

function providerCredentialEnvName(provider) {
  if (!provider || typeof provider.id !== "string" || typeof provider.kind !== "string") {
    throw runtimeError("MODEL_PROVIDER_INVALID", "ModelProvider identity is invalid");
  }
  if (provider.kind === "openai-api-key") return OPENAI_API_KEY_ENV;
  const digest = crypto.createHash("sha256")
    .update(provider.kind)
    .update("\0")
    .update(provider.id)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `SHOGGOTH_PROVIDER_${digest}_API_KEY`;
}

function bridgeError(code, message) {
  return runtimeError(code, message);
}

function bedrockSpawnEnvironment(parentEnv, provider) {
  // AWS authority 仍由标准 SDK credential chain 管理；这里只对白名单显式透传，且固定配置优先。
  const spawnEnv = {};
  for (const key of AWS_CREDENTIAL_CHAIN_ENV_KEYS) {
    const value = parentEnv?.[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAX_AWS_ENV_VALUE_BYTES) {
      throw bridgeError("AWS_CREDENTIAL_ENV_INVALID", "AWS credential chain environment is invalid");
    }
    spawnEnv[key] = value;
  }
  spawnEnv.AWS_REGION = provider.awsRegion;
  spawnEnv.AWS_DEFAULT_REGION = provider.awsRegion;
  if (provider.awsProfile !== null) spawnEnv.AWS_PROFILE = provider.awsProfile;
  const registeredSecrets = [];
  for (const key of AWS_SECRET_ENV_KEYS) {
    const value = spawnEnv[key];
    if (value === undefined) continue;
    if (Buffer.byteLength(value, "utf8") < 4) {
      throw bridgeError("AWS_CREDENTIAL_ENV_INVALID", "AWS credential chain environment is invalid");
    }
    if (!registeredSecrets.includes(value)) registeredSecrets.push(value);
  }
  return { spawnEnv, registeredSecrets };
}

class ProviderRuntimeBridge {
  constructor(options = {}) {
    if (!options.productStore || !options.secretStore
      || typeof options.configWriter?.overlay !== "function") {
      throw bridgeError("PROVIDER_RUNTIME_DEPENDENCY_REQUIRED", "Provider runtime dependencies are required");
    }
    this.productStore = options.productStore;
    this.secretStore = options.secretStore;
    this.configWriter = options.configWriter;
    this.parentEnv = options.parentEnv || process.env;
  }

  open() { return this; }
  async close() {}

  async prepareRuntime({
    runtimeProfileId,
    runtimeAccountId,
    codexHome,
    configurationMode = "overlay",
  }) {
    assertRuntimeProfileId(runtimeProfileId);
    if (!validRuntimeAccountId(runtimeAccountId)) {
      throw bridgeError("RUNTIME_ACCOUNT_INVALID", "Runtime account is invalid");
    }
    if (!["persistent", "overlay"].includes(configurationMode)) {
      throw bridgeError("CODEX_RUNTIME_CONFIG_INVALID", "Codex runtime configuration mode is invalid");
    }
    const profiles = this.productStore.listAgentProfiles()
      .filter((profile) => profile.runtimeProfileId === runtimeProfileId
        && profile.runtimeAccountId === runtimeAccountId);
    if (profiles.length === 0) {
      throw bridgeError("RUNTIME_PROFILE_NOT_FOUND", "Runtime profile was not found");
    }
    if (profiles.length !== 1) {
      throw bridgeError("RUNTIME_PROFILE_AMBIGUOUS", "Runtime profile identity is ambiguous");
    }
    const profile = profiles[0];
    if (!profile.enabled) throw bridgeError("RUNTIME_PROFILE_DISABLED", "Runtime profile is disabled");
    if (profile.providerRef === null) {
      const configured = configurationMode === "overlay"
        ? this.configWriter.overlay({ runtimeProfileId, runtimeAccountId, runtimeConfig: null })
        // Explicit legacy/test compatibility only. RuntimeAccountResolver always
        // selects overlay mode, so production runtime acquisition cannot write a
        // Profile-specific config into a CLI Home.
        : this.configWriter.write({
          runtimeProfileId, runtimeAccountId, codexHome, runtimeConfig: null,
        });
      return Object.freeze({
        spawnEnv: Object.freeze({}),
        registeredSecrets: Object.freeze([]),
        runtimeConfig: null,
        configArgs: configured.args || Object.freeze([]),
      });
    }
    const provider = this.productStore.getModelProvider(profile.providerRef);
    if (!provider) throw bridgeError("MODEL_PROVIDER_NOT_FOUND", "ModelProvider was not found");
    if (provider.kind === "openai-api-key" && provider.credentialRef === null) {
      throw bridgeError("credentials_missing", "credentials_missing");
    }
    let plaintext = null;
    let credentialEnv = null;
    try {
      if (provider.credentialRef !== null) {
        const metadata = this.secretStore.listMetadata()
          .find((entry) => entry.credentialRef === provider.credentialRef);
        if (!metadata) throw bridgeError("credentials_missing", "credentials_missing");
        if (metadata.kind !== provider.kind) throw bridgeError("credentials_mismatch", "credentials_mismatch");
        plaintext = await this.secretStore.get(provider.credentialRef);
        if (typeof plaintext !== "string" || plaintext.length === 0) {
          throw bridgeError("credentials_missing", "credentials_missing");
        }
        credentialEnv = providerCredentialEnvName(provider);
      }
      const runtimeConfig = {
        provider: {
          id: provider.id,
          kind: provider.kind,
          name: provider.name,
          baseUrl: provider.baseUrl,
          model: provider.kind === "custom-responses" ? profile.defaultModel ?? provider.model : provider.model,
          headers: provider.headers,
          awsRegion: provider.awsRegion,
          awsProfile: provider.awsProfile,
          credentialEnv,
        },
      };
      const configured = configurationMode === "overlay"
        ? this.configWriter.overlay({ runtimeProfileId, runtimeAccountId, runtimeConfig })
        : this.configWriter.write({ runtimeProfileId, runtimeAccountId, codexHome, runtimeConfig });
      let spawnEnv = plaintext === null ? {} : { [credentialEnv]: plaintext };
      let registeredSecrets = plaintext === null ? [] : [plaintext];
      if (provider.kind === "amazon-bedrock") {
        ({ spawnEnv, registeredSecrets } = bedrockSpawnEnvironment(this.parentEnv, provider));
      }
      return Object.freeze({
        spawnEnv: Object.freeze(spawnEnv),
        registeredSecrets: Object.freeze(registeredSecrets),
        runtimeConfig,
        configArgs: configured.args || Object.freeze([]),
      });
    } finally {
      plaintext = null;
    }
  }
}

module.exports = {
  AWS_CREDENTIAL_CHAIN_ENV_KEYS,
  AWS_SECRET_ENV_KEYS,
  ProviderRuntimeBridge,
  bedrockSpawnEnvironment,
  bridgeError,
  providerCredentialEnvName,
};
