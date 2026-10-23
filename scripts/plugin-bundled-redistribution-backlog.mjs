#!/usr/bin/env node
// Review queue only. This script must never turn source/manifest evidence into
// a redistribution approval or write the public-release review record.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const architecture = path.join(root, 'docs/architecture');
const output = path.join(architecture, 'bundled-redistribution-review-backlog-2026-09-27.md');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const catalog = read('resources/bundled-plugins/catalog.json');
const evidence = read('docs/architecture/bundled-license-evidence-2026-09-27.json');
const provenanceFiles = [
  'bundled-upstream-license-provenance-2026-09-27.json',
  'bundled-vendor-upstream-provenance-2026-09-27.json',
  'bundled-remaining-vendor-provenance-2026-09-27.json',
];
const provenance = provenanceFiles.map(name => ({ name, data: read(`docs/architecture/${name}`) }));
const packageReview = path.join(architecture, 'bundled-plugin-redistribution-review.json');
const assetCandidate = /(?:^|\/)(?:assets?|images?|fonts?|templates?|examples?|samples?)(?:\/|$)|\.(?:png|jpe?g|gif|webp|svg|ico|icns|woff2?|ttf|otf|mp[34]|mov|wav|pdf|gz|zip|tar|bin)$/iu;
const matchedStatuses = new Set([
  'same_path_same_bytes', 'same_plugin_relative_path', 'same_bytes_other_path',
  'history_same_path_same_bytes', 'history_same_bytes_other_path',
]);
const unmatchedStatuses = new Set(['no_pinned_commit_match', 'no_match_in_pinned_history']);

function assert(condition, message) {
  if (!condition) throw new Error(`Redistribution backlog evidence invalid: ${message}`);
}

function indexUnique(items, key, context) {
  assert(Array.isArray(items), `${context} is not an array`);
  const result = new Map();
  for (const item of items) {
    const id = item?.[key];
    assert(typeof id === 'string' && id && !result.has(id), `${context} has duplicate or invalid ${key}`);
    result.set(id, item);
  }
  return result;
}

function matched(file) {
  assert(matchedStatuses.has(file.status) || unmatchedStatuses.has(file.status),
    `unknown provenance status ${file.status}`);
  if (matchedStatuses.has(file.status)) {
    if ('upstreamSha256Verified' in file) assert(file.upstreamSha256Verified === true, 'upstream bytes not verified');
    if ('vendorSha256Verified' in file) assert(file.vendorSha256Verified === true, 'vendor bytes not verified');
    return true;
  }
  if (file.sameBytesInPinnedCommitAncestry) {
    assert(file.historicalVendorSha256Verified === true, 'historical vendor bytes not verified');
    return true;
  }
  return false;
}

function requiredWork(entry, audit, assetCount) {
  const actions = [];
  if (!entry.license) actions.push('逐文件确定权利来源');
  else if (entry.license === 'UNLICENSED' || entry.license === 'Proprietary'
    || entry.license.startsWith('LicenseRef-')) actions.push('明确权利人许可及适用范围');
  else if (entry.license.includes('GPL-') || entry.license.includes('CC-BY-')) {
    actions.push('核对专项许可与发行义务');
  }
  if (!audit) actions.push('建立固定来源与逐字节比对');
  else if (audit.unmatched) actions.push(`补 ${audit.unmatched} 文件的来源/授权`);
  if (assetCount) actions.push(`核对 ${assetCount} 个素材/嵌套候选`);
  return actions.join('；') || '核对适用许可与逐文件义务';
}

