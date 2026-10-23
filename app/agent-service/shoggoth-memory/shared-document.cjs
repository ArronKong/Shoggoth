"use strict";

// Product sharing has a narrower corpus than the native memory index. Keep
// these names explicit; arbitrary extraPaths and hidden session corpus are
// never admitted merely because the source owner can search them itself.
const DAILY = /^memory\/\d{4}-\d{2}-\d{2}\.md$/u;
const REPORT = /^memory\/dreaming\/(?:light|rem|deep)\/\d{4}-\d{2}-\d{2}\.md$/u;
function canonicalSharedPath(relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes("\0")
    || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..")) return null;
  return ["USER.md", "MEMORY.md", "DREAMS.md", "dreams.md"].includes(relative) || DAILY.test(relative) || REPORT.test(relative) ? relative : null;
}
function documentKind(relative, content = "", startLine = 1, endLine = startLine) {
  if (!canonicalSharedPath(relative)) return null;
  if (relative === "USER.md") return "user";
  if (relative === "MEMORY.md") return "long_term";
  if (!DAILY.test(relative)) return "reflection_report";
  const lines = content.split("\n"); let phase = null;
  for (let index = 0; index < Math.min(endLine, lines.length); index++) {
    const start = lines[index].match(/^\s*<!--\s*openclaw:dreaming:(light|rem):start\s*-->\s*$/u);
    const end = lines[index].match(/^\s*<!--\s*openclaw:dreaming:(light|rem):end\s*-->\s*$/u);
    if (start) phase = start[1];
    if (index + 1 >= startLine && phase) return "reflection_report";
    if (end && end[1] === phase) phase = null;
  }
  return "daily";
}
function hasReportSource(item, text) {
  // A report is inference, not a new hand-authored fact. Require verifiable
  // source ranges, session origins, or a persisted explicit Product record.
  return Boolean(item?.sourceEvidence?.length || item && !item.projection && item.createdAt > 0
    && item.sourceRefs?.length || /openclaw-memory-promotion:/u.test(text)
    || /\[[^\]\s]+\/sessions\/(?:[^/\s]+\/)?[^#\s\]]+#L\d+\]/u.test(text)
    || /\bmemory\/[^\n`<>]*?\.(?:txt|md)(?::\d+-\d+|#L\d+-L\d+)/u.test(text));
}
module.exports = { canonicalSharedPath, documentKind, hasReportSource };
