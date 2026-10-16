import { readFile, mkdir, open, lstat, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PortableCourseClient, resolvePortableServiceDataDir, type PortableCourseClientSession } from "../lib/workbench/portable-course-client";

import { acquireLock } from "./portable-course-service";

const actions = ["health", "workspace", "add", "run", "status", "stop", "resume", "experience", "knowledge", "claim", "patrol_begin", "guidance", "observation", "proposals", "reply_receipt", "reply_uptake", "participation_choice", "stage", "finish", "patrol_end", "attention", "relogin_required"];

export async function runCourseCli(args = process.argv.slice(2)) {
  if (!args.length || args[0] === "--help") {
    process.stdout.write(`课程能力 CLI（不需要 Codex）\n用法: npm run --silent service:cli -- <action> [--input request.json] [--session default]\n省略 --input 时从 stdin 读取 JSON；health/workspace 可无输入。\n动作: ${actions.join(", ")}\n同一回合始终使用同一 --session。租约仅保存于私有数据目录，不输出。\n`); return;
  }
  const action = args.shift()!;
  if (!actions.includes(action)) throw new Error("CLI_ACTION_INVALID");
  let inputFile: string | undefined; let sessionName = "default";
  while (args.length) {
    const key = args.shift(); const value = args.shift();
    if (!value || (key !== "--input" && key !== "--session")) throw new Error("CLI_OPTIONS_INVALID");
    if (key === "--input") inputFile = value; else sessionName = value;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(sessionName)) throw new Error("CLI_SESSION_INVALID");
  let raw = inputFile ? await readFile(inputFile, "utf8") : "";
  if (!inputFile && !["health", "workspace"].includes(action)) {
    if (process.stdin.isTTY) throw new Error("CLI_JSON_INPUT_REQUIRED");
    for await (const chunk of process.stdin) { raw += chunk.toString(); if (raw.length > 1_500_000) throw new Error("CLI_BODY_LIMIT"); }
  }
  if (raw.length > 1_500_000) throw new Error("CLI_BODY_LIMIT");
  const body = z.record(z.string(), z.unknown()).parse(JSON.parse(raw || "{}"));
  const folder = path.join(resolvePortableServiceDataDir(), "cli-sessions");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if ((await lstat(folder)).isSymbolicLink()) throw new Error("CLI_SESSION_PATH_INVALID");
  const file = path.join(folder, `${sessionName}.json`);
  const release = await acquireLock(folder, `${sessionName}.json.lock`);
  let client: PortableCourseClient | undefined;
  try {
    let session: PortableCourseClientSession | undefined;
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error("CLI_SESSION_PATH_INVALID");
      session = JSON.parse(await readFile(file, "utf8"));
    }
    client = new PortableCourseClient({ session });
    const runId = body.runId === undefined ? undefined : z.string().uuid().parse(body.runId);
    const operation = body.operationKey === undefined ? undefined : z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).parse(body.operationKey);
    let value: unknown;
    switch (action) {
      case "health": value = await client.health(); break;
      case "workspace": value = await client.workspace(); break;
      case "add": value = await client.registerCourse((body.course ?? body) as Parameters<typeof client.registerCourse>[0]); break;
      case "run": value = await client.createCourseRun(body as Parameters<typeof client.createCourseRun>[0]); break;
      case "status": value = await client.getCourseRun(runId); break;
      case "stop": value = await client.stopCourseRun(runId); break;
      case "resume": value = await client.resumeCourseRun(runId); break;
      case "experience": value = await client.readCourseExperience(z.string().uuid().parse(body.courseId)); break;
      case "knowledge": value = await client.searchPublicPractice(body as Parameters<typeof client.searchPublicPractice>[0]); break;
      case "claim": value = await client.claimCourseRun(runId); break;
      case "patrol_begin": value = await client.patrolBegin(runId); break;
      case "guidance": value = await client.readCourseGuidance(runId); break;
      case "observation": value = await client.recordCourseObservation(body.observation as Parameters<typeof client.recordCourseObservation>[0], runId, operation); break;
      case "proposals": value = await client.saveCourseProposals(body.proposals as Parameters<typeof client.saveCourseProposals>[0], runId, operation); break;
      case "reply_receipt": value = await client.recordReplyReceipt(body.receipt as Parameters<typeof client.recordReplyReceipt>[0], runId, operation); break;
      case "reply_uptake": value = await client.recordReplyUptake(body.uptake as Parameters<typeof client.recordReplyUptake>[0], runId, operation); break;
      case "participation_choice": value = await client.recordParticipationChoice(body.choice as Parameters<typeof client.recordParticipationChoice>[0], runId, operation); break;
      case "stage": value = await client.recordEditorReadback(body.receipt as Parameters<typeof client.recordEditorReadback>[0], runId, operation); break;
      case "finish": value = await client.finishCourseRun(z.string().parse(body.summary), runId, operation); break;
      case "patrol_end": value = await client.patrolEnd(z.string().parse(body.summary), runId, operation); break;
      case "attention": value = await client.reportCourseAttention(z.string().parse(body.message), runId); break;
      case "relogin_required": value = await client.markCourseReloginRequired(z.string().parse(body.message), runId); break;
    }
    process.stdout.write(JSON.stringify(value) + "\n");
  } finally {
    try {
      if (client) {
        const temporary = `${file}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(client.exportSession())); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
      }
    } finally { await release(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCourseCli().catch(error => {
    // Schema errors can embed supplied material; emit only stable error codes.
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : "COURSE_CALL_FAILED";
    process.stderr.write(JSON.stringify({ error: code }) + "\n"); process.exitCode = 1;
  });
}
