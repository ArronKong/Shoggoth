"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const { StdioMcpClient } = require("../app/agent-service/native-mcp-client-manager");
const { OFFICIAL_SKILL_IDS, OFFICIAL_SKILL_PUBLIC_MESSAGES, officialSkillPublicError } = require("../app/core/official-skill-connector-dto");

async function bridge(t, providerId) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "official-compatibility-")); fs.chmodSync(base, 0o700);
  const root = path.join(base, "state/runtime-bin/official-skills", providerId, crypto.randomUUID()), home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const files = { "payload.txt": "private-payload-canary" };
  if (providerId === "shop") files["shop-tools.json"] = JSON.stringify({ tools: require("./fixtures/shop-mcp.json").tools.tools });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, providerId,
    files: Object.entries(files).map(([name, content]) => ({ path: name, sha256: crypto.createHash("sha256").update(content).digest("hex") })) }), { mode: 0o600 });
  const client = new StdioMcpClient({ command: process.execPath,
    args: [path.resolve(__dirname, "../app/agent-service/official-skill-mcp-bridge.js"), "--provider", providerId, "--root", root, "--home", home], cwd: root },
  { trustedOfficialBridge: true, trustedEnv: { ELECTRON_RUN_AS_NODE: "1", HOME: home }, readinessTimeoutMs: 5000 });
  t.after(async () => { await client.close(); fs.rmSync(base, { recursive: true, force: true }); });
  await client.start();
  return { root, home, call: name => client.request("tools/call", { name, arguments: {} }, 5000) };
}

