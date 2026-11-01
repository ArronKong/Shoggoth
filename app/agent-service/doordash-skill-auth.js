"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { assertPrivateDirectory } = require("./security");
const { validOfficialVerificationUrl } = require("../core/official-skill-connector-dto");
const fail = (code = "OFFICIAL_SKILL_AUTH_FAILED") => { throw Object.assign(new Error(code), { code }); };
const tokenText = value => typeof value === "string" && value.length >= 16 && value.length <= 16384 && !/[\u0000-\u0020\u007f]/u.test(value);

// export-token explicitly avoids the OS keychain. Only this connector's private
// files and the fixed token environment variable carry its authorization.
function createDoorDashAuth({ root, home, run, parseJson, rememberSecret, now = Date.now }) {
  const tokenFile = path.join(home, "doordash-token.json"), flowFile = path.join(home, "doordash-authorization.json");
  const pendingFile = path.join(home, ".config", "dd-cli", "pending-login.json");
  const privateParentsExist = file => {
    assertPrivateDirectory(home);
    let directory = home;
    for (const part of path.relative(home, path.dirname(file)).split(path.sep).filter(Boolean)) {
      directory = path.join(directory, part);
      try { fs.lstatSync(directory); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
      assertPrivateDirectory(directory);
    }
    return true;
  };
  const read = file => {
    if (!privateParentsExist(file)) return null;
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(readPrivateFile(file, { maxBytes: 64 * 1024 })); } catch { fail("OFFICIAL_SKILL_INTEGRITY_FAILED"); }
  };
  const remove = file => { if (privateParentsExist(file) && fs.existsSync(file)) { readPrivateFile(file, { maxBytes: 64 * 1024 }); fs.unlinkSync(file); } };
  function pending() {
    const flow = read(flowFile);
    if (!flow) return null;
    if (!validOfficialVerificationUrl("doordash", flow.verificationUrl) || !Number.isFinite(flow.expiresAt)) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    if (flow.expiresAt <= now()) { remove(flowFile); remove(pendingFile); return null; }
    return { state: "authorizing", verificationUrl: flow.verificationUrl };
  }
  function token() {
    const value = read(tokenFile);
    if (!value) fail("OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED");
    if (!tokenText(value.accessToken) || value.expiresAt !== null && !Number.isFinite(value.expiresAt)) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    if (value.expiresAt !== null && value.expiresAt <= now()) fail("OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED");
    rememberSecret(value.accessToken); return value.accessToken;
  }
  return { token, pending,
    hasToken() { try { token(); return true; } catch (error) { if (error.code === "OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED") return false; throw error; } },
    logout() { for (const file of [tokenFile, flowFile, pendingFile]) remove(file); },
    async start(signal) {
      for (const file of [tokenFile, flowFile, pendingFile]) remove(file);
      const result = await run(["--json-output", "export-token", "--start"], { signal, extraEnv: { DD_CLI_ACCESS_TOKEN: "shoggoth-unconnected" } });
      if (result.code !== 0) fail();
      const urls = `${result.stdout}\n${result.stderr}`.match(/https:\/\/[^\s<>"']+/gu) || [];
      const verificationUrl = urls.find(url => validOfficialVerificationUrl("doordash", url) && new URL(url).pathname === "/authorize");
      const saved = read(pendingFile);
      if (!verificationUrl || typeof saved?.code_verifier !== "string" || typeof saved?.state !== "string" || typeof saved?.redirect_uri !== "string") fail();
      const url = new URL(verificationUrl);
      const challenge = crypto.createHash("sha256").update(saved.code_verifier).digest("base64url");
      if (url.searchParams.get("state") !== saved.state || url.searchParams.get("redirect_uri") !== saved.redirect_uri
        || url.searchParams.get("code_challenge") !== challenge || url.searchParams.get("code_challenge_method") !== "S256") fail();
      atomicWritePrivateFile(flowFile, JSON.stringify({ verificationUrl, expiresAt: now() + 10 * 60_000 }), { trustedRoot: root });
      return { state: "authorizing", verificationUrl };
    },
    async finish(callback, signal) {
      if (!pending()) fail();
      const saved = read(pendingFile), flow = read(flowFile); let received, expected, authorization;
      try { received = new URL(callback); expected = new URL(saved.redirect_uri); authorization = new URL(flow.verificationUrl); } catch { fail("OFFICIAL_SKILL_INVALID_ARGUMENT"); }
      if (expected.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(expected.hostname)
        || saved.redirect_uri !== authorization.searchParams.get("redirect_uri") || saved.state !== authorization.searchParams.get("state")
        || received.username || received.password || received.hash || received.origin !== expected.origin || received.pathname !== expected.pathname
        || received.searchParams.getAll("code").length !== 1 || received.searchParams.getAll("state").length !== 1
        || !received.searchParams.get("code") || received.searchParams.get("state") !== saved.state) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
      const result = await run(["--json-output", "export-token", "--finish", "-"], { signal, rawInput: callback, extraEnv: { DD_CLI_ACCESS_TOKEN: "shoggoth-unconnected" } });
      const value = parseJson(result.stdout);
      if (result.code !== 0 || !tokenText(value?.access_token)) fail();
      const expiresAt = value.expires_at == null ? null : Date.parse(value.expires_at);
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now())) fail();
      rememberSecret(value.access_token);
      atomicWritePrivateFile(tokenFile, JSON.stringify({ accessToken: value.access_token, expiresAt }), { trustedRoot: root });
      remove(flowFile); remove(pendingFile);
    },
  };
}
module.exports = { createDoorDashAuth };
