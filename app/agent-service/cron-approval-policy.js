"use strict";

const crypto = require("node:crypto");
const { mcpElicitationUsesApprovalWait } = require("../core/shoggoth-interaction-contract");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }

const CRON_INSTRUCTIONS = "This is an unattended scheduled task. Execute within its granted permissions without asking ordinary clarification questions. A denied action did not execute: try an allowed alternative, and never bypass a denied tool or ownership boundary. If the task cannot be completed, end this run with a clear failure report; do not wait for chat input or return a silence marker. The host may ask the user once for an additional approval and remember that exact operation for this task. A saved approval does not authorize other tasks or changed operations.";
const SCOPE_NOTICE = "本次批准将记住为此定时任务的授权，后续相同操作不再询问。任务内容、操作参数或权限范围改变后需重新确认。";
const PRODUCT_CONFIRMATION_META = "shoggoth/product-confirmation";

// Execution IDs are not an operation's target. Other arguments (including
// expected revisions and plugin digests) remain in the exact approval identity.
function productConfirmationIdentity(name, args) {
  const { runId: ignored, ...operation } = args;
  return `shoggoth-product-confirmation-v1:${digest([name, operation])}`;
}

function readProductConfirmationIdentity(params) {
  const legacy = params?.requestedSchema?.description;
  let identity = legacy;
  if (Object.hasOwn(params || {}, "_meta")) {
    const meta = params._meta;
    if (!meta || Object.getPrototypeOf(meta) !== Object.prototype
      || Object.keys(meta).length !== 1 || !Object.hasOwn(meta, PRODUCT_CONFIRMATION_META)) return null;
    identity = meta[PRODUCT_CONFIRMATION_META];
    if (legacy !== undefined && legacy !== identity) return null;
  }
  return typeof identity === "string" && /^shoggoth-product-confirmation-v1:[a-f0-9]{64}$/u.test(identity)
    ? identity : null;
}

function cronApprovalDescriptor(method, params, contract) {
  if (!contract?.cronAuthorization || params?.redacted || params?.automaticReviewBlocked) return null;
  let operation, response;
  if (method === "shoggoth/pluginTool/requestApproval") {
    const options = params.approvalOptions;
    if (!Array.isArray(options) || options.filter(option => option.kind === "allow_once").length !== 1
      || typeof params.toolName !== "string" || !params.toolInput) return null;
    operation = { method, toolName: params.toolName, toolInput: params.toolInput,
      reason: params.reason, authorizationIdentity: params.authorizationIdentity ?? null };
    response = { decision: "accept", approvalChoice: options.find(option => option.kind === "allow_once").choice };
  } else if (method === "mcpServer/elicitation/request" && mcpElicitationUsesApprovalWait({ ...params, method, kind: "mcp_elicitation" })) {
    const schema = params.requestedSchema, fields = schema?.properties || {};
    const product = fields.confirm_product_action;
    const identity = product ? readProductConfirmationIdentity(params) : null;
    if (product) {
      if (params.serverName !== "shoggoth" || Object.keys(fields).length !== 1
        || !identity
        || JSON.stringify(product.enum) !== JSON.stringify(["确认执行", "取消"])) return null;
      response = { action: "accept", content: { confirm_product_action: "确认执行" } };
    } else {
      // Only no-input confirmations may be remembered. Never save answers to
      // ordinary forms, credentials, login requests or user choices.
      if (Object.keys(fields).length !== 0 || params.mode === "url" || params.url
        // Product tool entry permission must be allowed by the live Product
        // policy first. A denial/revision mismatch cannot become a wider grant.
        || params.serverName === "shoggoth") return null;
      response = { action: "accept", content: {} };
    }
    // Preserve previously saved authorization keys. This legacy shape is only
    // hashed locally; root-level description must never be sent to Codex.
    operation = { method, serverName: params.serverName, message: params.message,
      schema: product ? { ...schema, description: identity } : schema };
  } else return null;
  const authority = [contract.profileId, contract.bindingId ?? null, contract.runtime,
    contract.runtimeProfileId, contract.runtimeAccountId, contract.workspace,
    contract.toolRegistryRevision, contract.toolPermissionRevision, contract.permissionPolicy];
  return { key: digest([authority, operation]), response };
}

function cronApprovalDisplay(method, params) {
  if (method === "shoggoth/pluginTool/requestApproval") return { ...params,
    reason: `${params.reason}\n\n${SCOPE_NOTICE}`,
    approvalOptions: params.approvalOptions.map(option => option.kind === "allow_once"
      ? { ...option, label: "允许并记住此任务" } : option) };
  const schema = structuredClone(params.requestedSchema);
  if (schema.properties?.confirm_product_action) schema.properties.confirm_product_action.description = SCOPE_NOTICE;
  return { ...params, message: `${params.message}\n\n${SCOPE_NOTICE}`, requestedSchema: schema };
}

function cronDenialResponse(method) {
  return method === "mcpServer/elicitation/request" ? { action: "decline" }
    : method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { decision: "decline" };
}

module.exports = { CRON_INSTRUCTIONS, PRODUCT_CONFIRMATION_META, productConfirmationIdentity, readProductConfirmationIdentity,
  cronApprovalDescriptor, cronApprovalDisplay, cronDenialResponse,
  cronAuthorizationDigest: digest };
