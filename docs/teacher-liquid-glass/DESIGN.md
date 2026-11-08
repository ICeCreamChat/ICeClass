---
name: "ICeClass · 教师端液态玻璃"
description: "正式教师网页与 Windows 教师端的蓝白玻璃材料、微软雅黑和清晰操作规范。"
colors:
  bg: "#dfedf7"
  surface: "#f4fbff69"
  surface-solid: "#edf7fc"
  text: "#193c59"
  muted: "#3e5b72"
  line: "#7199b52e"
  blue: "#0064d7"
  blue-text: "#075cad"
  blue-soft: "#e3f3ff8a"
  focus: "#4e87b2"
  green: "#24654e"
  red: "#943e3b"
  red-soft: "#fbe6e175"
  orange: "#825617"
  orange-soft: "#fff0dba1"
  action-ink: "#234f73"
  action-hover: "#174e79"
  field-label: "#34546c"
  placeholder: "#46637a"
  field-outline: "#92b4cc8c"
  glass-outline: "#ffffffb8"
  navigation-ink: "#345c78"
  selected-ink: "#005dbf"
  selected-surface: "#f7fcffb8"
  reduced-outline: "#b7cddd"
typography:
  headline:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "-.02em"
  title:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.5
  subheading:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.5
  dialog-title:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  action:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
  menu-action:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.3
  field:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "24px"
  field-label:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  supporting:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.75
  navigation:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  navigation-selected:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.65
  status:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  native-body:
    fontFamily: "Microsoft YaHei UI, Microsoft YaHei, Segoe UI"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  native-title:
    fontFamily: "Microsoft YaHei UI, Microsoft YaHei, Segoe UI"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.6
  native-supporting:
    fontFamily: "Microsoft YaHei UI, Microsoft YaHei, Segoe UI"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  native-action:
    fontFamily: "Microsoft YaHei UI, Microsoft YaHei, Segoe UI"
    fontSize: "16px"
    fontWeight: 600
rounded:
  button: "13px"
  field: "12px"
  navigation: "14px"
  tab-strip: "16px"
  surface: "25px"
  surface-narrow: "21px"
  popover: "17px"
  assistant-layer: "22px"
  dialog: "28px"
  dialog-narrow: "24px"
  status: "5px"
  native-flyout: "24px"
  native-toolbar: "11px"
spacing:
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "14": "14px"
  "16": "16px"
  "20": "20px"
  "24": "24px"
  "28": "28px"
components:
  button-default:
    textColor: "{colors.action-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.button}"
    padding: "10px 18px"
  button-primary:
    textColor: "{colors.blue-text}"
    typography: "{typography.action}"
    rounded: "{rounded.button}"
    padding: "10px 18px"
  button-danger:
    textColor: "{colors.red}"
    typography: "{typography.action}"
    rounded: "{rounded.button}"
    padding: "10px 18px"
  button-menu:
    backgroundColor: "transparent"
    textColor: "{colors.action-ink}"
    typography: "{typography.menu-action}"
    rounded: "{rounded.button}"
    padding: "10px 18px"
  input-field:
    textColor: "{colors.text}"
    typography: "{typography.field}"
    rounded: "{rounded.field}"
    padding: "7px 12px"
  provider-select:
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "10px 36px 10px 12px"
  navigation-item:
    textColor: "{colors.navigation-ink}"
    typography: "{typography.navigation}"
    rounded: "{rounded.navigation}"
    padding: "11px 14px"
  navigation-item-selected:
    backgroundColor: "{colors.selected-surface}"
    textColor: "{colors.selected-ink}"
    typography: "{typography.navigation-selected}"
    rounded: "{rounded.navigation}"
    padding: "11px 14px"
  status-badge:
    backgroundColor: "#e9f2e4"
    textColor: "{colors.green}"
    typography: "{typography.status}"
    rounded: "{rounded.status}"
    padding: "3px 8px"
  glass-panel:
    textColor: "{colors.text}"
    rounded: "{rounded.surface}"
    padding: "24px 26px"
  layered-dialog:
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    width: "min(580px,calc(100vw - 32px))"
  native-button:
    textColor: "{colors.action-ink}"
    typography: "{typography.native-action}"
    rounded: "{rounded.button}"
    padding: "10px 18px"
  native-button-primary:
    textColor: "{colors.blue-text}"
    typography: "{typography.native-action}"
    rounded: "{rounded.button}"
    padding: "10px 18px"
  native-field:
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
  native-card:
    textColor: "{colors.text}"
    rounded: "{rounded.surface}"
    padding: "24px"
