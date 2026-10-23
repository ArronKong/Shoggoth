# 瑞幸咖啡 my-coffee（`${secret:NAME}` 写法示例）

Agent 曾为这个插件写过 251 行的本地 stdio 桥接脚本，只为把令牌从
`~/.my-coffee/LUCKIN_MCP_TOKEN` 读出来加到请求头上。现在 `.mcp.json` 直接声明远程端点和
`Authorization: Bearer ${secret:LUCKIN_MCP_TOKEN}`，不再需要桥接脚本。

- 安装：插件页「选择本地能力包」→「Codex 内容包」→「技能与 MCP」，再选这个目录；或者让 Agent 用同样的文件调用 `plugin_create`。
- 凭据：插件页「快速设置」填写，或由 Agent 调用 `plugin_secret_request` 弹出密码卡片。值加密保存在本机，只随请求发往 `https://gwmcp.lkcoffee.com`。
- 启用：「一键启用」（或 Agent 的 `plugin_activate`）确认一次，即连接端点、发现工具并授权。
- 作为内置插件随版本发布：把整个目录放进 `resources/shoggoth-plugins/luckin-coffee/`。
