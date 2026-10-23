"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { serviceError } = require("./security");
const { SERVER, ISSUER, AUTHORIZATION, TOKEN, IDENTITY, METADATA_URLS, SCOPES,
  validDropboxProviderConfig, validDropboxClientSecret,
  verifyDropboxPrincipal } = require("./plugin-dropbox-oauth");

const FILE_NAME = "dropbox-client-registration.json";
const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const CALLBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/u;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw serviceError("DROPBOX_REGISTRATION_INVALID", "Dropbox 客户端注册资料无效"); };
const fileOf = paths => path.join(paths.pluginsDir, FILE_NAME);

function providerFromRegistration(record) {
  if (!exact(record, ["version", "clientId", "clientSecretRef", "redirectUrl"])
    || record.version !== 1 || !CLIENT_ID.test(record.clientId)
    || !CALLBACK.test(record.redirectUrl)) fail();
  const value = { id: "dropbox", name: "Dropbox", serverUrl: SERVER,
    issuer: ISSUER, audience: SERVER, authorizationEndpoint: AUTHORIZATION,
    tokenEndpoint: TOKEN, clientId: record.clientId,
    clientSecretRef: record.clientSecretRef, scopes: [...SCOPES],
    metadataUrls: [...METADATA_URLS], identity: { url: IDENTITY, subjectField: "account_id" },
    redirectUrl: record.redirectUrl };
  if (!validDropboxProviderConfig(value)) fail();
  return { ...value, identityUrls: [IDENTITY], protocol: "dropbox-mcp",
    verifyPrincipal: verifyDropboxPrincipal };
}

function loadDropboxRegistration(paths) {
  const file = fileOf(paths);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const parent = fs.lstatSync(paths.pluginsDir);
  if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o077)
    || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
    || stat.size > 4096 || (typeof process.getuid === "function"
      && (stat.uid !== process.getuid() || parent.uid !== process.getuid()))) fail();
  try {
    const record = JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(readPrivateFile(file, { maxBytes: 4096 })));
    const provider = providerFromRegistration(record);
    const expected = JSON.stringify(record);
    const assertCurrent = () => {
        try {
          const current = loadDropboxRegistration(paths);
          return current !== null
            && JSON.stringify({ version: 1, clientId: current.clientId,
              clientSecretRef: current.provider.clientSecretRef,
              redirectUrl: current.provider.redirectUrl }) === expected;
        } catch { return false; }
      };
    return { clientId: record.clientId, provider: { ...provider, assertCurrent },
      assertCurrent };
  } catch (error) {
    if (error.code === "DROPBOX_REGISTRATION_INVALID") throw error;
    fail();
  }
}

let configuring = false;
async function configureDropboxRegistration(paths, secretStore, input) {
  if (configuring || !exact(input, ["clientId", "clientSecret", "redirectPort"])
    || !CLIENT_ID.test(input.clientId) || !validDropboxClientSecret(input.clientSecret)
    || !Number.isSafeInteger(input.redirectPort) || input.redirectPort < 1024
    || input.redirectPort > 65535) fail();
  const record = { version: 1, clientId: input.clientId,
    clientSecretRef: `plugin-dropbox-client-${crypto.randomUUID()}`,
    redirectUrl: `http://127.0.0.1:${input.redirectPort}/oauth/callback` };
  providerFromRegistration(record);
  if (!secretStore || typeof secretStore.put !== "function"
    || typeof secretStore.delete !== "function" || loadDropboxRegistration(paths)) fail();
  configuring = true;
  let stored = false;
  try {
    await secretStore.put(record.clientSecretRef, input.clientSecret, { kind: "dropbox-oauth-client" });
    stored = true;
    atomicWritePrivateFile(fileOf(paths), `${JSON.stringify(record)}\n`, {
      trustedRoot: paths.trustedRoot });
    return { configured: true, restartRequired: true, provider: "dropbox" };
  } catch (error) {
    if (stored && !error.committedUncertain) {
      await secretStore.delete(record.clientSecretRef).catch(() => {});
    }
    throw error;
  } finally { configuring = false; }
}

module.exports = { FILE_NAME, providerFromRegistration, loadDropboxRegistration,
  configureDropboxRegistration };
