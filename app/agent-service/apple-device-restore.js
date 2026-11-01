"use strict";

const path = require("node:path");
const { lstatIfExists, serviceError } = require("./security");
const { readPrivateFile, atomicWritePrivateFile } = require("./private-file");
const { APPLE_DEVICE_RESOURCES, validateAppleDevicePolicyState } = require("../core/apple-device-contract");

// System consent belongs to a live Mac/App identity. Restoring a backup never
// reconnects its devices; reading/writing choices and no-replay receipts stay.
function quarantineAppleDevicePolicyForRestore({ paths }) {
  const file = path.join(paths.stateDir, "apple-device-policy.json");
  if (!lstatIfExists(file)) return { disconnected: 0 };
  let state;
  try {
    state = validateAppleDevicePolicyState(JSON.parse(readPrivateFile(file, { maxBytes: 1024 * 1024 })));
  } catch { throw serviceError("APPLE_DEVICE_POLICY_CORRUPT", "备份中的设备连接策略无效"); }
  const disconnected = APPLE_DEVICE_RESOURCES.filter(id => state.resources[id].enabled).length;
  if (disconnected) {
    if (state.revision >= Number.MAX_SAFE_INTEGER) throw serviceError("APPLE_DEVICE_POLICY_CORRUPT", "设备连接策略版本已达到上限");
    for (const id of APPLE_DEVICE_RESOURCES) state.resources[id].enabled = false;
    state.revision += 1;
    atomicWritePrivateFile(file, `${JSON.stringify(state)}\n`, { trustedRoot: paths.trustedRoot });
  }
  return { disconnected };
}

module.exports = { quarantineAppleDevicePolicyForRestore };
