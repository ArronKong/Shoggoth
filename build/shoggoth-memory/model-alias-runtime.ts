// Host projection: Product Profile IDs are the keys in agents.entries. Only
// model-selection-shared imports this boundary; no filesystem roster is read.
export const resolveAgentConfig = (cfg: { agents?: { entries?: Record<string, unknown> } }, id: string) => cfg.agents?.entries?.[id];

// These unrelated model-policy and global-registry paths are not exported by
// the memory entry point. Fail closed if future source starts reaching them.
const unavailable = (): never => { throw new Error("Global model selection is unavailable to memory"); };
export const resolveAgentModelConfigForRuntime = unavailable;
export const computeModelPolicyAllowlist = unavailable;
export const hasExplicitModelPolicyAllow = unavailable;
export const hasUtilityModelSeparationMigrationMarker = unavailable;
export const getCurrentPluginMetadataSnapshot = unavailable;
export const loadManifestMetadataSnapshot = unavailable;
export const getActivePluginRegistryWorkspaceDirFromState = unavailable;
export const createModelCatalogIdentityKeyResolver = unavailable;
export const readUtilityModelSetting = unavailable;
export const sanitizeForLog = unavailable;
export const stripAnsi = unavailable;
export const overlayCatalogMetadata = unavailable;
export const findModelCatalogEntry = unavailable;
