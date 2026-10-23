"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Candidate Node/Python interpreters for a plugin's contained script. Only
// paths are listed here; the dependency registry still inspects each file
// (owner, mode, architecture, digest) and probes its version before pinning.
// macOS /usr/bin/python3 is a Command Line Tools shim that may open an install
// dialog, so only the tools' real interpreter is considered.
function interpreterCandidates(kind, { env = process.env, homedir = os.homedir(), fileSystem = fs } = {}) {
  const name = kind === "node" ? "node" : kind === "python" ? "python3" : null;
  if (!name) return [];
  const candidates = [];
  for (const entry of String(env.PATH || "").split(path.delimiter)) {
    if (entry && path.isAbsolute(entry) && !entry.includes("\0")) candidates.push(path.join(entry, name));
  }
  if (typeof homedir === "string" && path.isAbsolute(homedir)) {
    candidates.push(path.join(homedir, ".local", "bin", name));
    if (kind === "node") {
      const versions = path.join(homedir, ".nvm", "versions", "node");
      try {
        const installed = fileSystem.readdirSync(versions)
          .filter(item => /^v\d+\.\d+\.\d+$/u.test(item))
          .sort((left, right) => compareVersions(right, left)).slice(0, 3);
        for (const version of installed) candidates.push(path.join(versions, version, "bin", "node"));
      } catch { /* No nvm installation. */ }
    }
  }
  candidates.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
  if (kind === "node") candidates.push("/usr/bin/node");
  else candidates.push("/Library/Developer/CommandLineTools/usr/bin/python3");
  return [...new Set(candidates)].filter(candidate => !(kind === "python" && candidate === "/usr/bin/python3"));
}

function compareVersions(left, right) {
  const a = left.slice(1).split(".").map(Number);
  const b = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

module.exports = { interpreterCandidates };
