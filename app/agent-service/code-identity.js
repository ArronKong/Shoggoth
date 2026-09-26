"use strict";

const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");
const { serviceError } = require("./security");
const { CODEX_PARENT_VERIFY_TIMEOUT_MS } = require("./codex-startup-timeouts");

const CODEX_TEAM_IDENTIFIER = "2DC432GLL2";
const CODEX_DESIGNATED_REQUIREMENT = "identifier codex and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"2DC432GLL2\"";
const SHOGGOTH_APP_IDENTIFIER = "ai.shoggoth.desktop";
// 首次校验随包分发的 Codex 大型二进制时，macOS 需要读取完整签名链；
// 实机冷启动已超过旧的 8 秒上限。继续保持外部进程有界，但覆盖冷缓存首轮校验。
const CODE_IDENTITY_TIMEOUT_MS = 20_000;

function identityError(code = "CODE_IDENTITY_INVALID") {
  return serviceError(code, code.toLowerCase());
}

function isStrictAdHocAppIdentity(identity) {
  return identity?.adHoc === true
    && identity.teamIdentifier === null
    && identity.identifier === SHOGGOTH_APP_IDENTIFIER
    && typeof identity.cdHash === "string"
    && /^[a-f0-9]{40}$/u.test(identity.cdHash)
    && identity.designatedRequirement === `cdhash H"${identity.cdHash}"`;
}

function isStrictLocalSignedAppIdentity(identity) {
  return identity?.localSigned === true
    && identity.teamIdentifier === null
    && identity.identifier === SHOGGOTH_APP_IDENTIFIER
    && typeof identity.certificateRootHash === "string"
    && /^[a-f0-9]{40}$/u.test(identity.certificateRootHash)
    && identity.designatedRequirement
      === `identifier "${SHOGGOTH_APP_IDENTIFIER}" and certificate root = H"${identity.certificateRootHash}"`;
}

function isLocalFileCryptoAppIdentity(identity) {
  return isStrictLocalSignedAppIdentity(identity) || isStrictAdHocAppIdentity(identity);
}

