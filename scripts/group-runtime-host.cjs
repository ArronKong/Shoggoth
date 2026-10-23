#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { readPrivateFile } = require("../app/agent-service/private-file");
const { GroupRuntimeHost } = require("../app/group-runtime-host");
const { createAuthResolver } = require("../app/core/device-auth");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { HermesBackend } = require("../app/core/hermes-backend");
const p = require("../app/group-runtime-host-protocol");

async function main() {
  if (process.argv[2] === "--help" && process.argv.length === 3) {
    process.stdout.write("Usage: node scripts/group-runtime-host.cjs serve|mcp /absolute/private-config.json\n"); return;
  }
  const [mode, file] = process.argv.slice(2);
  if (!["serve", "mcp"].includes(mode) || !file || !path.isAbsolute(file) || process.argv.length !== 4) {
    throw new Error("Usage: node scripts/group-runtime-host.cjs serve|mcp /absolute/private-config.json");
  }
  if (mode === "mcp") {
    const helper = require("../app/group-runtime-mcp-helper");
    await helper.serveStdio(helper.loadRuntimeConnection(file)); return;
  }
  const config = JSON.parse(readPrivateFile(file, { maxBytes: 16 * 1024 }).toString("utf8"));
  if (!p.exact(config, ["version", "stateDir", "agent", "ownerToken", "runtimeToken", "connection", "listen", "tls"])
    || config.version !== 1 || !path.isAbsolute(config.stateDir) || !p.exact(config.agent, ["backendId", "agentId"])
    || !p.exact(config.connection, ["url", "token", "profile"]) || !p.exact(config.listen, ["host", "port"])
    || !Number.isSafeInteger(config.listen.port) || config.listen.port < 1 || config.listen.port > 65535) p.fail("GROUP_HOST_CONFIG_INVALID");
  const endpoint = new URL(config.connection.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) p.fail("GROUP_HOST_CONFIG_INVALID");
  let backend;
  if (config.agent.backendId === "openclaw") {
    if (!["ws:", "wss:"].includes(endpoint.protocol)) p.fail("GROUP_HOST_CONFIG_INVALID");
    backend = new OpenClawBackend({ getUpstreamUrl: () => config.connection.url,
      authResolver: createAuthResolver({ getConfig: () => ({ gatewayUrl: config.connection.url, token: config.connection.token }),
        credentialsDir: path.join(config.stateDir, "device-auth") }) });
  } else if (config.agent.backendId === "hermes") {
    if (!["http:", "https:"].includes(endpoint.protocol) || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(config.connection.profile)) p.fail("GROUP_HOST_CONFIG_INVALID");
    backend = new HermesBackend({ getConfig: () => ({ hermesMode: "remote", hermesRemotes: [{ profile: config.connection.profile,
      baseUrl: config.connection.url, token: config.connection.token }] }) });
  } else p.fail("GROUP_HOST_CONFIG_INVALID");
  if (!await require("../app/group-local-runtime-proof").verifyLocalGroupRuntime({ backendId: config.agent.backendId, url: config.connection.url })) {
    p.fail("GROUP_HOST_FILESYSTEM_UNVERIFIED");
  }
  await backend.start();
  await backend.getAgent(config.agent.agentId); // The helper can serve only this already configured member.
  let tls = null;
  if (config.tls !== null) {
    if (!p.exact(config.tls, ["keyFile", "certFile"])) p.fail("GROUP_HOST_CONFIG_INVALID");
    tls = { key: readPrivateFile(config.tls.keyFile, { maxBytes: 64 * 1024 }), cert: readPrivateFile(config.tls.certFile, { maxBytes: 64 * 1024 }) };
  }
  const registry = { getBackend: id => id === backend.id ? backend : null };
  const host = new GroupRuntimeHost({ paths: { stateDir: config.stateDir, trustedRoot: config.stateDir }, registry,
    agent: config.agent, ownerToken: config.ownerToken, runtimeToken: config.runtimeToken, tls }).open();
  const address = await host.listen(config.listen);
  process.stderr.write(`Group execution host ${address.hostId} listening on ${config.listen.host}:${address.port}\n`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await host.close(); await backend.stop(); };
  process.once("SIGTERM", () => { void close(); }); process.once("SIGINT", () => { void close(); });
}
if (require.main === module) main().catch(error => { process.stderr.write(`${/^GROUP_HOST_[A-Z_]+$/u.test(error?.code ?? "") ? error.code : "Group host startup failed"}\n`); process.exitCode = 1; });
module.exports = { main };
