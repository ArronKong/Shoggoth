"use strict";

// 双后端复用的产物扫描/预览层（从 openclaw-backend 抽出，Hermes 共用）：
// - walkArtifactRoots：深度≤2、lstat 不追 symlink、stat 硬上限、点文件与
//   黑名单过滤，mtime desc 截 keep。
// - normalizeArtifactRoots：realpath + 去重 + 必须是目录。
// - resolveArtifactPreviewPath：Dashboard 缩略图重验证（realpath 包含在允许
//   根内 + 图片扩展名 + 普通文件）。
// 聊天 /__media 的 OpenClaw 安全边界与这里无关，保持不动。

const fs = require("node:fs");
const path = require("node:path");

const ARTIFACT_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"]);
const ARTIFACT_DOC_EXTS = new Set([".md", ".txt", ".pdf", ".html", ".doc", ".docx", ".rtf"]);
const ARTIFACT_DATA_EXTS = new Set([".json", ".csv", ".tsv", ".xlsx", ".yaml", ".yml", ".xml"]);
const DEFAULT_EXCLUDE_EXTS = new Set([".jsonl", ".bak", ".lock", ".tmp", ".log"]);

function artifactKind(ext) {
  if (ARTIFACT_IMAGE_EXTS.has(ext)) return "image";
  if (ARTIFACT_DOC_EXTS.has(ext)) return "doc";
  if (ARTIFACT_DATA_EXTS.has(ext)) return "data";
  return "other";
}

/** realpath + 去重 + 目录校验；candidates: [{path, area, agentId?}] */
async function normalizeArtifactRoots(candidates) {
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    try {
      const real = await fs.promises.realpath(c.path);
      if (seen.has(real)) continue;
      const st = await fs.promises.stat(real);
      if (!st.isDirectory()) continue;
      seen.add(real);
      out.push({ ...c, path: real });
    } catch { /* missing root → skip */ }
  }
  return out;
}

async function walkArtifactRoots(roots, {
  maxStats = 2000,
  keep = 100,
  excludeDirs = new Set(),
  excludeExts = DEFAULT_EXCLUDE_EXTS,
  identityFiles = new Set(),
  kindForExt = artifactKind,
} = {}) {
  let stats = 0;
  const items = [];
  const consider = (fullPath, name, st, root) => {
    if (!st.isFile()) return; // lstat: symlinked files excluded too
    if (name.startsWith(".") || identityFiles.has(name)) return;
    const ext = path.extname(name).toLowerCase();
    if (excludeExts.has(ext)) return;
    items.push({
      path: fullPath,
      name,
      area: root.area,
      ...(root.agentId ? { agentId: root.agentId } : {}),
      size: st.size,
      mtimeMs: st.mtimeMs,
      ...(ext ? { ext } : {}),
      kind: kindForExt(ext),
    });
  };
  for (const root of roots) {
    let names;
    try { names = await fs.promises.readdir(root.path); } catch { continue; }
    for (const name of names) {
      if (stats >= maxStats) break;
      if (name.startsWith(".")) continue;
      const p = path.join(root.path, name);
      let st;
      try { stats += 1; st = await fs.promises.lstat(p); } catch { continue; }
      if (st.isFile()) {
        consider(p, name, st, root);
      } else if (st.isDirectory() && !excludeDirs.has(name)) {
        // depth 2: files only, no deeper recursion
        let sub;
        try { sub = await fs.promises.readdir(p); } catch { continue; }
        for (const subName of sub) {
          if (stats >= maxStats) break;
          if (subName.startsWith(".")) continue;
          let sst;
          try { stats += 1; sst = await fs.promises.lstat(path.join(p, subName)); } catch { continue; }
          consider(path.join(p, subName), subName, sst, root);
        }
      }
      // symlinked directories intentionally not entered
    }
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items.slice(0, keep);
}

/** Dashboard 预览重验证：realpath 落在任一允许根内 + 图片扩展 + 普通文件。 */
async function resolveArtifactPreviewPath(requestedPath, roots, imageExts = ARTIFACT_IMAGE_EXTS) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) return null;
  let real;
  try {
    real = await fs.promises.realpath(requestedPath);
  } catch {
    return null;
  }
  const contained = roots.some((r) => real === r.path || real.startsWith(r.path + path.sep));
  if (!contained) return null;
  if (!imageExts.has(path.extname(real).toLowerCase())) return null;
  try {
    const st = await fs.promises.stat(real);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  return { absPath: real };
}

module.exports = {
  ARTIFACT_IMAGE_EXTS,
  DEFAULT_EXCLUDE_EXTS,
  artifactKind,
  normalizeArtifactRoots,
  walkArtifactRoots,
  resolveArtifactPreviewPath,
};
