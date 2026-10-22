# GitHub Actions 自动发布

推送 `v主版本.次版本.修订版本` 标签后，仓库的 **Publish release** 工作流会自动检查、构建并发布 GitHub Release。普通代码提交不会生成 Release。

## 发布新版本

1. 将 `Receiver/Receiver.csproj`、`Desktop/ICeClass.Desktop.csproj`、`package.json` 和 `package-lock.json` 的版本保持一致。
2. 编写对应的 `docs/发布记录-版本号.md`，提交源码。
3. 创建并推送版本标签，例如：

```powershell
git tag -a v2.4.1 -m "ICeClass 2.4.1"
git push --atomic origin main v2.4.1
```

示例中的版本号只作说明。标签必须指向要发布的源码，不能只更新标签而保留旧的项目版本；工作流会检查两端、npm 与锁文件的版本，以及实际构建的提交。

## 工作流做什么

- 使用 Windows runner，按源码的 `global.json` 安装 .NET SDK，并安装 Python 3.12 和 Node.js 22。
- 运行自动发布检查、Python 服务端检查、TypeScript 检查、旧 Cloudflare 检查、教室端核心检查和 Windows 教师端检查。
- 复用现有打包脚本，生成教室端、教师端、完整 Windows 和服务端四个 ZIP。
- 检查 ZIP、更新清单、客户端 SHA256，并在隔离进程中启动解压后的服务端，防止漏装模块。
- 生成版本化的 Ubuntu 更新脚本和 SHA256 校验文件。
- 先创建草稿、上传六个附件，再核对 GitHub 返回的文件大小与 SHA256，全部正确后才公开发布。失败时保留草稿，可重跑恢复。

已有公开 Release 和手工草稿不会被覆盖；需要更正已发布的程序时使用新的版本标签。补发较旧版本不会把较新版本的 Latest 标记降回旧版。

原生窗口、早读 WebView2 全屏、真实麦克风、教室触控与实体大屏仍按本地和现场验收流程验证，不能用云端构建通过替代。

## 补发已有标签

在 GitHub 仓库打开 **Actions → Publish release → Run workflow**，工作流分支选择 `main`，`tag` 填写已有标签，例如 `v2.4.0`。

这适用于创建工作流之前已经存在的标签。工作流工具与待发布源码分别检出，始终构建该标签对应的源码；无需移动或删除旧标签。

## 权限与线上部署

构建任务只有仓库读取权限；发布任务通过 GitHub 自带的 `GITHUB_TOKEN` 获取 `contents: write`，不需要额外保存个人访问令牌。使用的官方 Actions 固定到具体提交。

GitHub Release 提供版本记录和安装附件。学校平台、正式下载和客户端自动更新源仍由管理员部署；本工作流不连接学校服务器。教室端从学校服务器检查更新，不从 GitHub Releases 直接升级。
