"use strict";

const { serviceError } = require("./security");
const fail = code => serviceError(code, "Runtime 实际模型未能确认");
const ref = value => typeof value === "string" && value.length > 0 && value.length <= 512
  && value.isWellFormed() && !/[\u0000-\u0020\u007f]/u.test(value);
function validateModelResolution(result) {
  if (!result || Object.keys(result).length !== 2 || !ref(result.model) || !ref(result.provider)) {
    throw fail("MODEL_RESOLUTION_INVALID");
  }
  return Object.freeze({ model: result.model, provider: result.provider });
}
// Only an optional requested model is accepted beside operation metadata. No
// prompt, model turn, tool or memory text is accepted by this control call.
// The task must settle only after its private worker/thread has been released.
async function runBoundedModelResolution(input, task, { timeoutMs = 30_000, cleanupMs = 5_000 } = {}) {
  if (!input || Object.keys(input).some(key => !["operationId", "signal", "model"].includes(key))
    || typeof input.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.operationId)
    || (input.model !== undefined && !ref(input.model))
    || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw fail("MODEL_RESOLUTION_INVALID");
  if (input.signal?.aborted) throw fail("MODEL_ONLY_CANCELED");
  const controller = new AbortController();
  let timer, onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(fail("MODEL_ONLY_CANCELED")); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(fail("MODEL_RESOLUTION_TIMEOUT")); }, timeoutMs);
    timer.unref?.();
  });
  const pending = Promise.resolve().then(() => task(controller.signal));
  try { return validateModelResolution(await Promise.race([pending, interrupted])); }
  finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); controller.abort();
    let cleanup;
    try { await Promise.race([pending.then(() => {}, error => {
      if (error?.code === "RUNTIME_STOP_UNCONFIRMED") throw error;
    }), new Promise((_, reject) => {
      cleanup = setTimeout(() => reject(fail("RUNTIME_STOP_UNCONFIRMED")), cleanupMs);
    })]); } finally { clearTimeout(cleanup); }
  }
}
module.exports = { validateModelResolution, runBoundedModelResolution };
