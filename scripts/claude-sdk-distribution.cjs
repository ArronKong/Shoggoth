"use strict";

const SDK = "@anthropic-ai/claude-agent-sdk";
const REVIEWED_VERSION = "0.3.329";
const INLINED_PEERS = new Set(["@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod"]);
const NODE_MODULES = "node_modules/";

function isClaudeSdkCliPackage(name) {
  return name.startsWith(`${SDK}-`);
}

function parentPackage(key) {
  const index = key.lastIndexOf(`/${NODE_MODULES}`);
  return index === -1 ? "" : key.slice(0, index);
}

function resolveDependency(packages, from, name) {
  for (let parent = from; ; parent = parentPackage(parent)) {
    const key = `${parent ? `${parent}/` : ""}${NODE_MODULES}${name}`;
    if (Object.hasOwn(packages, key)) return key;
    if (!parent) return null;
  }
}

function dependencyClosure(packages, omitSdkExtras) {
  const seen = new Set();
  const pending = [""];
  while (pending.length) {
    const key = pending.pop();
    if (seen.has(key)) continue;
    const entry = packages[key];
    seen.add(key);
    const name = key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
    const reviewedSdk = omitSdkExtras && name === SDK && entry.version === REVIEWED_VERSION;
    for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const from = kind === "peerDependencies" ? parentPackage(key) : key;
      for (const dependency of Object.keys(entry[kind] ?? {})) {
        if (reviewedSdk && ((kind === "optionalDependencies" && isClaudeSdkCliPackage(dependency))
          || (kind === "peerDependencies" && INLINED_PEERS.has(dependency)))) continue;
        const resolved = resolveDependency(packages, from, dependency);
        if (resolved) pending.push(resolved);
      }
    }
  }
  return seen;
}

// This SDK entry point carries its runtime implementation and uses the user's
// installed CLI. A peer's transitive dependencies can also be shared with build
// tools, so the lockfile's `peer` flag alone cannot determine distribution.
function excludedClaudeSdkPaths(packages) {
  const installed = dependencyClosure(packages, false);
  const shipped = dependencyClosure(packages, true);
  return new Set([...installed].filter(key => !shipped.has(key)));
}

module.exports = { excludedClaudeSdkPaths, isClaudeSdkCliPackage };