function parseCodeIdentityDetails(details, options = {}) {
  const teamIdentifier = details.match(/^TeamIdentifier=([^\r\n]+)$/mu)?.[1] || "";
  const designatedRequirement = details.match(/^(?:# )?designated => ([^\r\n]+)$/mu)?.[1] || "";
  if (/^[A-Z0-9]{10}$/u.test(teamIdentifier)
    && designatedRequirement.length > 0 && designatedRequirement.length <= 4096) {
    return Object.freeze({ teamIdentifier, designatedRequirement });
  }

  // 本机开发包没有 Apple Team ID，但可以由固定的本机代码签名证书签名。
  // 只接受 codesign 生成的精确 certificate-root designated requirement；证书
  // 指纹成为稳定身份，避免 ad-hoc CDHash 在每次重打包后变化并反复触发钥匙串授权。
  const allowedLocalIdentifier = options.allowLocalSignedIdentifier;
  const identifier = details.match(/^Identifier=([^\r\n]+)$/mu)?.[1] || "";
  const signatureSize = details.match(/^Signature size=([0-9]+)$/mu)?.[1] || "";
  const authority = details.match(/^Authority=([^\r\n]+)$/mu)?.[1] || "";
  const localRequirement = designatedRequirement.match(
    /^identifier "([A-Za-z0-9.-]+)" and certificate root = H"([a-f0-9]{40})"$/u,
  );
  if (typeof allowedLocalIdentifier === "string" && allowedLocalIdentifier.length > 0
    && identifier === allowedLocalIdentifier && teamIdentifier === "not set"
    && /^[1-9][0-9]{2,6}$/u.test(signatureSize)
    && authority.length > 0 && authority.length <= 256
    && localRequirement?.[1] === allowedLocalIdentifier) {
    return Object.freeze({
      teamIdentifier: null,
      designatedRequirement,
      identifier,
      localSigned: true,
      certificateRootHash: localRequirement[2],
    });
  }

  // 本项目在没有 Developer ID 的本机构建中会显式进行 ad-hoc 深签名。
  // 只有调用方明确给出 bundle id，且 codesign 的 identifier、CDHash 与
  // designated requirement 三者完全互相绑定时，才承认这是当前 App 的自身份。
  const allowedIdentifier = options.allowAdHocIdentifier;
  const signature = details.match(/^Signature=([^\r\n]+)$/mu)?.[1] || "";
  const cdHash = details.match(/^CDHash=([a-fA-F0-9]+)$/mu)?.[1]?.toLowerCase() || "";
  if (typeof allowedIdentifier !== "string" || allowedIdentifier.length === 0
    || identifier !== allowedIdentifier || signature !== "adhoc"
    || teamIdentifier !== "not set" || !/^[a-f0-9]{40}$/u.test(cdHash)
    || designatedRequirement !== `cdhash H"${cdHash}"`) {
    throw identityError();
  }
  return Object.freeze({
    teamIdentifier: null,
    designatedRequirement,
    identifier,
    adHoc: true,
    cdHash,
  });
}

function readCodeIdentity(executablePath, options = {}) {
  const executable = path.resolve(executablePath || "");
  if (!path.isAbsolute(executablePath || "") || executable.includes("\0")) throw identityError();
  const run = options.spawnSync || spawnSync;
  const verifyTimeoutMs = options.verifyTimeoutMs === undefined ? CODE_IDENTITY_TIMEOUT_MS : options.verifyTimeoutMs;
  if (!Number.isSafeInteger(verifyTimeoutMs) || verifyTimeoutMs <= 0
    || verifyTimeoutMs > CODEX_PARENT_VERIFY_TIMEOUT_MS) throw identityError();
  try {
    const verified = run("/usr/bin/codesign", ["--verify", "--strict", executable], {
      encoding: "utf8", timeout: verifyTimeoutMs, maxBuffer: 64 * 1024,
    });
    if (verified?.error) throw verified.error;
    if (verified?.status !== 0) throw identityError();
    const described = run("/usr/bin/codesign", ["-d", "--verbose=4", "-r-", executable], {
      encoding: "utf8", timeout: CODE_IDENTITY_TIMEOUT_MS, maxBuffer: 64 * 1024,
    });
    if (described?.error) throw described.error;
    if (described?.status !== 0) throw identityError();
    const details = `${described.stdout || ""}\n${described.stderr || ""}`;
    return parseCodeIdentityDetails(details, options);
  } catch (error) {
    throw identityError(error?.code === "ETIMEDOUT" ? "CODE_IDENTITY_TIMEOUT" : "CODE_IDENTITY_INVALID");
  }
}

function execCodeSignAsync(run, args) {
  return new Promise((resolve, reject) => {
    run("/usr/bin/codesign", args, {
      encoding: "utf8", timeout: CODE_IDENTITY_TIMEOUT_MS, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ stdout, stderr });
    });
  });
}

async function readCodeIdentityAsync(executablePath, options = {}) {
  try {
    const executable = path.resolve(executablePath || "");
    if (!path.isAbsolute(executablePath || "") || executable.includes("\0")) throw identityError();
    const run = options.execFile || execFile;
    await execCodeSignAsync(run, ["--verify", "--strict", executable]);
    const described = await execCodeSignAsync(
      run, ["-d", "--verbose=4", "-r-", executable],
    );
    const details = `${described.stdout || ""}\n${described.stderr || ""}`;
    return parseCodeIdentityDetails(details, options);
  } catch {
    throw identityError();
  }
}

function assertCodeIdentity(executablePath, expected = {}, options = {}) {
  const identity = (options.readCodeIdentity || readCodeIdentity)(executablePath, options);
  if (!identity || typeof identity !== "object"
    || (expected.teamIdentifier !== undefined
      && identity.teamIdentifier !== expected.teamIdentifier)
    || (expected.designatedRequirement !== undefined
      && identity.designatedRequirement !== expected.designatedRequirement)) {
    throw identityError();
  }
  return identity;
}

module.exports = {
  CODEX_DESIGNATED_REQUIREMENT,
  CODEX_TEAM_IDENTIFIER,
  SHOGGOTH_APP_IDENTIFIER,
  assertCodeIdentity,
  isLocalFileCryptoAppIdentity,
  isStrictAdHocAppIdentity,
  isStrictLocalSignedAppIdentity,
  readCodeIdentity,
  readCodeIdentityAsync,
};
