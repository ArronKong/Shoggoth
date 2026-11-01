"use strict";
// Journal/history validation only. This module has no package or Grant resolver.
function validateLegacyPluginSelection(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new TypeError("invalid legacy plugin selection");
  const seen = new Set();
  for (const item of value) {
    if (!item || Object.getPrototypeOf(item) !== Object.prototype || Object.keys(item).sort().join(",") !== "installationId,revision"
      || typeof item.installationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.installationId)
      || !Number.isSafeInteger(item.revision) || item.revision < 1 || seen.has(item.installationId)) throw new TypeError("invalid legacy plugin selection");
    seen.add(item.installationId);
  }
  return value;
}
function normalizeLegacyPluginSelection(value) {
  if (value === undefined) return undefined;
  return validateLegacyPluginSelection(value).map(({ installationId, revision }) => ({ installationId, revision }))
    .sort((left, right) => left.installationId < right.installationId ? -1 : left.installationId > right.installationId ? 1 : 0);
}
function validLegacyPluginSelection(value) {
  try { normalizeLegacyPluginSelection(value); return true; } catch { return false; }
}
module.exports = { validateLegacyPluginSelection, normalizeLegacyPluginSelection, validLegacyPluginSelection };
