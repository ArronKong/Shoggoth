"use strict";

// One-time import of the notes Grok's own experimental memory (memory-v2)
// kept for a Shoggoth Agent before Shoggoth turned it off (GROK_MEMORY=0).
// Only that Agent's workspace scope is read
// (<GROK_HOME>/memory-v2/workspaces/<profileId>-<hash8>); the user's global
// Grok memory and other projects stay untouched. Like OpenClaw's
// memory/imports, each note is searchable but never part of the bootstrap:
// it becomes an Agent-trust record in the daily note of the day Grok captured
// it, so Dreaming can still promote it if it keeps being recalled.

const fs = require("node:fs");
const path = require("node:path");
const { sha256 } = require("./migration.cjs");
const { hasSecret, hasPii } = require("../memory-engine");
const { memoryThreatPattern } = require("../memory-threat-scan");

const STATE_NAMESPACE = "native-memory-import";
const STATE_KEY = "grok";
const MAX_NOTES = 500;
const MAX_NOTE_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 2048;
const ENTRY_MARKER = /<!--\s*\/?(?:shoggoth|openclaw)-memory/iu;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function readDirectory(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; }
}

// Grok's curated topics and its not-yet-folded observations. The generated
// MEMORY.md index is skipped.
function grokNotes(grokHome, profileId) {
  const root = path.join(grokHome, "memory-v2", "workspaces");
  const scope = new RegExp(`^${escapeRegExp(profileId)}-[0-9a-f]{8}$`, "u"), notes = [];
  for (const workspace of readDirectory(root)) {
    if (!workspace.isDirectory() || !scope.test(workspace.name)) continue;
    for (const folder of ["topics", path.join("observations", "_inbox")]) {
      const directory = path.join(root, workspace.name, folder);
      for (const file of readDirectory(directory)) {
        if (notes.length >= MAX_NOTES || !file.isFile() || !file.name.endsWith(".md")) continue;
        const target = path.join(directory, file.name), stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) continue;
        notes.push({ relative: path.join(workspace.name, folder, file.name), text: fs.readFileSync(target, "utf8"), mtimeMs: stat.mtimeMs });
      }
    }
  }
  return notes;
}

function parseNote(text) {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(normalized);
  const front = match ? match[1] : "", body = (match ? match[2] : normalized).trim();
  const seconds = Number(/^created_at:\s*(\d{9,12})\s*$/mu.exec(front)?.[1]);
  const type = /^type:\s*"?([A-Za-z_-]{1,32})"?\s*$/mu.exec(front)?.[1] || "note";
  return { body, type, createdAt: Number.isSafeInteger(seconds) ? seconds * 1000 : null };
}

function bounded(text) {
  if (Buffer.byteLength(text, "utf8") <= MAX_CONTENT_BYTES) return text;
  const chars = Array.from(text);
  while (Buffer.byteLength(`${chars.join("")}…`, "utf8") > MAX_CONTENT_BYTES) chars.pop();
  return `${chars.join("")}…`;
}

async function importGrokMemory(service, profileId, { grokHome }) {
  const state = service.host(profileId).database.openKeyedStore({ namespace: STATE_NAMESPACE, maxEntries: 16 });
  if (await state.lookup(STATE_KEY)) return { imported: 0, reason: "done" };
  const now = service.now(), records = [];
  for (const note of grokNotes(grokHome, profileId)) {
    const { body, type, createdAt } = parseNote(note.text);
    if (!body) continue;
    const content = bounded(`Imported from Grok's own memory (${type}): ${body.replace(/^#\s+/u, "").replace(/\n{3,}/gu, "\n\n")}`);
    if (hasSecret(content) || memoryThreatPattern(content) || ENTRY_MARKER.test(content)
      || service.recallPolicy.hasRevokedContent(profileId, content)) continue;
    const id = `grok-memory-${sha256(`${note.relative}\0${body}`).slice(0, 40)}`;
    if (service.store.get(profileId, id)) continue;
    const { day } = service.sessionCapture.day(profileId, createdAt ?? note.mtimeMs);
    records.push({ id, profileId, scope: "agent", type: "episodic", content,
      sourceRefs: [`grok-memory:${sha256(note.relative).slice(0, 32)}`], confidence: 0.5,
      sensitivity: hasPii(content) ? "private" : "normal", status: "active", validFrom: now, validUntil: null,
      supersedes: null, createdAt: now, updatedAt: now, memoryPath: `memory/${day}.md` });
  }
  if (records.length) await service.store.upsertMany(records, {});
  await state.register(STATE_KEY, { importedAt: now, count: records.length });
  return { imported: records.length, reason: "imported" };
}

module.exports = { importGrokMemory, grokNotes, parseNote };
