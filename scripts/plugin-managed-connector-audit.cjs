#!/usr/bin/env node
"use strict";

// Reproducible, read-only gap inventory for the frozen Codex .app.json batch.
// A matching independent MCP is only a candidate for tool-contract testing;
// this audit never treats an opaque managed App ID as an executable endpoint.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const catalogPath = "resources/bundled-plugins/catalog.json";
const inventoryPath = "docs/architecture/bundled-plugin-inventory-2026-09-26.json";
const reportPath = "docs/architecture/bundled-managed-connector-gaps-2026-09-27.md";
const packageIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedEntries(value) {
  invariant(object(value), "Expected a JSON object");
  return Object.entries(value).sort(([left], [right]) => compare(left, right));
}

function packageDigest(root) {
  const files = [];
  function visit(directory, prefix = "") {
    for (const name of fs.readdirSync(directory).sort(compare)) {
      if (name === ".DS_Store") continue;
      invariant(name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\"),
        `Unsafe bundled name: ${prefix}/${name}`);
      const relative = prefix ? `${prefix}/${name}` : name;
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      invariant(!stat.isSymbolicLink() && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)),
        `Unsafe bundled entry: ${relative}`);
      if (stat.isDirectory()) visit(target, relative);
      else {
        const bytes = fs.readFileSync(target);
        files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes),
          executable: (stat.mode & 0o111) !== 0 });
      }
    }
  }
  visit(root);
  return sha256(JSON.stringify(files));
}

