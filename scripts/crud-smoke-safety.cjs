"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createAuthResolver, loadOperatorAuth } = require("../app/core/device-auth");

// Match the installed UI's existing endpoint and identity while keeping any
// device-token refresh strictly inside the caller's owned temporary directory.
function openClawReadOnlyOptions({ configPath, credentialsDir, scratchDirectory, operatorIdentityDir, localGatewayConfigPath, origin = "http://127.0.0.1:18799" }) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const gatewayUrl = config.gatewayUrl;
  const endpoint = new URL(gatewayUrl);
  if (!["ws:", "wss:"].includes(endpoint.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw Object.assign(new Error("LIVE_READ_ONLY requires the configured local Gateway"), { code: "SMOKE_LIVE_GATEWAY_UNSUPPORTED" });
  }
  const isolatedCredentials = path.join(scratchDirectory, "openclaw-credentials");
  fs.mkdirSync(isolatedCredentials, { mode: 0o700 });
  const identities = new Set();
  const source = path.join(credentialsDir, "device-credentials.json");
  if (fs.existsSync(source)) {
    const bytes = fs.readFileSync(source);
    identities.add(JSON.parse(bytes).identity?.deviceId);
    fs.writeFileSync(path.join(isolatedCredentials, "device-credentials.json"), bytes, { mode: 0o600, flag: "wx" });
  }
  const operator = loadOperatorAuth(operatorIdentityDir);
  if (operator) identities.add(operator.deviceId);
  const resolver = createAuthResolver({
    getConfig: () => ({ gatewayUrl, token: config.token }), credentialsDir: isolatedCredentials,
    operatorIdentityDir, localGatewayConfigPath,
  });
  const requireExistingIdentity = (auth) => {
    if (!auth || !auth.deviceId || !identities.has(auth.deviceId)) {
      throw Object.assign(new Error("LIVE_READ_ONLY requires an existing valid device identity; no new device was connected"), { code: "SMOKE_LIVE_IDENTITY_UNAVAILABLE" });
    }
    return auth;
  };
  return {
    getUpstreamUrl: () => gatewayUrl,
    getOrigin: () => origin,
    authResolver: {
      ...resolver,
      resolveConnectAuth(url) {
        return requireExistingIdentity(resolver.resolveConnectAuth(url));
      },
      async resolveConnectAuthAsync(url) {
        return requireExistingIdentity(await resolver.resolveConnectAuthAsync(url));
      },
    },
  };
}

// This guard runs before http.request. Only scratch-config/model-fixture writes
// and exact local validation probes are allowed; real business data is read-only.
function assertSafeSmokeRequest(method, url, body, { modelFixture = false } = {}) {
  const u = new URL(url);
  if (["GET", "HEAD"].includes(method)) return;
  if (method === "PUT" && u.pathname === "/__api/config") return;
  if (modelFixture && /^\/__api\/models\/config(?:\/|$)/.test(u.pathname)) return;
  const localGuards = new Set([
    "POST /__api/chat/capabilities", "PUT /__api/host/openclaw",
    "PUT /__api/discovery/openclaw", "POST /__api/host/terminal",
    "POST /__api/dashboard", "POST /__api/dashboard/activities", "POST /__api/dashboard/preview",
  ]);
  if (localGuards.has(`${method} ${u.pathname}`)) return;
  if (method === "POST" && u.pathname === "/__api/updates/run"
    && [null, "nope"].includes(u.searchParams.get("backend"))) return;
  if (method === "DELETE" && u.pathname === "/__api/approval-grants" && !u.searchParams.has("id")) return;
  if (method === "POST" && ["/__api/host/open-path", "/__api/host/reveal-path"].includes(u.pathname)
    && body && Object.keys(body).length === 0) return;
  throw Object.assign(new Error(`LIVE_READ_ONLY rejected ${method} ${u.pathname}`), { code: "SMOKE_LIVE_WRITE_FORBIDDEN" });
}

