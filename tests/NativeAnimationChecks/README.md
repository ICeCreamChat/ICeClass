# 原生动画排查记录（2026-11-02）

2026-11-03 晚间续接：2.5.8 现场日志再次确认 Windows 动画关闭。“关于”鞠躬和原生语音班班仍保留独立的旧系统开关拦截，本轮已复现并修正；通知人物、通知条的控件默认值也统一为开启，浮岛的手动关闭设置继续有效。模拟系统动画关闭的 16 项回归、两种渲染模式各 35 项、教师程序集的关于页 15 项均通过。详细范围、其余检查及现场验证边界见 [本轮动画检查记录](../../docs/动画检查记录-2026-11-03.md)。本轮为本地修复，尚未发布；下方保留早期历史证据，不代表当前实现。

2026-11-03 续接：高一（17）班的 2.5.6 现场日志已确认 Windows 动画关闭，触发通知静态显示。用户随后要求默认开启；已正式发布的教室端 2.5.7 由独立的浮岛动画设置控制，默认开启，手动关闭可保留静态显示。最终默认套件包含新增的 16 项动画设置回归，共 35 项通过；生命周期 6 项通过。命令可加 `--island-motion` 单独运行或加 `--preview --island-motion` 打开本机隔离预览。详情见 [2.5.7 记录](../../docs/发布记录-2.5.7.md)。以下为原始排查记录，保留当时的证据和验证边界。

结论：尚未确认学校 Windows 10 电脑的现场根因，未修改生产动画代码。首要候选是 Windows 关闭了客户端区域动画，置信度为**中等、待现场取值**；不能仅凭两张静态截图断定动画丢失，也不能归因于 Windows 10 不支持动画。

本轮只新增本目录的项目、程序、本文，以及 `scripts/diagnose-native-animation.ps1`。未改动用户限定的禁改文件、原有未提交工作、系统动效设置、已安装客户端的绑定或资料；未提交、推送、部署或发送真实班级通知。

## 源码证据

- `Receiver/IslandBanbanMascot.cs` 确实有逐层绘制的跑动、拉岛条、眨眼、呼吸和举喇叭动画，靠 `RequestAnimationFrame` 持续 `InvalidateVisual()`；不是依赖浏览器、GIF 解码或视频播放的动画。`Animate` 初值取自系统动效偏好，关闭时使用固定姿态。
- `Receiver/IslandShoutCompanion.cs` 通过同类回调推进弹簧、透明度和宽度。`SetActive(..., animate: false)` 会立即显示班班、展开岛条，停止连续动画。这条现有分支能复现“角色还在，动作没有”的状态。
- `Receiver/AboutThankYouMascot.cs` 是真实的 8 帧鞠躬动画，使用 30 Hz `DispatcherTimer`，播放约 **2.4 秒**后主动回到第 0 帧。打开致谢页、点击或键盘激活角色可重播；隐藏、最小化、切换许可页、关闭都会停止。超过 2.4 秒的静止画面是既有设计。
- 两处共同经过 `Receiver/DesktopStyle.cs` 的 `SPI_GETCLIENTAREAANIMATION`（`0x1042`）判断。Windows 返回 false 时均可保持静态；查询失败时源码反而允许动画，不会因为查询失败而关闭。`UIEffects`、透明效果和远程会话不是这条函数额外使用的开关。
- 喊话角色在构造时保存 `Animate`，关于页在播放时重新查询；排查中应记录同一用户会话的实际值和程序启动时机，不能假定系统设置改变后所有已创建控件都会自动更新。
- `ClassroomIslandWindow.Opened` 已调用角色和伴随布局的 `ResumeAnimation()`。检查了隐藏后重新显示及重播，未复现动画队列卡死。没有根据推测替换计时器或增加软件渲染强制开关到正式客户端。

以上关键源文件以及 `ClassroomIslandReveal.cs`、`ClassroomIslandWindow.cs`、`Program.cs` 与本地 `v2.5.2` 标签比较无差异。本轮诊断构建仍使用 Receiver 2.5.2 / Avalonia 11.2.5。发布脚本为自带运行时的 win-x64 构建；学校缺少 SDK 本身不能解释这些原生动画缺失。

