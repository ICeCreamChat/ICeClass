# ICeClass 班伴

面向教室大屏、教师、学生和学校管理员的班级伴学与管理平台。早读、课表浮岛、通知、作业登记、班班助手、视频展台和纸卡答题在同一套系统中协作，教室端保留离线展示与早读能力。

[学校平台](https://iceclass.icecreamchat.top/) · [下载教室端](https://iceclass.icecreamchat.top/api/client/download/classroom) · [下载教师端](https://iceclass.icecreamchat.top/api/client/download/teacher) · [GitHub Releases](https://github.com/ICeCreamChat/ICeClass/releases/latest)

由 ICeCreamChat 维护。项目采用[非商业学习参考许可](LICENSE)，运行、部署、修改和再分发等使用须另行取得书面授权。

## 当前版本

| 组件 | 源码版本 | 技术 |
| --- | --- | --- |
| Windows 教室端 | 2.5.17 | .NET 8 / Avalonia / WebView2 |
| Windows 教师端 | 2.5.17 | .NET 8 / Avalonia / WebView2 |
| 学校服务 | 2.5.11 | Python / aiohttp / SQLite / WebSocket |
| 视频展台插件 | 1.0.0 | .NET 10 / Windows Forms / WebView2 |

本仓库包含教室端创意工坊中的视频展台和纸卡答题。源码、Release 附件和学校服务器分别更新，公开下载入口以实际发布内容为准。

## 三端分工

| 入口 | 主要用途 | 运行环境 |
| --- | --- | --- |
| 网页工作台 | 教师与管理员维护班级、课表、通知、作业和权限 | 现代浏览器 |
| Windows 教师端 | 工作台，加桌面来音提醒、本机转文字和自动更新 | Windows 10/11 x64、WebView2 |
| Windows 教室端 | 教室绑定、离线早读、课表浮岛、留言、作业登记、班班和创意工坊 | Windows 10/11 x64、WebView2 |

发布的 Windows 程序自带 .NET 运行环境。教师与管理员使用学校账号登录，教室电脑使用独立设备绑定。

## 安装与首次使用

**教室端**：完整解压下载包，运行“安装或升级.cmd”，填写平台地址及学校提供的绑定码，读取并选择班级后绑定。在本机确认声音、麦克风与课表。新增班级、升班或管理员改绑后按平台信息同步，无需复制其他电脑的绑定资料。

**教师端**：完整解压下载包，运行“安装到本机.cmd”，使用学校账号登录。操作范围与网页权限一致，本机选项与语音资源在“桌面设置”管理。

两端关闭窗口后收起到托盘，托盘“退出”才结束程序。正常升级保留原有绑定、登录资料和设置。详见[完整操作流程](docs/完整操作流程.md)、[Windows 教师端](docs/Windows教师端.md)和[三端本地验收](docs/三端本地验收.md)。

## 视频展台与 AI 点评

视频展台是独立设计的 Windows 插件，提供完整工作台和置顶浮窗，支持电脑、USB 与手机摄像头。教室端在“创意工坊”导入本机 ZIP 包，安装后启用、打开；也可停止、禁用或卸载。

面向高一数学公开课，WPS 显示题目，展台展示学生纸面作答。老师主动点击“AI 点评”，固定本次作答与 WPS 题图，直接向全班显示简短、鼓励为主的反馈和 1-2 个知识点；题目不确定时请老师框选。

~~~mermaid
flowchart LR
    A[选择来源并展示作答] --> B[老师点击 AI 点评]
    B --> C[确定 WPS 放映窗口]
    C --> D[定格作答并读取题图]
    D --> E{题目能否确定}
    E -->|可以| F[显示正误、建议和知识点]
    E -->|不确定| G[老师框选本次题目]
    G --> F
    F --> H[老师点击继续展示]
    H --> A
~~~

- 使用该班唯一有效班主任选择的班班连接，模型需支持图片输入；首次受理分析计一次设备月度次数，同次框选续评不重复计次。
- 打开插件不会自动开启摄像头。普通视频展示不调用 AI，电脑与 USB 摄像头可离线展示；手机连接按需准备，依赖实际网络与证书配置。
- 题图、作答和点评仅在本次内存会话中保留；继续展示、停止、退出或身份变化后清空。插件不接收模型密钥或设备令牌。
- 当前源码包含摄像头授权及旧拒绝记录恢复修复。真实摄像头、手机、WPS 遮挡取图和模型数学准确率仍需在课堂设备上验收。

安装、额度、卸载保留资料、构建和验证见[视频展台插件](docs/视频展台插件.md)，工程见[plugins/VideoBooth](plugins/VideoBooth/README.md)。

## 纸卡答题与学生课堂分析

Windows 教室端 2.5.17 支持在 PPT 放映时用班班收答。单击屏幕边缘的班班，在圆环中点“开始课堂”。老师按课件选题型，学生举卡作答。点“结束收答”即可看到各选项的匿名人数分布，再继续下一题。

单选和判断各收一轮。多选逐项收答，使用教室相机时，切到下一项就会自动开始采集。收起班班会暂停，再次展开可从原项继续。教师可在工作台课前组题、课后查看学生作答。

班主任可批量发放学生编号和六位密码，打印带班级、卡号及使用说明的纸卡。学生在统一登录页选择“学生”，登录后可查看本人课堂分析、改密和补印。使用方法见[纸卡答题](docs/纸卡答题.md)。

## 早读陪伴与统计

教室端内置兔拔萝卜、诗词镌刻、粒子浮雕、火箭升空四种模式。断网可运行，统计先保存在本机，联网后补传。

开始早读后全屏展示，Esc 或白板空白处长按 2 秒退出全屏；返回教室首页才结束采音。学校设置比赛时段与声量门槛，班级按有效发声秒数累计，同班多设备不重复累计同一秒。支持使用情况、排名与 CSV 导出。

声量表示相对出声强度，早读检测不上传原始麦克风音频。详见[早读使用说明](docs/早读使用说明.md)。

## 课表浮岛与批量设置

教师端与网页维护周课表、作息、单双周、临时调课、值班、提醒与自动化，支持 Excel 导入导出；教室端同步后离线显示和运行。

批量设置可以勾选内容同步，或明确选择整套复制。未勾选内容保留各班设置，应用前可预览，版本冲突时重新核对。浮岛提供日期、倒数日、课表、轮播及课前、上下课提醒，并承载班级通知。

详见[课表与自动化](docs/教室岛课表与自动化.md)和[顶部浮岛](docs/教室端顶部悬浮岛.md)。

## 通知、来音与教室控制

- 文字和教师原声通知支持普通、重要、紧急等级，保留发送记录与人工知晓回执。
- 学生可向教师发送语音留言；教师端提示新来音，由教师主动收听或在本机转文字。
- 管理员在授权范围内查看设备在线状态、版本与音量，远程调节音量或打开早读；离线音量设置在重连后应用。
- 作业登记支持已交、未交、无作业状态、历史补交、名单快照与 CSV 导出。见[作业统计](docs/作业统计.md)。
- 创意计划收集班级意见和作品，按原有权限与附件保留规则管理。见[创意计划](docs/千人创意计划.md)。

## 班班助手与桌宠

班班复用学校或个人模型连接，在授权范围内查询与维护班级事务；修改等操作通过确认卡及实际处理结果反馈。教室端支持唤醒、对话、语音播报和受控电脑查看，使用本班有效班主任的连接。

超级管理员可设置教师和设备的默认及单独月度次数上限，按北京时间每月切换。晚自习管理复用浮岛课表和既有模型连接，本地筛选后限量复核，默认关闭，启用前完成告知授权。

详见[班班智能交互](docs/班班智能交互说明.md)、[功能接入](docs/班班功能接入.md)、[桌宠与响应速度](docs/班班桌宠与响应速度.md)和[晚自习管理](docs/晚自习管理.md)。

## 轻量安装与语音资源

轻量包先安装程序，语音资源在课间空闲时后台准备。文字通知、教师原声和来音播放可先使用；语音播报、唤醒和识别按各自资源状态就绪。

教室端从“教室设置 → 更新与测试 → 下载语音资源”，教师端从“桌面设置 → 语音资源”补齐当前客户端所需内容。支持暂停、继续、断点续传和校验复用，课堂活动优先。

集中拷贝可使用[完整语音资源教室包](https://iceclass.icecreamchat.top/api/client/download/classroom-offline)或[教师包](https://iceclass.icecreamchat.top/api/client/download/teacher-offline)。首次绑定、登录、学校同步及在线 AI 仍需联网。

## 后续更新

两端支持文件级增量更新，复用未变化文件，有适用且更小的差分补丁时优先使用。自动下载避开课堂活动，校验后在下次真正启动时安装；“立即更新”会退出旧程序并打开新版。

更新保留绑定、设置和本机数据，安装前校验大小与 SHA256，并提供失败恢复。旧版更新问题及维护方法见[客户端更新说明](docs/客户端更新说明.md)。

## 本地体验

运行 `.\start-preview.bat` 启动仅监听本机的演示服务，默认端口为 8837。新演示库带有虚构的名单、作业、早读、课表、纸卡报告、创意评审、通知和自习记录。后续启动补充当天样例并保留已有演示数据。

| 演示角色 | 用户名 | 密码 |
| --- | --- | --- |
| 超级管理员 | `ICe` | `LocalDemo2026` |
| 教师 | `teacher1` | `LocalTeacher2026` |
| 学生（高一（1）班 01 号卡） | `2610101` | `260001` |

这些账号仅用于演示库。需要在 Windows 教师端验收时，详见[三端本地验收](docs/三端本地验收.md)。

## 代码与开发

| 路径 | 职责 |
| --- | --- |
| `server/` | 完整学校服务、身份、业务、AI 与后台维护 |
| `web_controller/` | 原生 JavaScript / CSS 教师工作台、教室嵌入页和早读 |
| `Receiver/` | Windows 教室端与原生控件 |
| `Desktop/`、`Shared/` | Windows 教师端与共享更新、资源逻辑 |
| `plugins/VideoBooth/` | 独立视频展台工程、页面、传输内核及原生检查 |
| `cloud/migrations/` | 数据库结构 |
| `scripts/`、`tests/` | 构建、打包、部署和检查入口 |
| `workflows/` | 视频展台与数学点评的交互、身份和生命周期约定 |

主客户端 SDK 以根目录 global.json 为准，当前为 .NET 8；视频展台有自己的 global.json，使用 .NET 10。完整学校平台运行 server/，cloud/src/ 是旧通知服务参考实现。服务端要求 Python 3.10+，语音准备脚本要求 Python 3.11+；GitHub 构建使用 Python 3.12 与 Node.js 22。

安装开发依赖并检查：

~~~powershell
python -m pip install -r server/requirements.txt
python -m unittest discover -s server -p "test_*.py"
python -m unittest discover -s tests -p "test_*.py"

npm ci
npm run typecheck
npm test

dotnet run --project tests/ReceiverOfflineChecks/ReceiverOfflineChecks.csproj -c Release -p:EmbedVoiceResources=false
dotnet run --project tests/DesktopChecks/DesktopChecks.csproj -c Release
dotnet run --project tests/UpdateChecks -c Release
~~~

视频展台与宿主的聚焦回归：

~~~powershell
dotnet run --project tests/WorkshopChecks -c Release
dotnet run --project tests/MathReviewChecks -c Release
dotnet run --project tests/ReceiverOfflineChecks/ReceiverOfflineChecks.csproj -c Release -p:EmbedVoiceResources=false -- --workshop-checks
dotnet run --project tests/ReceiverOfflineChecks/ReceiverOfflineChecks.csproj -c Release -p:EmbedVoiceResources=false -- --math-dialog-checks
node --test scripts/test-workshop-ui.cjs scripts/test-video-booth-workbench.cjs
~~~

纸卡答题与学生账号的聚焦回归：

~~~powershell
node --test scripts/test-card-quiz-model.cjs scripts/test-card-quiz-scanner.cjs scripts/test-card-quiz-journal.cjs
node --test scripts/test-card-quiz-classroom.cjs scripts/test-card-quiz-phone.cjs scripts/test-card-quiz-admin.cjs
node --test scripts/test-student-accounts-ui.cjs scripts/test-student-accounts.cjs
dotnet run --project tests/CardQuizChecks -c Release
dotnet run --project tests/CardQuizServiceChecks -c Release
dotnet run --project tests/ReceiverOfflineChecks/ReceiverOfflineChecks.csproj -c Release -p:EmbedVoiceResources=false -- --card-quiz-wheel-checks output/card-quiz-wheel-checks
~~~

网页界面回归另需 Playwright 与 Microsoft Edge。插件的 .NET 10 构建、摄像头授权检查及固定浏览器要求见[插件工程说明](plugins/VideoBooth/README.md)。合成图片、模拟设备和模型契约检查不能代替真实硬件与模型效果验收；完整检查选择见[验收指南](docs/验收指南.md)。

## 构建与打包

在 Windows 仓库根目录运行。视频展台的打包与包校验脚本使用 PowerShell 7+：

~~~powershell
.\build.bat
.\build-desktop.bat
.\package-release.bat
~~~

| 产物 | 内容 |
| --- | --- |
| `dist/receiver/` | 含完整语音资源的教室端 |
| `dist/receiver-core/` | 轻量教室核心与增量更新用程序 |
| `dist/desktop/` | Windows 教师端 |
| `dist/release/` | 客户端、Windows 完整交付与服务端 ZIP |

构建校验语音资源，模型二进制不进入 Git。打包默认重新构建两端，复用已验收产物时使用 scripts/package-release.ps1 的 -SkipBuild。插件单独通过 scripts/package-video-booth-plugin.ps1 生成 x64 / x86 ZIP，需显式提供 .NET 10 SDK 与对应架构的完整固定 WebView2 目录。

GitHub Actions 的 **Publish release** 在推送 v* 标签或手动运行时检查、构建和发布；普通分支推送只更新源码。发布步骤见[GitHub 自动发布](docs/GitHub自动发布.md)。

## 部署与维护

学校服务推荐 Ubuntu Server 24.04 LTS、专用域名与 HTTPS。首次部署按[完整操作流程](docs/完整操作流程.md)设置管理员、班级、教师与绑定码，再在一间教室验证后推广。

现有服务使用配套服务器 ZIP 和 scripts/update-ubuntu.sh 更新。默认程序位于 /opt/iceclass/app，数据位于 /var/lib/iceclass，备份位于 /var/backups/iceclass，环境文件为 /etc/iceclass.env，服务为 iceclass.service。

备份同时覆盖数据库与实际媒体目录，保留更新恢复所需资料。凭据、API Key、环境文件、真实数据库、学生图片、个人浏览器资料和构建产物不提交到 Git。

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 安装与验收 | [完整操作流程](docs/完整操作流程.md)、[验收指南](docs/验收指南.md)、[三端本地验收](docs/三端本地验收.md) |
| 微信教师端 | [小程序导入与上线](docs/微信教师端.md) |
| 视频展台 | [安装与维护](docs/视频展台插件.md)、[插件工程](plugins/VideoBooth/README.md)、[插件流程](workflows/video-booth-plugin.md)、[点评流程](workflows/math-classroom-review.md) |
| 纸卡答题 | [纸卡打印、课堂收答和学生报告](docs/纸卡答题.md) |
| 客户端与发布 | [教师端](docs/Windows教师端.md)、[客户端更新](docs/客户端更新说明.md)、[自动发布](docs/GitHub自动发布.md) |
| 教学与班级 | [权限](docs/用户权限与管理.md)、[早读](docs/早读使用说明.md)、[作业](docs/作业统计.md)、[课表](docs/教室岛课表与自动化.md)、[值班](docs/循环值班方案.md)、[晚自习](docs/晚自习管理.md) |
| 班班与反馈 | [语音助手](docs/班班语音助手.md)、[功能接入](docs/班班功能接入.md)、[创意计划](docs/千人创意计划.md)、[反馈邮件](docs/教师反馈邮件配置.md)、[致谢名单](docs/致谢名单维护.md) |
| 界面与历史 | [教室端设计](DESIGN.md)、[教师端设计](docs/teacher-liquid-glass/DESIGN.md)、[2.5.9 发布记录](docs/发布记录-2.5.9.md)、[动画记录](docs/动画检查记录-2026-11-03.md) |

## 许可与第三方来源

项目自身代码和文档采用[非商业学习参考许可](LICENSE)。第三方组件、模型、字体、图标与数据遵循各自许可，见[第三方说明](docs/licenses/THIRD_PARTY_NOTICES.md)；视频展台的有限移植来源及随附组件见[NOTICE](plugins/VideoBooth/NOTICE.md)。
