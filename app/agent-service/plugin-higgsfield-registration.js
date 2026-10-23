"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fsyncPrivateParent, validateDirectoryStat,
  validatePrivateStat, writeFully } = require("./private-file");
const { serviceError } = require("./security");
const { loadHiggsfieldRegistration, registerLocalHiggsfieldClient,
  saveHiggsfieldRegistration, trustedHiggsfieldProvider } = require("./plugin-higgsfield-official-oauth");

const PORT_MIN = 1024;
const PORT_MAX = 65535;
const PENDING_FILE = "higgsfield-registration-needs-verification.json";
const exact = (value, keys) => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const fail = code => { throw serviceError(code, "Higgsfield 官方 MCP 客户端登记无效或已存在"); };
const pendingPath = paths => path.join(paths.pluginsDir, PENDING_FILE);

function pendingRegistration(paths) {
  const file = pendingPath(paths);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  try {
    validateDirectoryStat(fs.lstatSync(paths.pluginsDir), paths.pluginsDir);
    validatePrivateStat(stat, file);
    // Even a partial marker means that a previous DCR attempt might have been
    // sent. Its presence is the gate; the contents are only operator context.
    if (stat.size > 256) fail("HIGGSFIELD_REGISTRATION_NEEDS_VERIFICATION");
    return { dev: stat.dev, ino: stat.ino };
  } catch { fail("HIGGSFIELD_REGISTRATION_NEEDS_VERIFICATION"); }
}

function markPendingRegistration(paths, redirectPort) {
  const file = pendingPath(paths);
  validateDirectoryStat(fs.lstatSync(paths.pluginsDir), paths.pluginsDir);
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    try { fd = fs.openSync(file, flags, 0o600); }
    catch (error) {
      if (error?.code === "EEXIST") fail("HIGGSFIELD_REGISTRATION_NEEDS_VERIFICATION");
      throw error;
    }
    writeFully(fs, fd, `${JSON.stringify({ version: 1, redirectPort })}\n`);
    fs.fsyncSync(fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  // A failed directory sync leaves the marker in place and prevents DCR egress.
  fsyncPrivateParent(paths.pluginsDir);
}

function clearPendingRegistration(paths) {
  const marker = pendingRegistration(paths);
  if (!marker) fail("HIGGSFIELD_REGISTRATION_CONFLICT");
  const file = pendingPath(paths);
  const current = fs.lstatSync(file);
  if (current.dev !== marker.dev || current.ino !== marker.ino) {
    fail("HIGGSFIELD_REGISTRATION_NEEDS_VERIFICATION");
  }
  fs.unlinkSync(file);
  fsyncPrivateParent(paths.pluginsDir);
}

// Only Service code constructs this controller. Browser input selects a local
// port; the official resource, issuer, metadata and requested scope stay fixed.
class HiggsfieldRegistrationController {
  #busy = false;

  constructor({ paths, store, fetchImpl = globalThis.fetch } = {}) {
    if (!paths || typeof store?.getBySource !== "function"
      || typeof store?.listGlobalBindings !== "function"
      || typeof fetchImpl !== "function") {
      throw new TypeError("Higgsfield registration requires Service-owned paths, store and fetch");
    }
    Object.assign(this, { paths, store, fetchImpl });
    this.startupRegistration = loadHiggsfieldRegistration(paths);
  }

  #hasOldBinding() {
    const installation = this.store.getBySource("bundled:higgsfield");
    return Boolean(installation && this.store.listGlobalBindings().some(binding =>
      binding.installationId === installation.installationId));
  }

  status() {
    const current = loadHiggsfieldRegistration(this.paths);
    const pending = pendingRegistration(this.paths);
    if ((!current && this.startupRegistration) || (!current && this.#hasOldBinding())) {
      fail("HIGGSFIELD_REGISTRATION_CONFLICT");
    }
    return { configured: current !== null,
      restartRequired: current !== null && this.startupRegistration === null,
      needsVerification: current === null && pending !== null };
  }

  assertCurrent() {
    const current = loadHiggsfieldRegistration(this.paths);
    return current !== null && this.startupRegistration !== null
      && JSON.stringify(current) === JSON.stringify(this.startupRegistration);
  }

  provider() {
    if (!this.startupRegistration) return null;
    return trustedHiggsfieldProvider(this.startupRegistration,
      { assertCurrent: () => this.assertCurrent() });
  }

  async configure(input) {
    if (!exact(input, ["redirectPort"]) || !Number.isSafeInteger(input.redirectPort)
      || input.redirectPort < PORT_MIN || input.redirectPort > PORT_MAX) {
      fail("HIGGSFIELD_REGISTRATION_INVALID");
    }
    if (this.#busy) fail("HIGGSFIELD_REGISTRATION_BUSY");
    const status = this.status();
    if (status.needsVerification) fail("HIGGSFIELD_REGISTRATION_NEEDS_VERIFICATION");
    if (status.configured || this.startupRegistration || this.#hasOldBinding()) {
      fail("HIGGSFIELD_REGISTRATION_CONFLICT");
    }
    this.#busy = true;
    try {
      const registration = await registerLocalHiggsfieldClient({
        redirectUrl: `http://127.0.0.1:${input.redirectPort}/oauth/callback`,
        fetchImpl: this.fetchImpl,
        beforeRegistration: () => {
          if (loadHiggsfieldRegistration(this.paths) || this.#hasOldBinding()) {
            fail("HIGGSFIELD_REGISTRATION_CONFLICT");
          }
          markPendingRegistration(this.paths, input.redirectPort);
        },
      });
      // The remote DCR response cannot override a registration that appeared
      // while the request was in flight. A second local write never occurs.
      if (this.status().configured) fail("HIGGSFIELD_REGISTRATION_CONFLICT");
      try { saveHiggsfieldRegistration(this.paths, registration); }
      catch (error) {
        if (error?.code === "EEXIST") fail("HIGGSFIELD_REGISTRATION_CONFLICT");
        throw error;
      }
      clearPendingRegistration(this.paths);
      return { configured: true, restartRequired: true, needsVerification: false };
    } finally { this.#busy = false; }
  }

  reconcile(input) {
    if (!exact(input, ["reviewedRemoteOutcome"]) || input.reviewedRemoteOutcome !== true) {
      fail("HIGGSFIELD_REGISTRATION_INVALID");
    }
    if (this.#busy) fail("HIGGSFIELD_REGISTRATION_BUSY");
    const status = this.status();
    if (status.configured || this.startupRegistration || this.#hasOldBinding()
      || !status.needsVerification) fail("HIGGSFIELD_REGISTRATION_CONFLICT");
    this.#busy = true;
    try {
      clearPendingRegistration(this.paths);
      return this.status();
    } finally { this.#busy = false; }
  }
}

module.exports = { HiggsfieldRegistrationController, PENDING_FILE };
