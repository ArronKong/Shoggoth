// A source inventory for the inert plugin files carried in extraResources.
// It is deliberately not a redistribution-license decision.
import crypto from 'node:crypto';

const hexDigest = /^[a-f0-9]{64}$/u;
const packageId = /^[a-z0-9][a-z0-9-]*$/u;
const emptyBatchDigest = crypto.createHash('sha256').update('[]').digest('hex');
const refPrefix = 'urn:shoggoth:bundled-plugin:';

export function bundledPluginSbomComponents(catalog, frozenInventory, scope) {
  // Public source exports deliberately omit all third-party bundled packages.
  // Their empty catalog has no private frozen inventory to compare against.
  if (catalog?.packages?.length === 0 && catalog.batchDigest === emptyBatchDigest) return [];
  if (!catalog || !frozenInventory || !scope
    || scope.frozenBatchDigest !== frozenInventory.batchDigest
    || !hexDigest.test(catalog.batchDigest)
    || !Array.isArray(catalog.packages) || !Array.isArray(frozenInventory.packages)
    || !Array.isArray(scope.activePackageIds)
    || catalog.packages.length !== scope.activePackageIds.length
    || frozenInventory.packages.length !== frozenInventory.summary?.packages
    || new Set(scope.activePackageIds).size !== scope.activePackageIds.length
    || new Set(catalog.packages.map(entry => entry.id)).size !== catalog.packages.length
    || catalog.packages.some(entry => !scope.activePackageIds.includes(entry.id))
    || crypto.createHash('sha256').update(JSON.stringify(catalog.packages
      .map(entry => ({ directory: entry.id, digest: entry.sourceDigest }))
      .sort((left, right) => left.directory.localeCompare(right.directory)))).digest('hex') !== catalog.batchDigest) {
    throw new Error("RELEASE_BUNDLED_PLUGIN_INVENTORY_MISMATCH");
  }
  const frozenPackages = new Map(frozenInventory.packages.map((entry) => [entry.directory, entry]));
  const seen = new Set();
  const components = catalog.packages.map((entry) => {
    const frozen = frozenPackages.get(entry.id);
    if (!frozen || !packageId.test(entry.id) || seen.has(entry.id)
      || !hexDigest.test(entry.sourceDigest)
      || frozen.sourceDigest !== entry.sourceDigest
      || frozen.version !== entry.version
      || frozen.files !== entry.fileCount || frozen.bytes !== entry.bytes) {
      throw new Error(`RELEASE_BUNDLED_PLUGIN_INVENTORY_MISMATCH:${entry.id}`);
    }
    seen.add(entry.id);
    return {
      type: "library",
      name: `Bundled plugin: ${entry.id}`,
      version: entry.version,
      "bom-ref": `${refPrefix}${entry.id}`,
      properties: [
        { name: "shoggoth:role", value: "inert-bundled-plugin-resource" },
        { name: "shoggoth:source-digest-sha256", value: entry.sourceDigest },
        { name: "shoggoth:file-count", value: String(entry.fileCount) },
        { name: "shoggoth:manifest-license-declaration", value: entry.license || "not-declared" },
        { name: "shoggoth:redistribution-review", value: "unverified" },
      ],
    };
  });
  if (seen.size !== scope.activePackageIds.length) throw new Error("RELEASE_BUNDLED_PLUGIN_INVENTORY_MISMATCH");
  return components;
}

export function withoutBundledPlugins(sbom, catalog) {
  if (!sbom || !Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)
    || !Array.isArray(catalog?.packages)) throw new Error('PUBLIC_BUNDLED_SBOM_INVALID');
  const rootRef = sbom.metadata?.component?.['bom-ref'];
  const root = sbom.dependencies.find((entry) => entry.ref === rootRef);
  const bundled = sbom.components.filter((entry) =>
    typeof entry['bom-ref'] === 'string' && entry['bom-ref'].startsWith(refPrefix));
  if (!root || !Array.isArray(root.dependsOn)
    || bundled.length !== catalog.packages.length
    || sbom.dependencies.some((entry) => entry.ref?.startsWith(refPrefix))) {
    throw new Error('PUBLIC_BUNDLED_SBOM_INVALID');
  }
  const refs = new Set();
  for (const source of catalog.packages) {
    const ref = `${refPrefix}${source.id}`;
    const entry = bundled.find((candidate) => candidate['bom-ref'] === ref);
    if (!entry || refs.has(ref) || !root.dependsOn.includes(ref)
      || entry.properties?.find((property) =>
        property.name === 'shoggoth:source-digest-sha256')?.value !== source.sourceDigest) {
      throw new Error(`PUBLIC_BUNDLED_SBOM_INVALID:${source.id}`);
    }
    refs.add(ref);
  }
  return {
    ...sbom,
    components: sbom.components.filter((entry) => !refs.has(entry['bom-ref'])),
    dependencies: sbom.dependencies.map((entry) => entry.ref === rootRef
      ? { ...entry, dependsOn: entry.dependsOn.filter((ref) => !refs.has(ref)) }
      : entry),
  };
}
