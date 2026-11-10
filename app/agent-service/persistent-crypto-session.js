"use strict";

const path = require("node:path");
const { FrameReader, decodeRequest, frame } = require("./crypto-worker-channel");
const { cryptoError } = require("./mcp-crypto-protocol");
const { ensurePrivateDirectoryTree } = require("./security");

async function runPersistentCryptoSession({ gate, electronApp, input = process.stdin, output = process.stdout,
  createStorage, perform, writeFrame, getParentPid = () => process.ppid, testStallMs = 0 }) {
  if (gate.callerRole !== "agent-service") throw cryptoError();
  let sequence = 0, queued = 0, ended = false, stopped = false, safeStorage = null, pathsKey = null;
  let tail = Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => {
      if (stopped) return;
      stopped = true; reader.clear();
      input.off("data", receive); input.off("end", end); input.off("error", fail);
      output.off("error", fail);
      try { safeStorage?.close?.(); } catch {}
      if (error) reject(cryptoError()); else resolve();
      if (typeof electronApp.exit === "function") electronApp.exit(error ? 1 : 0);
      else electronApp.quit();
    };
    const fail = () => finish(cryptoError());
    const reader = new FrameReader(body => {
      if (stopped || ended || queued >= 2 || getParentPid() !== gate.parentPid) throw cryptoError();
      const item = decodeRequest(body, gate, ++sequence);
      const key = JSON.stringify(item.request.paths);
      if (pathsKey !== null && key !== pathsKey) { item.payload.fill(0); throw cryptoError(); }
      pathsKey = key; queued += 1;
      tail = tail.then(async () => {
        try {
          if (stopped || getParentPid() !== gate.parentPid) throw cryptoError();
          if (!safeStorage) {
            const paths = item.request.paths;
            const userData = path.join(paths.profileDir, "mcp-crypto-worker");
            const sessionData = path.join(userData, "session");
            const cache = path.join(paths.cacheDir, "mcp-crypto-worker");
            for (const directory of [userData, sessionData, cache]) ensurePrivateDirectoryTree(directory, paths.trustedRoot);
            electronApp.setPath("userData", userData); electronApp.setPath("sessionData", sessionData); electronApp.setPath("cache", cache);
            await electronApp.whenReady();
            if (stopped || getParentPid() !== gate.parentPid) throw cryptoError();
            electronApp.setActivationPolicy?.("accessory");
            safeStorage = createStorage(paths);
          }
          if (Number.isSafeInteger(testStallMs) && testStallMs >= 10 && testStallMs <= 10_000) {
            await new Promise(resolve => setTimeout(resolve, testStallMs));
          }
          const raw = await perform({ ...item, safeStorage });
          let encoded;
          try { encoded = frame(raw); } finally { raw.fill(0); }
          await writeFrame(output, encoded);
        } finally { item.payload.fill(0); queued -= 1; }
      }).then(() => { if (ended && !queued) finish(); }, fail);
    }, fail);
    const receive = chunk => { reader.push(chunk); if (Buffer.isBuffer(chunk)) chunk.fill(0); };
    const end = () => { ended = true; if (reader.bytes.length) fail(); else if (!queued) finish(); };
    input.on("data", receive); input.once("end", end); input.on("error", fail); output.on("error", fail);
  });
}

module.exports = { runPersistentCryptoSession };
