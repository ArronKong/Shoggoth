"use strict";

const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { releaseDistribution } = require("./release-distribution.cjs");
const { runStapler } = require("./release-stapler.cjs");

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SUBMISSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const NETWORK_FAILURE = /^Error: HTTPError\(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-(?:1001|1005)\b/mu;
const PASSWORD_ENDPOINT = /\bNSErrorFailingURLStringKey=https:\/\/appstoreconnect\.apple\.com\/notary\/v2\/asp\??(?=[,\s}]|$)/u;
const retryDelays = [5_000, 15_000];

function notarytoolOptions(keychainProfile, keychainPath) {
  if (!PROFILE_PATTERN.test(keychainProfile || "")) throw new TypeError("notarization profile is invalid");
  if (keychainPath !== undefined
    && (!path.isAbsolute(keychainPath) || keychainPath.includes("\0"))) {
    throw new TypeError("notarization keychain path is invalid");
  }
  const args = ["--keychain-profile", keychainProfile];
  if (keychainPath) args.push("--keychain", keychainPath);
  args.push("--output-format", "json");
  return args;
}

function buildNotarytoolArgs(archivePath, keychainProfile, keychainPath) {
  if (!path.isAbsolute(archivePath)) throw new TypeError("notarization archive is invalid");
  return ["notarytool", "submit", archivePath, ...notarytoolOptions(keychainProfile, keychainPath), "--no-wait"];
}

function assertAcceptedReceipt(stdout) {
  let receipt;
  try { receipt = JSON.parse(stdout); } catch { throw new Error("NOTARIZATION_RECEIPT_INVALID"); }
  if (!receipt || receipt.status !== "Accepted"
    || typeof receipt.id !== "string" || !/^[A-Fa-f0-9-]{16,64}$/u.test(receipt.id)) {
    throw new Error("NOTARIZATION_REJECTED");
  }
  return { id: receipt.id, status: receipt.status, message: receipt.message || null };
}

function submissionId(receipt) {
  if (typeof receipt?.id !== "string" || !SUBMISSION_ID.test(receipt.id)) {
    throw new Error("NOTARIZATION_SUBMISSION_ID_INVALID");
  }
  return receipt.id;
}

function transientNetwork(error) {
  return error.code === "ETIMEDOUT" || NETWORK_FAILURE.test(String(error.stderr ?? ""));
}

function passwordRequestInterrupted(error) {
  const stderr = String(error.stderr ?? "");
  return NETWORK_FAILURE.test(stderr) && PASSWORD_ENDPOINT.test(stderr) && !String(error.stdout ?? "").trim()
    && !/Submission ID received|Successfully uploaded/iu.test(stderr);
}

