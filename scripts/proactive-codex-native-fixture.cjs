#!/usr/bin/env node
"use strict";
// Real app-server metadata verification in empty temporary homes. No login,
// model turn, user data or ambient Service is accessed by this fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { spawn } = require("node:child_process");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { resolveServicePaths } = require("../app/agent-service/paths");
const root = fs.mkdtempSync("/private/tmp/sg-proactive-native-");
const home = path.join(root, "home"), work = path.join(root, "workspace");
fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(work, { mode: 0o700 });
fs.mkdirSync(path.join(home, ".codex"), { mode: 0o700 });
const repoRoot = path.resolve(__dirname, "..");
const output = path.join(repoRoot, ".artifacts/proactive-reminders/native-runtime.json");
const paths = resolveServicePaths({ trustedRoot: root, homeDir: home, userDataRoot: path.join(root, "app"), cacheRoot: path.join(root, "cache") });
const parentEnv = { HOME: home, PATH: "/opt/homebrew/bin:/usr/bin:/bin", TMPDIR: root };
async function main() {
  const results = [];
  for (const [kind, runtimeAccountId] of [["bundled", "shoggoth-internal-codex-default-v1"], ["system", "native-codex-default-v1"]]) {
    const diagnostics = [], startupErrors = [], stderr = [], exits = [];
    const pool = new CodexRuntimePool({ repoRoot: process.env.SHOGGOTH_FIXTURE_RUNTIME_ROOT || repoRoot, paths, homedir: home, parentEnv, hostOptions: { cwd: work, requestTimeoutMs: 10_000,
      onDiagnostic: item => diagnostics.push(item.code) }, hostFactory: options => {
        const host = new CodexRuntimeHost({ ...options, spawnProcess(command, args, settings) {
          const child = spawn(command, args, settings);
          child.stderr.on('data', data => { if (stderr.join('').length < 3000) stderr.push(data.toString()); });
          child.once('exit', (code, signal) => exits.push({ code, signal }));
          return child;
        } }), initialize = host.initialize.bind(host);
        const fatal = host._markFatal.bind(host);
        host._markFatal = async error => { startupErrors.push({ phase: "original", code: error.code, message: String(error.message).slice(0, 300) }); return fatal(error); };
        host.initialize = async () => { try { return await initialize(); } catch (error) {
          const compact = value => ({ code: value?.code, message: String(value?.message || '').slice(0, 200),
            causeCode: value?.cause?.code, errors: value?.errors?.map(child => ({ code: child.code, message: String(child.message).slice(0, 200) })) });
          startupErrors.push(compact(error)); throw error;
        } }; return host;
      } });
    let handle, started;
    try {
      const adapter = new CodexRuntimeAdapter({ runtimePool: pool });
      handle = await adapter.acquire({ runtime: "codex", runtimeProfileId: `review-${kind}`, runtimeAccountId });
      const start = handle.host.threadStart.bind(handle.host);
      handle.host.threadStart = async (...args) => { started = await start(...args); return started; };
      assert.equal((await handle.accountRead({ refreshToken: false })).account, null);
      // This empty-home fixture has no product MCP helper. It proves sandbox
      // metadata only; production verification additionally requires the tool.
      const proof = await handle.verifyProactiveReview({ requireResponseTool: false });
      const features = await handle._proactiveFeatures(proof.sessionId, { allowDottedNames: true });
      results.push({ kind, runtimeVersion: handle.host.runtimeVersion, verified: proof.verified,
        sandbox: "read-only", networkAccess: false, approvalPolicy: "on-request", responseToolVerified: false,
        featureCount: features.length, enabledFeatures: features.filter(feature => feature.enabled).map(feature => feature.name) });
    } catch (error) {
      const features = started ? await handle._proactiveFeatures(started.thread.id, { allowDottedNames: true }).catch(() => null) : null;
      results.push({ kind, verified: false, code: error.code, causeCode: error.cause?.code, causeMessage: String(error.cause?.message || '').slice(0, 250), message: String(error.message).slice(0, 300),
        sandbox: started?.sandbox, approvalPolicy: started?.approvalPolicy, enabledFeatures: features?.filter(feature => feature.enabled).map(feature => feature.name), diagnostics, startupErrors, stderr: stderr.join('').slice(0, 3000), exits });
    } finally { await pool.stopAll(); }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), modelTurnExecuted: false, authenticated: false, results }, null, 2));
  fs.rmSync(root, { recursive: true });
  console.log(JSON.stringify({ results, output }));
  assert.equal(results.find(result => result.kind === 'bundled').verified, true);
  const native = results.find(result => result.kind === 'system');
  if (!native.verified) {
    assert.equal(native.code, 'PROACTIVE_RUNTIME_UNVERIFIED');
    assert.ok(native.enabledFeatures.includes('unified_exec'), 'Unsupported native features must fail closed');
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
