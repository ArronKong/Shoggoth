"use strict";

const { createHash } = require("node:crypto");

// Storage/command tests replace complete() with an in-process literal model.
// Its matching control transport attests that literal selection, while a
// missing model remains unknown. This is a test double, not a Coordinator
// selection token; real Runtime discovery and cache routing have separate
// Service and native-control tests.
function installLiteralMemoryModelControl(owner) {
  owner.prepareModelContext = async input => {
    input.signal?.throwIfAborted(); input.assertCurrent?.();
    const context = owner.resolveModelContext(input);
    const model = input.model || context.currentModel || context.defaultModel;
    if (!model) return context;
    return Object.freeze({ ...context, requestedModel: model, selectedModel: model,
      currentModel: input.sessionKey ? model : null, defaultModel: model,
      fingerprint: createHash("sha256").update(JSON.stringify([context.fingerprint, model])).digest("hex") });
  };
}

module.exports = { installLiteralMemoryModelControl };
