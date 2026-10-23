"use strict";

// Slack's official MCP scopes (2026-09-28) are a user OAuth boundary, not a
// tool Grant. Every send still requires the pinned component, registered
// principal, live Binding/Grant and Service-owned dispatch ticket.
const { validSlackUserScopes } = require("./plugin-slack-oauth");
const { componentId } = require("./plugin-component-catalog");
const LEGACY_COMPONENT = "shoggoth-slack-public-search";
const FULL_COMPONENT = "shoggoth-slack-official-mcp";
const PUBLIC_SCOPES = Object.freeze(["search:read.public"]);
const READ_SCOPES = Object.freeze([
  "canvases:read", "channels:history", "channels:read", "emoji:read", "files:read",
  "groups:history", "groups:read", "im:history", "im:read", "lists:read",
  "mpim:history", "mpim:read", "reactions:read", "search:read.files",
  "search:read.im", "search:read.mpim", "search:read.private", "search:read.public",
  "search:read.users", "users:read", "users:read.email",
]);
const FULL_SCOPES = Object.freeze([...READ_SCOPES,
  "canvases:write", "channels:write", "chat:write", "files:write", "groups:write",
  "im:write", "lists:write", "mpim:write", "reactions:write",
].sort());
const PROFILES = Object.freeze([
  Object.freeze({ id: "public-search", scopes: PUBLIC_SCOPES }),
  Object.freeze({ id: "workspace-read", scopes: READ_SCOPES }),
  Object.freeze({ id: "workspace-write", scopes: FULL_SCOPES }),
]);
// Exact names in Slack's official skills at commit
// 4399a32bf7b044532420976d030331f3bcb1a2f9. A remote annotation cannot turn an
// unreviewed action into a read. Unrecognized tools remain unavailable.
const KNOWN_READ = Object.freeze({
  slack_search_public: Object.freeze(["search:read.public"]),
  slack_search_public_and_private: Object.freeze([
    "search:read.public", "search:read.private", "search:read.im", "search:read.mpim",
  ]),
  slack_search_channels: Object.freeze(["search:read.public"]),
  slack_search_users: Object.freeze(["search:read.users"]),
  slack_read_channel: Object.freeze(["channels:history", "groups:history", "im:history", "mpim:history"]),
  slack_read_thread: Object.freeze(["channels:history", "groups:history", "im:history", "mpim:history"]),
  slack_read_file: Object.freeze(["files:read"]),
  slack_read_user_profile: Object.freeze(["users:read", "users:read.email"]),
  slack_list_channel_members: Object.freeze(["channels:read", "groups:read", "mpim:read"]),
  slack_get_reactions: Object.freeze(["reactions:read"]),
});
const KNOWN_WRITE = Object.freeze({
  slack_send_message: Object.freeze(["chat:write"]),
  slack_send_message_draft: Object.freeze(["chat:write"]),
  slack_schedule_message: Object.freeze(["chat:write"]),
  slack_add_reaction: Object.freeze(["reactions:write"]),
  slack_create_canvas: Object.freeze(["canvases:read", "canvases:write"]),
  // These exact names are also documented in Slack's official MCP overview.
  slack_get_file_upload_url: Object.freeze(["files:write"]),
  slack_complete_file_upload: Object.freeze(["files:write"]),
});
const REVIEWED_TOOLS = Object.freeze([...Object.keys(KNOWN_READ), ...Object.keys(KNOWN_WRITE)].sort());
const NAME = /^slack_[a-z][a-z0-9_]{0,121}$/u;
const denied = () => Object.freeze({ allowed: false, requiresEachCall: false });
function slackAccessProfile(scopes) {
  if (!validSlackUserScopes(scopes)) return null;
  return PROFILES.find(item => item.scopes.length === scopes.length
    && item.scopes.every(scope => scopes.includes(scope))) || null;
}
function slackToolRequiresEachCall(name) {
  return typeof name === "string" && Object.hasOwn(KNOWN_WRITE, name);
}
function slackToolAccess({ componentName, scopes, toolName }) {
  const profile = slackAccessProfile(scopes);
  if (!profile || typeof toolName !== "string" || !NAME.test(toolName)) return denied();
  if (componentName === LEGACY_COMPONENT) return Object.freeze({
    allowed: toolName === "slack_search_public", requiresEachCall: false,
  });
  if (componentName !== FULL_COMPONENT) return denied();
  if (Object.hasOwn(KNOWN_READ, toolName)) return Object.freeze({
    allowed: KNOWN_READ[toolName].every(scope => profile.scopes.includes(scope)), requiresEachCall: false,
  });
  if (!Object.hasOwn(KNOWN_WRITE, toolName)) return denied();
  return Object.freeze({ allowed: profile.id === "workspace-write"
      && KNOWN_WRITE[toolName].every(scope => profile.scopes.includes(scope)), requiresEachCall: true });
}
function slackBindingComponent(records) {
  const installationId = records?.installation?.installationId;
  if (typeof installationId !== "string" || records?.binding?.installationId !== installationId) return null;
  return [LEGACY_COMPONENT, FULL_COMPONENT].find(name =>
    componentId(installationId, "mcp-server", name) === records.binding.componentId) || null;
}
// Only a Service-owned registration callback may provide these actual scopes.
// Missing, read-only or changed registration cannot inherit a write profile.
function slackDispatchToolAccess(records, toolName, registeredScopes) {
  return slackToolAccess({ componentName: slackBindingComponent(records), scopes: registeredScopes, toolName });
}
module.exports = { LEGACY_COMPONENT, FULL_COMPONENT, PUBLIC_SCOPES, READ_SCOPES,
  FULL_SCOPES, PROFILES, REVIEWED_TOOLS, slackAccessProfile, slackToolRequiresEachCall, slackToolAccess, slackBindingComponent, slackDispatchToolAccess };
