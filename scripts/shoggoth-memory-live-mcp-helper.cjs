"use strict";

// Only used by the disposable real-Runtime memory acceptance worker.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { startShoggothMcpHelper } = require("../app/shoggoth-mcp-helper");
const { Transform } = require("node:stream");

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
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
  cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
const observe = (direction) => {
  let pending = "";
  return new Transform({ transform(chunk, encoding, done) {
    pending += chunk.toString("utf8");
    for (let end; (end = pending.indexOf("\n")) >= 0;) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const message = JSON.parse(line);
        const entry = { direction, method: message.method ?? "response" };
        if (message.method === "initialize") entry.capabilities = Object.keys(message.params?.capabilities ?? {});
        if (message.result?.action) entry.action = message.result.action;
        if (message.error?.code) entry.errorCode = message.error.code;
        fs.appendFileSync(path.join(root, "mcp-fixture-io.jsonl"),JSON.stringify(entry)+"\n",{mode:0o600});
      } catch {}
    }
    if (pending.length>1024*1024) pending="";
    done(null,chunk);
  } });
};
const input = observe("client"), output = observe("helper");
process.stdin.pipe(input); output.pipe(process.stdout);
startShoggothMcpHelper({ paths, safeStorage,
  input, output,
  electronApp: { whenReady: async () => {}, quit() {} },
  serviceVersion: "isolated-memory-live-acceptance" }).catch((error) => {
  const code = /^MCP_HELPER_[A-Z0-9_]+$/u.test(error?.code || "")
    ? error.code : "MCP_HELPER_FAILED";
  try { fs.appendFileSync(path.join(root, "mcp-helper-errors.jsonl"), `${JSON.stringify({ code })}\n`,
    { mode: 0o600 }); } catch {}
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}).finally(() => key.fill(0));
