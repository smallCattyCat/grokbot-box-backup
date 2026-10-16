# decision-reference v1 本地标注台

## 首批范围

首批冻结为 60 条，不自动扩批。抽样覆盖 2024/2025、三档结构评分、两类后续自然互动结果，并尽量分散作者。成员选择完成后，仅按匿名 `snapshot_key` 的域分离 SHA-256 稳定排列，再分配 `DR001..DR060`；显示顺序和编号不读取年度、抽样层或未来结果。标注页面隐藏抽样层、未来结果、原始 ID、课程和成员身份。

每条只填写三项：

1. `intervene`：`yes / no`；
2. `main_function`：`resource_connection / cognitive_conflict / emotional_support / none`；
3. `target_object`：`thread_author / specific_participant / thread_participants`。

`intervene=no` 时，服务端规范化为 `main_function=none`、`target_object=null`。

## 内容与时间边界

- 页面只加载 `decision_at` 及以前的主帖和互动事件。
- 正文只在本地服务与当前浏览器页面的易失内存中显示，不写入草稿或导出。
- 原始导出没有编辑历史或 `available_from`；界面固定显示 `final_export_revision_unknown`，不把最终导出正文声称为时点版本。
- `reference-manifest.json` 同时冻结成员摘要和显示顺序摘要；P3A 重跑、P3B `check` 与 `serve` 都会验证摘要及盲化排列。
- 旧版无摘要且仍为空标签的同一成员集合，只允许一次性改排并重编号；只要已有任一标签且需要改排就拒绝迁移。
- 首次创建 `selection-lock.json` 使用排他声明文件，避免两个本地编码进程同时接受不同批次。
- 标注不使用本地或在线模型，不访问外部网络，不触发论坛发布；运行时只使用 `127.0.0.1` 回环连接。

## 本地入口

先只读检查：

```powershell
npm run research:decision-review -- check --json
```

当前正式检查结果为 60 条、0 个 as-of 越界、正文不落盘、无网络调用。

人工需要开始首批编码时再运行：

```powershell
npm run research:decision-review -- serve --coder-id coder_a
```

服务只绑定 `127.0.0.1`，使用随机 fragment token，并校验 Host、Origin、CSP 与 `no-store`。默认浏览器会打开本地随机端口；停止服务使用 `Ctrl+C`。

## 输出

```text
%LOCALAPPDATA%\cmooc-research\p3b\decision-reference-v1
  ├─ selection-lock.json
  ├─ drafts
  └─ exports
```

草稿和导出采用原子写入，只含匿名稳定键、三项标签、coder ID、时间戳和 selection fingerprint。选择锁还记录成员/顺序摘要版本，用于阻止批次静默漂移。不会保存帖子正文、抽样层、未来结果或原始平台 ID。加载与保存期间界面锁定条目切换，并用请求代次和响应 `reference_id` 双重校验，避免快速操作把正文或标签错配到另一条。完成 60 条并导出后停止，不自动生成下一批。
