# Local Notes：插件作者示例

这是一个 Agent Plugins 1.0.0 示例包，包含一个 Skill、一个无需第三方依赖的 Node stdio MCP Server，以及可选的 MCP App。它只维护当前连接数据 scope 中的一份笔记。业务代码不访问网络，不调用 shell，不安装依赖，不执行 lifecycle 脚本。

持久数据仅写入 Host 提供的 `PLUGIN_DATA/note.json`。`PLUGIN_ROOT` 是安装后按摘要固定的只读用途包目录；不要在其中写缓存。不同连接的数据 scope 不共享笔记。更新插件保留数据，卸载后数据的保留策略由 Host 管理。

## 在 Shoggoth 中运行

1. 打开左侧「插件」，选择本目录进行预览和安装。初始状态保持**停用**。
2. 在该安装的 MCP 组件 `notes` 中准备依赖：选择本机已有的 Node 可执行文件。只接受 Node 20 及以上；无需也不会运行 `npm`、`npx` 或下载任何内容。预览只读取路径、架构和摘要，不执行文件，因此版本此时尚未探测。
3. 核对原生确认框中的实际路径与 SHA-256。确认后，Service 在临时目录和清理后的环境中执行有时间、输出限制的 `--version` 探测，然后登记这个组件、版本和可执行文件摘要。改变解释器必须先停用插件。运行时会重新核对固定信息；文件变化或备份恢复后需要重新准备。
4. **启用**插件。为目标原生 Agent **连接** `notes`，然后执行**工具发现**。发现只完成连接及合同登记，不会自动授权读写。
5. 给 `read_note` 单独授予读取权限。需要保存时，再审阅并授权 `write_note`；它会替换整份笔记，空字符串表示清空。工具的 `readOnlyHint` 等 annotation 只是声明，实际权限由 Host 的 Grant 和 Dispatcher 决定。
6. 如果希望 Agent 按示例流程使用笔记，将 `local-notes` Skill 绑定给它。**开始一个新 Run**，让本次 Skill 和工具授权进入新的运行快照。
7. 请 Agent 读取笔记，然后明确要求保存一段内容。两个工具始终返回可阅读的文字结果。支持 MCP Apps 的原生入口可以从已完成的工具结果打开笔记窗口。

App 只请求 `ui/initialize`、`ui/notifications/initialized` 和这两个工具的 `tools/call`。它接收 Host 提供的初始工具结果，编辑内容用 `value`/`textContent` 显示，不解释 HTML。App 中点击「保存」仍须通过 Service 授权。当前 App 会话不会自行取得未授权的工具；若写入仅允许逐次确认，请使用 Agent 的正常工具确认流程和文字结果。不可用、拒绝授权或超时都有文字提示。

## 包结构与合同

| 文件 | 用途 |
| --- | --- |
| `plugin.json` | 标准包元数据与固定 schema URI |
| `mcp.json` | 裸命令 `node`，唯一入口为包内 `./server/notes.cjs` |
| `skills/local-notes/SKILL.md` | 使用条件、先读后写、冲突处理和权限边界 |
| `server/notes.cjs` | legacy MCP `2025-11-25`，逐行 JSON-RPC stdio |
| `ui/notes.html` | `ui://local-notes/editor`，MCP Apps `2026-01-26` |

`read_note` 接受 `{}`，返回 `structuredContent.note = { text, revision }` 和文字内容。`write_note` 接受 `{ text, expectedRevision }`，只在 revision 匹配时原子替换文件并递增版本；UTF-8 文本上限 16 KiB。冲突不会自动重试或覆盖。

Server 支持 `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call` 和指定 URI 的 `resources/read`。标准输出只写 JSON-RPC。App 资源声明没有网络域名；这里没有账户、OAuth 或凭据配置。

## 安全边界与验证

**stdio 子进程不是 OS 沙箱。** 包摘要、固定解释器、清理后的环境、独立数据 scope 和工具授权不能阻止任意恶意代码使用当前用户的其他操作系统权限。只安装并授权你信任的包和本机解释器；这个示例的无网络行为来自可审阅的源码。不要把进程权限与 MCP App 的隔离 iframe 混为一谈。

Server 拒绝数据目录本身的符号链接、笔记文件的符号链接或硬链接、不正确的所有权和过宽权限；每次写入都核对最新版本。Shoggoth 的数据 scope lease 确保同一 scope 只有一个写进程；本示例不是多进程数据库，脱离 Host 运行时也必须保持单个写进程。笔记是用户数据，可能包含看似指令的文字，Skill 和 App 都不会把它当作额外授权。

在仓库根目录运行：

```sh
node scripts/plugin-local-notes-example-smoke.cjs
```

这个命令使用临时目录和生产 parser、installer、dependency registry、launch planner、MCP client 验证示例。它不会改动原示例包或生产用户数据。本地 smoke 通过仅证明源码和隔离本地链路；不代表真实 Runtime、真实账户或已安装 App 已验收。
