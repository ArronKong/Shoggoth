"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), net = require("node:net");
const { requestService } = require(path.join(process.env.SERVICE_CLIENT_TEST_ROOT || path.resolve(__dirname, ".."), "app/agent-service/client"));
async function reply(t, response, request = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-frame-")));
  fs.chmodSync(root, 0o700);
  const socketPath = path.join(root, "s");
  let received;
  const server = net.createServer(socket => socket.once("data", bytes => {
    received = JSON.parse(bytes.toString());
    socket.end(JSON.stringify(response(received)) + "\n");
  }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return requestService({ runtimeDir: root, socketPath }, { method: "service.status", ...request }, { timeoutMs: 1000 });
}
test("request ID defaults survive undefined/null IDs", async t => {
  for (const id of [undefined, null, ""]) {
    const result = await reply(t, req => { assert.match(req.id, /^[0-9a-f-]{36}$/); return { id: req.id, ok: true, result: "matched" }; }, { id });
    assert.equal(result, "matched");
  }
});
test("unparsed frame failures preserve their fixed code without pretending to match an RPC", async t => {
  for (const code of ["FRAME_TIMEOUT", "FRAME_TOO_LARGE", "INCOMPLETE_FRAME", "MALFORMED_JSON", "MULTIPLE_REQUESTS"]) {
    await assert.rejects(reply(t, () => ({ id: null, ok: false, error: { code, message: "private raw message" } })),
      error => error.code === code && !error.message.includes("private"));
  }
});
test("real ID mismatches, unknown null-ID errors and null-ID success remain rejected", async t => {
  for (const response of [
    { id: "wrong", ok: false, error: { code: "FRAME_TIMEOUT" } },
    { id: null, ok: false, error: { code: "AUTH_FAILED" } },
    { id: null, ok: true, result: "forged" }, null,
    { id: null, ok: false, error: { code: { toString: {} } } },
  ]) await assert.rejects(reply(t, () => response), { code: "RESPONSE_ID_MISMATCH" });
});

test("only the closed storage issue survives an IPC failure; code and admission stay unchanged", async t => {
  for (const systemIssue of ["STORAGE_FULL", "OTHER", { code: "STORAGE_FULL" }, null]) {
    await assert.rejects(reply(t, req => ({ id: req.id, ok: false,
      error: { code: "SERVICE_RECOVERY_REQUIRED", message: "needs recovery", systemIssue, privatePath: "must not copy" } })), error => {
      assert.equal(error.code, "SERVICE_RECOVERY_REQUIRED");
      assert.equal(error.systemIssue, systemIssue === "STORAGE_FULL" ? "STORAGE_FULL" : undefined);
      assert.equal(error.privatePath, undefined);
      assert.equal(error.admissionAccepted, undefined);
      return true;
    });
  }
});
