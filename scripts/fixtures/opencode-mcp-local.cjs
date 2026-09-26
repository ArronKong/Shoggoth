"use strict";

// Offline CLI double. Production Pool/Host, gate, bootstrap and relay remain real.
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const [mode, home, argvText] = process.argv.slice(2);
if (mode === "version") { process.stdout.write("1.18.32\n"); process.exit(0); }
if (mode === "relay") {
  require("../../app/bootstrap-role").main(JSON.parse(argvText), process.env,
    { defaultApp: true, userInfo: () => ({ homedir: home }) }).catch(error => {
      process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1;
    });
} else {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  const mcp = config.mcp?.shoggoth;
  const sessionFile = require("node:path").join(home, ".offline-opencode-sessions.json");
  let child, sequence = 0, buffer = "", relayError = "";
  const sessions = new Map(fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, "utf8")) : []);
  const persist = () => fs.writeFileSync(sessionFile, JSON.stringify([...sessions]), { mode: 0o600 });
  const requests = new Map();
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { requests.delete(id); reject(new Error(`MCP timeout: ${relayError}`)); }, 8000);
      requests.set(id, value => { clearTimeout(timeout); resolve(value); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  let ready = Promise.resolve();
  if (mcp) {
    child = spawn(mcp.command[0], [__filename, "relay", home, JSON.stringify(mcp.command.slice(1))],
      { env: { ...process.env, ...mcp.environment }, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", bytes => { relayError += bytes; });
    child.stdout.on("data", bytes => {
      buffer += bytes;
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const finish = requests.get(response.id); requests.delete(response.id); finish?.(response);
      }
    });
    ready = rpc("initialize", { protocolVersion: require("../../app/shoggoth-mcp-helper").MCP_STDIO_PROTOCOL_VERSION,
      capabilities: {}, clientInfo: { name: "offline-opencode", version: "1" } });
    ready.catch(() => {});
  }
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`) {
      res.writeHead(401); res.end(); return;
    }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      const route = new URL(req.url, "http://127.0.0.1").pathname;
      let result = {};
      if (route === "/config") result = config;
      else if (route === "/doc") result = { paths: Object.fromEntries([
        "/session/{sessionID}/prompt_async", "/session/{sessionID}/message", "/permission/{requestID}/reply",
      ].map(value => [value, {}])) };
      else if (route === "/global/health") result = { healthy: true };
      else if (route === "/provider") result = { connected: ["fixture"], all: [{ id: "fixture", models: { offline: {} } }] };
      else if (route === "/fixture/call") {
        await ready; result = await rpc("tools/call", body);
        const active = [...sessions.values()].find(value => value.busy);
        if (active) {
          const parent = [...active.messages].reverse().find(value => value.info.role === "user");
          active.messages.push({ info: { id: `msg_tool_${sequence}`, sessionID: active.id,
            role: "assistant", parentID: parent.info.id }, parts: [{ type: "tool", id: `prt_tool_${sequence}`,
            callID: `call_${sequence}`, tool: `shoggoth_${body.name}`,
            state: { status: "completed", input: body.arguments, output: JSON.stringify(result.result) } }] });
          persist();
        }
      }
      else if (route === "/fixture/ready") result = { initialized: (await ready).result?.protocolVersion, pid: process.pid };
      else if (route === "/permission" || route === "/question") result = [];
      else if (route === "/session" && req.method === "POST") {
        result = { id: `ses_${require("node:crypto").randomBytes(8).toString("hex")}`,
          directory: process.cwd(), permission: body.permission };
        sessions.set(result.id, { ...result, busy: false, messages: [] }); persist();
      } else if (route === "/session" && req.method === "GET") result = [...sessions.values()];
      else if (route === "/session/status") result = Object.fromEntries([...sessions.values()]
        .map(value => [value.id, { type: value.busy ? "busy" : "idle" }]));
      else {
        const [, , id, action] = route.split("/"); const session = sessions.get(id);
        if (!session) throw new Error(`unknown route ${route}`);
        if (action === "prompt_async") {
          session.busy = true;
          session.messages.push({ info: { id: body.messageID, sessionID: id, role: "user" }, parts: body.parts });
          persist();
          res.writeHead(204); res.end(); return;
        } else if (action === "message") result = session.messages;
        else if (action === "abort") { session.busy = false; result = true; persist(); }
        else result = session;
      }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ message: error.message })); }
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(`http://127.0.0.1:${server.address().port}\n`));
  process.once("SIGTERM", () => { child?.kill(); server.close(); process.exit(0); });
}
