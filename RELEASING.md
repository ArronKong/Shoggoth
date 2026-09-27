# Shoggoth 公开源码与 macOS 正式发布流程

本文件是每次公开源码更新和正式 macOS 发布的检查清单。开发目录与 `output/public-source` 是两个独立的 Git 仓库；公开仓库只接收审核后的源码快照，不能推送开发目录的 Git 历史。Shoggoth 自有代码采用 Apache-2.0；第三方组件保留各自的许可证和署名。

当前可重复执行的正式发布路径是**本机 Developer ID 签名、公证，GitHub 草稿 Release 验收后发布**。`.github/workflows/release.yml` 仅供手动触发；只有配置好所需 Actions secrets、修复并实测整条工作流后，才能将它用作正式发布路径。推送版本标签本身不会自动打包或发布。

## 1. 冻结本次源码

1. 确定版本号、待发布的开发提交、工作区改动和发行说明。只纳入本次版本的改动；其他任务的未提交工作须隔离。记录公开仓库当前 `main`、拟发布的源码提交和导出清单。
2. 从开发目录导出到**新的空目录**：`npm run export:source -- /absolute/path/to/new-empty-directory`。脚本会在目录旁生成 `<directory>.manifest.json`，记录文件名、权限、大小和 SHA-256。它不会覆盖已有 `output/public-source`，也不会自动识别夹在允许文件中的隐私内容。
3. 对照清单逐项比较新导出与 `output/public-source` 的完整文件列表和内容。确认增加、删除和修改都有来源与用途；不能只看 Git 的文本 diff。`resources/bundled-plugins/packages/` 在再分发权利完成审核前不得进入公开导出。

## 2. 推送前审核 `public-source`：必须通过

- 检查源码、测试、构建配置、必要资源、文档、`LICENSE`、`NOTICE` 和 `resources/legal`。核对第三方许可证及再分发条件，保留第三方合法署名。Shoggoth 自有代码的许可声明须与 Apache-2.0 一致。
- 检查完整文件树与新增二进制资源的内容或元数据。排除日志、缓存、备份、旧安装包、开发截图、内部文档、用户资料、会话记录、账号、令牌、私钥、非必要的个人姓名或邮箱、本机绝对路径和内部地址。DMG、ZIP、blockmap 与更新清单只作为单独审核的 Release 资产，不进入源码 Git 树。
- 推送前对新的空目录导出运行 `node scripts/check-release-private-keys.cjs /absolute/path/to/new-export`，同时运行 Gitleaks，并人工复核命中项以及它无法识别的隐私内容。私钥检查会阻止常见密钥文件、完整或疑似真实的 PEM/DER 私钥和私有 JWK；模拟测试文本或库里的私钥格式识别代码不会被当成真实密钥。检查公开仓库新增提交的作者和提交者、版本标签的创建者及注释元数据；使用 GitHub `noreply` 邮箱。核对待推送的分支与标签中不会带入开发仓库历史。
- 执行锁定依赖安装、前端类型检查与构建、许可一致性检查、相关隔离测试及两份依赖审计。检查 `output/public-source` 与新导出的一致性。所有例外必须有明确解释和审核结果。

**停止条件：**任何文件来源、隐私命中、许可范围、哈希或测试结果无法解释时，先修复并重新审核；CI 通过不能代替这项人工检查。审核通过后，通过公开仓库的 PR 合并源码更新，等待必需 CI 成功，并确认远端 `main` 与已审核内容一致。源码上传不等于安装包发布。

## 3. 从公开源码提交制作两个架构的正式包

1. 固定 `output/public-source` 中已通过 CI 的提交和 `package.json` 版本。打包前再次从该提交导出到新的空目录，运行 `node scripts/check-release-private-keys.cjs /absolute/path/to/new-export`；命中即停止。用两份锁文件安装依赖，完成 `build:manage`、`prepare:runtimes`、`release:metadata`、`licenses:check`。构建输入必须是该公开提交，不得混入开发目录未公开的改动。
2. 分别构建 Apple Silicon（arm64）和 Intel（x64）ZIP。Electron 组装每个 App 后，`afterPack` 会扫描完整 App（包括 `app.asar` 与附加资源），私钥命中即停止，**此时尚未签名、公证或上传**。使用 `SHOGGOTH_CODESIGN_MODE=developer-id`、指定的 Developer ID Application 身份与受控钥匙串、公证凭据。确认两个 App 的签名、Team ID、公证结果为 `Accepted`，并已附加和验证公证票据。签名私钥与公证凭据不能放入源码或安装包。
3. 对两个已签名 App 分别运行 `node scripts/create-macos-dmg.mjs --arch arm64 --distribution official` 和 `--arch x64 --distribution official`。两个 DMG 各自提交 Apple 公证，要求 `Accepted`，再执行 `stapler staple`、`stapler validate` 和 `hdiutil verify`。
4. 生成并验证 `SHA256SUMS.txt`。正式 Release 的资产是两个 DMG、两个 ZIP、两个对应的 `.blockmap`、`latest-mac.yml` 和 `SHA256SUMS.txt`。`Shoggoth-<version>-mac.zip` 是 Intel 更新包；`Shoggoth-<version>-arm64-mac.zip` 是 Apple Silicon 更新包。

## 4. 草稿验收、公开发布与回查

1. 确认版本标签指向上述公开源码提交，创建草稿 Release 并上传全部资产。逐个核对名称、大小、SHA-256、架构、版本、Developer ID 签名、App/DMG 公证票据、Gatekeeper、DMG 中的 App、ZIP 更新元数据和源码一致性。运行打包后 Runtime 烟测。
2. 在原生 Intel runner 验收 Intel ZIP 和 DMG；`verify-signed-draft.yml` 可用于草稿资产的 Intel 验收。公开源码 CI 和全部安装包验收成功后，才将草稿公开。任一门禁失败就保留草稿，不发布或覆盖已有正式资产。
3. 发布后核对仓库公开状态、标签指向、Release 状态、八项资产及下载链接，并保存导出清单、哈希、签名、公证与验收记录。下一版本重新执行整套审核；不得沿用上次的检查结论。

## GitHub Actions 自动发布路径

`Signed macOS release` 是独立的手动触发工作流，要求公开仓库和七项 Actions secrets：`MACOS_CERTIFICATE_BASE64`、`MACOS_CERTIFICATE_PASSWORD`、`MACOS_SIGNING_IDENTITY`、`APPLE_API_KEY_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`。配置凭据之前以及完整端到端实测通过之前，正式版仍按上面的本机签名与草稿验收路径发布。不能为了启用自动化，把本机私钥直接加入 Git 仓库。
