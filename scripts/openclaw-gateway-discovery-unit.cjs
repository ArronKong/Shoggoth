"use strict";

// No installed CLI or user gateway: every process, config, credential and
// listening port belongs to this fixture. Fixed-port migration uses stubs.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { createConfigStore, DEFAULT_GATEWAY_URL, LEGACY_GATEWAY_URL } = require("../app/core/config-store");
const { detectOpenclawHost } = require("../app/openclaw-host");
const { createOpenclawGatewayDiscovery } = require("../app/openclaw-gateway-discovery");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { createAuthResolver, DEFAULT_OPERATOR_SCOPES } = require("../app/core/device-auth");
const { startStaticServer } = require("../app/static-server");

function fixture(t, seed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createConfigStore(path.join(root, "app.json"));
  if (seed) fs.writeFileSync(store.path, JSON.stringify(seed), { mode: 0o600 });
  else store.ensure();
  return { root, store };
}
async function listen(t, server = net.createServer(socket => socket.end())) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `ws://127.0.0.1:${server.address().port}`;
}
function cliFixture(root, { output = "", config = {}, exit = 0 } = {}) {
  const configPath = path.join(root, "openclaw.json"), binPath = path.join(root, "openclaw");
  const log = path.join(root, "cli-commands.jsonl");
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(binPath, `#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,configPath:process.env.OPENCLAW_CONFIG_PATH})+'\\n');
if(args.includes('--version')) console.log('OpenClaw 2026.10.7');
else { console.log(${JSON.stringify(typeof output === "string" ? output : JSON.stringify(output))}); process.exitCode=${exit}; }
`, { mode: 0o700 });
  return { paths: { configPath, binPath, identityPath: path.join(root, "no-identity") }, log };
}
const discovered = (url = DEFAULT_GATEWAY_URL, extra = {}) => ({ gatewayRunning: false,
  localGatewayUrl: url, localGatewayRunning: true, ...extra });

test("new installs use the official fallback; only untouched legacy defaults migrate", t => {
  const { store } = fixture(t);
  assert.equal(store.read().gatewayUrl, "ws://127.0.0.1:18789");
  assert.equal(store.read().token, "");
  assert.equal(store.read().gatewayAutoDiscover, true);
  store.write({ theme: "dark" });
  assert.equal(store.read().gatewayAutoDiscover, true);
  store.write({ gatewayUrl: DEFAULT_GATEWAY_URL, gatewayAutoDiscover: true });
  assert.equal(store.read().gatewayAutoDiscover, false, "an explicit URL save wins even for the default port");
  store.write({ gatewayAutoDiscover: true });
  assert.equal(store.read().gatewayAutoDiscover, false, "ordinary patches cannot re-enable host discovery");
});

