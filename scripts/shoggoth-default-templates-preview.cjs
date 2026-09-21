#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { defaultAgentProfile } = require("../app/agent-service/product-store");
const { BUILTIN_CLI_AGENT_PROFILES } = require("../app/agent-service/builtin-cli-profiles");
const { isRuntimeAvailable } = require("../app/runtime-availability");
const { createDefaultDocuments, VIEW_HEADERS, EMPTY_VIEW_MESSAGES, DEFAULT_TEMPLATE_VERSION } = require("../app/agent-service/agent-definition-defaults");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");

const root = path.resolve(__dirname, "../docs/native-agent-defaults-v2");
const profiles = [defaultAgentProfile(0), ...BUILTIN_CLI_AGENT_PROFILES]
  .filter((profile) => isRuntimeAvailable(profile.runtime));
for (const profile of profiles) {
  const documents = { ...createDefaultDocuments(profile.name),
    TOOLS: DEFAULT_TOOL_REGISTRY.toolsMarkdown(), MEMORY: VIEW_HEADERS.MEMORY + EMPTY_VIEW_MESSAGES.MEMORY };
  const directory = path.join(root, profile.backendId);
  fs.mkdirSync(directory, { recursive: true });
  for (const [kind, content] of Object.entries(documents)) {
    fs.writeFileSync(path.join(directory, `${kind}.md`), content);
    // Keep the original Shoggoth example links working.
    if (profile.isDefault) fs.writeFileSync(path.join(root, `${kind}.md`), content);
  }
}
const kinds = ["IDENTITY", "SOUL", "USER", "AGENTS", "TOOLS", "MEMORY"];
const readme = [
  `# 原生 Agent 默认设定 v${DEFAULT_TEMPLATE_VERSION}`, "",
  "由当前源码生成的六套完整正文预览。App 打包携带模板代码，Service 为每个 Profile 在自己的数据目录生成文件；此目录是预览，不是活动 Agent 的存储。", "",
  "| 默认名称 | 后端 | 运行时 | 六份文件 |", "|---|---|---|---|",
  ...profiles.map((profile) => `| ${profile.name} | \`${profile.backendId}\` | \`${profile.runtime}\` | ${kinds.map((kind) => `[${kind}](${profile.backendId}/${kind}.md)`).join(" · ")} |`),
  "",
  "Shoggoth 与 Codex 共用 Codex 运行时，但 Profile、名称、设定和记忆分别保存。Claude Code 当前在发布配置中停用，不列为第七个启用后端。", "",
  "- IDENTITY 使用该 Profile 的正式名称；新增自定义 Agent 使用用户指定名称，不按后端或模型强行改名。应用名 Shoggoth、工具命名空间、CLI 品牌都不替代 Agent 名字。",
  "- SOUL 和 AGENTS 共用中性的初始原则，各 Profile 后续独立修改；不根据品牌杜撰个性或权限。",
  "- USER 和 MEMORY 初始为空，各 Profile 独立积累；项目和工作区记忆另按工作区约束。",
  "- TOOLS 来自同一产品工具注册表；可调用性受实际后端、连接和权限约束。原生 CLI 工具以本轮暴露的能力为准。Codex 专用提示只注入 Codex 运行时。",
  "- 当前后端和运行时由运行上下文提供，实际模型通过 runtime_context_get 查询，不在长期文件中写死。", "",
  "OpenClaw/Hermes 通过外部 MCP 连接时保留自己的身份和记忆机制；外部入口不暴露或允许调用原生 Agent 的设定、记忆和 Computer Use 工具。", "",
  "旧默认文件只升级确认从未定制的部分，保留历史和用户资料。v2 AGENTS 中原封未动的产品记忆确认段落会精确替换为直接保存规则，保留周围自定义内容。自定义、清空、导入、恢复及改回旧文字的设定均保留。根目录六份文件继续作为 Shoggoth 示例；各后端完整版本以表格链接为准。", "",
  "重新生成：`node scripts/shoggoth-default-templates-preview.cjs`。生成过程不连接已安装 App，不读取真实用户记忆。", "",
  "模板职责划分参考 [OpenClaw 官方模板](https://docs.openclaw.ai/reference/templates/AGENTS) 与 [Hermes 官方记忆机制](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)，正文按 Shoggoth 已实现的能力编写。", "",
].join("\n");
fs.writeFileSync(path.join(root, "README.md"), readme);
console.log(`Generated ${profiles.length} native Agent previews in ${root}`);