function loadAudit(root = repo) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, catalogPath), "utf8"));
  const inventory = JSON.parse(fs.readFileSync(path.join(root, inventoryPath), "utf8"));
  invariant(catalog.batchDigest === inventory.batchDigest, "Catalog batch differs from frozen inventory");
  invariant(Array.isArray(catalog.packages) && catalog.packages.length === inventory.summary.packages,
    "Catalog package count differs from frozen inventory");
  const frozen = new Map(inventory.packages.map(item => [item.directory, item]));
  invariant(frozen.size === inventory.packages.length, "Duplicate frozen package directory");

  const packages = new Map();
  const references = [];
  const emptyAppFiles = [];
  for (const entry of catalog.packages) {
    invariant(packageIdPattern.test(entry.id) && !packages.has(entry.id), `Invalid package id: ${entry.id}`);
    const item = frozen.get(entry.id);
    invariant(item && entry.sourceDigest === item.sourceDigest,
      `Catalog source digest differs from frozen inventory: ${entry.id}`);
    const packageRoot = path.join(root, "resources/bundled-plugins/packages", entry.id);
    invariant(packageDigest(packageRoot) === item.sourceDigest, `Frozen package changed: ${entry.id}`);
    const appFile = path.join(packageRoot, ".app.json");
    const mcpFile = path.join(packageRoot, ".mcp.json");
    const apps = fs.existsSync(appFile) ? JSON.parse(fs.readFileSync(appFile, "utf8")).apps : {};
    const mcp = fs.existsSync(mcpFile) ? JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers : {};
    const appEntries = sortedEntries(apps);
    const mcpEntries = sortedEntries(mcp);
    invariant(appEntries.length === item.components.apps && appEntries.length === entry.components.apps,
      `App declaration count changed: ${entry.id}`);
    invariant(mcpEntries.length === item.components.mcp && mcpEntries.length === entry.components.mcp,
      `MCP declaration count changed: ${entry.id}`);
    invariant(JSON.stringify(appEntries.map(([name]) => name).sort(compare))
      === JSON.stringify([...entry.details.apps].sort(compare)), `Catalog App keys changed: ${entry.id}`);
    invariant(JSON.stringify(appEntries.map(([name, config]) => ({ name, id: config.id })).sort((a, b) => compare(a.name, b.name)))
      === JSON.stringify(item.appReferences.map(({ name, id }) => ({ name, id })).sort((a, b) => compare(a.name, b.name))),
    `Frozen App IDs changed: ${entry.id}`);
    const converted = new Set(entry.details.mcpServers.map(server => server.name));
    const unconverted = new Map(entry.unconvertedMcp.map(server => [server.name, server.reasonCode]));
    for (const [name] of mcpEntries) {
      invariant(converted.has(name) !== unconverted.has(name), `MCP status missing or conflicting: ${entry.id}/${name}`);
    }
    invariant(converted.size + unconverted.size === mcpEntries.length,
      `MCP status count differs: ${entry.id}`);
    const servers = new Map(mcpEntries.map(([name, config]) => [name, {
      packageId: entry.id, name,
      transport: config.type === "http" ? "HTTP" : "stdio",
      status: converted.has(name) ? "converted" : "unconverted",
      reasonCode: unconverted.get(name) || null,
    }]));
    packages.set(entry.id, { servers });
    if (fs.existsSync(appFile) && appEntries.length === 0) emptyAppFiles.push(entry.id);
    for (const [name, config] of appEntries) {
      invariant(object(config) && typeof config.id === "string" && config.id.length > 0,
        `Invalid managed App reference: ${entry.id}/${name}`);
      references.push({ packageId: entry.id, name, id: config.id,
        samePackageConverted: [...servers.values()].filter(server => server.status === "converted"),
        idNamespace: config.id.startsWith("connector_") ? "connector_"
          : config.id.startsWith("asdk_app_") ? "asdk_app_"
            : config.id.startsWith("templated_apps_") ? "templated_apps_" : "other" });
    }
  }
  invariant(packages.size === frozen.size && references.length === inventory.summary.appIds,
    "Bundled App reference count differs from frozen inventory");

  // Only exact App key = MCP server name qualifies directly. Opaque app-<hex>
  // keys can use the package name when that package declares the same MCP name.
  // A repeated opaque ID can inherit that precise candidate across packages.
  const byId = new Map();
  for (const reference of references) {
    const servers = packages.get(reference.packageId).servers;
    const opaqueKey = /^app-[a-f0-9]{32}$/u.test(reference.name);
    const direct = [...servers.values()].filter(server => server.name === reference.name
      || (opaqueKey && server.name === reference.packageId));
    reference.directCandidates = direct;
    if (!byId.has(reference.id)) byId.set(reference.id, []);
    byId.get(reference.id).push(reference);
  }
  for (const group of byId.values()) {
    const candidates = [...new Map(group.flatMap(reference => reference.directCandidates)
      .map(server => [`${server.packageId}/${server.name}`, server])).values()]
      .sort((a, b) => compare(`${a.packageId}/${a.name}`, `${b.packageId}/${b.name}`));
    for (const reference of group) {
      reference.candidates = candidates;
      reference.classification = candidates.length === 0 ? "needs-provider-adapter"
        : candidates.some(candidate => candidate.status === "converted") ? "mcp-candidate-converted"
          : "mcp-candidate-unconverted";
      // A name or repeated managed ID is a discovery lead, not evidence that
      // the opaque App and independent MCP expose the same tool contract.
      reference.exactOverlapStatus = candidates.length ? "candidate-only" : "unsupported";
    }
  }
  references.sort((a, b) => compare(`${a.packageId}/${a.name}`, `${b.packageId}/${b.name}`));
  const ids = [...byId.entries()].map(([id, group]) => ({ id, references: group,
    namespace: group[0].idNamespace, candidates: group[0].candidates,
    classification: group[0].classification })).sort((a, b) => compare(a.id, b.id));
  const countBy = (items, field) => items.reduce((counts, item) => {
    counts[item[field]] = (counts[item[field]] || 0) + 1;
    return counts;
  }, {});
  return { batchDigest: inventory.batchDigest, references, ids, packages,
    emptyAppFiles: emptyAppFiles.sort(compare),
    referenceClasses: countBy(references, "classification"),
    exactOverlapCounts: countBy(references, "exactOverlapStatus"),
    idClasses: countBy(ids, "classification"),
    namespaceCounts: countBy(ids, "namespace"),
  };
}

function candidateCell(reference) {
  if (!reference.candidates.length) return "—";
  return reference.candidates.map(candidate => {
    const source = candidate.packageId === reference.packageId ? "同包" : "同 ID";
    const state = candidate.status === "converted" ? "已转换" : `未转换:${candidate.reasonCode}`;
    return `${candidate.packageId}/${candidate.name} (${source}, ${candidate.transport}, ${state})`;
  }).join("<br>");
}

function samePackageConvertedCell(reference) {
  if (!reference.samePackageConverted.length) return "—";
  return reference.samePackageConverted.map(server => `${server.name} (${server.transport})`).join("<br>");
}

