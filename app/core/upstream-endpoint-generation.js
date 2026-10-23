"use strict";

const { createHash } = require("node:crypto");

// These getters belong to the App composition root, never to a browser RPC.
// An explicit retirement also changes the epoch when URL and owner generation
// happen to be unchanged (for example, a credential rotation).
function endpointDigest(url, generation = null) {
  if (typeof url !== "string" || !url.trim()) return null;
  if (generation !== null && !(typeof generation === "string" && generation.length <= 256)
    && !(Number.isSafeInteger(generation) && generation >= 0)) return null;
  return createHash("sha256").update(JSON.stringify([url.trim(), generation])).digest("hex");
}

function createEndpointGenerationGuard({ getUrl, getGeneration } = {}) {
  if (typeof getUrl !== "function" || (getGeneration !== undefined && typeof getGeneration !== "function")) {
    throw new TypeError("Endpoint getters must come from the App");
  }
  const bindings = new WeakSet();
  let epoch = 0;
  function current() {
    try {
      const url = getUrl();
      const generation = getGeneration ? getGeneration() : null;
      const digest = endpointDigest(url, generation);
      return digest ? { url: url.trim(), digest } : null;
    } catch { return null; }
  }
  return Object.freeze({
    capture() {
      const value = current();
      if (!value) return null;
      const binding = Object.freeze({ ...value, epoch });
      bindings.add(binding);
      return binding;
    },
    isCurrent(binding) {
      if (!binding || !bindings.has(binding) || binding.epoch !== epoch) return false;
      const value = current();
      return !!value && binding.url === value.url && binding.digest === value.digest;
    },
    invalidate() { epoch += 1; },
  });
}

module.exports = { createEndpointGenerationGuard, endpointDigest };
