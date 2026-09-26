#!/usr/bin/env node
"use strict";

// Read-only comparison against the same filters/transformer electron-builder
// uses. Records the exact working-tree sources, including uncommitted files.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const asar = require("@electron/asar");
const { getMainFileMatchers } = require("app-builder-lib/out/fileMatcher");
const { createTransformer } = require("app-builder-lib/out/fileTransformer");
const source = path.resolve(__dirname, "..");

async function verify({ archive, output, arch }) {
  assert.ok(path.isAbsolute(archive) && path.isAbsolute(output), "absolute archive/output paths required");
  assert.ok(["arm64", "x64"].includes(arch), "supported architecture required");
  const config = require("js-yaml").load(fs.readFileSync(path.join(source, "electron-builder.yml"), "utf8"));
  const matcher = getMainFileMatchers(source, path.dirname(archive), value => value.replaceAll("${arch}", arch),
    config.mac, { info: { config, projectDir: source, buildResourcesDir: "build", isPrepackedAppAsar: false,
      debugLogger: { isEnabled: false } } }, path.dirname(path.dirname(path.dirname(archive))), false)[0];
  const filter = matcher.createFilter(), transform = createTransformer(source, config, null, null);
  const files = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile() && filter(file, stat)) files.push(file);
    }
  }
  walk(path.join(source, "app")); walk(path.join(source, "schemas")); files.push(path.join(source, "package.json"));
  const hashes = {};
  for (const file of files) {
    const relative = path.relative(source, file);
    const transformed = await transform(file);
    const expected = transformed == null ? fs.readFileSync(file) : Buffer.from(transformed);
    const packed = asar.extractFile(archive, relative);
    assert.equal(Buffer.compare(expected, packed), 0, `package/source mismatch: ${relative}`);
    hashes[relative] = crypto.createHash("sha256").update(packed).digest("hex");
  }
  for (const entry of asar.listPackage(archive)) {
    const relative = entry.replace(/^\//u, "");
    if ((relative.startsWith("app/") || relative.startsWith("schemas/")) && !asar.statFile(archive, relative).files) {
      assert.ok(hashes[relative], `unexpected packaged source: ${relative}`);
    }
  }
  const result = { version: 1, appVersion: require("../package.json").version, arch, source, archive,
    evidence: "package-source-parity", matchedFiles: files.length, usesElectronBuilderFilter: true,
    sourceSetSha256: crypto.createHash("sha256").update(JSON.stringify(hashes)).digest("hex"), hashes };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ matchedFiles: files.length, sourceSetSha256: result.sourceSetSha256, output }));
  return result;
}

if (require.main === module) {
  const [archive, output, arch = process.arch, ...extra] = process.argv.slice(2);
  Promise.resolve().then(() => {
    assert.equal(extra.length, 0, "usage: archive output [arm64|x64]");
    return verify({ archive, output, arch });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verify };
