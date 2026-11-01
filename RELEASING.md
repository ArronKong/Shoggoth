# Shoggoth 公开源码与 macOS 正式发布流程

本文件是每次公开源码更新和正式 macOS 发布的检查清单。开发目录与 `output/public-source` 是两个独立的 Git 仓库；公开仓库只接收审核后的源码快照，不能推送开发目录的 Git 历史。Shoggoth 自有代码采用 Apache-2.0；第三方组件保留各自的许可证和署名。

当前可重复执行的正式发布路径是**本机 Developer ID 签名、公证，GitHub 草稿 Release 验收后发布**。`.github/workflows/release.yml` 仅供手动触发；只有配置好所需 Actions secrets、修复并实测整条工作流后，才能将它用作正式发布路径。推送版本标签本身不会自动打包或发布。

## 1. 冻结本次源码

1. 确定版本号、待发布的开发提交、工作区改动和发行说明。只纳入本次版本的改动；其他任务的未提交工作须隔离。记录公开仓库当前 `main`、拟发布的源码提交和导出清单。
2. 从开发目录导出到**新的空目录**：`npm run export:source -- /absolute/path/to/new-empty-directory`。脚本会在目录旁生成 `<directory>.manifest.json`，记录文件名、权限、大小和 SHA-256。导出拒绝已退役的插件包资源；MCP 连接器的固定依赖锁、许可证和运行时重建资料须一并审核；已退役的 OpenConnector 资源不得重新引入。它不会覆盖已有 `output/public-source`，也不会自动识别夹在允许文件中的隐私内容。
3. 对照清单逐项比较新导出与 `output/public-source` 的完整文件列表和内容。确认增加、删除和修改都有来源与用途；不能只看 Git 的文本 diff。`resources/bundled-plugins/packages/` 在再分发权利完成审核前不得进入公开导出。

## 2. 推送前审核 `public-source`：必须通过

- 检查源码、测试、构建配置、必要资源、文档、`LICENSE`、`NOTICE` 和 `resources/legal`。核对第三方许可证及再分发条件，保留第三方合法署名。Shoggoth 自有代码的许可声明须与 Apache-2.0 一致。
- 检查完整文件树与新增二进制资源的内容或元数据。排除日志、缓存、备份、旧安装包、开发截图、内部文档、用户资料、会话记录、账号、令牌、私钥、非必要的个人姓名或邮箱、本机绝对路径和内部地址。DMG、ZIP、blockmap 与更新清单只作为单独审核的 Release 资产，不进入源码 Git 树。
- 推送前对新的空目录导出运行 `node scripts/check-release-private-keys.cjs /absolute/path/to/new-export`，同时运行 Gitleaks，并人工复核命中项以及它无法识别的隐私内容。私钥检查会阻止常见密钥文件、完整或疑似真实的 PEM/DER 私钥和私有 JWK；模拟测试文本或库里的私钥格式识别代码不会被当成真实密钥。检查公开仓库新增提交的作者和提交者、版本标签的创建者及注释元数据；使用 GitHub `noreply` 邮箱。核对待推送的分支与标签中不会带入开发仓库历史。
- 执行锁定依赖安装、前端类型检查与构建、许可一致性检查、相关隔离测试及两份依赖审计。检查 `output/public-source` 与新导出的一致性。所有例外必须有明确解释和审核结果。

**停止条件：**任何文件来源、隐私命中、许可范围、哈希或测试结果无法解释时，先修复并重新审核；CI 通过不能代替这项人工检查。审核通过后，通过公开仓库的 PR 合并源码更新，等待必需 CI 成功，并确认远端 `main` 与已审核内容一致。源码上传不等于安装包发布。

## 3. 从已审核的公开源码提交制作正式包（当前 connector 候选尚有公开发布门禁）

1. 固定 `output/public-source` 中已通过 CI 的提交和 `package.json` 版本。打包前再次从该提交导出到新的空目录，运行 `node scripts/check-release-private-keys.cjs /absolute/path/to/new-export`；命中即停止。用两份锁文件安装依赖，完成 `build:manage`、`prepare:runtimes`、`release:metadata`、`licenses:check`。构建输入必须是该公开提交，不得混入开发目录未公开的改动。
2. 分别构建 Apple Silicon（arm64）和 Intel（x64）ZIP。Electron 组装每个 App 后，`afterPack` 会扫描完整 App（包括 `app.asar` 与附加资源），私钥命中即停止，**此时尚未签名、公证或上传**。使用 `SHOGGOTH_CODESIGN_MODE=developer-id`、指定的 Developer ID Application 身份与受控钥匙串、公证凭据。确认两个 App 的签名、Team ID、公证结果为 `Accepted`，并已附加和验证公证票据。签名私钥与公证凭据不能放入源码或安装包。
3. 对两个已签名 App 分别运行 `node scripts/create-macos-dmg.mjs --arch arm64 --distribution official` 和 `--arch x64 --distribution official`。两个 DMG 各自提交 Apple 公证，要求 `Accepted`，再执行 `stapler staple`、`stapler validate` 和 `hdiutil verify`。
4. 生成并验证 `SHA256SUMS.txt`。正式 Release 的资产是两个 DMG、两个 ZIP、两个对应的 `.blockmap`、`latest-mac.yml` 和 `SHA256SUMS.txt`。`Shoggoth-<version>-mac.zip` 是 Intel 更新包；`Shoggoth-<version>-arm64-mac.zip` 是 Apple Silicon 更新包。

