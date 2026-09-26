"use strict";
const readline = require("node:readline");
const reply = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line); let result;
  if (message.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  else if (message.method === "session/new") result = { sessionId: "acp-fixture-session" };
  else if (message.method === "session/load") result = {};
  else if (message.method === "session/prompt") {
    reply({ method: "session/update", params: { sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP fixture answer" } } } });
    result = { stopReason: "end_turn" };
  } else if (message.method === "session/cancel") return;
  else return reply({ id: message.id, error: { code: -32601, message: "unsupported" } });
  reply({ id: message.id, result });
});
