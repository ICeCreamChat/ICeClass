# 教室首页呼叫班班 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击首页“呼叫班班”后召出桌宠并立即收听。

**Architecture:** 首页单独接入现有 BanbanVoiceWindow.StartConversation，沿用后台 WebView 和本地语音服务。连接尚未就绪时保留一次呼叫，成功后消费，失败或用户暂停时清除。

**Tech Stack:** C#、Avalonia、WebView2、现有本地语音服务。

**Spec:** docs/superpowers/specs/2026-10-30-classroom-call-banban-design.md

## Global Constraints

- 保留现有样式、字号、绑定、数据与其他未提交改动。
- 不新增依赖；教师端不重启；不提交、推送或部署。
- 用户已批准立即实施，在当前工作区执行。

## Review Focus

- 首次关联完成前点击仍能进入收听，期间不展示聊天记录。
- 连续点击及退场后呼叫保持桌宠可见并进入新的收听会话。
- 语音暂停后点击可启用语音；暂停、注销和休眠清除待执行的呼叫。
- 连接失败显示可恢复的反馈，不在迟到的回执中意外开始收音。
- 正常与最窄窗口按钮文字完整，键盘可操作，原文字对话入口可用。

### Task 1: 首页呼叫和就绪衔接

**Files:** Receiver/StudentVoiceWindow.cs、Receiver/App.axaml.cs、Receiver/BanbanVoiceWindow.cs、Receiver/BanbanVoiceService.cs、Receiver/BanbanPetWindow.cs、tests/ReceiverOfflineChecks/BanbanCallReview.cs、tests/ReceiverOfflineChecks/Program.cs

**Interfaces:** 复用 BanbanVoiceWindow.StartConversation()；App.StartBanbanVoice 增加可选的立即收听参数，首页通过 CallBanban 传入。

- [x] 添加真实窗口的首次呼叫、重复呼叫、退场重呼叫和暂停重呼叫检查，确认旧实现失败。
- [x] 修改首页文案与回调；连接完成后消费呼叫，连接失败提供现有重连界面。
- [x] 验证真实窗口、麦克风、关联和收听状态，回归连续对话与退场。

### Task 2: 本地交付

- [x] 构建并发布教室端，在正常与最窄窗口检查入口、键盘操作和桌宠状态。
- [x] 将本轮构建更新到现有本地验收目录，保留设置与数据库，打开首页供用户验收。
- [x] 记录实际结果与未验证的部分，见 output/banban-call-20261030/acceptance.md。

## Execution Ledger

- 2026-10-30：用户已选择点击即收听并要求开始，直接在现有工作区执行，不重复请求设计或计划审批。
- Ruling: 新增 BanbanCallReview 复用现有真实 Avalonia/WebView 测试宿主，而不在后台音频恢复验收里叠加模式；避免与无关采音恢复检查耦合。
- Ruling: 实测初次关联先 authorized=false，班级列表完成后 authorized=true；首个否定回执保留呼叫，明确身份错误、注销、暂停、休眠清除呼叫。
- 只读复查发现并修复三处问题：已发生的连接错误需要保留恢复入口；待关联时需要保持桌宠展开；麦克风恢复冷却期中的呼叫要明确报错而不是一直准备。新增真实课堂状态、错误后呼叫和引擎冷却时钟检查，最终 17 项呼叫检查通过。独立复审未发现剩余重要缺陷。
