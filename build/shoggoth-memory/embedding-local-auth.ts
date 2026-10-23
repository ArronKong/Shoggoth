import { callHost } from "shoggoth-memory-host";

// Product calls carry an explicit Profile resource; OpenClaw's global/default
// agent and external CLI auth stores cannot supply memory credentials.
export const tryResolveAmbientOwnerAgentId = () => undefined;
export const resolveAgentDir = (...args: unknown[]) => callHost("resolveAgentDir", ...args);
export const resolveScopedAuthProfileStore = (...args: unknown[]) =>
  callHost("resolveScopedMemoryAuthProfileStore", ...args);
export const resolveProviderEntryApiKeyAuth = (...args: unknown[]) =>
  callHost("resolveMemoryProviderEntryApiKeyAuth", ...args);
