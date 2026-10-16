# Design QA — GPT 风格智能控制台空闲首页

## 对照基准

- 选定视觉稿：`C:\Users\tiany\.codex\generated_images\019ff33b-1c4e-75d1-8813-778aacb0e211\exec-59d0a3c9-e818-4a9b-86a6-990d65726a0d.png`
- 视觉稿尺寸：1487 × 1058。
- 最终实现截图：`C:\Users\tiany\Nutstore\2\我的坚果云\cMOOC智能学伴自动干预系统\源码\artifacts\design-qa\workbench-idle-gpt-theme-final-1440x1024.png`
- 验收视口：1440 × 1024；状态为空闲、课程已可信绑定、本机运行时已连接、存在一条可继续任务。
- 同屏对照：`C:\Users\tiany\Nutstore\2\我的坚果云\cMOOC智能学伴自动干预系统\源码\artifacts\design-qa\workbench-idle-gpt-theme-comparison.png`

## 实现结论

- 空闲首页收敛为“当前课程 → 单一任务输入 → 一条可继续任务”，不再常驻运行状态条、完整任务轨、工具时间线或匿名化内部编号。
- 当前课程优先显示经 Manifest 精确绑定并校验的真实课程名称；不能验证时使用“课程名称待核验”，不猜测、不显示内部 alias。
- 任务历史默认收起，只在右侧给出一条可继续任务；完整历史通过显式按钮打开抽屉。
- 输入区保留搜索与工具、启动研判、只读/真实发布关闭、本机连接状态与周期运行入口，但全部降为紧凑次级信息。
- 运行、完成、失败三态继续使用原有完整时间线；完成/失败显示“事件已收束”，运行中才显示 LIVE。
- 执行详情、工具证据、Manifest/Tape 等核查信息默认折叠，不影响可审计性。

## 视觉对照

- 对齐了视觉稿的近黑底色、青色细边、真实课程在输入上方、左侧主输入与右侧续接任务的两栏关系，以及大面积留白。
- 最终实现将输入高度控制为 128px，而不是逐像素复制视觉稿中更高的输入框。这是有意的产品取舍：保留 GPT 式聚焦感，同时避免重新挤占用户先前要求释放的控制台空间。
- 课程、输入、续接任务区域在原始尺寸对照图中均可辨读，因此未另做放大裁切；同时用浏览器 DOM 几何核对了关键区域的位置与溢出。

## 浏览器验收

- Idle：仅一个可见 H1；真实课程名可见；`bnu-test` 等内部 alias 不可见；页面横向和纵向溢出均为 0。
- History：关闭态遮罩 `visibility:hidden`，不进入可访问性树；打开后完整任务抽屉可用并恢复焦点路径。
- Schedule：切换后空闲输入面板为 `hidden + display:none`，页面只呈现周期运行内容；可返回任务输入。
- Running：受控演示在 queued/running 窗口显示 LIVE、停止入口、用户任务和时间线；课程平台写入保持 0。
- Completed：显示完整答复与“事件已收束”，不再显示 LIVE；执行详情默认折叠。
- Failed：历史失败任务显示“任务未完成”和重新启动入口；“事件已收束”，执行详情默认折叠。
- 浏览器控制台：0 errors，0 warnings。

## 回归中发现并修复

- 恢复请求的旧 `finally` 可能提前解锁空闲首页：增加 operation guard。
- 空闲首页曾隐藏本机运行时连接入口：补回紧凑状态。
- 终态曾继续显示 LIVE：改为按运行状态派生事件通道文案。
- 已完成但可续接任务显示为“已完成”：改为“可继续”。
- 周期运行切换后隐藏输入面板仍被高优先级 CSS 布局：增加 idle-scoped `[hidden]` 规则。
- 关闭的历史遮罩仍出现在可访问性树：关闭态显式隐藏。
- 课程 alias、会话路径和历史 API 中的内部标识可能进入默认展示：从用户投影中移除或改为可信名称/中性文案。
- 901–1080px 桌面与矮屏下两栏过紧：增加仅桌面的窄宽与短高度覆盖。

## 验证证据

- `npm run test:workbench`：223/223 通过。
- `npm run type-check`：通过。
- `npx next lint`：0 warnings，0 errors。
- `npm run build`：通过，32 个页面生成成功。
- 本地生产页：`http://127.0.0.1:3000/workbench` 返回 200，并使用最新构建实测。

final result: passed

---

# Design QA — Opportunity Canvas 证据工作区（2026-08-12）

## 视觉方向与概念图

- 使用内置 `imagegen` 生成概念方向：保持现有 ChatGPT 式近黑控制台与 38/62 并排
  Canvas，在一个任务面内以细线标签切换判断依据、事件变化、课程画像和研究证据；避免
  大屏、KPI 方块、渐变、玻璃和人物画像。
- 概念图：`artifacts/design-qa/slice2-evidence-canvas-concept-1440x1024.png`。
- 最终实现：`artifacts/design-qa/slice2-opportunity-canvas-1440x1024.png`、
  `slice2-opportunity-canvas-1024x768.png`、`slice2-opportunity-canvas-390x844.png`、
  `slice2-opportunity-canvas-320x700.png`。

## 视觉保真台账

