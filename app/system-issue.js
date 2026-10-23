"use strict";

const SYSTEM_ISSUE_CODES = Object.freeze({ storageFull: "STORAGE_FULL", uiResourceUnavailable: "UI_RESOURCE_UNAVAILABLE" });
const STORAGE_FULL_CODES = new Set(["ENOSPC", "EDQUOT", "SQLITE_FULL", "STORAGE_FULL"]);

// Read only data properties; raw messages and paths never become toast text.
function dataProperty(value, key) {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}

function storageIssueCode(error) {
  const seen = new Set();
  for (let depth = 0; depth < 4 && error && !seen.has(error); depth += 1) {
    seen.add(error);
    if (STORAGE_FULL_CODES.has(dataProperty(error, "code")) || dataProperty(error, "systemIssue") === "STORAGE_FULL") {
      return SYSTEM_ISSUE_CODES.storageFull;
    }
    error = dataProperty(error, "cause");
  }
  return null;
}

module.exports = { SYSTEM_ISSUE_CODES, storageIssueCode };
