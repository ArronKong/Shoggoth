"use strict";

const { serviceError } = require("./security");

// The runtime request writes synchronously when invoked. Keep the submission
// callback at that boundary, and leave its response timeout to the transport.
function guardRuntimeTurnSubmission(input, phase, submit) {
  if (!input.withTurnSendGuard) return submit();
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let done = false;
    const retire = () => {
      done = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
    };
    const fail = error => {
      if (done) return;
      retire();
      controller.abort(error);
      reject(error);
    };
    const cancel = () => fail(serviceError("WORK_RUN_COORDINATOR_STALE_RUN", "Runtime turn canceled before submission"));
    const timer = setTimeout(() => fail(serviceError("CONTEXT_MEMORY_READ_UNAVAILABLE", "Runtime send guard timed out")), 5_000);
    timer.unref?.();
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) { cancel(); return; }
    Promise.resolve().then(() => {
      if (done) return;
      return input.withTurnSendGuard(phase, () => {
        if (done) return;
        retire();
        try { resolve(submit()); } catch (error) { reject(error); }
      }, controller.signal);
    }).then(() => fail(serviceError("CONTEXT_MEMORY_READ_UNAVAILABLE", "Runtime send guard did not submit")), fail);
  });
}

module.exports = { guardRuntimeTurnSubmission };
