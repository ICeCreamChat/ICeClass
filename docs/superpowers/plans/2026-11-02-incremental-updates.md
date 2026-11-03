# Incremental Updates Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 两端只下载变化内容，在不打断课堂、不牺牲语音体验的前提下更新。

**Architecture:** 共用文件级更新准备与MSDelta回建。保留完整离线EXE及旧接口；新计划采用精简EXE和可复用语音资源，更新就绪后下次启动安装。

**Tech Stack:** .NET 8、Avalonia、Windows MSDelta、Python/aiohttp、PowerShell。

**Spec:** ../specs/2026-11-02-incremental-updates-design.md

## Global Constraints

- 响应优先、离线包保留、两端更新、课间空闲下载、下次启动安装及主动立即更新。
- 不修改绑定、账号、配置、数据；不提交推送部署；版本升至2.5.2用于区分旧行为。
- 共用代码放Shared，客户端分别链接；发布脚本不包含凭据和本机运维文档。

## Review Focus

- 全量内嵌EXE第一次切换精简EXE时，所有语音文件必须就绪且能在断网后读取。
- 补丁来源、结果或payload错误时保留旧程序，不把错误输出标记已就绪。
- 关闭到托盘不视作重启，录音/早读/对话开始中止网络下载并保留片段。
- 跨平台路径大小写、ADS、保留名、链接路径拒绝，安装不得覆盖配置或数据。
- 安装中断和启动失败恢复全部变化文件，并保留本地验收endpoint/profile。

### Task 1: 更新协议与发布

- [x] 服务端计划/payload授权、Range、路径与长度测试先红后绿。
- [x] 新增server/update_payloads.py，两端plan/payload端点，保留原接口响应。
- [x] 脚本构建full/core，内容寻址payload和可选上一版MSDelta差分，真实回建测试。

### Task 2: 共用更新准备与安装

- [x] 新增tests/UpdateChecks独立行为测试，先见未变资源、差分与校验失败。
- [x] Shared/IncrementalUpdates.cs负责计划、同源、断点、文件/补丁SHA与暂存。
- [x] Shared/WindowsDelta.cs薄封装ApplyDeltaW，Shared/UpdateInstaller.cs负责pending及回退。
- [x] Receiver/VoiceResourceFiles.cs支持嵌入或EXE旁VoiceResources，准备时可复用嵌入资源。

### Task 3: 两端集成与时机

- [x] ReceiverUpdateService/DesktopUpdates接新计划且保留legacy下载API供过渡。
- [x] 两端启动前应用pending；下载完成不退出，托盘/原更新入口提供主动安装。
- [x] 根据课表和实际活动暂停下载；教师端有页面可见/交互活动时延后后台更新。
- [x] 构建、暂停/就绪/重启测试和必要局部UI检查。

### Task 4: 内存与完整验收

- [x] 先测旧版语音待机，消除有证据的重复分配，保留已预热识别/播报与音频缓冲。
- [x] 语音、更新、服务端回归及安装回退测试；发布产物离线读取验证。
- [x] 汇总实际资源复用、差分大小、内存/响应测量限制，打开最新本地客户端供验收。

用户已在六项选择后明确要求开始实施，本轮不重复请求实施许可。

## 执行记录（2026-11-02）

独立审查的两项问题已修复并补回归：教师端未保存课表时采用年级有效默认，合法无课日允许更新；过期下载计划会重新检查，保留相同内容的续传文件。真实 Windows PowerShell 5.1 安装测试先复现文件替换与恢复日志解析失败，修正后 14 个场景全部通过。

完整结果、产物和测量限制见 [2.5.2 本地验收记录](../../本地验收-2.5.2.md)。代码与发布包仅在本地，保持未提交、未推送、未部署。
