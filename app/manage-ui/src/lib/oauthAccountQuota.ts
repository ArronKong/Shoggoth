import { getOAuthProviderQuota, listOAuthProviders } from "../api/client";
import type { OAuthAccountQuota, OAuthProvider } from "../types";
import { readEnabledOAuthQuotaBackends } from "./backends";
import { readPageCacheRevision, subscribePageCacheRevision } from "./usePageCache";

type Entry = {
  backend: string;
  id: string;
  scope: string;
  quota?: OAuthAccountQuota;
  requested?: boolean;
  request?: { controller: AbortController; promise: Promise<boolean> };
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const accountKey = (backend: string, id: string) => JSON.stringify([backend, id]);
const accountScope = ({ status, quotaScope, quotaSource }: OAuthProvider) =>
  quotaScope ?? JSON.stringify([status.source, status.tokenPreview, quotaSource]);

export function canShowOAuthAccountQuota(provider: OAuthProvider): boolean {
  const { status } = provider;
  return provider.connection?.enabled !== false
    && status.loggedIn && !status.error && !status.verification
    && (!status.expiresAt || Date.parse(status.expiresAt) > Date.now());
}

export function canReadOAuthAccountQuota(provider: OAuthProvider): boolean {
  return provider.canReadQuota === true && provider.quotaScope !== null && canShowOAuthAccountQuota(provider);
}

export function subscribeOAuthQuota(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish() {
  for (const listener of listeners) listener();
}

function removeEntry(key: string, entry: Entry) {
  entries.delete(key);
  entry.request?.controller.abort();
}

subscribePageCacheRevision(() => {
  for (const [key, entry] of entries) removeEntry(key, entry);
  publish();
});

export function forgetOAuthQuota(backend: string, id: string): void {
  const key = accountKey(backend, id);
  const entry = entries.get(key);
  if (!entry) return;
  removeEntry(key, entry);
  publish();
}

export function readCachedOAuthQuota(backend: string, provider: OAuthProvider): OAuthAccountQuota | undefined {
  const entry = entries.get(accountKey(backend, provider.id));
  return entry?.scope === accountScope(provider) ? entry.quota : undefined;
}

export function refreshOAuthQuota(backend: string, provider: OAuthProvider): Promise<boolean> {
  const { id } = provider;
  const key = accountKey(backend, id);
  const scope = accountScope(provider);
  const before = entries.get(key);
  if (before?.scope === scope && before.request) return before.request.promise;
  if (before && before.scope !== scope) removeEntry(key, before);
  const entry: Entry = before?.scope === scope ? before : { backend, id, scope };
  // The CLI response has no account identifier. Read a fresh snapshot on each open.
  const retrying = entry.quota && (entry.quota.status !== "available" || provider.quotaSource === "antigravity-cli");
  if (retrying) delete entry.quota;
  entry.requested = true;
  entries.set(key, entry);
  if (retrying || (before?.quota && entry !== before)) publish();

  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
  const promise = getOAuthProviderQuota(backend, id, signal).catch(() => ({ status: "unavailable" } as const)).then(result => {
    if (entries.get(key) !== entry) return false;
    if (result.status !== "available" && entry.quota?.status === "available") return result.status === "unsupported";
    if (result.status === "available" && provider.quotaScope && result.quotaScope !== provider.quotaScope) {
      delete entry.quota;
      publish();
      return true;
    }
    entry.quota = result;
    publish();
    return false;
  }).finally(() => { delete entry.request; });
  entry.request = { controller, promise };
  return promise;
}

export async function prefetchMissingOAuthQuotas(backend: string, providers: OAuthProvider[]): Promise<void> {
  const eligible = new Map(providers.filter(canReadOAuthAccountQuota).map(provider => [provider.id, provider]));
  let changed = false;
  for (const [key, entry] of entries) {
    if (entry.backend !== backend) continue;
    const provider = eligible.get(entry.id);
    if (provider && entry.scope === accountScope(provider)) continue;
    // Native auth probes can briefly lose verification while warming a runtime.
    const current = providers.find(item => item.id === entry.id);
    if (current?.status.verification === "unverified" && current.connection?.enabled !== false) continue;
    removeEntry(key, entry);
    changed = true;
  }
  for (const provider of eligible.values()) {
    const { id, quotaScope, cachedQuota } = provider;
    if (!quotaScope || cachedQuota?.quotaScope !== quotaScope) continue;
    const key = accountKey(backend, id);
    const entry = entries.get(key);
    if (!entry) {
      entries.set(key, { backend, id, scope: quotaScope, quota: cachedQuota });
      changed = true;
    } else if (entry.quota?.status !== "available") {
      entry.quota = cachedQuota;
      changed = true;
    }
  }
  if (changed) publish();

  const revision = readPageCacheRevision();
  const accounts = [...eligible.values()].filter(provider => provider.quotaSource !== "antigravity-cli")
    .sort((a, b) => Number(!!a.connection) - Number(!!b.connection));
  // Wait for existing reads too, so a second scan does not skip ahead of the first.
  for (let i = 0; i < accounts.length && revision === readPageCacheRevision(); i += 2) {
    await Promise.all(accounts.slice(i, i + 2).map(provider => {
      const entry = entries.get(accountKey(backend, provider.id));
      return entry?.requested ? entry.request?.promise : refreshOAuthQuota(backend, provider);
    }));
  }
}

export async function warmOAuthAccountQuotas(): Promise<void> {
  const backends = await readEnabledOAuthQuotaBackends();
  const revision = readPageCacheRevision();
  await Promise.allSettled(backends.map(async backend => {
    const { providers } = await listOAuthProviders(backend, { quotaOnly: true });
    if (revision === readPageCacheRevision()) await prefetchMissingOAuthQuotas(backend, providers);
  }));
}
