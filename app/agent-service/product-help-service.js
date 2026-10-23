"use strict";

const { PRODUCT_HELP_CATALOG, productHelpRevision } = require("./product-help-catalog");
const { serviceError } = require("./security");

const REASONS = {
  UI_REQUIRED: ["请在应用界面操作。", "Use the App UI."],
  NATIVE_ONLY: ["此操作仅向原生 Agent 开放。", "This operation is available only to native Agents."],
  NATIVE_TARGET_REQUIRED: ["此操作只支持原生目标。", "This operation supports native targets only."],
  TOOL_FORBIDDEN: ["当前 Agent 的该工具权限已禁用。", "This tool is denied for the current Agent."],
  TOOL_UNAVAILABLE: ["对应工具或服务目前不可用。", "The required tool or service is unavailable."],
  PERMISSION_UNKNOWN: ["无法确认当前工具权限。", "Current tool permissions could not be verified."],
  BACKEND_DISCONNECTED: ["目标后端未连接或已禁用。", "The target backend is disconnected or disabled."],
  BACKEND_STATE_UNKNOWN: ["无法确认目标后端连接状态。", "The target backend connection state is unknown."],
  USER_CONVERSATION_REQUIRED: ["需要当前用户对话及可验证的用户消息。", "A current user conversation with a verified user message is required."],
  CURRENT_RUN_UNKNOWN: ["无法确认当前执行上下文。", "The current execution context could not be verified."],
  CONFIRMATION_REQUIRED: ["执行时需要产品确认。", "Product confirmation is required when executing."],
  RUNTIME_UNSUPPORTED: ["当前 Runtime 不支持此操作。", "The current Runtime does not support this operation."],
  SERVICE_STATE_UNKNOWN: ["无法确认产品服务状态。", "Product service state could not be verified."],
};
function reason(code, locale) { return { code, message: REASONS[code][locale === "en" ? 1 : 0] }; }

class ProductHelpService {
  constructor(options) { Object.assign(this, options); this.now = options.now || Date.now; }

