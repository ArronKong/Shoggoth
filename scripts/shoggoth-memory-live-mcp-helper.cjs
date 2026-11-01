"use strict";

// Only used by the disposable real-Runtime memory acceptance worker.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveCanonicalServicePaths, resolveServicePaths } = require("../app/agent-service/paths");
const { startShoggothMcpHelper } = require("../app/shoggoth-mcp-helper");
const { createMcpEvidenceObserver } = require("./shoggoth-memory-live-mcp-evidence.cjs");

const root = fs.realpathSync(process.env.HOME || "");
if (!root.startsWith("/private/tmp/sgmemlive-") && !root.startsWith("/tmp/sgmemlive-")) {
  process.stderr.write("MCP_HELPER_FIXTURE_HOME_INVALID\n"); process.exit(1);
}
// Codex's MCP child does not consistently inherit CODEX_HOME. This helper
// never reads Codex auth: its private key and all service paths are confined
// to the validated disposable HOME, so that variable is not an auth gate.
const keyPath = path.join(root, "mcp-key.bin");
const stat = fs.lstatSync(keyPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32 || (stat.mode & 0o077) !== 0
  || (process.getuid && stat.uid !== process.getuid())) process.exit(1);
const key = fs.readFileSync(keyPath);
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  decryptString(bytes) {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  },
};
const config = JSON.parse(fs.readFileSync(path.join(root, "worker.json"), "utf8"));
if (config.root !== root) throw new Error("MCP_HELPER_FIXTURE_CONFIG_INVALID");
const paths = config.suite === "repair"
  ? resolveCanonicalServicePaths({ userInfo: () => ({ homedir: root }) })
  : resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
const evidencePath = path.join(root, "mcp-fixture-io.jsonl");
const record = entry => fs.appendFileSync(evidencePath, JSON.stringify(entry) + "\n", { mode: 0o600 });
const runtimeGatePresent = process.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE !== undefined;
record({ direction: "fixture", method: "transport", route: runtimeGatePresent ? "runtime-gate-relay" : "local-auth",
  runtimeGatePresent });
const observe = createMcpEvidenceObserver(record);
const input = observe("client"), output = observe("helper");
process.stdin.pipe(input); output.pipe(process.stdout);
// Match the product entry point: non-Codex runtimes authenticate an exact Run
// through a consumed gate. The fixture supplies only its isolated system home;
// production bootstrap validation, relay, and Service gate checks all execute.
Promise.resolve().then(() => runtimeGatePresent
  ? require("../app/bootstrap-role").main(process.argv.slice(1), process.env,
    { userInfo: () => ({ homedir: root }) },
    { runtimeMcpRelay: bridge => require("../app/runtime-mcp-relay").startRuntimeMcpRelay({ ...bridge, input, output }) })
  : startShoggothMcpHelper({ paths, safeStorage, input, output,
    electronApp: { whenReady: async () => {}, quit() {} },
    serviceVersion: "isolated-memory-live-acceptance" })).catch((error) => {
  const codes = [];
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (/^[A-Z][A-Z0-9_]{0,100}$/u.test(current.code || "")) codes.push(current.code);
  }
  const code = codes[0] || "MCP_HELPER_FAILED";
  try { record({ direction: "fixture", method: "startup-error", code, codes }); } catch {}
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}).finally(() => key.fill(0));