---

# Design System: ICeClass · 教师端液态玻璃

## Overview

**Creative North Star: "教师端蓝白液态玻璃"**

蓝白曲面延续教师已确认的玻璃工作台。透明渐变、边缘折射和内高光提供连续的材料；深蓝标题、正文、图标、表单值与键盘焦点保留在独立前景。浅层工作台和深层编辑、确认、班班面板使用同一字体与材料语言，操作文字保持清楚。

本规范适用于正式教师网页与 Windows 教师端：统计、作业、晚自习、课表、通知、教室来音、控制、创意、班级、用户、账号和班班，以及桌面设置、反馈、关于等原生窗口。保留既有权限、校验、确认和真实业务行为，样板目录与模拟数据不进入正式功能。

网页主依据是 [teacher-liquid-glass.css](../../web_controller/teacher-liquid-glass.css)，并结合 [ui.css](../../web_controller/ui.css)、[index.html](../../web_controller/index.html) 与[背景镜片运行时](../../web_controller/assets/classroom-glass.js)的层叠结果。Windows 依据 [TeacherStyle.cs](../../Desktop/TeacherStyle.cs)、[TeacherControls.axaml](../../Desktop/TeacherControls.axaml)、[DesktopStyle.cs](../../Receiver/DesktopStyle.cs) 和[背景画布](../../Receiver/ClassroomGlassHost.cs)。仓库根 DESIGN.md 仍只描述教室嵌入页。

**Key Characteristics:**

- 蓝白曲面、独立背景镜片、边缘折射与内高光共同表达玻璃。
- 微软雅黑优先，普通操作半粗，说明文字保留自己的层级。
- 浅色玻璃按钮配深蓝文字，主操作通过文字与边缘色差表达。
- 深层菜单、字段、弹窗和状态反馈延续同一材料，保留真实控件行为。

frontmatter 是颜色、字体、圆角、间距与组件基础值的唯一规范层；[schema 2 sidecar](.impeccable/design.json)补充渐变、阴影、状态、断点、动态和十个组件片段。侧栏、表格、登录与班班仍保留各自既有布局；本文件不把某一个页面的构图推广为全局模板。

## Colors

单一蓝色动作体系配灰蓝中性色，语义状态保留既有成功、警示和危险色。颜色名称对应 frontmatter；曲面与玻璃的多层色值在 sidecar 中按实际渐变记录。

### Primary

- **blue** 用于动作提示、光标等既有强调；**blue-text** 用于浅色主按钮与明确操作。
- **focus** 用于柔和的键盘轮廓。网页最终焦点以共享 [control-focus.css](../../web_controller/assets/control-focus.css) 为准，字段使用细浅蓝边和淡蓝微光；原生复用 [NativeControls.axaml](../../Receiver/NativeControls.axaml) 的共享焦点资源。历史组件片段不能覆盖这些正式样式。
- **selected-ink** 用于主导航与分段导航的选中项；**blue-soft** 保留既有轻量选中与悬停背景用途。

### Neutral

- **bg** 是蓝白页面基底；**surface** 是共享半透明底，**surface-solid** 是网页减少透明效果时的实色面板。
- **text** 用于标题和正文；**muted** 用于帮助、次要信息和状态说明；**placeholder** 保持完整不透明度，避免小字被玻璃背景冲淡。
- **action-ink**、**action-hover** 与 **navigation-ink** 分别服务普通操作、悬停操作和未选中导航；**field-label** 区分字段标签。
- **line** 用于表格、分组与内容分隔；**glass-outline** 表达透明材料边缘；**field-outline** 用于字段；**selected-surface** 承载主导航选中状态。

### Semantic states

- **green** 表达已启用、已确认等成功状态；**red** 与 **red-soft** 表达错误、危险和紧急；**orange** 与 **orange-soft** 表达警示。具体业务仍同时提供文字状态。
- Windows 现有设置、反馈和来音窗口保留部分局部状态颜色；这些局部色不提升为新的全局调色板。

**The 清晰前景 Rule.** 文字、图标、输入值和焦点保持在前景，透明与折射只改变它们下方的背景。

## Typography

**Body Font:** frontmatter 中的微软雅黑优先字体链。网页保留 `font-synthesis: none`；Windows 由 App 字体资源与 TeacherStyle 设置同一字体链，并使用 Antialias 文本渲染。没有为此次迁移添加网络字体。

网页层级按 frontmatter 的 headline、title、subheading、dialog-title、body、action 和 supporting 应用。字段标签、表格辅助字、导航和状态有各自角色；不把所有小字统一加粗。普通正文行高继承 ui.css，帮助文本、班班回答与确认说明保留各自实际行高。

