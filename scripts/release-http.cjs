"use strict";

const assert = require("node:assert/strict");

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const transientStatuses = new Set([429, 500, 502, 503, 504]);
const connectionErrors = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);

function isTransientReadError(error) {
  const code = error?.cause?.code ?? error?.code;
  return ["TimeoutError", "AbortError"].includes(error?.name) || connectionErrors.has(code)
    || (code == null && error instanceof TypeError && error.message === "terminated");
}

// Only reads are replayed here. Callers must reconcile an uncertain write.
async function releaseRequest(url, options = {}, runtime = {}) {
  const fetcher = runtime.fetch || fetch;
  const pause = runtime.sleep || sleep;
  const method = (options.method || "GET").toUpperCase();
  const attempts = ["GET", "HEAD"].includes(method) && !runtime.singleAttempt ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetcher(url, { ...options, method,
        signal: options.signal || AbortSignal.timeout(45_000) });
    } catch (cause) {
      const transient = isTransientReadError(cause);
      if (transient && attempt < attempts) { await pause(attempt * 1500); continue; }
      throw Object.assign(new Error(`Release ${method} transport failed`, { cause }), { retryable: transient });
    }
    if (response.ok) return response;
    const rawDelay = response.headers.get("retry-after");
    const limitReached = [403, 429].includes(response.status) && response.headers.get("x-ratelimit-remaining") === "0";
    const rateLimited = response.status === 429 || limitReached || (response.status === 403 && rawDelay !== null);
    const reset = response.headers.get("x-ratelimit-reset");
    const now = runtime.now || Date.now;
    const retryAfterMs = rawDelay === null ? 0 : Math.ceil(Number(rawDelay) * 1000);
    const resetMs = !limitReached ? 0 : reset === null ? Infinity : Math.max(0, Number(reset) * 1000 - now());
    const delay = Math.max(retryAfterMs, resetMs, rawDelay === null && rateLimited && !limitReached ? 60_000 : attempt * 1500);
    const retryable = (transientStatuses.has(response.status) || rateLimited) && Number.isFinite(delay) && delay <= 30_000;
    await response.body?.cancel();
    if (retryable && attempt < attempts) {
      await pause(delay); continue;
    }
    throw Object.assign(new Error(`Release ${method} returned HTTP ${response.status}`),
      { status: response.status, retryable, rateLimited, retryAfterMs: delay });
  }
}

function releaseApi(repository, token, runtime = {}) {
  assert.equal(repository, "ArronKong/Shoggoth");
  assert.ok(token, "GitHub token is required");
  const base = `https://api.github.com/repos/${repository}`;
  const request = (route, options = {}) => {
    assert.ok(route === "" || (route.startsWith("/") && !route.startsWith("//")), "Invalid repository API route");
    return releaseRequest(base + route, { ...options, headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...options.headers,
    } }, runtime);
  };
  const get = async route => (await request(route)).json();
  const assertTag = async (tag, sha) =>
    assert.equal((await get(`/commits/${encodeURIComponent(tag)}`)).sha, sha, "Version tag moved away from the frozen source");
  return { request, get, assertTag };
}

module.exports = { releaseRequest, releaseApi, sleep, isTransientReadError };