function build() {
  assert(catalog.batchDigest === evidence.batchDigest, 'catalog/evidence batch digest mismatch');
  const catalogById = indexUnique(catalog.packages, 'id', 'catalog packages');
  const evidenceById = indexUnique(evidence.packages, 'id', 'license evidence packages');
  assert(catalogById.size === evidenceById.size, 'catalog/evidence package count mismatch');
  const provenanceById = new Map();
  for (const source of provenance) {
    assert(source.data.frozenBatchDigest === catalog.batchDigest, `${source.name} batch digest mismatch`);
    for (const item of source.data.packages) {
      assert(!provenanceById.has(item.id), `duplicate official candidate: ${item.id}`);
      provenanceById.set(item.id, { ...item, document: source.name.replace(/\.json$/u, '.md') });
    }
  }
  const rows = [];
  for (const [id, entry] of catalogById) {
    const item = evidenceById.get(id);
    assert(item && item.sourceDigest === entry.sourceDigest, `${id}: source digest mismatch`);
    assert(item.files.length === entry.fileCount, `${id}: file count mismatch`);
    const filesByPath = indexUnique(item.files, 'path', `${id} license files`);
    const assetCount = item.files.filter(file => assetCandidate.test(file.path)).length;
    const upstream = provenanceById.get(id);
    let audit = null;
    if (upstream) {
      assert(upstream.frozenSourceDigest === entry.sourceDigest, `${id}: provenance source digest mismatch`);
      const upstreamFiles = indexUnique(upstream.files, 'path', `${id} provenance files`);
      assert(upstreamFiles.size === filesByPath.size, `${id}: provenance file set mismatch`);
      let matchedCount = 0;
      for (const [filePath, file] of filesByPath) {
        const candidate = upstreamFiles.get(filePath);
        assert(candidate && candidate.frozenSha256 === file.sha256,
          `${id}/${filePath}: provenance SHA-256 mismatch`);
        if (matched(candidate)) matchedCount += 1;
      }
      audit = {
        matched: matchedCount, unmatched: item.files.length - matchedCount,
        repository: upstream.officialRepository || upstream.vendorRepository || upstream.candidateOfficialRepository,
        commit: upstream.pinnedCommit,
        document: upstream.document,
      };
      assert(audit.repository && audit.commit, `${id}: missing official candidate identity`);
    }
    rows.push({ id, entry, item, audit, assetCount, work: requiredWork(entry, audit, assetCount) });
  }
  assert(rows.reduce((sum, row) => sum + row.item.files.length, 0) === evidence.summary.files,
    'evidence total file count mismatch');
  assert(rows.filter(row => row.audit).length === provenanceById.size,
    'provenance includes a package outside the frozen catalog');
  assert(rows.reduce((sum, row) => sum + row.item.summary.filesWithoutAnyLocalDeclaration, 0)
    === evidence.summary.filesWithoutAnyLocalDeclaration, 'local declaration count mismatch');
  assert(!fs.existsSync(packageReview),
    'an approval record now exists; this pending-only backlog must be reconciled before regeneration');
  return rows;
}

