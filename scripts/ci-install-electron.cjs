"use strict";

const { setTimeout: sleep } = require("node:timers/promises");

const retryDelaysMs = [15_000, 45_000, 120_000];
const transientStatuses = new Set([502, 503, 504]);

function retryElectronDownload(version, fetcher, { pause = sleep, log = console.log } = {}) {
  const origin = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-`;
  const archives = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]
    .map(target => `${origin}${target}.zip`));

  return async (url, options) => {
    if (!archives.has(url) || (options?.method ?? "GET").toUpperCase() !== "GET") {
      return fetcher(url, options);
    }
    // Retry the download response before Electron reads or extracts any bytes.
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(url, options);
      const delay = retryDelaysMs[attempt];
      if (delay === undefined || !transientStatuses.has(response.status)) return response;
      await response.body?.cancel();
      log(`Electron ${version} download returned HTTP ${response.status}. Retrying in ${delay / 1000}s (attempt ${attempt + 2}/${retryDelaysMs.length + 1}).`);
      await pause(delay, undefined, { signal: options?.signal });
    }
  };
}

if (require.main === module) {
  const { version } = require("../node_modules/electron/package.json");
  globalThis.fetch = retryElectronDownload(version, globalThis.fetch);
  // The locked installer still chooses the archive, verifies checksums, and extracts it.
  require("../node_modules/electron/install.js");
}

module.exports = { retryElectronDownload };
