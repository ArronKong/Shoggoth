"use strict";

const readline = require("node:readline");
const { handle } = require("./mcp-sdk-fixture.cjs");

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "tools/call"
    && request.params?.arguments?.value === "crash") {
    setTimeout(() => process.exit(0), 20);
    return;
  }
  const response = handle(request, "2025-11-25");
  if (!response) return;
  if (request.method === "tools/call") {
    response.result.structuredContent.dataDirectory = process.env.PLUGIN_DATA;
    response.result.structuredContent.pid = process.pid;
  }
  const write = () => process.stdout.write(`${JSON.stringify(response)}\n`);
  if (request.method === "tools/call" && request.params?.arguments?.value === "slow") {
    setTimeout(write, 250);
  } else write();
  if (request.method === "tools/call" && request.params?.arguments?.value === "exit") {
    setTimeout(() => process.exit(0), 20);
  }
});
input.on("close", () => {
  // Keep the writer alive briefly after stdin EOF, so the lease test can
  // prove that a successor cannot start while shutdown is still in flight.
  setTimeout(() => process.exit(0), 350);
});
