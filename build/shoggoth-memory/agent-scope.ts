// Profiles and private memory workspaces are supplied by the owning Service.
import { callHost } from "shoggoth-memory-host";
export const listAgentIds = (...args: unknown[]) => callHost("listAgentIds", ...args);
export const resolveAgentWorkspaceDir = (...args: unknown[]) => callHost("resolveAgentWorkspaceDir", ...args);
export const resolveDefaultAgentId = (...args: unknown[]) => callHost("resolveDefaultAgentId", ...args);
export const resolveAgentConfig = (...args: unknown[]) => callHost("resolveAgentConfig", ...args);
