"use strict";

const path = require("node:path");
const { createNativeRuntimeImportAdapter } = require("./native-runtime-import-policy");

const adapter = createNativeRuntimeImportAdapter({
  runtime: "antigravity",
  sourceSegments: [".gemini"],
  targetRoot: (paths, runtimeProfileId) => path.join(paths.stateDir, "antigravity", runtimeProfileId),
  targetPrefix: ".gemini",
  active: [
    "GEMINI.md", "settings.json",
    "antigravity-cli/settings.json", "config/config.json",
  ],
  pending: [
    "config/hooks.json", "config/mcp_config.json", "config/plugins",
    "config/sidecars",
    "antigravity/mcp_config.json", "antigravity/plugins",
    "antigravity-ide/mcp_config.json", "antigravity-ide/plugins",
    "antigravity-cli/hooks", "antigravity-cli/plugins",
    "projects.json", "trustedFolders.json",
  ],
  skills: ["config/skills", "antigravity-cli/skills"],
  additionalSkillSourceSegments: [[".agents", "skills"]],
});

module.exports = Object.freeze({ ...adapter, skillImportRevision: 2 });
