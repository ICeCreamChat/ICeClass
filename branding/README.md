# 班伴应用图标

应用图标统一使用 ICe 提供的「应用图标.jpg」。`source.jpg` 保留原始插画。

`app-icon.png` 沿黑板原有的圆角外轮廓裁切，外侧纸张和方形底色已移除，背景透明；保留插画本身的细边框。`app.ico` 包含 16–256 像素的透明图层，供 Windows EXE、窗口和托盘使用。教室端通过 `Receiver.csproj` 嵌入这两个资源。

网页的图标位于 `web_controller/assets`，包含 favicon、Apple touch icon 和不同尺寸的 PNG。新增客户端或页面应复用这套素材。

登录页、侧边栏和早读页统一引用这一套透明图标。网页保留 `/favicon.ico` 和旧 `/favicon.svg` 入口；两者均由同一素材生成，教师网页快捷方式使用 ICO，避免再出现旧书本或雪花标识。网页资源引用已更新版本参数以刷新缓存。

重新生成资源可运行 `python scripts/generate-app-icons.py`（需要 Pillow）。生成器从 `source.jpg` 提取封闭的黑板轮廓，保留人物和文字，再统一缩放到各尺寸。
