# Shoggoth

[English](README.md) | **简体中文**

Shoggoth 是一款面向 macOS 的本地 AI Agent 工作台。它把聊天、模型与账号、代理管理、定时任务、技能、用量统计和灵感便签放在同一个桌面应用中。

你可以通过统一界面使用本地代理，连接 OpenClaw、Hermes 和已启用的 CLI 后端，管理不同代理的工作与对话。应用基于 Electron 和 React，通过本地代理服务与各个后端通信。

## 可以做什么

- **与代理聊天**：在统一界面中切换代理、管理会话并查看对话记录。
- **管理模型与账号**：集中配置模型供应商、模型选择和账号授权。
- **管理代理**：查看代理状态，配置不同代理使用的后端与模型。
- **安排定时任务**：创建和管理定时任务，查看执行记录。
- **管理技能与工具**：查看和管理后端提供的 Skills 与 CLI 工具。
- **查看用量**：通过用量页面了解模型的 Token 使用情况。
- **记录灵感**：用灵感便签收集想法、整理内容并归档。

## 环境要求

- 桌面应用需要 **macOS 13 或更新版本**，支持 Apple Silicon 和 Intel。
- 从源码开发需要 **Node.js 22.22.3 或更新版本**及 npm；打包后的应用自带所需运行时。
- 安装依赖和下载固定版本的运行时需要联网。
- 根据使用的功能，准备相应账号，以及需要连接的外部 CLI 或后端。仅构建界面、运行隔离测试时不需要登录这些账号。

## 从源码运行

下载或克隆仓库后，在项目根目录执行：

```sh
npm ci
npm --prefix app/manage-ui ci
npm run prepare:runtimes
npm run build:manage
npm start
```

`prepare:runtimes` 会下载固定版本的 Codex 和 Cua，并准备两种 Mac 架构使用的 SQLite 原生模块。下载文件与解压后的二进制会按照 `build/` 中的清单校验。

这些步骤不会安装、配置外部代理，也不会自动登录账号。下载生成的文件位于 `.vendor/`，无需提交到仓库。

## 开发与构建

开发前端时，在一个终端中启动界面开发服务器：

```sh
npm --prefix app/manage-ui run dev
```

再在另一个终端的项目根目录启动桌面应用，由它提供本地 API：

```sh
npm run start:dev
```

构建包含桌面应用的 ZIP 安装包：

```sh
npm run dist
```

构建产物位于 `dist/`。未配置 Developer ID 和公证凭据时，生成的包用于内部预览。正式向 macOS 用户分发前，需要完成签名、公证、Gatekeeper 检查和干净 Mac 账户下的验证。

## 后端连接与数据

在「设置」中连接需要的本地后端，在「模型」中配置模型和账号。OpenClaw 与 Hermes 需要单独安装，请按各自上游项目的说明配置。

当前版本暂时停用 **原生 Claude Code 连接**，依赖和安装包中不包含 Claude Agent SDK。已有账号与对话数据保留；通过其他已配置后端访问的 Anthropic 模型不受此限制。

本地配置、会话和文件可能包含私人数据。提交 Issue 或分享项目文件时，请先移除账号凭据和私人内容。

## 常用检查

在项目根目录运行：

```sh
npm --prefix app/manage-ui exec -- tsc --noEmit --project app/manage-ui/tsconfig.json
npm run build:manage
npm run release:metadata
npm run licenses:check
node scripts/third-party-licenses-unit.mjs
node scripts/shoggoth-builtin-cli-profiles-unit.cjs
node scripts/runtime-cli-auth-unit.cjs
node scripts/shoggoth-runtime-adapter-registry-unit.cjs
node scripts/proxy-smoke.mjs
node scripts/proxy-chat-smoke.mjs
node scripts/hermes-start-smoke.cjs
npm audit
npm --prefix app/manage-ui audit
```

在 macOS 上安装 Electron 并完成界面构建后，还可以运行窗口安全检查：

```sh
node_modules/.bin/electron scripts/ui-security-electron-smoke.cjs
```

以上检查使用测试数据和临时本地服务。需要真实账号或会修改外部后端的测试，应在单独的测试环境中运行。参与开发前请阅读[贡献说明](CONTRIBUTING.md)。

如果运行时下载失败，可以重新执行 `npm run prepare:runtimes`，不要跳过文件校验。如果 Electron 下载需要使用已配置的 HTTP(S) 代理，可以执行 `ELECTRON_GET_USE_PROXY=1 npm ci`。修改依赖后，应按两份锁文件重新安装，并在打包前重新生成发布元数据。

## 导出用于发布的源码

首次准备公开源码时，可以导出到一个空目录：

```sh
npm run export:source -- /absolute/path/to/an-empty-directory
```

导出会排除内部开发记录与原仓库的 Git 历史。文件哈希清单保存在导出目录旁边，名称为 `<directory>.manifest.json`，用于本地核对。创建公开仓库前，应先检查并扫描导出的内容。

## 许可证

Shoggoth 自有代码采用 [MIT 许可证](LICENSE)。第三方代码、字体和随包程序保留各自原有许可证。

相关来源、版权和完整许可文本见：

- [第三方声明](resources/legal/THIRD-PARTY-NOTICES.md)
- [许可证索引](resources/legal/third-party-index.json)
- [运行时源码来源](resources/legal/RUNTIME-LICENSE-SOURCES.md)

打包后的应用也会在 `Contents/Resources/legal` 中包含这些许可材料。
