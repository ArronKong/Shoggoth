#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), http = require("node:http");
const { startStaticServer } = require("../app/static-server");
const { createConfigStore } = require("../app/core/config-store");
const { createManagedOpenClawProductHost } = require("../app/managed-openclaw-product-host");
const { createManagedHermesProductHost } = require("../app/managed-hermes-product-host");
async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-managed-hosts-http-")); fs.chmodSync(root, 0o700);
  let web, unavailable; const calls = [], clients = { openclaw: 0, hermes: 0 };
  const store = createConfigStore(`${root}/config.json`); store.ensure();
  const hosts = {};
  for (const backendId of ["openclaw", "hermes"]) {
    let state = "absent";
    const factory = backendId === "openclaw" ? createManagedOpenClawProductHost : createManagedHermesProductHost;
    const mode = `${backendId}PluginHostMode`;
    const host = factory({ getMode: () => store.read()[mode], setManagedMode: () => store.write({ [mode]: "managed" }),
      createClient: () => {
        clients[backendId]++;
        return { ready: Promise.resolve(),
          getStatus: () => ({ state, ownership: state === "running" ? "managed" : "absent", selectionSupported: state === "running" }),
          getEndpoint: () => state === "running" ? { url: "http://127.0.0.1:9", token: "PRIVATE_ONLY" } : null,
          getExecution: () => state === "running" ? { home: root, runtimeRoot: root, configPath: `${root}/private.json` } : null,
          controller: { getCandidate: async () => ({ candidateId: "a".repeat(64) }), prepareCandidate: async () => { throw new Error("not used"); },
            activateCandidate: async () => { state = "running"; return { healthVerified: true }; },
            stopOwned: async () => { state = "absent"; return { ownership: "absent" }; } },
          close: async () => { state = "closed"; },
        };
      },
    });
    const exposed = {};
    for (const name of ["getStatus", "getOperationStatus"]) exposed[name] = (...args) => ({ ...host[name](...args),
      token: "PRIVATE_ONLY", dataRoot: root, nativeMeta: { pid: 123 }, backendId: "forged-source-id" });
    for (const action of ["prepare", "restart", "stop"]) exposed[action] = input => {
      calls.push({ backendId, action, input }); return host[action](input);
    };
    hosts[backendId] = { host, exposed };
  }
  try {
    for (const key of ["openclawPluginHostMode", "hermesPluginHostMode"]) {
      assert.equal(store.read()[key], "existing"); store.write({ [key]: "managed" });
      assert.equal(createConfigStore(store.path).read()[key], "managed");
      store.write({ [key]: "invalid" }); assert.equal(store.read()[key], "existing");
    }
    const options = { registry: { backends: new Map() }, configStore: store, homeDir: root, userDataRoot: root };
    web = await startStaticServer(0, { ...options, managedOpenClawHost: hosts.openclaw.exposed, managedHermesHost: hosts.hermes.exposed });
    unavailable = await startStaticServer(0, options);
    const request = async (url, options = {}) => {
      const response = await fetch(url, options), text = await response.text();
      return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : null, text };
    };
    const route = backendId => `${web.url}/__api/plugins/host-runtime/${backendId}`;
    for (const backendId of ["openclaw", "hermes"]) {
      const result = await request(route(backendId)); assert.equal(result.status, 200);
      assert.equal(result.body.backendId, backendId); assert.equal(Object.keys(result.body).length, 7);
      assert(!result.text.includes("PRIVATE_ONLY")); assert(!result.text.includes(root)); assert(!result.text.includes("nativeMeta"));
      assert.equal((await request(`${unavailable.url}/__api/plugins/host-runtime/${backendId}`)).status, 501);
    }
    assert.deepEqual(clients, { openclaw: 0, hermes: 0 }); assert.equal(calls.length, 0);
    console.log("PASS both backend modes persist; bounded GET projections disclose no private identity and start no client");
    const headers = { origin: web.url, "content-type": "application/json" };
    for (const backendId of ["openclaw", "hermes"]) {
      for (const action of ["prepare", "restart", "stop"]) {
        const operationId = `${action}-shared-id`;
        const result = await request(`${route(backendId)}/${action}`, { method: "POST", headers, body: JSON.stringify({ operationId }) });
        assert.equal(result.status, 202); assert.equal(result.body.backendId, backendId);
        await hosts[backendId].host.waitForOperation(operationId);
        const receipt = await request(`${route(backendId)}/operations/${operationId}`);
        assert.equal(receipt.status, 200); assert.equal(receipt.body.operationId, operationId); assert.equal(receipt.body.backendId, backendId);
      }
    }
    assert.deepEqual(clients, { openclaw: 1, hermes: 1 }); assert.equal(calls.length, 6);
    console.log("PASS prepare/restart/stop and exact original-operation queries are isolated by backend, including equal operation IDs");
    const stale = await request(`${web.url}/__api/config`, { method: "PUT", headers,
      body: JSON.stringify({ openclawPluginHostMode: "existing", hermesPluginHostMode: "existing", locale: "en" }) });
    assert.equal(stale.status, 200); assert.equal(store.read().locale, "en");
    for (const key of ["openclawPluginHostMode", "hermesPluginHostMode"]) assert.equal(stale.body.config[key], "managed");
    console.log("PASS stale or forged Settings PUT cannot downgrade either trusted managed mode");
    const count = calls.length;
    for (const backendId of ["openclaw", "hermes"]) {
      const endpoint = route(backendId);
      for (const body of [{}, [], { operationId: "bad/id" }, ...["sourceRoot", "runtimeRoot", "token", "authority", "policy", "ready", "backendId", "lease", "nativeMeta"].map(key => ({ operationId: "ok", [key]: "forged" }))]) {
        assert.equal((await request(`${endpoint}/prepare`, { method: "POST", headers, body: JSON.stringify(body) })).status, 400);
      }
      for (const suffix of ["?sourceRoot=/old", "/prepare?operationId=forged", "/operations/stop-shared-id?ready=true"]) {
        assert.equal((await request(`${endpoint}${suffix}`)).status, 400);
      }
      for (const badHeaders of [{ "content-type": "application/json" }, { ...headers, origin: "https://untrusted.example" }, { ...headers, "sec-fetch-site": "cross-site" }]) {
        assert.equal((await request(`${endpoint}/prepare`, { method: "POST", headers: badHeaders, body: '{"operationId":"ok"}' })).status, 403);
      }
      assert.equal((await request(`${endpoint}/operations/unknown`)).status, 404);
      assert.equal((await request(`${endpoint}/activate`, { method: "POST", headers, body: '{"operationId":"ok"}' })).status, 405);
      const withBody = await new Promise((resolve, reject) => {
        const req = http.request(endpoint, { method: "GET", headers: { "content-length": "2" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.on("error", reject); req.end("{}");
      });
      assert.equal(withBody, 400);
    }
    assert.equal((await request(`${web.url}/__api/plugins/host-runtime/unknown`)).status, 400);
    assert.equal(calls.length, count);
    console.log("PASS fixed routes, strict body/query, read-only GET and same-origin CSRF guards reject before controller mutation");
    for (const backendId of ["openclaw", "hermes"]) {
      hosts[backendId].exposed.prepare = () => { throw Object.assign(new Error("PRIVATE_ONLY"), { code: backendId === "hermes" ? "MANAGED_HERMES_LOCAL_RUNTIME_UNSUPPORTED" : "MANAGED_HOST_WRITER_OWNER_UNKNOWN" }); };
      const result = await request(`${route(backendId)}/prepare`, { method: "POST", headers, body: '{"operationId":"blocked"}' });
      assert.equal(result.status, 409); assert(!result.text.includes("PRIVATE_ONLY")); assert(result.body.code.startsWith("MANAGED_"));
    }
    console.log("PASS both backend refusal codes remain bounded without exposing private exception text");
    console.log(JSON.stringify({ ok: true, groups: 5, actualProductControllers: 2, runtimeSpawns: 0, modelCalls: 0, remoteCalls: 0 }));
  } finally { await web?.close(); await unavailable?.close(); for (const row of Object.values(hosts)) await row.host.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
