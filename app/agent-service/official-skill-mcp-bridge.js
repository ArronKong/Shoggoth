"use strict";

// The only application entry point allowed to execute managed official CLIs.
// Runtime files are checked before every operation; tool arguments never select
// an executable, an API endpoint, a working directory, or environment variables.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { assertPrivateDirectory } = require("./security");
const { readPrivateFile } = require("./private-file");
const { getOfficialSkillProvider } = require("./official-skill-providers");
const { officialSkillPublicError } = require("../core/official-skill-connector-dto");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const failure = (code = "OFFICIAL_SKILL_AUTH_FAILED") => Object.assign(new Error(code), { code });
const safeRelative = value => typeof value === "string" && value.length < 1024 && !/[\\\0]/u.test(value)
  && !path.isAbsolute(value) && value.split("/").every(part => part && part !== "." && part !== "..") && value.split("/")[0] !== "home";

function validatePayload(providerId, root, home) {
  // Missing/malformed manifests and private-file guards are component failures.
  // Do not expose filesystem paths or turn them into account rejection errors.
  try { return readValidatedPayload(providerId, root, home); }
  catch { throw failure("OFFICIAL_SKILL_INTEGRITY_FAILED"); }
}
function readValidatedPayload(providerId, root, home) {
  if (!getOfficialSkillProvider(providerId) || !path.isAbsolute(root) || path.dirname(root).split(path.sep).at(-1) !== providerId
    || path.dirname(path.dirname(root)).split(path.sep).at(-1) !== "official-skills" || home !== path.join(root, "home")
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(path.basename(root))) throw failure("OFFICIAL_SKILL_INTEGRITY_FAILED");
  for (const directory of [root, home, path.dirname(root), path.dirname(path.dirname(root)), path.dirname(path.dirname(path.dirname(root))), path.dirname(path.dirname(path.dirname(path.dirname(root))))]) assertPrivateDirectory(directory);
  const manifest = JSON.parse(readPrivateFile(path.join(root, "payload-manifest.json"), { maxBytes: 1024 * 1024 }));
  if (manifest?.schemaVersion !== 1 || manifest.providerId !== providerId || !Array.isArray(manifest.files)
    || !manifest.files.length || manifest.files.length > 4096 || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw failure("OFFICIAL_SKILL_INTEGRITY_FAILED");
  for (const file of manifest.files) {
    if (!safeRelative(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw failure("OFFICIAL_SKILL_INTEGRITY_FAILED");
    let parent = path.dirname(path.join(root, file.path));
    while (parent !== root) { assertPrivateDirectory(parent); parent = path.dirname(parent); }
    if (sha256(readPrivateFile(path.join(root, file.path), { maxBytes: 100 * 1024 * 1024 })) !== file.sha256) throw failure("OFFICIAL_SKILL_INTEGRITY_FAILED");
  }
  return manifest;
}

const PRIVATE_STATE_ERRORS = new Set(["UNSAFE_SYMLINK", "UNSAFE_HARDLINK", "UNSAFE_OWNER", "UNSAFE_PERMISSIONS", "UNSAFE_PATH", "PRIVATE_FILE_TOO_LARGE"]);
function bridgeErrorCode(error) {
  if (PRIVATE_STATE_ERRORS.has(error?.code)) return "OFFICIAL_SKILL_INTEGRITY_FAILED";
  return officialSkillPublicError(error, "OFFICIAL_SKILL_AUTH_FAILED").code;
}

// Provider implementation is kept separate from the trusted launch/stdio loop.
function createBridge(options) { return require("./official-skill-runtime").createOfficialSkillRuntime(options); }

async function serve({ input = process.stdin, output = process.stdout, argv = process.argv.slice(2) } = {}) {
  if (argv.length !== 6 || argv[0] !== "--provider" || argv[2] !== "--root" || argv[4] !== "--home") throw failure("OFFICIAL_SKILL_INVALID_ARGUMENT");
  const providerId = argv[1], root = argv[3], home = argv[5];
  validatePayload(providerId, root, home);
  const runtime = createBridge({ providerId, root, home, validate: () => validatePayload(providerId, root, home) });
  const pending = new Map(); let buffer = "", closed = false, stopping;
  const write = message => { if (!closed) output.write(`${JSON.stringify(message)}\n`); };
  const stop = () => stopping ||= (async () => { closed = true; for (const abort of pending.values()) abort.abort(); await runtime.close?.(); })();
  input.on("end", stop); input.on("error", stop);
  for (const event of ["SIGTERM", "SIGINT"]) process.once(event, () => { stop().finally(() => process.exit(0)); });
  input.on("data", bytes => {
    buffer += bytes.toString("utf8");
    if (Buffer.byteLength(buffer) > 512 * 1024) { stop(); input.destroy(); return; }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); continue; }
      if (message.method === "notifications/cancelled") { pending.get(message.params?.requestId)?.abort(); continue; }
      if (message.id === undefined) continue;
      if (!["string", "number"].includes(typeof message.id) || pending.has(message.id)) {
        write({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "Invalid or duplicate request id" } }); continue;
      }
      const abort = new AbortController(); pending.set(message.id, abort);
      Promise.resolve().then(async () => {
        if (message.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: `official-${providerId}`, version: getOfficialSkillProvider(providerId).version } };
        if (message.method === "ping") return {};
        if (message.method === "tools/list") return { tools: runtime.tools };
        if (message.method === "tools/call") return { content: [{ type: "text", text: JSON.stringify(await runtime.call(message.params?.name, message.params?.arguments || {},
          { signal: abort.signal, officialSessionId: message.params?._meta?.["shoggoth/official-session-id"] })) }] };
        throw Object.assign(new Error("Unknown method"), { rpcCode: -32601 });
      }).then(result => write({ jsonrpc: "2.0", id: message.id, result }), error => write({ jsonrpc: "2.0", id: message.id,
        error: { code: error.rpcCode || -32000, message: bridgeErrorCode(error) } }))
        .finally(() => pending.delete(message.id));
    }
  });
}

module.exports = { validatePayload, createBridge, serve, safeRelative, sha256, failure };
if (require.main === module) { process.umask(0o077); serve().catch(() => { process.stderr.write("OFFICIAL_SKILL_RUNTIME_MISSING\n"); process.exitCode = 1; }); }
