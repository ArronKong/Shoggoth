"use strict";

const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const {
  createCuaSdkLoader,
  resolveCuaSdkSpecifier,
} = require("../app/cua-sdk-loader");

assert.equal(resolveCuaSdkSpecifier({ packaged: false }), "@trycua/cua-driver");
const expected = pathToFileURL(path.join(
  "/Applications/Shoggoth.app/Contents/Resources",
  "app.asar.unpacked/node_modules/@trycua/cua-driver/dist/index.js",
)).href;
assert.equal(resolveCuaSdkSpecifier({
  packaged: true, resourcesPath: "/Applications/Shoggoth.app/Contents/Resources",
}), expected);
assert.throws(() => resolveCuaSdkSpecifier({ packaged: true, resourcesPath: "relative" }), TypeError);
const imports = [];
const loader = createCuaSdkLoader({
  packaged: true,
  resourcesPath: "/Applications/Shoggoth.app/Contents/Resources",
  importer: async (specifier) => { imports.push(specifier); return { loaded: true }; },
});
(async () => {
  assert.deepEqual(await loader(), { loaded: true });
  assert.deepEqual(imports, [expected]);
  console.log("Cua SDK loader unit: PASS (packaged physical path, source package specifier)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
