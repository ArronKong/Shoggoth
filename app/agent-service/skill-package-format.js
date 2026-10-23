"use strict";

const yaml = require("js-yaml");
const { serviceError } = require("./security");

const PORTABLE_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const DEPENDENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const own = value => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const fail = () => { throw serviceError("SKILL_MANIFEST_INVALID", "SKILL.md 的 name、description 或依赖声明无效"); };

function isSkillPackagingArtifact(parts) {
  return parts.some(part => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"));
}

// Preserve host metadata in SKILL.md. Only an explicit x-shoggoth contract
// supplies Shoggoth dependencies; allowed-tools never grants permissions.
function portableSkillManifest(content, contentDigest) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match || Buffer.byteLength(match[1], "utf8") > 64 * 1024) fail();
  let frontmatter;
  try { frontmatter = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }); }
  catch { fail(); }
  if (!own(frontmatter) || typeof frontmatter.name !== "string" || !PORTABLE_NAME.test(frontmatter.name)
    || typeof frontmatter.description !== "string" || !frontmatter.description.trim()
    || frontmatter.description.length > 1024
    || (frontmatter.metadata !== undefined && !own(frontmatter.metadata))
    || (frontmatter.compatibility !== undefined && (typeof frontmatter.compatibility !== "string"
      || !frontmatter.compatibility.trim() || frontmatter.compatibility.length > 500))) fail();
  const requirements = frontmatter["x-shoggoth"] ?? {};
  const dependencies = value => Array.isArray(value) && value.length <= 128
    && value.every(item => typeof item === "string" && DEPENDENCY.test(item))
    && new Set(value).size === value.length;
  if (!own(requirements)
    || Object.keys(requirements).some(key => !["requiredTools", "requiredRuntimeCapabilities"].includes(key))
    || !dependencies(requirements.requiredTools ?? [])
    || !dependencies(requirements.requiredRuntimeCapabilities ?? [])) fail();
  const declaredVersion = frontmatter.version ?? frontmatter.metadata?.version;
  return {
    schemaVersion: 1,
    id: frontmatter.name,
    name: frontmatter.name,
    version: typeof declaredVersion === "string" && VERSION.test(declaredVersion)
      ? declaredVersion : `0.0.0-import.${contentDigest.slice(0, 24)}`,
    description: frontmatter.description,
    entry: "SKILL.md",
    requiredTools: requirements.requiredTools ?? [],
    requiredRuntimeCapabilities: requirements.requiredRuntimeCapabilities ?? [],
    sourceCompatibility: ["shoggoth", "codex", "openclaw", "hermes"],
  };
}

module.exports = { isSkillPackagingArtifact, portableSkillManifest };
