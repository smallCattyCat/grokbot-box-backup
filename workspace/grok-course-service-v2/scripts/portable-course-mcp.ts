import { existsSync } from "node:fs";
import path from "node:path";

function packageRoot(): string {
  const configured = process.env.CMOOC_WORKBENCH_ROOT;
  if (configured) {
    const root = path.resolve(configured);
    if (existsSync(path.join(root, "package.json"))) return root;
    if (existsSync(path.join(root, "源码", "package.json"))) return path.join(root, "源码");
  }
  const cwd = path.resolve(process.cwd());
  return existsSync(path.join(cwd, "package.json")) ? cwd : existsSync(path.join(cwd, "源码", "package.json")) ? path.join(cwd, "源码") : cwd;
}

const root = packageRoot();
const port = process.env.CMOOC_SERVICE_PORT || "3050";
process.env.CMOOC_WORKBENCH_ROOT ||= root;
process.env.CMOOC_PORTABLE_MODE = "1";
process.env.CMOOC_SERVICE_DATA_DIR ||= path.join(root, ".cmooc-service-data");
// Keep the service's private middle-layer projection inside the same portable
// data root when the connector is launched directly.  The service launcher
// sets this too; mirroring it here avoids a connector-only finish/resume path
// accidentally falling back to a workstation LOCALAPPDATA tree.
process.env.LOCALAPPDATA ||= path.join(process.env.CMOOC_SERVICE_DATA_DIR, "private");
process.env.CMOOC_PORTABLE_SERVICE_ORIGIN ||= `http://127.0.0.1:${port}`;
process.env.CMOOC_WORKBENCH_ORIGIN ||= process.env.CMOOC_PORTABLE_SERVICE_ORIGIN;

async function main() {
  await import("./course-companion-mcp");
}

void main().catch(() => {
  process.stderr.write("课程插件连接失败。\n");
  process.exitCode = 1;
});
