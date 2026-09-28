#!/usr/bin/env node
// Static evidence only: a nearby notice or manifest declaration is not a
// legal determination that an individual bundled file may be redistributed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'resources/bundled-plugins/packages');
const catalogPath = path.join(root, 'resources/bundled-plugins/catalog.json');
const inventoryPath = path.join(root, 'docs/architecture/bundled-plugin-inventory-2026-09-26.json');
const jsonPath = path.join(root, 'docs/architecture/bundled-license-evidence-2026-09-27.json');
const markdownPath = path.join(root, 'docs/architecture/bundled-license-evidence-2026-09-27.md');
const noticeName = /^(?:licen[sc]e|copying|notice|copyright|unlicense|third[_-]?party(?:[_-]?notices?)?)(?:[._-]|$)/iu;
const textExtensions = new Set(['.c', '.cc', '.cjs', '.css', '.h', '.html', '.java', '.js', '.json', '.jsx', '.md', '.mdx', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.svg', '.swift', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml']);
const unresolvedKindNames = {
  pluginMetadata: '插件描述文件（manifest/App/MCP）',
  markdown: 'Skill 与参考 Markdown',
  agentYaml: 'Agent YAML 配置',
  scripts: '脚本',
  binaryAndCompressedAssets: '图标、图片与压缩数据',
  structuredDataAndTemplates: '其他结构化数据与模板',
};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => `${JSON.stringify(value, null, 2)}\n`;
const slash = value => value.split(path.sep).join('/');

function walk(directory, prefix = '') {
  const records = [];
  for (const name of fs.readdirSync(directory).sort()) {
    if (name === '.DS_Store') continue;
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new Error(`Unsafe bundle entry: ${prefix}/${name}`);
    }
    const relative = prefix ? `${prefix}/${name}` : name;
    const target = path.join(directory, name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error(`Unsafe bundle entry: ${relative}`);
    }
    if (stat.isDirectory()) records.push(...walk(target, relative));
    else {
      const bytes = fs.readFileSync(target);
      records.push({ path: slash(relative), bytes: bytes.length, sha256: sha(bytes),
        executable: (stat.mode & 0o111) !== 0, source: bytes });
    }
  }
  return records;
}

function inlineSpdx(record) {
  if (!textExtensions.has(path.extname(record.path).toLowerCase())
    && !['LICENSE', 'LICENCE', 'COPYING', 'NOTICE'].includes(path.basename(record.path).toUpperCase())) return [];
  const head = record.source.subarray(0, 8192).toString('utf8').split(/\r?\n/u).slice(0, 80).join('\n');
  return [...new Set([...head.matchAll(/SPDX-License-Identifier:\s*([^\r\n*<>]{1,128})/giu)]
    .map(match => match[1].trim()).filter(Boolean))].sort();
}

function candidateNotices(file, noticePaths) {
  let directory = path.posix.dirname(file);
  for (;;) {
    const candidates = noticePaths.filter(notice => path.posix.dirname(notice) === directory);
    if (candidates.length) return candidates;
    if (directory === '.') return [];
    directory = path.posix.dirname(directory);
  }
}

function unresolvedKind(file) {
  if (['.app.json', '.mcp.json', '.codex-plugin/plugin.json'].includes(file)) return 'pluginMetadata';
  const extension = path.posix.extname(file).toLowerCase();
  if (extension === '.md') return 'markdown';
  if (extension === '.yaml' || extension === '.yml') return 'agentYaml';
  if (['.mjs', '.py', '.sh'].includes(extension)) return 'scripts';
  if (['.png', '.svg', '.gz'].includes(extension)) return 'binaryAndCompressedAssets';
  return 'structuredDataAndTemplates';
}

function countUnresolvedKinds(files) {
  const counts = Object.fromEntries(Object.keys(unresolvedKindNames).map(kind => [kind, 0]));
  for (const file of files) counts[unresolvedKind(file.path)] += 1;
  return counts;
}

function build() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  if (catalog.batchDigest !== inventory.batchDigest || catalog.packages.length !== inventory.packages.length) {
    throw new Error('Bundled catalog and frozen inventory disagree');
  }
  const frozenByName = new Map(inventory.packages.map(item => [item.directory, item]));
  const packages = [];
  for (const entry of catalog.packages) {
    const frozen = frozenByName.get(entry.id);
    if (!frozen || frozen.sourceDigest !== entry.sourceDigest) throw new Error(`Frozen package mismatch: ${entry.id}`);
    const source = walk(path.join(packageRoot, entry.id));
    const sourceRecords = source.map(({ path: file, bytes, sha256, executable }) =>
      ({ path: file, bytes, sha256, executable }));
    if (sha(JSON.stringify(sourceRecords)) !== entry.sourceDigest || source.length !== entry.fileCount) {
      throw new Error(`Bundled package bytes changed: ${entry.id}`);
    }
    const notices = source.filter(record => noticeName.test(path.posix.basename(record.path)))
      .map(record => record.path).sort();
    const skillLicenses = new Map(frozen.skills.map(skill => [skill.directory, skill.declaredLicense || null]));
    const files = source.map(record => {
      const skill = /^skills\/([^/]+)\//u.exec(record.path)?.[1] || null;
      const noticeCandidates = candidateNotices(record.path, notices);
      return { path: record.path, bytes: record.bytes, sha256: record.sha256,
        explicitSpdx: inlineSpdx(record),
        skillFrontmatterLicense: skill ? skillLicenses.get(skill) || null : null,
        nearestNoticeCandidates: noticeCandidates,
        isNotice: notices.includes(record.path) };
    });
    const withoutLocalDeclaration = files.filter(file => !file.explicitSpdx.length
      && !file.skillFrontmatterLicense && !file.nearestNoticeCandidates.length
      && !entry.license);
    packages.push({ id: entry.id, sourceDigest: entry.sourceDigest,
      manifestLicense: entry.license || null, notices,
      summary: { files: files.length,
        explicitSpdxFiles: files.filter(file => file.explicitSpdx.length).length,
        skillFrontmatterFiles: files.filter(file => file.skillFrontmatterLicense).length,
        filesWithNearbyNotice: files.filter(file => file.nearestNoticeCandidates.length).length,
        filesWithoutAnyLocalDeclaration: withoutLocalDeclaration.length,
        unresolvedKinds: countUnresolvedKinds(withoutLocalDeclaration) }, files });
  }
  const unresolvedKinds = Object.fromEntries(Object.keys(unresolvedKindNames).map(kind =>
    [kind, packages.reduce((sum, item) => sum + item.summary.unresolvedKinds[kind], 0)]));
  return { schemaVersion: 1, batchDigest: catalog.batchDigest,
    limitation: 'Evidence inventory only. Manifest, Skill frontmatter, SPDX text and nearby notices require file-level license and redistribution review.',
    summary: { packages: packages.length, files: packages.reduce((sum, item) => sum + item.summary.files, 0),
      explicitSpdxFiles: packages.reduce((sum, item) => sum + item.summary.explicitSpdxFiles, 0),
      filesWithoutAnyLocalDeclaration: packages.reduce((sum, item) => sum + item.summary.filesWithoutAnyLocalDeclaration, 0),
      unresolvedKinds },
    packages };
}

