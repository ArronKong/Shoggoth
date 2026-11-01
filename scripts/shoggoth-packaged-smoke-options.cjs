"use strict";
const path = require("node:path");
const MODES = new Set(["--spike", "--spike-arm64", "--spike-x64", "--app-arm64", "--zip-arm64", "--run-as-node-app", "--service-app"]);
function invalid(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
function absolute(value) { return typeof value === "string" && value.isWellFormed() && !/[\0\r\n]/u.test(value) && path.isAbsolute(value); }
function parsePackagedSmokeOptions(argv, { artifactRoot } = {}) {
  const guards = argv.filter(value => value === "--require-candidate");
  if (guards.length > 1) invalid("SMOKE_ARGUMENT_INVALID", "duplicate --require-candidate");
  const requireCandidate = guards.length === 1;
  if (requireCandidate && artifactRoot === undefined) invalid("CANDIDATE_ARTIFACT_REQUIRED", "set SHOGGOTH_SMOKE_DIST_DIR to the isolated candidate artifact directory");
  if (artifactRoot !== undefined && !absolute(artifactRoot)) invalid("SMOKE_ARGUMENT_INVALID", "SHOGGOTH_SMOKE_DIST_DIR must be a well-formed absolute path");
  const args = argv.filter(value => value !== "--require-candidate");
  const mode = args[0] || null;
  if (requireCandidate && mode === null) invalid("PACKAGED_MODE_REQUIRED", "select --app-arm64, --spike-arm64 or another packaged mode; source-only validation cannot satisfy candidate acceptance");
  if (mode !== null && !MODES.has(mode)) invalid("SMOKE_ARGUMENT_INVALID", `unknown argument: ${mode}`);
  const directApp = ["--run-as-node-app", "--service-app"].includes(mode);
  if (directApp ? args.length !== 2 || !absolute(args[1]) : args.length > 1) invalid("SMOKE_ARGUMENT_INVALID", directApp ? `${mode} requires one absolute App path` : "select exactly one packaged mode");
  return Object.freeze({ requireCandidate, mode, appPath: directApp ? args[1] : null,
    requestedArch: ["--spike-arm64", "--app-arm64", "--zip-arm64"].includes(mode) ? "arm64" : mode === "--spike-x64" ? "x64" : null });
}
module.exports = { parsePackagedSmokeOptions };