  async #context(authority, scope, needsBackend) {
    const read = async fn => { try { return await fn(); } catch { return null; } };
    const [backendRows, services] = await Promise.all([
      needsBackend ? read(() => this.getBackendStatuses()) : null,
      this.getServiceStatus ? read(() => this.getServiceStatus()) : null,
    ]);
    let backends = null;
    if (needsBackend) {
      const value = backendRows;
      if (Array.isArray(value) && value.length <= 128
        && new Set(value.map(row => row?.id)).size === value.length
        && value.every(row => typeof row?.id === "string" && typeof row.connected === "boolean"
          && typeof row.disabled === "boolean")) backends = value;
    }
    let runtime = null;
    if (!authority.federationClient) {
      try { runtime = this.getRuntimeContext?.(authority.profileId, scope) || null; } catch {}
    }
    const projection = this.permissionEngine.profileProjection?.(authority.profileId);
    return { backends, runtime, services, permissions: projection?.tools || null,
      permissionRevision: projection?.revision ?? null };
  }

  #toolState(toolName, authority, context, locale) {
    const tool = this.toolRegistry.get(toolName);
    if (authority.federationClient && this.isNativeOnlyTool(toolName)) {
      return { availability: "unavailable", reason: reason("NATIVE_ONLY", locale) };
    }
    if (!tool || !tool.enabled || tool.modelVisible === false || !this.toolAvailable(toolName)) {
      return { availability: "unavailable", reason: reason("TOOL_UNAVAILABLE", locale) };
    }
    const permission = context.permissions?.find(item => item.name === toolName);
    if (!permission) return { availability: "unknown", reason: reason("PERMISSION_UNKNOWN", locale) };
    if (permission.effect === "deny" || !permission.enabled) {
      return { availability: "unavailable", reason: reason("TOOL_FORBIDDEN", locale) };
    }
    if (this.getServiceStatus && ["cron", "kanban"].includes(tool.domain)) {
      const available = context.services?.domainAvailability?.[tool.domain]?.available;
      if (available === false) return { availability: "unavailable", reason: reason("TOOL_UNAVAILABLE", locale) };
      if (available !== true) return { availability: "unknown", reason: reason("SERVICE_STATE_UNKNOWN", locale) };
    }
    const confirm = ["confirm", "destructive"].includes(tool.risk);
    return { availability: confirm ? "requires_confirmation" : "available",
      reason: confirm ? reason("CONFIRMATION_REQUIRED", locale) : null };
  }

  #action(item, backendId, authority, context, locale) {
    const external = backendId !== "shoggoth";
    const toolName = external && item.externalTool ? item.externalTool : item.tool;
    const tool = toolName ? this.toolRegistry.get(toolName) : null;
    const result = { id: item.id, label: item.labels[locale], tool: toolName,
      operation: external && item.externalTool === "app_manage" ? item.operation : null,
      risk: tool?.risk ?? null, requiresConfirmation: tool ? ["confirm", "destructive"].includes(tool.risk) : false };
    const state = (availability, code) => ({ ...result, availability, reason: code ? reason(code, locale) : null });
    if (item.runtimeCapability) {
      const supported = external ? undefined : context.runtime?.capabilities?.[item.runtimeCapability];
      if (supported === undefined) return state("unknown", "CURRENT_RUN_UNKNOWN");
      if (supported !== true) return state("unavailable", "RUNTIME_UNSUPPORTED");
    }
    if (!toolName) return state("ui_only", "UI_REQUIRED");
    const permission = this.#toolState(toolName, authority, context, locale);
    if (["unavailable", "unknown"].includes(permission.availability)) return { ...result, ...permission };
    if (external && item.nativeTarget) return state("unavailable", "NATIVE_TARGET_REQUIRED");
    if (external && item.externalTool === "app_manage") {
      const operationPermission = this.#toolState(item.operation, authority, context, locale);
      if (["unavailable", "unknown"].includes(operationPermission.availability)) return { ...result, ...operationPermission };
    }
    if (item.userConversation || item.currentRun) {
      if (!context.runtime) return state("unknown", "CURRENT_RUN_UNKNOWN");
      if (item.userConversation && context.runtime.userConversation !== true) {
        return state("unavailable", "USER_CONVERSATION_REQUIRED");
      }
    }
    if ((external && item.externalTool) || item.connectedTarget) {
      const backend = context.backends?.find(row => row.id === backendId);
      if (!backend) return state("unknown", "BACKEND_STATE_UNKNOWN");
      if (!backend.connected || backend.disabled) return state("unavailable", "BACKEND_DISCONNECTED");
    }
    return { ...result, ...permission };
  }

  async get({ featureId, backendId = "shoggoth", locale = "zh-CN" }, authority, scope) {
    const feature = PRODUCT_HELP_CATALOG.find(item => item.id === featureId);
    if (!feature) throw serviceError("MCP_TOOL_NOT_FOUND", "未找到该功能说明");
    const needsBackend = backendId !== "shoggoth"
      || feature.actions.some(item => item.connectedTarget || item.tool === "backend_status");
    const context = await this.#context(authority, scope, needsBackend);
    const content = feature.content[locale];
    return { featureId, locale, ...structuredClone(content), uiTarget: { ...feature.uiTarget },
      backendId, catalogRevision: productHelpRevision, toolRegistryRevision: this.toolRegistry.revision,
      permissionRevision: context.permissionRevision, sampledAt: this.now(),
      runtime: context.runtime?.runtime ?? null, runtimeCapabilities: { ...(context.runtime?.capabilities || {}) },
      availabilityNotice: locale === "en"
        ? "Availability describes current tool access. Resolve the exact target and read its state before execution; permissions, revisions, workspace and confirmation are checked again. Asking about a feature does not request execution."
        : "可用状态表示当前工具访问条件。执行前仍需定位具体目标并读取其状态，目标归属、版本、工作区、权限与确认会再次检查。询问功能本身不代表请求执行。",
      actions: feature.actions.map(item => this.#action(item, backendId, authority, context, locale)) };
  }

  async currentCapabilities(authority, scope) {
    const context = await this.#context(authority, scope, false);
    return { permissionRevision: context.permissionRevision, runtime: context.runtime?.runtime ?? null,
      sampledAt: this.now(), scope: "product-tool-access",
      availabilityNotice: "工具访问状态不证明具体目标可执行。请用 app_help_get 读取功能和后端状态，执行时仍校验目标归属、当前用户来源、版本与确认。",
      tools: this.toolRegistry.publicProjection().capabilities
        .filter(item => !authority.federationClient || !this.isNativeOnlyTool(item.tool))
        .map(item => ({ tool: item.tool, ...this.#toolState(item.tool, authority, context, "zh-CN") })) };
  }
}

module.exports = { ProductHelpService };
