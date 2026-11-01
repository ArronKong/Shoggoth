"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ADVISORY = "https://github.com/advisories/GHSA-g3hv-75wg-m249";
const REVIEW_EXPIRES = Date.parse("2026-11-16T00:00:00Z");
// The maintainer describes the optimizer introduced in modern minimatch.
// Keep the legacy callable API; these exact sources have no such optimizer.
// https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249
const LEGACY_SOURCES = Object.freeze({
  "3.1.5": "746849f267c4868a53729225bd85c7dccd387712136fb305fcc0a3eadd4a3d9d",
  "5.1.9": "1339bca8b70e33847860daa8fc3ccfa62487e143670da01a3b718d40d5fd424f",
});

function reviewedLegacyFinding(record, root, now) {
  if (now >= REVIEW_EXPIRES || record.severity !== "moderate"
    || record.range !== "<11.0.1" || record.via.length !== 1
    || !Array.isArray(record.nodes) || record.nodes.length === 0) return false;
  const advisory = record.via[0];
  if (!advisory || typeof advisory !== "object" || advisory.url !== ADVISORY
    || advisory.name !== "minimatch" || advisory.severity !== "moderate"
    || advisory.range !== "<11.0.1") return false;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    return record.nodes.every(location => {
      if (typeof location !== "string" || !location.startsWith("node_modules/")
        || location.split("/").includes("..") || !location.endsWith("/minimatch")) return false;
      const entry = lock.packages?.[location];
      const expectedHash = LEGACY_SOURCES[entry?.version];
      if (!expectedHash || entry.dev !== true || !entry.integrity?.startsWith("sha512-")) return false;
      const directory = fs.realpathSync(path.join(root, location));
      if (!directory.startsWith(fs.realpathSync(root) + path.sep)) return false;
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      if (pkg.name !== "minimatch" || pkg.version !== entry.version) return false;
      const file = path.join(directory, "minimatch.js");
      if (!fs.lstatSync(file).isFile()) return false;
      const source = fs.readFileSync(file);
      return crypto.createHash("sha256").update(source).digest("hex") === expectedHash
        && !/firstPhasePreProcess|secondPhasePreProcess|optimizationLevel/u.test(source.toString("utf8"));
    });
  } catch { return false; }
}

function evaluateAudit(report, { root, now = Date.now() }) {
  if (report?.error || report?.auditReportVersion !== 2 || !report.vulnerabilities
    || typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)) {
    throw new Error("DEPENDENCY_AUDIT_REPORT_INVALID");
  }
  const records = report.vulnerabilities;
  const blocked = new Set();
  const reviewed = new Set();
  const low = new Set();
  for (const [name, record] of Object.entries(records)) {
    if (!record || !Array.isArray(record.via) || record.via.length === 0
      || !["info", "low", "moderate", "high", "critical"].includes(record.severity)) {
      throw new Error("DEPENDENCY_AUDIT_RECORD_INVALID");
    }
    if (["info", "low"].includes(record.severity)) { low.add(name); continue; }
    if (name === "minimatch" && reviewedLegacyFinding(record, root, now)) {
      reviewed.add(name); continue;
    }
    if (record.severity !== "moderate" || record.via.some(item =>
      typeof item !== "string" || !Object.hasOwn(records, item))) blocked.add(name);
  }
  // npm's meta-vulnerability graph can contain cycles (builder <-> dmg-builder).
  // Propagate both real blockers and the reviewed leaf through the whole graph.
  let changed;
  do {
    changed = false;
    for (const [name, record] of Object.entries(records)) {
      if (low.has(name)) continue;
      if (!blocked.has(name) && record.via.some(item => typeof item === "string" && blocked.has(item))) {
        blocked.add(name); changed = true;
      }
      if (!reviewed.has(name) && record.via.some(item => typeof item === "string" && reviewed.has(item))) {
        reviewed.add(name); changed = true;
      }
    }
  } while (changed);
  const unresolved = Object.keys(records).filter(name => !low.has(name)
    && (blocked.has(name) || !reviewed.has(name)));
  return { passed: unresolved.length === 0, unresolved,
    reviewedBuildRecords: [...reviewed].filter(name => !blocked.has(name)),
    reviewedAdvisory: reviewed.size ? ADVISORY : null,
    reviewExpires: reviewed.size ? new Date(REVIEW_EXPIRES).toISOString() : null };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const directory = args.indexOf("--directory");
    const output = args.indexOf("--output");
    if (args.length !== (directory >= 0 ? 2 : 0) + (output >= 0 ? 2 : 0)
      || (directory >= 0 && !args[directory + 1]) || (output >= 0 && !args[output + 1])) {
      throw new Error("Usage: node scripts/dependency-audit-policy.cjs [--directory path] [--output path]");
    }
    const root = path.resolve(directory >= 0 ? args[directory + 1] : ".");
    const result = spawnSync("npm", ["audit", "--audit-level=moderate", "--json"], {
      cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || ![0, 1].includes(result.status)) throw new Error("DEPENDENCY_AUDIT_COMMAND_FAILED");
    const report = JSON.parse(result.stdout);
    const counts = report.metadata?.vulnerabilities;
    if (!counts || !Number.isSafeInteger(counts.total)
      || counts.total !== Object.keys(report.vulnerabilities || {}).length
      || (result.status === 1 && counts.moderate + counts.high + counts.critical === 0)) {
      throw new Error("DEPENDENCY_AUDIT_SUMMARY_INVALID");
    }
    const decision = evaluateAudit(report, { root });
    if (output >= 0) fs.writeFileSync(path.resolve(args[output + 1]),
      JSON.stringify({ npmExitCode: result.status, rawReport: report, decision }, null, 2) + "\n");
    console.log(JSON.stringify({ directory: root, rawCounts: report.metadata?.vulnerabilities, ...decision }, null, 2));
    if (!decision.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { evaluateAudit, ADVISORY, LEGACY_SOURCES, REVIEW_EXPIRES };
