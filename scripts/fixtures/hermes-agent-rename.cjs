"use strict";

// Real Shoggoth HTTP/backend, with only the upstream Hermes dashboard simulated.
// No user profile, CLI, model provider or installed App is accessed.
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { HermesBackend } = require("../../app/core/hermes-backend");
const { BackendRegistry } = require("../../app/core/backend-registry");
const { startStaticServer } = require("../../app/static-server");

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-agent-rename-"));
  const profiles = [{ name: "default" }, { name: "writer" }];
  const writes = [];
  const state = { rejectRename: false, omitReceiptName: false, notifications: 0, startedProfiles: [] };
  const upstream = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, "http://127.0.0.1");
      let status = 200, data;
      if (url.pathname === "/api/profiles" && req.method === "GET") data = { profiles };
      else if (url.pathname.startsWith("/api/profiles/") && req.method === "PATCH") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        const profile = profiles.find(row => row.name === decodeURIComponent(url.pathname.split("/").pop()));
        writes.push({ profile: profile?.name, body });
        if (state.rejectRename || !profile) {
          status = 400; data = { detail: "Profile rename rejected" };
        } else {
          const name = body.new_name.trim();
          // Matches Hermes ProfileRename: default changes only display_name;
          // named profiles change their canonical lowercase directory name.
          if (profile.name === "default") profile.display_name = name;
          else profile.name = name.toLowerCase();
          data = { ok: true, name: profile.name, display_name: profile.display_name };
          if (state.omitReceiptName) delete data.name;
        }
      } else if (url.pathname === "/api/status") data = { version: "0.0.0-fixture" };
      else if (url.pathname === "/api/model/info") data = { model: "fixture-model", provider: "fixture" };
      else if (url.pathname === "/api/sessions") data = { sessions: [] };
      else { status = 404; data = { detail: "Unknown fixture route" }; }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    })().catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const backend = new HermesBackend({ getConfig: () => ({ hermesMode: "local" }) });
  backend._hermesHomeForProfile = profile => path.join(root, "profiles", profile);
  for (const profile of profiles) {
    backend.dashboards.set(profile.name, { profile: profile.name, baseUrl, token: "fixture", spawned: false });
  }
  backend._startHooks = { onPartialReady() { state.notifications++; } };
  // Rebinding a renamed profile uses the same loopback fixture, never a CLI.
  backend._spawnOrReuseDashboard = async profile => {
    if (!profiles.some(row => row.name === profile)) throw Error("Unknown fixture profile");
    state.startedProfiles.push(profile);
    return { profile, baseUrl, token: "fixture", spawned: false };
  };
  await backend._refreshAgentsFor(backend._defaultDash());
  const registry = new BackendRegistry();
  registry.register(backend);
  const config = { locale: "zh-CN", theme: "light", setupCompletedAt: 1, disabledBackends: [], gatewayUrl: "", token: "" };
  const server = await startStaticServer(0, { registry, homeDir: root, userDataRoot: path.join(root, "data"),
    configStore: { read: () => config } });
  return { root, profiles, writes, state, backend, registry, server,
    async request(suffix = "/hermes-default", method = "GET", body) {
      const response = await fetch(`${server.url}/__api/agents${suffix}?backend=hermes`, {
        method, headers: { "content-type": "application/json", origin: server.url },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      await server.close();
      await backend.stop();
      await new Promise(resolve => upstream.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { createFixture };
