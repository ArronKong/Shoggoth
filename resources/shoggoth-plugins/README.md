# Shoggoth 内置插件（第一方通道）

这里的每个子目录都是随 App 发布的一个插件。目录名就是插件 ID（小写字母、数字、`-`，最长 64 个字符），
安装身份为 `first-party:<目录名>`，与 App 所在路径无关。

- 格式：Codex 内容包（`.codex-plugin/plugin.json` + `skills/` + 可选 `.mcp.json`），或 Agent Plugins 1.0.0
  标准包（根目录 `plugin.json`，含 `$schema`）。Agent 在对话里创建的插件草稿就是 Codex 格式，可以把草稿的
  `package/` 目录整个复制进来。
- 凭据只写 `${secret:NAME}` 引用，不要放真实或示例令牌（发布前检查会扫描私钥）。
- 行为：首次启动安装并为所有助理启用技能；新版本内容有变化时自动更新（已启用的先停用排空、更新后再启用，
  旧的 MCP 授权按规则失效，需在插件页「一键启用」一次）；用户卸载后不再自动重装，可在插件页重新安装。
- 发布前：`node scripts/first-party-plugin-sync-fixture.cjs` 会校验这里的每个包都能安装。

详见仓库根目录 `RELEASING.md` 与 `docs/architecture/plugin-author-guide.md`。
