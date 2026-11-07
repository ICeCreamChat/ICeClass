# Homework Registration Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task. The user has authorized implementation; proceed in this session without another design approval. Do not commit or push.

**Goal:** 接入已确认的作业登记弹窗以及教师学期预设、名单和统计；按追加要求预留教室首页创意工坊格子。

**Architecture:** Python/aiohttp 服务以新增 SQLite 表保存班级配置和登记；WebView2 原生宿主仅向同源教室专属接口注入设备凭证。教师网页复用当前登录、班级范围、导航和共享样式。

**Tech Stack:** Python 3 / aiohttp / SQLite，Avalonia 11 / .NET 8 / WebView2，原生 JavaScript/CSS。

**Spec:** `docs/作业统计.md`；独立样板位于用户已确认的 visualizations 目录。

## Global Constraints

- 保留已提供的 51 人姓名和顺序；真实姓名仅写本地班级数据。
- 不新增依赖；不触碰线上；不提交或推送。
- 沿用现有字体和白蓝风格；修改范围为作业统计及创意工坊首页占位，创意作品功能另行实现。
- 已有六项未提交修改保留。在当前指定目录创建 `codex/homework-registration` 分支工作，不移动或重置用户文件。

## Review Focus

- 设备被改绑或停用：旧窗口不能读写原班或新班数据。
- 两台电脑同时登记：后保存者看到冲突，原记录不丢失。
- 名单或作业项目修改：当前草稿必须重新核对，历史统计分母保持快照。
- 网络失败与关窗：未保存勾选保留，不能假装已生效。
- 任课/班主任/上级与其他班：读取和修改均以现有范围授权。

## Task 1: 数据、权限、统计接口

**Files:** `server/homework.py`、`server/app.py`、`server/test_homework.py`。

**Interfaces:** 依 spec 提供配置、教室登记、分页报表和导出；JSON 字段采用当前项目 camelCase。profile 为 `{revision, value:{activeTermId,students:[{id,name}],terms:[{id,label,subjects:[{id,name,items:[{id,name,active}]}]}]}}`。登记保存稳定编号和可读名称快照。

- [x] 编写并运行失败测试：未配置名单、设备绑定隔离、全选未保存、独立项目、无作业、补交、版本冲突、名单变更、历史保留、教师越权、导出和日期校验。
- [x] 实现新增表和实际处理器；事务保存，已有表不改变；声明教师能力。
- [x] 运行新增测试、用户权限及教师路由发现检查。

## Task 2: 教室弹窗与原生入口

**Files:** `web_controller/homework/`、`Receiver/HomeworkManagementWindow.cs`、`Receiver/StudentVoiceWindow.cs`、`Receiver/App.axaml.cs`；必要的原生/UI 检查。

**Consumes:** Task 1 的设备 API。**Produces:** 班级管理窗口和与已确认样板相同的作业登记模态弹窗。

- [x] 将样板的数据读写改为真实请求，移除样板身份切换、重置及 localStorage；增加读取、保存失败和冲突反馈。
- [x] 原生复用 ReadingBrowser，限制同源主文档和 API 凭证范围、禁用下载/外部导航/设备权限；关闭前让页面处理未保存内容。
- [x] 首页增加班级管理卡片，单例打开，改绑和退出时释放窗口；不改变早读、录音、班班等功能。
- [x] 构建并检查本地加载、入口、登记弹窗和默认名单。
- [x] 实窗登记保存、补交、无作业、重开、关闭确认、断网与窄窗口；检查名单空格操作和焦点。
- [x] 首页增加创意工坊占位卡片及禁用“筹备中”按钮，实窗检查双列和最窄单列布局。

## Task 3: 教师预设及统计

**Files:** `web_controller/homework-admin.js`、`web_controller/homework-admin.css`、`web_controller/index.html`。

**Consumes:** Task 1 的教师 API。**Produces:** 可导航的作业统计页面、配置编辑及报表。

- [x] 使用现有 api/state/班级范围，添加作业统计入口和导航离开保护。
- [x] 实现按学期作业项目、名单维护和新增学期；管理权限只控制显示，后端仍强制校验。
- [x] 实现日期/学科/班级/学期筛选、作业与学生汇总、分页及 CSV 导出。
- [x] 检查教师名单预设保存、导航提醒、登记及补交后的报表；在 390 像素宽度检查页面溢出及 Enter 切换统计，不修改公共 React 配置（项目不是 React）。

## Task 4: 本地验收与复核

**Files:** 本功能文档、隔离本地验收启动配置；不写真实凭据。

- [x] 构建两端，运行作业及路由相关 22 项检查、服务端全量回归 516 项；全部通过。
- [x] 独立本机测试库中导入用户提供的高一（9）班名单；其他班保持空名单。
- [x] 用最新原生教室端和教师网页走完登记、补交、无作业、重开、冲突、断网核对及未保存提醒关键路径；具体结果和未完成的托盘宿主实测记入规格文档。
- [x] 按 executing-plans 使用一次独立最终代码复核；修复跨班草稿、历史快照、正常退出保护、班班下载声明及学科状态计数问题。
- [x] 最后打开使用最新构建的教室首页、作业弹窗和教师统计页面交由用户验收，保留隔离服务，不触及原绑定。
