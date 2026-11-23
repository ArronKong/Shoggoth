"use strict";

const { validRuntimeModelSelection, runtimeModelIdentity, sameRuntimeModel } = require("./runtime-model-selection");

function validCronModelSelection(value) {
  return value === null || validRuntimeModelSelection(value);
}

function cronSessionHasModel(session, bindingId, selection) {
  return session?.runtimeBindingId === bindingId && !session.nextRuntimeSelection
    && session.modelOverride === (selection?.model ?? null)
    && (session.modelProviderRef ?? null) === (selection?.modelProviderRef ?? null);
}

module.exports = { validCronModelSelection, cronModelIdentity: runtimeModelIdentity, sameCronModel: sameRuntimeModel, cronSessionHasModel };
