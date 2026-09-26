"use strict";

const { serviceError } = require("./security");

const PROVIDER_CREDENTIAL_PREFIX = "provider-credential-";

function reconciliationError() {
  return serviceError(
    "PROVIDER_SECRET_RECONCILIATION_FAILED",
    "Provider credential reconciliation failed",
  );
}

async function reconcileProviderCredentialSecrets({ productStore, secretStore }) {
  try {
    const providers = productStore.listModelProviders();
    const metadata = secretStore.listMetadata();
    if (!Array.isArray(providers) || !Array.isArray(metadata)) throw reconciliationError();

    const ownedCredentialRefs = new Set();
    for (const provider of providers) {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)
        || (provider.credentialRef !== null && typeof provider.credentialRef !== "string")) {
        throw reconciliationError();
      }
      if (provider.credentialRef !== null) ownedCredentialRefs.add(provider.credentialRef);
    }

    const orphanCredentialRefs = new Set();
    for (const entry of metadata) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || typeof entry.credentialRef !== "string") {
        throw reconciliationError();
      }
      if (entry.credentialRef.startsWith(PROVIDER_CREDENTIAL_PREFIX)
        && !ownedCredentialRefs.has(entry.credentialRef)) {
        orphanCredentialRefs.add(entry.credentialRef);
      }
    }

    for (const credentialRef of orphanCredentialRefs) {
      await secretStore.delete(credentialRef);
    }

    if (orphanCredentialRefs.size > 0) {
      const remaining = secretStore.listMetadata();
      if (!Array.isArray(remaining) || remaining.some((entry) => (
        !entry || typeof entry !== "object" || Array.isArray(entry)
        || typeof entry.credentialRef !== "string"
        || orphanCredentialRefs.has(entry.credentialRef)
      ))) {
        throw reconciliationError();
      }
    }

    return Object.freeze({
      ownedCredentialCount: ownedCredentialRefs.size,
      deletedCredentialCount: orphanCredentialRefs.size,
    });
  } catch {
    throw reconciliationError();
  }
}

module.exports = {
  PROVIDER_CREDENTIAL_PREFIX,
  reconcileProviderCredentialSecrets,
};