参考原始资料：[Microsoft 对系统动效标志的定义](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-systemparametersinfow)、[Avalonia 11.2.5 的帧回调](https://github.com/AvaloniaUI/Avalonia/blob/11.2.5/src/Avalonia.Controls/TopLevel.cs)、[计时器](https://github.com/AvaloniaUI/Avalonia/blob/11.2.5/src/Avalonia.Base/Threading/DispatcherTimer.cs)、[Windows 渲染模式及既有软件回退](https://github.com/AvaloniaUI/Avalonia/blob/11.2.5/src/Windows/Avalonia.Win32/Win32PlatformOptions.cs)。

## 本轮实际验证

环境为本机 Windows 11 build 26200、x64、.NET 8.0.31、显示缩放 150%。系统查询成功，`ClientAreaAnimationEnabled=true`、`UIEffectsEnabled=true`、DWM 合成开启、`SM_REMOTESESSION=false`。显卡包括 RTX 4060 Laptop GPU 和 GameViewer 虚拟显示适配器；这不代表学校电脑的环境。

- 独立项目构建成功，0 警告、0 错误。只使用生产展示控件和资源，不运行 Receiver 主入口或 App 的服务初始化，不启动语音、网络、绑定或配置存储。
- 默认渲染：**19/19 通过**。关于页采到第 0–7 帧及 15 次场景更新；普通/重要/紧急喊话分别记录 324/389/384 次场景更新。
- 强制软件渲染：**19/19 通过**。关于页同样采到第 0–7 帧及 15 次场景更新；普通/重要/紧急喊话分别记录 88/116/122 次场景更新。次数只是本次观察值，不是性能阈值或截图基线。
- 检查覆盖自动播放、重播、隐藏/最小化/恢复、页签切换、关闭释放计时器、喊话拉伸的中间宽度、停止后的静止、减少动效时立即显示，以及重新显示后的恢复。
- 验证期间没有用固定时间姿态、主动调用 `Advance`、离屏渲染或额外 `InvalidateVisual` 来假装动画已工作。统计的是实际原生窗口的计时器状态、动画回调和场景更新。独立的单次帧回调探针完成后才开始角色循环检查。
- “减少动效”的喊话检查仅在**测试控件**上设 `Animate=false`；本机没有关闭 Windows 全局动画，因此关于页在真实系统动效关闭时的分支尚未实机验证。这里没有已确认缺陷对应的红绿回归测试，也没有宣称修复学校问题。
- 本地实际窗口已打开，已通过 Computer Use 观察关于页从站立到鞠躬，并验证空格键重播。隔离的喊话预览窗口也已保留供人工验收。未将离屏采样当作学校硬件验收。
- 只读环境脚本在 PowerShell 7 和 Windows PowerShell 5.1 均执行成功；PowerShell 解析检查通过。

结果在忽略目录：`output/native-animation-default/checks.json`、`output/native-animation-software/checks.json`、`output/native-animation-environment.json`。场景更新能证明应用提交了新画面，不能单独证明学校 GPU、远程显示软件或实际大屏正确呈现了这些画面。

## 复现命令

在 `D:\ICeCoding\ICeClass` 执行。测试输出与中间产物放到独立的 `output/native-animation-build`，避免覆盖其他任务的构建。测试不嵌入语音模型，不涉及语音能力。

```powershell
& '.\.tools\desktop-sdk\runtime\dotnet.exe' build tests/NativeAnimationChecks/NativeAnimationChecks.csproj --artifacts-path output/native-animation-build -p:EmbedVoiceResources=false --nologo -v:minimal
$animationCheck = 'D:\ICeCoding\ICeClass\output\native-animation-build\bin\NativeAnimationChecks\debug\ICeClass.ReceiverOfflineChecks.exe'
& $animationCheck output/native-animation-default
& $animationCheck --software output/native-animation-software
& '.\scripts\diagnose-native-animation.ps1'
powershell.exe -NoProfile -File scripts/diagnose-native-animation.ps1
& $animationCheck --preview
```

独立项目沿用已存在的 `ICeClass.ReceiverOfflineChecks` 友元程序集名以访问内部展示控件，不修改生产程序集声明，也不加载现有测试程序的入口。

## 学校现场仍缺的证据

在出问题的同一 Windows 用户会话运行只读脚本，保留 `ClientAreaAnimationQuerySucceeded`、`ClientAreaAnimationEnabled`、OS build、显卡驱动、DWM 和远程会话结果；该脚本不读取客户端设置、账号、密钥或班级资料，不改系统设置。

- 若 `ClientAreaAnimationQuerySucceeded=true` 且 `ClientAreaAnimationEnabled=false`，就确认了能够同时抑制两处动画的现有系统策略分支；应先向现场核实是否有意关闭动效，不在客户端代码里擅自绕过。
- 若该值为 true，需在学校的**隔离原生诊断程序**对照默认与 `--software`，同时观察关于页点击后前 2.4 秒和喊话进入时前 3 秒。只读脚本可直接单独运行；本轮测试 EXE 为依赖 .NET 8 的本地构建，尚未制成供无运行时电脑使用的独立诊断包。
- 若计时器和场景更新正常、实屏仍静止，应继续核对实际安装文件是否与所报 2.5.2 一致、显示驱动、合成及远程显示链路；若软件渲染单独恢复，才有依据进一步定位硬件渲染。当前本机的两个渲染路径均正常，不能据此排除学校硬件问题。

学校的有效系统开关、确切 Windows 10 build、客户端文件一致性、显卡驱动和真实显示行为本轮均未取得，故没有基于猜测提交生产补丁。
