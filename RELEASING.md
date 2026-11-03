# Shoggoth 公开源码与 macOS 正式发布流程

本文件是每次公开源码更新和正式 macOS 发布的检查清单。开发目录与 `output/public-source` 是两个独立的 Git 仓库；公开仓库只接收审核后的源码快照，不能推送开发目录的 Git 历史。Shoggoth 自有代码采用 Apache-2.0；第三方组件保留各自的许可证和署名。

自动化入口有两种。`.github/workflows/release.yml` 使用两台 GitHub 托管 Mac 并行签名、公证；`scripts/release-local.cjs` 使用本机钥匙串依次构建两个架构，再调用 GitHub 双架构原生验收。两者共用构建、公证、资产收据和验收逻辑，通过后都保留草稿。正式公开仍是独立操作。云端路径需要配置下文的发布环境 Secrets，本机路径使用已有钥匙串身份和公证 profile。推送版本标签本身不会自动打包或发布。

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

## 3. 从已审核的公开源码提交制作正式包

1. 固定 `output/public-source` 中已通过 CI 的提交和 `package.json` 版本。打包前再次从该提交导出到新的空目录，运行 `node scripts/check-release-private-keys.cjs /absolute/path/to/new-export`；命中即停止。用两份锁文件安装依赖，完成 `build:manage`、`prepare:runtimes`、`release:metadata`、`licenses:check`。构建输入必须是该公开提交，不得混入开发目录未公开的改动。
2. 分别构建 Apple Silicon（arm64）和 Intel（x64）ZIP。Electron 组装每个 App 后，`afterPack` 会扫描完整 App（包括 `app.asar` 与附加资源），私钥命中即停止，**此时尚未签名、公证或上传**。使用 `SHOGGOTH_CODESIGN_MODE=developer-id`、指定的 Developer ID Application 身份与受控钥匙串、公证凭据。确认两个 App 的签名、Team ID、公证结果为 `Accepted`，并已附加和验证公证票据。签名私钥与公证凭据不能放入源码或安装包。
3. 对两个已签名 App 分别运行 `node scripts/create-macos-dmg.mjs --arch arm64 --distribution official` 和 `--arch x64 --distribution official`。两个 DMG 各自提交 Apple 公证，要求 `Accepted`，再执行 `stapler staple`、`stapler validate` 和 `hdiutil verify`。
4. 生成并验证 `SHA256SUMS.txt`。正式 Release 的资产是两个 DMG、两个 ZIP、两个对应的 `.blockmap`、`latest-mac.yml` 和 `SHA256SUMS.txt`。`Shoggoth-<version>-mac.zip` 是 Intel 更新包；`Shoggoth-<version>-arm64-mac.zip` 是 Apple Silicon 更新包。

## 4. 草稿验收、公开发布与回查

1. 确认版本标签指向上述公开源码提交，创建草稿 Release 并上传全部资产。逐个核对名称、大小、SHA-256、架构、版本、Developer ID 签名、App/DMG 公证票据、Gatekeeper、DMG 中的 App、ZIP 更新元数据和源码一致性。运行打包后 Runtime 烟测。
2. 在原生 Intel 和 Apple Silicon runner 分别验收对应 ZIP 和 DMG；`verify-signed-draft.yml` 按双架构矩阵检查实际硬件、Runtime、离线 E5 与分发资产。它还在空的一次性 GitHub-hosted 账号上，将精确草稿 App 复制到该 runner 的 `/Applications`（已有 App 即停止），重核哈希、签名和公证后设置下载隔离标记，并通过 LaunchServices 正常启动，要求 Gatekeeper 已启用、可见窗口、Renderer、私有 Service 和正常退出，保存截图与结果。仅可确认标准下载的“打开”提示，不绕过“已损坏”或隐私权限提示。该受控隔离标记不等于实际浏览器下载，也不证明此前报告问题的用户设备已复测。本机已有用户数据的账号不得运行此首次启动脚本。公开源码 CI 和全部安装包验收成功后，才将草稿公开。任一门禁失败就保留草稿，不发布或覆盖已有正式资产。
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

`Signed macOS draft` 以已审核的公开源码标签为输入。必须从该版本标签触发，`tag` 必须等于 `v<package.json version>`。按本文件前述流程完成源码审核和公开 PR 后，用下面的命令触发一次即可。

```bash
gh workflow run release.yml --repo ArronKong/Shoggoth --ref v<VERSION> -f tag=v<VERSION>
```

1. 固定源码 SHA，拒绝已公开版本和归属不符的草稿，重新扫描源码，并调用同提交的完整 `CI` 工作流。源码 CI 失败会阻止签名。
2. 在 `macos-latest` arm64 与 `macos-15-intel` x64 上并行安装锁定依赖、构建、签名及公证。保留 App 和 DMG 的四次独立公证、Accepted、staple/validate、许可证、包内私钥和源码一致性门禁。凭据仅用于签名 job，并在退出时清理临时文件和钥匙串。
3. 汇总两个架构的构建收据，核对源码 SHA、运行编号、架构和资产摘要。合并 `latest-mac.yml` 的两个 ZIP 条目并保留 Intel fallback，重新计算 SHA-512 与全部七项资产的 SHA-256 清单。
4. 创建带操作标记的草稿，通过 Release ID 上传八项资产并读取远端字节核对。部分上传可以重试，只有同源码、同归属、同字节的已有资产才能复用。冲突、来源不明或已公开的资产会停止流程，需先调查。
5. 调用 `verify-signed-draft.yml` 的双架构原生验收，继续覆盖 ZIP、Runtime、离线 E5、签名、公证、Gatekeeper、DMG、隔离首次启动、窗口、Renderer、Service 与自然退出，并保存截图。最后将草稿状态和资产 ID、大小、摘要与已验字节收据再次核对，生成 `accepted-draft` artifact。