function blockerCell(reference, packages) {
  if (reference.candidates.length) {
    const parser = reference.candidates.every(candidate => candidate.status === "unconverted")
      ? "先完成独立 MCP 的安全转换；" : "";
    return `${parser}核对托管工具与 MCP 的工具名、参数、结果和读写权限；完成认证、账号及真实调用验收。`;
  }
  const other = [...packages.get(reference.packageId).servers.keys()];
  const mismatch = other.length ? `同包 MCP ${other.join("、")} 不能凭包名代替此引用；` : "";
  return `${mismatch}需要公开 API/MCP 或受控适配器、供应商应用注册/账号、工具合同与真实业务验收。`;
}

function renderReport(audit) {
  const classLabel = {
    "mcp-candidate-converted": "独立 MCP 已转换候选",
    "mcp-candidate-unconverted": "独立 MCP 未转换候选",
    "needs-provider-adapter": "无匹配独立 MCP",
  };
  const count = (counts, key) => counts[key] || 0;
  const lines = [
    "# 冻结 Codex 托管连接器引用与协议缺口（2026-09-27）",
    "",
    `来源：\`resources/bundled-plugins/packages/*/.app.json\`、\`resources/bundled-plugins/catalog.json\` 与冻结清单；批次摘要 \`${audit.batchDigest}\`。运行 \`node scripts/plugin-managed-connector-audit.cjs --check\` 可核对来源摘要和本报告，\`--write\` 重建。`,
    "",
    "本表是**阻塞分类**，不是连接器实现或工具等价性证明。`.app.json` 只有宿主托管 ID、名称、分类/可选性及个别 read/write 标签，没有可移植 URL、工具 schema、OAuth 客户端或具体授权范围。`connector_`、`asdk_app_`、`templated_apps_` 是 ID 命名空间，不能推断为 HTTP/MCP 协议。独立 MCP 的“已转换”只表示安装候选配置可表示，尚须账号、授权、真实工具列举/读写调用及与原托管工具逐项等价验收。所有 73 次引用继续视为未适配；同一 ID 在多包重复时仍须验收各包 Skill 场景。",
    "",
    "## 规模与分流",
    "",
    `- ${audit.references.length} 次引用，${audit.ids.length} 个唯一 ID；另有 ${audit.emptyAppFiles.map(id => `\`${id}\``).join("、")} 两个空 \`.app.json\`。`,
    `- 可进一步做工具等价性验收：${count(audit.referenceClasses, "mcp-candidate-converted")} 次引用 / ${count(audit.idClasses, "mcp-candidate-converted")} 个 ID 有已转换独立 MCP 候选；${count(audit.referenceClasses, "mcp-candidate-unconverted")} 次引用 / ${count(audit.idClasses, "mcp-candidate-unconverted")} 个 ID 有尚未转换的独立 MCP 候选。`,
    `- ${count(audit.referenceClasses, "needs-provider-adapter")} 次引用 / ${count(audit.idClasses, "needs-provider-adapter")} 个 ID 无可精确关联的独立 MCP，须查证供应商公开 API/MCP 或开发受控适配器。`,
    `- 托管引用与独立 MCP 的**精确功能交集**：proven ${count(audit.exactOverlapCounts, "proven")}、candidate-only ${count(audit.exactOverlapCounts, "candidate-only")}、unsupported ${count(audit.exactOverlapCounts, "unsupported")}。有 ${audit.references.filter(reference => reference.samePackageConverted.length).length} 次引用所在包另有已转换独立 MCP；同包存在不等于可替代。`,
    `- 唯一 ID 命名空间：\`connector_\` ${count(audit.namespaceCounts, "connector_")}、\`asdk_app_\` ${count(audit.namespaceCounts, "asdk_app_")}、\`templated_apps_\` ${count(audit.namespaceCounts, "templated_apps_")}、其他 ${count(audit.namespaceCounts, "other")}。`,
    "",
    "候选关联只采用两种本地证据：① 同包 `.app.json` 键与独立 `.mcp.json` server 名完全相同（`app-<32 位十六进制>`不透明键可用包目录名）；② 其他包相同**完整托管 ID**已有上述直接候选。不同 ID 或同包但不同工具用途的 MCP 不自动互换。候选本身也不证明端点公开准入、认证可用、工具覆盖或许可。",
    "",
    "精确功能交集的 `proven` 需要原托管连接器与独立 MCP 在同一业务动作上的工具合同和运行结果对照；冻结 `.app.json` 不含前者的工具合同，因此当前为 0。`candidate-only` 表示有上述精确关联线索，仍未完成该对照；`unsupported` 只表示**冻结资源内**没有可关联的独立 MCP，不断言供应商没有公开 API、产品没有其他实现或未来不能适配。GitHub.com 独立 MCP 的四项本地业务动作已有受限功能交集证据，但托管工具的输入、输出和权限仍未取得，所以 `github/github` 仍是 `candidate-only`。",
    "",
    "## 每次引用（73）",
    "",
    "| 包 / App 键 | 托管 ID | 同包已转换独立 MCP | 精确功能交集 | 分流 | 独立 MCP 候选及配置状态 | 下一阻塞 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const reference of audit.references) {
    lines.push(`| \`${reference.packageId}/${reference.name}\` | \`${reference.id}\` | ${samePackageConvertedCell(reference)} | \`${reference.exactOverlapStatus}\` | ${classLabel[reference.classification]} | ${candidateCell(reference)} | ${blockerCell(reference, audit.packages)} |`);
  }
  lines.push("", "## 去重托管 ID（53）", "",
    "| ID | 命名空间 | 出现的包 / App 键 | 独立 MCP 候选 |", "| --- | --- | --- | --- |");
  for (const item of audit.ids) {
    lines.push(`| \`${item.id}\` | \`${item.namespace}\` | ${item.references.map(ref => `\`${ref.packageId}/${ref.name}\``).join("<br>")} | ${candidateCell(item.references[0])} |`);
  }
  const github = audit.references.find(reference => reference.packageId === "github"
    && reference.name === "github");
  invariant(github?.id === "connector_76869538009648d5b282a4bb21c3d157"
    && github.classification === "mcp-candidate-converted", "Frozen GitHub reference changed");
  lines.push("", "## 受限功能交集：GitHub.com 独立 MCP", "",
    `[GitHub 逐工具映射及本地读写/权限证据](github-managed-reference-functional-overlap-2026-09-27.md)覆盖仓库文件读取/写入和 Issue 读取/评论。投影只在当前认证连接的 \`tools/list\` 参数 schema 匹配时出现，并保持 \`functional-overlap\` / \`unverified\`；独立 MCP 的 Grant 与逐次审批仍单独执行。它**没有**适配 Codex 的不透明 \`connector_76869538009648d5b282a4bb21c3d157\`，也没有覆盖 \`templated_apps_GitHubEnterprise\` 或共用此 ID 的另两包业务。上述 73 次未适配引用、${count(audit.referenceClasses, "mcp-candidate-converted")} 次已转换 MCP 候选等分流数字均不因该受限投影减少。`, "");
  lines.push("", "## 验收停止条件", "",
    "1. 候选 MCP 需逐工具比较名称、输入 schema、输出、错误、读写权限与账号作用域；使用隔离真实账号完成调用，并记录供应商是否允许 Shoggoth 客户端。任何一项不同须做显式适配，不能复用托管 ID 作连接凭据。",
    "2. 无候选项需有公开 API/MCP 文档或受控 provider、应用注册与 OAuth/令牌、具体工具合同、账号与真实业务结果。`templated_apps_` 项另需明确租户/部署实例。",
    "3. 62 包的 manifest 或嵌套文件许可、502 个 Skill 的依赖及三类 Agent 的实际执行，仍按主计划单独验收。本报告不改变安装可用性或完成状态。", "");
  return lines.join("\n");
}

