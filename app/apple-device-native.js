"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const OPERATIONS = new Set(["status", "requestAccess", "calendar.list", "calendar.events", "calendar.get", "calendar.create", "calendar.update", "calendar.delete",
  "reminders.lists", "reminders.search", "reminders.get", "reminders.create", "reminders.update", "reminders.delete"]);
const ERROR_MESSAGES = Object.freeze({
  APPLE_DEVICE_INVALID_ARGUMENT: "Invalid Apple device request.",
  APPLE_DEVICE_PERMISSION_REQUIRED: "Connect this application in Your devices before accessing its data.",
  APPLE_DEVICE_NOT_FOUND: "The selected item no longer exists.",
  APPLE_DEVICE_CONFLICT: "This item changed. Read it again and approve the updated change.",
  APPLE_DEVICE_READ_ONLY: "The selected calendar or list is read only.",
  APPLE_DEVICE_UNAVAILABLE: "Apple device access is unavailable on this desktop.",
  APPLE_DEVICE_BUSY: "Another Apple device operation is still active. Wait for it to finish before trying again.",
  APPLE_DEVICE_CANCELLED: "Apple device operation was cancelled. Check the current item before retrying a change.",
  APPLE_DEVICE_TIMEOUT: "Apple device access timed out. Check the current item before retrying a change.",
  APPLE_DEVICE_FAILED: "Apple device operation failed. Check the current item before retrying a change.",
});
function failure(code) {
  const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "APPLE_DEVICE_FAILED";
  const error = new Error(ERROR_MESSAGES[safeCode]);
  error.code = safeCode;
  return error;
}

function createAppleDeviceNative(options = {}) {
  const platform = options.platform || process.platform;
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const location = options.addonPath || (resourcesPath ? path.join(resourcesPath, "apple-device", "apple-device.node") : path.join(__dirname, "../.vendor/apple-device/apple-device.node"));
  const loader = options.loadAddon || require;
  let addon;
  function load() {
    if (addon) return addon;
    try {
      if (!options.loadAddon) {
        const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(location), "manifest.json"), "utf8"));
        const binaryHash = crypto.createHash("sha256").update(fs.readFileSync(location)).digest("hex");
        if (manifest.version !== 1 || manifest.napiVersion !== 8 || manifest.sha256 !== binaryHash) throw failure("APPLE_DEVICE_UNAVAILABLE");
      }
      addon = loader(location);
      if (!addon || typeof addon.invoke !== "function") throw failure("APPLE_DEVICE_UNAVAILABLE");
      return addon;
    } catch { addon = undefined; throw failure("APPLE_DEVICE_UNAVAILABLE"); }
  }
  return {
    async invoke(operation, params = {}, { signal } = {}) {
      if (platform !== "darwin") throw failure("APPLE_DEVICE_UNAVAILABLE");
      if (!OPERATIONS.has(operation) || !params || typeof params !== "object" || Array.isArray(params) || Object.getPrototypeOf(params) !== Object.prototype)
        throw failure("APPLE_DEVICE_INVALID_ARGUMENT");
      if (signal?.aborted) throw failure("APPLE_DEVICE_CANCELLED");
      if (signal && (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) throw failure("APPLE_DEVICE_INVALID_ARGUMENT");
      const requestId = crypto.randomUUID();
      let input;
      try { input = JSON.stringify({ operation, params, requestId }); } catch { throw failure("APPLE_DEVICE_INVALID_ARGUMENT"); }
      if (Buffer.byteLength(input, "utf8") > 65536) throw failure("APPLE_DEVICE_INVALID_ARGUMENT");
      let onAbort;
      try {
        const native = load();
        if (signal && typeof native.cancel !== "function") throw failure("APPLE_DEVICE_UNAVAILABLE");
        const cancellation = signal ? new Promise((_resolve, reject) => {
          onAbort = () => {
            try { native.cancel(requestId); } catch { /* Keep the caller cancelled even if shutdown has begun. */ }
            reject(failure("APPLE_DEVICE_CANCELLED"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }) : null;
        cancellation?.catch(() => {});
        if (signal?.aborted) onAbort();
        const execution = signal?.aborted ? cancellation : native.invoke(input);
        const raw = await (cancellation ? Promise.race([execution, cancellation]) : execution);
        if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 49152) throw failure("APPLE_DEVICE_FAILED");
        const response = JSON.parse(raw);
        if (!response || response.ok !== true || !response.result || typeof response.result !== "object" || Array.isArray(response.result))
          throw failure(response?.error?.code);
        return response.result;
      } catch (error) { throw failure(error?.code); }
      finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
    },
  };
}
const defaultNative = createAppleDeviceNative();
module.exports = { createAppleDeviceNative, invoke: defaultNative.invoke, APPLE_DEVICE_OPERATIONS: Object.freeze([...OPERATIONS]) };
