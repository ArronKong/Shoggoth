"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function legacyAcpReader() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "runtime-prepared-legacy-readers.json")));
  assert.equal(manifest.version, 1);
  const entry = manifest.sources["runtime-acp-handle.js"], source = fs.readFileSync(path.join(__dirname, entry.file));
  assert.equal(sha(source), entry.sha256, "Frozen ACP V1 reader must retain its original source bytes");
  const directory = path.resolve(__dirname, "../../app/agent-service"), filename = path.join(directory, "prepared-test-old-runtime-acp-handle.js");
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(directory);
  loaded._compile(source.toString("utf8"), filename);
  return { ...loaded.exports, sourceCommit: manifest.sourceCommit, sha256: entry.sha256 };
}
async function openLegacyAcpReader({ binding, workspace, stateDir, trustedRoot }) {
  const original = legacyAcpReader(), requests = [];
  const rpc = { subscribe() {}, registerServerRequestHandler() {}, async request(method) {
    requests.push(method); assert.equal(method, "initialize", "Read-only compatibility proof may never send a session or prompt request");
    return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  } };
  const handle = await original.createAcpHandle({ binding, workspace, stateDir, trustedRoot, home: workspace,
    rpc, stop: async () => {}, terminated: new Promise(() => {}) });
  return { handle, requests, sha256: original.sha256, sourceCommit: original.sourceCommit };
}
module.exports = { legacyAcpReader, openLegacyAcpReader };
