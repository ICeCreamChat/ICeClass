# 视频展台来源与第三方组件

本工程为 ICeClass 的独立视频展台。新 Program、WorkbenchForm、协议边界校验与页面由本工程维护，不使用旧桌面壳、更新器或反馈面板，不引用工作区外工程。

`Transport/` 中的 BoothServer、Certificates、TrustedEndpoint、RoomStore、PhoneConnection、PublicPhonePairing、PhonePreparation、PhonePreparationPages、ManagedPreparation、NetworkSelection、ConnectionChoice、LocalStunResponder、IceClassProtocol、IceClassPipeClient、DataDirectoryLease 来源于用户本机 `D:/ICeCoding/VideoBooth/src/VideoBooth.Core`，于 2026-11-14 有限移植。变更包括命名空间、新资源前缀和白名单、独立单实例名称、去除旧反馈路由及启动联网副作用。CertificateMaintenance 只保留证书有效期判断。原工程此快照未提供独立的源码 LICENSE，本说明不虚构对原代码的额外许可；该用户提供的源码继续由原权利人保留权利。

| 组件 | 固定版本 | 随附许可 |
| --- | --- | --- |
| QRCoder | 1.8.0 | MIT，`licenses/QRCoder.txt` |
| Microsoft.Web.WebView2 SDK | 1.0.4258.31 | Microsoft，`licenses/WebView2.txt`、`licenses/WebView2-NOTICE.txt` |
| .NET、Windows Forms、ASP.NET Core | 10.0.12 runtime / SDK 10.0.401 | `licenses/dotnet.txt`、`licenses/dotnet-ThirdPartyNotices.txt` |
| fflate（手机静态配对页使用时） | 0.8.2 | MIT，`licenses/fflate-LICENSE.txt` |

自包含分发时保留 .NET 自带的第三方声明；附带 WebView2 固定浏览器时保留微软完整原件、软件条款及第三方声明。ICeClass 图标取自本仓库 `branding/app.ico`。
