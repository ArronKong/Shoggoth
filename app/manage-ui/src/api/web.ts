import { jsonFetch } from "./client";
// Only configured status is returned; API key plaintext is write-only.
export async function getWebSettings(): Promise<import('../types').WebSettingsSnapshot> {
  return jsonFetch('/__api/web-settings');
}
export async function setWebSettings(input: { expectedRevision: number; config: import('../types').WebProviderConfig }): Promise<import('../types').WebSettingsSnapshot> {
  return jsonFetch('/__api/web-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}
export async function setWebProviderKey(input: { provider: import('../types').WebProvider; expectedRevision: number | null; apiKey: string }): Promise<import('../types').WebSettingsSnapshot> {
  return jsonFetch('/__api/web-settings/credentials', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}
export async function clearWebProviderKey(input: { provider: import('../types').WebProvider; expectedRevision: number | null }): Promise<import('../types').WebSettingsSnapshot> {
  return jsonFetch('/__api/web-settings/credentials', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}
