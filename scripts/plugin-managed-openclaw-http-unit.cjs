#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), http = require("node:http");
const { startStaticServer } = require("../app/static-server");
const { createConfigStore } = require("../app/core/config-store");
async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-managed-host-http-")); fs.chmodSync(root, 0o700);
  let web; const calls = [];
  const status = { version: 1, backendId: "openclaw", mode: "managed", state: "running", operationId: "actual-operation",
    selectionSupported: true, errorCode: null, token: "secret-must-strip", dataRoot: "/private/old-root", identity: { pid: 123 } };
  const host = { getStatus: () => status, getOperationStatus: operationId => {
    if (operationId !== "actual-operation") throw Object.assign(new Error("missing"), { code: "MANAGED_HOST_OPERATION_NOT_FOUND", status: 404 });
    return status;
  } };
  for (const action of ["prepare", "restart", "stop"]) host[action] = input => { calls.push({ action, input }); return status; };
  try {
    const store = createConfigStore(`${root}/config.json`); store.ensure();
    assert.equal(store.read().openclawPluginHostMode, "existing");
    store.write({ openclawPluginHostMode: "managed" }); store.write({ locale: "en" });
    assert.equal(createConfigStore(store.path).read().openclawPluginHostMode, "managed");
    web = await startStaticServer(0, { registry: { backends: new Map() }, managedOpenClawHost: host,
      configStore: store, homeDir: root, userDataRoot: root });
    const endpoint = `${web.url}/__api/plugins/host-runtime/openclaw`;
    const request = async (url = endpoint, options = {}) => {
      const response = await fetch(url, options); const text = await response.text();
      return { status: response.status, text, body: text.startsWith("{") ? JSON.parse(text) : null };
    };
    const result = await request(); assert.equal(result.status, 200);
    assert.equal(Object.keys(result.body).length, 7); assert(!result.text.includes("secret")); assert(!result.text.includes("/private"));
    assert.equal(calls.length, 0);
    assert.equal((await request(`${endpoint}/operations/actual-operation`)).body.operationId, "actual-operation");
    assert.equal((await request(`${endpoint}/operations/unknown`)).status, 404);
    assert.equal(calls.length, 0);
    console.log("PASS mode survives config persistence; status GET strips all private metadata and performs no activation");
    const headers = { origin: web.url, "content-type": "application/json" };
    const staleSettings = await request(`${web.url}/__api/config`, { method: "PUT", headers,
      body: JSON.stringify({ openclawPluginHostMode: "existing", locale: "en" }) });
    assert.equal(staleSettings.status, 200); assert.equal(store.read().openclawPluginHostMode, "managed");
    assert.equal(staleSettings.body.config.openclawPluginHostMode, "managed"); assert.equal(store.read().locale, "en");
    console.log("PASS stale or forged Settings mode downgrade cannot restore legacy paths or bypass managed quit");
    for (const action of ["prepare", "restart", "stop"]) {
      assert.equal((await request(`${endpoint}/${action}`, { method: "POST", headers,
        body: JSON.stringify({ operationId: `${action}-test` }) })).status, 202);
    }
    assert.deepEqual(calls, ["prepare", "restart", "stop"].map(action => ({ action, input: { operationId: `${action}-test` } })));
    console.log("PASS same-origin POST delegates only the exact operation ID and bounded allowed action");
    const count = calls.length;
    for (const body of [{}, [], { operationId: "bad/id" }, ...["sourceRoot", "runtimeRoot", "token", "authority", "policy", "ready"].map(key => ({ operationId: "ok", [key]: "forged" }))]) {
      assert.equal((await request(`${endpoint}/prepare`, { method: "POST", headers, body: JSON.stringify(body) })).status, 400);
    }
    for (const url of [`${endpoint}?sourceRoot=/old`, `${endpoint}/prepare?operationId=forged`]) assert.equal((await request(url)).status, 400);
    assert.equal((await request(`${endpoint}/prepare`, { method: "POST", body: '{"operationId":"ok"}' })).status, 403);
    assert.equal((await request(`${endpoint}/prepare`, { method: "POST", headers: { ...headers, origin: "https://untrusted.example" }, body: '{"operationId":"ok"}' })).status, 403);
    assert.equal((await request(`${endpoint}/prepare`, { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body: '{"operationId":"ok"}' })).status, 403);
    assert.equal((await request(`${endpoint}/activate`, { method: "POST", headers, body: '{"operationId":"ok"}' })).status, 405);
    assert.equal((await request(`${endpoint}/prepare`)).status, 405);
    const withBody = await new Promise((resolve, reject) => {
      const req = http.request(endpoint, { method: "GET", headers: { "content-length": "2" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(withBody, 400); assert.equal(calls.length, count);
    console.log("PASS query/body/authority injection, missing Origin and cross-site actions all reject before controller access");
    host.prepare = () => { throw Object.assign(new Error("private-sensitive-failure"), { code: "MANAGED_HOST_WRITER_OWNER_UNKNOWN", status: 409 }); };
    const blocked = await request(`${endpoint}/prepare`, { method: "POST", headers, body: '{"operationId":"blocked"}' });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, "MANAGED_HOST_WRITER_OWNER_UNKNOWN");
    assert(!blocked.text.includes("private-sensitive"));
    console.log("PASS unknown writer refusal remains explicit without exposing private exception text");
    console.log(JSON.stringify({ ok: true, groups: 5, runtimeSpawns: 0, modelCalls: 0, remoteCalls: 0 }));
  } finally { await web?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
