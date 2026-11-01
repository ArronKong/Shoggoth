"use strict";

const { validateAppleDeviceInvokeParams, validateAppleDeviceInvokeResult,
  APPLE_DEVICE_RESOURCES } = require("./core/apple-device-contract");

const SETTINGS = Object.freeze({
  calendar: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  reminders: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
});
const unavailable = () => Object.assign(new Error("Apple device access is unavailable"), { code: "APPLE_DEVICE_UNAVAILABLE" });

// Invoked exclusively by the authenticated App-host socket, never by renderer
// IPC or a model-supplied native call. The addon lives in the signed App process.
function createAppleDeviceHost({ native, openExternal }) {
  if (typeof native?.invoke !== "function" || typeof openExternal !== "function") throw new TypeError("Apple device host dependencies invalid");
  return {
    async invoke(input, { signal } = {}) {
      let request;
      try { request = validateAppleDeviceInvokeParams(input); }
      catch { throw Object.assign(new Error("Invalid Apple device operation"), { code: "APPLE_DEVICE_INVALID_ARGUMENT" }); }
      const { operation, params } = request;
      if (signal?.aborted) throw Object.assign(new Error("Apple device operation canceled"), { code: "APPLE_DEVICE_CANCELED" });
      if (operation === "settings.open") {
        await openExternal(SETTINGS[params.resource]);
        return { opened: true };
      }
      let result;
      try { result = await native.invoke(operation, params, { signal }); }
      catch (error) {
        if (operation !== "status") throw error;
        return { available: false, errorCode: "APPLE_DEVICE_UNAVAILABLE",
          resources: APPLE_DEVICE_RESOURCES.map(id => ({ id, authorization: "unavailable" })) };
      }
      try {
        if (operation === "status" || operation === "requestAccess") {
          result = { available: true, errorCode: null,
            resources: APPLE_DEVICE_RESOURCES.map(id => ({ id, authorization: result[id] })) };
        }
        return validateAppleDeviceInvokeResult(operation, result);
      }
      catch { throw unavailable(); }
    },
  };
}

module.exports = { createAppleDeviceHost, SETTINGS };