窄窗口的页面标题、面板标题、普通按钮、分段项和弹窗标题按现有响应式规则收缩；登录标题与故事区也沿用自己的大小。它们的变化见 sidecar，不把样板正文行高或样板字段内距覆盖到正式网页。

Windows 的 native-body、native-title 与 native-supporting 特指 DesktopStyle.Text 辅助方法：教师模式将该方法的小字下限提升到辅助字号，按字号比例设置行高，较大强调标题使用 Bold，普通操作使用 SemiBold。原生字段、Checkbox、文档页签和局部按钮仍可能直接设置属性，因此没有把网页字体阶梯当作全原生窗口的固定约束。

**The 同类同重 Rule.** 普通操作复用 SemiBold；说明、页脚和未选中文档页签保留常规字重，选中文档页签再增强。不得用 Microsoft YaHei UI 的 Medium 设置值替代已确认的实际半粗效果。

## Layout

网页维持左侧导航、统一顶栏与主要内容区域的工作台结构，主体和内容宽度分别受现有最大宽度约束。顶栏集中品牌、当前位置、桌面工具及账号入口；Windows 工作台就绪后收起重复原生工具条，加载或连接失败时保留恢复入口。主内容允许收缩，长表格在自身滚动区域内展开。字段纵向排列并保留标签关联；弹窗头尾固定在容器内，正文独立滚动，操作区可换行。

宽窗口和紧凑桌面有独立侧栏、主区内距；窄屏进一步调整面板、弹窗和操作文字。所有断点及其真实作用记录在 sidecar。最终教师外壳与共享抽屉使用同一窄屏切换点，紧凑桌面从相邻的下一个宽度起生效；不保留原来相互错开的侧栏切换规则。

间距取自现有字段、按钮、确认窗口、卡片和弹窗。frontmatter 的 spacing 是这些实际复用值的集合，并非要求所有页面套用统一倍数网格。普通按钮最小高度、图标按钮、分段项及操作菜单各自的尺寸见组件片段。

Windows 设置和反馈窗口保留内容滚动与固定底部操作；可调整窗口由 KeepWindowInWorkingArea 约束在屏幕工作区。来音窗口由自己的定位逻辑约束宽度和高度；它的浮层轮廓与普通窗口不同，不套用网页断点。

## Elevation & Depth

玻璃深度来自半透明渐变、柔和环境阴影、内高光和边缘位移。面板、按钮、下拉、浮层与弹窗分别保留当前阴影；确切的阴影和渐变只在 sidecar 中记录，不另造一套海拔等级。

网页为镜片建立独立伪元素，背景滤镜只作用于该层。运行时在视口外扩范围（80px）内按可见性分配位移图，离开观察区域时释放；尺寸变化不足阈值（1px）时复用，动态增加的弹窗和按钮通过观察器加入。位移图限制在（760 × 560）以内，按钮组与菜单内的小操作不各自创建镜片；没有持续动画循环。旧教室端继续使用自己的选择器和镜片分支，不随教师规范变更。

Windows 的 ClassroomGlassHost 把背景画布放在实际控件之前，只对程序生成的背景场景折射，不截取桌面、不对文字或控件内容使用滤镜。仅绘制可见且与窗口相交的面板；尺寸、几何与高对比状态未变时复用录制画面，分离时释放资源。LiquidGlassOptics 的受限位移图保留原来的默认模式，教师背景宿主显式启用尺寸限制。

网页减少动态效果时取消过渡、缩短动画并恢复普通滚动；减少透明效果时隐藏镜片与装饰曲面，使用实色面板；强制颜色时使用系统画布、文字和焦点色。Windows 背景宿主在系统高对比模式下画实色白底与深色边缘，平时为静态场景；本轮提取未发现它对 Windows「透明效果」开关的单独绑定，不能把网页的媒体查询能力声称为原生已实现的能力。

**The 背景镜片 Rule.** 折射、模糊和饱和度只进入独立背景层；可读内容及键盘焦点不参与滤镜，布局变化才更新静态光学资源。

## Shapes

普通按钮、字段、主导航、分段容器、大面板、班班内层与弹窗使用 frontmatter 中各自的圆角。窄窗口面板与弹窗保留对应收缩值。镜片继承宿主轮廓；背景裁切和前景内容的滚动边界按实际容器处理。

