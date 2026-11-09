"use strict";

const { estimateContextTokens } = require("./conversation-context-budget");
const bytes = text => Buffer.byteLength(text, "utf8");

// Keep a stored record (including qualifications and negations) together.
// Handwritten material uses paragraph boundaries. Daily notes prefer the tail.
function memoryUnits(text) {
  const units = [], entry = /<!-- shoggoth-memory-entry:[^\n]+ -->\n[\s\S]*?\n<!-- \/shoggoth-memory-entry -->/gu;
  let offset = 0;
  const prose = value => units.push(...value.split(/\n\s*\n/u).filter(value => value.trim()));
  for (const match of text.matchAll(entry)) {
    prose(text.slice(offset, match.index)); units.push(match[0]); offset = match.index + match[0].length;
  }
  prose(text.slice(offset));
  return units;
}

function fairShares(demands, total) {
  const shares = demands.map(() => 0), pending = new Set(demands.map((_, index) => index));
  while (pending.size && total > 0) {
    const share = Math.floor(total / pending.size);
    const small = [...pending].filter(index => demands[index] <= share);
    if (!small.length) {
      for (const index of pending) { shares[index] = share; total -= share; }
      break;
    }
    for (const index of small) { shares[index] = demands[index]; total -= demands[index]; pending.delete(index); }
  }
  return shares;
}

function selectFileMemory(files, { budgetBytes, tokenBudget = Infinity, notice, wrap }) {
  const partial = `\n[Partial file. ${notice}]`;
  const reserved = wrap("MEMORY FILES", files.map(file => `## ${file.path}\n${partial}`).join("\n\n"));
  const contentBytes = Math.max(0, budgetBytes - bytes(reserved));
  const contentTokens = Math.max(0, tokenBudget - estimateContextTokens(reserved));
  const byteShares = fairShares(files.map(file => bytes(file.text)), contentBytes);
  const tokenShares = Number.isFinite(contentTokens)
    ? fairShares(files.map(file => estimateContextTokens(file.text)), contentTokens) : files.map(() => Infinity);
  const rendered = files.map((file, index) => {
    let text = "", selected = [];
    const units = memoryUnits(file.text), recentFirst = /^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(file.path);
    if (bytes(file.text) <= byteShares[index] && estimateContextTokens(file.text) <= tokenShares[index]) {
      text = file.text; selected = units.map((_, i) => i);
    } else {
      let usedBytes = 0, usedTokens = 0;
      const order = units.map((_, i) => i); if (recentFirst) order.reverse();
      for (const i of order) {
        const size = bytes(units[i]) + 2, tokens = estimateContextTokens(units[i]) + 1;
        if (usedBytes + size > byteShares[index] || usedTokens + tokens > tokenShares[index]) continue;
        selected.push(i); usedBytes += size; usedTokens += tokens;
      }
      text = selected.sort((a, b) => a - b).map(i => units[i]).join("\n\n");
    }
    const truncated = text !== file.text;
    return { file, text, truncated, stats: { path: file.path, sourceBytes: bytes(file.text),
      injectedBytes: bytes(text), omittedBytes: Math.max(0, bytes(file.text) - bytes(text)),
      selectedUnits: selected.length, candidateUnits: units.length, truncated,
      order: recentFirst ? "recent_first" : "file_order" } };
  });
  let content = files.length ? wrap("MEMORY FILES", rendered.map(row => `## ${row.file.path}\n${row.text}${row.truncated ? partial : ""}`).join("\n\n")) : "";
  // Even file labels may exceed a tiny remaining model window. Report the
  // omission; never cut an instruction boundary or silently overrun the budget.
  if (bytes(content) > budgetBytes || estimateContextTokens(content) > tokenBudget) {
    content = "";
    for (const row of rendered) { row.text = ""; row.truncated = true;
      Object.assign(row.stats, { injectedBytes: 0, omittedBytes: row.stats.sourceBytes, selectedUnits: 0, truncated: true }); }
  }
  const selectedItems = rendered.flatMap(row => row.file.items.filter(item => {
    const marker = `<!-- shoggoth-memory-entry:${item.id} -->`;
    return row.file.text.includes(marker) ? row.text.includes(marker) : row.text.includes(item.content);
  }));
  const truncated = rendered.some(row => row.truncated);
  return { content, selectedItems, truncated,
    report: { budgetBytes, budgetTokens: Number.isFinite(tokenBudget) ? tokenBudget : null,
      actualBytes: bytes(content), estimatedTokens: estimateContextTokens(content), tokenMeasurement: "estimated",
      candidateCount: files.reduce((sum, file) => sum + file.items.length, 0), selectedCount: selectedItems.length,
      searchTruncated: truncated, priorityCandidates: null, prioritySelected: 0, priorityCoverage: null,
      priorityMetric: "balanced_files", sorting: [], files: files.map(file => file.path),
      fileCoverage: rendered.map(row => row.stats) } };
}

module.exports = { selectFileMemory };
