"use strict";

const { createHash } = require("node:crypto");

// revision 只描述模型目录可公开、可比较的字段；Provider 凭证和端点永不进入摘要。
const CATALOG_FIELDS = [
  "id",
  "name",
  "provider",
  "backendId",
  "profile",
  "contextWindow",
  "maxTokens",
  "reasoning",
  "thinkingOptions",
  "thinkingDefault",
  "fast",
  "pricing",
  "acpProviderRef",
  "modelScopes",
  "defaultModelScopes",
  "providerConfigDigest",
];
const FORBIDDEN_KEY = /(?:secret|api[_-]?key|token|authorization|base[_-]?url|endpoint|credential|password|url)/i;
const URL_VALUE = /[a-z][a-z\d+.-]*:\/\//i;

/**
 * 递归生成稳定且安全的公开值：对象键排序，同时剔除凭证、端点和 URL。
 * @param {*} value
 * @returns {*}
 */
function normalizePublicValue(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value === "string") return URL_VALUE.test(value.trim()) ? undefined : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizePublicValue(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN_KEY.test(key)) continue;
    const child = normalizePublicValue(value[key]);
    if (child !== undefined) normalized[key] = child;
  }
  return normalized;
}

/**
 * 将任意目录输入收敛为稳定白名单行；非数组按空目录处理。
 * @param {*} rows
 * @returns {Array<object>}
 */
function normalizeCatalogRows(rows) {
  if (!Array.isArray(rows)) return [];
  const normalized = rows.map((row) => {
    const source = row && typeof row === "object" && !Array.isArray(row) ? row : {};
    const output = {};
    for (const field of CATALOG_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
      const value = normalizePublicValue(source[field]);
      if (value !== undefined) output[field] = value;
    }
    return output;
  });

  // 主排序固定目录身份；内容排序消除同身份多行的输入顺序差异。
  return normalized.sort((left, right) => {
    for (const field of ["backendId", "profile", "provider", "id"]) {
      const leftValue = String(left[field] || "");
      const rightValue = String(right[field] || "");
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
    }
    const leftContent = JSON.stringify(left);
    const rightContent = JSON.stringify(right);
    if (leftContent < rightContent) return -1;
    if (leftContent > rightContent) return 1;
    return 0;
  });
}

/**
 * 根据配置真值与运行时目录生成内容寻址的 SHA-256 revision。
 * @param {{backendId?: string, config?: Array<object>, runtime?: Array<object>}} input
 * @returns {string}
 */
function computeCatalogRevision({ backendId, config, runtime } = {}) {
  const canonical = {
    backendId: String(backendId || "all"),
    config: normalizeCatalogRows(config),
    runtime: normalizeCatalogRows(runtime),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

module.exports = {
  computeCatalogRevision,
  normalizeCatalogRows,
};
