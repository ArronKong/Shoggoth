#!/usr/bin/env node
"use strict";

// Local operator setup for a Shoggoth-owned Zoom General App. The secret is
// never accepted in argv, environment variables, plugin files, or stdout.
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { MEETING_SCOPES, IDENTITY_SCOPE } = require("../app/agent-service/plugin-zoom-oauth");

function readSecret() {
  return new Promise((resolve, reject) => {
    let secret = "";
    if (process.stdin.isTTY) {
      process.stdout.write("Zoom General App client secret: ");
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const finish = (error = null) => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        if (error) reject(error);
        else resolve(secret);
      };
      const onData = bytes => {
        for (const byte of bytes) {
          if (byte === 3) { finish(new Error("Canceled")); return; }
          if (byte === 10 || byte === 13) { finish(); return; }
          if (byte === 127 || byte === 8) { secret = secret.slice(0, -1); continue; }
          if (byte < 33 || byte > 126 || secret.length >= 512) {
            finish(new Error("Invalid client secret input")); return;
          }
          secret += String.fromCharCode(byte);
        }
      };
      process.stdin.on("data", onData);
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      secret += chunk;
      if (secret.length > 513) {
        process.stdin.destroy();
        reject(new Error("Client secret input is too long"));
      }
    });
    process.stdin.on("end", () => resolve(secret.replace(/\r?\n$/u, "")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const [clientId, rawPort, ...requested] = process.argv.slice(2);
  const redirectPort = Number(rawPort);
  const scopes = [IDENTITY_SCOPE, ...(requested.length ? requested : [MEETING_SCOPES[0]])];
  if (!clientId || !Number.isSafeInteger(redirectPort) || redirectPort < 1024
    || redirectPort > 65535 || !scopes.some(scope => MEETING_SCOPES.includes(scope))
    || scopes.some(scope => ![IDENTITY_SCOPE, ...MEETING_SCOPES].includes(scope))
    || new Set(scopes).size !== scopes.length) {
    throw new Error("Usage: node scripts/configure-zoom-mcp-client.cjs CLIENT_ID CALLBACK_PORT [meeting:read:search ...]");
  }
  const clientSecret = await readSecret();
  const paths = resolveCanonicalServicePaths();
  const result = await requestService(paths, { token: readClientToken(paths),
    version: SERVICE_PROTOCOL_VERSION, method: "plugins.zoom.registration.configure",
    params: { clientId, clientSecret, redirectPort, scopes } }, { timeoutMs: 15_000 });
  if (result?.configured !== true || result.restartRequired !== true) {
    throw new Error("Zoom registration was not confirmed");
  }
  process.stdout.write("Zoom client stored in Shoggoth's encrypted Service store. Restart Shoggoth, then connect Zoom from the plugin page.\n");
}

if (require.main === module) main().catch(error => {
  console.error(error?.message || "Zoom client setup failed");
  process.exitCode = 1;
});
