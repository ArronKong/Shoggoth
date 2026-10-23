"use strict";

const path = require("node:path");
const { atomicWritePrivateFile } = require("./private-file");
const { loadOutlookCalendarConfig } = require("./outlook-calendar-graph");
const { serviceError } = require("./security");

const FILE_NAME = "outlook-calendar-graph.json";
const CLIENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const exact = (value, keys) => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

function registrationError(code) {
  return serviceError(code, "Microsoft Graph 客户端登记无效或已存在");
}

function getGraphRegistrationStatus(paths, graphAccount) {
  const configured = loadOutlookCalendarConfig(paths);
  // A retained encrypted account or a still-active client cannot be rebound to
  // a new file. Refuse the availability check before native confirmation.
  if (configured === null && (graphAccount?.config != null || graphAccount?.hasStoredAccount?.())) {
    throw registrationError("GRAPH_REGISTRATION_CONFLICT");
  }
  return { configured: configured !== null,
    restartRequired: configured !== null && configured.clientId !== graphAccount?.config?.clientId };
}

// First registration only. A different client ID would invalidate the shared
// encrypted account and every Graph card; replacement needs its own revocation
// operation. The Service keeps the current in-memory config until restart.
function configureGraphRegistration(paths, graphAccount, input) {
  if (!exact(input, ["clientId"]) || typeof input.clientId !== "string"
    || !CLIENT_ID.test(input.clientId)) throw registrationError("GRAPH_REGISTRATION_INVALID");
  if (typeof graphAccount?.hasStoredAccount !== "function") {
    throw new TypeError("Graph registration requires a Service-owned account broker");
  }
  if (loadOutlookCalendarConfig(paths) !== null || graphAccount.config != null
    || graphAccount.hasStoredAccount()) {
    throw registrationError("GRAPH_REGISTRATION_CONFLICT");
  }
  const record = { version: 1, clientId: input.clientId.toLowerCase() };
  atomicWritePrivateFile(path.join(paths.pluginsDir, FILE_NAME), `${JSON.stringify(record)}\n`,
    { trustedRoot: paths.trustedRoot });
  return { configured: true, restartRequired: true };
}

module.exports = { FILE_NAME, getGraphRegistrationStatus, configureGraphRegistration };
