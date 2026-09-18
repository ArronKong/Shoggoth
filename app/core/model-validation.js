"use strict";

// 模型配置参数错误使用专用类型与稳定 code，供 REST 边界精确映射为 400。
class ModelValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "ModelValidationError";
    this.code = "ERR_INVALID_MODEL_URL";
  }
}

// 严格归一化可选字符串：缺省/空白视为未提供，禁止数组或对象被隐式强转。
function normalizeOptionalString(value, fieldName = "value") {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw new ModelValidationError(`${fieldName} 必须是字符串`);
  }
  return value.trim();
}

// 严格判断模型后端地址：依赖标准 URL 解析器，只接受带主机名的 HTTP(S) URL。
function isHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname;
  } catch {
    return false;
  }
}

// 在配置进入读写层前拒绝非法地址；错误只描述字段约束，避免泄露 URL 中的凭证。
function assertHttpUrl(value, fieldName = "URL") {
  if (!isHttpUrl(value)) {
    throw new ModelValidationError(`${fieldName} 必须是包含主机名的 HTTP(S) URL`);
  }
  return value;
}

module.exports = { ModelValidationError, normalizeOptionalString, isHttpUrl, assertHttpUrl };
