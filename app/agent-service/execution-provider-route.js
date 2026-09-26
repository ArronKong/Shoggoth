"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { validRuntimeAccountId } = require("./runtime-adapter");

const HASH = /^[a-f0-9]{64}$/u;
const PROVIDER_FIELDS = ["providerRef", "providerRevision", "credentialRef", "credentialRevision", "modelRef"];
const FENCE_FIELDS = ["profileId", "accountId", "accountRevision", "accountFingerprint",
  "providerFingerprint", "profileRouteFingerprint"];

function routeError(code = "EXECUTION_CONTRACT_STALE") {
  return serviceError(code, code === "EXECUTION_CONTRACT_STALE"
    ? "执行契约的 Provider、账号或凭据已变化，请重新发起执行"
    : "冻结的 Provider 执行契约无效");
}

function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    });
}

function text(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !value.includes("\0") && value.isWellFormed();
}

function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function profileRoute(profile) {
  return {
    profileId: profile.id, runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, enabled: profile.enabled,
    providerRef: profile.providerRef, defaultModel: profile.defaultModel,
    permissionPolicy: profile.permissionPolicy,
  };
}

function validateFrozenExecutionProviderRoute(contract) {
  const provider = contract?.provider;
  const fence = contract?.providerFence;
  if (!exact(provider, PROVIDER_FIELDS) || !exact(fence, FENCE_FIELDS)
    || !(provider.providerRef === null || text(provider.providerRef, 128))
    || !(provider.credentialRef === null || text(provider.credentialRef, 128))
    || !(provider.modelRef === null || text(provider.modelRef, 1024))
    || !(provider.providerRef === null ? provider.providerRevision === null : revision(provider.providerRevision))
    || !(provider.credentialRef === null ? provider.credentialRevision === null : revision(provider.credentialRevision))
    || (provider.providerRef === null && provider.credentialRef !== null)
    || !text(fence.profileId, 4096) || !validRuntimeAccountId(fence.accountId)
    || !revision(fence.accountRevision) || !HASH.test(fence.accountFingerprint)
    || !HASH.test(fence.profileRouteFingerprint)
    || !(provider.providerRef === null ? fence.providerFingerprint === null : HASH.test(fence.providerFingerprint))
    || (contract.bindingId !== undefined && contract.bindingId !== null && !text(contract.bindingId, 128))
    || (contract.profileId !== undefined && contract.profileId !== fence.profileId)
    || (contract.runtimeAccountId !== undefined && contract.runtimeAccountId !== fence.accountId)) {
    throw routeError("EXECUTION_CONTRACT_INVALID");
  }
  return Object.freeze({
    ...(contract.bindingId === undefined ? {} : { bindingId: contract.bindingId }),
    provider: Object.freeze(Object.fromEntries(PROVIDER_FIELDS.map((field) => [field, provider[field]]))),
    providerFence: Object.freeze(Object.fromEntries(FENCE_FIELDS.map((field) => [field, fence[field]]))),
  });
}

function captureExecutionProviderRoute({ productStore, secretStore, profile, modelRef = null, bindingId = undefined }) {
  const selectedBindingId = bindingId ?? profile?.selectedBindingId ?? profile?.defaultBindingId;
  if (selectedBindingId !== undefined && productStore.resolveAgentRuntimeProfile) {
    try { profile = productStore.resolveAgentRuntimeProfile(profile.id, selectedBindingId); } catch { throw routeError(); }
  }
  if (!profile || profile.enabled !== true) throw routeError();
  const account = productStore.getRuntimeAccount(profile.runtimeAccountId);
  if (!account || account.runtime !== profile.runtime) throw routeError();
  const provider = profile.providerRef === null ? null : productStore.getModelProvider(profile.providerRef);
  if (profile.providerRef !== null && !provider) throw routeError();
  const providerRevision = provider === null ? null : productStore.getModelProviderRevision?.(provider.id);
  const credentialRef = provider?.credentialRef ?? null;
  const credentialRevision = credentialRef === null ? null : secretStore?.getCredentialRevision?.(credentialRef);
  if (provider !== null && !revision(providerRevision)) throw routeError();
  if (credentialRef !== null && !revision(credentialRevision)) throw routeError();
  return validateFrozenExecutionProviderRoute({
    ...(selectedBindingId === undefined ? {} : { bindingId: selectedBindingId }),
    provider: {
      providerRef: provider?.id ?? null, providerRevision, credentialRef, credentialRevision,
      modelRef: modelRef ?? profile.defaultModel ?? provider?.model ?? null,
    },
    providerFence: {
      profileId: profile.id, accountId: account.id, accountRevision: account.updatedAt ?? 0,
      accountFingerprint: fingerprint(account), providerFingerprint: provider === null ? null : fingerprint(provider),
      profileRouteFingerprint: fingerprint(profileRoute(profile)),
    },
  });
}

function assertExecutionProviderRouteCurrent(contract, { productStore, secretStore }) {
  const frozen = validateFrozenExecutionProviderRoute(contract);
  let current;
  try {
    current = captureExecutionProviderRoute({ productStore, secretStore,
      profile: productStore.getAgentProfile(frozen.providerFence.profileId), modelRef: frozen.provider.modelRef,
      bindingId: frozen.bindingId ?? undefined });
  } catch { throw routeError(); }
  if (JSON.stringify(current) !== JSON.stringify(frozen)) throw routeError();
  return true;
}

module.exports = {
  captureExecutionProviderRoute,
  assertExecutionProviderRouteCurrent,
  validateFrozenExecutionProviderRoute,
};
