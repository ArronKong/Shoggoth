"use strict";

const { createHash } = require("node:crypto");
const { assertHttpUrl, normalizeOptionalString } = require("./model-validation");

const PROVIDER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 模型变更请求的字段级错误；稳定 code 供 API 层映射，消息绝不包含用户输入的 secret。
 */
class ModelChangeError extends Error {
  constructor(code, message, { field, stage = "validate", status = 400, details } = {}) {
    super(message);
    this.name = "ModelChangeError";
    this.code = code;
    this.field = field;
    this.stage = stage;
    this.status = status;
    this.details = details;
  }
}

/** 将 provider 与模型 ID 编码为不会碰撞的复合身份键。 */
function modelIdentityKey(provider, modelId) {
  return JSON.stringify([String(provider || ""), String(modelId || "")]);
}

/**
 * 调用既有字符串归一化工具，并将其字段输入错误统一转换为模型变更错误。
 */
function optionalString(value, field) {
  try {
    return normalizeOptionalString(value, field);
  } catch {
    throw new ModelChangeError("invalid_string", `${field} 必须是字符串`, { field });
  }
}

/** 校验必填字符串，空白字符串与缺失均返回稳定的 required 错误。 */
function requiredString(value, field) {
  const normalized = optionalString(value, field);
  if (!normalized) {
    throw new ModelChangeError("required", `${field} 不能为空`, { field });
  }
  return normalized;
}

/**
 * 校验根请求必须为普通对象，避免 null、数组与原始值触发原生 TypeError。
 */
function assertPlainInputObject(input) {
  const prototype = input && typeof input === "object" ? Object.getPrototypeOf(input) : null;
  if (!input || typeof input !== "object" || Array.isArray(input) || (prototype !== Object.prototype && prototype !== null)) {
    throw new ModelChangeError("invalid_input", "请求必须是普通对象", { field: "input" });
  }
  return input;
}

/**
 * 校验可选的正安全整数模型参数：只接受 number 或严格十进制字符串，拒绝隐式类型转换。
 */
function positiveInteger(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ModelChangeError("positive_integer", `${field} 必须是正整数`, { field });
  }
  return number;
}

/**
 * 将创建、更新、重命名请求转为可持久化 safeSpec，并将 apiKey 独立放入短生命周期信封。
 */
function normalizeModelChangeRequest(input = {}) {
  input = assertPlainInputObject(input);
  const providerKey = requiredString(input.providerKey, "providerKey");
  if (!PROVIDER_KEY_RE.test(providerKey)) {
    throw new ModelChangeError("invalid_provider", "providerKey 格式不合法", { field: "providerKey" });
  }

  const targetModelId = requiredString(input.model?.id, "model.id");
  const sourceModelId = optionalString(input.sourceModelId, "sourceModelId");
  const providerMode = input.providerMode === "new" ? "new" : "existing";
  const kind = !sourceModelId ? "create" : sourceModelId === targetModelId ? "update" : "rename";
  if (kind !== "create" && providerMode === "new") {
    throw new ModelChangeError("provider_locked", "编辑模型时不能更换 Provider", { field: "providerKey" });
  }

  const baseUrl = optionalString(input.baseUrl, "baseUrl");
  if (baseUrl) {
    try {
      assertHttpUrl(baseUrl, "baseUrl");
    } catch {
      throw new ModelChangeError("invalid_url", "baseUrl 必须是包含主机名的 HTTP(S) URL", { field: "baseUrl" });
    }
  }

  const name = optionalString(input.model?.name, "model.name");
  const contextWindow = positiveInteger(input.model?.contextWindow, "model.contextWindow");
  const maxTokens = positiveInteger(input.model?.maxTokens, "model.maxTokens");
  const model = Object.freeze({
    id: targetModelId,
    ...(name ? { name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(typeof input.model?.reasoning === "boolean" ? { reasoning: input.model.reasoning } : {}),
  });
  const safeSpec = Object.freeze({
    kind,
    providerMode,
    providerKey,
    sourceModelId: sourceModelId || null,
    sourceKey: sourceModelId ? modelIdentityKey(providerKey, sourceModelId) : null,
    targetKey: modelIdentityKey(providerKey, targetModelId),
    baseUrl,
    api: optionalString(input.api, "api"),
    model,
  });
  const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
  return Object.freeze({ safeSpec, secretEnvelope: apiKey ? Object.freeze({ apiKey }) : null });
}

/** 将删除模型或删除 Provider 的输入转换为明确且不可变的删除契约。 */
function normalizeModelDeleteSpec(input = {}) {
  input = assertPlainInputObject(input);
  const providerKey = requiredString(input.providerKey, "providerKey");
  if (!PROVIDER_KEY_RE.test(providerKey)) {
    throw new ModelChangeError("invalid_provider", "providerKey 格式不合法", { field: "providerKey" });
  }
  const sourceModelId = optionalString(input.modelId, "modelId");
  return Object.freeze({
    kind: sourceModelId ? "delete-model" : "delete-provider",
    providerKey,
    sourceModelId: sourceModelId || null,
    sourceKey: sourceModelId ? modelIdentityKey(providerKey, sourceModelId) : modelIdentityKey(providerKey, "*"),
    target: null,
  });
}

/** 递归排序对象键，生成与对象插入顺序无关的确定性 JSON 文本。 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 计算 safeSpec 的稳定 SHA-256 摘要，并防止凭证进入可记录对象。 */
function modelChangeRequestDigest(spec) {
  if (spec && Object.prototype.hasOwnProperty.call(spec, "apiKey")) {
    throw new ModelChangeError("secret_in_safe_spec", "safeSpec 不得包含凭证", { status: 500 });
  }
  return createHash("sha256").update(stableJson(spec)).digest("hex");
}

module.exports = {
  ModelChangeError,
  modelIdentityKey,
  normalizeModelChangeRequest,
  normalizeModelDeleteSpec,
  modelChangeRequestDigest,
};
