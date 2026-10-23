// Reuse the pinned alias/index algorithms with one caller-owned configuration.
// Memory cannot discover Gateway plugins, auth profiles or another Runtime.
import { buildModelAliasIndex, resolveModelRefFromString } from "upstream:src/agents/model-selection-shared.ts";
import { parseModelRef } from "upstream:src/agents/model-selection-normalize.ts";
type OpenClawConfig = Parameters<typeof buildModelAliasIndex>[0]["cfg"];

const policy = Object.freeze({ allowManifestNormalization: false,
  allowPluginNormalization: false, manifestPlugins: [] });
export function resolveMemoryModelReference(params: { cfg: OpenClawConfig; agentId: string; raw: string; defaultProvider: string }) {
  const scope = { cfg: params.cfg, agentId: params.agentId, defaultProvider: params.defaultProvider, ...policy };
  return resolveModelRefFromString({ ...scope, raw: params.raw, aliasIndex: buildModelAliasIndex(scope) });
}
export function normalizeMemoryModelReference(raw: string, defaultProvider: string) {
  return parseModelRef(raw, defaultProvider, policy);
}
export { splitTrailingAuthProfile as splitMemoryModelAuthProfile } from "upstream:src/agents/model-ref-profile.ts";
