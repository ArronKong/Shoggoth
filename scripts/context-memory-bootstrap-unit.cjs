"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { selectFileMemory } = require("../app/agent-service/context-memory-bootstrap");
const { untrusted } = require("../app/agent-service/context-compiler");
const { renderMemoryEntry } = require("../app/agent-service/shoggoth-memory/migration.cjs");
const file = (path, prefix, count = 30, body = "x".repeat(600)) => {
  const items = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, content: `${prefix}-${i}: ${body} Conditions ${i}.` }));
  return { path, items, text: items.map(renderMemoryEntry).join("\n") };
};
const select = (files, extra = {}) => selectFileMemory(files, { budgetBytes: 12 * 1024,
  notice: "Read the remaining source with memory_get.", wrap: untrusted, ...extra });

test("each memory file receives a share and daily notes retain complete recent entries", () => {
  const files = [file("MEMORY.md", "long"), file("memory/2026-11-10.md", "today"), file("memory/2026-11-09.md", "yesterday")];
  const before = JSON.stringify(files), result = select(files);
  assert.ok(result.report.actualBytes <= 12 * 1024);
  assert.equal(result.report.fileCoverage.length, 3);
  assert.ok(result.report.fileCoverage.every(row => row.injectedBytes > 0 && row.omittedBytes > 0 && row.truncated));
  assert.match(result.content, /long-0:/u);
  assert.match(result.content, /today-29:/u);
  assert.match(result.content, /yesterday-29:/u);
  assert.doesNotMatch(result.content, /today-0:/u);
  assert.equal((result.content.match(/<!-- shoggoth-memory-entry:/gu) || []).length,
    (result.content.match(/<!-- \/shoggoth-memory-entry -->/gu) || []).length);
  for (const item of result.selectedItems) assert.ok(result.content.includes(item.content));
  assert.equal(JSON.stringify(files), before);
});

test("short daily files release their unused share and ample budgets preserve exact source text", () => {
  const files = [file("MEMORY.md", "long"), file("memory/2026-11-10.md", "today", 1, "brief"),
    file("memory/2026-11-09.md", "yesterday", 1, "brief")];
  const result = select(files);
  assert.ok(result.report.fileCoverage[0].injectedBytes > 8 * 1024);
  assert.ok(result.report.fileCoverage.slice(1).every(row => !row.truncated));
  const full = select(files, { budgetBytes: 64 * 1024 });
  for (const source of files) assert.ok(full.content.includes(source.text));
  assert.equal(full.truncated, false);
});

test("CJK token and UTF-8 budgets include labels; oversized entries are omitted intact", () => {
  const files = [file("MEMORY.md", "long", 20, "保留日期和否定条件。".repeat(40)),
    file("memory/2026-11-10.md", "today", 3, "近期记录")];
  const result = select(files, { tokenBudget: 600 });
  assert.ok(result.report.estimatedTokens <= 600);
  assert.ok(result.report.actualBytes <= 12 * 1024);
  assert.ok(result.report.fileCoverage[0].truncated);
  const tiny = select(files, { budgetBytes: 1, tokenBudget: 1 });
  assert.equal(tiny.content, ""); assert.equal(tiny.selectedItems.length, 0);
  assert.ok(tiny.report.fileCoverage.every(row => row.injectedBytes === 0));
});

test("duplicate multiline bodies retain provenance only for the selected complete record", () => {
  const items = ["earlier", "latest"].map(id => ({ id, content: `${"x".repeat(2000)}\nDo not publish unless approved.` }));
  const result = select([{ path: "memory/2026-11-10.md", items, text: items.map(renderMemoryEntry).join("\n") }],
    { budgetBytes: 3000 });
  assert.deepEqual(result.selectedItems.map(item => item.id), ["latest"]);
  assert.match(result.content, /Do not publish unless approved/u);
});
