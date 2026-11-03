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
assert.deepEqual(Object.keys(yaml.load(workflow).on), ["workflow_dispatch"],
  "signed release must require a deliberate manual trigger");
const release = yaml.load(workflow);
assert.deepEqual(release.permissions, { contents: "read" });
assert.equal(release.concurrency.group, "shoggoth-release-${{ inputs.tag }}");
assert.equal(release.jobs.build.strategy["fail-fast"], false);
assert.deepEqual(release.jobs.build.strategy.matrix.include.map(row => [row.arch, row.runner]),
  [["arm64", "macos-latest"], ["x64", "macos-15-intel"]]);
assert.deepEqual(release.jobs.build.needs, ["validate", "source-ci"]);
assert.equal(release.jobs["source-ci"].uses, "./.github/workflows/ci.yml");
assert.equal(release.jobs["native-verification"].uses, "./.github/workflows/verify-signed-draft.yml");
assert.deepEqual(release.jobs["accepted-draft"].needs, ["validate", "draft", "native-verification"]);
assert.equal(release.jobs.build.env.SHOGGOTH_CODESIGN_MODE, "developer-id");
assert.equal(release.jobs.build.env.SHOGGOTH_EXPECT_NOTARIZED, "1");
assert.match(workflow, /electron-builder --mac zip --"\$BUILD_ARCH" --publish never/u);
assert.match(workflow, /shoggoth-source-parity\.cjs/u);
assert.match(workflow, /release-draft\.cjs confirm/u);
assert.doesNotMatch(workflow, /--draft=false|--publish always|--clobber/u);
const native = yaml.load(fs.readFileSync(path.join(root, ".github/workflows/verify-signed-draft.yml"), "utf8"));
assert.ok(native.on.workflow_dispatch && native.on.workflow_call);
const nativeSteps = native.jobs.macos.steps.map(step => step.run || "").join("\n");
for (const gate of ["shoggoth-packaged-runtime-smoke.mjs", "shoggoth-memory-e5-packaged.cjs",
  "shoggoth-quarantined-first-launch.cjs", "stapler validate", "codesign --verify --deep --strict",
  "verify-app-update-release.mjs", "spctl --assess", "hdiutil verify"]) assert.ok(nativeSteps.includes(gate));
console.log("App update release contract unit: PASS");
