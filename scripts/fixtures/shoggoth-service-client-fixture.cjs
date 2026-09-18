"use strict";

const path = require("node:path");
const ROOT = path.resolve(__dirname, "..", "..");
const { readClientToken, requestService } = require(path.join(ROOT, "app", "agent-service", "client.js"));
const { PROTOCOL_VERSION } = require(path.join(ROOT, "app", "agent-service", "server.js"));

const paths = JSON.parse(process.argv[2]);
requestService(paths, {
  method: "service.status",
  token: readClientToken(paths),
  version: PROTOCOL_VERSION,
}).then((status) => {
  process.stdout.write(`${JSON.stringify(status)}\n`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
