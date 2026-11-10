"use strict";

const crypto = require("node:crypto");
const hashLine = text => crypto.createHash("sha256").update(text).digest("hex");
const normalizeRule = text => text.normalize("NFKC").replace(/[\s`*_]/gu, "");

// Receipts contain hashes and positions, never another copy of an old document.
// Eight characters is the minimum fact length accepted by definition-links.
// Coverage deliberately errs toward preserving a pre-existing fact: matching
// fragments can produce a false positive, but cannot acquire an older fact.
function priorCoverage(line, grams) {
  const text = normalizeRule(line), covered = new Uint8Array(text.length);
  for (let at = 0; at + 8 <= text.length; at++) {
    if (grams.has(text.slice(at, at + 8))) covered.fill(1, at, at + 8);
  }
  const spans = [];
  for (let at = 0; at < covered.length;) {
    if (!covered[at]) { at++; continue; }
    const start = at;
    while (covered[at]) at++;
    spans.push([start, at]);
  }
  return spans;
}

function advanceProvenance(previous, before, after) {
  const provenance = structuredClone(previous || { templates: {}, lineBirth: {}, receipts: {} });
  for (const [kind, ref] of Object.entries(after.manifest.documents)) {
    const original = provenance.templates[kind] || { hash: ref.contentHash, unchanged: true };
    if ((before && before.manifest.documents[kind].contentHash !== ref.contentHash)
      || ["import", "restore"].includes(after.manifest.actor)) original.unchanged = false;
    provenance.templates[kind] = original;
  }
  const oldLines = new Set((before?.documents.AGENTS || "").split("\n"));
  const lines = [...new Set(after.documents.AGENTS.split("\n").filter(line => line.trim()))];
  provenance.lineBirth = Object.fromEntries(lines.map(line => {
    const hash = hashLine(line);
    return [hash, oldLines.has(line) && provenance.lineBirth[hash] || after.manifest.revision];
  }));
  if (after.manifest.reason?.startsWith("conversation-definition:")) {
    const oldText = normalizeRule(before?.documents.AGENTS || ""), grams = new Set();
    for (let at = 0; at + 8 <= oldText.length; at++) grams.add(oldText.slice(at, at + 8));
    provenance.receipts[after.manifest.revision] = {
      manifest: after.manifest,
      rules: lines.filter(line => !oldLines.has(line)).map(line => ({
        hash: hashLine(line), priorCoverage: priorCoverage(line, grams),
      })),
    };
  }
  return provenance;
}

function factWasPresent(line, fact, coverage) {
  const at = normalizeRule(line).indexOf(fact);
  return at >= 0 && coverage.some(([start, end]) => start <= at && end >= at + fact.length);
}

module.exports = { advanceProvenance, factWasPresent, hashLine, normalizeRule };
