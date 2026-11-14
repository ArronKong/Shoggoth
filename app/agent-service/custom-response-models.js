"use strict";

const { normalizedApiRoot } = require("./codex-provider-service");
const { declaredReasoningOptions } = require("./model-reasoning-catalog");

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_MODELS = 500;

function failure(code, reachable = false) {
  return { ok: false, reachable, code, message: "Model catalog could not be read.", models: [] };
}

// Discovery only reads the supplied service's catalog. It never saves a key,
// binds a Profile, or sends a model inference request.
async function discoverCustomResponseModels(endpoint = {}, request = globalThis.fetch) {
  const { reasoningOptions: _reasoningOptions, ...discovery } = await readCustomResponseModelCatalog(endpoint, request);
  return discovery;
}

async function readCustomResponseModelCatalog(endpoint = {}, request = globalThis.fetch) {
  let baseUrl;
  try { baseUrl = normalizedApiRoot(endpoint.baseUrl?.trim()); }
  catch { return failure("invalid_url"); }
  const key = typeof endpoint.apiKey === "string" ? endpoint.apiKey.trim() : "";
  if (key.length > 64 * 1024 || /[\u0000-\u001f\u007f]/u.test(key)) {
    return failure("authentication_failed");
  }
  let response;
  try {
    response = await request(`${baseUrl}/models`, {
      method: "GET",
      headers: { accept: "application/json", ...endpoint.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(endpoint.timeoutMs ?? 12_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return failure([401, 403].includes(response.status) ? "authentication_failed" : "catalog_unavailable", true);
    }
    if (Number(response.headers.get("content-length")) > MAX_CATALOG_BYTES) {
      await response.body?.cancel().catch(() => {});
      return failure("catalog_too_large", true);
    }
    const reader = response.body?.getReader();
    if (!reader) return failure("invalid_catalog", true);
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => {});
        return failure("catalog_too_large", true);
      }
      chunks.push(Buffer.from(value));
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return failure("invalid_catalog", true); }
    const rows = Array.isArray(body) ? body
      : Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.models) ? body.models : null;
    if (!rows) return failure("invalid_catalog", true);
    const models = new Set();
    const reasoningOptions = new Map();
    for (const row of rows) {
      const raw = typeof row === "string" ? row : row?.id ?? row?.name;
      if (typeof raw !== "string") continue;
      const model = raw.trim();
      if (model && Buffer.byteLength(model, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/u.test(model) && (!key || !model.includes(key))) {
        const options = declaredReasoningOptions(row)?.filter(effort => !key || !effort.includes(key)) ?? null;
        if (models.has(model) && JSON.stringify(reasoningOptions.get(model)) !== JSON.stringify(options)) {
          reasoningOptions.set(model, []);
        } else if (!models.has(model)) {
          reasoningOptions.set(model, options);
        }
        models.add(model);
      }
      if (models.size >= MAX_MODELS) break;
    }
    return { ok: true, reachable: true, message: "", models: [...models], reasoningOptions };
  } catch (error) {
    // Remote error bodies and exceptions may echo the credential; only return
    // stable codes that the UI translates locally.
    return failure(error?.name === "TimeoutError" ? "timeout" : "catalog_unavailable", Boolean(response));
  }
}

// Catalog metadata is optional and short-lived. Key it by the complete saved
// route so edited endpoints and rotated credentials cannot reuse another route's data.
function createCustomResponseReasoningReader({ readCredential, now = Date.now, request } = {}) {
  const cache = new Map();
  let activeReads = 0;
  return async provider => {
    if (!["custom-responses", "openrouter"].includes(provider.kind)) return null;
    const identity = JSON.stringify(provider);
    const previous = cache.get(provider.id);
    if (previous?.identity === identity && previous.expires > now()) return previous.result;
    if (activeReads >= 16) return null;
    const entry = { identity, expires: Infinity };
    const sameProvider = () => cache.get(provider.id) === entry;
    activeReads += 1;
    entry.result = Promise.resolve().then(async () => {
      try {
        const key = provider.credentialRef ? await readCredential(provider.credentialRef) : "";
        if (!sameProvider() || provider.credentialRef && !key) return null;
        const catalog = await readCustomResponseModelCatalog({ baseUrl: provider.baseUrl, apiKey: key,
          headers: provider.headers, timeoutMs: 900 }, request);
        return sameProvider() && catalog.ok ? catalog.reasoningOptions : null;
      } catch { return null; }
    }).then(result => {
      entry.expires = now() + (result ? 5 * 60_000 : 30_000);
      return result;
    }).finally(() => { activeReads -= 1; });
    cache.delete(provider.id);
    cache.set(provider.id, entry);
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    return entry.result;
  };
}

module.exports = { createCustomResponseReasoningReader, discoverCustomResponseModels,
  readCustomResponseModelCatalog, MAX_CATALOG_BYTES, MAX_MODELS };
