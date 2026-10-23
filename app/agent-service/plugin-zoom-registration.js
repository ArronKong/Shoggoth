"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { serviceError } = require("./security");
const { SERVER, ISSUER, AUTHORIZATION, TOKEN, IDENTITY, METADATA_URLS,
  validZoomProviderConfig, validZoomClientSecret, verifyZoomPrincipal } = require("./plugin-zoom-oauth");

const FILE_NAME = "zoom-client-registration.json";
const CALLBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/u;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw serviceError("ZOOM_REGISTRATION_INVALID", "Zoom 客户端注册资料无效"); };
const fileOf = paths => path.join(paths.pluginsDir, FILE_NAME);

function providerFromRegistration(record) {
  if (!exact(record, ["version", "clientId", "clientSecretRef", "redirectUrl", "scopes"])
    || record.version !== 1 || typeof record.redirectUrl !== "string"
    || !CALLBACK.test(record.redirectUrl)) fail();
  const value = { id: "zoom-meetings", name: "Zoom Meetings", serverUrl: SERVER,
    issuer: ISSUER, audience: SERVER, authorizationEndpoint: AUTHORIZATION,
    tokenEndpoint: TOKEN, clientId: record.clientId,
    clientSecretRef: record.clientSecretRef, scopes: record.scopes,
    metadataUrls: METADATA_URLS, identity: { url: IDENTITY, subjectField: "id" },
    redirectUrl: record.redirectUrl };
  if (!validZoomProviderConfig(value)) fail();
  return { ...value, identityUrls: [IDENTITY], protocol: "zoom-mcp",
    verifyPrincipal: verifyZoomPrincipal };
}

function loadZoomRegistration(paths) {
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
    return { clientId: record.clientId, provider };
  } catch (error) {
    if (error.code === "ZOOM_REGISTRATION_INVALID") throw error;
    fail();
  }
}

let configuring = false;
async function configureZoomRegistration(paths, secretStore, input) {
  if (configuring) fail();
  if (!exact(input, ["clientId", "clientSecret", "redirectPort", "scopes"])
    || !Number.isSafeInteger(input.redirectPort) || input.redirectPort < 1024
    || input.redirectPort > 65535 || !validZoomClientSecret(input.clientSecret)) fail();
  const record = { version: 1, clientId: input.clientId,
    clientSecretRef: `plugin-zoom-client-${crypto.randomUUID()}`,
    redirectUrl: `http://127.0.0.1:${input.redirectPort}/oauth/callback`, scopes: input.scopes };
  providerFromRegistration(record);
  if (!secretStore || typeof secretStore.put !== "function"
    || typeof secretStore.delete !== "function" || loadZoomRegistration(paths)) fail();
  configuring = true;
  let stored = false;
  try {
    await secretStore.put(record.clientSecretRef, input.clientSecret, { kind: "zoom-oauth-client" });
    stored = true;
    atomicWritePrivateFile(fileOf(paths), `${JSON.stringify(record)}\n`, {
      trustedRoot: paths.trustedRoot });
    return { configured: true, restartRequired: true, provider: "zoom-meetings" };
  } catch (error) {
    if (stored && !error.committedUncertain) {
      await secretStore.delete(record.clientSecretRef).catch(() => {});
    }
    throw error;
  } finally { configuring = false; }
}

module.exports = { FILE_NAME, providerFromRegistration, loadZoomRegistration,
  configureZoomRegistration };
