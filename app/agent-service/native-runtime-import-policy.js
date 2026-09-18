"use strict";

const path = require("node:path");

function portable(value) {
  return value.split(path.sep).join("/");
}

function cleanPath(value) {
  const normalized = portable(value);
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("Native Runtime import path is invalid");
  }
  return normalized;
}

function under(relativePath, prefix) {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function normalizedList(values = []) {
  if (!Array.isArray(values)) throw new TypeError("Native Runtime import policy list is invalid");
  return Object.freeze(values.map(cleanPath));
}

function normalizedSegmentLists(values = []) {
  if (!Array.isArray(values) || values.some((segments) => !Array.isArray(segments)
    || segments.length === 0 || segments.some((part) => typeof part !== "string" || !part
      || part.includes("\0") || part === "." || part === ".." || part.includes("/")
      || part.includes(path.sep)))) {
    throw new TypeError("Native Runtime import source segments are invalid");
  }
  return Object.freeze(values.map((segments) => Object.freeze([...segments])));
}

function createNativeRuntimeImportAdapter(spec) {
  if (!spec || typeof spec.runtime !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(spec.runtime)
    || !Array.isArray(spec.sourceSegments) || spec.sourceSegments.length === 0
    || spec.sourceSegments.some((part) => typeof part !== "string" || !part || part.includes("\0")
      || part === "." || part === ".." || part.includes("/") || part.includes(path.sep))
    || typeof spec.targetRoot !== "function") {
    throw new TypeError("Native Runtime import adapter is invalid");
  }
  const active = normalizedList(spec.active);
  const pending = normalizedList(spec.pending);
  const skills = normalizedList(spec.skills);
  const additionalSkillSourceSegments = normalizedSegmentLists(
    spec.additionalSkillSourceSegments,
  );
  const targetPrefix = spec.targetPrefix ? cleanPath(spec.targetPrefix) : null;
  const adapter = {
    runtime: spec.runtime,
    sourceSegments: Object.freeze([...spec.sourceSegments]),
    sourceRoot(homeDir) { return path.join(homeDir, ...spec.sourceSegments); },
    targetRoot(paths, runtimeProfileId) { return spec.targetRoot(paths, runtimeProfileId); },
    classify(relativePath) {
      const candidate = cleanPath(relativePath);
      if (skills.some((prefix) => under(candidate, prefix))) return "skill";
      if (pending.some((prefix) => under(candidate, prefix))) return "pending";
      if (active.some((prefix) => under(candidate, prefix))) return "active";
      if ([...skills, ...pending, ...active].some((prefix) => prefix.startsWith(candidate + "/"))) {
        return "container";
      }
      return "exclude";
    },
    destination(relativePath, kind) {
      const candidate = cleanPath(relativePath);
      if (kind === "pending") return path.posix.join(".shoggoth-import-pending", candidate);
      if (kind !== "active") throw new TypeError("Native Runtime import destination kind is invalid");
      if (typeof spec.mapActiveDestination === "function") {
        return cleanPath(spec.mapActiveDestination(candidate));
      }
      return targetPrefix ? path.posix.join(targetPrefix, candidate) : candidate;
    },
    skillRoots: skills,
    additionalSkillRoots(homeDir) {
      return additionalSkillSourceSegments.map((segments) => path.join(homeDir, ...segments));
    },
  };
  return Object.freeze(adapter);
}

module.exports = { createNativeRuntimeImportAdapter };
