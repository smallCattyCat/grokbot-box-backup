# 通用 v2 课程清单示例

这两份文件使用纯 synthetic 域名和课程引用，可直接用于理解字段和校验关系，不能访问
真实平台。

接入一门目标课程时：

1. 把 template 复制为 `configs/courses/<alias>-course.template.json`；
2. 把实际 manifest 放到部署机的 `COURSE_MANIFEST_DIR/<alias>-course.json`；
3. 同时替换 `platformId`、`adapterId`、课程引用、规范地址、允许 origins 和两个 SHA-256；
4. template 与 manifest 的绑定字段必须逐字一致；
5. 先注册只读 observer，再运行 `OBSERVE` 或 `SHADOW`。

`courseIdHash` 是 UTF-8 课程引用的 SHA-256；`canonicalUrlHash` 是标准化 HTTPS URL
字符串的 SHA-256。实际 manifest 不得包含凭据、Cookie、token、课程正文或身份。