function markdown(report) {
  const lines = [
    '# 冻结内置插件逐文件许可线索（2026-09-27）', '',
    `来源批次摘要：\`${report.batchDigest}\`；${report.summary.packages} 包、${report.summary.files} 个非 \`.DS_Store\` 文件。`, '',
    '此表只列出静态线索。包 manifest、Skill frontmatter、文件头 SPDX 和就近许可文件都不能单独证明某文件或嵌套素材可在 Shoggoth 中再分发；尤其不能把上级 LICENSE 自动套用到图标、字体、模板、脚本和第三方样例。逐文件记录及 SHA-256 见同名 JSON，仍需人工核对条款、权利主体和公开分发条件。', '',
    `文件头含 SPDX 标记：${report.summary.explicitSpdxFiles}；没有任何本地声明线索：${report.summary.filesWithoutAnyLocalDeclaration}。这些计数是待核查工作量，不是许可通过数量。`, '',
    '| 包 | 文件 | manifest 声明 | 许可/通知文件 | SPDX 文件 | 无本地声明线索 |',
    '| --- | ---: | --- | ---: | ---: | ---: |',
  ];
  for (const item of report.packages) {
    const manifest = (item.manifestLicense || '未声明').replaceAll('|', '\\|');
    lines.push(`| ${item.id} | ${item.summary.files} | ${manifest} | ${item.notices.length} | ${item.summary.explicitSpdxFiles} | ${item.summary.filesWithoutAnyLocalDeclaration} |`);
  }
  lines.push('', `无本地声明线索的文件类别（合计仍为 ${report.summary.filesWithoutAnyLocalDeclaration}，类别只用于安排核查）：`, '',
    '| 类别 | 文件数 |', '| --- | ---: |');
  for (const [kind, label] of Object.entries(unresolvedKindNames)) {
    lines.push(`| ${label} | ${report.summary.unresolvedKinds[kind]} |`);
  }
  lines.push('',
    '来源根核对（2026-09-27）：冻结下载目录根未见 LICENSE/NOTICE；其 `README.md` SHA-256 为 `b3681ebd15797bdee1d638c6520c7ba10a36e676760ea5c251530f53f843c852`。上述 11 个包与该目录的来源文件摘要逐包一致。[OpenAI 官方 plugins 仓库当前根目录](https://github.com/openai/plugins)也未列出 LICENSE/NOTICE；当前 `main` 未与冻结批次按 commit 绑定，不能据此补出仓库级许可。', '',
    '上游候选核对现分为[Shopify/Stripe/Higgsfield](bundled-upstream-license-provenance-2026-09-27.md)、[Airtable/Canva/Monday](bundled-vendor-upstream-provenance-2026-09-27.md)、[Adobe/Consensus/Datadog/Dropbox/Lovable](bundled-remaining-vendor-provenance-2026-09-27.md)三批，固定 11 个公开仓库提交并逐文件比对 248 个冻结文件，覆盖全部 220 个没有本地声明线索的文件所在包。125 个文件在所查固定提交或其祖先中同字节，123 个未命中；同字节也不能单独证明适用许可、品牌资产权利或最终 App 的再分发条件，因此 220 个文件仍须逐项核查。');
  lines.push('', '验收停止条件：逐文件与嵌套来源许可核对、必要的归属/授权材料、随包 notices 和真实发行渠道审查完成前，不能将此清单当作 P7 公开分发许可通过。', '');
  return lines.join('\n');
}

const mode = process.argv[2];
if (!['--check', '--write'].includes(mode) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/plugin-bundled-license-evidence.mjs --check|--write');
}
const report = build();
const generated = [[jsonPath, canonical(report)], [markdownPath, markdown(report)]];
if (mode === '--write') {
  for (const [file, content] of generated) fs.writeFileSync(file, content);
} else {
  for (const [file, content] of generated) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
      throw new Error(`Stale bundled license evidence: ${file}`);
    }
  }
}
console.log(`PASS bundled license evidence: ${report.summary.packages} packages, ${report.summary.files} files`);
