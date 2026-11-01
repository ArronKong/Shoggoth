"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { spawn, spawnSync } = require("node:child_process");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
const { validatePayload } = require("../app/agent-service/official-skill-mcp-bridge");

// A kernel sandbox denies all network access. No real credentials, global CLI
// install, OS keychain, browser or account-authorization exchange is used.
async function runDoorDashOfflineSmoke(root, home) {
  assert.equal(process.platform, "darwin", "This explicit native smoke requires macOS sandbox-exec");
  const offlineHome = path.join(home, "offline-validation"); fs.mkdirSync(offlineHome, { mode: 0o700 });
  fs.mkdirSync(path.join(offlineHome, "tmp"), { mode: 0o700 });
  const policy = "(version 1) (allow default) (deny network*)", binary = path.join(root, "runtime", "dd-cli");
  const env = { HOME: offlineHome, TMPDIR: path.join(offlineHome, "tmp"), XDG_CONFIG_HOME: path.join(offlineHome, ".config"), XDG_CACHE_HOME: path.join(offlineHome, ".cache"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", NO_COLOR: "1", CI: "1", PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring", DD_CLI_ACCESS_TOKEN: "isolated-offline-placeholder",
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" };
  const checks = [["export-token", "--help"], ["auth", "status", "--help"], ["restaurant-item-details", "--help"], ["order", "preview", "--help"], ["order", "submit", "--help"], ["cart", "add-items", "--help"]], steps = [];
  for (const args of checks) {
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", policy, binary, "--json-output", ...args], { env, cwd: offlineHome, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `Offline ${args.join(" ")} failed: ${result.stderr}`); assert.match(result.stdout, /Usage:/u);
    if (args[1] === "preview") { assert.match(result.stdout, /--card-id/u); assert.match(result.stdout, /net_total_before_tip/u); }
    if (args[1] === "submit") { for (const flag of ["--tip-cents", "--card-id", "--yes"]) assert.ok(result.stdout.includes(flag)); }
    steps.push({ command: args.join(" "), exitCode: result.status });
  }
  const runtime = createOfficialSkillRuntime({ providerId: "doordash", root, home: offlineHome, env,
    validate: () => validatePayload("doordash", root, home), spawn: (command, args, options) => spawn("/usr/bin/sandbox-exec", ["-p", policy, command, ...args], options) });
  try {
    const authorization = await runtime.call("account_start", {}); assert.equal(authorization.state, "authorizing"); assert.equal(new URL(authorization.verificationUrl).hostname, "identity.doordash.com");
    const local = await runtime.call("account_status", {}); assert.equal(local.state, "authorizing");
    const file = path.join(offlineHome, ".config", "dd-cli", "pending-login.json"); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(offlineHome, "doordash-token.json")), false);
    assert.equal((await runtime.call("account_logout", {})).state, "signedOut"); assert.equal(fs.existsSync(file), false);
    return { nativeVersion: "0.2.6", network: "kernel-denied", keychain: "null backend", steps, localPkceStartAndLogout: true,
      tokenExchange: false, realAccountAuthorization: false, businessCalls: false };
  } finally { await runtime.close(); }
}
module.exports = { runDoorDashOfflineSmoke };