function main() {
  const mode = process.argv[2];
  invariant(mode === "--check" || mode === "--write" || mode === "--json",
    "Usage: node scripts/plugin-managed-connector-audit.cjs --check|--write|--json");
  const audit = loadAudit();
  if (mode === "--json") {
    process.stdout.write(`${JSON.stringify({ batchDigest: audit.batchDigest,
      references: audit.references, ids: audit.ids, emptyAppFiles: audit.emptyAppFiles,
      referenceClasses: audit.referenceClasses, exactOverlapCounts: audit.exactOverlapCounts,
      idClasses: audit.idClasses,
      namespaceCounts: audit.namespaceCounts }, null, 2)}\n`);
    return;
  }
  const report = renderReport(audit);
  const target = path.join(repo, reportPath);
  if (mode === "--check") {
    invariant(fs.existsSync(target) && fs.readFileSync(target, "utf8") === report,
      `Managed connector report is stale: ${reportPath}`);
    process.stdout.write(`Verified ${audit.references.length} references / ${audit.ids.length} unique IDs\n`);
  } else {
    fs.writeFileSync(target, report);
    process.stdout.write(`Wrote ${reportPath}: ${audit.references.length} references / ${audit.ids.length} unique IDs\n`);
  }
}

if (require.main === module) main();
module.exports = { loadAudit, renderReport };
