"use strict";
// Loopback-only protocol fixture. No model, CLI installation or user data.
const http = require("node:http");
const [scenario, version, command] = process.argv.slice(2);
if (command === "--version") { console.log(version); }
else {
  const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
  const paths = { "/session/{sessionID}/prompt_async": {}, "/session/{sessionID}/message": {}, "/permission/{requestID}/reply": {} };
  if (scenario !== "no-compact") paths["/session/{sessionID}/summarize"] = { post: {} };
  if (scenario === "missing-route") delete paths["/permission/{requestID}/reply"];
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  if (scenario === "unsafe-permission") config.permission["*"] = "allow";
  const server = http.createServer((request, response) => {
    const allowed = scenario === "no-auth" || request.headers.authorization === authorization;
    response.writeHead(allowed ? 200 : 401, { "Content-Type": "application/json" });
    response.end(JSON.stringify(!allowed ? {} : request.url === "/doc" ? { paths }
      : request.url === "/config" ? config : { healthy: true }));
  });
  server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
  process.once("SIGTERM", () => { server.closeAllConnections(); server.close(); });
}
