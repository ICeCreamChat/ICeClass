---
name: "ICeClass · 嵌入式教室操作中心"
description: "仅适用于教室端嵌入首页、班级管理与同页作业登记的蓝白液态玻璃规范。"
colors:
  ink: "#193c59"
  muted: "#4e6c83"
  blue: "#0064d7"
  focus: "#4e87b2"
  module-teal: "#177a83"
  module-violet: "#6964b6"
  canvas: "#e5f0f8"
  white: "#fff"
  white-canvas: "#f4f7fb"
  white-outline: "#dae4ee"
  solid-glass: "#eff7ff"
  soft-surface: "#f7fcffad"
  soft-ink: "#235f8b"
  text-action: "#2c6394"
  field-surface: "#f8fcff91"
  assignment-surface: "#e0edf45e"
  assignment-ink: "#3c6686"
  assignment-active: "#0b6dcc"
  student-surface: "#f9fdffb0"
  student-ink: "#294f6c"
  student-checked: "#2078cb"
  missing-surface: "#fff5ede0"
  missing-ink: "#94603c"
  success-surface: "#e4f5ed"
  success-ink: "#246543"
  warning-surface: "#fff3e6"
  warning-ink: "#814810"
typography:
  headline:
    fontFamily: '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif'
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-1px"
  title:
    fontFamily: '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif'
    fontSize: "23px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-.5px"
  dialog-title:
    fontFamily: '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif'
    fontSize: "27px"
    fontWeight: 700
    letterSpacing: "-.7px"
  body:
    fontFamily: '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif'
    fontSize: "16px"
    fontWeight: 400
  action:
    fontFamily: '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif'
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.4
  compact-action:
    fontFamily: '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif'
    fontSize: "16px"
    fontWeight: 600
  student:
    fontFamily: '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif'
    fontSize: "17px"
    fontWeight: 500
rounded:
  control: "11px"
  compact-button: "12px"
  button: "15px"
  navigation: "22px"
  capsule: "25px"
  detail: "27px"
  surface: "28px"
  dialog: "30px"
  surface-narrow: "24px"
spacing:
  "8": "8px"
  "12": "12px"
  "20": "20px"
  "24": "24px"
  "28": "28px"
components:
  button-primary:
    textColor: "{colors.white}"
    typography: "{typography.action}"
    rounded: "{rounded.button}"
    padding: "12px 21px"
  button-soft:
    backgroundColor: "{colors.soft-surface}"
    textColor: "{colors.soft-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.button}"
    padding: "12px 21px"
  button-text:
    textColor: "{colors.text-action}"
    typography: "{typography.compact-action}"
    padding: "10px 5px"
  search-field:
    backgroundColor: "{colors.field-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  top-navigation:
    textColor: "{colors.ink}"
    typography: "{typography.action}"
    rounded: "{rounded.navigation}"
    padding: "5px"
  assignment-chip:
    backgroundColor: "{colors.assignment-surface}"
    textColor: "{colors.assignment-ink}"
    typography: "{typography.compact-action}"
    rounded: "{rounded.control}"
    padding: "10px 17px"
  assignment-chip-selected:
    backgroundColor: "{colors.assignment-active}"
    textColor: "{colors.white}"
    typography: "{typography.compact-action}"
    rounded: "{rounded.control}"
    padding: "10px 17px"
  module-card:
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "26px 28px 21px"
  student-tile:
    backgroundColor: "{colors.student-surface}"
    textColor: "{colors.student-ink}"
    typography: "{typography.student}"
    rounded: "{rounded.control}"
    padding: "10px 11px"
  homework-dialog:
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    width: "min(840px,calc(100vw - 40px))"
    height: "fit-content"
    maxHeight: "calc(100dvh - 40px)"
---

# Design System: ICeClass · 嵌入式教室操作中心

## Overview

**Creative North Star: "教室操作中心"**

本规范只适用于 `web_controller/homework/classroom/index.html` 所呈现的嵌入式教室首页、班级管理及同页作业登记流程。它记录用户批准样板在正式教室端的实现，不是教师端、其他网页或原生共享控件的全局设计系统；原生悬浮岛也不在本规范范围内。

蓝白曲面作为安静的底景，轻透静态材质承载顶部操作栏、模块外壳和上层弹窗。深蓝文字、清楚的操作按钮与柔和边缘维持样板层次。教室端从 2.5.13 起取消背景折射和模糊，以降低教室测试机的合成开销；保留原版白色和降低透明度的外观选择。

