"use strict";
// Disposable source acceptance helper. Production bootstrap has a separate gate.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { startShoggothMcpHelper } = require("../../app/shoggoth-mcp-helper");
const { MCP_PRODUCT_TOOL_DEFINITIONS } = require("../../app/agent-service/mcp-product-tool-controller");
// Match the production tool's safety annotations as well as its schema.
// Without them Codex conservatively asks to approve the call before the
// helper can submit its internal binding proof.
const responseTool = MCP_PRODUCT_TOOL_DEFINITIONS.find(tool => tool.name === "proactive_respond");
if (!responseTool) throw Error("PROACTIVE_FIXTURE_TOOL_UNAVAILABLE");
const root = fs.realpathSync(process.env.HOME || "");
if (!root.startsWith("/private/tmp/sg-proactive-live-")) throw Error("PROACTIVE_FIXTURE_ROOT_INVALID");
const keyPath = path.join(root, "mcp-key.bin"), stat = fs.lstatSync(keyPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw Error("PROACTIVE_FIXTURE_KEY_INVALID");
const key = fs.readFileSync(keyPath);
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
  decryptString(bytes) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); } };
// Helper only decrypts Service-issued credentials. No local secrets are written.
startShoggothMcpHelper({ paths: resolveServicePaths({ trustedRoot: root, homeDir: root,
  stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") }),
  safeStorage, electronApp: { whenReady: async () => {}, quit() {} },
  toolDefinitions: [responseTool], serviceVersion: "proactive-source-acceptance" }).catch(error => {
  process.stderr.write((/^MCP_HELPER_[A-Z0-9_]+$/.test(error.code) ? error.code : "MCP_HELPER_FAILED") + "\n"); process.exitCode = 1;
}).finally(() => key.fill(0));