function markdown(rows) {
  const totalFiles = rows.reduce((sum, row) => sum + row.item.files.length, 0);
  const comparedFiles = rows.reduce((sum, row) => sum + (row.audit ? row.item.files.length : 0), 0);
  const matches = rows.reduce((sum, row) => sum + (row.audit?.matched || 0), 0);
  const noManifest = rows.filter(row => !row.entry.license);
  const assetCandidates = rows.reduce((sum, row) => sum + row.assetCount, 0);
  const lines = [
    '# 内置插件再分发逐包待审表（2026-09-27）', '',
    `冻结批次：\`${catalog.batchDigest}\`。本表列出 ${rows.length} 包、${totalFiles} 文件；**逐文件再分发批准：0/${totalFiles}，逐包批准：0/${rows.length}**。审核文件 \`bundled-plugin-redistribution-review.json\` 尚不存在；本脚本只写待审表，绝不生成批准记录。`, '',
    `已有 ${provenanceByIdCount(rows)} 包/${comparedFiles} 文件与固定官方候选仓库做逐字节比对：${matches} 文件在所查提交或限定历史中有相同字节，${comparedFiles - matches} 未命中；其余 ${totalFiles - comparedFiles} 文件尚无这类候选比对。**同字节只说明所查仓库内出现相同内容，不证明许可证适用或 App 可再分发。**`, '',
    `manifest 未声明许可的 ${noManifest.length} 包共有 ${noManifest.reduce((sum, row) => sum + row.item.files.length, 0)} 文件，其中 ${noManifest.reduce((sum, row) => sum + row.item.summary.filesWithoutAnyLocalDeclaration, 0)} 文件连本地许可声明线索也没有。所有 ${totalFiles} 文件仍须逐项审查；${assetCandidates} 个路径/后缀命中“素材或嵌套文件”筛选器，属人工复查队列，**不是**已证实第三方素材数量。`, '',
    '核对输入：[冻结逐文件 SHA-256 清单](bundled-license-evidence-2026-09-27.json)及三个官方候选来源报告：[Shopify/Stripe/Higgsfield](bundled-upstream-license-provenance-2026-09-27.md)、[Airtable/Canva/Monday](bundled-vendor-upstream-provenance-2026-09-27.md)、[Adobe/Consensus/Datadog/Dropbox/Lovable](bundled-remaining-vendor-provenance-2026-09-27.md)。三份来源报告各自说明固定提交、扫描历史范围及未覆盖的其他来源。manifest 字符串、Skill frontmatter、SPDX、就近 LICENSE/NOTICE 均只是线索。', '',
    '| 包 | 文件 | manifest 自述 | 包内许可/通知 | 官方候选相同字节 | 素材/嵌套候选 | 下步核查重点 |',
    '| --- | ---: | --- | ---: | --- | ---: | --- |',
  ];
  for (const row of rows) {
    const license = (row.entry.license || '未声明').replaceAll('|', '\\|');
    const candidate = row.audit
      ? `[${row.audit.matched}/${row.item.files.length}](${row.audit.document})`
      : '未比对';
    lines.push(`| ${row.id} | ${row.item.files.length} | ${license} | ${row.item.notices.length} | ${candidate} | ${row.assetCount} | ${row.work} |`);
  }
  lines.push('', '逐包审核需把每个文件的 SHA-256、实际作品来源与权利主体、许可适用范围、改动、嵌套素材/商标、需携带的版权与许可文本和 NOTICE、拟发行渠道、义务履行证据逐项记录，再由审核人给出明确日期与批准/拒绝决定。**不要**把此待审表复制为批准 JSON；[公开发布门槛](../../scripts/check-bundled-plugin-public-release.cjs)要求与冻结摘要绑定的逐文件批准、义务记录和经核实 SBOM，当前仍应拒绝包含这 62 包的正式公开发行。', '',
    '通用条款核对入口仅用于审查适用文件，不能反推整包授权：[MIT 原文](https://opensource.org/license/mit)要求保留版权和许可声明；[Apache-2.0 第 4、6 节](https://www.apache.org/licenses/LICENSE-2.0)涉及许可证、改动、NOTICE 与商标；[CC BY 4.0 第 3 节](https://creativecommons.org/licenses/by/4.0/legalcode.en)涉及署名。`GPL-3.0-only`、`LicenseRef-Figma-Developer-Terms`、`Proprietary`、`UNLICENSED` 及混合许可包须按实际材料与发行方式专项核对。', '',
    '复跑：`node scripts/plugin-bundled-license-evidence.mjs --check && node scripts/plugin-bundled-redistribution-backlog.mjs --check`。如来源快照或候选报告更新，先审查差异，再运行 `--write` 重生成此表；脚本会拒绝摘要、文件集或逐文件 SHA-256 不一致。', '');
  return lines.join('\n');
}

function provenanceByIdCount(rows) {
  return rows.filter(row => row.audit).length;
}

const mode = process.argv[2];
assert(['--check', '--write'].includes(mode) && process.argv.length === 3,
  'usage: node scripts/plugin-bundled-redistribution-backlog.mjs --check|--write');
const result = markdown(build());
if (mode === '--write') fs.writeFileSync(output, result);
else assert(fs.existsSync(output) && fs.readFileSync(output, 'utf8') === result,
  `stale review backlog: ${output}`);
console.log(`PASS bundled redistribution backlog: ${catalog.packages.length} packages, ${evidence.summary.files} pending files`);
