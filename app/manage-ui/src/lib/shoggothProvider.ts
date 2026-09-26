import type { ShoggothProviderConfiguration, ShoggothProviderSnapshot } from "../types";

export function providerOperationId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export function profileProviderId(
  kind: ShoggothProviderConfiguration["provider"]["kind"],
  snapshot: ShoggothProviderSnapshot | null,
): string {
  const profile = snapshot?.profile;
  if (!profile || profile.isDefault) return `provider-${kind}`;
  let hash = 0x811c9dc5;
  for (const point of profile.id) {
    hash ^= point.codePointAt(0) || 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const prefix = `provider-${kind}-`;
  const suffix = `-${hash.toString(16).padStart(8, "0")}`;
  return `${prefix}${profile.id.slice(0, 128 - prefix.length - suffix.length)}${suffix}`;
}
