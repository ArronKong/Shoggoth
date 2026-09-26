"use strict";

const path = require("node:path");
const { createNativeRuntimeImportAdapter } = require("./native-runtime-import-policy");

module.exports = createNativeRuntimeImportAdapter({
  runtime: "deepseek-harness",
  sourceSegments: [".dsh"],
  targetRoot: (paths, runtimeProfileId) => path.join(paths.stateDir, "deepseek-harness", runtimeProfileId),
  active: ["settings.yaml", "settings.yml", "settings.json"],
  pending: ["profiles"],
  skills: ["skills"],
});
