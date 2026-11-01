"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { evaluateAudit, ADVISORY, REVIEW_EXPIRES } = require("./dependency-audit-policy.cjs");
const root = path.resolve(__dirname, "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const legacy = Object.entries(lock.packages).find(([name, pkg]) =>
  name.endsWith("/minimatch") && pkg.version === "3.1.5" && pkg.dev);
assert(legacy, "fixture requires the real locked legacy build dependency");
function fixture(t, version = "3.1.5") {
  const legacy = Object.entries(lock.packages).find(([name, pkg]) => name.endsWith("/minimatch") && pkg.version === version && pkg.dev);
  assert(legacy);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-audit-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const installed = path.join(directory, legacy[0]); fs.mkdirSync(installed, { recursive: true });
  for (const name of ["package.json", "minimatch.js"]) fs.copyFileSync(path.join(root, legacy[0], name), path.join(installed, name));
  fs.writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ packages: { [legacy[0]]: legacy[1] } }));
  const report = { auditReportVersion: 2, vulnerabilities: {
    minimatch: { severity: "moderate", range: "<11.0.1", nodes: [legacy[0]],
      via: [{ url: ADVISORY, name: "minimatch", severity: "moderate", range: "<11.0.1" }] },
    builder: { severity: "moderate", via: ["minimatch", "dmg"] },
    dmg: { severity: "moderate", via: ["builder"] },
  } };
  return { directory, installed, report, options: { root: directory, now: Date.parse("2026-11-02T00:00:00Z") } };
}
test("accepts only verified legacy sources and their cyclic meta-vulnerabilities", t => {
  const f = fixture(t); const result = evaluateAudit(f.report, f.options);
  assert.equal(result.passed, true); assert.equal(result.reviewedBuildRecords.length, 3);
});
test("other vulnerabilities still block every dependent", t => {
  const f = fixture(t); f.report.vulnerabilities.minimatch.via.push({ url: "https://example.invalid/new-advisory" });
  assert.deepEqual(new Set(evaluateAudit(f.report, f.options).unresolved), new Set(["minimatch", "builder", "dmg"]));
});
test("tampered or unknown-version package sources cannot use the exception", t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.installed, "minimatch.js"), "\n// changed\n");
  assert.equal(evaluateAudit(f.report, f.options).passed, false);
  const pkg = JSON.parse(fs.readFileSync(path.join(f.installed, "package.json"))); pkg.version = "10.2.6";
  fs.writeFileSync(path.join(f.installed, "package.json"), JSON.stringify(pkg));
  assert.equal(evaluateAudit(f.report, f.options).passed, false);
});
test("production dependencies cannot use the build exception", t => {
  const f = fixture(t); const changed = structuredClone(legacy[1]); delete changed.dev;
  fs.writeFileSync(path.join(f.directory, "package-lock.json"), JSON.stringify({ packages: { [legacy[0]]: changed } }));
  assert.equal(evaluateAudit(f.report, f.options).passed, false);
});
test("high severity, unknown edges, and unrelated cycles are rejected", t => {
  const f = fixture(t); f.report.vulnerabilities.builder.severity = "high";
  assert.equal(evaluateAudit(f.report, f.options).passed, false);
  f.report.vulnerabilities.builder = { severity: "moderate", via: ["missing"] };
  assert.equal(evaluateAudit(f.report, f.options).passed, false);
  delete f.report.vulnerabilities.minimatch;
  f.report.vulnerabilities.builder = { severity: "moderate", via: ["dmg"] };
  assert.equal(evaluateAudit(f.report, f.options).passed, false);
});
test("expired review requires a fresh decision while clean audits stay clean", t => {
  const f = fixture(t); assert.equal(evaluateAudit(f.report, { ...f.options, now: REVIEW_EXPIRES }).passed, false);
  assert.equal(evaluateAudit({ auditReportVersion: 2, vulnerabilities: {} }, { ...f.options, now: REVIEW_EXPIRES }).passed, true);
});
test("network errors and malformed reports do not become passes", t => {
  const f = fixture(t);
  assert.throws(() => evaluateAudit({ error: { code: "ENETUNREACH" } }, f.options));
  assert.throws(() => evaluateAudit({ auditReportVersion: 2, vulnerabilities: { unknown: { severity: "moderate", via: [] } } }, f.options));
});

test("the separately pinned legacy v5 source is verified as well", t => {
  const f = fixture(t, "5.1.9"); assert.equal(evaluateAudit(f.report, f.options).passed, true);
});
