import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SOURCE_ROOT, TSX_CLI, MCP_SCRIPT, commandEnv, stringEnv, freePort, runCommand,
  startService, stopService, waitForHealth, mcpText, asObject } from "./smoke-portable-course-service";

export async function smokeR2() {
  const data = await mkdtemp(path.join(os.tmpdir(), "cmooc-r2-smoke-"));
  const port = await freePort(); const env = { ...commandEnv(data, port), CMOOC_MCP_SESSION: "r2-smoke" };
  const base = new URL(`http://127.0.0.1:${port}`);
  let service: ReturnType<typeof startService> | undefined;
  let client: Client | undefined; let transport: StdioClientTransport | undefined;
  const close = async () => { await client?.close().catch(() => undefined); await transport?.close().catch(() => undefined); client = undefined; transport = undefined; };
  const connect = async () => {
    transport = new StdioClientTransport({ command: process.execPath, args: [TSX_CLI, MCP_SCRIPT], cwd: SOURCE_ROOT, env: stringEnv(env), stderr: "pipe" });
    client = new Client({ name: "course-r2-validation", version: "2" }); await client.connect(transport);
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client!.callTool({ name, arguments: args });
    const value = JSON.parse(mcpText(result, name));
    assert.ok(!result.isError, `${name} failed with ${String(value.code || "unknown")}`);
    assert.equal(JSON.stringify(value).includes("leaseToken"), false);
    return value;
  };
  const checks: string[] = [];
  try {
    // Environment preflight must repair absent caller variables itself.
    delete (env as NodeJS.ProcessEnv).LOCALAPPDATA;
    await runCommand(["setup"], env); service = startService(env);
    const first = await waitForHealth(base, service); assert.equal(first.primaryProtocol, "course-companion/v2");
    await connect();
    const identity = await call("get_runtime_identity", {});
    assert.equal(identity.namespaceId, first.namespaceId);
    const course = await call("register_course", { course: { title: "Synthetic shared page", entryUrl: "https://example.invalid/course/r2", budget: 1 } });
    const courseId = String(course.id);
    const run = await call("create_course_run", { courseId, requestId: randomUUID(), mode: "observe" });
    const runId = String(run.id);
    const claimed = await call("claim_course_run", { runId });
    const sameClaim = await call("claim_course_run", { runId });
    assert.equal(sameClaim.run.attempt, claimed.run.attempt);
    const at = new Date(Date.now() - 1500).toISOString();
    const observed = {
      courseUrl: "https://example.invalid/course/r2", observedAt: at, scope: "selected_discussions", complete: false,
      expectedDiscussions: null, coverageNote: "Synthetic shared-page lower-bound observation.",
      pages: [{ url: "https://example.invalid/course/r2", itemCount: 2, terminal: false }],
      discussions: ["D1", "D2"].map((ref, index) => ({ ref, stableKey: `synthetic-${ref}`, url: "https://example.invalid/course/r2",
        title: `Synthetic ${ref}`, summary: "Synthetic observation only", complete: true,
        continuation: { kind: index === 0 ? "acknowledgement" : "explanation_advance", evidenceRefs: [`${ref}-reply`], interpretedAt: at, followup: index === 0 ? "needed" : "unknown" } })),
      posts: ["D1", "D2"].flatMap(ref => [
        { ref: `${ref}-root`, discussionRef: ref, parentRef: null, actorAlias: "A", role: "learner", createdAt: new Date(Date.now() - 86_400_000).toISOString(), url: "https://example.invalid/course/r2" },
        { ref: `${ref}-reply`, discussionRef: ref, parentRef: `${ref}-root`, actorAlias: "B", role: "learner", createdAt: new Date(Date.now() - 5000).toISOString(), url: "https://example.invalid/course/r2" }
      ])
    };
    await call("record_course_observation", { runId, operationKey: "observe-shared", observation: observed });
    await close(); await connect();
    await call("read_course_guidance", { runId });
    checks.push("connector-restart-retains-lease");
    await stopService(service); service = startService(env);
    const second = await waitForHealth(base, service);
    assert.notEqual(second.instanceId, first.instanceId); assert.equal(second.namespaceId, first.namespaceId);
    await call("read_course_guidance", { runId });
    checks.push("service-restart-retains-session-and-environment");
    const malformed = await client!.callTool({ name: "record_course_observation", arguments: { runId, observation: { ...observed, courseUrl: "https://another.invalid/course" } } });
    assert.equal(malformed.isError, true);
    const failure = asObject(JSON.parse(mcpText(malformed, "invalid scope")), "structured failure");
    assert.equal(failure.stage, "observation"); assert.equal(failure.code, "COURSE_MISMATCH");
    assert.ok(failure.recoveryAction);
    checks.push("structured-recoverable-errors");
    const proposals = ["D1", "D2"].map(discussionRef => ({ discussionRef, decision: "YIELD", reason: "保留真人交流机会，同时分别判断接续功能。", draft: "" }));
    const saved = await call("save_course_proposals", { runId, operationKey: "shared-proposals", proposals });
    assert.equal(saved.middleLayer.results.length, 2);
    const results = saved.middleLayer.results as Array<Record<string, unknown>>;
    assert.notEqual(results[0].decisionKey, results[1].decisionKey);
    assert.notEqual(results[0].peerContinuation, "true");
    assert.equal(results[1].peerContinuation, "true");
    const summary = await call("get_course_summary", { courseId });
    const rendered = JSON.stringify(summary);
    assert.ok(rendered.includes("acknowledgement")); assert.ok(rendered.includes("explanation_advance"));
    checks.push("shared-url-distinct-identity-and-functional-summary");
    const done = await call("finish_course_run", { runId, operationKey: "finish-r2", summary: "Synthetic R2 verification complete." });
    assert.equal(done.status, "completed");
    await close(); await connect();
    const replay = await call("finish_course_run", { runId, operationKey: "finish-r2", summary: "Synthetic R2 verification complete." });
    assert.equal(replay.completionReadback, true); assert.equal(replay.newActionExecuted, false);
    checks.push("lost-finish-response-readback");
    const knowledge = await call("search_public_practice", { query: "反馈", limit: 2 });
    assert.equal(knowledge.knowledgeClass, "PUBLIC_CANDIDATE");
    assert.ok(knowledge.results.every((item: Record<string, unknown>) => item.knowledgeClass === "PUBLIC_CANDIDATE" && item.courseApprovalGranted === false && typeof item.label === "string"));
    checks.push("public-candidates-unambiguously-labelled");
    const next = await call("create_course_run", { courseId, requestId: randomUUID(), mode: "observe" });
    await call("claim_course_run", { runId: next.id });
    const nextObservedAt = new Date().toISOString();
    await call("record_course_observation", { runId: next.id, observation: { ...observed, observedAt: nextObservedAt, discussions: observed.discussions.map(d => ({ ...d, continuation: { ...d.continuation, interpretedAt: nextObservedAt } })) }, operationKey: "before-relogin" });
    await call("mark_course_relogin_required", { runId: next.id, message: "Synthetic login expiry" });
    const resumed = await call("resume_course_run", { runId: next.id });
    assert.ok(resumed.observation); assert.equal(resumed.status, "queued");
    await call("claim_course_run", { runId: next.id });
    await call("stop_course_run", { runId: next.id });
    checks.push("relogin-retains-partial-progress");
  } finally { await close(); if (service) await stopService(service); await rm(data, { recursive: true, force: true }); }
  console.log(JSON.stringify({ status: "PASS", schemaVersion: "portable-r2-smoke.v1", checks, syntheticOnly: true, realPublishEnabled: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) smokeR2().catch(error => {
  console.error(JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : "R2_SMOKE_FAILED" })); process.exitCode = 1;
});
