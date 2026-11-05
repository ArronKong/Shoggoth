"use strict";

const assert = require("node:assert/strict");

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const transientStatuses = new Set([429, 500, 502, 503, 504]);

// Only reads are replayed here. Callers must reconcile an uncertain write.
async function releaseRequest(url, options = {}, runtime = {}) {
  const fetcher = runtime.fetch || fetch;
  const pause = runtime.sleep || sleep;
  const method = (options.method || "GET").toUpperCase();
  const attempts = ["GET", "HEAD"].includes(method) ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetcher(url, { ...options, method,
        signal: options.signal || AbortSignal.timeout(45_000) });
    } catch (cause) {
      const transient = ["TypeError", "TimeoutError", "AbortError"].includes(cause.name);
      if (transient && attempt < attempts) { await pause(attempt * 1500); continue; }
      throw Object.assign(new Error(`Release ${method} transport failed`, { cause }), { retryable: transient });
    }
    if (response.ok) return response;
    const limited = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
    const retryable = transientStatuses.has(response.status) || limited;
    const rawDelay = response.headers.get("retry-after");
    const delay = rawDelay === null ? attempt * 1500 : Number(rawDelay) * 1000;
    await response.body?.cancel();
    if (retryable && attempt < attempts && Number.isFinite(delay) && delay >= 0 && delay <= 30_000) {
      await pause(delay); continue;
    }
    throw Object.assign(new Error(`Release ${method} returned HTTP ${response.status}`),
      { status: response.status, retryable });
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

module.exports = { releaseRequest, releaseApi, sleep };
