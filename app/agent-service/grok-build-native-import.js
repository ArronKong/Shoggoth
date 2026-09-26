"use strict";

const path = require("node:path");
const { createNativeRuntimeImportAdapter } = require("./native-runtime-import-policy");

module.exports = createNativeRuntimeImportAdapter({
  runtime: "grok-build",
  sourceSegments: [".grok"],
  targetRoot: (paths, runtimeProfileId) => path.join(paths.stateDir, "grok-build", runtimeProfileId),
  active: ["config.toml"],
  pending: ["hooks", "installed-plugins", "grove"],
  skills: ["skills"],
});
