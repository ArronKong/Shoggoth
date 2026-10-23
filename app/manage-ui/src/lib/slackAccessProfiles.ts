import type { PluginSlackAccessProfile } from "../api/client";
const readScopes = [
  "canvases:read", "channels:history", "channels:read", "emoji:read", "files:read",
  "groups:history", "groups:read", "im:history", "im:read", "lists:read",
  "mpim:history", "mpim:read", "reactions:read", "search:read.files",
  "search:read.im", "search:read.mpim", "search:read.private", "search:read.public",
  "search:read.users", "users:read", "users:read.email",
];
export const SLACK_ACCESS_PROFILES: ReadonlyArray<{ id: PluginSlackAccessProfile; scopes: readonly string[] }> = [
  { id: "public-search", scopes: ["search:read.public"] },
  { id: "workspace-read", scopes: readScopes },
  { id: "workspace-write", scopes: [...readScopes, "canvases:write", "channels:write", "chat:write",
    "files:write", "groups:write", "im:write", "lists:write", "mpim:write", "reactions:write"].sort() },
];
export function slackProfileTranslation(id: PluginSlackAccessProfile) {
  return id === "public-search" ? "plugins.slackAccessPublic"
    : id === "workspace-read" ? "plugins.slackAccessRead" : "plugins.slackAccessWrite";
}
