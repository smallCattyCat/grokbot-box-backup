#!/usr/bin/env node
/**
 * cmooc-mcp — stdio MCP for Grok Bot workbench ledger/lock operations.
 * Control plane via cmoocctl; everything else via scripts/mcp-bridge.ts.
 * No forum publish / authorize-publish / realPublishEnabled flips / cookie export.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_CMOOC_ROOT = "/workspace/cmooc";
const CMOOC_ROOT = process.env.CMOOC_ROOT || DEFAULT_CMOOC_ROOT;

const SECRET_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|satoken|authorization|cookie|credential)/i;

function assertCmoocRoot() {
  const ctl = path.join(CMOOC_ROOT, "scripts", "cmoocctl.ts");
  const bridge = path.join(CMOOC_ROOT, "scripts", "mcp-bridge.ts");
  if (!fs.existsSync(ctl)) {
    throw new Error(
      `CMOOC_ROOT looks wrong: missing ${ctl} (CMOOC_ROOT=${CMOOC_ROOT})`
    );
  }
  if (!fs.existsSync(bridge)) {
    throw new Error(
      `CMOOC_ROOT looks wrong: missing ${bridge} (CMOOC_ROOT=${CMOOC_ROOT})`
    );
  }
}

function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) {
        if (typeof v === "boolean" || v === null) {
          out[k] = v;
        } else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
          // Keep status-shaped objects (configured/valid) under secret-named keys
          out[k] = scrubSecrets(v);
        } else if (typeof v === "string") {
          out[k] = "[redacted]";
        } else {
          out[k] = "[redacted]";
        }
        continue;
      }
      out[k] = scrubSecrets(v);
    }
    return out;
  }
  return value;
}

function childEnv() {
  const env = { ...process.env };
  if (!env.LLM_MODE) env.LLM_MODE = "mock";
  env.CMOOC_ROOT = CMOOC_ROOT;
  if (!env.CMOOC_APP_ORIGIN) {
    env.CMOOC_APP_ORIGIN =
      env.APP_ORIGIN || env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000";
  }
  // Slim Nutstore ledger mirror (full ~335MB exceeds CopyToBox 100MB)
  const slimDb = "/workspace/cmooc-ledger-mirror/ledger-slim.db";
  const fullDb = "/workspace/cmooc-ledger-mirror/dev.db";
  const marker = "/workspace/cmooc-ledger-mirror/.use-mirror";
  if (!env.CMOOC_DATABASE_URL) {
    if (fs.existsSync(marker) || fs.existsSync(slimDb) || fs.existsSync(fullDb)) {
      if (fs.existsSync(slimDb)) {
        env.CMOOC_DATABASE_URL = `file:${slimDb}`;
      } else if (fs.existsSync(fullDb)) {
        env.CMOOC_DATABASE_URL = `file:${fullDb}`;
      }
    }
  }
  if (env.CMOOC_DATABASE_URL) {
    env.DATABASE_URL = env.CMOOC_DATABASE_URL;
  }
  if (!env.CMOOC_LEDGER_DB) {
    if (fs.existsSync(slimDb)) env.CMOOC_LEDGER_DB = slimDb;
    else env.CMOOC_LEDGER_DB = slimDb;
  }
  return env;
}

function runTsx(scriptRel, args, { allowNonZero = true } = {}) {
  assertCmoocRoot();
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", scriptRel, ...args], {
      cwd: CMOOC_ROOT,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            `${scriptRel} produced no stdout (exit ${code}): ${stderr.trim() || "(no stderr)"}`
          )
        );
        return;
      }
      // Pretty-printed JSON (cmoocctl) is multi-line; try whole buffer first.
      // Fall back to last JSON line for scripts that emit progress then one object.
      let parsed = null;
      let parseErr = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        parseErr = err;
        const lines = trimmed.split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          try {
            parsed = JSON.parse(lines[i]);
            parseErr = null;
            break;
          } catch (lineErr) {
            parseErr = lineErr;
          }
        }
      }
      if (parsed === null) {
        reject(
          new Error(
            `${scriptRel} stdout was not JSON (exit ${code}): ${parseErr?.message}\n--- stdout ---\n${trimmed.slice(0, 2000)}\n--- stderr ---\n${stderr.slice(0, 1000)}`
          )
        );
        return;
      }
      if (!allowNonZero && code !== 0) {
        reject(
          new Error(
            `${scriptRel} exited ${code}: ${JSON.stringify(parsed).slice(0, 500)}`
          )
        );
        return;
      }
      resolve({
        exitCode: code ?? 1,
        result: scrubSecrets(parsed),
        stderr: stderr.trim() || undefined
      });
    });
  });
}

function runCmoocctl(args) {
  return runTsx("scripts/cmoocctl.ts", args);
}

function runBridge(op, flagArgs = []) {
  return runTsx("scripts/mcp-bridge.ts", [op, ...flagArgs]);
}

function toolText(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

function toolError(err) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            error: {
              code: "CMOOC_MCP_INVOKE_FAILED",
              message: err instanceof Error ? err.message : String(err)
            }
          },
          null,
          2
        )
      }
    ]
  };
}

function pushFlag(args, name, value) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "boolean") {
    if (value) args.push(`--${name}`);
    return;
  }
  args.push(`--${name}`, String(value));
}

const server = new McpServer({
  name: "cmooc-mcp",
  version: "0.4.0"
});

// --- Control plane (cmoocctl) ---

server.registerTool(
  "cmooc_manifest",
  {
    title: "cMOOC control manifest",
    description:
      "Read-only control-plane capability manifest. Same as cmoocctl manifest --json. No secrets, no publish."
  },
  async () => {
    try {
      const { result } = await runCmoocctl(["manifest", "--json"]);
      return toolText(result);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.registerTool(
  "cmooc_status",
  {
    title: "cMOOC control status",
    description: "Read-only desensitized control-plane status. Same as cmoocctl status."
  },
  async () => {
    try {
      const { result } = await runCmoocctl(["status"]);
      return toolText(result);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.registerTool(
  "cmooc_adapter_doctor",
  {
    title: "cMOOC adapter doctor",
    description:
      "Read-only adapter auth summary (no credential values). Same as cmoocctl adapter doctor. Default adapterId is cmooc.",
    inputSchema: {
      adapterId: z
        .string()
        .min(1)
        .optional()
        .describe("Adapter id for doctor; default cmooc")
    }
  },
  async ({ adapterId }) => {
    try {
      const id = adapterId && adapterId.trim() ? adapterId.trim() : "cmooc";
      const { result } = await runCmoocctl([
        "adapter",
        "doctor",
        "--adapter",
        id
      ]);
      return toolText(result);
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Bridge helpers ---

function bridgeTool(name, meta, op, buildArgs) {
  server.registerTool(name, meta, async (input = {}) => {
    try {
      const args = buildArgs ? buildArgs(input) : [];
      const { result } = await runBridge(op, args);
      return toolText(result);
    } catch (err) {
      return toolError(err);
    }
  });
}

bridgeTool(
  "cmooc_autonomy_status",
  {
    title: "Autonomy status",
    description:
      "Autonomy runtime health, due invocations, workerWake. Offline via prisma (same spirit as GET /api/autonomy/status)."
  },
  "autonomy_status"
);

bridgeTool(
  "cmooc_soak_readiness",
  {
    title: "Autonomy soak readiness",
    description: "Autonomy soak readiness receipt from runtime health."
  },
  "soak_readiness"
);

bridgeTool(
  "cmooc_governance_get",
  {
    title: "Governance get",
    description:
      "Current governance summary. Optional courseAlias for single-course safeGovernanceSummary; omit for list view. Flags documented in payload.",
    inputSchema: {
      courseAlias: z
        .string()
        .min(1)
        .optional()
        .describe("Course alias; omit for full list view")
    }
  },
  "governance_get",
  ({ courseAlias }) => {
    const args = [];
    pushFlag(args, "course", courseAlias);
    return args;
  }
);

bridgeTool(
  "cmooc_course_graph_status",
  {
    title: "Course graph status",
    description: "Course content graph projection status for a course alias.",
    inputSchema: {
      courseAlias: z.string().min(1).describe("Course alias (required)")
    }
  },
  "course_graph_status",
  ({ courseAlias }) => {
    const args = [];
    pushFlag(args, "course", courseAlias);
    return args;
  }
);

bridgeTool(
  "cmooc_execution_agents_status",
  {
    title: "Execution agents status",
    description: "Safe execution account pool summary (no credentials)."
  },
  "execution_agents_status"
);

bridgeTool(
  "cmooc_operator_manifest",
  {
    title: "Operator manifest",
    description: "Operator registry manifest (paths, actions, endpoints)."
  },
  "operator_manifest"
);

bridgeTool(
  "cmooc_operator_status",
  {
    title: "Operator status",
    description: "Operator console status payload.",
    inputSchema: {
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("summary (default) or full"),
      fresh: z.boolean().optional().describe("Bypass caches when true")
    }
  },
  "operator_status",
  ({ detail, fresh }) => {
    const args = [];
    pushFlag(args, "detail", detail);
    pushFlag(args, "fresh", fresh);
    return args;
  }
);

bridgeTool(
  "cmooc_operator_auth_status",
  {
    title: "Operator auth status",
    description: "cMOOC auth readiness flags only — never dumps cookies/tokens."
  },
  "operator_auth_status"
);

bridgeTool(
  "cmooc_platform_readiness",
  {
    title: "Platform readiness",
    description:
      "Without target: LOCALAPPDATA/meta readiness. With target: inspectCmoocUiReadiness (playwright) or HTTP fallback.",
    inputSchema: {
      target: z
        .string()
        .min(1)
        .optional()
        .describe("cMOOC course URL for full UI readiness inspect")
    }
  },
  "platform_readiness",
  ({ target }) => {
    const args = [];
    pushFlag(args, "target", target);
    return args;
  }
);

bridgeTool(
  "cmooc_platform_live_opportunities",
  {
    title: "Live opportunities list",
    description:
      "List/summarize live opportunity receipts from LOCALAPPDATA runtime. Summarizes only — no forum body spam when containsForumText.",
    inputSchema: {
      observation: z
        .string()
        .optional()
        .describe("Optional observation receipt hash to load latest for"),
      limit: z.number().int().positive().max(100).optional().describe("Max receipts (default 20)")
    }
  },
  "platform_live_opportunities",
  ({ observation, limit }) => {
    const args = [];
    pushFlag(args, "observation", observation);
    if (limit !== undefined) pushFlag(args, "limit", limit);
    return args;
  }
);

bridgeTool(
  "cmooc_settings_get",
  {
    title: "Settings get",
    description:
      "Forum settings read-only (secrets scrubbed). Never flips realPublishEnabled."
  },
  "settings_get"
);

bridgeTool(
  "cmooc_workbench_runtime_get",
  {
    title: "Workbench runtime",
    description: "Local Codex harness readiness (ready / auth-required / unavailable)."
  },
  "workbench_runtime_get"
);

bridgeTool(
  "cmooc_workbench_runs_list",
  {
    title: "Workbench runs list",
    description: "Persistent workbench run history.",
    inputSchema: {
      limit: z.number().int().positive().max(100).optional().describe("Default 12")
    }
  },
  "workbench_runs_list",
  ({ limit }) => {
    const args = [];
    if (limit !== undefined) pushFlag(args, "limit", limit);
    return args;
  }
);

bridgeTool(
  "cmooc_workbench_run_get",
  {
    title: "Workbench run get",
    description: "Get one workbench run by id (in-memory then persistent; HTTP fallback).",
    inputSchema: {
      id: z.string().min(1).describe("Workbench run id")
    }
  },
  "workbench_run_get",
  ({ id }) => {
    const args = [];
    pushFlag(args, "id", id);
    return args;
  }
);

bridgeTool(
  "cmooc_workbench_brief",
  {
    title: "Workbench brief",
    description:
      "Anchored course opportunity brief. Requires courseAlias + invocationId + snapshotId.",
    inputSchema: {
      courseAlias: z.string().min(1),
      invocationId: z.string().min(1),
      snapshotId: z.string().min(1)
    }
  },
  "workbench_brief",
  ({ courseAlias, invocationId, snapshotId }) => {
    const args = [];
    pushFlag(args, "courseAlias", courseAlias);
    pushFlag(args, "invocationId", invocationId);
    pushFlag(args, "snapshotId", snapshotId);
    return args;
  }
);

bridgeTool(
  "cmooc_workbench_evidence",
  {
    title: "Workbench evidence",
    description:
      "Anchored course evidence workspace. Requires courseAlias + invocationId + snapshotId.",
    inputSchema: {
      courseAlias: z.string().min(1),
      invocationId: z.string().min(1),
      snapshotId: z.string().min(1)
    }
  },
  "workbench_evidence",
  ({ courseAlias, invocationId, snapshotId }) => {
    const args = [];
    pushFlag(args, "courseAlias", courseAlias);
    pushFlag(args, "invocationId", invocationId);
    pushFlag(args, "snapshotId", snapshotId);
    return args;
  }
);

bridgeTool(
  "cmooc_workbench_run_stop",
  {
    title: "Workbench run stop",
    description:
      "Local stop only (no forum write). Prefers HTTP to Next process owning the active run.",
    inputSchema: {
      id: z.string().min(1).describe("Workbench run id")
    }
  },
  "workbench_run_stop",
  ({ id }) => {
    const args = [];
    pushFlag(args, "id", id);
    return args;
  }
);

bridgeTool(
  "cmooc_maintenance_recover",
  {
    title: "Maintenance recover",
    description:
      "Recover expired autonomy invocation leases. Local DB only — no forum write."
  },
  "maintenance_recover"
);

bridgeTool(
  "cmooc_outcomes_reconcile",
  {
    title: "Outcomes reconcile",
    description:
      "Schedule/observe proximal outcomes from local HMAC event ledger. No external mutation."
  },
  "outcomes_reconcile"
);

bridgeTool(
  "cmooc_incident_ack",
  {
    title: "Incident acknowledge",
    description: "Acknowledge autonomy incident (id + expectedEvidenceHash).",
    inputSchema: {
      id: z.string().min(1),
      expectedEvidenceHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("SHA-256 hex evidence hash")
    }
  },
  "incident_ack",
  ({ id, expectedEvidenceHash }) => {
    const args = [];
    pushFlag(args, "id", id);
    pushFlag(args, "expectedEvidenceHash", expectedEvidenceHash);
    return args;
  }
);

bridgeTool(
  "cmooc_incident_resolve",
  {
    title: "Incident resolve",
    description: "Resolve autonomy incident (id + expectedEvidenceHash).",
    inputSchema: {
      id: z.string().min(1),
      expectedEvidenceHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("SHA-256 hex evidence hash")
    }
  },
  "incident_resolve",
  ({ id, expectedEvidenceHash }) => {
    const args = [];
    pushFlag(args, "id", id);
    pushFlag(args, "expectedEvidenceHash", expectedEvidenceHash);
    return args;
  }
);

bridgeTool(
  "cmooc_auth_check",
  {
    title: "Auth check",
    description:
      "Scrubbed auth check (configured/valid flags only). Never dumps cookies or satoken values."
  },
  "auth_check"
);

bridgeTool(
  "cmooc_shadow_budget_read",
  {
    title: "Shadow budget read",
    description:
      "Read today's or latest budget-YYYY-MM-DD.md from CMOOC_LEDGER_DIR (default agent ledger path).",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe("Override ledger directory")
    }
  },
  "shadow_budget_read",
  ({ dir }) => {
    const args = [];
    pushFlag(args, "dir", dir);
    return args;
  }
);

bridgeTool(
  "cmooc_ledger_sync_status",
  {
    title: "Ledger sync status",
    description:
      "Slim Nutstore ledger mirror status: path, size, mtime, tableCounts. Reads CMOOC_LEDGER_DB (default /workspace/cmooc-ledger-mirror/ledger-slim.db) via python3 sqlite3. Does not pull from Nutstore — Bot CopyToBox refreshes the file."
  },
  "ledger_sync_status"
);

bridgeTool(
  "cmooc_tape_get_by_post",
  {
    title: "Tape get by post",
    description:
      "Primary DecisionTapeEntry rows (+ AutonomyDecision when linkable) for forumPostId/postId. Exposes R7 decision DRAFT|WAIT|YIELD|ABSTAIN when present, kind, hashes, createdAt. AgentPatrolLedger only under deprecatedPatrolRows. Scrubs secrets; containsForumText forced false.",
    inputSchema: {
      forumPostId: z
        .string()
        .min(1)
        .optional()
        .describe("ForumPost.forumPostId (preferred)"),
      postId: z
        .string()
        .min(1)
        .optional()
        .describe("Alias for forumPostId, or ForumPost.id"),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("Max rows per collection (default 50)")
    }
  },
  "tape_get_by_post",
  ({ forumPostId, postId, limit }) => {
    const args = [];
    pushFlag(args, "forumPostId", forumPostId || postId);
    if (limit !== undefined) pushFlag(args, "limit", limit);
    return args;
  }
);

bridgeTool(
  "cmooc_tape_append",
  {
    title: "Tape append (DecisionTapeEntry)",
    description:
      "Append DecisionTapeEntry on local slim DB only when a real invocationId (ScheduledInvocation) exists — same hash-chain rules as lib/autonomy/decision-tape.ts. R7 decision DRAFT|WAIT|YIELD|ABSTAIN. Payload redacted (no url/content/cookie/token). Fail closed: no invented invocations, no AgentPatrolLedger writes.",
    inputSchema: {
      invocationId: z
        .string()
        .min(1)
        .describe("Required real ScheduledInvocation id"),
      forumPostId: z.string().min(1).optional().describe("ForumPost.forumPostId"),
      postId: z.string().min(1).optional().describe("Alias for forumPostId"),
      kind: z
        .string()
        .min(1)
        .describe("patrol_judgment | publish_receipt | decision_committed (or snake_case)"),
      decision: z
        .enum(["DRAFT", "WAIT", "YIELD", "ABSTAIN"])
        .optional()
        .describe("R7 four-state intent"),
      reasonCode: z.string().optional().describe("Structured reason code"),
      status: z.string().optional().describe("Default recorded"),
      payloadJson: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Extra redacted JSON fields (secrets / forum bodies / forbidden keys stripped)"),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Alias for payloadJson")
    }
  },
  "tape_append",
  ({
    invocationId,
    forumPostId,
    postId,
    kind,
    decision,
    reasonCode,
    status,
    payloadJson,
    payload
  }) => {
    const args = [];
    pushFlag(args, "invocationId", invocationId);
    pushFlag(args, "forumPostId", forumPostId || postId);
    pushFlag(args, "kind", kind);
    pushFlag(args, "decision", decision);
    pushFlag(args, "reasonCode", reasonCode);
    pushFlag(args, "status", status);
    const body = payloadJson !== undefined ? payloadJson : payload;
    if (body !== undefined) {
      pushFlag(args, "payload", JSON.stringify(body));
    }
    return args;
  }
);


bridgeTool(
  "cmooc_patrol_begin",
  {
    title: "Patrol begin (claim ScheduledInvocation lease)",
    description:
      "Claim a real ScheduledInvocation id on the slim ledger under lease rules (SHADOW) for browser patrol / cmooc助手. Links AutonomyCourseManifest + OperationSchedule for courseAlias. leaseOwner=grok-patrol:<uuid>. Fail closed: unknown alias, missing schedule, lease_busy, governance emergencyHalt. Use returned invocationId with cmooc_tape_append.",
    inputSchema: {
      courseAlias: z.string().min(1).describe("AutonomyCourseManifest.alias (required)"),
      leaseSeconds: z
        .number()
        .int()
        .min(30)
        .max(604800)
        .optional()
        .describe("Lease TTL seconds (default 900)")
    }
  },
  "patrol_begin",
  ({ courseAlias, leaseSeconds }) => {
    const args = [];
    pushFlag(args, "courseAlias", courseAlias);
    if (leaseSeconds !== undefined) pushFlag(args, "leaseSeconds", leaseSeconds);
    return args;
  }
);

bridgeTool(
  "cmooc_patrol_end",
  {
    title: "Patrol end (complete invocation lease)",
    description:
      "Mark a patrol ScheduledInvocation completed (status completed, finishedAt) if still running. Optional leaseOwner must match when provided; without it, only grok-patrol:* leases are completed. Prevents zombie running leases.",
    inputSchema: {
      invocationId: z.string().min(1).describe("ScheduledInvocation id from cmooc_patrol_begin"),
      leaseOwner: z
        .string()
        .min(1)
        .optional()
        .describe("Optional leaseOwner from begin; must match if provided")
    }
  },
  "patrol_end",
  ({ invocationId, leaseOwner }) => {
    const args = [];
    pushFlag(args, "invocationId", invocationId);
    pushFlag(args, "leaseOwner", leaseOwner);
    return args;
  }
);

bridgeTool(
  "cmooc_list_capabilities",
  {
    title: "List capabilities",
    description:
      "Meta tool: all MCP tools with needsNext vs offline, plus explicit exclusions (no publish)."
  },
  "list_capabilities"
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