**Key Characteristics:**

- 蓝白曲面、静态轻透底色和柔和边缘保持材质层次，不使用实时背景折射或模糊。
- 沿用微软雅黑字体栈、明确的按钮字重和圆角控件。
- 首页、班级管理与作业上层弹窗保持连续的操作上下文。
- 桌面双列、窄屏单列；作业名单独立滚动，底部操作保持可见。

取值依据为正式的 `classroom.css`、`index.html`、`assets/classroom-glass.js`、`home.js`、`classroom.js` 与 `Receiver/StudentVoiceWindow.cs`。使用范围见[教室端液态玻璃](docs/教室端液态玻璃.md)；颜色、尺寸和状态以最终代码为准。前置令牌记录可复用的现有值，阴影、渐变、动态和断点由本机 `.impeccable/design.json` 扩展记录。

## Colors

主色来自现有的蓝白教室界面：深蓝承担阅读，操作蓝承担动作和选中，半透明冷白让背景曲面透出。

### Primary

- **操作蓝**（`blue`）：文本输入光标等主要蓝色基准；主按钮使用其现有的纵向蓝色渐变，不能以单一背景色代替。
- **焦点蓝**（`focus`）：柔和键盘轮廓，保持独立于 hover 与选中反馈。最终样式复用共享 [control-focus.css](web_controller/assets/control-focus.css) 的细浅蓝描边与淡蓝微光，不照搬历史片段中的粗蓝框。
- **项目选中蓝**（`assignment-active`）：作业项目的实色选中状态。
- **名单勾选蓝**（`student-checked`）：已交复选框，配合白色勾线。

### Secondary

- **班级管理青**（`module-teal`）：班级管理、作业统计图标的识别细节。

### Tertiary

- **创意工坊紫**（`module-violet`）：工坊图标与对应的轻量识别细节。

### Neutral

- **深蓝正文 / 灰蓝辅助字**（`ink` / `muted`）：标题、正文与说明层级；不要把辅助字降成低对比装饰。
- **蓝白底景 / 冷白**（`canvas` / `white`）：玻璃背后的基底与控件高光。完整曲面渐变保留在组件样式中。
- **原版白色底 / 边缘**（`white-canvas` / `white-outline`）：白色模式的页面底色与实白容器描边。
- **降低透明度底色**（`solid-glass`）：应用内该选项的更实底色；系统减少透明度偏好另沿用代码中的同类处理。
- **次级操作、输入、项目与名单底色**：对应的 `soft-*`、`field-*`、`assignment-*` 与 `student-*` 令牌保留源代码的透明度，不能预先混成某一张背景上的不透明色。
- **未交、成功与警示**：`missing-*`、`success-*`、`warning-*` 是明确状态组合，必须同时显示勾选变化或可读文字。

**The Blue Action Rule.** 蓝色用于主操作、选中与焦点；青色和紫色用于班级管理、创意工坊的识别细节，不替代主操作蓝。

Sidecar 的八阶色带由这些源色推导，仅供设计面板预览，不是新增的生产色阶。

## Typography

字体统一沿用 frontmatter 的微软雅黑优先字体栈。页面不加载网络字体，保留 `font-synthesis: none`；标题和正文来自同一字体体系，通过字号、字重与留白建立层级。

- **Headline**（`typography.headline`）：班级名称或“班级管理”的页面标题。桌面低高度布局降为（30px），窄屏降为（27px）。
- **Title**（`typography.title`）：首页模块标题；窄屏沿用代码中的（21px），不与说明文字混用。
- **Dialog title**（`typography.dialog-title`）：作业上层弹窗标题；窄屏为（23px）。
- **Body**（`typography.body`）：首页模块说明；详情、反馈等较长内容分别保留现有的宽松行高。
- **Label**（`typography.label`）：课程时间、状态、页脚和辅助说明。
- **Action / Compact action**：普通按钮与紧凑操作分别使用对应令牌；保存、返回、筛选等动作文字维持清楚的半粗层级。
- **Student**（`typography.student`）：桌面姓名；较窄布局为（12px），同时保留复选框和文字的间隔。

**The Original Type Rule.** 保留现有字体栈、标题层级与操作字重；不得用换字体或合成粗体重新解释批准样板。

日期、时间及人数使用等宽数字特性；标题允许均衡换行，长班名可换行。姓名单元保留截断和完整姓名提示，不能把复选框挤出可操作区域。

## Layout

