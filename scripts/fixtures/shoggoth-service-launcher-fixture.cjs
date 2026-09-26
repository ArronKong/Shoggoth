"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const serviceFixture = path.resolve(__dirname, "shoggoth-agent-service-fixture.cjs");
const child = spawn(process.execPath, [serviceFixture, process.argv[2]], {
  detached: true,
  stdio: "ignore",
});
child.unref();
process.stdout.write(`${child.pid}\n`);
