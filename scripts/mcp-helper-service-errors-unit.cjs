"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const root = path.resolve(process.env.SHOGGOTH_TEST_SOURCE_ROOT || path.join(__dirname, ".."));
const { authenticateMcpSession, authenticateFederationMcpSession } = require(path.join(root, "app/shoggoth-mcp-helper"));
const bootstrap = require(path.join(root, "app/bootstrap-role"));
const { recordBootstrapFailure } = require(path.join(root, "app/bootstrap-diagnostics"));
const { resolveServicePaths } = require(path.join(root, "app/agent-service/paths"));
const { ensureFederationMcpCredential, federationMcpAuthPath } = require(path.join(root, "app/agent-service/federation-mcp-auth"));
const { CodexJsonlRpcClient } = require(path.join(root, "app/agent-service/codex-jsonl-rpc"));
const { recordCodexSessionFailure } = require(path.join(root, "app/agent-service/codex-session-diagnostics"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(root, "app/agent-service/service-protocol-version"));

const binding = { runtimeProfileId: "fixture-runtime", runtimeAccountId: "fixture-account" };
const unavailable = "MCP_HELPER_SERVICE_UNAVAILABLE";
const recovery = "MCP_HELPER_SERVICE_RECOVERY_REQUIRED";
const auth = "MCP_HELPER_AUTH_FAILED";
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-service-error-")));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolveServicePaths({ homeDir: home });
  ensureFederationMcpCredential(paths);
  return paths;
}
function assertPublic(error, code) {
  assert.equal(error.code, code);
  assert.equal(error.message, code.toLowerCase());
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|Bearer|\/Users\//u);
  return true;
}

test("native and federated startup distinguish unavailable/recovery/auth without retrying", async (t) => {
  const paths = fixture(t);
  for (const [cause, expected] of [
    ["SERVICE_UNAVAILABLE", unavailable], ["SERVICE_QUIESCED", unavailable],
    ["SERVICE_DISCONNECTED", unavailable], ["REQUEST_TIMEOUT", unavailable],
    ["ENOENT", unavailable], ["ECONNREFUSED", unavailable],
    ["ECONNRESET", unavailable], ["EPIPE", unavailable],
    ["SERVICE_RECOVERY_REQUIRED", recovery], ["MCP_AUTH_FAILED", auth],
    ["UNSAFE_OWNER", auth], ["PROTOCOL_VERSION_MISMATCH", auth], ["PRIVATE_CODE", auth],
  ]) {
    for (const kind of ["native", "federated"]) {
      let calls = 0;
      const options = { paths, ...binding, requestService: async () => {
        calls++;
        throw Object.assign(new Error("PRIVATE_PROMPT Bearer PRIVATE_TOKEN /Users/private"), { code: cause });
      } };
      const start = kind === "native" ? authenticateMcpSession(options)
        : authenticateFederationMcpSession({ ...options, client: "openclaw", authFile: federationMcpAuthPath(paths) });
      await assert.rejects(start, error => assertPublic(error, expected));
      assert.equal(calls, 1, `${kind} ${cause} must not replay authentication or send a task`);
    }
  }
});

test("missing federation credential stays auth failure and never contacts Service", async (t) => {
  const paths = fixture(t);
  fs.unlinkSync(federationMcpAuthPath(paths));
  await assert.rejects(authenticateFederationMcpSession({ paths, ...binding,
    client: "hermes", authFile: federationMcpAuthPath(paths),
    requestService: async () => assert.fail("credential failure cannot call Service"),
  }), error => assertPublic(error, auth));
});

