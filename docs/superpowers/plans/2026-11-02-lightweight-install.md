# 轻量安装与语音资源准备 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两端提供轻量安装、空闲自动/手动语音补齐及完整离线安装包。
**Architecture:** 共享资源目录与现有可靠传输，分别接入两端现有活动监控和原生界面；服务器从既有发布资源提供公开校验下载。
**Tech Stack:** .NET 8 / Avalonia / Python aiohttp / PowerShell；不新增依赖。
**Spec:** docs/superpowers/specs/2026-11-02-lightweight-install-design.md

## Global Constraints

- 保留未提交源码、绑定、配置和数据；在当前已有工作分支继续，不移动既有修改，不提交或推送。
- 共享字体/控件遵循 AGENTS.md；不添加装饰方向箭头。
- 自动遵循课堂规则；手动绕过课时等待但服从实际语音活动。
- 资源补齐不生成程序待安装记录；已校验资源复用；不新增下载框架或依赖。

## Review Focus

- 核心包没有模型时启动和通知状态仍正确，缺资源不会被报成麦克风故障。
- 下载和程序更新不能相互覆盖或丢失断点；退出或改绑取消旧传输。
- 旧教师缓存与完整离线资源都能使用，无法访问外部模型站不影响学校内下载。
- 服务器不会通过公开语音入口泄露程序、任意文件或设备身份。
- 窄窗、键盘、失败重试和就绪状态与实际资源一致。

### Task 1: 共享语音资源与公开 payload

**Files:** Shared/VoiceResources.cs, Shared/IncrementalUpdates.cs, server/update_payloads.py, tests/UpdateChecks/VoiceResourceChecks.cs, server/test_update_payloads.py
**Interfaces:** VoiceResources 读取内置清单，检查并下载资源；复用 IncrementalUpdates.DownloadAsync。公开 /api/voice/resources/{sha256} 只服务语音文件。
- [x] 添加并运行断线续传、已校验复用、路径/哈希和公开语音隔离失败测试。
- [x] 实现共享服务、发布清单和路由，运行上述检查至通过。

### Task 2: 两端后台策略、能力状态与界面

**Files:** Receiver/App*.cs, Receiver/EnrollmentWindow.cs, Receiver/VoiceResourceFiles.cs, Receiver/BanbanVoiceService.cs, Desktop/DesktopWindow*.cs, Desktop/ClassroomVoiceTranscriber.cs, Receiver/VoiceResourcesView.cs, 两端 csproj
**Interfaces:** 共享服务向原生资源面板报告状态；两端现有活动门控制开始和取消。
- [x] 为自动/手动暂停、资源缺失状态和缓存复用添加行为检查，观察失败。
- [x] 接入后台/手动资源补齐、完成后启用语音及转文字入口；资源补齐在设置内使用单一下载操作。
- [x] 检查并修复正常/窄窗、键盘及相关状态；运行两端检查。

### Task 3: 轻量/完整交付与本地验收

**Files:** scripts/package-release.ps1, scripts/prepare-delivery.ps1, scripts/install-desktop.ps1, server 下载路由, web 下载入口, docs/客户端更新说明.md, 相关打包测试
**Interfaces:** 默认轻量 ZIP 与额外 offline ZIP；教师 offline ZIP 包含受校验的 ASR 文件，轻量包无需模型即可安装。
- [x] 添加实际发布物与安装资源校验测试并观察失败。
- [x] 生成两端最新构建和四种 ZIP，校验内容、体积和资源完整性。
- [x] 完成相关测试、独立代码复查与最新本地两端验收；记录实际结果和未验证场景。

本地交付已完成，结果及边界见 `output/lightweight-install-20261102/验收报告.md`。两端验收界面已实际打开；教室端手动下载已完成，教师端已校验并复用旧缓存。未执行用户正式目录的完整安装器或现场音频硬件验收；未提交、推送或部署。