for (const providerId of OFFICIAL_SKILL_IDS) test(`${providerId}: payload permissions remain an integrity error across the real bridge`, async t => {
  const f = await bridge(t, providerId), file = path.join(f.root, "payload.txt");
  fs.chmodSync(file, 0o644);
  await assert.rejects(f.call("account_status"), error => error.code === "OFFICIAL_SKILL_INTEGRITY_FAILED"
    && !error.message.includes(f.root) && !error.message.includes("private-payload-canary"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, "unrecognized payloads are never repaired or adopted");
});

test("invalid payload manifests are component failures, not authorization failures", async t => {
  const f = await bridge(t, "weread");
  fs.writeFileSync(path.join(f.root, "payload-manifest.json"), "invalid-private-manifest");
  await assert.rejects(f.call("account_status"), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
});

test("Quark private authorization state failures stay distinct from a rejected account", async t => {
  const f = await bridge(t, "quark-drive"), file = path.join(f.home, "quark-authorization.json");
  fs.writeFileSync(file, "private-account-canary", { mode: 0o644 });
  await assert.rejects(f.call("account_start"), error => error.code === "OFFICIAL_SKILL_INTEGRITY_FAILED"
    && !error.message.includes(f.home) && !error.message.includes("private-account-canary"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(file, "utf8"), "private-account-canary");
});

for (const providerId of ["quark-drive", "meituan-paotui", "doordash"]) test(`${providerId}: status checks cannot hide a managed HOME failure`, async t => {
  const f = await bridge(t, providerId);
  if (providerId === "doordash") fs.writeFileSync(path.join(f.home, "doordash-token.json"), JSON.stringify({ accessToken: "private-offline-token-canary", expiresAt: null }), { mode: 0o600 });
  const file = path.join(f.home, "unexpected-cache"); fs.writeFileSync(file, "keep-private-state", { mode: 0o644 });
  await assert.rejects(f.call("account_status"), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
  assert.equal(fs.readFileSync(file, "utf8"), "keep-private-state");
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});

test("DoorDash status reports a missing native runtime without discarding saved authorization", async t => {
  const f = await bridge(t, "doordash"), file = path.join(f.home, "doordash-token.json");
  const token = JSON.stringify({ accessToken: "private-offline-token-canary", expiresAt: null });
  fs.writeFileSync(file, token, { mode: 0o600 });
  await assert.rejects(f.call("account_status"), { code: "OFFICIAL_SKILL_RUNTIME_MISSING" });
  assert.equal(fs.readFileSync(file, "utf8"), token);
});

// The peer fixture tests framing and trust boundaries only. Provider parsing and
// the real bridge's filesystem checks are exercised separately above and in the
// provider suites; no remote account or business operation is dispatched here.
async function errorPeer(t, trusted) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "official-error-peer-"));
  const script = path.join(base, "peer.cjs");
  fs.writeFileSync(script, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);if(m.id===undefined)return;
    const response=m.method==='initialize'?{result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}
      :{error:{code:m.params.rpcCode??-32000,message:m.params.errorCode,data:'private-peer-canary'}};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...response})+'\\n');
  });`, { mode: 0o600 });
  const client = new StdioMcpClient({ command: process.execPath, args: [script], cwd: base },
    { trustedOfficialBridge: trusted, trustedEnv: { ELECTRON_RUN_AS_NODE: "1" }, readinessTimeoutMs: 5000 });
  t.after(async () => { await client.close(); fs.rmSync(base, { recursive: true, force: true }); });
  await client.start(); return client;
}

for (const trusted of [true, false]) test(`known official errors are preserved only for validated account calls (trusted=${trusted})`, async t => {
  const client = await errorPeer(t, trusted);
  for (const code of Object.keys(OFFICIAL_SKILL_PUBLIC_MESSAGES)) {
    await assert.rejects(client.request("tools/call", { name: "account_start", arguments: {}, errorCode: code }, 5000), error => {
      const expected = !trusted ? "MCP_SERVER_CALL_FAILED" : code === "OFFICIAL_SKILL_OPERATION_UNCERTAIN" ? "MCP_SERVER_RESULT_UNKNOWN" : code;
      assert.equal(error.code, expected, code);
      assert.equal(error.message.includes("private-peer-canary"), false);
      if (trusted && expected === code) assert.equal(officialSkillPublicError(error).message, OFFICIAL_SKILL_PUBLIC_MESSAGES[code]);
      return true;
    });
  }
});

test("business error mappings and unknown-result barriers survive; unknown codes and wrong RPC methods cannot claim trust", async t => {
  const client = await errorPeer(t, true);
  const mappings = {
    OFFICIAL_SKILL_AUTH_REQUIRED: "MCP_AUTH_REQUIRED", OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED: "MCP_AUTH_REQUIRED",
    OFFICIAL_SKILL_APPROVAL_REQUIRED: "MCP_CONNECTOR_NOT_READY", OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED: "MCP_SERVER_REQUEST_INVALID",
    OFFICIAL_SKILL_OPERATION_UNCERTAIN: "MCP_SERVER_RESULT_UNKNOWN", OFFICIAL_SKILL_SESSION_REQUIRED: "OFFICIAL_SKILL_SESSION_REQUIRED",
    OFFICIAL_SKILL_QUARK_AUTH_REQUIRED: "OFFICIAL_SKILL_QUARK_AUTH_REQUIRED", OFFICIAL_SKILL_QUARK_LIMITED: "OFFICIAL_SKILL_QUARK_LIMITED",
    OFFICIAL_SKILL_ROLLINGGO_AUTH_REQUIRED: "OFFICIAL_SKILL_ROLLINGGO_AUTH_REQUIRED", OFFICIAL_SKILL_RATE_LIMITED: "OFFICIAL_SKILL_RATE_LIMITED",
  };
  for (const [errorCode, code] of Object.entries(mappings)) await assert.rejects(client.request("tools/call", { name: "fixture_read", arguments: {}, errorCode }, 5000), { code });
  for (const params of [
    { errorCode: "OFFICIAL_SKILL_PRIVATE_UNKNOWN" }, { errorCode: "toString" },
    { errorCode: { toString: null } },
    { errorCode: "OFFICIAL_SKILL_QUARK_LIMITED", rpcCode: -32603 },
  ]) await assert.rejects(client.request("tools/call", { name: "account_start", ...params }, 5000), { code: "MCP_SERVER_CALL_FAILED" });
  await assert.rejects(client.request("tools/list", { errorCode: "OFFICIAL_SKILL_QUARK_LIMITED" }, 5000), { code: "MCP_SERVER_CALL_FAILED" });
});
