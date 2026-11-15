# 视频展台页面

desktop.html、desktop.js、styles.css 是 ICeClass 全新工作台与浮窗实现，没有移植旧桌面 DOM、布局或工具栏。

shared.js、orientation.js、managed-review.js、public-peer.js、phone.js、portal.js、setup.js、connect.js、preparation-*.js、phone-preparation-*.js 及 fflate.js 移植自 D:/ICeCoding/VideoBooth/src/VideoBooth.Core/Site，保留媒体、配对、证书准备与图像校验算法。来源与许可见上级 NOTICE.md 和 licenses/。control-focus.css 复用 ICeClass 的 web_controller/assets/control-focus.css。

手机 HTML 重新组织为视频展台品牌与共用蓝白布局，保留底层脚本需要的 ID。手机采集改为手动开始；切换摄像头先发送 streaming:false，使电脑端旧点评失效。公网 portal 静态发布需要随插件另行发布到配置的服务，本地页面修改不会更新远端服务。
