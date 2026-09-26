"use strict";
const http = require("node:http");
const readline = require("node:readline");
const endpoint = new URL(process.env.SHOGGOTH_CAPACITY_ENDPOINT);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin }).on("line", line => {
  const input = JSON.parse(line);
  if (input.type === "get_state") {
    send({ id: input.id, type: "response", command: input.type, success: true,
      data: { model: { id: "capacity-fixture-model", provider: "capacity-fixture", baseUrl: `${endpoint.origin}/v1` } } });
  } else if (input.type === "prompt") {
    const request = http.request(new URL("/v1/chat/completions", endpoint), { method: "POST" }, response => {
      response.resume();
      response.on("end", () => send({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "CAPACITY_FIXTURE_OK" }] }] }));
    });
    request.on("error", () => { process.exitCode = 1; process.stdin.destroy(); });
    request.end(JSON.stringify({ model: "capacity-fixture-model", stream: true }));
  }
});