test("structured status discovers a running wrapper gateway despite unknown service runtime", async t => {
  const { root } = fixture(t), url = await listen(t);
  const cli = cliFixture(root, { output: { gateway: { probeUrl: url }, service: { runtime: { status: "unknown" } } },
    config: { gateway: { port: 1, auth: { token: "fixture-token-do-not-expose" } } } });
  const host = await detectOpenclawHost({ gatewayUrl: "ws://127.0.0.1:1", paths: cli.paths });
  assert.equal(host.gatewayRunning, false);
  assert.equal(host.localGatewayUrl, url);
  assert.equal(host.localGatewayRunning, true);
  assert.equal(host.version, "2026.10.7");
  assert.equal(host.localTokenReadable, true);
  assert.doesNotMatch(JSON.stringify(host), /fixture-token-do-not-expose/);
  const commands = fs.readFileSync(cli.log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(commands.length, 2);
  const status = commands.find(row => row.args.includes("status"));
  assert.deepEqual(status.args, ["--no-color", "gateway", "status", "--no-probe", "--json"]);
  assert.equal(status.configPath, cli.paths.configPath);
  assert.deepEqual(await detectOpenclawHost({ gatewayUrl: "ws://127.0.0.1:1", paths: cli.paths }), host);
  assert.equal(fs.readFileSync(cli.log, "utf8").trim().split("\n").length, 2, "cached without extra CLI calls");
});

test("legacy text and CLI failure fall back to an actual configured listening port", async t => {
  for (const kind of ["text", "failure", "stale-service"]) {
    const { root } = fixture(t), url = await listen(t);
    const cli = cliFixture(root, { output: kind === "text" ? `\x1b[32mProbe target:\x1b[0m ${url}\nRuntime: unknown`
      : kind === "failure" ? "wrapper could not inspect LaunchAgent" : { gateway: { probeUrl: "ws://127.0.0.1:1" } },
    exit: kind === "failure" ? 1 : 0, config: { gateway: { port: Number(new URL(url).port) } } });
    const host = await detectOpenclawHost({ gatewayUrl: "invalid", paths: cli.paths });
    assert.equal(host.gatewayRunning, false);
    assert.equal(host.localGatewayUrl, url, kind);
    assert.equal(host.localGatewayRunning, true, kind);
  }
});

test("service runtime running without a listener is not a running gateway", async t => {
  const { root } = fixture(t);
  const cli = cliFixture(root, { output: { gateway: { probeUrl: "ws://127.0.0.1:1" },
    service: { runtime: { status: "running" } } }, config: { gateway: { port: 1 } } });
  const host = await detectOpenclawHost({ gatewayUrl: "ws://127.0.0.1:1", paths: cli.paths });
  assert.equal(host.localGatewayRunning, false);
});

test("untrusted status URLs are not adopted or exposed; remote config is not a local candidate", async t => {
  for (const url of ["wss://remote.invalid:18789", "ws://secret@localhost:18789", "ws://localhost:18789?token=secret",
    "http://localhost:18789", "ws://localhost:18789/path"]) {
    const { root } = fixture(t), cli = cliFixture(root, { output: { gateway: { probeUrl: url } },
      config: { gateway: { mode: "remote", port: 18789 } } });
    const host = await detectOpenclawHost({ gatewayUrl: "", paths: cli.paths });
    assert.equal(host.localGatewayUrl, null);
    assert.equal(host.localGatewayRunning, false);
  }
});

test("an existing install with the old 18792 default migrates after onboarding", async t => {
  const { store } = fixture(t, { gatewayUrl: LEGACY_GATEWAY_URL, token: "", setupCompletedAt: 1234, theme: "dark" });
  let applied = 0;
  const refresh = createOpenclawGatewayDiscovery({ configStore: store, detect: async () => discovered(),
    onConfigChanged: async cfg => { applied++; assert.equal(cfg.gatewayUrl, DEFAULT_GATEWAY_URL); } });
  assert.equal(await refresh(), true);
  assert.equal(applied, 1);
  assert.equal(store.read().gatewayUrl, DEFAULT_GATEWAY_URL);
  assert.equal(store.read().gatewayAutoDiscover, true);
  assert.equal(store.read().setupCompletedAt, 1234);
  assert.equal(store.read().theme, "dark");
  assert.equal(await refresh(), false);
});

test("manual, remote, token-bearing, disabled and managed connections are preserved", async t => {
  for (const patch of [{ gatewayAutoDiscover: false }, { gatewayUrl: "ws://127.0.0.1:25555" },
    { gatewayUrl: "wss://remote.invalid" }, { token: "manual-token" }, { disabledBackends: ["openclaw"] },
    { openclawPluginHostMode: "managed" }]) {
    const { store } = fixture(t, { gatewayUrl: LEGACY_GATEWAY_URL, token: "", ...patch });
    const before = fs.readFileSync(store.path, "utf8");
    const refresh = createOpenclawGatewayDiscovery({ configStore: store, detect: () => { throw Error("must not probe"); } });
    assert.equal(await refresh(), false);
    assert.equal(fs.readFileSync(store.path, "utf8"), before);
  }
});

test("working endpoints, unreachable candidates and corrupt config are never rewritten", async t => {
  for (const host of [discovered(DEFAULT_GATEWAY_URL, { gatewayRunning: true }),
    discovered(DEFAULT_GATEWAY_URL, { localGatewayRunning: false }), discovered("wss://remote.invalid")]) {
    const { store } = fixture(t, { gatewayUrl: LEGACY_GATEWAY_URL });
    const refresh = createOpenclawGatewayDiscovery({ configStore: store, detect: async () => host });
    assert.equal(await refresh(), false);
    assert.equal(store.read().gatewayUrl, LEGACY_GATEWAY_URL);
  }
  const { store } = fixture(t);
  fs.writeFileSync(store.path, "{broken");
  assert.equal(await createOpenclawGatewayDiscovery({ configStore: store,
    detect: () => { throw Error("must not probe"); } })(), false);
  assert.equal(fs.readFileSync(store.path, "utf8"), "{broken");
});

test("concurrent polls share discovery and an intervening user edit wins", async t => {
  const { store } = fixture(t);
  let release, calls = 0;
  const refresh = createOpenclawGatewayDiscovery({ configStore: store,
    detect: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const first = refresh(), second = refresh();
  assert.equal(first, second);
  store.write({ gatewayUrl: "ws://127.0.0.1:23456" });
  release(discovered("ws://127.0.0.1:34567"));
  assert.equal(await first, false);
  assert.equal(calls, 1);
  assert.equal(store.read().gatewayUrl, "ws://127.0.0.1:23456");
});

test("production REST + Backend authenticate against the discovered user gateway after setup", async t => {
  const { root, store } = fixture(t, { gatewayUrl: "ws://127.0.0.1:1", gatewayAutoDiscover: true,
    setupCompletedAt: 1234, token: "" });
  const gateway = http.createServer(), wss = new WebSocketServer({ server: gateway });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${gateway.address().port}`, methods = [];
  const cli = cliFixture(root, { output: { gateway: { probeUrl: url }, service: { runtime: { status: "unknown" } } },
    config: { gateway: { port: Number(new URL(url).port), auth: { token: "isolated-gateway-token" } } } });
  wss.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "discovery-test" } }));
    socket.on("message", raw => {
      const frame = JSON.parse(raw); methods.push(frame.method);
      let payload = {};
      if (frame.method === "connect") {
        assert.equal(frame.params.auth.token, "isolated-gateway-token");
        payload = { type: "hello-ok", protocol: 3, server: { version: "2026.10.7" },
          features: { methods: ["agents.list", "cron.status"], events: [] },
          auth: { role: "operator", scopes: DEFAULT_OPERATOR_SCOPES },
          policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 1024 * 1024 } };
      } else if (frame.method === "agents.list") payload = { agents: [{ id: "main", name: "User's OpenClaw" }] };
      else if (frame.method === "cron.status") payload = { jobs: 0 };
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  const backend = new OpenClawBackend({ getUpstreamUrl: () => store.read().gatewayUrl,
    authResolver: createAuthResolver({ getConfig: () => store.read(), credentialsDir: path.join(root, "credentials"),
      localGatewayConfigPath: cli.paths.configPath, operatorIdentityDir: path.join(root, "identity") }) });
  const registry = new BackendRegistry(); registry.register(backend);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const refresh = createOpenclawGatewayDiscovery({ configStore: store,
    detect: async opts => { await gate; return detectOpenclawHost({ ...opts, paths: cli.paths }); },
    onConfigChanged: () => backend.stop() });
  const server = await startStaticServer(0, { registry, configStore: store, homeDir: root, userDataRoot: root,
    refreshHostConnections: refresh });
  t.after(async () => { await server.close(); await backend.stop(); for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => gateway.close(resolve)); });
  const first = await fetch(`${server.url}/__api/status`).then(r => r.json());
  assert.equal(first.backends[0].connected, false, "status returns while discovery is pending");
  release();
  assert.equal(await refresh(), true);
  const status = await fetch(`${server.url}/__api/status`).then(r => r.json());
  assert.equal(status.backends[0].connected, true, JSON.stringify(status));
  assert.equal(status.backends[0].info.gatewayUrl, url);
  assert.equal(status.backends[0].info.agents, 1);
  assert.deepEqual(methods, ["connect", "cron.status", "agents.list"]);
  const config = await fetch(`${server.url}/__api/config`).then(r => r.json());
  assert.equal(config.config.gatewayUrl, url);
  assert.equal(config.config.token, "", "the user's token is not copied into App config");
});
