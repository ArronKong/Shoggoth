"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, validateDirectoryStat } = require("./private-file");
const { serviceError } = require("./security");
const { SERVER, ISSUER, AUDIENCE, AUTHORIZATION, TOKEN, AUTH_TEST,
  METADATA_URLS, CLIENT_ID, LOOPBACK_CALLBACK, validSlackUserScopes,
  validSlackProtocolProvider, verifySlackPrincipal } = require("./plugin-slack-oauth");

const FILE_NAME = "slack-client-registration.json";
// This ID is pinned in the frozen third-party plugin. It is not a Shoggoth
// application registration and must never enter a user-owned registration.
const FROZEN_SOURCE_CLIENT_ID = "11843774967.11905492103734";
const { PUBLIC_SCOPES: PUBLIC_SEARCH_SCOPES, slackAccessProfile } = require("./plugin-slack-access-policy");
const exact = (value, keys) => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const fail = (code = "SLACK_REGISTRATION_INVALID") => {
  throw serviceError(code, "Slack 客户端登记无效或已存在");
};
const fileOf = paths => path.join(paths.pluginsDir, FILE_NAME);

function recordFromInput(input) {
  if (!exact(input, ["clientId", "redirectPort", "scopes"])
    || typeof input.clientId !== "string" || !CLIENT_ID.test(input.clientId)
    || input.clientId === FROZEN_SOURCE_CLIENT_ID
    || !Number.isSafeInteger(input.redirectPort) || input.redirectPort < 1024
    || input.redirectPort > 65535 || !validSlackUserScopes(input.scopes)
    || !slackAccessProfile(input.scopes)) fail();
  return { version: 1, clientId: input.clientId,
    redirectUrl: `http://localhost:${input.redirectPort}/oauth/callback`,
    scopes: [...slackAccessProfile(input.scopes).scopes] };
}

function providerFromRegistration(record) {
  if (!exact(record, ["version", "clientId", "redirectUrl", "scopes"])
    || record.version !== 1 || typeof record.redirectUrl !== "string") fail();
  const callback = LOOPBACK_CALLBACK.exec(record.redirectUrl);
  if (!callback || Number(callback[1]) < 1024 || Number(callback[1]) > 65535) fail();
  const clean = recordFromInput({ clientId: record.clientId,
    redirectPort: Number(callback[1]), scopes: record.scopes });
  if (clean.redirectUrl !== record.redirectUrl) fail();
  const provider = { protocol: "slack-mcp", id: "slack", name: "Slack",
    serverUrl: SERVER, issuer: ISSUER, audience: AUDIENCE,
    authorizationEndpoint: AUTHORIZATION, tokenEndpoint: TOKEN,
    clientId: record.clientId, scopes: [...record.scopes],
    metadataUrls: [...METADATA_URLS], identityUrls: [AUTH_TEST],
    redirectUrl: record.redirectUrl, verifyPrincipal: verifySlackPrincipal };
  if (!validSlackProtocolProvider(provider, record.clientId)) fail();
  return provider;
}

function loadSlackRegistration(paths) {
  const file = fileOf(paths);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    validateDirectoryStat(fs.lstatSync(paths.pluginsDir), paths.pluginsDir);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0 || stat.size > 4096
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail();
    const record = JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(readPrivateFile(file, { maxBytes: 4096 })));
    const provider = providerFromRegistration(record);
    return { clientId: record.clientId, provider };
  } catch (error) {
    if (error.code === "SLACK_REGISTRATION_INVALID") throw error;
    fail();
  }
}

// A saved ID is merely a local claim about a user-owned internal Slack App.
// It does not prove app ownership, administrator approval, OAuth consent, or
// MCP tool availability.
function configureSlackRegistration(paths, input, { hasStoredAccount } = {}) {
  if (typeof hasStoredAccount !== "function") {
    throw new TypeError("Slack registration requires a Service-owned account predicate");
  }
  const record = recordFromInput(input);
  providerFromRegistration(record);
  if (loadSlackRegistration(paths) || hasStoredAccount()) fail("SLACK_REGISTRATION_CONFLICT");
  atomicWritePrivateFile(fileOf(paths), `${JSON.stringify(record)}\n`,
    { trustedRoot: paths.trustedRoot });
  return { configured: true, restartRequired: true };
}

class SlackRegistrationController {
  constructor({ paths, store } = {}) {
    if (!paths || typeof store?.getBySource !== "function"
      || typeof store?.listGlobalBindings !== "function") {
      throw new TypeError("Slack registration requires Service-owned paths and store");
    }
    this.paths = paths;
    this.store = store;
    this.startupRegistration = loadSlackRegistration(paths);
  }

  #hasOldBinding() {
    const installation = this.store.getBySource("bundled:slack");
    return Boolean(installation && this.store.listGlobalBindings().some(binding =>
      binding.installationId === installation.installationId));
  }

  status() {
    const current = loadSlackRegistration(this.paths);
    if (!current && (this.startupRegistration || this.#hasOldBinding())) {
      fail("SLACK_REGISTRATION_CONFLICT");
    }
    return { configured: current !== null,
      restartRequired: current !== null && (this.startupRegistration === null
        || JSON.stringify(current.provider) !== JSON.stringify(this.startupRegistration.provider)),
      accessProfile: current ? slackAccessProfile(current.provider.scopes).id : null };
  }

  assertCurrent() {
    const current = loadSlackRegistration(this.paths);
    return current !== null && this.startupRegistration !== null
      && JSON.stringify(current.provider) === JSON.stringify(this.startupRegistration.provider);
  }

  provider() {
    if (!this.startupRegistration) return null;
    return { ...this.startupRegistration.provider,
      assertCurrent: () => this.assertCurrent() };
  }

  configure(input) {
    if (this.status().configured || this.startupRegistration || this.#hasOldBinding()) {
      fail("SLACK_REGISTRATION_CONFLICT");
    }
    return configureSlackRegistration(this.paths, input,
      { hasStoredAccount: () => this.#hasOldBinding() });
  }
}

module.exports = { FILE_NAME, FROZEN_SOURCE_CLIENT_ID, recordFromInput,
  PUBLIC_SEARCH_SCOPES, providerFromRegistration, loadSlackRegistration,
  configureSlackRegistration, SlackRegistrationController };
