# 通知提示音 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重要、紧急通知先响短提示音再播放原正文；普通通知静音，班班日常对话不响提示音。

**Architecture:** 内置已试听的两段 WAV，用 NAudio 的采样接口将提示音、0.2 秒停顿和正文串接为一次播放。通知级别只在通知入口选择；原有对话和课表调用默认不加前奏，取消沿用现有播放代次和音频取消令牌。

**Tech Stack:** .NET 8、Avalonia、现有 NAudio 2.2.1 与班班内置神经语音。

**Spec:** `docs/superpowers/specs/2026-10-29-notification-chime-design.md`

## Global Constraints

- 不新增依赖、模型、设置项或云请求。
- 本地验收；不提交、推送或正式部署，保留私有绑定、连接与历史。
- 两段提示音固定节奏；正文语速音量、录音原声及通知优先级保留。

## Review Focus

- 普通通知即使有音量字段仍须完全静音。
- 默认对话与提醒不能误响提示音。
- 提示音期间关闭或被抢占后，旧正文不能开始播放。
- 录音不同采样率下前奏重采样，正文不能变调或丢失。
- 连续读正文或重复停止不能重复前奏或复活旧声音。

## Task 1: 前奏与真实播放

**Files:** 新增 `Receiver/NotificationChime.cs`、两段 `Receiver/Assets/Sounds/notification-*.wav`；修改 `Receiver.csproj`、`BanbanNeuralSpeech.cs`、`SpeechService.cs`、`AudioPlaybackService.cs`、`CloudReceiverService.cs`；扩展 `NotificationVoiceChecks.cs`。

**Interfaces:** `NotificationChime.ForLevel(string)` 选择通知前奏，`NotificationChime.Prepend(ISampleProvider, NotificationCue)` 返回一次连续音频；原播报调用默认 `NotificationCue.None`。

- [x] 先运行缺少提示音实现时失败的检查，保留失败日志。
- [x] 复用试听 WAV，实现通知选择和前奏；语音对话与提醒保持默认无前奏。
- [x] 检查各采样率、0.2 秒停顿、正文逐样本保留及单次前奏；通过真实通知、停止与抢占检查。
- [x] 回归原神经语音与教室核心检查；只报告实际结果。

## Task 2: 本地候选交付

**Files:** 更新现有语音说明、发布记录、验收报告及打包说明；重建本地教室端和四种候选包。

- [ ] 更新说明与本轮证据，保留既有未通过项目。
- [ ] 发布并重新打包、校验四包，同步本地候选与用户审查目录，核对私有数据未变。
- [ ] 启动最新候选，打开通知预览入口供用户试听。

用户已要求直接完整操作，按当前会话继续执行，不另加计划批准步骤。
