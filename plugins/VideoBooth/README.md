# 视频展台

ICeClass 创意工坊的独立 Windows 插件。准备时使用工作台，展示时切换为置顶浮窗；支持电脑、USB 和手机采集。窗口与页面为新实现，必要的媒体传输代码来源见 [NOTICE.md](NOTICE.md)。

## 使用

在教室端创意工坊导入对应架构的 `ICeClass-VideoBooth-win-x64.zip` 或 `win-x86.zip`，启用后打开。选择来源并主动开始采集；打开窗口本身不启动摄像头或手机准备。

点击“AI 点评”后固定作答，与 WPS 当前题目一并分析，结果简短展示；点击“继续展示”恢复。AI 由宿主管理，使用当前班班连接和设备额度，模型需支持图片。独立打开可验收展示，AI 需要从创意工坊启动。

手机选择后按需准备连接并扫码。辅助准备依赖随包公共服务配置与实际网络；电脑及 USB 摄像头可离线使用。真实手机连接、证书和识别效果需要在课堂设备上验收。

## 构建

本目录使用 .NET 10 SDK，宿主继续使用 .NET 8。无需引用原 VideoBooth 工作区。于本目录运行：

```powershell
dotnet build ICeClass.VideoBooth.csproj
dotnet run --project tests/NativeChecks/ICeClass.VideoBooth.NativeChecks.csproj
```

摄像头授权回归使用 `dotnet run --project tests/NativeChecks/ICeClass.VideoBooth.NativeChecks.csproj -- --camera-permission`。检查使用隔离资料和模拟摄像头硬件，保留真实 WebView2 授权事件，覆盖独立窗口、宿主模式与旧拒绝记录恢复；不能代替实际摄像头验收。开发机未安装 WebView2 时，将 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 设为固定运行时的 Windows 绝对路径。

在仓库根目录使用 PowerShell 7+ 运行打包脚本，并指定 .NET 10 SDK 可执行文件和各架构的完整固定 WebView2 目录：

```powershell
./scripts/package-video-booth-plugin.ps1 -Dotnet <dotnet.exe> -BrowserX64 <x64浏览器目录> -BrowserX86 <x86浏览器目录>
```

默认生成双架构自包含插件；可用 `-Runtime win-x64` 单独构建。输出目录必须为新目录。包中保留完整固定浏览器、NOTICE、licenses 和公共服务配置，不包含配对、证书私钥、账号、设置或缓存。

资料默认保存在 `%LOCALAPPDATA%/ICeClass/Receiver/VideoBooth/data`，可用 `--data` 指定隔离目录。规范化资料目录有进程互斥；旧展台资料不会自动读取或迁移。协议、安装及数学点评维护方法见仓库的 `docs/视频展台插件.md`。
