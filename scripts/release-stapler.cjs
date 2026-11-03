"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// EX_NOHOST alone is not retryable: it can also mean an unnotarized product.
// Retry only Apple's explicit timeout/connection-lost transport diagnostics.
function transientTicketFailure(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return !result.error && result.status === 68
    && /NSURLErrorDomain\s+Code=-(?:1001|1005)\b/u.test(output);
}

function runStapler(action, target, options = {}) {
  assert.ok(["staple", "validate"].includes(action), "Unsupported stapler operation");
  assert.ok(typeof target === "string" && target && !target.includes("\0"), "Invalid stapler target");
  const execute = options.execute || spawnSync;
  const wait = options.wait || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const log = options.log || (text => process.stdout.write(text));
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = execute("/usr/bin/xcrun", ["stapler", action, path.resolve(target)], {
      encoding: "utf8", env: options.env || process.env,
      timeout: options.timeout || (action === "staple" ? 180000 : 60000),
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (output) log(output.endsWith("\n") ? output : `${output}\n`);
    if (!result.error && result.status === 0) return { ...result, attempts: attempt };
    if (attempt === attempts || !transientTicketFailure(result)) {
      const error = new Error(`STAPLER_${action.toUpperCase()}_FAILED (exit ${result.status ?? "unknown"}, attempt ${attempt}): ${result.error?.message || output.slice(-6000)}`);
      error.status = result.status;
      throw error;
    }
    const delay = 3000 * 2 ** (attempt - 1);
    log(`Apple ticket service transport interrupted; retrying ${action} in ${delay / 1000}s (${attempt}/${attempts}).\n`);
    wait(delay);
  }
}

if (require.main === module) {
  try { runStapler(process.argv[2], process.argv[3]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { transientTicketFailure, runStapler };
