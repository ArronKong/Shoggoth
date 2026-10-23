"use strict";

const { serviceError } = require("./security");
const EXTERNAL_PROVIDER_CREDENTIAL_PREFIX = "external-provider-credential-";
const EXTERNAL_PROVIDER_SECRET_KIND = "external-provider-api-key";

async function reconcileExternalProviderCredentialSecrets({ controller, secretStore }) {
  // Lazy import avoids a factory cycle. This API has no renderer route.
  const { isExternalProviderCredentialController } = require("./external-provider-credential-controller");
  const fail = () => serviceError("EXTERNAL_PROVIDER_CREDENTIAL_RECONCILIATION_FAILED",
    "EXTERNAL_PROVIDER_CREDENTIAL_RECONCILIATION_FAILED");
  try {
    if (!isExternalProviderCredentialController(controller)) throw fail();
    const owned = new Set(controller.credentialOwnershipSnapshot());
    const prefix = controller.credentialPrefix || EXTERNAL_PROVIDER_CREDENTIAL_PREFIX;
    const kind = controller.secretKind || EXTERNAL_PROVIDER_SECRET_KIND;
    const metadata = secretStore.listMetadata(); if (!Array.isArray(metadata)) throw fail();
    const orphans = [];
    for (const row of metadata) {
      if (!row || typeof row.credentialRef !== "string" || typeof row.kind !== "string") throw fail();
      if (!row.credentialRef.startsWith(prefix)) continue;
      if (row.kind !== kind) throw fail();
      if (!owned.has(row.credentialRef)) orphans.push(row.credentialRef);
    }
    for (const credentialRef of orphans) {
      if (controller.credentialOwnershipSnapshot().includes(credentialRef)) throw fail();
      await secretStore.delete(credentialRef);
    }
    const remaining = secretStore.listMetadata();
    if (!Array.isArray(remaining) || remaining.some(row => orphans.includes(row?.credentialRef))) throw fail();
    return Object.freeze({ ownedCredentialCount: owned.size, deletedCredentialCount: orphans.length });
  } catch { throw fail(); }
}

module.exports = { EXTERNAL_PROVIDER_CREDENTIAL_PREFIX, EXTERNAL_PROVIDER_SECRET_KIND, reconcileExternalProviderCredentialSecrets };
