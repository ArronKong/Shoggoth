// Per-model "xhigh" thinking support for OpenClaw models.
//
// xhigh is a per-(provider,model) decision made inside the OpenClaw gateway's
// provider plugins (supportsXHighThinking). There is NO read-only RPC that exposes
// it, and hardcoding model-id rules would go stale as new models ship (gpt-5.5,
// gpt-5.6, …). So we learn it at runtime by probing the gateway and cache the
// result per `provider:model`. This keeps the app correct against whatever OpenClaw
// is installed locally, with no changes to OpenClaw itself.
//
// Probe = sessions.patch{thinkingLevel:"xhigh"}. The gateway validates xhigh per
// model and either accepts it (supported) or rejects with an "xhigh … only
// supported …" error (unsupported). Rejection returns before the store write, so it
// is non-mutating; acceptance persists xhigh, which we immediately restore.

const CACHE_KEY = "shoggoth.thinking.xhigh.v1";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-probe weekly so OpenClaw upgrades take effect

type Entry = { xhigh: boolean; ts: number };
type Cache = Record<string, Entry>;

function loadCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Cache) : {};
  } catch {
    return {};
  }
}

function saveCache(cache: Cache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* localStorage unavailable / over quota — degrade to no cache */
  }
}

/** Cached xhigh support for `provider:model`, or undefined if unknown/stale. */
export function readXHighCache(key: string): boolean | undefined {
  const entry = loadCache()[key];
  if (!entry) return undefined;
  if (Date.now() - entry.ts > TTL_MS) return undefined;
  return entry.xhigh;
}

export function writeXHighCache(key: string, xhigh: boolean): void {
  const cache = loadCache();
  cache[key] = { xhigh, ts: Date.now() };
  saveCache(cache);
}

type Send = (method: string, params: unknown) => Promise<unknown>;

/**
 * Probe whether the active session's model supports xhigh, via sessions.patch.
 * Returns true/false. Throws on transient errors (network / unrelated gateway
 * errors) so the caller can skip caching and retry later.
 *
 * On "supported" the session is left at `xhigh` momentarily, then `priorLevel` is
 * restored (null clears the override → model default).
 */
export async function probeXHigh(
  send: Send,
  sessionKey: string,
  priorLevel: string | null,
): Promise<boolean> {
  try {
    await send("sessions.patch", { key: sessionKey, thinkingLevel: "xhigh" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/xhigh/i.test(msg)) return false; // gateway rejected xhigh for this model
    throw err; // transient / unrelated — let the caller skip caching
  }
  // Accepted → supported. Restore the prior level (best-effort, silent).
  await send("sessions.patch", { key: sessionKey, thinkingLevel: priorLevel }).catch(() => {});
  return true;
}
