# 班班原画

- `character.jpg`：用户提供的完整小书灵。
- `parts.jpg`：用户提供的身体、眼睛、嘴巴、手臂、书签拆件图。
- `mas-source.webp`：用户提供的 MAS 原标志。
- `smile.jpg`：用户补充的闭眼笑素材。
- `emotions.jpg`：用户补充的等待、思考、开心表情。
- `thinking.jpg`：用户补充的托脸手势素材。

使用原画拆件制作透明 WebP，并将完整 MAS 徽章合到胸前圆位。素材处理脚本只用于开发阶段，需要 Pillow：

```powershell
python scripts/prepare-banban-assets.py branding/banban/parts.jpg branding/banban/mas-source.webp --expressions
```

网页素材位于 `web_controller/assets/banban`，含新骨骼纹理共约 275 KiB。各组眼睛和嘴巴经过透明去底、大小匹配及对位，使用统一的 660×720 坐标，完整 MAS 徽章保持独立。

`web_controller/banban-motion.js` 根据聊天、输入、拖动与网络状态调度动作；`web_controller/banban-rig.js` 负责 Canvas 2D 原画网格变形、肩肘腕关节和连续眼睑。先运行原画拆件脚本，再运行 `python scripts/prepare-banban-rig.py` 生成眼球、眼白、眼睫毛、闭眼及前臂纹理；需要 Pillow。原画文件不随服务端发布包分发。

眼球独立移动，眼睑逐渐遮住眼球；手臂沿弧线抬向脸颊，书签延后跟随身体。点击会轻轻歪头、眨眼回应；真实文字到达才触发短暂嘴部回应。表情来自实际返回的数据和交互情境，不因一条回复完成就庆祝。只使用一个小画布，不加载视频或外部动画运行库，素材失败时保留静态原画。支持关闭动效、系统减少动态效果和页面隐藏暂停。

这是基于用户原画的 2D 关节与网格动画，不是 Live2D、3D 或面部追踪。实现、验证和 GitHub 参考见 [角色动作说明](../../docs/班班角色动作说明.md)。最终真实浏览器动画位于本地 `output/banban/rig-final-motion.gif`。
