"use strict";

// Packaging checks shared by the release preflight (before electron-builder)
// and the afterPack hook (App assembled, nothing signed yet). Internal builds
// run from development checkouts, so nothing here assumes a fresh `npm ci` or
// the public-source export. electron-builder exits 0 even when it drops
// transitive dependencies (symlinked node_modules) or frozen connector assets;
// either can leave an App that fails at runtime.
const fs = require("node:fs");
const path = require("node:path");
const { excludedClaudeSdkPaths, isClaudeSdkCliPackage } = require("./claude-sdk-distribution.cjs");

const REPO = path.resolve(__dirname, "..");
const NODE_MODULES = "node_modules/";

function lockPackages(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8")).packages;
}

function allows(list, value) {
  if (!Array.isArray(list)) return true;
  const positive = list.filter((item) => !item.startsWith("!"));
  return !list.includes(`!${value}`) && (positive.length === 0 || positive.includes(value));
}

function packageName(key) {
  return key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
}

/** Production packages for one platform/arch; other platforms' optional packages are skipped. */
function productionPackages(repo, { platform = "darwin", arch }, packages = lockPackages(repo)) {
  return Object.entries(packages)
    .filter(([key, entry]) => key.startsWith(NODE_MODULES) && !entry.dev && !entry.devOptional
      && (!entry.optional || (allows(entry.os, platform) && allows(entry.cpu, arch))))
    .map(([key, entry]) => ({
      key,
      name: packageName(key),
      version: entry.version,
      optional: Boolean(entry.optional),
    }));
}

function readVersion(manifest) {
  try { return JSON.parse(fs.readFileSync(manifest, "utf8")).version ?? null; } catch { return null; }
}

/** Preflight: node_modules is a real install matching the lockfile. */
function checkInstalledDependencies(repo = REPO, { arch = process.arch } = {}) {
  const root = path.join(repo, "node_modules");
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return ["node_modules is missing; run `npm ci --ignore-scripts`"];
  if (stat.isSymbolicLink()) {
    return ["node_modules is a symlink, which makes electron-builder drop transitive dependencies; "
      + "use a real directory (`npm ci --ignore-scripts`, or in a worktree "
      + "`unlink node_modules && cp -c -R <main checkout>/node_modules node_modules`)"];
  }
  const problems = [];
  for (const pkg of productionPackages(repo, { arch })) {
    const version = readVersion(path.join(repo, pkg.key, "package.json"));
    if (version === null) {
      if (!pkg.optional) problems.push(`${pkg.key} is not installed; run \`npm ci --ignore-scripts\``);
    } else if (version !== pkg.version) {
      problems.push(`${pkg.key} is ${version} but the lockfile requires ${pkg.version}; run \`npm ci --ignore-scripts\``);
    }
  }
  return problems;
}

// Builder hoists nested production copies, so a package counts as shipped when
// the same name@version exists anywhere in the App's node_modules.
function packagedVersions(appPath) {
  const asar = require("@electron/asar");
  const resources = path.join(appPath, "Contents", "Resources");
  const archive = path.join(resources, "app.asar");
  const found = new Set();
  for (const entry of asar.listPackage(archive)) {
    const name = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/u.exec(entry)?.[1];
    if (!name) continue;
    try {
      found.add(`${name}@${JSON.parse(asar.extractFile(archive, entry.replace(/^\//u, "")).toString("utf8")).version}`);
    } catch { /* A manifest that cannot be read does not count as shipped. */ }
  }
  const visit = (nodeModules) => {
    if (!fs.existsSync(nodeModules)) return;
    for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirs = entry.name.startsWith("@")
        ? fs.readdirSync(path.join(nodeModules, entry.name), { withFileTypes: true })
          .filter((child) => child.isDirectory()).map((child) => `${entry.name}/${child.name}`)
        : [entry.name];
      for (const name of dirs) {
        const version = readVersion(path.join(nodeModules, name, "package.json"));
        if (version !== null) found.add(`${name}@${version}`);
        visit(path.join(nodeModules, name, "node_modules"));
      }
    }
  };
  visit(path.join(resources, "app.asar.unpacked", "node_modules"));
  return found;
}

/** afterPack: check the distribution closure at locked versions. */
function checkPackagedDependencies(appPath, { repo = REPO, arch }) {
  const packages = lockPackages(repo);
  const excluded = excludedClaudeSdkPaths(packages);
  const required = productionPackages(repo, { arch }, packages).filter(pkg => !excluded.has(pkg.key));
  const requiredVersions = new Set(required.map(pkg => `${pkg.name}@${pkg.version}`));
  const excludedVersions = new Set([...excluded].map(key => `${packageName(key)}@${packages[key].version}`));
  const found = packagedVersions(appPath);
  const missing = required
    .filter((pkg) => !found.has(`${pkg.name}@${pkg.version}`))
    .map((pkg) => `${pkg.name}@${pkg.version} (${pkg.key}) is missing from the App`);
  const unexpected = [...found]
    .filter(id => isClaudeSdkCliPackage(id) || (excludedVersions.has(id) && !requiredVersions.has(id)))
    .map(id => `${id} must be excluded from the App`);
  return [...missing, ...unexpected];
}

/** Preflight: repository content the App ships passes the release gates. */
function checkPackagingInputs(repo = REPO) {
  const { scanDirectory } = require("./check-release-private-keys.cjs");
  const problems = [];
  for (const dir of ["resources", "schemas"]) {
    try { scanDirectory(path.join(repo, dir)); } catch (error) { problems.push(`${dir}: ${error.message}`); }
  }
  return [...problems, ...require("../app/external-plugin-adapter-protocol").checkAdapterProtocols(
    path.join(repo, "resources", "external-plugin-adapters")),
    ...require("./connector-package-checks.cjs").checkConnectorBuildInputs(repo)];
}

if (require.main === module) {
  const mode = process.argv[2];
  if (!["preflight", "inputs"].includes(mode) || process.argv.length !== 3) {
    console.error("Usage: node scripts/release-package-checks.cjs <preflight|inputs>");
    process.exitCode = 2;
  } else {
    if (mode === "preflight") require("./picomatch-security.cjs").secureInstall(REPO);
    const problems = mode === "preflight"
      ? [...checkInstalledDependencies(), ...checkPackagingInputs()]
      : checkPackagingInputs();
    if (problems.length) {
      console.error(`Release ${mode} failed:\n  - ${problems.join("\n  - ")}`);
      process.exitCode = 1;
    } else {
      console.log(`Release ${mode} checks passed`);
    }
  }
}

module.exports = {
  checkInstalledDependencies,
  checkPackagedDependencies,
  checkPackagingInputs,
  productionPackages,
};
