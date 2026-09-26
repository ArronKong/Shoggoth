"use strict";

const path = require("node:path");
const { createNativeRuntimeImportAdapter } = require("./native-runtime-import-policy");

module.exports = createNativeRuntimeImportAdapter({
  runtime: "pi",
  sourceSegments: [".pi", "agent"],
  targetRoot: (paths, runtimeProfileId) => path.join(paths.stateDir, "pi", runtimeProfileId),
  active: ["settings.json"],
  pending: ["extensions", "models-store.json", "prompt-templates", "themes"],
  skills: ["skills"],
});
