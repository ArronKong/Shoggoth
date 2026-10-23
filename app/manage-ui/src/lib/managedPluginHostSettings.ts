import type { AppConfig } from "../types";

export interface ManagedPluginHostModes { openclaw: boolean; hermes: boolean; }
export function filterLegacyHostSettings(patch: Partial<AppConfig>, modes: ManagedPluginHostModes): Partial<AppConfig> {
  const result = { ...patch };
  if (modes.openclaw) { delete result.gatewayUrl; delete result.token; }
  if (modes.hermes) { delete result.hermesMode; delete result.hermesRemotes; delete result.hermesKeepAlive; }
  // These fields are set only by the trusted desktop Host factory.
  delete result.openclawPluginHostMode; delete result.hermesPluginHostMode;
  return result;
}
