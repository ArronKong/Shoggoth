"use strict";

const { serviceError } = require("./security");
const fail = code => serviceError(code, "无工具模型任务未能完成");
function validateModelOnlyInput(input) {
  if (!input || typeof input.prompt !== "string" || !input.prompt.isWellFormed() || input.prompt.includes("\0")
    || !input.prompt.length || Buffer.byteLength(input.prompt) > 128 * 1024
    || (input.model !== null && (typeof input.model !== "string" || !input.model.length || input.model.length > 512
      || !input.model.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(input.model)))
    || typeof input.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.operationId)
    || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw fail("MODEL_ONLY_INVALID");
  if (input.signal?.aborted) throw fail("MODEL_ONLY_CANCELED");
}
async function runBoundedModelOnly(input, task, { timeoutMs = 180_000, cleanupMs = 5_000 } = {}) {
  validateModelOnlyInput(input);
  const controller = new AbortController();
  let timer, onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(fail("MODEL_ONLY_CANCELED")); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(fail("MODEL_ONLY_ACCEPTANCE_UNKNOWN")); }, timeoutMs);
    timer.unref?.();
  });
  const pending = Promise.resolve().then(() => task(controller.signal));
  try {
    const result = await Promise.race([pending, interrupted]);
    if (!result || typeof result.text !== "string" || !result.text.trim()
      || Buffer.byteLength(result.text) > 32 * 1024) throw fail("MODEL_ONLY_OUTPUT_INVALID");
    return result;
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); controller.abort();
    // Do not release the admission slot while a canceled child is still alive.
    let cleanup;
    try { await Promise.race([pending.then(() => {}, () => {}), new Promise((_, reject) => {
      cleanup = setTimeout(() => reject(fail("RUNTIME_STOP_UNCONFIRMED")), cleanupMs);
    })]); } finally { clearTimeout(cleanup); }
  }
}
module.exports = { validateModelOnlyInput, runBoundedModelOnly };
