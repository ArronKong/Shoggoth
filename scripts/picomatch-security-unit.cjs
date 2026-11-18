"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { advisory, pico, playwright, secureInstall, verifyPackagedMatcher } = require("./picomatch-security.cjs");
const { evaluateAudit, PICOMATCH_REVIEW_EXPIRES } = require("./dependency-audit-policy.cjs");
const repo = path.resolve(__dirname, "..");
const ui = path.join(repo, "app/manage-ui");

// Use only the locked upstream bytes, regardless of whether npm ran postinstall.
function original(target, bytes) {
  const text = bytes.toString("utf8").replace(/^ *\/\/ Shoggoth security backport[^\n]*\n[\s\S]*?^ *\}\n/mu, "");
  assert.equal(createHash("sha256").update(text).digest("hex"), target.original);
  return text;
}

function fixture(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-glob-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(source, "package-lock.json"), path.join(dir, "package-lock.json"));
  for (const target of source === repo ? [pico, playwright] : [pico]) {
    const location = "node_modules/" + target.name;
    for (const relative of [target.file, ...Object.keys(target.unchanged)]) {
      const file = path.join(dir, location, relative);
      const bytes = fs.readFileSync(path.join(source, location, relative));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, relative === target.file ? original(target, bytes) : bytes);
    }
  }
  return dir;
}

function checkMatcher(match) {
  assert.equal(match("**/*.{ts,tsx}")("src/feature.ts"), true);
  assert.equal(match("+(ab).js")("abab.js"), true);
  assert.equal(match("+(js|ts)")("js"), true);
  assert.equal(match("!(*.test).js")("main.js"), true);
  assert.equal(match("*.js", { ignore: ["*.test.js"] })("a.test.js"), false);
  // Parse only. The rejection must happen before a RegExp or matcher exists.
  for (const pattern of ["src/+(part*end).js", "src/*(part*end).js"]) {
    for (const options of [{}, { fastpaths: false, maxExtglobRecursion: false }]) {
      assert.throws(() => match.makeRe(pattern, options), /Unsupported wildcard in repeated/u);
      assert.throws(() => match.parse(pattern, options), /Unsupported wildcard in repeated/u);
    }
  }
}

test("locked installs repair both package entry points and the embedded Playwright parser", t => {
  for (const scope of [repo, ui]) {
    const dir = fixture(t, scope);
    assert.throws(() => secureInstall(dir), /Missing reviewed patch/u);
    secureInstall(dir, { apply: true });
    secureInstall(dir, { apply: true });
    secureInstall(dir);
    const folder = path.join(dir, "node_modules/picomatch");
    for (const entry of ["index.js", "posix.js"]) checkMatcher(require(path.join(folder, entry)));
    if (scope === repo) {
      // Expose the embedded matcher to this process only. All imports resolve
      // against the real locked Playwright installation.
      const filename = path.join(repo, "node_modules/playwright", playwright.file);
      const compiled = new Module(filename, module);
      compiled.filename = filename;
      compiled.paths = Module._nodeModulePaths(path.dirname(filename));
      compiled._compile(fs.readFileSync(path.join(dir, "node_modules/playwright", playwright.file), "utf8")
        + "\nmodule.exports = require_picomatch2();\n", filename);
      checkMatcher(compiled.exports);
    }
  }
});

function uiReport() {
  const reported = (name, via) => ({ severity: "high", nodes: ["node_modules/" + name], via });
  const vulnerabilities = {};
  for (const [name, causes] of Object.entries({
    picomatch: [{ name: "picomatch", dependency: "picomatch", url: advisory, source: 1247710, range: "<=4.0.7", severity: "high" }],
    fdir: ["picomatch"], tinyglobby: ["fdir", "picomatch"], vite: ["picomatch", "tinyglobby"], "@vitejs/plugin-react": ["vite"],
  })) vulnerabilities[name] = reported(name, causes);
  return { auditReportVersion: 2, vulnerabilities };
}

test("the raw finding requires read-only proof for the entire pinned graph", t => {
  const root = fixture(t, ui), options = { root, now: PICOMATCH_REVIEW_EXPIRES - 1 };
  const decision = (report = uiReport(), context = options) => evaluateAudit(report, context);
  assert.equal(decision().passed, false);
  secureInstall(root, { apply: true });
  assert.equal(decision().passed, true);
  assert.equal(decision().patchedBuildRecords.length, 5);
  assert.equal(decision(uiReport(), { ...options, now: PICOMATCH_REVIEW_EXPIRES }).passed, false);
  for (const mutate of [
    r => r.picomatch.via.push({ url: advisory + "-other" }),
    r => { r.picomatch.via[0].range = "*"; },
    r => { r.vite.severity = "critical"; },
    r => r.vite.via.push("unknown"),
    r => r.fdir.nodes.push("node_modules/x/node_modules/fdir"),
    r => { r.newConsumer = { severity: "moderate", via: ["picomatch"] }; },
  ]) {
    const report = uiReport(); mutate(report.vulnerabilities);
    assert.equal(decision(report).passed, false);
  }
  const lockfile = path.join(root, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockfile));
  lock.packages["node_modules/picomatch"].dev = false;
  fs.writeFileSync(lockfile, JSON.stringify(lock));
  assert.equal(decision().passed, false);
  lock.packages["node_modules/picomatch"].dev = true;
  lock.packages["node_modules/another/node_modules/picomatch"] = lock.packages["node_modules/picomatch"];
  fs.writeFileSync(lockfile, JSON.stringify(lock));
  assert.equal(decision().passed, false);
});

test("unknown or substituted sources fail closed and a signed candidate must contain the patched bytes", async t => {
  const dir = fixture(t, repo);
  const file = path.join(dir, "node_modules/playwright", playwright.file);
  const bytes = fs.readFileSync(file);
  fs.appendFileSync(file, "\n");
  assert.throws(() => secureInstall(dir, { apply: true }), /unexpected bytes/u);
  fs.writeFileSync(file, bytes);
  secureInstall(dir, { apply: true });
  const appPath = path.join(dir, "fixture.app");
  const resources = path.join(appPath, "Contents/Resources");
  const source = path.join(dir, "asar-input");
  const relative = "node_modules/playwright/" + playwright.file;
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
  fs.copyFileSync(file, path.join(source, relative));
  const { createPackageWithOptions } = require("@electron/asar");
  const archive = path.join(resources, "app.asar");
  await createPackageWithOptions(source, archive, { unpack: "**/*.js" });
  verifyPackagedMatcher(appPath);
  fs.writeFileSync(path.join(archive + ".unpacked", relative), bytes);
  assert.throws(() => verifyPackagedMatcher(appPath), /missing its reviewed picomatch patch/u);
});
