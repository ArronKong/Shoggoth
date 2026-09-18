#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const privateDirectories = new Set(['docs', 'tasks', '.superpowers', '.vscode']);
const privateFiles = new Set([
  'ARCHITECTURE.md', 'BUG_REPORT.md', 'CLAUDE.md', 'PROGRESS.md', 'prd.md',
  'openclaw-hermes-kanban-flow.png', 'openclaw-hermes-kanban-flow.svg',
  'app/manage-ui/openclawdesign.md', 'SOURCE-EXPORT.json',
]);

// Check tracked files too: .gitignore alone does not exclude already tracked notes.
export function isPublicSourcePath(relative) {
  return !privateDirectories.has(relative.split('/')[0])
    && !privateFiles.has(relative)
    && !relative.split('/').includes('.DS_Store');
}

// Export the working source without private notes, user data or Git history.
export function exportPublicSource(destinationPath = path.join(root, 'output/public-source')) {
  const destination = path.resolve(destinationPath);
  if (destination === root || root.startsWith(`${destination}${path.sep}`)) throw new Error('Unsafe export destination');
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error('Export destination must be empty');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const entries = [];
  for (const relative of files) {
    if (path.isAbsolute(relative) || relative.split('/').some(part => part === '..' || part === '.git')) throw new Error('Unsafe source path');
    if (!isPublicSourcePath(relative)) continue;
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) continue; // unstaged file removal
    if (source === destination || source.startsWith(`${destination}${path.sep}`)) throw new Error('Destination is part of the source inventory');
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Review non-regular source before exporting: ${relative}`);
    const bytes = fs.readFileSync(source);
    entries.push({ path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mode: stat.mode & 0o777 });
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const target = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, entry.path), target);
    fs.chmodSync(target, entry.mode);
    if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== entry.sha256) throw new Error(`Source changed during export: ${entry.path}; create a new export`);
  }
  const manifestPath = `${destination}.manifest.json`;
  fs.writeFileSync(manifestPath, `${JSON.stringify({ format: 1, baseCommit: git(['rev-parse', 'HEAD']).trim(), historyIncluded: false, files: entries }, null, 2)}\n`);
  console.log(`Exported ${entries.length} source files to ${destination}; private notes and Git history excluded. Manifest: ${manifestPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  exportPublicSource(process.argv[2]);
}
