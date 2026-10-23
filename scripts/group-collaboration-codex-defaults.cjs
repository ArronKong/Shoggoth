"use strict";
// Evaluation metadata only: preserve the frozen, allowlisted native model
// defaults while the production adapter borrows authentication in memory.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => Object.assign(new Error(code), { code });
const fields = new Set(["model", "model_provider", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "service_tier", "model_context_window", "model_auto_compact_token_limit"]);
const enums = { model_provider: ["openai"], model_reasoning_effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  model_reasoning_summary: ["auto", "concise", "detailed", "none"], model_verbosity: ["low", "medium", "high"], service_tier: ["auto", "default", "flex", "priority"] };
function safeNativeDefaults(value) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail("GROUP_LIVE_CODEX_DEFAULTS_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value), output = {};
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !fields.has(key))) throw fail("GROUP_LIVE_CODEX_DEFAULTS_INVALID");
  for (const [key, property] of Object.entries(descriptors)) {
    if (!Object.hasOwn(property, "value") || !property.enumerable) throw fail("GROUP_LIVE_CODEX_DEFAULTS_INVALID");
    const item = property.value;
    if (key === "model" ? typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(item)
      : enums[key] ? !enums[key].includes(item) : !Number.isSafeInteger(item) || item <= 0) throw fail("GROUP_LIVE_CODEX_DEFAULTS_INVALID");
    output[key] = item;
  }
  if (!output.model) throw fail("GROUP_LIVE_CODEX_DEFAULTS_INVALID");
  return Object.freeze(output);
}
function boundedFile(file, max, { readonly = false, privateMode = false } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file) throw fail("GROUP_LIVE_CODEX_DEFAULTS_FILE_INVALID");
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.size > max
    || readonly && (s.mode & 0o222) || privateMode && (s.mode & 0o077)) throw fail("GROUP_LIVE_CODEX_DEFAULTS_FILE_INVALID");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const opened = fs.fstatSync(fd); bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
    if (s.dev !== opened.dev || s.ino !== opened.ino || opened.size !== bytes.length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      throw fail("GROUP_LIVE_CODEX_DEFAULTS_FILE_CHANGED");
    return bytes;
  } catch (error) { bytes?.fill(0); throw error; }
  finally {
    try { fs.closeSync(fd); } catch (error) { bytes?.fill(0); throw error; }
  }
}
function validateFrozenRecord(record, { sourcePath, sdkVersion }) {
  if (!record || record.version !== 1 || record.path !== sourcePath || !/^[a-f0-9]{64}$/u.test(record.sha256 || "")
    || record.unlistedConfigCopied !== false || record.realModelRequests !== 0
    || record.sourceAccountIdentitySha256 !== undefined && !/^[a-f0-9]{64}$/u.test(record.sourceAccountIdentitySha256)) throw fail("GROUP_LIVE_CODEX_DEFAULTS_INVALID");
  const projection = safeNativeDefaults(record.projection), proof = record.providerDefaultProof;
  if (!proof || Object.keys(proof).some(key => !["provider", "pinnedVersion", "path", "sha256", "originalHomeConfigReadSucceeded"].includes(key))
    || proof.provider !== "openai" || proof.pinnedVersion !== sdkVersion || proof.originalHomeConfigReadSucceeded !== false
    || !/^[a-f0-9]{64}$/u.test(proof.sha256 || "") || typeof proof.path !== "string" || !proof.path.startsWith("/private/tmp/")
    || projection.model_provider && projection.model_provider !== proof.provider) throw fail("GROUP_LIVE_CODEX_PROVIDER_DEFAULT_UNPROVEN");
  return { projection, providerDefaultProof: proof, expectedSourceAccountIdentitySha256: record.sourceAccountIdentitySha256 ?? null,
    config: Object.freeze({ ...projection, model_provider: proof.provider }) };
}
function load(file, { sdkVersion }) {
  if (!file) throw fail("GROUP_LIVE_CODEX_DEFAULTS_REQUIRED");
  const metadataBytes = boundedFile(file, 64 * 1024, { readonly: true, privateMode: true });
  let record; try { record = JSON.parse(metadataBytes); } catch { throw fail("GROUP_LIVE_CODEX_DEFAULTS_INVALID"); }
  const sourcePath = path.join(os.homedir(), ".codex/config.toml"), validated = validateFrozenRecord(record, { sourcePath, sdkVersion });
  const sourceBytes = boundedFile(sourcePath, 1024 * 1024, { privateMode: true });
  try {
    if (sha(sourceBytes) !== record.sha256) throw fail("GROUP_LIVE_CODEX_SOURCE_DEFAULTS_CHANGED");
  } finally { sourceBytes.fill(0); }
  const proofBytes = boundedFile(validated.providerDefaultProof.path, 4 * 1024 * 1024, { readonly: true });
  if (sha(proofBytes) !== validated.providerDefaultProof.sha256
    || !/required_model_provider\(\)[\s\S]{0,160}\.or\(model_provider\)[\s\S]{0,80}\.or\(cfg\.model_provider\)[\s\S]{0,100}\.unwrap_or_else\(\|\| "openai"\.to_string\(\)\)/u.test(proofBytes.toString("utf8")))
    throw fail("GROUP_LIVE_CODEX_PROVIDER_DEFAULT_UNPROVEN");
  return Object.freeze({ ...validated, metadataPath: file, metadataSha256: sha(metadataBytes), sourceConfigPath: sourcePath,
    sourceConfigSha256: record.sha256, sdkVersion, providerProof: "allowlisted-source-projection-and-pinned-public-SDK-default;original-Home-configRead-unresolved;actual-thread-response-is-separate" });
}
function finalObservation(snapshot) {
  try {
    const sourceBytes = boundedFile(snapshot.sourceConfigPath, 1024 * 1024, { privateMode: true });
    let sourceConfigUnchanged;
    try { sourceConfigUnchanged = sha(sourceBytes) === snapshot.sourceConfigSha256; }
    finally { sourceBytes.fill(0); }
    return { sourceConfigUnchanged,
    metadataUnchanged: sha(boundedFile(snapshot.metadataPath, 64 * 1024, { readonly: true, privateMode: true })) === snapshot.metadataSha256,
    providerDefaultProofUnchanged: sha(boundedFile(snapshot.providerDefaultProof.path, 4 * 1024 * 1024, { readonly: true })) === snapshot.providerDefaultProof.sha256 }; }
  catch (error) { return { sourceConfigUnchanged: null, metadataUnchanged: null, providerDefaultProofUnchanged: null, errorCode: error.code ?? "GROUP_LIVE_CODEX_DEFAULTS_OBSERVATION_UNAVAILABLE" }; }
}
module.exports = { safeNativeDefaults, validateFrozenRecord, load, finalObservation };
