import catalog from "../../../native-backend-catalog.json";
export const nativeBackendCatalog = catalog;
export function isNativeAgentId(id: string): boolean { return catalog.agentPrefixes.some((prefix) => id.startsWith(prefix)); }
