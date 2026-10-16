# 鹈鹕骑自行车 Bakeoff 记分卡

评估方式：基于生成的 HTML/SVG **代码结构**（元素种类、注释/关键字、车轮半径、是否成景），非浏览器截图目视。

## 结果总览

| 状态 | provider | model | 耗时 | 大小 | 备注 |
|---|---|---|---:|---:|---|
| 成功 | `opencode` | `space-bunny-free` (free) | 31791 ms | 12849 B | has_circle,has_ellipse,has_path,has_rect,has_line,has_g,bike_named,bird_named,wh |
| 成功 | `opencode` | `mimo-v2.6-flash-free` (free) | 220169 ms | 12694 B | has_circle,has_ellipse,has_path,has_rect,has_line,has_g,bike_named,bird_named,wh |
| 成功 | `opencode` | `big-pickle` (free) | 70864 ms | 4132 B | has_circle,has_ellipse,has_path,has_line,has_g,bike_named,bird_named,wheel_like_ |
| 成功 | `opencode` | `nemotron-3.5-lightning-free` (free) | 33946 ms | 1726 B | has_circle,has_ellipse,has_polygon,has_rect,has_line,bike_named,bird_named,wheel |
| 失败 | `opencode` | `muse-spark-1.3-contributor-free` (free) | 383 ms | 0 B | 地区不可用 |
| 失败 | `opencode` | `nemotron-3-ultra-free` (free) | 1543 ms | 0 B | 上游过载 503 |
| 失败 | `opencode` | `longcat-2.5-preview-free` (free) | 300076 ms | 0 B | generate 超时(300s) |
| 成功 | `opencode` | `step-5-preview-free` (free) | 159118 ms | 11107 B | has_circle,has_ellipse,has_path,has_rect,has_line,has_g,bike_named,bird_named,wh |
| 成功 | `opencode-go` | `longcat-2.5-preview-free` (free) | 189263 ms | 7468 B | has_circle,has_ellipse,has_path,has_rect,has_line,has_g,bike_named,bird_named,wh |
| 失败 | `opencode-go` | `step-5-preview-free` (free) | 300120 ms | 0 B | generate 超时(300s) |
| 成功 | `opencode-go` | `claude-haiku-5-5` (paid) | 13188 ms | 5474 B | has_circle,has_ellipse,has_path,has_rect,has_line,has_g,bike_named,bird_named,wh |

## 成功模型评分（每项 1–5，总分 25）

| 排名 | 模型 | 有效SVG | 鹈鹕可识别 | 自行车完整 | 构图 | 速度 | 总分 |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | `opencode-go/claude-haiku-5-5` | 5 | 5 | 5 | 5 | 5 | **25** |
| 2 | `opencode/space-bunny-free` | 5 | 5 | 5 | 5 | 4 | **24** |
| 3 | `opencode/step-5-preview-free` | 5 | 5 | 5 | 5 | 2 | **22** |
| 4 | `opencode/nemotron-3.5-lightning-free` | 5 | 4 | 5 | 3 | 4 | **21** |
| 5 | `opencode/big-pickle` | 5 | 5 | 5 | 3 | 3 | **21** |
| 6 | `opencode-go/longcat-2.5-preview-free` | 5 | 5 | 5 | 5 | 1 | **21** |
| 7 | `opencode/mimo-v2.6-flash-free` | 5 | 5 | 5 | 5 | 1 | **21** |

## 简评（按代码事实）

- **`opencode-go/claude-haiku-5-5`**：付费参照：约 13s 最快；双轮+frame/pedal/beak 等齐全，中等复杂度（约 5.5KB）。
- **`opencode/space-bunny-free`**：HTML+SVG 完整；双轮半径约 80；大量 path/ellipse；含 pouch/wing、车架/踏板关键字与场景（sky/ground/sun）。细节最丰富之一，约 32s。
- **`opencode/step-5-preview-free`**：Zen 侧 step-5：双轮、多 path、有鸟/车关键字与场景元素；约 11KB，耗时约 159s。
- **`opencode/nemotron-3.5-lightning-free`**：最小可用：双轮半径 35、polygon/ellipse 拼鸟、有 pedal/frame 注释；几乎无 path、无场景，约 1.7KB / 34s。
- **`opencode/big-pickle`**：中等完整：双轮半径 40、注释列出 wheels/frame/pedals/pelican 部件；元素较少（约 4KB），构图偏简。
- **`opencode-go/longcat-2.5-preview-free`**：Go 侧 longcat 成功（Zen 同名超时）：双轮、path/line 较多，有 pelican/bike 部件注释风格结构；约 7.5KB / 189s。
- **`opencode/mimo-v2.6-flash-free`**：结构很完整：双轮半径约 95、显式 beak/pouch/wing id、车架踏板、场景层次多。体积大但耗时最长（约 220s）。

## 失败原因

- `muse-spark-1.3-contributor-free`：地区不可用（503 Country）。
- `nemotron-3-ultra-free`：Nvidia 上游过载（503）。
- `opencode/longcat-2.5-preview-free`：generate 300s 超时；同模型在 `opencode-go` 可用。
- `opencode-go/step-5-preview-free`：generate 300s 超时；同模型在 `opencode`（Zen）可用。

## 结论（免费模型）

1. **综合质量首选**：`opencode/space-bunny-free`（结构最完整之一）。
2. **免费里最快**：`opencode/space-bunny-free`（31791 ms）。
3. **细节最密**：`opencode/space-bunny-free`（12849 B）。
4. **付费参照 Haiku 5.5**：速度明显更快，质量中上，适合当默认；免费任务可优先 space-bunny / step-5 / mimo。

文件入口：`index.html`（链接各作品）、`results.jsonl`（原始元数据）。