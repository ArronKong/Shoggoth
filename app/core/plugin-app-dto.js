"use strict";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const id = value => typeof value === "string" && ID.test(value);
const digest = value => typeof value === "string" && HASH.test(value);
const text = (value, max = 256) => typeof value === "string" && value.isWellFormed() && Buffer.byteLength(value) <= max;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new TypeError("invalid plugin App result"); };
function origin(value) {
  if (!text(value, 256)) return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && url.origin === value; } catch { return false; }
}
function validatePluginAppResult(method, value) {
  if (Buffer.byteLength(JSON.stringify(value)) > 48 * 1024) invalid();
  if (method === "plugins.apps.prepare") {
    if (!exact(value, ["challenge", "expiresAt", "summary"]) || !digest(value.challenge) || !integer(value.expiresAt)
      || !exact(value.summary, ["action", "agent", "package", "capability", "toolCount"])
      || value.summary.action !== "app-open" || !integer(value.summary.toolCount) || value.summary.toolCount > 256
      || !["agent", "package", "capability"].every(key => text(value.summary[key]))) invalid();
  } else if (method === "plugins.apps.commit") {
    if (!exact(value, ["canceled", "descriptor"]) || typeof value.canceled !== "boolean") invalid();
    if (value.canceled) { if (value.descriptor !== null) invalid(); return value; }
    const item = value.descriptor;
    if (!exact(item, ["transport", "expiresAt", "hostOrigin", "sandboxOrigin", "resource", "policy", "initialNotifications"])
      || !integer(item.expiresAt) || !origin(item.hostOrigin) || !origin(item.sandboxOrigin)
      || item.hostOrigin === item.sandboxOrigin
      || !exact(item.transport, ["sessionId", "nonce", "sourceId", "origin", "conversationId"])
      || !digest(item.transport.sessionId) || !digest(item.transport.nonce)
      || !id(item.transport.sourceId) || !id(item.transport.conversationId)
      || item.transport.origin !== item.sandboxOrigin
      || !exact(item.resource, ["uri", "mimeType", "resourceDigest", "contentDigest", "encoding", "byteLength", "chunkCount"])
      || !text(item.resource.uri, 2048) || !item.resource.uri.startsWith("ui://")
      || item.resource.mimeType !== "text/html;profile=mcp-app" || item.resource.encoding !== "base64"
      || !digest(item.resource.resourceDigest) || !digest(item.resource.contentDigest)
      || !integer(item.resource.byteLength) || item.resource.byteLength < 1 || item.resource.byteLength > 192 * 1024
      || !integer(item.resource.chunkCount) || item.resource.chunkCount < 1 || item.resource.chunkCount > 16) invalid();
    const notifications = item.initialNotifications;
    if (!Array.isArray(notifications) || notifications.length !== 2
      || Buffer.byteLength(JSON.stringify(notifications)) > 32 * 1024
      || notifications.some((notification, index) => !exact(notification, ["jsonrpc", "method", "params"])
        || notification.jsonrpc !== "2.0"
        || notification.method !== ["ui/notifications/tool-input", "ui/notifications/tool-result"][index]
        || !notification.params || Object.getPrototypeOf(notification.params) !== Object.prototype)
      || !exact(notifications[0].params, ["arguments"])
      || !notifications[0].params.arguments || Object.getPrototypeOf(notifications[0].params.arguments) !== Object.prototype
      || !Array.isArray(notifications[1].params.content)) invalid();
    const policy = item.policy;
    if (!exact(policy, ["csp", "contentSecurityPolicy", "permissions", "permissionsPolicy", "outerSandbox", "innerSandbox",
      "nodeIntegration", "contextIsolation", "sandbox", "navigation", "dedicatedOriginRequested", "prefersBorder"])
      || !text(policy.contentSecurityPolicy, 4096) || !text(policy.permissionsPolicy, 1024)
      || policy.nodeIntegration !== false || policy.contextIsolation !== true || policy.sandbox !== true
      || policy.navigation !== "blocked" || policy.outerSandbox !== "allow-scripts allow-same-origin"
      || policy.innerSandbox !== "allow-scripts" || !exact(policy.permissions, [])
      || typeof policy.dedicatedOriginRequested !== "boolean" || typeof policy.prefersBorder !== "boolean"
      || !exact(policy.csp, ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"])
      || Object.values(policy.csp).some(domains => !Array.isArray(domains) || domains.length !== 0)) invalid();
  } else if (method === "plugins.apps.chunk") {
    if (!exact(value, ["index", "text", "total"]) || !integer(value.index) || !integer(value.total)
      || value.index >= value.total || value.total > 16 || !text(value.text, 24 * 1024)
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.text)) invalid();
  } else if (method === "plugins.apps.message") {
    if (value !== null && (!value || value.jsonrpc !== "2.0" || !(typeof value.id === "string" || integer(value.id))
      || (Object.hasOwn(value, "result") === Object.hasOwn(value, "error"))
      || !exact(value, ["jsonrpc", "id", Object.hasOwn(value, "result") ? "result" : "error"]))) invalid();
  } else if (method === "plugins.apps.close") {
    if (!exact(value, ["closed", "pendingCalls", "teardown"]) || value.closed !== true || !integer(value.pendingCalls)
      || value.pendingCalls > 4 || !exact(value.teardown, ["jsonrpc", "id", "method", "params"])
      || value.teardown.jsonrpc !== "2.0" || !text(value.teardown.id, 128)
      || value.teardown.method !== "ui/resource-teardown" || !exact(value.teardown.params, ["reason"])
      || !text(value.teardown.params.reason, 64)) invalid();
  } else invalid();
  return structuredClone(value);
}
module.exports = { validatePluginAppResult };
