"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const builder = yaml.load(fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
assert.deepEqual(builder.publish, {
  provider: "github",
  owner: "ArronKong",
  repo: "Shoggoth",
  releaseType: "draft",
});
for (const moduleName of ["electron-updater", "builder-util-runtime", "fs-extra", "tiny-typed-emitter"]) {
  assert.ok(builder.files.includes(`node_modules/${moduleName}/**/*`), `${moduleName} must be packaged`);
}
assert.ok(builder.mac.target.some((target) => target.target === "zip"
  && target.arch.includes("arm64") && target.arch.includes("x64")));

const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
for (const contract of [
  /REPOSITORY_VISIBILITY[\s\S]*"public"/u,
  /SHOGGOTH_CODESIGN_MODE:\s*developer-id/u,
  /SHOGGOTH_EXPECT_NOTARIZED:\s*"1"/u,
  /electron-builder --mac --publish always/u,
  /verify-app-update-release\.mjs/u,
  /shoggoth-packaged-runtime-smoke\.mjs --spike/u,
  /gh release view[\s\S]*isDraft/u,
  /gh release edit[\s\S]*--draft=false/u,
]) assert.match(workflow, contract);
assert.ok(workflow.indexOf("verify-app-update-release.mjs") < workflow.indexOf("--draft=false"),
  "release must be verified before draft promotion");

console.log("App update release contract unit: PASS");
