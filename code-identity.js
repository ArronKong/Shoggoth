"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { serviceError } = require("./security");

const CODEX_TEAM_IDENTIFIER = "2DC432GLL2";
const CODEX_DESIGNATED_REQUIREMENT = "identifier codex and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"2DC432GLL2\"";
// 首次校验随包分发的 Codex 大型二进制时，macOS 可能需要读取完整签名链；
// 实机冷启动稳定超过 1 秒。仍保持外部进程有界，但不能把正常校验误判为攻击。
const CODE_IDENTITY_TIMEOUT_MS = 8_000;

function identityError() {
  return serviceError("CODE_IDENTITY_INVALID", "code_identity_invalid");
}

function readCodeIdentity(executablePath, options = {}) {
  const executable = path.resolve(executablePath || "");
  if (!path.isAbsolute(executablePath || "") || executable.includes("\0")) throw identityError();
  const run = options.spawnSync || spawnSync;
  try {
    const verified = run("/usr/bin/codesign", ["--verify", "--strict", executable], {
      encoding: "utf8", timeout: CODE_IDENTITY_TIMEOUT_MS, maxBuffer: 64 * 1024,
    });
    if (verified?.status !== 0 || verified?.error) throw identityError();
    const described = run("/usr/bin/codesign", ["-d", "--verbose=4", "-r-", executable], {
      encoding: "utf8", timeout: CODE_IDENTITY_TIMEOUT_MS, maxBuffer: 64 * 1024,
    });
    if (described?.status !== 0 || described?.error) throw identityError();
    const details = `${described.stdout || ""}\n${described.stderr || ""}`;
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
  assertCodeIdentity,
  readCodeIdentity,
};
