"use strict";

// Only authenticated Service IPC can mint a request context. Public owner IDs
// resolve through this catalog; renderer inputs never name SecretStore entries.
const fs = require("node:fs");
const path = require("node:path");
const privateFiles = require("./private-file");
const protocol = require("./memory-provider-owner-protocol.cjs");
const { MemoryProviderOwnerController, createMemoryOwnerManagementAuthority,
  createMemoryOwnerStoppedLeaseAuthority, recoverStoppedMemoryOwnerCatalogLock, recoverStoppedMemoryOwnerCatalogFiles } = require("./memory-provider-owner-controller.cjs");

function createMemoryProviderOwnerRpc({ paths, secretStore, getConfig, getProfileIds, assertProfileCurrent,
  assertServiceCurrent, assertExclusiveStoppedRecovery, retireOwners }) {
  for (const value of [getConfig, getProfileIds, assertProfileCurrent, assertServiceCurrent, assertExclusiveStoppedRecovery, retireOwners]) {
    if (typeof value !== "function") throw new TypeError("Private memory catalog resources are required");
  }
  const contexts = new WeakMap();
  let controller = null, incarnation = null, opened = false, closing = null;
  const assertReady = () => protocol.need(opened && controller && assertServiceCurrent() === true, "MEMORY_OWNER_RETIRED");
  const requestAssertion = context => {
    const captured = contexts.get(context);
    protocol.need(captured && captured.incarnation === incarnation, "MEMORY_OWNER_FORBIDDEN");
    return () => {
      assertReady();
      protocol.need(captured.incarnation === incarnation && captured.assertCurrent() === true, "MEMORY_OWNER_FORBIDDEN");
      return true;
    };
  };
  return {
    isMethod: method => protocol.METHODS.includes(method),
    open() {
      protocol.need(!opened && !controller && !closing, "MEMORY_OWNER_CONFLICT");
      // The Service's exclusive instance lease and physical stopped-owner
      // proof are both required; no public recovery input can grant either.
      const lock = path.join(paths.stateDir, "memory-provider-owners.json.lock");
      let staleLock = false;
      try { fs.lstatSync(lock); staleLock = true; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      const recovery = { stateDir: paths.stateDir, trustedRoot: paths.trustedRoot, privateFiles,
        authorizeStoppedOwner: info => createMemoryOwnerStoppedLeaseAuthority(() => assertExclusiveStoppedRecovery(info) === true) };
      // Owned catalog/receipt writes may survive a crash before lock link
      // publication. Recover their exact stopped-writer proofs even if the
      // catalog lock is absent; the Service instance lease remains required.
      recoverStoppedMemoryOwnerCatalogFiles(recovery);
      if (staleLock) recoverStoppedMemoryOwnerCatalogLock(recovery);
      const current = new MemoryProviderOwnerController({ paths, secretStore, privateFiles, getConfig, getProfileIds,
        assertProfileCurrent, retireOwners, assertServiceCurrent: () => opened && controller === current && assertServiceCurrent() === true,
        authorizeManagement: (_scope, context) => createMemoryOwnerManagementAuthority(requestAssertion(context)) });
      current.open(); controller = current; incarnation = Symbol("memory-provider-owner-generation"); opened = true;
    },
    createRequestContext(assertCurrent) {
      assertReady(); protocol.need(typeof assertCurrent === "function", "MEMORY_OWNER_FORBIDDEN");
      const context = Object.freeze({}); contexts.set(context, { incarnation, assertCurrent }); requestAssertion(context)(); return context;
    },
    async dispatch(method, value, context) {
      try {
        const assertCurrent = requestAssertion(context); assertCurrent();
        const params = protocol.validateParams(method, value);
        const current = controller;
        const result = method === "memory.provider.owner.context" ? current.context(params, context)
          : method === "memory.provider.owner.apply" ? await current.apply(params, context)
          : await current.recover(params, context);
        assertCurrent(); return protocol.validateResult(method, result);
      } catch (error) { const safe = protocol.publicError(error); throw Object.assign(new Error(safe.message), { code: safe.code }); }
    },
    resolveOwner(packet) { assertReady(); return controller.resolveOwner(packet); },
    projectProviderMetadata(profileId, config) { assertReady(); return controller.projectProviderMetadata(profileId, config); },
    close() {
      if (closing) return closing;
      opened = false; incarnation = null;
      if (!controller) return Promise.resolve();
      const current = controller;
      const operation = current.close().then(() => { if (controller === current) controller = null; });
      closing = operation.finally(() => { if (closing === joined) closing = null; });
      const joined = closing; return closing;
    },
    get opened() { return opened; },
  };
}
module.exports = { createMemoryProviderOwnerRpc };
