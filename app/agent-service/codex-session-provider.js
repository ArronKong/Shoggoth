"use strict";

// Per-conversation model source for the built-in Codex Harness.
//
// AgentProfile.providerRef stays the only Provider authority and remains the
// default for new conversations, HEARTBEAT and other sessionless work. A chat
// session may select any other source of this Profile: ChatGPT, a preset the
// Models page configured for it (OpenAI API Key, OpenRouter, Ollama, LM
// Studio, Bedrock) or any Shoggoth custom endpoint. Execution app-servers
// are reused by source; the management app-server defaults to ChatGPT.

const { serviceError } = require("./security");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
const { providerConfigAlias } = require("./codex-runtime-config");

const CHATGPT_SELECTION = "@chatgpt";
const PRESET_KINDS = Object.freeze(["openai-api-key", "openrouter", "ollama", "lmstudio", "amazon-bedrock"]);
const CODEX_CUSTOM_CONFIG_KINDS = new Set(["openai-api-key", "openrouter", "ollama", "lmstudio", "custom-responses"]);
const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function providerError(code = "SESSION_MODEL_PROVIDER_UNAVAILABLE") {
  return serviceError(code, code === "SESSION_MODEL_PROVIDER_UNAVAILABLE"
    ? "此会话选择的模型来源已不可用，请在模型菜单重新选择模型"
    : "模型来源选择无效");
}

function validProviderSelection(value) {
  return value === CHATGPT_SELECTION || (typeof value === "string" && ENDPOINT_ID.test(value));
}

function supportsSessionProviders(profile) {
  return profile?.runtime === "codex" && profile.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID;
}

function isEndpointProvider(provider) {
  return provider?.kind === "custom-responses";
}

// The id the Models page gives a preset of `kind` for this Profile
// (manage-ui/src/lib/shoggothProvider.ts profileProviderId).
function presetProviderId(kind, profile) {
  if (profile.isDefault === true) return `provider-${kind}`;
  let hash = 0x811c9dc5;
  for (const point of profile.id) {
    hash ^= point.codePointAt(0) || 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const prefix = `provider-${kind}-`;
  const suffix = `-${hash.toString(16).padStart(8, "0")}`;
  return `${prefix}${profile.id.slice(0, 128 - prefix.length - suffix.length)}${suffix}`;
}

// A provider another Profile uses as its default is managed there.
function ownedElsewhere(profiles, profile, providerId) {
  return profiles.some((candidate) => candidate.id !== profile.id && candidate.providerRef === providerId);
}

// Same ownership rule as CustomEndpointService.list: an endpoint referenced by
// another backend's Profile is managed there and is never offered here.
function shoggothEndpoints(productStore) {
  if (typeof productStore?.listModelProviders !== "function") return [];
  const profiles = productStore.listAgentProfiles();
  return productStore.listModelProviders().filter((provider) => isEndpointProvider(provider)
    && !profiles.some((profile) => profile.providerRef === provider.id && profile.backendId !== "shoggoth"))
    .sort((left, right) => left.id.localeCompare(right.id));
}

// Presets configured for this Profile, in the Models page's order. Its own
// default provider always counts, whatever its id.
function presetProviders(productStore, profile) {
  if (typeof productStore?.listModelProviders !== "function") return [];
  const profiles = productStore.listAgentProfiles();
  const owned = new Set(PRESET_KINDS.map((kind) => presetProviderId(kind, profile)));
  return productStore.listModelProviders()
    .filter((provider) => PRESET_KINDS.includes(provider.kind)
      && (provider.id === profile.providerRef
        || (owned.has(provider.id) && !ownedElsewhere(profiles, profile, provider.id))))
    .sort((left, right) => PRESET_KINDS.indexOf(left.kind) - PRESET_KINDS.indexOf(right.kind)
      || left.id.localeCompare(right.id));
}

// Every non-ChatGPT source of this Profile: presets, then custom endpoints.
// Readiness (validation, credentials) is left to each caller.
function sourceProviders(productStore, profile) {
  if (!supportsSessionProviders(profile)) return [];
  const presets = presetProviders(productStore, profile);
  const endpoints = shoggothEndpoints(productStore).filter((provider) => !presets.some((preset) => preset.id === provider.id));
  return [...presets, ...endpoints];
}

function isSourceProvider(productStore, profile, providerRef) {
  return providerRef === null || sourceProviders(productStore, profile).some((provider) => provider.id === providerRef);
}

// Returns the providerRef a selection names; throws when it is not available.
function resolveProviderSelection(productStore, profile, selection) {
  if (selection === null || selection === undefined || !supportsSessionProviders(profile)) return profile.providerRef;
  if (!validProviderSelection(selection)) throw providerError("SESSION_MODEL_PROVIDER_INVALID");
  if (selection === CHATGPT_SELECTION) return null;
  if (!isSourceProvider(productStore, profile, selection)) throw providerError();
  return selection;
}

// The Profile as seen by one execution route. Only providerRef and the model
// that belongs to that provider change; every other field stays the Profile's.
function applyProviderRef(productStore, profile, providerRef) {
  if (providerRef === undefined || providerRef === profile.providerRef) return profile;
  if (!supportsSessionProviders(profile) || !isSourceProvider(productStore, profile, providerRef)) throw providerError();
  const provider = providerRef === null ? null : productStore.getModelProvider(providerRef);
  return { ...profile, providerRef, defaultModel: provider?.model ?? null };
}

// Selection token that names providerRef for this Profile (null = Profile default).
function selectionForProviderRef(_productStore, profile, providerRef) {
  if (providerRef === profile.providerRef) return null;
  return providerRef === null ? CHATGPT_SELECTION : providerRef;
}

// Explicit token of a providerRef, independent of the Profile default.
function sourceToken(providerRef) {
  return providerRef === null ? CHATGPT_SELECTION : providerRef;
}

// Codex config identity of a provider, as declared by codex-runtime-config.
function codexModelProvider(productStore, providerRef) {
  if (providerRef === null) return Object.freeze({ kind: "chatgpt", configId: "openai" });
  const provider = productStore.getModelProvider(providerRef);
  if (!provider) throw providerError();
  if (provider.kind === "chatgpt") return Object.freeze({ kind: "chatgpt", configId: "openai" });
  if (provider.kind === "amazon-bedrock") return Object.freeze({ kind: provider.kind, configId: "amazon-bedrock" });
  if (!CODEX_CUSTOM_CONFIG_KINDS.has(provider.kind)) throw providerError();
  return Object.freeze({ kind: provider.kind, configId: providerConfigAlias(provider) });
}

// Only a ChatGPT thread needs the ChatGPT sign-in; every other source carries
// its own credential.
function providerRequiresOpenaiAuth(productStore, providerRef) {
  return codexModelProvider(productStore, providerRef).kind === "chatgpt";
}

function routeRequiresOpenaiAuth(productStore, contract) {
  if (contract?.runtime !== undefined && !supportsSessionProviders(contract)) return true;
  const providerRef = contract?.provider?.providerRef;
  if (providerRef === undefined) return true;
  try { return providerRequiresOpenaiAuth(productStore, providerRef); } catch { return true; }
}

module.exports = {
  CHATGPT_SELECTION,
  PRESET_KINDS,
  applyProviderRef,
  codexModelProvider,
  isEndpointProvider,
  isSourceProvider,
  presetProviderId,
  presetProviders,
  providerRequiresOpenaiAuth,
  resolveProviderSelection,
  routeRequiresOpenaiAuth,
  selectionForProviderRef,
  shoggothEndpoints,
  sourceProviders,
  sourceToken,
  supportsSessionProviders,
  validProviderSelection,
};
