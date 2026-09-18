"use strict";

const path = require("node:path");
const { createNativeRuntimeImportAdapter } = require("./native-runtime-import-policy");

module.exports = createNativeRuntimeImportAdapter({
  runtime: "codex",
  sourceSegments: [".codex"],
  targetRoot: (paths, runtimeProfileId) => path.join(paths.stateDir, "codex", runtimeProfileId),
  active: ["AGENTS.md", "config.toml"],
  pending: [
    "automations", "chrome-native-hosts.json", "chrome-native-hosts-v2.json",
    "computer-use", "hooks.json", "plugins", "rules", "superpowers",
  ],
  skills: ["skills"],
  additionalSkillSourceSegments: [[".agents", "skills"]],
  mapActiveDestination: (relativePath) => (
    relativePath === "config.toml" ? ".shoggoth-imported/config.toml" : relativePath
  ),
});
