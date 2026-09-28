#!/usr/bin/env node
"use strict";

// Check the same extraResources matcher used by electron-builder before a
// release build. A filtered source file would invalidate the frozen catalog
// inside the App even when the source checkout itself is correct.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { FileMatcher } = require("app-builder-lib/out/fileMatcher");
const { BundledPluginCatalog } = require("../app/core/bundled-plugin-catalog");

const repo = path.resolve(__dirname, "..");
const config = yaml.load(fs.readFileSync(path.join(repo, "electron-builder.yml"), "utf8"));
const entries = config.extraResources.filter(item => item.to === "bundled-plugins");
assert.equal(entries.length, 1, "exactly one bundled plugin resource mapping is required");
const entry = entries[0];
assert.equal(entry.from, "resources/bundled-plugins");
const source = path.join(repo, entry.from);
const directEntries = config.extraResources.filter(item =>
  item.to === "bundled-plugins/packages/temporal/assets/.gitkeep");
assert.equal(directEntries.length, 1, "Temporal's frozen .gitkeep needs one direct file mapping");
assert.equal(directEntries[0].from,
  "resources/bundled-plugins/packages/temporal/assets/.gitkeep");
assert.equal(fs.lstatSync(path.join(repo, directEntries[0].from)).isFile(), true);
const directRelative = path.relative(source, path.join(repo, directEntries[0].from))
  .split(path.sep).join("/");
const catalog = new BundledPluginCatalog(source);
const matcher = new FileMatcher(source, path.join(repo, ".artifacts", "bundled-filter-test"),
  value => value, entry.filter ?? ["**/*"]).createFilter();
const files = [];
function visit(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const target = path.join(directory, name);
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), false, `symlink in frozen resources: ${target}`);
    if (name === ".gitkeep") {
      const relative = path.relative(source, target).split(path.sep).join("/");
      // builder-util's directory walker skips .gitkeep before the matcher.
      assert.equal(relative, directRelative, "new .gitkeep needs a direct file mapping");
      files.push(relative);
      continue;
    }
    assert.equal(matcher(target, stat), true,
      `electron-builder extraResources would omit ${path.relative(source, target)}`);
    if (stat.isDirectory()) visit(target);
    else {
      assert.equal(stat.isFile(), true);
      files.push(path.relative(source, target).split(path.sep).join("/"));
    }
  }
}
visit(source);
const packages = [...catalog.entries.values()];
for (const item of packages) catalog.assertCurrent(item.id);
assert.equal(files.length, 1 + packages.reduce((sum, item) => sum + item.fileCount, 0),
  "resource mapping must include exactly the catalog and its frozen package files");
assert.deepEqual(files.filter(file => path.posix.basename(file) === ".npmrc"),
  ["packages/product-design/templates/prototype/.npmrc"],
  "new npm configuration must be individually reviewed before bundling");
const excluded = new FileMatcher(source, path.join(repo, ".artifacts", "bundled-filter-test"),
  value => value, ["**/*", "!**/.npmrc"]).createFilter();
const templateNpmrc = path.join(source, "packages/product-design/templates/prototype/.npmrc");
assert.equal(excluded(templateNpmrc, fs.lstatSync(templateNpmrc)), false,
  "the frozen template must not be lost to an unqualified npmrc exclusion");
process.stdout.write(`Bundled extraResources filter retains ${packages.length} packages and ${files.length} files\n`);