function notaryError(stage, cause) {
  if (cause.code === "NOTARIZATION_DEADLINE_EXCEEDED") return cause;
  const status = /(?:statusCode:\s*(?:Optional\()?|HTTP status code:\s*)([45]\d\d)\b/iu.exec(String(cause.stderr ?? ""))?.[1];
  return new Error(`NOTARIZATION_${stage}_FAILED${status ? ` (Apple HTTP ${status})` : ""}`, { cause });
}

async function readNotary(stage, read, { pause, warn }) {
  for (let attempt = 0; ; attempt++) {
    try { return read(); }
    catch (error) {
      const backoff = retryDelays[attempt];
      if (backoff === undefined || !transientNetwork(error)) throw notaryError(stage, error);
      warn(`Apple notarization ${stage.toLowerCase()} read interrupted. Retrying the read in ${backoff / 1000}s.`);
      await pause(backoff);
    }
  }
}

async function submitArchive(run, submitArgs, options, name, runtime) {
  for (let attempt = 0; ; attempt++) {
    let result;
    try { result = run(submitArgs); }
    catch (error) {
      if (!transientNetwork(error)) throw notaryError("SUBMIT", error);
      const backoff = retryDelays[attempt];
      const mayRetry = backoff !== undefined && passwordRequestInterrupted(error);
      if (mayRetry) await runtime.pause(backoff);
      const history = JSON.parse(await readNotary("HISTORY", () => run(["notarytool", "history", ...options], 60_000), runtime))?.history;
      if (!Array.isArray(history)) throw new Error("NOTARIZATION_HISTORY_INVALID");
      const matches = history.filter(item => item?.name === name);
      if (matches.length === 1) return submissionId(matches[0]);
      if (matches.length > 1) throw new Error("NOTARIZATION_HISTORY_AMBIGUOUS");
      if (!mayRetry) throw new Error("NOTARIZATION_SUBMISSION_UNCONFIRMED: inspect the preserved submission name", { cause: error });
      runtime.warn("Apple password request timed out before notarization. Retrying this archive after checking its submission history.");
      continue;
    }
    return submissionId(JSON.parse(result));
  }
}

async function notarizeArchive(archive, receiptPath, profile, keychain, {
  runFile = execFileSync, pause = delay, now = () => performance.now(), warn = console.warn,
} = {}) {
  if (!path.isAbsolute(archive)) throw new TypeError("notarization archive is invalid");
  const options = notarytoolOptions(profile, keychain);
  const scratch = fs.mkdtempSync(path.join(path.dirname(archive), ".notary-upload-"));
  try {
    // The unique basename makes Apple history lookup specific to these bytes.
    const ext = path.extname(archive);
    const name = `${path.basename(archive, ext)}-${randomUUID()}${ext}`;
    const upload = path.join(scratch, name);
    fs.linkSync(archive, upload);
    const submissionPath = path.join(path.dirname(receiptPath), `${path.basename(receiptPath, ".json")}.submission.json`);
    const save = (destination, value, exclusive = false) => {
      const temporary = `${destination}.tmp-${randomUUID()}`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        if (exclusive) fs.linkSync(temporary, destination);
        else fs.renameSync(temporary, destination);
      } finally { fs.rmSync(temporary, { force: true }); }
    };
    save(submissionPath, { name }, true);
    const deadline = now() + 30 * 60_000;
    const remaining = () => {
      const milliseconds = Math.floor(deadline - now());
      if (milliseconds < 1000) {
        throw Object.assign(new Error("NOTARIZATION_DEADLINE_EXCEEDED"), { code: "NOTARIZATION_DEADLINE_EXCEEDED" });
      }
      return milliseconds;
    };
    const run = (args, timeout = Infinity) => runFile("/usr/bin/xcrun", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: Math.min(timeout, remaining()),
    });
    const runtime = { pause, warn };
    const id = await submitArchive(run, buildNotarytoolArgs(upload, profile, keychain), options, name, runtime);
    save(submissionPath, { name, id });
    const result = await readNotary("WAIT", () => run([
      "notarytool", "wait", id, ...options, "--timeout", `${Math.floor(remaining() / 1000)}s`,
    ]), runtime);
    const receipt = assertAcceptedReceipt(result);
    if (receipt.id.toLowerCase() !== id.toLowerCase()) throw new Error("NOTARIZATION_RECEIPT_ID_MISMATCH");
    save(receiptPath, receipt);
    return receipt;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

exports.default = function notarize(context) {
  if (context.electronPlatformName !== "darwin") return;
  const mode = process.env.SHOGGOTH_CODESIGN_MODE
    || (process.env.SHOGGOTH_CODESIGN_IDENTITY ? "local" : "adhoc");
  const keychainProfile = process.env.SHOGGOTH_NOTARY_KEYCHAIN_PROFILE;
  const keychainPath = process.env.SHOGGOTH_NOTARY_KEYCHAIN;
  const distribution = releaseDistribution(mode, process.env.SHOGGOTH_RELEASE_DISTRIBUTION);
  if (distribution === "internal") {
    if (keychainProfile) throw new Error("Internal builds must not configure notarization");
    console.log("  • notarization skipped (internal preview; signing identity retained)");
    return;
  }
  if (!keychainProfile) {
    if (mode === "developer-id") {
      throw new Error("Developer ID release requires SHOGGOTH_NOTARY_KEYCHAIN_PROFILE");
    }
    console.log("  • notarization skipped (internal preview)");
    return;
  }
  if (mode !== "developer-id" || !PROFILE_PATTERN.test(keychainProfile)) {
    throw new TypeError("Notarization requires Developer ID mode and a valid keychain profile");
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  return notarizeApp(appPath, keychainProfile, keychainPath);
};

async function notarizeApp(appPath, keychainProfile, keychainPath) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-notary-"));
  try {
    const archivePath = path.join(scratch, "Shoggoth-notarization.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, archivePath], {
      stdio: "ignore", timeout: 180_000,
    });
    // Preserve Apple's accepted submission even if the later ticket lookup loses
    // its connection. The final build receipt still requires every gate below.
    const receipt = await notarizeArchive(archivePath, `${appPath}.notarization.json`, keychainProfile, keychainPath);
    runStapler("staple", appPath);
    runStapler("validate", appPath);
    execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], {
      stdio: "inherit", timeout: 60_000,
    });
    console.log(`  • notarized and stapled  ${appPath} (${receipt.id})`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

exports.PROFILE_PATTERN = PROFILE_PATTERN;
exports.assertAcceptedReceipt = assertAcceptedReceipt;
exports.buildNotarytoolArgs = buildNotarytoolArgs;
exports.notarizeArchive = notarizeArchive;