// Existing dashboards may be observed. Never start/restart one: startup can
// reconcile state.db, recover hosted rooms and start auto-archive/Cron workers.
function guardHermesReadOnlyLifecycle(backend) {
  const blocked = [];
  for (const method of ["start", "_startImpl", "reconfigure", "_spawnOrReuseDashboard", "_spawnDashboard", "_reapStaleDashboard"]) {
    backend[method] = async (target) => {
      blocked.push(method);
      throw Object.assign(new Error(`LIVE_READ_ONLY cannot ${method} (${target})`), { code: "SMOKE_LIVE_START_UNSAFE" });
    };
  }
  return () => {
    if (blocked.length) throw Object.assign(new Error(
      `LIVE_READ_ONLY unavailable: Hermes would start/restart dashboards (${blocked.length} attempts); no processes changed`,
    ), { code: "SMOKE_LIVE_START_UNSAFE" });
  };
}

async function attachExistingHermesReadOnly(backend, { home, get, portCount = 32 }) {
  const expected = new Map([["default", home]]);
  const profilesDirectory = path.join(home, "profiles");
  if (fs.existsSync(profilesDirectory)) {
    for (const entry of fs.readdirSync(profilesDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) expected.set(entry.name, path.join(profilesDirectory, entry.name));
    }
  }
  const normalize = (value) => {
    try { return fs.realpathSync(value); } catch { return path.resolve(value); }
  };
  // Explicit GET-only attachment. No Backend.start(), CLI version probe,
  // process reconciliation, dashboard creation or periodic refresh timer.
  for (let port = backend.startPort; port < backend.startPort + portCount && backend.dashboards.size < expected.size; port++) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const page = await get(`${baseUrl}/`, { timeoutMs: 1000 }).catch(() => null);
    const token = page?.status === 200 ? /__HERMES_SESSION_TOKEN__\s*=\s*["']([^"']+)["']/.exec(page.body)?.[1] : null;
    if (!token) continue;
    const response = await get(`${baseUrl}/api/status`, { token, timeoutMs: 1000 }).catch(() => null);
    let identity;
    try { identity = response?.status === 200 ? JSON.parse(response.body) : null; } catch { continue; }
    if (typeof identity?.hermes_home !== "string" || !identity.hermes_home) continue;
    const match = [...expected].find(([, directory]) => normalize(directory) === normalize(identity.hermes_home));
    if (!match || backend.dashboards.has(match[0])) continue;
    backend.dashboards.set(match[0], { profile: match[0], port, baseUrl, token, proc: null, spawned: false });
  }
  if (!backend.dashboards.has("default")) {
    throw Object.assign(new Error("LIVE_READ_ONLY requires an already-running, identity-verified default Hermes dashboard; none was started"), { code: "SMOKE_LIVE_BACKEND_UNAVAILABLE" });
  }
  await backend._refreshAgentsFor(backend.dashboards.get("default"));
  const missing = [...backend.profileById.values()].filter((profile) => !backend.dashboards.has(profile));
  if (missing.length || !backend.profileById.size) {
    throw Object.assign(new Error(`LIVE_READ_ONLY incomplete Hermes dashboards: ${missing.length} profiles unavailable`), { code: "SMOKE_LIVE_BACKEND_UNAVAILABLE" });
  }
  await Promise.all([backend.refreshSessions(), backend.refreshModelChoices()]);
  backend._sessionRowsComplete = true;
}

async function withMediaFixture(parent, operation) {
  // The parent must already exist. Own only this exclusive temporary directory;
  // a prior smoke's files or the user's workspace must never be overwritten.
  const directory = fs.mkdtempSync(path.join(parent, ".shoggoth-media-smoke-"));
  try {
    const png = path.join(directory, "probe.png");
    const text = path.join(directory, "probe.txt");
    fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"), { flag: "wx" });
    fs.writeFileSync(text, "not an image", { flag: "wx" });
    return await operation({ png, text });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { assertSafeSmokeRequest, guardHermesReadOnlyLifecycle, attachExistingHermesReadOnly, withMediaFixture, openClawReadOnlyOptions };