1. 保留现有导航、对话主线、38/62 桌面分栏和青/琥珀/灰证据语义；没有新增一级汇报页。
2. 四个视角使用同一行轻量下划线标签，DOM 只渲染一个活动 `tabpanel`；证据复杂度按需
   展开，不纵向堆成四张报告卡。
3. 六段资格链以纵向细线表达首停，UNKNOWN 是中性合格状态；不显示模型榜单或伪造分数。
4. 课程画像使用两条紧凑分母条和三项解释事实，不用雷达图；unsupported 与相容范围
   保留证据边界。
5. 移动端顺序固定为页头、横向事项轨、唯一详情滚动区、底部只读边界；320px 四个短标签
   仍完整显示，无第二条标签横向滚动。
6. 最终实现比概念图更克制：判断依据保持单列可读，不加入概念图中额外的结论分栏；这是
   为 565px 详情宽度和移动端一致性作出的有意取舍。

## 浏览器验收

- 1440×1024：Canvas 856.8px，左事项轨 291px、详情 564.6px；单一 H1、单一活动面板，
  页面 `scrollWidth` 等于视口。
- 1024×768：桌面保持 38/62 非模态并排，背景可操作，不设置 `aria-modal` 或 `inert`。
- 390×844 与 320×700：Canvas 固定全屏，`aria-modal=true`，背景 `inert + aria-hidden`，
  body 滚动锁定；事项轨仅横滚，详情是唯一纵向滚动容器，页面无横向溢出。
- 键盘：事项轨 Arrow/Home/End、视角标签 Arrow/Home/End、移动 Tab/Shift+Tab 循环、
  Escape 关闭、关闭与 Escape 后精确归还原触发器焦点均实测通过；切事项/视角详情滚动
  复位为 0。
- 判断、变化、画像、研究四个视角均逐一打开核对；研究包按钮指向严格聚合端点，技术
  信息默认折叠。
- 浏览器控制台：0 errors，0 warnings。

## 工程验收

- `npm run test:workbench`：298/298 通过，临时 SQLite 应用 20 个 migration。
- `npm run type-check`：通过。
- Slice 2 定向 ESLint：通过。
- `git diff --check`：通过（仅已有 CRLF 转换提示）。
- `npm run build`：通过；生产路由包含 `/api/workbench/evidence` 和
  `/api/workbench/research-export`，且不包含临时视觉 QA 路由。

final result: passed

---

# Design QA — 今日课程简报与机会 Canvas（2026-08-12）

## 对照与实现证据

- 现有极简控制台基准：`C:\Users\tiany\.codex\visualizations\2026\08\12\019ff682-2058-7b22-928b-44daf2260289\product-audit\01-workbench-idle-desktop.png`
- 桌面空闲简报：`C:\Users\tiany\Nutstore\2\我的坚果云\cMOOC智能学伴自动干预系统\源码\artifacts\design-qa\slice1-workbench-brief-idle-1440x1024.png`
- 桌面机会 Canvas：`C:\Users\tiany\Nutstore\2\我的坚果云\cMOOC智能学伴自动干预系统\源码\artifacts\design-qa\slice1-workbench-canvas-1440x1024.png`
- 移动端简报与 Canvas：`slice1-workbench-brief-mobile-390x844.png`、`slice1-workbench-canvas-mobile-390x844.png`、`slice1-workbench-canvas-320x568.png`
- 这是现有设计系统内的小型功能扩展，直接以已验收控制台为视觉基准，没有生成新的概念图。

## 视觉保真台账

1. 保留近黑背景、细分隔线、青色主动作和大面积留白；顶部导航及原有输入区未改成汇报式卡片阵列。
2. 空闲态只增加两行简报入口，不常驻图表、模型分数或运行术语；主任务输入仍是视觉中心。
3. 桌面展开采用实测 38/62 的对话区/Canvas 比例；Canvas 是同一工作面的非模态并排窗口，不是新的一级页面。
4. Canvas 以事项轨、一个判断焦点、三关状态和两个动作组成；内部 hash、证据 code、论坛正文和身份不进入可见层。
5. 900px 以下改为全屏二级窗口；390px 与 320px 均无页面级横向溢出，事项轨保留触摸与键盘横向浏览但隐藏系统滚动条。
6. 只有一个可见 H1；事项轨使用 roving tabindex，移动端有焦点循环，Escape 关闭并在触发器仍存在时归还焦点。

## 浏览器与回归验收

- 视口：1440×1024、1280×720、1024×768、390×844、320×568。
- 1280 与 1024 桌面实测 Canvas 比例均为 0.38；操作按钮在 1280×720 内可见。
- 390px 顶栏为品牌行加五等分导航，所有入口可见；390px/320px 页面 `scrollWidth` 等于视口宽度。
- 移动端焦点从关闭按钮反向循环至末个证据动作，再正向回到关闭按钮；桌面 Escape 关闭后回到原简报触发器。
- “交给学伴研判”把安全只读提示送回输入框，保留精确 snapshot context，并明确不执行真实发布。
- 浏览器控制台：0 errors，0 warnings。
- `npm run test:workbench`：262/262 通过；`npm run type-check`、`npm run lint`、独立 `npm run build` 均通过。

final result: passed
