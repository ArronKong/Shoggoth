"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

function resolveCuaSdkSpecifier(options = {}) {
  if (options.packaged !== true) return "@trycua/cua-driver";
  if (typeof options.resourcesPath !== "string" || !path.isAbsolute(options.resourcesPath)) {
    throw new TypeError("packaged Cua SDK requires an absolute resourcesPath");
  }
  return pathToFileURL(path.join(
    options.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@trycua",
    "cua-driver",
    "dist",
    "index.js",
  )).href;
}

function createCuaSdkLoader(options = {}) {
  const specifier = resolveCuaSdkSpecifier(options);
  const importer = options.importer || ((target) => import(target));
  if (typeof importer !== "function") throw new TypeError("Cua SDK importer is invalid");
  return () => importer(specifier);
}

module.exports = { createCuaSdkLoader, resolveCuaSdkSpecifier };
