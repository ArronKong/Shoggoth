"use strict";
const { runBoundedModelOnly } = require("./runtime-model-only");
const { serviceError } = require("./security");
const fail = code => serviceError(code, "受限模型检查未能完成");

// These are dedicated, tool-free ACP processes, never a user's warm chat
// process. Stopping the process group is the cancellation/cleanup receipt.
async function generateAcpModelOnly(host, input) {
  if (!host.modelOnlyInstance || host.permissionPolicy.approvalPolicy !== "never"
    || host.permissionPolicy.sandbox !== "read-only") throw fail("MODEL_ONLY_TOOLS_FORBIDDEN");
  return runBoundedModelOnly(input, async signal => {
    let sessionId, text = "", usage = null, model = input.model, provider = null;
    let resolve, reject;
    const terminal = new Promise((yes, no) => { resolve = yes; reject = no; });
    terminal.catch(() => {});
    const abort = () => { reject(fail("MODEL_ONLY_CANCELED")); void host.stop().catch(() => {}); };
    const fence = () => { if (signal.aborted) throw fail("MODEL_ONLY_CANCELED"); input.assertCurrent?.(); };
    const unsubscribe = host.subscribe(event => {
      if (!sessionId || (event.sessionId ?? event.threadId) !== sessionId) return;
      if (["tool_start", "tool_update", "tool_result"].includes(event.type)) {
        reject(fail("MODEL_ONLY_TOOLS_FORBIDDEN")); void host.stop().catch(() => {});
      }
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "text") text = event.text;
      if (Buffer.byteLength(text) > 32 * 1024) { reject(fail("MODEL_ONLY_OUTPUT_INVALID")); void host.stop().catch(() => {}); }
      if (event.type === "usage" && event.usage) {
        if (!usage) usage = { ...event.usage };
        else for (const key of Object.keys(usage)) usage[key] += event.usage[key] || 0;
        model = event.model || model; provider = event.provider || provider;
      }
      if (event.type === "complete") {
        if (event.status === "completed") resolve();
        else reject(fail(event.errorCode || event.failure?.code || "MODEL_ONLY_ACCEPTANCE_UNKNOWN"));
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    host.terminated.then(() => reject(fail("MODEL_ONLY_ACCEPTANCE_UNKNOWN")), reject);
    try {
      fence();
      const started = await host.sessionStart({ source: `model-only:${input.operationId}`, cwd: null,
        model: input.model, modelSecretScope: input.modelSecretScope, permissionPolicy: host.permissionPolicy,
        developerInstructions: "Complete the supplied text task. No tools or external actions are authorized." });
      sessionId = started.session.id;
      fence();
      await host.turnStart({ sessionId, operationId: input.operationId, prompt: input.prompt, model: input.model,
        cwd: null, attachments: [], permissionPolicy: host.permissionPolicy });
      await terminal; fence();
      input.onText?.(text);
      return { text, usage, model, provider };
    } finally {
      signal.removeEventListener("abort", abort); unsubscribe();
      try { await host.stop(); } catch { throw fail("RUNTIME_STOP_UNCONFIRMED"); }
    }
  }, { cleanupMs: 10_000 });
}
module.exports = { generateAcpModelOnly };
