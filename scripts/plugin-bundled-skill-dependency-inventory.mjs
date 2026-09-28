#!/usr/bin/env node
// Static inventory only. Bundled Skill text is untrusted data and is never executed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCatalog = path.join(repoRoot, 'resources/bundled-plugins/catalog.json');
const defaultFrozen = path.join(repoRoot, 'docs/architecture/bundled-plugin-inventory-2026-09-26.json');
const defaultPackages = path.join(repoRoot, 'resources/bundled-plugins/packages');
const jsonReport = path.join(repoRoot, 'docs/architecture/bundled-skill-dependency-inventory-2026-09-27.json');
const markdownReport = path.join(repoRoot, 'docs/architecture/bundled-skill-dependency-inventory-2026-09-27.md');
const textExtensions = new Set(['.md', '.mdx', '.txt', '.yaml', '.yml']);
const scriptExtensions = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.zsh', '.rb', '.go', '.rs', '.swift', '.sql', '.ipynb']);
const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.mp3', '.mp4', '.wav', '.woff', '.woff2', '.ttf']);
const cliNames = ['bash', 'bun', 'curl', 'docker', 'ffmpeg', 'gh', 'git', 'gcloud', 'go', 'just', 'kubectl', 'node', 'npm', 'npx', 'pip', 'pip3', 'pnpm', 'python', 'python3', 'ruby', 'swift', 'uv', 'xcodebuild', 'yarn'];
const hostPatterns = [
  ['CODEX_HOME', /\$CODEX_HOME\b/],
  ['codex_config_path', /(?:^|[^\w])(?:~\/)?\.codex\//m],
  ['codex_deep_link', /\bcodex:\/\//],
  ['codex_cli', /\bcodex\s+(?:exec|mcp|app)\b/i],
  ['codex_desktop', /\b(?:Codex app|ChatGPT Desktop|ChatGPT Work Mode)\b/],
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function posixRelative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function walkFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Bundled Skill contains symlink: ${full}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
      else throw new Error(`Bundled Skill contains unsupported entry: ${full}`);
    }
  }
  visit(root);
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

// Identical source fingerprint contract to import-bundled-plugins.cjs. Check
// the entire frozen package, not only the SKILL.md files used by this report.
export function scanFrozenPackage(root) {
  const files = [];
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === '.DS_Store') continue;
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error(`Unsafe bundle file name: ${prefix}/${name}`);
      const relative = prefix ? `${prefix}/${name}` : name;
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error(`Unsafe bundle entry: ${relative}`);
      if (stat.isDirectory()) visit(target, relative);
      else {
        const bytes = fs.readFileSync(target);
        files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes), executable: (stat.mode & 0o111) !== 0 });
      }
    }
  }
  visit(root);
  return { sourceDigest: sha256(JSON.stringify(files)), fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

// A link inside a fenced example is rendered as source text, not a link to a
// file in the shipped Skill. Match the Markdown fence length so a nested
// triple-backtick example cannot close an outer four-backtick fence.
function outsideFencedCode(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character
        && marker[1].length >= fence.length && marker[2].trim() === '') fence = null;
      return '';
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      return '';
    }
    return line;
  }).join('\n');
}

