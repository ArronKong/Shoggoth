"use strict";
const { readSingleJsonLineSync, performWorkerOperation, writeFrame } = require("../../app/mcp-crypto-worker");
const { runPersistentCryptoSession } = require("../../app/agent-service/persistent-crypto-session");
const mode = process.argv[2];
const storage = { isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => { if (!value.toString().startsWith("sealed:")) throw new Error(); return value.toString().slice(7); } };
runPersistentCryptoSession({
  gate: readSingleJsonLineSync(3),
  electronApp: { setPath() {}, whenReady: async () => {}, exit: code => process.exit(code) },
  createStorage: () => storage,
  perform: async input => {
    if (mode === "hang") return new Promise(() => {});
    const response = await performWorkerOperation(input);
    if (mode === "nonce") response[9] ^= 1;
    return response;
  }, writeFrame,
}).catch(() => process.exit(1));
