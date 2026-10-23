#!/usr/bin/env node
"use strict";

// A stable local code-signing identity for internal preview builds.
//
// An ad-hoc signature's designated requirement is the cdhash, which changes with every
// build, so macOS keeps the Accessibility / Screen Recording grant (and Keychain ACLs)
// on the previous install. Signing with one fixed local certificate gives
//   identifier "ai.shoggoth.desktop" and certificate leaf = H"<certificate sha1>"
// which stays the same across rebuilds and needs no keychain to evaluate; app/agent-service/
// code-identity.js accepts exactly that shape. The certificate is issued by a private CA whose
// key is deleted right after issuing; only the CA certificate is trusted, for code signing.
//
// The identity lives in its own keychain with a password this script generates, and its
// private key is imported with the codesign partition already authorized, so signing
// never asks for a password. Nothing here touches the login keychain or other identities.
//
// codesign only accepts identities that pass the code-signing trust policy, and a
// private CA is not trusted until the user says so. `trust` asks macOS to record that
// for this one CA certificate; macOS shows its own authorization dialog, which
// takes the user's login password (this script never sees it).
//
// codesign also only finds an identity whose keychain is in the user's search list, so
// `run` and `verify` add the keychain for the duration of the command and restore the
// original list afterwards.
//
//   node scripts/local-signing.cjs setup     create the keychain and identity (idempotent)
//   node scripts/local-signing.cjs trust     mark the CA trusted for code signing (once)
//   node scripts/local-signing.cjs verify    sign two scratch files and check the requirement
//   node scripts/local-signing.cjs run -- <command...>
//                                            run a build with the SHOGGOTH_CODESIGN_* environment set
//   node scripts/local-signing.cjs env       print those exports (the keychain still has to be in the
//                                            search list while signing; `run` does that for you)
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const IDENTITY_NAME = "Shoggoth Internal Signing";
const CA_NAME = "Shoggoth Internal Signing CA";
const BUNDLE_ID = "ai.shoggoth.desktop";
const STATE_DIR = path.join(os.homedir(), ".shoggoth-signing");
const KEYCHAIN = path.join(os.homedir(), "Library", "Keychains", "shoggoth-internal-signing.keychain-db");
const PASSWORD_FILE = path.join(STATE_DIR, "keychain-password");
const IDENTITY_FILE = path.join(STATE_DIR, "identity.json");
const COMMAND_TIMEOUT_MS = 60_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    // A hidden password dialog would otherwise hang the build silently.
    stdio: ["ignore", "pipe", "pipe"], ...options.spawn,
  });
  if (result.error || (options.allowFailure !== true && result.status !== 0)) {
    const detail = result.error ? String(result.error.message) : (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args[0]} failed${result.error?.code === "ETIMEDOUT" ? " (timed out; a password dialog may be waiting)" : ""}: ${detail}`.slice(0, 600));
  }
  return result;
}

function keychainSearchList() {
  return [...run("security", ["list-keychains", "-d", "user"]).stdout.matchAll(/"([^"]+)"/gu)].map(match => match[1]);
}

function identityHash(keychain) {
  const listing = run("security", ["find-identity", "-p", "codesigning", keychain], { allowFailure: true }).stdout;
  return new RegExp(`^\\s*\\d+\\) ([0-9A-F]{40}) "${IDENTITY_NAME}"`, "mu").exec(listing)?.[1] || null;
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
    const password = fs.readFileSync(PASSWORD_FILE, "utf8").trim();
    if (state.keychain === KEYCHAIN && /^[0-9A-F]{40}$/u.test(state.sha1) && /^[0-9a-f]{40}$/u.test(state.rootSha1)
      && password && fs.existsSync(KEYCHAIN)) {
      return { ...state, password };
    }
  } catch { /* not set up yet */ }
  return null;
}

// The chain (leaf -> CA) is only found when the keychain is in the search list.
function isTrusted(keychain, sha1) {
  return withKeychainInSearchList(() => run("security", ["find-identity", "-v", "-p", "codesigning", keychain],
    { allowFailure: true }).stdout.includes(sha1));
}

function trust() {
  const state = readState();
  if (!state) throw new Error("not set up; run: node scripts/local-signing.cjs setup");
  unlock(state.password);
  if (isTrusted(KEYCHAIN, state.sha1)) return { ...state, alreadyTrusted: true };
  const work = fs.mkdtempSync(path.join(STATE_DIR, "trust-"));
  try {
    const cert = path.join(work, "cert.pem");
    fs.writeFileSync(cert, run("security", ["find-certificate", "-c", CA_NAME, "-p", KEYCHAIN]).stdout);
    // The authorization dialog waits for a person, so allow more than the default budget.
    run("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", KEYCHAIN, cert], { timeoutMs: 300_000 });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  if (!isTrusted(KEYCHAIN, state.sha1)) throw new Error("the certificate is still not trusted for code signing");
  return { ...state, alreadyTrusted: false };
}

// The list is rebuilt from an argument array: a single joined string would be written as one
// bogus keychain path.
// Leaving the search list locks the keychain again, so it is unlocked after joining, not before.
function withKeychainInSearchList(action) {
  const others = keychainSearchList().filter(entry => entry !== KEYCHAIN);
  run("security", ["list-keychains", "-d", "user", "-s", ...others, KEYCHAIN]);
  try {
    try { unlock(fs.readFileSync(PASSWORD_FILE, "utf8").trim()); } catch { /* setup has not finished */ }
    return action();
  }
  finally { run("security", ["list-keychains", "-d", "user", "-s", ...others], { allowFailure: true }); }
}

function unlock(password) {
  run("security", ["unlock-keychain", "-p", password, KEYCHAIN]);
}

function setup() {
  const existing = readState();
  if (existing) {
    unlock(existing.password);
    if (identityHash(KEYCHAIN) === existing.sha1) return existing;
  }
  if (fs.existsSync(KEYCHAIN)) {
    throw new Error(`${KEYCHAIN} exists but its state under ${STATE_DIR} is missing or does not match. `
      + "Delete that keychain (security delete-keychain) and rerun setup; it holds only this signing identity.");
  }
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE_DIR, 0o700);
  const password = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  const work = fs.mkdtempSync(path.join(STATE_DIR, "work-"));
  const originalList = keychainSearchList();
  try {
    const conf = (name, lines) => {
      const file = path.join(work, `${name}.cnf`);
      fs.writeFileSync(file, `${lines.join("\n")}\n`);
      return file;
    };
    const caKey = path.join(work, "ca.key"), caCert = path.join(work, "ca.pem");
    const leafKey = path.join(work, "leaf.key"), leafCsr = path.join(work, "leaf.csr"), leafCert = path.join(work, "leaf.pem");
    const bundle = path.join(work, "identity.p12");
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-keyout", caKey, "-out", caCert,
      "-config", conf("ca", ["[req]", "distinguished_name = dn", "x509_extensions = ext", "prompt = no",
        "[dn]", `CN = ${CA_NAME}`,
        "[ext]", "basicConstraints = critical,CA:true,pathlen:0", "keyUsage = critical,keyCertSign,cRLSign",
        "subjectKeyIdentifier = hash"])]);
    run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", leafKey, "-out", leafCsr,
      "-subj", `/CN=${IDENTITY_NAME}`]);
    run("openssl", ["x509", "-req", "-in", leafCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-days", "3650",
      "-out", leafCert, "-extfile", conf("leaf", ["[ext]", "basicConstraints = critical,CA:false",
        "keyUsage = critical,digitalSignature", "extendedKeyUsage = critical,codeSigning",
        "subjectKeyIdentifier = hash", "authorityKeyIdentifier = keyid"]), "-extensions", "ext"]);
    const rootSha1 = /=([0-9A-Fa-f:]{59})/u.exec(run("openssl", ["x509", "-in", caCert, "-noout", "-fingerprint", "-sha1"]).stdout)
      ?.[1].replaceAll(":", "").toLowerCase();
    if (!/^[0-9a-f]{40}$/u.test(rootSha1 || "")) throw new Error("could not read the CA fingerprint");
    // The CA key is not needed once the certificate is issued; it never reaches the keychain.
    fs.rmSync(caKey, { force: true });
    const bundlePassword = crypto.randomBytes(18).toString("base64url");
    run("openssl", ["pkcs12", "-export", "-inkey", leafKey, "-in", leafCert, "-certfile", caCert, "-out", bundle,
      "-name", IDENTITY_NAME, "-passout", `pass:${bundlePassword}`]);
    run("security", ["create-keychain", "-p", password, KEYCHAIN]);
    // create-keychain adds the keychain to the user's search list; codesign gets it explicitly instead.
    run("security", ["list-keychains", "-d", "user", "-s", ...originalList]);
    run("security", ["set-keychain-settings", KEYCHAIN]);
    unlock(password);
    run("security", ["import", bundle, "-k", KEYCHAIN, "-P", bundlePassword, "-f", "pkcs12",
      "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"]);
    // Authorizing the key's partition at import time is what avoids the "codesign wants to use
    // key ..." password dialog on every signature.
    run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, KEYCHAIN]);
    const sha1 = identityHash(KEYCHAIN);
    if (!sha1) throw new Error("the imported identity is not listed as a code-signing identity");
    const state = { name: IDENTITY_NAME, sha1, rootSha1, keychain: KEYCHAIN, createdAt: new Date().toISOString() };
    fs.writeFileSync(IDENTITY_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return { ...state, password };
  } catch (error) {
    // Leave nothing half-made behind: the next setup must start from a clean slate.
    run("security", ["delete-keychain", KEYCHAIN], { allowFailure: true });
    run("security", ["list-keychains", "-d", "user", "-s", ...originalList], { allowFailure: true });
    fs.rmSync(PASSWORD_FILE, { force: true });
    fs.rmSync(IDENTITY_FILE, { force: true });
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function requirementOf(target) {
  const described = run("codesign", ["-d", "-r-", target]);
  const output = `${described.stderr}\n${described.stdout}`;
  return /designated => ([^\r\n]+)/u.exec(output)?.[1] || null;
}

function verify() {
  const state = readState();
  if (!state) throw new Error("not set up; run: node scripts/local-signing.cjs setup");
  unlock(state.password);
  if (!isTrusted(KEYCHAIN, state.sha1)) {
    throw new Error("the certificate is not trusted for code signing yet; run: node scripts/local-signing.cjs trust");
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-signing-"));
  try {
    const requirements = withKeychainInSearchList(() => ["true", "false"].map(name => {
      const target = path.join(scratch, name);
      // Different binaries: a cdhash-based requirement would differ, a certificate-based one cannot.
      fs.copyFileSync(`/usr/bin/${name}`, target);
      run("codesign", ["--force", "--options", "runtime", "--timestamp=none", "--identifier", BUNDLE_ID,
        "--keychain", KEYCHAIN, "--sign", state.sha1, target]);
      run("codesign", ["--verify", "--strict", target]);
      return requirementOf(target);
    }));
    const expected = `identifier "${BUNDLE_ID}" and certificate leaf = H"${state.sha1.toLowerCase()}"`;
    if (!requirements.every(value => value === expected)) {
      throw new Error(`unstable or unexpected designated requirement: ${JSON.stringify(requirements)}`);
    }
    // The gate the Service and MCP helper apply to the app itself must accept what was signed.
    const { readCodeIdentity } = require("../app/agent-service/code-identity");
    const identity = readCodeIdentity(path.join(scratch, "true"), { allowLocalSignedIdentifier: BUNDLE_ID });
    if (identity.localSigned !== true || identity.certificateLeafHash !== state.sha1.toLowerCase()) {
      throw new Error("the runtime code-identity gate did not accept the signature");
    }
    return { sha1: state.sha1, requirement: requirements[0] };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

function signingEnvironment(state) {
  return { SHOGGOTH_CODESIGN_MODE: "local", SHOGGOTH_CODESIGN_IDENTITY: state.sha1,
    SHOGGOTH_CODESIGN_KEYCHAIN: state.keychain, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
}

function ready() {
  const state = readState();
  if (!state) throw new Error("not set up; run: node scripts/local-signing.cjs setup");
  unlock(state.password);
  if (!isTrusted(KEYCHAIN, state.sha1)) {
    throw new Error("the certificate is not trusted for code signing yet; run: node scripts/local-signing.cjs trust");
  }
  return state;
}

function runWithSigning(argv) {
  if (argv.length === 0) throw new Error("usage: node scripts/local-signing.cjs run -- <command...>");
  const state = ready();
  return withKeychainInSearchList(() => spawnSync(argv[0], argv.slice(1), {
    stdio: "inherit", env: { ...process.env, ...signingEnvironment(state) },
  }));
}

function main(command, rest = []) {
  if (command === "setup") {
    const state = setup();
    console.log(`identity ready: ${state.name} (${state.sha1})\nkeychain: ${state.keychain}`);
  } else if (command === "trust") {
    const state = trust();
    console.log(state.alreadyTrusted ? "already trusted for code signing" : "trusted for code signing");
  } else if (command === "env") {
    const state = ready();
    console.log(Object.entries(signingEnvironment(state)).map(([key, value]) => `export ${key}=${JSON.stringify(value)}`).join("\n"));
  } else if (command === "run") {
    const result = runWithSigning(rest[0] === "--" ? rest.slice(1) : rest);
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else if (command === "verify") {
    const result = verify();
    console.log(`stable: ${result.requirement}`);
  } else {
    console.error("usage: node scripts/local-signing.cjs <setup|trust|verify|run|env>");
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try { main(process.argv[2], process.argv.slice(3)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { BUNDLE_ID, IDENTITY_NAME, KEYCHAIN, STATE_DIR, requirementOf, setup, trust, verify };
