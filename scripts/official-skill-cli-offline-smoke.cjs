"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
function runNeteaseOfflineSmoke(root, home) {
  assert.ok(root.startsWith("/private/"), "CLI smoke must not resolve modules through the repository tree");
  const helper = path.resolve(__dirname, "../app/agent-service/official-skill-cli-helper.js"), bootstrap = path.resolve(__dirname, "../app/agent-service/official-skill-child-bootstrap.js");
  const env = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: home, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1", CI: "1" }, steps = [];
  for (const [field, value] of [["appId", "fixture-offline-app"], ["privateKey", "fixture-offline-key"]]) {
    const args = ["--require", bootstrap, helper, "--root", root, "--home", home, "--field", field];
    const result = spawnSync(process.execPath, args, { env, cwd: home, input: JSON.stringify(value), encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `Official CLI config ${field} failed: ${result.stderr}`);
    assert.equal(args.includes(value), false);
    steps.push({ field, status: result.status, argvContainsCredential: false });
  }
  const help = spawnSync(process.execPath, ["--require", bootstrap, path.join(root, "runtime/dist/index.js"), "--help"], { env, cwd: home, encoding: "utf8", timeout: 30_000 });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Usage:/u);
  const file = path.join(home, ".config/ncm-cli/credentials.enc.json"), bytes = fs.readFileSync(file, "utf8"), value = JSON.parse(bytes);
  assert.deepEqual(Object.keys(value).sort(), ["data", "iv"]); assert.equal(bytes.includes("fixture-offline"), false); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  return { realCliVersion: "0.1.7", secretTransport: "stdin", steps, rootHelp: true, isolatedFromRepository: true,
    officialCredentialStorage: { relativePath: ".config/ncm-cli/credentials.enc.json", mode: "600", encryptedFields: ["iv", "data"], plaintextFixturePresent: false }, realAccountAuthorization: false, businessCalls: false };
}
module.exports = { runNeteaseOfflineSmoke };
