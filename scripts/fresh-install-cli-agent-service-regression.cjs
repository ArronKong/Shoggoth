#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID, NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { SYSTEM_CLI_DISCOVERY_METHOD, SYSTEM_CLI_RUNTIMES } = require("../app/agent-service/system-cli-discovery");
const { createRuntimeCliAuth } = require("../app/runtime-cli-auth");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

async function run() {
  // Keep the Unix socket pathname within macOS's short sun_path limit.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/shg-cli-install-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache") });
  let service;
  const start = async (installed) => {
    service = createAgentService({ paths, version: "first-install-cli-regression",
      builtinCliProfiles: true, builtinCliInstalledAccountIds: installed });
    await service.start();
    return service.productStore.listAgentProfiles();
  };
  try {
    let profiles = await start([]);
    assert.deepEqual(profiles.map(profile => profile.name), ["Shoggoth"]);
    assert.equal(profiles[0].runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
    await service.stop();

    profiles = await start([NATIVE_CODEX_RUNTIME_ACCOUNT_ID]);
    assert.deepEqual(profiles.map(profile => profile.name), ["Shoggoth", "Codex"]);
    assert.equal(profiles[1].runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
    await service.stop();

    profiles = await start([]);
    assert.deepEqual(profiles.map(profile => profile.name), ["Shoggoth", "Codex"],
      "a previously created Agent must keep its persisted identity after CLI removal");
    console.log("PASS fresh install: bundled Shoggoth works without system CLI; only installed CLI seeds a native Agent; existing profile is preserved");
  } finally {
    await service?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
  await runDiscovery();
}

async function runDiscovery() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/shg-cli-pick-"));
  const userHome = path.join(root, "home"), desktopBin = path.join(root, "desktop bin");
  const serviceBin = path.join(root, "service bin");
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const desktopBinary = path.join(desktopBin, "opencode"), serviceLink = path.join(serviceBin, "opencode");
  const executionLog = path.join(root, "spawned");
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const cliFixture = path.join(__dirname, "fixtures", "opencode-compatibility-server.cjs");
  const writeCli = (target) => {
    fs.writeFileSync(target, [
      "#!/bin/sh",
      `printf '%s %s\\n' "$0" "$1" >> ${shellQuote(executionLog)}`,
      `exec ${shellQuote(process.execPath)} ${shellQuote(cliFixture)} discovery 1.18.32 "$@"`,
    ].join("\n") + "\n", { mode: 0o755 });
    return target;
  };
  let service, backend;
  try {
    for (const directory of [userHome, desktopBin, serviceBin]) fs.mkdirSync(directory, { mode: 0o700 });
    writeCli(desktopBinary);
    const original = writeCli(path.join(root, "service-opencode"));
    const replacement = writeCli(path.join(root, "upgraded-opencode"));
    fs.symlinkSync(original, serviceLink);
    const parentEnvironment = directory => ({ PATH: [directory, "/usr/bin", "/bin"].join(path.delimiter) });
    service = createAgentService({
      paths, version: "native-cli-discovery-regression", builtinCliProfiles: true,
      builtinCliInstalledAccountIds: [NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID],
      parentEnv: parentEnvironment(serviceBin), runtimeStorageHomedir: userHome,
    });
    await service.start();
    const account = row => row.runtimeAccountId === NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID;
    const desktopAuth = () => createRuntimeCliAuth({ paths, parentEnv: parentEnvironment(desktopBin), homedir: userHome });
    assert.equal(desktopAuth().find(account).binaryPath, desktopBinary);
    const discover = (params, token = readClientToken(paths)) => requestService(paths,
      { token, version: PROTOCOL_VERSION, method: SYSTEM_CLI_DISCOVERY_METHOD, params });
    await assert.rejects(discover({}, "unauthorized"), { code: "AUTH_FAILED" });
    await assert.rejects(discover({ path: desktopBinary }), { code: "INVALID_PARAMS" });
    const inventory = await discover({});
    assert.equal(inventory.rows.find(account).binaryPath, original);
    assert.equal(inventory.rows.find(account).binaryCandidatePath, serviceLink);
    assert.ok(!fs.existsSync(executionLog), "discovery must never execute the discovered program");

    const requests = [];
    let legacyService = false;
    backend = new ShoggothBackend({
      paths, getRuntimeCliAuth: desktopAuth,
      async requestService(paths, request, options) {
        requests.push(request.method);
        const result = await requestService(paths, request, options);
        if (legacyService && request.method === "service.status") delete result.nativeCliDiscovery;
        return result;
      },
    });
    backend.setDisabledBackendsProvider(() => [...SYSTEM_CLI_RUNTIMES.filter(runtime => runtime !== "opencode"), "antigravity"]);
    assert.equal(await backend.start(), true);
    const status = (rows) => rows.find(account);
    const selected = async () => status(await backend.getRuntimeCliLocations());
    const full = status(await backend.getRuntimeStatuses());
    assert.equal(full.installation, "available");
    assert.equal(full.readiness, "auth-required");
    assert.ok(!JSON.stringify(full).includes(root), "runtime status does not serialize CLI paths");
    assert.deepEqual(await selected(), {
      runtimeAccountId: NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID, path: original, source: "path", confirmed: true,
    });
    const provider = (await backend.listOAuthProviders()).providers.find(row => row.id === NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID);
    assert.ok(provider.cliCommand.includes(shellQuote(original)));
    assert.ok(!provider.cliCommand.includes(desktopBinary));
    let observed = fs.readFileSync(executionLog, "utf8").trim().split("\n");
    assert.ok(observed.includes(`${original} --version`) && observed.includes(`${original} serve`));
    assert.ok(!observed.some(row => row.startsWith(desktopBinary)));

    assert.equal(backend._runtimeReadinessFor(NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID), "auth-required");
    fs.unlinkSync(serviceLink);
    fs.symlinkSync(replacement, serviceLink);
    const countBeforeCreateView = requests.filter(method => method === SYSTEM_CLI_DISCOVERY_METHOD).length;
    assert.equal(status(await backend.getRuntimeStatuses({ forAgentCreation: true })).readiness, "unverified");
    assert.equal(requests.filter(method => method === SYSTEM_CLI_DISCOVERY_METHOD).length, countBeforeCreateView);
    assert.equal(status(await backend.getRuntimeStatuses()).readiness, "auth-required");
    assert.equal((await selected()).path, replacement);
    observed = fs.readFileSync(executionLog, "utf8").trim().split("\n");
    assert.ok(observed.includes(`${replacement} serve`), "new readiness probe must launch the upgraded file");

    const countBeforeLegacy = requests.filter(method => method === SYSTEM_CLI_DISCOVERY_METHOD).length;
    legacyService = true;
    assert.equal(status(await backend.getRuntimeStatuses()).installation, "available");
    assert.equal((await selected()).path, desktopBinary);
    assert.equal((await selected()).confirmed, false);
    assert.equal(requests.filter(method => method === SYSTEM_CLI_DISCOVERY_METHOD).length, countBeforeLegacy);
    console.log("PASS auto discovery: desktop and Service PATH differ; status, login entry and actual OpenCode launch agree; upgrade invalidates proof; old Service stays usable");
  } finally {
    await backend?.stop().catch(() => {});
    await service?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
