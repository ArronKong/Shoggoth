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
assert.equal(release.jobs.build.environment, "macos-signing");
assert.equal(release.jobs.build.env.DEVELOPER_DIR, "/Applications/Xcode_26.3.app/Contents/Developer");
const buildSteps = release.jobs.build.steps;
const importStep = buildSteps.find(step => step.name === "Import Developer ID certificate and Notary credentials");
const packageStepIndex = buildSteps.findIndex(step => step.run === "node scripts/release-build.cjs");
assert.ok(buildSteps.indexOf(importStep) < packageStepIndex, "Signing readiness must fail before packaging");
assert.match(importStep.run, /'find-identity', '-v', '-p', 'codesigning'/u);
assert.match(importStep.run, /codesign --verify --strict/u);
assert.match(importStep.run, /shoggoth-keychain-search-list\.json/u);
assert.doesNotMatch(importStep.run, /add-trusted-cert|trustRoot|trustAsRoot/u);
const cleanupStep = buildSteps.find(step => step.name === "Remove temporary signing credentials");
assert.equal(cleanupStep.if, "always()");
assert.match(cleanupStep.run, /'list-keychains', '-d', 'user', '-s'/u);
assert.match(cleanupStep.run, /security delete-keychain/u);
for (const workflowName of ["release.yml", "verify-signed-draft.yml", "ci.yml"]) {
  const parsed = yaml.load(fs.readFileSync(path.join(root, ".github/workflows", workflowName), "utf8"));
  for (const job of Object.values(parsed.jobs)) for (const step of job.steps || []) {
    if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/u, "Release actions must pin immutable commits");
  }
}
assert.match(workflow, /node scripts\/release-build\.cjs/u);
const build = fs.readFileSync(path.join(root, "scripts/release-build.cjs"), "utf8");
for (const gate of ["electron-builder", '"--publish", "never"', "shoggoth-host-capability-coverage-unit.cjs", "shoggoth-source-parity.cjs",
  "verify-app-update-release.mjs", "create-macos-dmg.mjs", "buildNotarytoolArgs",
  "assertAcceptedReceipt(result)", '"stapler", "staple"', '"stapler", "validate"',
  '"/usr/bin/hdiutil", ["verify"', "recordBuild("]) assert.ok(build.includes(gate));
assert.match(workflow, /release-draft\.cjs confirm/u);
assert.doesNotMatch(workflow, /--draft=false|--publish always|--clobber/u);
const native = yaml.load(fs.readFileSync(path.join(root, ".github/workflows/verify-signed-draft.yml"), "utf8"));
assert.ok(native.on.workflow_dispatch && native.on.workflow_call);
const nativeSteps = native.jobs.macos.steps.map(step => step.run || "").join("\n");
for (const gate of ["shoggoth-packaged-runtime-smoke.mjs", "shoggoth-memory-e5-packaged.cjs",
  "shoggoth-quarantined-first-launch.cjs", "stapler validate", "codesign --verify --deep --strict",
  "verify-app-update-release.mjs", "spctl --assess", "hdiutil verify"]) assert.ok(nativeSteps.includes(gate));
console.log("App update release contract unit: PASS");
