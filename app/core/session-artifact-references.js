"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const {
  DEFAULT_EXCLUDE_EXTS,
  artifactKind,
  normalizeArtifactRoots,
  walkArtifactRoots,
} = require("./artifact-scan");

const MAX_REFERENCED_PATHS = 256;
const MAX_SOURCE_STRINGS = 256;
const MAX_SOURCE_STRING_BYTES = 64 * 1024;
const ARTIFACT_GRACE_MS = 5 * 60 * 1000;
const IDENTITY_FILES = new Set([
  "AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md", "TOOLS.md", "MEMORY.md",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSuccessfulToolResult(event) {
  if (event?.kind !== "tool_result" || !isRecord(event.content)) return false;
  const tool = isRecord(event.content.tool) ? event.content.tool : null;
  const historyItem = isRecord(event.content.historyItem) ? event.content.historyItem : null;
  if (typeof tool?.success === "boolean") return tool.success;
  if (typeof historyItem?.success === "boolean") return historyItem.success;
  return ["completed", "succeeded", "success"].includes(tool?.status)
    || ["completed", "succeeded", "success"].includes(historyItem?.status);
}

function eventToolIds(event) {
  if (!isRecord(event?.content)) return [];
  return [event.content.toolCallId, event.content.itemId, event.content.historyItem?.toolCallId]
    .filter((value) => typeof value === "string" && value.length > 0);
}

function collectStrings(value, output, seen = new Set()) {
  if (output.length >= MAX_SOURCE_STRINGS || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= MAX_SOURCE_STRING_BYTES) output.push(value);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const item of values) {
    collectStrings(item, output, seen);
    if (output.length >= MAX_SOURCE_STRINGS) break;
  }
}

function relevantEvent(event, successfulToolIds) {
  if (!isRecord(event)) return false;
  if (["assistant", "artifact"].includes(event.kind)) return true;
  const ids = eventToolIds(event);
  if (event.kind === "tool_result") return isSuccessfulToolResult(event);
  return ["tool_call", "approval"].includes(event.kind)
    && ids.some((id) => successfulToolIds.has(id));
}

function trimPathCandidate(value) {
  return value.trim()
    .replace(/^[([{]+/u, "")
    .replace(/[\])},;:!?]+$/u, "")
    .trim();
}

function extractPathCandidates(value) {
  const candidates = [];
  const add = (candidate) => {
    const trimmed = trimPathCandidate(candidate);
    if (trimmed && trimmed.length <= 4096) candidates.push(trimmed);
  };
  if (!/[\r\n]/u.test(value) && /^(?:\/|file:|\$\{?(?:HOME|PWD)|~[\\/]|\.[\\/])/u.test(value)) add(value);
  const wrappers = /`([^`\r\n]{1,4096})`|"([^"\r\n]{1,4096})"|'([^'\r\n]{1,4096})'/gu;
  for (const match of value.matchAll(wrappers)) add(match[1] ?? match[2] ?? match[3]);
  const prefixes = String.raw`(?:file:\/{2,3}|\$\{HOME\}|\$HOME|\$\{PWD\}|\$PWD|~|\.)[\\/]|(?:[A-Za-z]:\\|\/(?:Users|Volumes|private|tmp|var|home|opt)\/)`;
  const unwrapped = new RegExp(`${prefixes}[^\\s\\r\\n\"'\\x60<>|;&]{0,4095}`, "gu");
  for (const match of value.matchAll(unwrapped)) add(match[0]);
  return candidates;
}

function resolveCandidate(value, workspace, runtimeHome) {
  let candidate = value;
  if (/^file:\/{2,3}/iu.test(candidate)) {
    try { candidate = fileURLToPath(candidate); } catch { return null; }
  } else if (/^(?:\$\{HOME\}|\$HOME|~)[\\/]/u.test(candidate)) {
    candidate = path.join(runtimeHome, candidate.replace(/^(?:\$\{HOME\}|\$HOME|~)[\\/]+/u, ""));
  } else if (/^(?:\$\{PWD\}|\$PWD|\.)[\\/]/u.test(candidate)) {
    candidate = path.join(workspace, candidate.replace(/^(?:\$\{PWD\}|\$PWD|\.)[\\/]+/u, ""));
  }
  if (candidate.includes("\0") || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(candidate)
    || /[*?\[\]{}]/u.test(candidate) || !path.isAbsolute(candidate)) return null;
  return path.resolve(candidate);
}

function contained(relative) {
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

async function realDirectory(directory) {
  try {
    const real = await fs.promises.realpath(directory);
    const stat = await fs.promises.stat(real);
    return stat.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

async function allowedRoots(workspace, runtimeHome) {
  const userHome = os.homedir();
  const outputNames = ["Downloads", "Desktop", "Documents", "output", "outputs", "artifacts"];
  const candidates = [{ directory: workspace, allowRoot: true }];
  for (const home of new Set([runtimeHome, userHome])) {
    for (const name of outputNames) {
      candidates.push({ directory: path.join(home, name), allowRoot: false });
    }
  }
  candidates.push({ directory: os.tmpdir(), allowRoot: false });
  const roots = [];
  for (const candidate of candidates) {
    const real = await realDirectory(candidate.directory);
    if (real && !roots.some((root) => root.path === real)) {
      roots.push({ path: real, allowRoot: candidate.allowRoot });
    }
  }
  return roots;
}

function candidateAllowed(candidate, roots, isDirectory) {
  if (isDirectory && roots.some((root) => root.path === candidate && !root.allowRoot)) return false;
  return roots.some((root) => {
    const relative = path.relative(root.path, candidate);
    return contained(relative) && (root.allowRoot || relative !== "" || !isDirectory);
  });
}

function eventWindow(event, runsById, sessionCreatedAt) {
  const run = typeof event.runId === "string" ? runsById.get(event.runId) : null;
  const eventTime = Number.isSafeInteger(event.occurredAt) ? event.occurredAt : sessionCreatedAt;
  const since = Number.isSafeInteger(run?.startedAt) ? run.startedAt : sessionCreatedAt;
  const terminal = Number.isSafeInteger(run?.finishedAt) ? run.finishedAt : eventTime;
  return { since, until: Math.max(since, terminal, eventTime) + ARTIFACT_GRACE_MS };
}

function artifactActivityTime(stat) {
  return Math.max(...[stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs].filter(Number.isFinite));
}

function matchesAnyWindow(stat, windows) {
  const activity = artifactActivityTime(stat);
  return windows.some(({ since, until }) => activity >= since && activity <= until);
}

async function collectTranscriptReferencedArtifacts({
  events,
  runs,
  workspace,
  runtimeHome,
  sessionCreatedAt,
  agentId,
  maxStats = 2000,
  allowDirectories = true,
  outputRoots = [],
  mtimeOnly = false,
}) {
  if (!Array.isArray(events) || !Array.isArray(runs) || typeof workspace !== "string"
    || typeof runtimeHome !== "string" || !Number.isSafeInteger(sessionCreatedAt)) return [];
  const successfulToolIds = new Set(events.filter(isSuccessfulToolResult).flatMap(eventToolIds));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const candidateWindows = new Map();
  for (const event of events) {
    if (!relevantEvent(event, successfulToolIds)) continue;
    const strings = [];
    collectStrings(event.content, strings);
    const window = eventWindow(event, runsById, sessionCreatedAt);
    for (const source of strings) {
      for (const raw of extractPathCandidates(source)) {
        const resolved = resolveCandidate(raw, workspace, runtimeHome);
        if (!resolved) continue;
        const windows = candidateWindows.get(resolved) || [];
        windows.push(window);
        candidateWindows.set(resolved, windows);
        if (candidateWindows.size >= MAX_REFERENCED_PATHS) break;
      }
      if (candidateWindows.size >= MAX_REFERENCED_PATHS) break;
    }
    if (candidateWindows.size >= MAX_REFERENCED_PATHS) break;
  }
  const roots = await allowedRoots(workspace, runtimeHome);
  for (const root of await normalizeArtifactRoots(outputRoots)) {
    roots.push({ path: root.path, allowRoot: false });
  }
  const directoryCandidates = [];
  const directItems = [];
  for (const [candidate, windows] of candidateWindows) {
    let real;
    let stat;
    try {
      const initial = await fs.promises.lstat(candidate);
      if (initial.isSymbolicLink()) continue;
      real = await fs.promises.realpath(candidate);
      stat = await fs.promises.lstat(real);
    } catch {
      continue;
    }
    if (!candidateAllowed(real, roots, stat.isDirectory())) continue;
    if (!allowDirectories) {
      const root = roots.filter((item) => contained(path.relative(item.path, real)))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (path.relative(root.path, real).split(path.sep).some((part) => part.startsWith(".")
        || ["node_modules", "chat-attachments", "inbound"].includes(part))) continue;
    }
    if (stat.isDirectory()) {
      if (allowDirectories) directoryCandidates.push({ path: real, area: "session-reference", agentId, windows });
    } else if (stat.isFile() && (mtimeOnly
      ? windows.some(({ since, until }) => stat.mtimeMs >= since && stat.mtimeMs <= until)
      : matchesAnyWindow(stat, windows))) {
      const name = path.basename(real);
      const ext = path.extname(name).toLowerCase();
      if (!name.startsWith(".") && !IDENTITY_FILES.has(name) && !DEFAULT_EXCLUDE_EXTS.has(ext)) {
        directItems.push({
          path: real,
          name,
          area: "session-reference",
          agentId,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ...(ext ? { ext } : {}),
          kind: artifactKind(ext),
        });
      }
    }
  }
  const normalized = await normalizeArtifactRoots(directoryCandidates);
  const scanned = await walkArtifactRoots(normalized, {
    maxStats,
    keep: Number.MAX_SAFE_INTEGER,
    excludeDirs: new Set(["node_modules"]),
    identityFiles: IDENTITY_FILES,
  });
  const windowsByRoot = new Map(normalized.map((root) => [root.path, root.windows]));
  const matchedScanned = [];
  for (const item of scanned) {
    const matchingRoots = normalized.filter((candidate) => (
      item.path === candidate.path || item.path.startsWith(`${candidate.path}${path.sep}`)
    ));
    let stat;
    try { stat = await fs.promises.lstat(item.path); } catch { continue; }
    const windows = matchingRoots.flatMap((root) => windowsByRoot.get(root.path) || []);
    if (matchesAnyWindow(stat, windows)) matchedScanned.push(item);
  }
  const byPath = new Map([...directItems, ...matchedScanned].map((item) => [item.path, item]));
  return [...byPath.values()].sort((left, right) => right.mtimeMs - left.mtimeMs);
}

module.exports = { collectTranscriptReferencedArtifacts, extractPathCandidates, resolveCandidate };
