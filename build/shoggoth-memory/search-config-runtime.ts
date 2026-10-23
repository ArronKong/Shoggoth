// Resolve ownership through the Service; importing search policy must not load
// another app's plugin discovery, credential registry or database directories.
import { callHost } from "shoggoth-memory-host";
export const assertSecretOwnerAvailable = (...args: unknown[]) => callHost("assertSecretOwnerAvailable", ...args);
export const resolveOpenClawAgentSqlitePath = (...args: unknown[]) => callHost("resolveOpenClawAgentSqlitePath", ...args);
export const getMemoryEmbeddingProvider = (...args: unknown[]) => callHost("getMemoryEmbeddingProvider", ...args);
