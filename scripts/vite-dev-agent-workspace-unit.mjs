import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer as createViteServer } from "../app/manage-ui/node_modules/vite/dist/node/index.js";
import { devAgentWorkspace } from "../app/manage-ui/dev-agent-workspace.ts";

test("the Vite preview projects a managed workspace for an older desktop host", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-dev-agent-workspace-"));
  const agentsDir = path.join(root, "shoggoth-core", "agents");
  const agentDir = path.join(agentsDir, "profile-fixture");
  const nameLinks = path.join(root, "agents-by-name");
  const managedPath = path.join(nameLinks, "Shoggoth");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(nameLinks);
  fs.symlinkSync(path.relative(nameLinks, agentDir), managedPath, "dir");
  const legacy = { id: "shoggoth-legacy", name: "Shoggoth", backendId: "shoggoth", profile: "profile-fixture", workspace: "/project" };
  const notCreated = { ...legacy, id: "shoggoth-new-agent", profile: "profile-new-agent" };
  const current = {
    ...legacy, id: "shoggoth-current", managedWorkspace: { path: "/authoritative", exists: false },
  };
  const external = { id: "hermes-fixture", backendId: "hermes", profile: "profile-fixture" };
  const upstream = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    const agent = {
      "/__api/agents/shoggoth-legacy": legacy,
      "/__api/agents/shoggoth-current": current,
      "/__api/agents/shoggoth-new-agent": notCreated,
      "/__api/agents/shoggoth-mismatch": legacy,
      "/__api/agents/hermes-fixture": external,
    }[pathname];
    const body = Buffer.from(JSON.stringify(agent ? { agent, method: req.method } : { error: "missing" }));
    res.writeHead(agent ? 200 : 404, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
  });
  let vite;
  t.after(async () => {
    try {
      await vite?.close();
      if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const target = `http://127.0.0.1:${upstream.address().port}`;
  vite = await createViteServer({
    configFile: false, root, logLevel: "silent",
    plugins: [devAgentWorkspace(target, { userDataRoot: root, agentsDir })],
    server: { host: "127.0.0.1", port: 0, strictPort: true, proxy: { "/__api": target } },
  });
  await vite.listen();
  const preview = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const route = (agent, backend = "shoggoth") => `/__api/agents/${agent}?backend=${backend}`;
  const request = (id, backend, init) => fetch(preview + route(id, backend), init);

  assert.deepEqual((await (await fetch(target + route(legacy.id))).json()).agent, legacy);
  const response = await request(legacy.id);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).agent, { ...legacy, managedWorkspace: { path: managedPath, exists: true } });
  assert.deepEqual((await (await request(current.id)).json()).agent, current);
  assert.deepEqual((await (await request("shoggoth-mismatch")).json()).agent, legacy);
  assert.deepEqual((await (await request(external.id, "hermes")).json()).agent, external);
  assert.deepEqual(await (await request(legacy.id, "shoggoth", { method: "PUT" })).json(), { agent: legacy, method: "PUT" });
  const missing = await request("shoggoth-missing");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "missing" });
  const absentPath = path.join(agentsDir, notCreated.profile);
  assert.deepEqual((await (await request(notCreated.id)).json()).agent.managedWorkspace, { path: absentPath, exists: false });
  assert.equal(fs.existsSync(absentPath), false);
});
