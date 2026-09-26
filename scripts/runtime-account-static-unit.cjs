#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { startStaticServer } = require("../app/static-server");
(async () => {
  const calls = [], id = "native-grok-build-default-v1";
  const storage = { runtimeAccountId: id, scope: "native-system", available: true, bytes: 1024,
    files: 1, dirs: 1, symlinks: 0, incomplete: false, limitReason: null };
  const account = { id, runtime: "grok-build", kind: "native-user", installationKind: "system",
    homeKind: "system-default", isDefault: true, sharedAgentCount: 2,
    admission: { generation: 1, active: 0, maxActive: 1, mutationActive: false, backoffUntil: null } };
  const project = (name, result) => async input => { calls.push([name, input]); return result; };
  const host = {
    listRuntimeAccounts: project("list", { accounts: [{ ...account, storage }] }),
    readRuntimeAccount: project("read", { account, storage }),
    readRuntimeAccountStorage: project("storage", storage),
    readRuntimeAccountAuth: project("auth", { account: null, requiresOpenaiAuth: true, login: null }),
    startRuntimeAccountLogin: project("login", { requestId: "request-1", mode: "browser", status: "waiting", loginId: "login-1", authUrl: "https://example.test/login" }),
    cancelRuntimeAccountLogin: project("cancel", { requestId: "request-1", status: "canceled" }),
    logoutRuntimeAccount: project("logout", { loggedOut: true }),
  };
  const server = await startStaticServer(0, { productHost: host, registry: { backends: new Map(), getBackend: () => null, listBackendDescriptors: () => [] } });
  const base = "/__api/shoggoth/runtime-accounts";
  const request = (suffix, body, origin = server.url) => fetch(server.url + base + suffix, {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const result = await request(""); assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { accounts: [{ ...account, storage }] });
    for (const [suffix, name] of [[`/${id}`, "read"], [`/${id}/storage`, "storage"], [`/${id}/auth`, "auth"]]) {
      assert.equal((await request(suffix)).status, 200);
      assert.deepEqual(calls.at(-1), [name, { runtimeAccountId: id }]);
    }
    assert.equal((await request(`/${id}/login`, { mode: "browser" }, null)).status, 403);
    for (const [suffix, body, name] of [["login", { mode: "browser" }, "login"],
      ["login/cancel", { requestId: "request-1" }, "cancel"], ["logout", {}, "logout"]]) {
      assert.equal((await request(`/${id}/${suffix}`, body)).status, 200);
      assert.deepEqual(calls.at(-1), [name, { runtimeAccountId: id, ...body }]);
    }
    const before = calls.length;
    for (const category of ["legacy-homes", "backups"]) for (const action of ["prepare", "commit"]) {
      assert.equal((await request(`/${category}/cleanup/${action}`, { entryId: "retired" })).status, 405);
    }
    assert.equal(calls.length, before, "retired cleanup cannot reach the product host");
    console.log("PASS current RuntimeAccount REST reads/auth, Origin gate and retired cleanup route rejection");
  } finally { await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
