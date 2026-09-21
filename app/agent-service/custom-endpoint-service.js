"use strict";

const crypto = require("node:crypto");
const { buildProviderPreset, normalizedApiRoot } = require("./codex-provider-service");
const { discoverCustomResponseModels } = require("./custom-response-models");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");

const error = (message) => Object.assign(new Error(message), { code: "CUSTOM_ENDPOINT_REJECTED" });
const modelsOf = (provider) => provider.models ?? (provider.model ? [provider.model] : []);

// Endpoint configuration and credentials remain owned by the native Service.
// The desktop adapter receives only the same public snapshot used by other backends.
class CustomEndpointService {
  constructor({ productStore, providerService, secretStore, profileServiceController, now = Date.now, randomUUID = crypto.randomUUID }) {
    Object.assign(this, { productStore, providerService, secretStore, profileServiceController, now, randomUUID });
    this.tail = Promise.resolve();
  }

  profiles() { return this.productStore.listAgentProfiles(); }

  target(profileId) {
    const profiles = this.profiles();
    const profile = profileId
      ? profiles.find((item) => item.id === profileId)
      : profiles.find((item) => item.backendId === "shoggoth" && item.isDefault);
    if (!profile || profile.backendId !== "shoggoth" || profile.runtime !== "codex"
      || profile.runtimeAccountId !== SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID || !profile.enabled) {
      throw error("请选择可用的 Shoggoth 助理。");
    }
    return profile;
  }

  provider(id) {
    const provider = this.productStore.getModelProvider(id);
    if (!provider || provider.kind !== "custom-responses") throw error("自定义端点不存在。");
    if (this.profiles().some((profile) => profile.providerRef === id && profile.backendId !== "shoggoth")) {
      throw error("此端点由其他后端管理。");
    }
    return provider;
  }

  list(profileId = null) {
    const target = this.target(profileId);
    const allProfiles = this.profiles();
    const profiles = allProfiles.filter((item) => item.backendId === "shoggoth");
    const endpoints = this.providerService.list().filter((provider) => provider.kind === "custom-responses"
      && !allProfiles.some((profile) => profile.providerRef === provider.id && profile.backendId !== "shoggoth"))
      .map((provider) => ({
        id: provider.id, name: provider.name, baseUrl: normalizedApiRoot(provider.baseUrl),
        model: provider.model, models: modelsOf(provider), api: "openai-responses",
        hasApiKey: provider.credentialRef !== null, discoverModels: false,
        isCurrent: target.providerRef === provider.id,
        profiles: profiles.map((profile) => profile.name),
        activeIn: profiles.filter((profile) => profile.providerRef === provider.id).map((profile) => profile.name),
      }));
    return { supported: true, endpoints, profiles: profiles.map((profile) => profile.name),
      form: { apiOptions: ["openai-responses"], defaultApi: "openai-responses", nameEditable: false, firstModelIsDefault: true } };
  }

  enqueue(action) {
    const pending = this.tail.then(action);
    this.tail = pending.catch(() => {});
    return pending;
  }

  save(profileId, input) {
    return this.enqueue(async () => {
      const profile = this.target(profileId);
      if (!input || typeof input !== "object" || Array.isArray(input)
        || (input.api && input.api !== "openai-responses")) throw error("此端点需要使用 openai-responses 协议。");
      const id = input.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
        throw error("请填写有效的 Provider ID。");
      }
      const existing = this.productStore.getModelProvider(id);
      if (existing) this.provider(id);
      const models = input.models ?? [input.model];
      const draft = buildProviderPreset({
        id, kind: "custom-responses", name: existing?.name ?? input.name,
        baseUrl: input.baseUrl, model: Array.isArray(models) ? models[0] : null, models,
        ...(existing?.headers ? { headers: existing.headers } : {}),
      });
      const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
      if (key && (Buffer.byteLength(key, "utf8") < 4 || key.length > 64 * 1024 || /[\u0000-\u001f\u007f]/u.test(key))) {
        throw error("API Key 格式无效。");
      }
      if (existing?.credentialRef && draft.baseUrl !== existing.baseUrl && !key) {
        throw error("端点 URL 已更改，请重新填写 API Key。");
      }
      const owners = this.profiles().filter((item) => item.providerRef === id);
      if (owners.some((item) => item.id !== profile.id && !models.includes(item.defaultModel))) {
        throw error("请保留其他助理正在使用的默认模型，或先为这些助理切换模型。");
      }
      await this.providerService.save({ id, kind: draft.kind, name: draft.name,
        baseUrl: draft.baseUrl, model: draft.model, models: draft.models, headers: draft.headers });
      if (key) await this.providerService.setSecret({ providerId: id, secret: key });
      await this.providerService.validate({ providerId: id, level: "protocol" });
      await this.profileServiceController.handle("profile.bind", {
        operationId: `endpoint-${this.randomUUID()}`, profileId: profile.id,
        providerRef: id, defaultModel: draft.model, createdAt: this.now(),
      });
      return this.list(profile.id);
    });
  }

  remove(profileId, id) {
    return this.enqueue(async () => {
      const profile = this.target(profileId);
      this.provider(id);
      const owners = this.profiles().filter((item) => item.providerRef === id);
      if (owners.some((item) => !item.enabled)) throw error("请先恢复使用此端点的已归档助理，再切换其模型或删除端点。");
      for (const owner of owners) {
        await this.profileServiceController.handle("profile.clear", {
          operationId: `endpoint-${this.randomUUID()}`, profileId: owner.id,
          providerRef: id, defaultModel: owner.defaultModel, createdAt: this.now(),
        });
      }
      await this.providerService.delete({ providerId: id });
      return this.list(profile.id);
    });
  }

  async discover(profileId, input) {
    this.target(profileId);
    let key = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
    try {
      // Never forward a stored key automatically after the user changes the URL.
      if (!key && input?.id) {
        const provider = this.productStore.getModelProvider(input.id);
        if (provider?.kind === "custom-responses"
          && normalizedApiRoot(input.baseUrl) === provider.baseUrl && provider.credentialRef) {
          this.provider(provider.id);
          key = await this.secretStore.get(provider.credentialRef) || "";
        }
      }
      return await discoverCustomResponseModels({ baseUrl: input?.baseUrl, apiKey: key });
    } finally { key = null; }
  }
}

module.exports = { CustomEndpointService };