同一标签的运行通过 concurrency 串行化。已成功上传的架构产物属于同一 Actions run，失败 job 可单独重跑。若重新构建导致字节改变，而草稿已有旧字节，上传会停止并保留现场。新的源码提交应使用新的版本标签。完整流水线成功仅代表该草稿通过上述自动门禁；正式公开仍需要单独授权及其它适用的生产验收。

签名 Secrets 放在受保护的 `macos-signing` Environment，只有签名 job 声明并使用它，不放在仓库通用 Secrets。环境只接受 `v*` 标签，仓库版本标签规则限制创建、更新和删除为管理员操作。普通分支、PR 和 fork 不获得这些签名凭据。当前保护通过标签规则和环境部署限制执行，没有额外配置每次运行的人工 reviewer。管理员仍能更改规则或工作流，因此应保持管理员账号安全。所有外部 Actions 固定到完整提交 SHA。

通过 GitHub 加密 Secrets 渠道配置以下四项通用配置和一组公证凭据，私钥值不进入代码、日志或聊天。签名私钥移交 GitHub 托管 runner 前须取得用户相应授权。

| Secret | 用途 |
| --- | --- |
| `MACOS_CERTIFICATE_BASE64` | 包含 Developer ID 私钥的加密 PKCS#12，编码为单行 Base64 |
| `MACOS_CERTIFICATE_PASSWORD` | PKCS#12 的随机强密码 |
| `MACOS_SIGNING_IDENTITY` | Developer ID 身份的 SHA-1 指纹 |
| `APPLE_TEAM_ID` | Developer ID 所属 Team ID |

公证方式任选一组。API Key 使用 `APPLE_API_KEY_BASE64`、`APPLE_API_KEY_ID` 和 `APPLE_API_ISSUER`（App Store Connect 团队 API Key）；Apple ID 方式使用 `APPLE_ID` 和 `APPLE_APP_SPECIFIC_PASSWORD`（应用专用密码，不能填 Apple 账号登录密码）。两组都完整时优先使用 API Key。缺少证书或任一完整公证方式即停止，临时钥匙串和密钥文件在 job 结束时清理。

Apple ID 方式可在 [Apple 账号页面](https://account.apple.com/) 的「登录和安全 → App 专用密码」生成独立密码，例如命名 `Shoggoth GitHub Actions`，再到仓库 Settings → Environments → `macos-signing` → Environment secrets 分别填写开发者账号邮箱和生成的密码。此功能需要双重认证；生成与撤销步骤见 [Apple 说明](https://support.apple.com/zh-cn/102654)。凭据直接填写在 GitHub，不经聊天传递。

独立的 `Verify notarized macOS draft` 手动验收入口继续接受 `tag` 和 `release_id`，用于复验已有草稿。

## 本机签名、GitHub 双架构验收路径

本机需要 Node 22.22.3、已登录并有仓库写权限的 `gh`、Xcode 工具、可用 Developer ID 私钥和已验证的 `shoggoth-notary` profile。发布时 Mac 必须保持在线，构建会占用本机资源和临时磁盘空间。脚本从公开 GitHub 标签建立独立检出，等待该精确提交的 CI 成功，不打包当前开发目录。先做只读预检，再用同一标签运行完整流程。

```bash
node scripts/release-local.cjs --tag v<VERSION> --check-only
node scripts/release-local.cjs --tag v<VERSION>
```

如果本机通过 `HTTP_PROXY` / `HTTPS_PROXY` 联网，在上述命令前加 `NODE_USE_ENV_PROXY=1`，让锁定的 Node 22.22.3 下载器使用现有代理。例如 `NODE_USE_ENV_PROXY=1 node scripts/release-local.cjs --tag v<VERSION>`。它不改变系统代理配置，下载仍校验锁定的官方摘要。

可用 `--identity`、`--keychain`、`--notary-profile` 和 `--notary-keychain` 指定已有凭据。默认不传公证钥匙串路径，让 Apple 工具使用其默认钥匙串搜索，兼容存于数据保护钥匙串的 profile。本机路径不读取 GitHub 签名 Secrets，也不导出本机私钥。

脚本先重新导出并扫描固定源码、安装锁定依赖和准备构建输入，然后依次生成两个架构的已签名、公证 ZIP 和 DMG。每个架构验完 ZIP CRC 后，收集原始文件与签名回执，并移除本任务独立检出中的可由 ZIP 恢复的临时 App，以控制空间。汇总采用文件系统支持的复制优化，随后上传草稿、核对全部远端字节，触发唯一运行编号对应的双架构原生验收。下载验收证据后生成 `accepted-draft.json`，草稿仍保持未公开。

状态、包和证据默认保存在 `.artifacts/local-draft-v<VERSION>/`，也可用 `--work-dir /absolute/path` 指定。网络上传中断后用同一命令加 `--resume`，只续传相同字节。已完成但尚未收集的构建可根据原收据恢复；没有 Accepted 构建收据的签名或公证中断会停止，须先核对 Apple 提交状态，不能盲目重签。遗留 `release.lock` 须确认对应进程已退出后处理。验收失败应检查已有 run，按失败原因修复或重跑失败 job，再恢复本地等待。请求发出后未找到对应 run 时先核对 Actions，不自动重复触发。

两条路径可以分别体验，但同一版本只应有一套确定的签名产物。测试另一条路径时使用新的已审核版本标签，不能覆盖已有草稿中不同字节的资产。
