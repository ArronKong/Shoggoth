"use strict";

const crypto = require("node:crypto");
const QUESTIONS = Object.freeze([
  { id: "goal", question: "What is the current project goal? Name the project and its two required outputs.",
    clauses: [["Museum Atlas"], ["offline catalog"], ["SHA-256", "SHA256"]],
    answer: "Museum Atlas needs an offline catalog and a SHA-256 manifest for the imported exhibits." },
  { id: "constraints", question: "What three constraints must the implementation preserve? State the worker limit exactly.",
    clauses: [["no network", "offline only"], ["originals read-only", "never modify originals"], ["8 workers", "eight workers"]],
    answer: "No network requests; keep originals read-only; allow at most 8 workers.", forbidden: ["16 workers", "modify originals in place"] },
  { id: "decisions", question: "Which database mode and manifest update policy did we finally choose?",
    clauses: [["SQLite WAL"], ["immutable manifest"]],
    answer: "Use SQLite WAL and an immutable manifest written by atomic replacement.", forbidden: ["use postgres", "use a mutable manifest"] },
  { id: "files", question: "List the three agreed key source/test files using their exact paths.",
    clauses: [["src/catalog/indexer.ts"], ["src/catalog/schema.sql"], ["tests/catalog-recovery.test.ts"]],
    answer: "src/catalog/indexer.ts, src/catalog/schema.sql, tests/catalog-recovery.test.ts." },
  { id: "next", question: "What are the next two steps, in the agreed order and with the benchmark size?",
    clauses: [["crash recovery", "crash-recovery"], ["50000", "50,000", "50k"]],
    answer: "First test crash recovery, then benchmark 50,000 fixture files.",
    ordered: [["crash recovery", "crash-recovery"], ["50000", "50,000", "50k"]] },
]);

function dialogueFixture(rounds) {
  if (![30, 50].includes(rounds)) throw new Error("HANDOFF_EVAL_ROUNDS_INVALID");
  const facts = new Map([
    [1, "Project goal: Museum Atlas needs an offline catalog and a SHA-256 manifest for imported exhibits."],
    [3, "Binding constraints: no network requests, originals read-only, and at most 8 workers."],
    [Math.floor(rounds / 2), "Final storage decision: SQLite WAL. Use an immutable manifest with atomic replacement."],
    [rounds - 5, "Key files: src/catalog/indexer.ts, src/catalog/schema.sql, tests/catalog-recovery.test.ts."],
    [rounds - 1, "Next steps in order: first test crash recovery, then benchmark 50,000 fixture files."],
  ]);
  const turns = Array.from({ length: rounds }, (_, index) => {
    const round = index + 1;
    const user = facts.get(round) || `Round ${round}: inspect fixture exhibit group ${String(round).padStart(3, "0")}. `
      + "Record duplicate filenames, byte lengths, Unicode labels and stable sorting. Report observations without changing the source exhibits. "
      + "The sample collection has text descriptions, photographs and an exported checksum list. Keep any scratch output inside the test workspace.";
    return { user, assistant: facts.has(round) ? "Recorded this project fact for the implementation."
      : `Group ${String(round).padStart(3, "0")} reviewed: ordering is deterministic, labels retain Unicode and checksums match the fixture. `
        + "No source files were edited. Duplicate names remain separate records, so the index can recover them by their stable exhibit identifiers." };
  });
  const serialized = JSON.stringify(turns);
  return { version: 1, rounds, turns, sha256: crypto.createHash("sha256").update(serialized).digest("hex") };
}

const normalize = value => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
function scoreAnswers(answers, threshold = 4) {
  if (threshold !== 4) throw new Error("HANDOFF_EVAL_THRESHOLD_FIXED");
  const valid = answers && Object.getPrototypeOf(answers) === Object.prototype
    && Object.keys(answers).sort().join(",") === QUESTIONS.map(q => q.id).sort().join(",")
    && QUESTIONS.every(q => typeof answers[q.id] === "string" && Buffer.byteLength(answers[q.id]) <= 4096);
  const items = QUESTIONS.map(q => {
    const answer = valid ? normalize(answers[q.id]) : "";
    const matched = q.clauses.map(alternatives => alternatives.some(part => answer.includes(normalize(part))));
    const contradiction = (q.forbidden || []).some(part => answer.includes(normalize(part)));
    const positions = q.ordered?.map(parts => Math.min(...parts.map(part => answer.indexOf(normalize(part))).filter(index => index >= 0)));
    const ordered = !positions || (positions.every(Number.isFinite) && positions[0] < positions[1]);
    return { id: q.id, passed: valid && matched.every(Boolean) && !contradiction && ordered, matched, contradiction, ordered };
  });
  const correct = items.filter(item => item.passed).length;
  return { threshold, correct, total: QUESTIONS.length, passed: correct >= threshold, validFormat: !!valid, items };
}

// A deterministic read-back probe, deliberately not a model. It only produces
// an answer when every required literal survives in the actual compiled seed.
function fixtureReadback(context) {
  const normalized = normalize(context);
  return Object.fromEntries(QUESTIONS.map(q => [q.id,
    q.clauses.every(parts => parts.some(part => normalized.includes(normalize(part)))) ? q.answer : "Unknown from retained context."]));
}

module.exports = { QUESTIONS, dialogueFixture, scoreAnswers, fixtureReadback };
