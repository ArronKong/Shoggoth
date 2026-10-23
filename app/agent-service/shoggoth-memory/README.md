# Shoggoth Memory

Shoggoth 原生 Agent 的记忆服务。文件记忆、逐 Agent 索引、主动召回、来源校验和后台整理由本模块接入 Product Service。

## 产品入口与构建

- `service.cjs` 导出 `ShoggothMemoryService`，`host.cjs` 导出 `ShoggothMemoryHost`。
- `app/agent-service/server.js` 创建服务；配置与界面使用 owner `shoggoth-memory-core`。
- Product 状态库为 `<stateDir>/shoggoth-memory.sqlite`；每个 Agent 的索引为 `<stateDir>/agents/<profileId>/memory-core.sqlite`。`stateDir` 由 `resolveServicePaths()` 确定，默认是 `~/Library/Application Support/Shoggoth/shoggoth-core`。
- 构建适配层与固定输入在 `build/shoggoth-memory/`；入口脚本为 `scripts/build-shoggoth-memory.cjs`。
- `npm run build:memory-core` 生成 `core.cjs`；`npm run check:memory-core` 校验固定输入及 bundle 一致性；`npm run test:memory-core` 运行相关回归。

## 上游来源

检索和维护算法使用固定的 OpenClaw 源码，revision 为 `c10679395819ede78bb073f979f95c157e165bfa`。`build/shoggoth-memory/manifest.json` 记录来源和逐文件 SHA-256；`source/`、`dependencies/` 的内容保持原样，`core.cjs` 由构建脚本生成。

上游包名、SDK 接口、原生 promotion 标记、批处理请求 metadata 及许可证保留原名。这些名称用于准确调用和识别固定上游格式，不是旧 Shoggoth 存储标识的兼容别名。第三方通知仍指向 OpenClaw 的原仓库与许可证。

## 全新安装约定

2026-10-08 用户明确选择自行清理旧缓存后全新安装。本次命名调整直接使用新的 Product owner 与数据库名称，不添加旧目录、旧类名、旧 owner 或旧数据库的回退读取，也不自动迁移、删除用户数据。初始化、重启和中断恢复仍校验本安装的私有 owner、工作区与 SQLite 归属。

本次只调整模块命名；跨 Agent 只读互查另按开发计划实施。