内容居中，容器最大宽度为（1456px），常规左右内边距为（52px）。首页上方依次是品牌与操作栏、班级标题和右侧连接状态、左侧日期与右侧全天课表；下方是早读陪伴、给老师留言、创意工坊、班级管理四模块。这是本页已确认的结构，不是其他 ICeClass 页面的模板。

常规首页为两列等宽网格，使用 `spacing.20` 的间隔；模块内边距见 `components.module-card`。日期和课表为两个并排的独立玻璃容器，高度保持 82px，左侧日期宽 125px，间隔 12px。背景、边缘高光、阴影和圆角复用下方模块卡片的玻璃样式，常规圆角为 28px，窄屏为 24px。课表按课程开始时间分为上午（12:00 前）、中午（12:00 - 14:00 前）、下午（14:00 - 18:00 前）、晚上（18:00 起），只展示有课程的时段。图标位于课程侧边，各时段最多两行课程，科目与完整起止时间同行排列，字号为 17px / 600 和 16px。右侧课表按原生端的校准时间及真实课表自动定位：上课时跟随当前课程，课间显示下一节课，全天结束后停在最后一节。首次载入直接定位，课程切换时平滑移动，减少动态效果偏好下直接定位。宽度不足时可直接拖动课表内容或底部留白，也支持触摸滑动、横向滚轮和键盘左右方向键、Home、End；隐藏滚动条，仅在可滚动时进入键盘顺序，焦点沿用页面的细描边与淡蓝微光。手动查看的位置保留至定位目标变化，普通状态刷新不抢回位置；日期固定，页面不产生横向滚动，也不通过增加行数增高课表。临时喊话在右侧替换课程概览，保留手动知晓操作及由原生状态更新的进度，日期保持可见，通知结束后恢复课程定位。

响应式规则直接对应现有媒体查询：

- **宽屏**（min-width: 1600px）：外边距增至（64px），模块与网格适当放宽。
- **课表宽度不足**：保持两行，在右侧容器内自动移动至当前课程或下一节课，课程尽量居中且不超出内容边界；可手动左右查看，滚动条隐藏，宽度足够时完整展示。
- **中等宽度**（max-width: 1150px）：外边距为（30px），收紧模块内距与按钮尺寸。
- **紧凑宽度**（max-width: 800px）：外边距为（24px）；顶部导航显示图标并保留可访问名称；名单由五列变四列。
- **窄屏**（max-width: 560px）：外边距为（18px），首页模块变为单列；日期仍位于课表左侧，宽 92px、间隔 10px。模块及作业弹窗使用 `surface-narrow` 圆角。学科导航改为横向滚动，名单为三列。
- **桌面低高度**（min-width: 801px 且 max-height: 820px）：收紧页头、模块和垂直留白；日期和课表仍高 82px，临时喊话至少 82px；不能只根据宽度推断桌面布局。

作业弹窗在视口中固定居中，尺寸不受底层页面滚动影响。其头部和底部不收缩，工作区填充剩余高度，只有名单区域独立滚动；打开弹窗时锁定底层页面滚动并保留稳定的滚动条占位。常规名单为五列，随断点减少列数。窄屏弹窗离视口左右各（8px），高度为 `100dvh - 24px`。

## Elevation & Depth

这里的深度由曲面背景、半透明渐变、静态内侧高光和柔和阴影共同表达。教室端不使用实时折射或背景模糊，降低合成开销。作业弹窗拥有更实的冷白渐变和更高的阴影，背景班级管理页面仍能辨认。

- **Glass shell**：常规模块、胶囊和顶部操作栏的柔和外阴影。
- **Glass inner / highlight**：容器边缘的内侧亮暗线，不作为正文的描边。
- **Homework modal**：作业弹窗的高层阴影；最终冷白渐变以 CSS 后置规则为准。
- **Detail modal**：设置、确认与详情弹窗的较小范围阴影。
- **Primary control**：蓝色主按钮的内侧亮线与短阴影；hover 反馈维持同一材料。

这些值以组件 CSS 为准。教室分支只应用静态底色和现有装饰，不生成位移图或背景纹理，也不使用背景采样、模糊与折射。两端均只装饰静态材质，不生成光学贴图。

**Content clarity.** 文字、图标、姓名与按钮始终保持清晰，不参与滤镜或变形。

按钮状态切换和弹窗入场使用现有缓动；录音动态只表达正在录音。尊重 `prefers-reduced-motion`，去除动画与过渡。应用内降低透明度会采用更实底色；系统减少透明度偏好也有对应处理。原版白色隐藏曲面和镜片，使用实白容器、细描边与轻阴影，保留结构、操作及字体层级。