细亮边缘与内高光表达玻璃厚度，表格分隔保持淡蓝。圆形关闭按钮、紧凑状态标签和原生浮层使用自己的轮廓，不把大面板圆角推广到所有控件。原生来音外层与内部镜片的轮廓也按实际代码分别保留。

## Components

### Buttons

普通、主要和危险动作使用浅色玻璃，统一动作字体、内距与圆角；网页普通动作最小高度沿用共享控件尺寸。主要动作使用蓝色文字与偏蓝镜片，危险动作用语义文字与暖色镜片。悬停增强亮度，按下保持原位置；网页键盘轮廓置于材料之外。禁用沿用既有不可操作状态与透明度反馈。

操作菜单使用常规字重、透明行背景和浅色悬停；分段导航也有自己的常规与选中字重。用户菜单行、班班工具、圆形关闭、移动端操作栏和原生紧凑工具不都使用普通按钮的字号或最小高度。现有原生反馈辅助按钮与来音翻页按钮的较小局部值仅记录为例外，不确立为新窗口的默认值。

### Inputs / Fields

普通网页字段使用共享 ui.css 的内距、教师字段圆角和浅色渐变；placeholder 保持既定颜色及完整不透明度。焦点同时改变边缘并提供光晕。原生 TextBox、ComboBox、NumericUpDown 复用教师字段样式；输入框水印保留完整不透明度，控件焦点与弹出列表仍由原生模板承载。

班班服务商是原生语义 select。正式样式对它声明独立 ID 规则，恢复教师字体、颜色、圆角、最小高度与焦点轮廓，并保留原布局的选项内距。支持基础选择器外观的浏览器可显示玻璃选项面板；其他浏览器继续使用该 select 的原生交互。预览展示字段与可交互选择器，不能代替真实浏览器的弹出选项验证。

### Navigation

主导航保持真实模块组织，未选中常规、选中半粗，选中状态使用浅色面板与蓝字。分段导航、作业范围、浮岛页签与班班年级选择继续使用各自的选中属性；不为其额外添加装饰性方向箭头。共享抽屉的键盘和开关行为继续由既有脚本负责。

### Chips / Status

标签保留短状态文字与语义色，状态不能只靠颜色识别。sidecar 的状态预览取自已启用／已确认标签；通知等级、来音状态、创意进度等继续复用各自已有语义。

### Cards / Containers

工作台筛选、统计、通知、用户、课表、作业与班班容器共享玻璃背景机制；其内容密度和内距仍由实际页面定义。大面板、浮动菜单和班班内层分别用自己的圆角和渐变。教师原生卡片、字段和按钮由背景宿主识别并绘制镜片，实际控件位于其上。

### Dialogs

网页 dialog 保留浏览器模态与焦点语义，正文滚动、头尾保持可见，窄窗口使用对应内距和轮廓。班班嵌套面板继续使用已有层级和返回行为。Windows 确认／消息、桌面设置、反馈和来音使用原窗口逻辑与取消、Esc、焦点及状态反馈；外观迁移不改变执行后果。

sidecar 的十个片段均为独立 `ds-` 作用域的 HTML/CSS，只展示静态材料、原生 HTML 控件与 CSS 状态。实际 SVG 位移和 Windows 背景画布来自程序运行时，片段没有模拟它们。它们不包含真实业务调用、账号、学校资料或新图像资源。

## Do's and Don'ts

### Do:

- **Do** 复用教师端现有字体、文字层级、浅色控件与深层玻璃材料，让同类操作保持一致。
- **Do** 将折射留在独立背景层，保留文字、输入值、图标和焦点的清晰度。
- **Do** 为长表格和弹窗正文保留各自滚动边界，并检查窄窗口、键盘、选中、禁用与错误反馈。
- **Do** 保留必要的权限、离线、有效期与操作后果说明，以及下拉、展开和翻页所需方向提示。
- **Do** 分别验证网页和原生的实际渲染，保留两端已存在的字号、内距、焦点与紧凑控件差异。

### Don't:

- **Don't** 用透明度、模糊、位移或不完整水印不透明度降低小字和输入的辨认度。
- **Don't** 把样板的模拟业务、样板尺寸或网页断点直接当作正式原生窗口的实现规范。
- **Don't** 为文字已明确表达操作的按钮或链接追加装饰性方向箭头。
- **Don't** 将教师端样式写回教室端根规范，或改变共享光学算法的原教室端默认模式。
- **Don't** 将局部紧凑按钮或未验证的辅助偏好能力提升为全局规则。

本规范描述设计与维护约定，不作为测试通过证明。每次修改仍需验证受影响页面和原生窗口，不能用历史样板的检查记录代替当前程序验收。
