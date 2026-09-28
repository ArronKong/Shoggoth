"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

const PAGE_BYTES = 36 * 1024;
const MAX_LIMIT = 100;
const fail = code => { throw serviceError(code, "Skill 管理目录查询无效或已变化"); };
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The Service projects one small page while retaining the full registry only
// in its own process. Page boundaries include the same byte budget as the
// harness protocol, so descriptions cannot grow a browser response to 2 MiB.
function querySkillManagementCatalog({ catalog, usage, query, status, pageIndex, limit,
  expectedRevision }) {
  if (!catalog || !Array.isArray(catalog.items) || !(usage instanceof Map)
    || typeof query !== "string" || !query.isWellFormed()
    || Buffer.byteLength(query) > 256 || /[\x00-\x1f\x7f]/u.test(query)
    || !["", "on", "off"].includes(status)
    || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 100_000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT
    || (expectedRevision !== null && !/^[a-f0-9]{64}$/u.test(expectedRevision))) fail("INVALID_PARAMS");

  const revision = hash([catalog.registryRevision, catalog.registryVersion,
    catalog.profileRevision, query, status, usage.supported === true,
    [...usage.entries()].sort(([a], [b]) => a.localeCompare(b)),
    catalog.items.map(item => [item.id, item.usageAgents])]);
  if (expectedRevision !== null && expectedRevision !== revision) fail("HARNESS_REVISION_CONFLICT");
  if (pageIndex > 0 && expectedRevision === null) fail("HARNESS_REVISION_CONFLICT");
  const usageSupported = usage.supported === true;
  const term = query.trim().toLowerCase();
  const filtered = catalog.items.filter(item => {
    if ((status === "on" && !item.enabled) || (status === "off" && item.enabled)) return false;
    if (!term) return true;
    const category = item.category || (item.source === "builtin" ? "Shoggoth built-in" : "Shoggoth native");
    return item.name.toLowerCase().includes(term)
      || item.description.toLowerCase().includes(term)
      || category.toLowerCase().includes(term);
  }).sort((a, b) => {
    const difference = (usage.get(b.name) || 0) - (usage.get(a.name) || 0);
    return difference || a.name.localeCompare(b.name);
  });

  const bounds = [];
  for (let start = 0; start < filtered.length;) {
    let end = start, bytes = 0;
    while (end < filtered.length && end - start < limit) {
      const size = Buffer.byteLength(JSON.stringify(filtered[end]), "utf8");
      if (size > PAGE_BYTES) fail("HARNESS_RESPONSE_TOO_LARGE");
      if (end > start && bytes + size > PAGE_BYTES) break;
      bytes += size; end += 1;
    }
    bounds.push([start, end]);
    start = end;
  }
  if (bounds.length === 0) bounds.push([0, 0]);
  if (pageIndex >= bounds.length) fail("INVALID_PARAMS");
  const [start, end] = bounds[pageIndex];
  return {
    registryRevision: catalog.registryRevision,
    registryVersion: catalog.registryVersion,
    profileRevision: catalog.profileRevision,
    queryRevision: revision,
    pageIndex,
    pageCount: bounds.length,
    total: catalog.items.length,
    enabledCount: catalog.items.filter(item => item.enabled).length,
    usedCount: catalog.items.filter(item => (usage.get(item.name) || 0) > 0).length,
    usageSupported,
    matchCount: filtered.length,
    items: filtered.slice(start, end),
  };
}

module.exports = { PAGE_BYTES, querySkillManagementCatalog };
