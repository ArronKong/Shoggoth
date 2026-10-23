#!/usr/bin/env node
"use strict";

// The App must carry exactly the active catalog and its nine package trees.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { FileMatcher } = require("app-builder-lib/out/fileMatcher");
const { BundledPluginCatalog } = require("../app/core/bundled-plugin-catalog");

const repo = path.resolve(__dirname, "..");
const config = yaml.load(fs.readFileSync(path.join(repo, "electron-builder.yml"), "utf8"));
const scope = JSON.parse(fs.readFileSync(path.join(repo,
  "docs/architecture/bundled-plugin-scope-2026-10-02.json"), "utf8"));
const source = path.join(repo, "resources/bundled-plugins");
const catalog = new BundledPluginCatalog(source);
const ids = catalog.list().items.map(item => item.id);
assert.deepEqual([...ids].sort(), [...scope.activePackageIds].sort());
for (const item of scope.hiddenPackages) {
  assert.equal(fs.existsSync(path.join(source, "packages", item.id)), true,
    `hidden source must remain recorded: ${item.id}`);
  assert.equal(catalog.get(item.id), null, `hidden package must not enter the App catalog: ${item.id}`);
}
for (const item of scope.removedProprietaryPackages) {
  assert.equal(fs.existsSync(path.join(source, "packages", item.id)), false,
    `proprietary source must be removed: ${item.id}`);
  assert.equal(catalog.get(item.id), null);
}
const mappings = config.extraResources.filter(item =>
  typeof item.to === "string" && (item.to === "bundled-plugins"
    || item.to.startsWith("bundled-plugins/")));
assert.deepEqual(mappings.map(item => item.to).sort(), [
  "bundled-plugins/catalog.json",
  ...ids.map(id => `bundled-plugins/packages/${id}`),
].sort(), "App resource mappings must include only active packages");

const files = [];
for (const mapping of mappings) {
  const relative = path.posix.relative("bundled-plugins", mapping.to);
  const from = path.join(repo, mapping.from);
  const stat = fs.lstatSync(from);
  assert.equal(stat.isSymbolicLink(), false);
  if (stat.isFile()) {
    assert.equal(relative, "catalog.json");
    files.push(relative);
    continue;
  }
  assert.equal(stat.isDirectory(), true);
  const matcher = new FileMatcher(from, path.join(repo, ".artifacts", "bundled-filter-test"),
    value => value, mapping.filter ?? ["**/*"]).createFilter();
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const current = fs.lstatSync(target);
      assert.equal(current.isSymbolicLink(), false, `unsafe resource: ${target}`);
      assert.equal(name === ".gitkeep", false, `electron-builder skips .gitkeep: ${target}`);
      assert.equal(matcher(target, current), true, `builder would omit ${target}`);
      if (current.isDirectory()) visit(target);
      else {
        assert.equal(current.isFile(), true);
        files.push(path.posix.join(relative, path.relative(from, target).split(path.sep).join("/")));
      }
    }
  }
  visit(from);
}
for (const id of ids) catalog.assertCurrent(id);
assert.equal(files.length, 1 + [...catalog.entries.values()].reduce((sum, item) => sum + item.fileCount, 0));
assert.equal(files.some(file => file.endsWith("/.npmrc")), false);
assert.equal(files.some(file => scope.hiddenPackages.some(item => file.startsWith(`packages/${item.id}/`))), false);
assert.equal(files.some(file => scope.removedProprietaryPackages.some(item => file.startsWith(`packages/${item.id}/`))), false);
process.stdout.write(`Bundled App resources contain ${ids.length} packages and ${files.length} files\n`);
