"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { startAgentServiceProcess } = require(path.resolve(__dirname, "..", "..", "app", "agent-service.js"));

const paths = JSON.parse(process.argv[2]);
process.on("SIGUSR1", () => {
  process.title = "shoggoth-service-title-changed";
  fs.writeFileSync(path.join(paths.stateDir, "title-changed"), "ok");
});
startAgentServiceProcess({ paths, version: "fixture", exitOnStop: true }).catch((error) => {
  console.error(error);
  process.exit(1);
});