## Shapes

大容器使用圆润但可辨认的矩形，操作控件的圆角更紧凑。全天课表与模块卡片共用容器圆角；顶部操作栏、作业弹窗和详情弹窗保留各自的圆角，用途令牌见 frontmatter。图标按钮为圆形，模块图标保留带厚度的圆角方形底座。

玻璃的圆角、镜片与高光继承同一轮廓并裁切；输入框、作业项目和姓名格使用更紧凑的 `control` 圆角。分隔线采用源代码中的低对比冷蓝透明细线，区分工作区，不形成繁重的表格边框。

## Components

### Buttons

主按钮使用现有蓝色纵向渐变、白字、内侧高光及短阴影；次级按钮使用半透明冷白底和蓝字；低优先级动作使用文字按钮。普通按钮沿用各自现有尺寸；管理流程弹窗内表单与操作按钮的最小高度为 46px，图标按钮为 44px。文本能说明动作时不再添加装饰性方向箭头。

首页四个模块入口是同级操作，统一使用浅色液态玻璃底、深蓝文字的 `button soft`，共用 17px 半粗字、48px 最小高度、112px 最小宽度和 15px 圆角，并在卡片右下对齐。蓝色主按钮用于进入流程后的开始录音、开始早读、保存和提交等执行操作；返回、取消沿用浅色次按钮。入口文字采用清楚的四字动宾短语，步骤文字、进行中状态和错误反馈按实际行为表达，保持同一操作在初始和动态恢复时用词一致。

班级管理内的两个同级入口同样使用 `button soft`，文案为“登记作业”和“自习管理”，共用 17px 半粗字、142px 最小宽度和 48px 最小高度，位于各自卡片右下角。

早读活动使用轻透静态材质：启动、暂停、继续与导航按钮使用深蓝文字，主操作以淡蓝透明底强调。兔子、火箭教师面板可透见活动背景，统计区仅保留轻透明色；音效开启及暂停仍用轻量状态色与文字表达。保存、提交沿用蓝色执行按钮。动态恢复按钮文案时保留材质类，不新增背景图层。

Hover 改变底色和阴影，按下轻缩至（0.975）；禁用降低不透明度并阻止操作。键盘焦点使用 1px 蓝色外轮廓及淡蓝微光，常规偏移 4px；搜索和日期输入框在外壳显示更近的细边。系统高对比度使用 2px `Highlight` 轮廓。外观切换与未交筛选通过 `aria-pressed` 表达选中，学科和作业使用原生下拉框表达当前值。

### Navigation

顶部操作栏是紧凑玻璃壳，保留创意计划、呼叫班班和教室设置三个操作及分隔线。窄屏可隐藏可见文字，必须保留图标按钮的中文可访问名称和点击区域。作业登记的学科、作业与日期位于弹窗顶部同一行；窄屏保留学科和作业并列，日期单独占一行，不再使用侧栏。

### Assignment selection

学科和作业使用浅蓝透明底的原生下拉框，保留键盘选择；作业选项附带已登记或无作业状态。切换学科、作业或日期时继续检查未保存修改，取消切换恢复原选择。“筹备中”只用于创意工坊占位。

### Cards / Containers

班级管理将作业统计与自习管理分成两张独立卡片，桌面并排且作业略宽，900px 及以下纵向排列。每张卡片保留标题、一句用途说明、独立插画和简短状态；人数、学科数及登记状态来自现有业务数据。作业图使用练习本、作业纸与铅笔，自习图使用无角色的书本、薄荷绿台灯与铅笔完整插画，与自习管理弹层保持一致，避免与首页班级管理插画重复。页首右侧保留连接状态并与标题区对齐，课表高度继续为 82px。

首页保留四个模块及已批准的视觉层次。蓝色图标用于早读和留言，青色用于管理，紫色用于工坊。卡片内的标题、说明、操作和页脚信息保持各自层级；不要增加重复辅助标签。课表四枚蓝色线条图标由粥生成，运行时使用 `homework/classroom/icons/` 下的透明 WebP，复用 `.module-icon.blue` 玻璃底座；图片替代文字保留时段名称。当前课程使用粥生成的完整班班纸签插画 `icons/current-lesson-banban-paper.webp`：班班位于左端，与淡蓝手绘纸签相连，边缘轻柔起伏，右端保留暖白色小折角。横向分段拉伸只延展文字区域，保留班班与右端折角的比例。科目与时间同行共用一块完整背景；普通课程最小高度为 30px，当前项为 36px，班班保持原比例及 36px 的展示高度，两行合计不超过 68px，课表总高度保持 82px。当前项左侧为班班预留空间，文字分别使用深蓝与蓝灰色。玻璃、原版白色及降低透明度外观沿用同一背景，高对比度移除图片并使用系统强调色。保留 `aria-current` 和可访问名称中的状态，不另外显示“正在上课”文字。

