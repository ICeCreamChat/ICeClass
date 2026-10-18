# 班伴应用图标

教室端原生应用使用 ICe 提供的「应用图标.jpg」。`source.jpg` 保留原始插画。

`app-icon.png` 沿黑板原有的圆角外轮廓裁切，外侧纸张和方形底色已移除，背景透明；保留插画本身的细边框。`app.ico` 包含 16–256 像素的透明图层，供 Windows EXE、窗口和托盘使用。教室端通过 `Receiver.csproj` 嵌入这两个资源。

重新生成资源可运行 `python scripts/generate-app-icons.py`（需要 Pillow）。生成器从 `source.jpg` 提取封闭的黑板轮廓，保留人物和文字，再统一缩放到各尺寸。

## Windows 教师端与网页

教师端单独使用 ICe 提供的「应用图标2.jpg」，原图保存在 `teacher/source.jpg`。`teacher/app-icon.png` 保留原画的文字、人物与圆角边框，移除外侧纸张，使用透明背景；`teacher/app.ico` 包含 16、24、32、48、64、128 和 256 像素图层。

`Desktop/ICeClass.Desktop.csproj` 将这套图标用于 EXE，并嵌入教师端窗口、托盘、工具栏和“关于”页使用的资源。安装器的桌面快捷方式、开始菜单和卸载条目均从教师端 EXE 读取图标。

重新生成教师端资源可运行 `python scripts/generate-teacher-icons.py`（需要 Pillow）。

同一生成器还会更新 `web_controller/assets` 内的 512 / 192 像素应用图标、32 像素 favicon、180 像素 Apple touch icon，以及 `/favicon.ico` 和兼容旧链接的 `/favicon.svg`。登录页插画与标识、工作台侧栏、浏览器标签及网页快捷方式均使用这套新图；教师端内嵌工作台与独立网页共用这些资源。HTML 和网页快捷方式的图标版本参数已更新到 `v=5`。
