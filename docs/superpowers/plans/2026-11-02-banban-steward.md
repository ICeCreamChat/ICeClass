# 班班统一管家 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded independent implementation and review. Steps use checkbox syntax. Current user authorization covers local implementation and acceptance; do not commit, push, or deploy.

**Goal:** 让教师端的功能声明自动成为班班的能力，并补齐现有业务与本机操作流程。

**Architecture:** 在业务路由注册时附加能力元数据，班班运行时读取统一目录并复用原处理器。教师端原生操作使用当前窗口报告的受限能力和执行回执；界面沿用原确认卡。

**Tech Stack:** Python/aiohttp、原生 JavaScript、Avalonia/.NET 8、WebView2，无新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-02-banban-steward-design.md`

## Global Constraints

- 保留账号、密码、班级绑定、历史记录和本地设置。
- 本轮不提交、推送或部署线上。
- 重要修改先确认，结果以实际业务回执为准。
- 原文件不交给模型、不存进聊天或操作历史。
- 不向正式班级发送消息，不发真实反馈邮件。
- 沿用现有浅蓝主题和紧凑确认卡。

## Review Focus

- 新增功能已注册但工具仍沿用旧清单：用运行时注册的测试功能验证发现及实际执行。
- 账号撤权或班级改绑发生在确认前：实际处理器重新检查并拒绝执行。
- 历史操作重载、重复轮询或重复确认：不重复发送或执行。
- 导入/导出文件及凭据泄露到模型：只返回预览、文件元数据或需登录的同源下载链接。
- 普通浏览器、旧客户端或本机窗口关闭：明确不可用或结果未确认，不谎报成功。

### Task 1: 统一功能注册与运行时发现

**Files:** Create `Server/teacher_capabilities.py`, `Server/test_teacher_capabilities.py`; modify `Server/banban_operations.py`, `Server/banban_agent.py`.

**Interfaces:** 功能路由注册元数据包含编号、名称、方法、路径、字段、目标、权限及确认规则；目录从当前 app 读取。保留已有操作编号与工具名，工具枚举在调用时生成。

- [x] 先添加测试：新注册测试路由自动出现在目录、工具枚举中，实际执行且仅执行一次；未声明接口覆盖检查失败。
- [x] 运行测试确认失败，完成注册、查询和执行接入，再运行新测试与原班班操作回归。

### Task 2: 补齐教师端业务能力

**Files:** Modify `Server/app.py`, `Server/island.py`, `Server/reading.py`, `Server/management.py`, `Server/ideas.py`; add focused functional tests.

**Interfaces:** 通过 Task 1 的注册函数将元数据与原路由一起声明；无需修改班班清单。查询响应只包含权限内数据。

- [x] 测试创意查询/评审、版本冲突、非超级管理员拒绝；学校默认规则、绑定码和导出流程。
- [x] 将旧 18 项操作迁到对应路由的声明处，补齐缺失动作；验证实际处理器、权限和确认流程。
- [x] 导入文件由确认卡选择，调用原导入预览，再核对保存；下载结果提供同源链接。

### Task 3: 教师端原生功能桥

**Files:** Create `Desktop/TeacherActions.cs`, `Desktop/teacher-actions.js`; modify `Desktop/DesktopWindow.cs`, `Desktop/ICeClass.Desktop.csproj`; add native/JavaScript bridge checks.

**Interfaces:** `window.ICeClassTeacherHost.catalog()` 返回当前可用能力数组；`execute(action,payload,operationId)` 返回 `{success,verified,detail,...}`。宿主消息限定学校同源、当前已登录窗口和注册动作；重复 operationId 复用结果。

- [x] 测试同源、动作字段、登出、未知命令与重复命令。
- [x] 将设置、刷新、关于、反馈、更新检查接到现有方法；共享动作元数据与真实执行逻辑。
- [x] 以“已打开”与“已保存”区分回执；不自动发送邮件或安装重启。

### Task 4: 对话与确认卡贯通

**Files:** Modify `Server/banban_agent.py`, `Server/banban_operations.py`, `web_controller/banban.js`, `web_controller/banban-operations.js`, `web_controller/banban-operations.css`; add flow tests.

**Interfaces:** 对话携带实际客户端能力；本机操作只在当前实时任务中执行，执行回执由当前账号提交。动态目录始终由功能声明生成。

- [x] 测试新能力无需修改工具清单、确认后连续任务、当前客户端缺少能力、历史恢复不执行、重复事件不重发。
- [x] 增加文件选择/下载和本机动作必要控件，保持原主题、键盘操作和紧凑排版。
- [x] 应用 Impeccable 与 Web Interface Guidelines 检查本次 UI 改动。

### Task 5: 验证、交付与续接规范

**Files:** Update `AGENTS.md` 本地约定与相关开发文档；测试证据保存在忽略的 `output/banban-steward-20261102/`。

- [x] 跑服务器关键回归、前端行为测试、教师端构建与桥检查。
- [x] 用本机有效 DeepSeek 配置和虚构数据验证新功能发现、查询、确认、执行、连续步骤；不打印密钥。
- [x] 独立复核权限、泄露、重复执行与遗漏功能；修复实际问题。
- [ ] 打开最新本地教师端及班班入口，保留现有登录资料和数据，让用户验收。

## Execution ledger

2026-11-02：用户已明确要求立即实现。沿用当前干净的 codex 功能分支和共享工作区；不建立需要额外同步安装资料的工作树，不提交或部署。主代理承担统一注册和跨层集成，独立代理处理原生桥及范围明确的复核。

2026-11-02 完成实现与独立复核：动态目录包含 28 项业务动作、15 项查询和 6 处明确的人工入口。原有 18 项操作编号保留，删除重复的 BUSINESS/READS 清单和相应无用引用；仍被发布迁移使用的 cloud 目录及明确保留的素材不删除。

最终回归：112 项服务端测试通过；25 项新增前端行为测试、39 项 JS 桥断言及 77 项原前端回归通过。原生检查 97 项、真实 WebView2 检查 25 项、原有桌面检查 199 项通过，最终教师端已 publish。DeepSeek 的 3 个隔离场景通过，其中原生回执明确为模拟；真实网页已验证“打开创意计划”，未修改该创意内容。

独立复核后的修复：确认预览和浮岛配置读取保留完整 201 条调课；指定班级导出实际应用筛选且拒绝冲突；本机等待时间与 JS 桥对齐为 90 秒，允许期限内第一次迟到回执但不覆盖已有回执；需要确认的新本机动作在当前对话中收到新的实时执行事件，历史与轮询不执行。最后一项已先复现失败，再修复通过。

本地验收限制：原生教师端自动启动被自动审批拒绝，原因为 `blocked by policy`，未重试或绕过。最新构建和保留原验收资料的手动启动入口位于 `output/banban-steward-20261102/`。浏览器本地验收已完成；上方原生自动打开步骤保持未勾选。

清理限制：已确认的 40 个旧缓存/测试日志约 1 MB，自动删除同样被审批拒绝，实际删除文件数为 0；清单在 `output/banban-steward-20261102/cleanup.json`。用户数据、绑定、设置、构建依赖和现用发行包均保留。