function markdownTargets(text) {
  const targets = [];
  for (const match of outsideFencedCode(text).matchAll(/\]\(([^)]+)\)/g)) {
    let raw = match[1].trim();
    if (raw.startsWith('<')) raw = raw.slice(1, raw.indexOf('>') < 0 ? undefined : raw.indexOf('>'));
    else raw = raw.split(/\s+["']/)[0];
    if (!raw || /^(?:#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
    try { raw = decodeURIComponent(raw); } catch { /* Keep malformed escapes as literal source data. */ }
    raw = raw.split(/[?#]/)[0];
    // Code examples can contain array indexing immediately followed by a call,
    // which also spells `](...)`. Only file-like Markdown destinations count.
    if (!raw || /[\s<>]/.test(raw)) continue;
    if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')
      || raw.includes('/') || /\.[a-z0-9]{1,8}$/i.test(raw)) targets.push(raw);
  }
  return targets;
}

function lexicalSignals(text) {
  const explicitTools = [...new Set([
    ...text.matchAll(/\bmcp__[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?/g),
    ...text.matchAll(/\bfunctions\.[A-Za-z_][A-Za-z0-9_]*/g),
  ].map(match => match[0]))].sort();
  const appLinks = [...new Set([...text.matchAll(/\bapp:\/\/[A-Za-z0-9@._-]+/g)].map(match => match[0]))].sort();
  const namedToolCandidates = [...new Set([
    ...text.matchAll(/\b(?:call|invoke|use|run)\s+(?:the\s+)?`([A-Za-z][A-Za-z0-9_]{2,})`/gi),
    ...text.matchAll(/`([A-Za-z][A-Za-z0-9_]{2,})`\s+(?:MCP\s+)?tool/gi),
  ].map(match => match[1]))].sort();
  const hostMarkers = hostPatterns.filter(([, expression]) => expression.test(text)).map(([name]) => name);
  const mentionedCli = cliNames.filter(name => new RegExp(`(?:^|[\\s\x60$])${name}(?=\\s|$|[\\x60(])`, 'mi').test(text));
  return { explicitTools, namedToolCandidates, appLinks, hostMarkers, mentionedCli };
}

function allowedTools(frontmatterText) {
  const lines = frontmatterText.split('\n');
  const index = lines.findIndex(line => /^allowed-tools:/.test(line));
  if (index < 0) return null;
  const first = lines[index].slice('allowed-tools:'.length).trim();
  if (first) return first.slice(0, 1024);
  const following = [];
  for (const line of lines.slice(index + 1)) {
    if (!/^\s+\S/.test(line)) break;
    following.push(line.trim().replace(/^-\s*/, ''));
  }
  return following.join(' ').slice(0, 1024) || '(empty declaration)';
}

function collectSkill(packageEntry, skillName, packagesRoot, sourceRoot) {
  const packageDir = path.join(packagesRoot, packageEntry.id);
  const skillDir = path.join(packageDir, 'skills', skillName);
  const mainFile = path.join(skillDir, 'SKILL.md');
  if (!fs.statSync(mainFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing top-level Skill: ${mainFile}`);
  const files = walkFiles(skillDir);
  const mainBytes = fs.readFileSync(mainFile);
  const mainText = mainBytes.toString('utf8');
  const supportFiles = files.filter(file => file !== mainFile).map(file => posixRelative(skillDir, file));
  const scriptFiles = supportFiles.filter(file => file.startsWith('scripts/') || scriptExtensions.has(path.extname(file).toLowerCase()));
  const referenceFiles = supportFiles.filter(file => file.startsWith('references/'));
  const assetFiles = supportFiles.filter(file => file.startsWith('assets/') || assetExtensions.has(path.extname(file).toLowerCase()));
  const linked = new Map();
  const skippedTextFiles = [];
  for (const file of files) {
    if (file !== mainFile && !textExtensions.has(path.extname(file).toLowerCase())) continue;
    const size = fs.statSync(file).size;
    if (size > 1024 * 1024) { skippedTextFiles.push(posixRelative(packageDir, file)); continue; }
    const text = file === mainFile ? mainText : fs.readFileSync(file, 'utf8');
    const targets = markdownTargets(text);
    // Some frozen web-documentation excerpts omit the leading slash on a site
    // route while also linking to that same /docs/... route family elsewhere
    // in the document. Keep the inference visible; do not call it a missing
    // local package file or claim the remote URL is currently reachable.
    const siteDocFamilies = new Set(targets.filter(target => target.startsWith('/docs/'))
      .map(target => target.slice(1).split('/').slice(0, 3).join('/')));
    for (const raw of targets) {
      const target = path.resolve(path.dirname(file), raw);
      const skillRootTarget = path.resolve(skillDir, raw);
      const source = posixRelative(packageDir, file);
      const key = `${source}\0${raw}`;
      const status = raw.startsWith('/') ? 'site_root_relative'
        : !within(packageDir, target) ? 'outside_package'
          : fs.existsSync(target) ? 'present'
            : within(packageDir, skillRootTarget) && fs.existsSync(skillRootTarget) ? 'present_from_skill_root'
              : raw.startsWith('docs/')
                && siteDocFamilies.has(raw.split('/').slice(0, 3).join('/'))
                ? 'site_root_relative_inferred' : 'missing';
      linked.set(key, { source, target: raw, status });
    }
  }
  const localLinks = [...linked.values()].sort((a, b) => `${a.source}/${a.target}`.localeCompare(`${b.source}/${b.target}`, 'en'));
  const frontmatterEnd = mainText.startsWith('---\n') ? mainText.indexOf('\n---\n', 4) : -1;
  const frontmatter = frontmatterEnd >= 0 ? mainText.slice(4, frontmatterEnd) : '';
  const signals = lexicalSignals(mainText);
  const packageApps = [...new Set(packageEntry.details?.apps ?? [])].sort();
  const reviewFlags = [
    scriptFiles.length && 'bundled_script_or_code',
    allowedTools(frontmatter) !== null && 'allowed_tools_declaration',
    signals.explicitTools.length && 'explicit_host_tool_reference',
    signals.namedToolCandidates.length && 'named_tool_candidate',
    signals.hostMarkers.length && 'codex_host_marker',
    signals.appLinks.length && 'app_scheme_link',
    packageApps.length && 'package_app_declaration',
    localLinks.some(link => link.status === 'missing') && 'missing_local_markdown_target',
    localLinks.some(link => link.status === 'outside_package') && 'outside_package_markdown_target',
    localLinks.some(link => link.status === 'site_root_relative') && 'site_root_relative_markdown_target',
    localLinks.some(link => link.status === 'site_root_relative_inferred') && 'inferred_site_root_markdown_target',
    skippedTextFiles.length && 'text_file_over_scan_limit',
  ].filter(Boolean);
  return {
    id: `${packageEntry.id}/${skillName}`,
    packageId: packageEntry.id,
    packageSourceDigest: packageEntry.sourceDigest ?? null,
    skillName,
    sourcePath: posixRelative(sourceRoot, mainFile),
    sha256: sha256(mainBytes),
    bytes: mainBytes.length,
    supportFiles,
    scriptFiles,
    referenceFiles,
    assetFiles,
    localLinks,
    skippedTextFiles,
    packageApps,
    packageMcpDeclarations: packageEntry.components?.mcp ?? 0,
    allowedTools: allowedTools(frontmatter),
    ...signals,
    reviewFlags,
    businessAvailability: 'not_assessed',
  };
}

export function buildInventory({ catalogPath = defaultCatalog, frozenPath = defaultFrozen, packagesRoot = defaultPackages, sourceRoot = repoRoot, expectedSkills = 502, expectedPackages = 62 } = {}) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8'));
  if (catalog.packages.length !== expectedPackages) throw new Error(`Package count ${catalog.packages.length} != ${expectedPackages}`);
  if (catalog.batchDigest !== frozen.batchDigest || frozen.summary?.packages !== expectedPackages || frozen.summary?.skills !== expectedSkills) throw new Error('Catalog batch differs from independent frozen inventory');
  const frozenPackages = new Map(frozen.packages.map(item => [item.directory, item]));
  if (frozenPackages.size !== expectedPackages) throw new Error('Duplicate or missing frozen package');
  const catalogNames = catalog.packages.map(item => item.id).sort();
  const actualNames = fs.readdirSync(packagesRoot).filter(name => name !== '.DS_Store').sort();
  if (catalogNames.join('\0') !== actualNames.join('\0')) throw new Error('Frozen package directory list differs from catalog');
  const skills = [];
  const packageIds = new Set();
  const packageDigests = [];
  let sourceFileCount = 0;
  for (const packageEntry of [...catalog.packages].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    if (packageIds.has(packageEntry.id)) throw new Error(`Duplicate package ${packageEntry.id}`);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(packageEntry.id)) throw new Error(`Unsafe package id: ${packageEntry.id}`);
    packageIds.add(packageEntry.id);
    const frozenEntry = frozenPackages.get(packageEntry.id);
    if (!frozenEntry || packageEntry.sourceDigest !== frozenEntry.sourceDigest
      || packageEntry.fileCount !== frozenEntry.files || packageEntry.bytes !== frozenEntry.bytes) throw new Error(`Catalog package differs from independent frozen inventory: ${packageEntry.id}`);
    const fingerprint = scanFrozenPackage(path.join(packagesRoot, packageEntry.id));
    if (fingerprint.sourceDigest !== frozenEntry.sourceDigest || fingerprint.fileCount !== frozenEntry.files || fingerprint.bytes !== frozenEntry.bytes) throw new Error(`Frozen source changed: ${packageEntry.id}`);
    packageDigests.push({ directory: packageEntry.id, digest: fingerprint.sourceDigest });
    sourceFileCount += fingerprint.fileCount;
    const declared = (packageEntry.details?.skills ?? []).map(item => item.name);
    if (declared.sort().join('\0') !== (frozenEntry.skills ?? []).map(item => item.directory).sort().join('\0')) throw new Error(`Catalog Skill directory list differs from independent frozen inventory: ${packageEntry.id}`);
    if (declared.some(name => !/^[a-z0-9][a-z0-9._-]*$/.test(name))) throw new Error(`Unsafe Skill name: ${packageEntry.id}`);
    const declaredSet = new Set(declared);
    if (declaredSet.size !== declared.length || declared.length !== packageEntry.components?.skills) throw new Error(`Skill declaration mismatch: ${packageEntry.id}`);
    const skillsDir = path.join(packagesRoot, packageEntry.id, 'skills');
    const actual = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(item => item.isDirectory() && fs.existsSync(path.join(skillsDir, item.name, 'SKILL.md')))
      .map(item => item.name).sort() : [];
    if (actual.join('\0') !== [...declared].sort().join('\0')) throw new Error(`Top-level Skill mismatch: ${packageEntry.id}; declared=${declared.length}, actual=${actual.length}`);
    for (const skillName of [...declared].sort()) skills.push(collectSkill(packageEntry, skillName, packagesRoot, sourceRoot));
  }
  const batchDigest = sha256(JSON.stringify(packageDigests.sort((a, b) => a.directory.localeCompare(b.directory))));
  if (batchDigest !== frozen.batchDigest) throw new Error('Frozen batch digest differs from independent inventory');
  if (sourceFileCount !== frozen.summary.filesWithoutDsStore) throw new Error('Frozen file count differs from independent inventory');
  if (skills.length !== expectedSkills) throw new Error(`Skill count ${skills.length} != ${expectedSkills}`);
  const flagCounts = Object.fromEntries([...new Set(skills.flatMap(skill => skill.reviewFlags))].sort().map(flag => [flag, skills.filter(skill => skill.reviewFlags.includes(flag)).length]));
  const totals = {
    packages: catalog.packages.length,
    sourceFiles: sourceFileCount,
    skills: skills.length,
    supportFiles: skills.reduce((sum, skill) => sum + skill.supportFiles.length, 0),
    withScripts: skills.filter(skill => skill.scriptFiles.length).length,
    withReferences: skills.filter(skill => skill.referenceFiles.length).length,
    withAssets: skills.filter(skill => skill.assetFiles.length).length,
    withNamedToolCandidates: skills.filter(skill => skill.namedToolCandidates.length).length,
    withMissingLocalMarkdownTargets: skills.filter(skill => skill.localLinks.some(link => link.status === 'missing')).length,
    withOutsidePackageMarkdownTargets: skills.filter(skill => skill.localLinks.some(link => link.status === 'outside_package')).length,
    withSiteRootRelativeMarkdownTargets: skills.filter(skill => skill.localLinks.some(link => link.status === 'site_root_relative')).length,
    withInferredSiteRootMarkdownTargets: skills.filter(skill => skill.localLinks.some(link => link.status === 'site_root_relative_inferred')).length,
    withSkippedLargeText: skills.filter(skill => skill.skippedTextFiles.length).length,
    flagCounts,
  };
  return {
    schemaVersion: 1,
    scope: 'static_source_inventory_only',
    source: { catalog: posixRelative(sourceRoot, catalogPath), frozenInventory: posixRelative(sourceRoot, frozenPath), batchDigest: catalog.batchDigest },
    totals,
    skills,
  };
}

function cell(value) { return String(value).replaceAll('|', '\\|').replaceAll('\n', ' '); }

export function renderMarkdown(inventory) {
  const { totals } = inventory;
  const lines = [
    '# 内置 Skill 静态依赖清单（2026-09-27）',
    '',
    `来源：\`${inventory.source.catalog}\` 与独立冻结清单 \`${inventory.source.frozenInventory}\`，批次摘要 \`${inventory.source.batchDigest}\`。本报告由 \`node scripts/plugin-bundled-skill-dependency-inventory.mjs --write\` 生成；[逐项 JSON](bundled-skill-dependency-inventory-2026-09-27.json) 可供脚本查询。`,
    '',
    `覆盖 **${totals.packages} 包 / ${totals.skills} 个 manifest 顶层 Skill**，逐项与目录核对；已重算并核对整批 ${totals.sourceFiles} 个来源文件的路径、字节、SHA-256 与可执行位及批次摘要。包含 ${totals.supportFiles} 个所属目录附属文件。${totals.withScripts} 个 Skill 随带脚本或代码文件，${totals.withReferences} 个随带 references，${totals.withAssets} 个随带 assets，${totals.withNamedToolCandidates} 个含具名工具词法线索；${totals.withMissingLocalMarkdownTargets} 个含静态缺失的相对 Markdown 链接，${totals.withOutsidePackageMarkdownTargets} 个含越出本包的相对 Markdown 链接，${totals.withSiteRootRelativeMarkdownTargets} 个含站点根路径链接，${totals.withInferredSiteRootMarkdownTargets} 个含同文档路由族推断的网页链接。`,
    '',
    '**判定边界：**只读取冻结文件及 catalog，不执行 Skill、脚本、登录或工具调用。脚本、references、assets 分类可以交叠，汇总数均以 Skill 为单位。`app` 是包级 manifest 声明，不证明某个 Skill 实际调用；CLI、具名工具和宿主工具只是 SKILL.md 的词法命中，允许出现示例、否定语句、同名变量及条件分支。链接检查只解析围栏代码块外、文件形态的 Markdown 目标；围栏示例里的链接不是本包文件依赖。先按当前文档、再按 Skill 根目录解析；站点根路径单列，不当作本包文件。同文档存在 `/docs/...` 路由族时，缺少前导斜杠的 `docs/...` 仅标记为网页路径推断，不证明远端存在或可访问。检查不验证运行时生成路径、网络内容或语义。所有 `businessAvailability` 均为 `not_assessed`；无一项可据此标记三宿主业务可用。缺失/越界链接是待人工核对的静态信号，可能是上游示例路径。每项 JSON 保留完整文件名和信号，原文不复制进报告。',
    '',
    '审查优先级：先处理缺失/越界的本地引用和大文本扫描遗漏，再核对显式宿主工具、app/账号、脚本运行环境；按具体包建立原生、OpenClaw、Hermes 的等价调用与代表任务证据。',
    '',
    '| 序号 | Skill | 附属文件 | 脚本/代码 | references | assets | 包级 app | 具名工具线索 | 显式宿主工具 | Codex 宿主标记 | CLI 词法 | 静态诊断 |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const [index, skill] of inventory.skills.entries()) {
    const issues = skill.reviewFlags.filter(flag => flag.includes('missing_') || flag.includes('outside_')
      || flag.includes('over_scan_') || flag.includes('inferred_site_root_'));
    lines.push(`| ${index + 1} | [${cell(skill.id)}](../../${skill.sourcePath}) | ${skill.supportFiles.length} | ${skill.scriptFiles.length} | ${skill.referenceFiles.length} | ${skill.assetFiles.length} | ${skill.packageApps.length} | ${skill.namedToolCandidates.length} | ${skill.explicitTools.length} | ${skill.hostMarkers.length} | ${skill.mentionedCli.length} | ${cell(issues.join(', ') || '—')} |`);
  }
  lines.push('', '机器查询示例：`jq -r \'.skills[] | select(.reviewFlags | index("explicit_host_tool_reference")) | .id\' docs/architecture/bundled-skill-dependency-inventory-2026-09-27.json`。', '');
  return lines.join('\n');
}

function main() {
  const action = process.argv[2] ?? '--json';
  if (!['--json', '--write', '--check'].includes(action) || process.argv.length > 3) throw new Error('Usage: node scripts/plugin-bundled-skill-dependency-inventory.mjs [--json|--write|--check]');
  const inventory = buildInventory();
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  const markdown = renderMarkdown(inventory);
  if (action === '--json') process.stdout.write(json);
  if (action === '--write') {
    fs.writeFileSync(jsonReport, json);
    fs.writeFileSync(markdownReport, markdown);
    process.stdout.write(`Wrote ${inventory.totals.skills} Skill records\n`);
  }
  if (action === '--check') {
    if (fs.readFileSync(jsonReport, 'utf8') !== json || fs.readFileSync(markdownReport, 'utf8') !== markdown) throw new Error('Generated Skill dependency inventory is stale');
    process.stdout.write(`Verified ${inventory.totals.skills} Skill records\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
