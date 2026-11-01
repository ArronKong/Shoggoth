"use strict";
// Source-mode diagnostic only. Wraps trusted composition in this test process;
// no production stop rules, timeouts or return values are replaced.
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { RuntimeExtensionAdapter } = require("../app/agent-service/runtime-extension-adapter");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const args = new Set(process.argv.slice(2)), output = path.resolve(__dirname, "../.artifacts/acp-foundation-completion-20261026/d-bridge");
fs.mkdirSync(output, { recursive: true });
const file = path.join(output, `helper-retirement-diagnostic-${Date.now()}.jsonl`), hosts = new Set(), rows = [];
const code = error => typeof error?.code === "string" ? error.code : error?.name || "UNKNOWN";
const note = row => { const value = { at: Date.now(), ...row }; rows.push(value); fs.appendFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 }); };
const originalKill = process.kill;
process.kill = function (pid, signal) {
  const traced = pid < -1 || [...hosts].some(host => host.child?.pid === pid);
  try { const result = originalKill.call(this, pid, signal); if (traced) note({ phase: "kill", pid, signal, outcome: "success" }); return result; }
  catch (error) { if (traced) note({ phase: "kill", pid, signal, outcome: code(error) }); throw error; }
};
const originalRevoke = RuntimeMcpGateIssuer.prototype.revokeMcpServer;
RuntimeMcpGateIssuer.prototype.revokeMcpServer = function (...values) {
  try { const result = originalRevoke.apply(this, values); note({ phase: "gate-revoke", outcome: "success", revoked: result.revoked }); return result; }
  catch (error) { note({ phase: "gate-revoke", outcome: code(error) }); throw error; }
};
const originalStart = RuntimeExtensionAdapter.prototype.start;
RuntimeExtensionAdapter.prototype.start = async function (...values) {
  const handle = await originalStart.apply(this, values), host = handle.host; hosts.add(host);
  for (const event of ["exit", "close", "error"]) host.child.on(event, (...details) => note({ phase: `child-${event}`, pid: host.child.pid,
    code: event === "error" ? code(details[0]) : details[0], signal: event === "error" ? null : details[1] }));
  for (const stream of ["stdin", "stdout", "stderr"]) host.child[stream].on("close", () => note({ phase: `${stream}-close`, pid: host.child.pid }));
  const originalClose = host.acpBridge.close;
  host.acpBridge.close = function (...args) {
    note({ phase: "bridge-close-begin", pid: host.child.pid, state: host.state, slots: this.slots.size });
    try { const value = originalClose.apply(this, args); note({ phase: "bridge-close-end", pid: host.child.pid }); return value; }
    catch (error) { note({ phase: "bridge-close-error", pid: host.child.pid, code: code(error) }); throw error; }
  };
  const originalStop = host.stop;
  const tracedStop = function (...args) {
    note({ phase: "stop-begin", pid: host.child.pid, state: host.state });
    return Promise.resolve().then(() => originalStop.apply(this, args)).then(value => {
      note({ phase: "stop-end", pid: host.child.pid, state: host.state }); return value;
    }, error => { note({ phase: "stop-error", pid: host.child.pid, state: host.state, code: code(error) }); throw error; });
  };
  host.stop = handle.stop = tracedStop; return handle;
};
const sourceFile = path.join(__dirname, "generic-acp-product-service-unit.cjs");
let source = fs.readFileSync(sourceFile, "utf8"); source = source.slice(0, source.indexOf("\ntest("));
source = source.replace('fs.rmSync(root, { recursive: true, force: true });', '/* Keep this controlled root for diagnostic evidence. */');
const electron = fs.realpathSync(require("electron"));
if (!args.has("--node-helper")) source = source.replace('mcpHelperLaunch: { command, argsPrefix: [] }', `mcpHelperLaunch: { command: ${JSON.stringify(electron)}, argsPrefix: [] }`);
const loaded = new Module(path.join(__dirname, "generic-acp-product-service-diagnostic-fixture.cjs"), module);
loaded.filename = path.join(__dirname, "generic-acp-product-service-diagnostic-fixture.cjs"); loaded.paths = Module._nodeModulePaths(__dirname);
loaded._compile(source + "\nmodule.exports={fixture};\n", loaded.filename);
async function main() {
  const cleanups = [], f = await loaded.exports.fixture({ after(callback) { cleanups.push(callback); } });
  note({ phase: "fixture", root: f.root, helper: args.has("--node-helper") ? "node" : "electron", electron });
  try {
    const ack = await f.service.workRunCoordinator.send({ sessionKey: f.session.sessionKey, operationId: "diagnostic-crash", prompt: "[ACP_PROBE:diagnostic-crash] [ACP_REQUIRE_MCP] [ACP_CRASH]" });
    let timer;
    try {
      const run = await Promise.race([f.service.workRunCoordinator.waitForTerminal(ack.run.id),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Diagnostic observed no terminal")), 12000); })]);
      note({ phase: "run-terminal", runId: run.id, status: run.status, code: run.errorCode });
    } catch (error) { note({ phase: "run-error", code: code(error), message: error.message }); }
    finally { clearTimeout(timer); }
  } finally {
    try { await f.service.stop({ notify: false }); note({ phase: "service-stopped" }); }
    catch (error) { note({ phase: "service-stop-error", code: code(error) }); }
    note({ phase: "audit", audit: f.audit() });
    process.kill = originalKill;
    console.log(JSON.stringify({ file, root: f.root, stopErrors: rows.filter(row => row.phase.endsWith("error")), phases: rows.length }));
  }
}
main().catch(error => { process.kill = originalKill; note({ phase: "diagnostic-error", code: code(error), message: error.message }); console.error(JSON.stringify({ file, code: code(error), message: error.message })); process.exitCode = 1; });
