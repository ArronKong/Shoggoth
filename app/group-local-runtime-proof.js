"use strict";

const { execFile } = require("node:child_process");

const run = (command, args) => new Promise((resolve, reject) => execFile(command, args,
  { timeout: 3000, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));

/** Loopback may be an SSH tunnel. Filesystem access additionally requires a same-user runtime listener. */
async function verifyLocalGroupRuntime({ backendId, url }, { execute = run, uid = process.getuid?.() } = {}) {
  try {
    const endpoint = new URL(url);
    if (!["hermes", "openclaw"].includes(backendId) || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      || !["http:", "https:", "ws:", "wss:"].includes(endpoint.protocol) || !Number.isInteger(uid)) return false;
    const port = endpoint.port || (["https:", "wss:"].includes(endpoint.protocol) ? "443" : "80");
    const rows = await execute("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpu"]);
    const processes = []; let current = null;
    for (const line of rows.split("\n")) {
      if (/^p\d+$/u.test(line)) { current = { pid: Number(line.slice(1)), uid: null }; processes.push(current); }
      else if (/^u\d+$/u.test(line) && current) current.uid = Number(line.slice(1));
    }
    const owners = [...new Map(processes.filter(value => value.uid === uid).map(value => [value.pid, value])).values()];
    if (owners.length !== 1 || processes.some(value => value.uid !== uid)) return false;
    const command = (await execute("ps", ["-p", String(owners[0].pid), "-o", "command="])).trim();
    return backendId === "openclaw" ? /(?:^|[ /])openclaw[^\r\n;]*\bgateway\b/iu.test(command)
      : /(?:hermes[^\r\n;]*\bdashboard\b|tui_gateway[./]server|hermes_cli[./]dashboard)/iu.test(command);
  } catch { return false; }
}

module.exports = { verifyLocalGroupRuntime };
