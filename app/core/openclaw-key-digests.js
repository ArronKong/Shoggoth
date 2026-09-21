"use strict";

const { execFile } = require("node:child_process");

const maskKey = value => value.length >= 10
  ? `${value.slice(0, 4)}...${value.slice(-4)}` : "••••••";

/** Public previews only; profile references and externally managed values are not keys. */
function projectKeyDigests(config, store = {}) {
  const profiles = store.profiles || {};
  const digests = new Map();
  for (const [id, profile] of Object.entries(profiles)) {
    if (profile?.type !== "api_key" || typeof profile.key !== "string" || !profile.key.trim()) continue;
    const provider = profile.provider || id.split(":")[0];
    if (!digests.has(provider) || id === `${provider}:default`) {
      digests.set(provider, maskKey(profile.key.trim()));
    }
  }
  for (const [id, entry] of Object.entries(config?.models?.providers || {})) {
    const raw = entry?.apiKey;
    if (raw == null || raw === "") continue;
    digests.delete(id);
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim();
    const profile = profiles[value.replace(/^profile:/, "")];
    if (profile) {
      if (profile.type === "api_key" && typeof profile.key === "string" && profile.key.trim()) {
        digests.set(id, maskKey(profile.key.trim()));
      }
    } else if (!value.includes(":") && !value.includes("REDACTED") && value !== "secretref-managed") {
      digests.set(id, maskKey(value));
    }
  }
  return [...digests];
}

function readCanonicalKeyDigests({ sdk, home, agentId }) {
  // Mask inside the read-only SDK process: plaintext never crosses its stdout.
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [sdk, helper, home, agentId] = process.argv.slice(1);
    const { loadAuthProfileStoreForSecretsRuntime } = await import(pathToFileURL(sdk).href);
    const { projectKeyDigests } = (await import(pathToFileURL(helper).href)).default;
    const config = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    const store = loadAuthProfileStoreForSecretsRuntime(path.join(home, 'agents', agentId, 'agent'));
    process.stdout.write(JSON.stringify(projectKeyDigests(config, store)));
  `;
  return new Promise((resolve, reject) => {
    execFile("node", ["--input-type=module", "-e", script, sdk, __filename, home, agentId], {
      encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(new Error("Provider key previews unavailable"));
      try { resolve(new Map(JSON.parse(stdout))); }
      catch { reject(new Error("Provider key previews unavailable")); }
    });
  });
}

module.exports = { projectKeyDigests, readCanonicalKeyDigests };
