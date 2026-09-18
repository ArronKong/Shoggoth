#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const {
  compareVersions,
  buildVersionSummary,
  fetchOfficialLatestVersions,
} = require("../app/core/version-checker");
const { BackendRegistry } = require("../app/core/backend-registry");
const { HermesBackend } = require("../app/core/hermes-backend");

async function startHermesDashboard(initialBehind) {
  let behind = initialBehind;
  let updateCalls = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/status") {
      res.end(JSON.stringify({ version: "0.20.4" }));
      return;
    }
    if (req.url?.startsWith("/api/hermes/update/check")) {
      updateCalls += 1;
      res.end(JSON.stringify({
        current_version: "0.20.4",
        behind,
        update_available: typeof behind === "number" && behind !== 0,
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    get updateCalls() { return updateCalls; },
    setBehind(value) { behind = value; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  assert.equal(compareVersions("2026.6.9", "2026.6.10"), -1, "date-style OpenClaw version sorts numerically");
  assert.equal(compareVersions("v0.17.0", "0.17.0"), 0, "leading v is ignored");
  assert.equal(compareVersions("0.16.9", "0.17.0"), -1, "semver-style Hermes version sorts numerically");
  assert.equal(compareVersions("control-ui", "2026.6.10"), null, "unparseable versions do not create false updates");

  const latest = await fetchOfficialLatestVersions({
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes("npmjs")
          ? { version: "2026.6.10" }
          : {
              name: "Hermes Agent v0.21.0 (v2026.8.31)",
              tag_name: "v2026.8.31",
            },
    }),
  });
  assert.deepEqual(latest, {
    openclaw: {
      latest: "2026.6.10",
      source: "npm",
      releaseNotesUrl: "https://github.com/openclaw/openclaw/releases",
    },
    hermes: {
      latest: "0.21.0",
      source: "github",
      releaseNotesUrl: "https://github.com/NousResearch/hermes-agent/releases",
    },
  });

  assert.deepEqual(
    buildVersionSummary({
      current: "2026.6.9",
      latest: "2026.6.10",
      currentSource: "gateway",
      latestSource: "npm",
      releaseNotesUrl: "https://github.com/openclaw/openclaw/releases",
    }),
    {
      current: "2026.6.9",
      latest: "2026.6.10",
      updateAvailable: true,
      currentSource: "gateway",
      latestSource: "npm",
      releaseNotesUrl: "https://github.com/openclaw/openclaw/releases",
    },
  );

  const localDashboard = await startHermesDashboard(12);
  const remoteCurrent = await startHermesDashboard(0);
  const remoteUnknown = await startHermesDashboard(null);
  try {
    const localBackend = new HermesBackend({
      getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }),
    });
    localBackend.dashboards = new Map([
      ["default", { profile: "default", port: 9119, baseUrl: localDashboard.baseUrl, token: "local" }],
      ["coder", { profile: "coder", port: 9120, baseUrl: localDashboard.baseUrl, token: "local" }],
    ]);
    const localVersion = await localBackend.getVersionInfo();
    assert.equal(localDashboard.updateCalls, 1, "local profiles sharing one install check upstream once");
    assert.equal(localVersion.current, "0.20.4");
    assert.equal(localVersion.latest, undefined, "registry supplies the display version");
    assert.equal(localVersion.updateAvailable, true);
    assert.equal(localVersion.dashboards.every((row) => row.updateAvailable === true), true);
    localBackend._selfUpdater = {
      run: () => ({ running: true }),
      status: () => ({ running: false }),
    };
    assert.deepEqual(localBackend.runSelfUpdate(), {
      supported: true,
      actions: ["update"],
      status: { running: true },
    });
    assert.deepEqual(localBackend.getSelfUpdateStatus(), {
      supported: true,
      actions: ["update"],
      status: { running: false },
    });

    const remoteBackend = new HermesBackend({
      getConfig: () => ({ hermesMode: "remote", hermesRemotes: [] }),
    });
    remoteBackend.dashboards = new Map([
      ["current", { profile: "current", port: 0, baseUrl: remoteCurrent.baseUrl, token: "current" }],
      ["unknown", { profile: "unknown", port: 0, baseUrl: remoteUnknown.baseUrl, token: "unknown" }],
    ]);
    const incompleteRemote = await remoteBackend.getVersionInfo();
    assert.equal(incompleteRemote.updateAvailable, undefined, "partial remote failure does not claim up-to-date");
    assert.equal(incompleteRemote.dashboards.find((row) => row.profile === "current")?.updateAvailable, false);
    assert.equal(incompleteRemote.dashboards.find((row) => row.profile === "unknown")?.updateAvailable, undefined);
    const mergedIncompleteRemote = BackendRegistry.prototype._mergeVersionRow(incompleteRemote, {
      latest: "0.19.0",
      source: "pypi",
    });
    assert.equal(
      mergedIncompleteRemote.updateAvailable,
      undefined,
      "registry preserves an incomplete authoritative dashboard comparison",
    );

    remoteUnknown.setBehind(-1);
    const availableRemote = await remoteBackend.getVersionInfo();
    assert.equal(availableRemote.updateAvailable, true, "unknown commit count sentinel still means update available");
    assert.equal(remoteCurrent.updateCalls, 2, "remote installs are checked independently");
    assert.equal(remoteUnknown.updateCalls, 2, "remote installs are checked independently");
  } finally {
    await Promise.all([localDashboard.close(), remoteCurrent.close(), remoteUnknown.close()]);
  }

  assert.deepEqual(
    buildVersionSummary({ current: "0.17.0", latest: "0.17.0", currentSource: "dashboard", latestSource: "pypi" }),
    {
      current: "0.17.0",
      latest: "0.17.0",
      updateAvailable: false,
      currentSource: "dashboard",
      latestSource: "pypi",
    },
  );

  const registry = new BackendRegistry();
  registry.register({
    id: "openclaw",
    name: "OpenClaw",
    getVersionInfo: async () => ({ id: "openclaw", name: "OpenClaw", current: "2026.6.9", currentSource: "gateway" }),
  });
  registry.register({
    id: "hermes",
    name: "Hermes",
    getVersionInfo: async () => ({
      id: "hermes",
      name: "Hermes",
      current: "0.20.4",
      updateAvailable: true,
      currentSource: "dashboard",
      dashboards: [{
        profile: "default",
        connected: true,
        current: "0.20.4",
        updateAvailable: true,
      }],
    }),
  });
  registry.register({
    id: "shoggoth",
    name: "Shoggoth",
    getVersionInfo: async () => ({
      id: "shoggoth",
      name: "Shoggoth",
      current: "0.8.41",
      currentSource: "desktop",
      comparisonSupported: false,
    }),
  });
  const versions = await registry.getVersions({
    latest: {
      openclaw: {
        latest: "2026.6.10",
        source: "npm",
        releaseNotesUrl: "https://github.com/openclaw/openclaw/releases",
      },
      hermes: {
        latest: "0.21.0",
        source: "github",
        releaseNotesUrl: "https://github.com/NousResearch/hermes-agent/releases",
      },
    },
  });
  const openclawRow = versions.find((v) => v.id === "openclaw");
  assert.equal(openclawRow?.updateAvailable, true);
  assert.equal(
    openclawRow?.releaseNotesUrl,
    "https://github.com/openclaw/openclaw/releases",
    "release notes url flows through registry merge",
  );
  const hermes = versions.find((v) => v.id === "hermes");
  assert.equal(hermes?.latest, "0.21.0", "GitHub latest release supplies the display version");
  assert.equal(hermes?.updateAvailable, true);
  assert.equal(hermes?.dashboards?.[0]?.updateAvailable, true);
  assert.equal(hermes?.dashboards?.[0]?.latest, "0.21.0");
  assert.equal(hermes?.latestSource, "github");
  assert.equal(hermes?.releaseNotesUrl, "https://github.com/NousResearch/hermes-agent/releases");
  assert.deepEqual(versions.find((v) => v.id === "shoggoth"), {
    id: "shoggoth",
    name: "Shoggoth",
    current: "0.8.41",
    currentSource: "desktop",
    comparisonSupported: false,
  });

  console.log("[version-check-unit] PASS");
}

main().catch((err) => {
  console.error("[version-check-unit] FAIL");
  console.error(err);
  process.exit(1);
});
