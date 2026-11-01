"use strict";

// NetEase's production CLI stores developer credentials in its own encrypted
// file. Feed configuration through stdin, then construct the CLI's argv only
// inside this process so credentials never appear in OS process arguments.
const fs = require("node:fs");
const path = require("node:path");
const { validatePayload } = require("./official-skill-mcp-bridge");
async function configureNetease(argv = process.argv.slice(2), input = process.stdin) {
  if (argv.length !== 6 || argv[0] !== "--root" || argv[2] !== "--home" || argv[4] !== "--field" || !["appId", "privateKey"].includes(argv[5])) throw new Error("invalid");
  const root = argv[1], home = argv[3], field = argv[5];
  validatePayload("netease-music", root, home);
  if (process.env.HOME !== home) throw new Error("invalid");
  let bytes = "";
  for await (const chunk of input) { bytes += chunk.toString("utf8"); if (Buffer.byteLength(bytes) > 32768) throw new Error("invalid"); }
  const value = JSON.parse(bytes);
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("invalid");
  process.umask(0o077);
  const entry = path.join(root, "runtime", "dist", "index.js");
  process.argv = [process.execPath, entry, "config", "set", field, value];
  require(entry);
}
module.exports = { configureNetease };
if (require.main === module) configureNetease().catch(() => { process.stderr.write("OFFICIAL_SKILL_AUTH_FAILED\n"); process.exitCode = 1; });
