"use strict";

const { normalizedApiRoot } = require("./codex-provider-service");

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_MODELS = 500;

function failure(code, reachable = false) {
  return { ok: false, reachable, code, message: "Model catalog could not be read.", models: [] };
}

// Discovery only reads the supplied service's catalog. It never saves a key,
// binds a Profile, or sends a model inference request.
async function discoverCustomResponseModels(endpoint = {}, request = globalThis.fetch) {
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
      headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
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
    for (const row of rows) {
      const raw = typeof row === "string" ? row : row?.id ?? row?.name;
      if (typeof raw !== "string") continue;
      const model = raw.trim();
      if (model && Buffer.byteLength(model, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/u.test(model) && (!key || !model.includes(key))) {
        models.add(model);
      }
      if (models.size >= MAX_MODELS) break;
    }
    return { ok: true, reachable: true, message: "", models: [...models] };
  } catch (error) {
    // Remote error bodies and exceptions may echo the credential; only return
    // stable codes that the UI translates locally.
    return failure(error?.name === "TimeoutError" ? "timeout" : "catalog_unavailable", Boolean(response));
  }
}

module.exports = { discoverCustomResponseModels, MAX_CATALOG_BYTES, MAX_MODELS };