test("exchange transport errors keep their cause and clear the secret; local credential errors stay auth failures", async (t) => {
  const paths = fixture(t);
  for (const [cause, expected, localFailure] of [
    ["ECONNRESET", unavailable, false], ["SERVICE_RECOVERY_REQUIRED", recovery, false],
    ["MCP_AUTH_FAILED", auth, false], ["ENOENT", auth, true],
  ]) {
    const secret = Buffer.alloc(32, 0x5a), methods = [];
    const failure = Object.assign(new Error("PRIVATE_MESSAGE"), { code: cause });
    await assert.rejects(authenticateMcpSession({ paths, ...binding,
      mcpCryptoBroker: { readForHelper: async () => { if (localFailure) throw failure; return secret; } },
      requestService: async (_paths, request) => {
        methods.push(request.method);
        if (request.method === "mcp.auth.challenge") return {
          challengeId: Buffer.alloc(16, 0x11).toString("base64url"),
          protocolVersion: SERVICE_PROTOCOL_VERSION, ...binding,
          clientNonce: request.params.clientNonce, serverNonce: Buffer.alloc(32, 0x22).toString("base64url"),
          expiresAt: Date.now() + 10_000,
        };
        throw failure;
      },
    }), error => assertPublic(error, expected));
    assert.deepEqual(methods, localFailure ? ["mcp.auth.challenge"] : ["mcp.auth.challenge", "mcp.auth.exchange"]);
    if (!localFailure) assert.equal(secret.every(byte => byte === 0), true);
  }
});

test("auth errors never invoke hostile code accessors", async () => {
  let hits = 0;
  const error = Object.defineProperty({}, "code", { get() { hits++; throw Error("PRIVATE_SECRET"); } });
  await assert.rejects(authenticateMcpSession({ ...binding, requestService: async () => { throw error; } }),
    caught => assertPublic(caught, auth));
  assert.equal(hits, 0);
});

test("actual absent socket is service unavailable and a recovering IPC stays recovery-required", async (t) => {
  const paths = fixture(t);
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await assert.rejects(authenticateMcpSession({ paths, ...binding }), error => assertPublic(error, unavailable));
  let requests = 0;
  const server = net.createServer(socket => {
    socket.once("data", data => {
      requests++;
      const request = JSON.parse(data.toString("utf8"));
      assert.equal(request.method, "mcp.auth.challenge");
      socket.end(JSON.stringify({ id: request.id, ok: false, error: { code: "SERVICE_RECOVERY_REQUIRED", message: "PRIVATE_PATH" } }) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.socketPath, resolve); });
  fs.chmodSync(paths.socketPath, 0o600);
  try {
    await assert.rejects(authenticateMcpSession({ paths, ...binding }), error => assertPublic(error, recovery));
    assert.equal(requests, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const code of [unavailable, recovery]) test(`${code} survives bootstrap and Codex diagnostics without private messages`, async (t) => {
  const paths = fixture(t);
  let startupError;
  await assert.rejects(bootstrap.main(["--shoggoth-internal-role=mcp"], { NODE_ENV: "test" },
    { defaultApp: true, verifyMcpParent: () => true }, { mcp: async () => {
      throw Object.assign(new Error("PRIVATE_MESSAGE"), { code, secret: "PRIVATE_CREDENTIAL" });
    } }), error => { startupError = error; return error.code === code && error.message === code; });
  assert.equal(recordBootstrapFailure(startupError, { paths, argv: ["--shoggoth-internal-role=mcp"] }), true);
  const bootstrapText = fs.readFileSync(path.join(paths.runtimeDir, "bootstrap-diagnostics.json"), "utf8");
  assert.equal(JSON.parse(bootstrapText).records[0].errors[0].code, code);
  assert.doesNotMatch(bootstrapText, /PRIVATE_/u);

  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const rpc = new CodexJsonlRpcClient(child);
  try {
    const pending = rpc.request("thread/start", {});
    child.stdout.write(JSON.stringify({ id: 1, error: { code: -32603,
      message: `required MCP servers failed to initialize: ${code} PRIVATE_PROMPT`,
    } }) + "\n");
    await assert.rejects(pending, error => {
      assert.equal(error.startupDiagnostic, code);
      assert.equal(recordCodexSessionFailure({ paths, binding: { runtime: "codex", ...binding },
        operationName: "threadStart", phase: "rpc", params: {}, error }), true);
      return true;
    });
    const text = fs.readFileSync(path.join(paths.runtimeDir, "codex-session-diagnostics.json"), "utf8");
    assert.equal(JSON.parse(text).records[0].startupDiagnostic, code);
    assert.doesNotMatch(text, /PRIVATE_/u);
  } finally { await rpc.terminate(); }
});
