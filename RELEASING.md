# Shoggoth 公开源码与 macOS 正式发布流程

本文件是每次公开源码更新和正式 macOS 发布的检查清单。开发目录与 `output/public-source` 是两个独立的 Git 仓库；公开仓库只接收审核后的源码快照，不能推送开发目录的 Git 历史。Shoggoth 自有代码采用 Apache-2.0；第三方组件保留各自的许可证和署名。

当前可重复执行的正式发布路径是**本机 Developer ID 签名、公证，GitHub 草稿 Release 验收后发布**。`.github/workflows/release.yml` 仅供手动触发；只有配置好所需 Actions secrets、修复并实测整条工作流后，才能将它用作正式发布路径。推送版本标签本身不会自动打包或发布。

## 1. 冻结本次源码

1. 确定版本号、待发布的开发提交、工作区改动和发行说明。只纳入本次版本的改动；其他任务的未提交工作须隔离。记录公开仓库当前 `main`、拟发布的源码提交和导出清单。
2. 从开发目录导出到**新的空目录**：`npm run export:source -- /absolute/path/to/new-empty-directory`。脚本会在目录旁生成 `<directory>.manifest.json`，记录文件名、权限、大小和 SHA-256。导出会同时清空未完成再分发审核的插件目录清单，并移除构建配置中对这些未导出文件的单独复制项。它不会覆盖已有 `output/public-source`，也不会自动识别夹在允许文件中的隐私内容。
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

## 随 App 发布的 Shoggoth 内置插件（第一方通道）

- 把插件目录放进 `resources/shoggoth-plugins/<id>/`，目录名就是插件 ID（小写字母、数字、`-`）。格式可以是 Codex 内容包（`.codex-plugin/plugin.json`，Agent 创建的草稿就是这种格式），也可以是 Agent Plugins 1.0.0 标准包（根目录 `plugin.json`，含 `$schema`）。安装身份为 `first-party:<id>`，与 App 所在路径无关；这个目录和第三方的 `resources/bundled-plugins/` 分开，随公开源码一起导出，内容须是 Shoggoth 有权以 Apache-2.0 再分发的。
- 凭据只写 `${secret:NAME}` 引用，不能放真实或示例令牌。发布前运行 `node scripts/first-party-plugin-sync-fixture.cjs`（已包含在 `npm run test:plugins` 中），它会确认这里的每个包都能安装；私钥扫描同样覆盖 `resources/`。
- 用户侧行为：首次启动时安装，并为所有助理启用技能；MCP 服务仍需在插件页「一键启用」一次。新版本中某个包的内容有变化时会自动更新：已启用的先停用并排空旧连接，更新后再启用，旧的 MCP 授权按规则失效，需要再一键启用一次；已停用的保持停用。用户卸载过的包不会自动重装，可以在插件页重新安装。
- 如果新内容与这个包用过的某个旧版本逐字节相同，会被当作回退而跳过，需要提高 `version`。中途中断的更新（例如已停用、尚未安装）会在下次启动时接着完成。

## 内部预览包（开发目录或 worktree，不公证、不发布）

内部包直接从开发提交构建，包含 `resources/bundled-plugins`，不经过公开导出，只用于本机或内部验收，不上传 Release。

1. 提交全部改动，保持工作区干净。提升版本时用 `npm version <版本> --no-git-tag-version` 后运行 `npm run release:metadata`，同步 `package.json`、`package-lock.json` 与 SBOM。
2. 根目录 `node_modules` 必须是与锁文件一致的真实目录：`npm ci --ignore-scripts`；worktree 可用 `unlink node_modules && cp -c -R <主检出>/node_modules node_modules`（APFS 克隆）。**不能是符号链接**：electron-builder 会丢掉全部传递依赖，却仍然返回成功。
3. 运行 `npm run dist:arm64`（本机 Apple Silicon，产物在 `dist/release-<版本>/`）或 `npm run dist`（双架构）。两者都先执行 `node scripts/release-package-checks.cjs preflight`：核对依赖安装，对 `resources/`、`schemas/` 执行私钥门禁，逐个校验内置插件完整性；任一项失败都不开始构建。
4. `afterPack` 在任何签名之前核对成品：私钥门禁、SQLite、依赖闭包（锁文件中的生产依赖都以锁定版本出现在 App 中）、内置插件完整性（与安装时的校验相同）。任一失败即中止。
5. 构建后运行 `SHOGGOTH_SMOKE_DIST_DIR=<产物目录> node scripts/shoggoth-packaged-runtime-smoke.mjs --spike-arm64`，在产物目录记录 `verification.json`（来源提交、SHA-256、各项检查结果），并更新 PROGRESS。
6. 每次交付新包必须附更新说明：以上一份已交付包的实际构建来源提交为基线，对比本次固定构建提交，归纳用户可见的新增、改进和修复，不能只列最后一次合入。标明对应版本与来源，将未实施计划和验收限制单列；更新清单与 App、ZIP、验收记录一同交付，并写入 PROGRESS。

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
