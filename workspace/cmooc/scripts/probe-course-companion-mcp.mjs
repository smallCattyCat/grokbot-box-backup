import { spawn } from "node:child_process";
const child = spawn("npx", ["tsx", "scripts/course-companion-mcp.ts"], {
  cwd: "/workspace/cmooc",
  env: {
    ...process.env,
    LOCALAPPDATA: "/workspace/cmooc/.localappdata",
    CMOOC_WORKBENCH_ORIGIN: "http://127.0.0.1:3017",
    CMOOC_WORKBENCH_ROOT: "/workspace/cmooc",
  },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}
child.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error("non-json", line); continue; }
    if (msg.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    } else if (msg.id === 2) {
      const names = (msg.result?.tools || []).map((t) => t.name);
      console.log(JSON.stringify({ ok: true, tools: names }, null, 2));
      child.kill();
      process.exit(0);
    }
  }
});
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "0" },
  },
});
setTimeout(() => { console.error("timeout"); process.exit(1); }, 25000);