## 4. 草稿验收、公开发布与回查

1. 确认版本标签指向上述公开源码提交，创建草稿 Release 并上传全部资产。逐个核对名称、大小、SHA-256、架构、版本、Developer ID 签名、App/DMG 公证票据、Gatekeeper、DMG 中的 App、ZIP 更新元数据和源码一致性。运行打包后 Runtime 烟测。
2. 在原生 Intel runner 验收 Intel ZIP 和 DMG；`verify-signed-draft.yml` 可用于草稿资产的 Intel 验收。公开源码 CI 和全部安装包验收成功后，才将草稿公开。任一门禁失败就保留草稿，不发布或覆盖已有正式资产。
3. 发布后核对仓库公开状态、标签指向、Release 状态、八项资产及下载链接，并保存导出清单、哈希、签名、公证与验收记录。下一版本重新执行整套审核；不得沿用上次的检查结论。

## 依赖审计范围复核（2026-11-02，复核到期 2026-11-16 UTC）

正式发布执行 `npm run audit:release`，根目录和 UI 仍各自调用 `npm audit --audit-level=moderate --json`。完整原始报告与实际 npm 退出码应随验收记录保存；未解释的中危及以上结果、网络错误、无效报告和未知依赖链均阻止发布。

当前仅复核 [GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249) 在旧构建依赖中的适用范围。维护者公告指向 minimatch 10.2.6 的 `optimizationLevel >= 2` 和 `firstPhasePreProcess` / `secondPhasePreProcess`；数据库的 `<11.0.1` 范围还涵盖没有该优化器的 3.1.5 与 5.1.9，[范围澄清问题](https://github.com/github/advisory-database/issues/10811) 尚未结案。这是根据维护者公告和固定源码所作的项目级范围复核。

`dependency-audit-policy.cjs` 只接受上述两份源码的精确 SHA-256、锁文件版本与 dev-only 用途，逐个核对全部安装位置及优化器缺席，并只传播这一个已复核条目的传递标记。任何其它公告、版本、源码变化、生产用途、较高严重级别或复核到期都会阻止验收。原始报告可能仍列出 15 个受该条目传播的构建依赖记录，交付时应报告该事实。现代 glob/minimatch 分支使用修复版 14.0.3/11.0.3；旧构建工具保留其 callable API。

Undici 分别固定为根依赖 7.30.1、node-gyp 的 6.29.1、记忆核心内嵌依赖 8.12.2。记忆依赖的官方归档完整性、来源及逐文件哈希记录在 `build/shoggoth-memory/manifest.json`；OpenClaw 上游源文件仍保持原 revision 与哈希，重建核心后须通过完整记忆回归。

## MCP 连接器

连接器通过 Service 托管的 MCP 客户端接入。App 不再携带 OpenConnector、Bun 编译 sidecar 或原 sidecar 的 313 项依赖清单；与主进程或 UI 共同使用的包仍按各自依赖闭包保留在 SBOM 中。Registry 包由用户明确确认后使用本机 npx / uvx / Docker 启动精确版本，不在 App 启动时自动安装。

升级保留 OpenConnector 原数据和密钥，不启动旧 writer。MCP 连接确认账本由 App Host 持有独占 writer lease；离线备份和恢复必须取得同一 lease，拒绝活跃 App writer。恢复覆盖当前精确请求范围的确认屏障并把 pending 转为 unknown，不重发任何已接受或不确定的确认。旧插件退役凭证、历史、独立 Skills、外部 Host 桥、模型 Runtime 和记忆分别保留。`connector-package-checks.cjs` 的旧模块名保留供打包工具兼容，其现行合同改为拒绝包内任何已退役资源或 SBOM 条目；不再要求已删除的 sidecar 来源或 Bun/WebKit 重链接审查。Developer ID、公证、完整性、依赖闭包、私钥与发布授权门禁继续执行。

## 内部预览包（开发目录或 worktree，不公证、不发布）

内部候选只用于隔离验收，不安装到现有 App，不上传 Release。

1. 冻结准确源码和改动范围。版本变化后同步 `package.json`、锁文件、发行元数据和 SBOM；保留并行任务修改。
2. 根目录和 UI `node_modules` 使用与各自锁文件一致的真实目录。worktree 可 APFS 克隆后核对版本；符号链接会让 builder 丢失传递依赖。Electron binary 的实际版本也必须匹配 npm 包，不能只改 package.json。
3. 准备固定 Runtime，运行 `npm run dist:arm64`。构建组件后执行 release preflight：依赖锁、私钥、MCP 合同和已退役资源缺席检查均须通过。
4. `afterPack` 在签名前检查实际 App 的私钥、SQLite、依赖闭包、MCP 协议与已退役资源缺席，并拒绝已退役资源。签名后再次检查包内不含 OpenConnector 资源，并核对 Service 正常启停。
5. 运行 `SHOGGOTH_SMOKE_DIST_DIR=<候选产物绝对目录> npm run test:mcp-connectors:app -- --spike-arm64`（必须明确提供候选路径）；包含 MCP 连接器、Service 持久化、无旧 writer、自然停止和退出。再做 ZIP CRC、实际解包后的 App 重验，记录各自证据。
仅检查开发候选 App 目录时可用 `--app-arm64`；此模式仍执行完整 App 门禁，但不代表 ZIP CRC、解包或分发验收。ZIP 归档失败不能记为 ZIP 成功。

6. 交付说明分别报告源码、UI/Service、真实 Host/Provider、App/ZIP 和安装版状态。真实账号和业务结果不能由夹具代替；推送、安装、公开发布分别遵守用户授权。

7. 每次新包必须附更新清单：以上一份已交付包的实际构建来源为基线，对比本次固定提交，归纳全部用户可见新增、改进和修复，不能只列最后一次合入。记录对应版本与来源，把未实施计划和验收限制单列；清单与 App、ZIP 和验收记录一同交付，并写入 PROGRESS。

### 稳定的本地签名身份（内部预览包）

ad-hoc 签名的 designated requirement 是 `cdhash`，每次重新打包都会变，macOS 里已开启的辅助功能/屏幕录制授权（以及钥匙串授权）就仍属于旧安装包。内部预览包改用一张固定的本地证书签名，要求变成 `identifier "ai.shoggoth.desktop" and certificate leaf = H"<证书指纹>"`，重装后授权保持有效。

```bash
node scripts/local-signing.cjs setup     # 建专用钥匙串和证书（幂等；密码由脚本随机生成，存于 ~/.shoggoth-signing，权限 600）
node scripts/local-signing.cjs trust     # 一次：macOS 弹出系统授权框，输入登录密码，把私有 CA 设为代码签名受信任
node scripts/local-signing.cjs verify    # 签两个不同文件，确认无弹窗、要求稳定、运行时身份校验通过
node scripts/local-signing.cjs run -- npm run dist:arm64   # 用该身份打包
```

- 专用钥匙串 `~/Library/Keychains/shoggoth-internal-signing.keychain-db` 只含这一个身份；私钥导入时已授权 codesign，签名不会再弹出输入密码的框。CA 私钥在签发后立即删除。`run` 只在命令执行期间把该钥匙串加入搜索列表并解锁，结束后恢复原列表。
- 早先手工建的 `shoggoth-local-signing` 钥匙串需要它自己的密码（不是登录密码），不要再用；不要用登录钥匙串里的其他身份签内部包。
- 第一次换成该身份的 App 启动时，macOS 会就「Shoggoth Safe Storage」钥匙串项询问一次访问权限（旧项属于 ad-hoc 身份），选「始终允许」；之后重装不再询问。已有的辅助功能/屏幕录制授权也要在系统设置里移除再添加一次，之后重装保持有效。
- 证书有效期 10 年；过期或需要重建时删除钥匙串（`security delete-keychain`）和 `~/.shoggoth-signing` 后重新 `setup` + `trust`，那时授权同样需要重新添加一次。

## GitHub Actions 自动发布路径

`Signed macOS release` 是独立的手动触发工作流，要求公开仓库和七项 Actions secrets：`MACOS_CERTIFICATE_BASE64`、`MACOS_CERTIFICATE_PASSWORD`、`MACOS_SIGNING_IDENTITY`、`APPLE_API_KEY_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`。配置凭据之前以及完整端到端实测通过之前，正式版仍按上面的本机签名与草稿验收路径发布。不能为了启用自动化，把本机私钥直接加入 Git 仓库。