课表侧边图标使用 32px × 40px 底座，图片显示为 27px × 36px，沿用原版造型：上午日出、中午太阳、下午云与太阳、晚上月亮与单星；每枚图形在上，下方分别带 AM、NOON、PM、NIGHT 字样。细线图形与轻量字样由粥作为完整的上下构图生成，保留原图比例和内部位置，保持蓝色、线条粗细与文字基线一致；底座不增加课表的两行高度。课程条目的基础圆角为 8px，当前背景沿用插画轮廓。分隔线和当前课程沿用课表已有配色。

### Inputs / Fields

搜索框和日期控件使用轻透明底、紧凑圆角及清楚的文字。搜索图标是装饰，输入框仍有明确的可访问名称；姓名筛选、只看未交和全部勾选维持可见操作。Sidecar 只截取真实组件的静态状态，不连接 API，也不代表真实名单或登记数据。

### Student tiles

姓名格包含真正的复选框。已交以蓝色复选框和勾线表示，未交同时取消勾选，并使用样板中的蓝灰底和细描边；不能仅靠颜色区分。Hover 提亮容器，键盘轮廓保持可见；人数、未交数和保存状态通过可读文字及 live region 更新。

### Dialogs & feedback

从首页进入班级管理，再打开作业上层弹窗；弹窗后仍是班级管理页面。作业登记采用样板的紧凑布局，宽度最多 840px，高度随内容变化；顶部选择学科、作业和日期，下方为搜索筛选与四列名单，窄屏两列。长名单独立滚动，底部保留人数、无作业、取消和保存操作；空名单不撑满窗口。自习管理宽度最多 540px，以粥生成的无角色书本、台灯与铅笔完整插画 `illustrations/study-reading.webp` 陪衬当前状态，按原比例缩放，时段与状态放在同组；用听声、复核、提醒、通知的图示流程代替处理方式说明，并只标记真实运行阶段。今日复核保留次数与额度条，具体阈值默认折叠为简短字段，底部保留刷新和暂停操作。首次同步没有配置时显示等待同步，不显示示例阈值或用量。两个流程均使用真实业务数据。原生 `dialog` 保留名称、说明、焦点管理及未保存确认，确认层继续使用相同材料。

载入、保存、无作业、空名单、离线、错误和成功分别有真实文案与可读反馈。保存中禁用冲突操作，失败保留当前选择；不能用静默关闭代替错误提示。成功提示使用状态语义，错误使用警告语义。创意工坊继续明确为预留入口。

## Do's and Don'ts

### Do:

- **Do** 把本规范限制在嵌入式教室首页、班级管理及同页作业流程，并以最终 CSS 和真实原生截图核对改动。
- **Do** 保留批准样板的字体、蓝白曲面、左侧日期与右侧分时段课表、圆角和层次；业务适配沿用真实数据与原生桥。
- **Do** 让镜片、高光和内容分层，保持文字与控件不变形。
- **Do** 同时保留液态玻璃、原版白色、降低透明度以及系统减少动态偏好的行为。
- **Do** 检查窄屏、低高度桌面、键盘焦点、姓名截断和弹窗底部操作。
- **Do** 使用实际的勾选、状态文字及错误反馈说明登记结果。

### Don't:

- **Don't** 将这份局部规范提升为教师端、其他页面、原生悬浮岛或原生共享样式已经迁移的声明。
- **Don't** 更换字体、降低操作字重，或重新为教室材质叠加背景模糊和边缘折射。
- **Don't** 对文字、图标、名单或整个弹窗做液态位移。
- **Don't** 为教室背景增加持续采样或动画循环，或在用户要求减少动态后继续录音装饰动画。
- **Don't** 给已有明确动作文字追加装饰性方向箭头，或通过隐藏全部名称压缩窄屏控件。
- **Don't** 把色带预览、组件示例名单或样板数据当成新的生产令牌或业务记录。
