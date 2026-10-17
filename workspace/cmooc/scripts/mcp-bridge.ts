/**
 * JSON CLI dispatcher for cmooc-mcp.
 * Usage: npx tsx scripts/mcp-bridge.ts <op> [--flags]
 * Prints exactly one JSON object to stdout. Prefer direct lib/prisma;
 * HTTP fallback via CMOOC_APP_ORIGIN when awkward or cross-process.
 *
 * Forbidden: forum publish, authorize-publish, realPublishEnabled flips,
 * cookie/satoken export, unconstrained forum posts.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyMirrorDatabaseEnv,
  applyWorkbenchDatabaseEnv,
  ensureSlimAutonomyTables,
  ledgerSyncStatus,
  ledgerUseMirror,
  patrolBegin,
  patrolEnd,
  tapeAppend,
  tapeGetByPost
} from "./ledger-tape-ops";

const APP_ORIGIN =
  process.env.CMOOC_APP_ORIGIN?.trim() ||
  process.env.APP_ORIGIN?.trim() ||
  process.env.NEXT_PUBLIC_APP_URL?.trim() ||
  "http://127.0.0.1:3000";

const DEFAULT_LEDGER_DIR =
  "/home/box/agent-data/agents/596f4a8c-5093-4949-b843-6443e71c9dff/memory/cmooc-ledger";

const SECRET_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|satoken|authorization|cookie|credential)/i;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type Capability = {
  op: string;
  mcpTools: string[];
  needsNext: boolean;
  offline: boolean;
  mutatesLocal: boolean;
  description: string;
  args?: string[];
};

const CAPABILITIES: Capability[] = [
  {
    op: "list",
    mcpTools: [],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "List bridge ops"
  },
  {
    op: "list_capabilities",
    mcpTools: ["cmooc_list_capabilities"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Meta: all MCP tools + Next vs offline"
  },
  {
    op: "autonomy_status",
    mcpTools: ["cmooc_autonomy_status"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Autonomy health, due invocations, workerWake"
  },
  {
    op: "soak_readiness",
    mcpTools: ["cmooc_soak_readiness"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Autonomy soak readiness receipt"
  },
  {
    op: "governance_get",
    mcpTools: ["cmooc_governance_get"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description:
      "Governance summary; optional --course <alias>. Without course: list view.",
    args: ["--course"]
  },
  {
    op: "course_graph_status",
    mcpTools: ["cmooc_course_graph_status"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Course content graph projection status",
    args: ["--course (required)"]
  },
  {
    op: "execution_agents_status",
    mcpTools: ["cmooc_execution_agents_status"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Safe execution account pool summary"
  },
  {
    op: "operator_manifest",
    mcpTools: ["cmooc_operator_manifest"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Operator registry manifest"
  },
  {
    op: "operator_status",
    mcpTools: ["cmooc_operator_status"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Operator console status",
    args: ["--detail", "--fresh"]
  },
  {
    op: "operator_auth_status",
    mcpTools: ["cmooc_operator_auth_status"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "cMOOC auth readiness (no cookie dump)"
  },
  {
    op: "platform_readiness",
    mcpTools: ["cmooc_platform_readiness"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description:
      "UI readiness meta, or inspect with --target <courseUrl> (playwright)",
    args: ["--target"]
  },
  {
    op: "platform_live_opportunities",
    mcpTools: ["cmooc_platform_live_opportunities"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description:
      "List/summarize live opportunity receipts (no forum body spam)",
    args: ["--observation", "--limit"]
  },
  {
    op: "settings_get",
    mcpTools: ["cmooc_settings_get"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Forum settings (secrets scrubbed; realPublish never flipped)"
  },
  {
    op: "workbench_runtime_get",
    mcpTools: ["cmooc_workbench_runtime_get"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Local Codex harness readiness"
  },
  {
    op: "workbench_runs_list",
    mcpTools: ["cmooc_workbench_runs_list"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Persistent workbench run history",
    args: ["--limit"]
  },
  {
    op: "workbench_run_get",
    mcpTools: ["cmooc_workbench_run_get"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Get workbench run by id (memory then persistent)",
    args: ["--id (required)"]
  },
  {
    op: "workbench_brief",
    mcpTools: ["cmooc_workbench_brief"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Anchored course opportunity brief",
    args: ["--courseAlias", "--invocationId", "--snapshotId"]
  },
  {
    op: "workbench_evidence",
    mcpTools: ["cmooc_workbench_evidence"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Anchored course evidence workspace",
    args: ["--courseAlias", "--invocationId", "--snapshotId"]
  },
  {
    op: "workbench_run_stop",
    mcpTools: ["cmooc_workbench_run_stop"],
    needsNext: true,
    offline: false,
    mutatesLocal: true,
    description:
      "Stop in-process workbench run (needs Next for active server runs)",
    args: ["--id (required)"]
  },
  {
    op: "maintenance_recover",
    mcpTools: ["cmooc_maintenance_recover"],
    needsNext: false,
    offline: true,
    mutatesLocal: true,
    description: "Recover expired autonomy invocation leases (local only)"
  },
  {
    op: "outcomes_reconcile",
    mcpTools: ["cmooc_outcomes_reconcile"],
    needsNext: false,
    offline: true,
    mutatesLocal: true,
    description: "Schedule/observe proximal outcomes (local ledger only)"
  },
  {
    op: "incident_ack",
    mcpTools: ["cmooc_incident_ack"],
    needsNext: false,
    offline: true,
    mutatesLocal: true,
    description: "Acknowledge autonomy incident",
    args: ["--id", "--expectedEvidenceHash"]
  },
  {
    op: "incident_resolve",
    mcpTools: ["cmooc_incident_resolve"],
    needsNext: false,
    offline: true,
    mutatesLocal: true,
    description: "Resolve autonomy incident",
    args: ["--id", "--expectedEvidenceHash"]
  },
  {
    op: "auth_check",
    mcpTools: ["cmooc_auth_check"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Auth check scrubbed (never dumps cookies)"
  },
  {
    op: "shadow_budget_read",
    mcpTools: ["cmooc_shadow_budget_read"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description: "Read today's/latest shadow budget markdown from ledger dir",
    args: ["--dir"]
  },
  {
    op: "ledger_sync_status",
    mcpTools: ["cmooc_ledger_sync_status"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description:
      "Slim Nutstore ledger mirror status (path/size/mtime/tableCounts). CMOOC_LEDGER_DB default /workspace/cmooc-ledger-mirror/ledger-slim.db; raw sqlite via python3"
  },
  {
    op: "ledger_use_mirror",
    mcpTools: [],
    needsNext: false,
    offline: true,
    mutatesLocal: true,
    description:
      "Bridge-only: point CMOOC_LEDGER_DB / CMOOC_DATABASE_URL at slim mirror. Optional --source copies a box-local file into the mirror dir.",
    args: ["--source", "--preferFull"]
  },
  {
    op: "tape_get_by_post",
    mcpTools: ["cmooc_tape_get_by_post"],
    needsNext: false,
    offline: true,
    mutatesLocal: false,
    description:
      "Primary DecisionTapeEntry (+ AutonomyDecision when linkable) by forumPostId/postId. Exposes R7 decision DRAFT|WAIT|YIELD|ABSTAIN, kind, hashes, createdAt. AgentPatrolLedger only under deprecatedPatrolRows.",
    args: ["--forumPostId|--postId (required)", "--limit"]
  },
  {
    op: "tape_append",
    mcpTools: ["cmooc_tape_append"],
    needsNext: false,
    offline: true,
    mutatesLocal: true,
    description:
      "Append DecisionTapeEntry only when real invocationId exists (hash-chain rules). Accepts forumPostId, decision (DRAFT|WAIT|YIELD|ABSTAIN), kind, reasonCode, status, redacted payload. Fail closed — no AgentPatrolLedger writes, no invented ScheduledInvocation.",
    args: [
      "--invocationId (required)",
      "--kind (required)",
      "--forumPostId|--postId",
      "--decision (DRAFT|WAIT|YIELD|ABSTAIN)",
      "--reasonCode",
      "--status",
      "--payload (JSON object, redacted)"
    ]
  },
  {
    op: "patrol_begin",
    mcpTools: ["cmooc_patrol_begin"],
    needsNext: false,
    offline: true,
    mutatesLocal: true,
    description:
      "Claim a real ScheduledInvocation lease (SHADOW) on slim DB for browser patrol — linked to AutonomyCourseManifest + OperationSchedule. Fail closed on unknown alias, missing schedule, lease_busy, governance emergencyHalt. Returns invocationId for tape_append.",
    args: ["--courseAlias (required)", "--leaseSeconds (default 900)"]
  },
  {
    op: "patrol_end",
    mcpTools: ["cmooc_patrol_end"],
    needsNext: false,
    offline: true,
    mutatesLocal: true,
    description:
      "Mark a patrol ScheduledInvocation completed (status completed, finishedAt) when still running; optional leaseOwner match. Clears lease so ticks do not leave zombies.",
    args: ["--invocationId (required)", "--leaseOwner"]
  },
];

function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        if (typeof v === "boolean" || v === null) {
          out[k] = v;
        } else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
          // Status-shaped objects under secret-named keys (e.g. envSatoken.configured)
          out[k] = scrubSecrets(v);
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

function emit(payload: unknown, exitCode = 0): never {
  process.stdout.write(`${JSON.stringify(scrubSecrets(payload))}\n`);
  process.exit(exitCode);
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): never {
  emit(
    {
      ok: false,
      error: { code, message },
      externalMutationAttempted: false,
      containsForumText: false,
      ...extra
    },
    1
  );
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function flagStr(flags: Map<string, string | boolean>, name: string): string | undefined {
  const v = flags.get(name);
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function flagBool(flags: Map<string, string | boolean>, name: string): boolean {
  const v = flags.get(name);
  if (v === true) return true;
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return false;
}

function flagInt(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const v = flagStr(flags, name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function ensureEnv() {
  process.chdir(path.resolve(process.env.CMOOC_ROOT || process.cwd()));
  if (!process.env.LLM_MODE) process.env.LLM_MODE = "mock";
  // Prefer slim Nutstore mirror when marker / CMOOC_DATABASE_URL present
  applyMirrorDatabaseEnv();
  const { ensureAppEnvLoaded } = await import("../lib/env");
  ensureAppEnvLoaded();
  if (!process.env.LOCALAPPDATA) {
    process.env.LOCALAPPDATA = path.resolve(".localappdata");
  }
}

async function withPrisma<T>(fn: (prisma: import("@prisma/client").PrismaClient) => Promise<T>): Promise<T> {
  const { prisma } = await import("../lib/db");
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function httpJson(
  method: string,
  routePath: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const url = new URL(routePath, APP_ORIGIN).toString();
  const headers: Record<string, string> = {
    Accept: "application/json",
    Origin: APP_ORIGIN,
    "Sec-Fetch-Site": "same-origin"
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 2000) };
  }
  return { ok: res.ok, status: res.status, json };
}

function summarizeOpportunity(receipt: Record<string, unknown>, receiptHash: string) {
  const containsForumText = receipt.containsForumText === true;
  return {
    receiptHash,
    opportunityKey: receipt.opportunityKey ?? null,
    decision: receipt.decision ?? null,
    decisionMode: receipt.decisionMode ?? null,
    reasonCode: receipt.reasonCode ?? null,
    assessedAt: receipt.assessedAt ?? null,
    observationReceiptHash: receipt.observationReceiptHash ?? null,
    runtimeMode: receipt.runtimeMode ?? null,
    draftCreated: receipt.draftCreated === true,
    draftBodyPersisted: receipt.draftBodyPersisted === true,
    realPublishEnabled: false,
    containsForumText: false,
    forumTextOmitted: containsForumText,
    selectedFunction: receipt.selectedFunction ?? null,
    workloadCost: typeof receipt.workloadCost === "number" ? receipt.workloadCost : null
  };
}

async function listLiveOpportunities(opts: {
  observation?: string;
  limit: number;
}) {
  const { liveRuntimeOutputRoot, loadLatestLiveOpportunityForObservation, loadRuntimeReceipt } =
    await import("../lib/live-runtime/store");
  let root: string;
  try {
    root = liveRuntimeOutputRoot();
  } catch (err) {
    return {
      ok: true,
      opportunities: [],
      count: 0,
      note:
        err instanceof Error
          ? err.message
          : "LOCALAPPDATA unset; no live runtime root",
      containsForumText: false
    };
  }

  if (opts.observation) {
    const latest = await loadLatestLiveOpportunityForObservation(opts.observation, root);
    if (!latest) {
      return {
        ok: true,
        opportunities: [],
        count: 0,
        observation: opts.observation,
        containsForumText: false
      };
    }
    return {
      ok: true,
      opportunities: [
        summarizeOpportunity(
          latest.receipt as unknown as Record<string, unknown>,
          latest.receiptHash
        )
      ],
      count: 1,
      observation: opts.observation,
      containsForumText: false
    };
  }

  const directory = path.join(root, "opportunities");
  let names: string[] = [];
  try {
    names = (await fsp.readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/i.test(name))
      .sort()
      .reverse()
      .slice(0, Math.max(1, Math.min(opts.limit, 100)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        opportunities: [],
        count: 0,
        root: directory,
        containsForumText: false
      };
    }
    throw err;
  }

  const opportunities = [];
  for (const name of names) {
    try {
      const loaded = await loadRuntimeReceipt("opportunities", name.slice(0, -5), root);
      opportunities.push(
        summarizeOpportunity(
          loaded.receipt as unknown as Record<string, unknown>,
          loaded.receiptHash
        )
      );
    } catch {
      // skip corrupt
    }
  }
  return {
    ok: true,
    opportunities,
    count: opportunities.length,
    root: directory,
    containsForumText: false
  };
}

async function courseGraphStatus(courseAlias: string) {
  return withPrisma(async (prisma) => {
    const snapshot = await prisma.courseContentGraphSnapshot.findFirst({
      where: { courseAlias },
      orderBy: [{ asOfAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        worldSnapshotId: true,
        asOfAt: true,
        schemaVersion: true,
        coverageStatus: true,
        roleRegistryStatus: true,
        nodeCount: true,
        edgeCount: true,
        learnerNodeCount: true,
        worldSnapshot: { select: { invocationId: true } }
      }
    });
    if (!snapshot) {
      return {
        ok: true,
        courseAlias,
        status: "not_projected",
        realPublishEnabled: false,
        containsForumText: false
      };
    }
    const scanRun = await prisma.courseScanRun.findUnique({
      where: { invocationId: snapshot.worldSnapshot.invocationId },
      select: { id: true, coverageJson: true }
    });
    return {
      ok: true,
      courseAlias,
      status: "projected",
      schemaVersion: snapshot.schemaVersion,
      asOfAt: snapshot.asOfAt.toISOString(),
      coverageStatus: snapshot.coverageStatus,
      roleRegistryStatus: snapshot.roleRegistryStatus,
      nodeCount: snapshot.nodeCount,
      edgeCount: snapshot.edgeCount,
      learnerNodeCount: snapshot.learnerNodeCount,
      hasScanRun: Boolean(scanRun),
      realPublishEnabled: false,
      containsForumText: false
    };
  });
}

async function governanceGet(courseAlias?: string) {
  if (courseAlias) {
    return withPrisma(async (prisma) => {
      const { loadCourseManifest } = await import("../lib/autonomy/course-manifest");
      const {
        loadCourseOperationGovernance,
        safeGovernanceSummary
      } = await import("../lib/autonomy/course-operation-governance");
      try {
        const manifest = await loadCourseManifest(courseAlias);
        const verified = await loadCourseOperationGovernance({
          prisma,
          manifest,
          requireExecutable: false
        });
        return {
          ok: true,
          courseAlias,
          summary: safeGovernanceSummary(verified),
          externalMutationAttempted: false,
          containsForumText: false
        };
      } catch (err) {
        return {
          ok: false,
          courseAlias,
          code:
            err instanceof Error && /^[a-z0-9_]+$/i.test(err.message)
              ? err.message
              : "governance_get_failed",
          message: err instanceof Error ? err.message : String(err),
          externalMutationAttempted: false,
          containsForumText: false,
          flags: {
            courseAliasRequired: true,
            requireExecutable: false,
            note: "Uses loadCourseManifest + loadCourseOperationGovernance; no lifecycle mutations."
          }
        };
      }
    });
  }

  // List view (same spirit as GET /api/autonomy/governance)
  return withPrisma(async (prisma) => {
    const {
      courseOperationGovernanceListOrderBy,
      currentCourseOperationGovernanceHashes,
      safeCourseOperationGovernanceState
    } = await import("../lib/autonomy/course-operation-governance");
    const { safeCourseOperationGovernanceTransitionState } = await import(
      "../lib/autonomy/course-operation-governance-lifecycle"
    );
    const { loadCourseManifest } = await import("../lib/autonomy/course-manifest");
    const { filterOperatorCourses } = await import("../lib/autonomy/operator-presentation");
    const now = new Date();
    const GOVERNANCE_VIEW_LIMIT = 200;
    const manifests = filterOperatorCourses(
      await prisma.autonomyCourseManifest.findMany({
        where: { enabled: true },
        select: {
          alias: true,
          manifestHash: true,
          realPublishEnabled: true,
          enabled: true
        }
      })
    );
    const visibleCourseAliases = manifests.map((m) => m.alias);
    const [policyWindow, transitionWindow] = await Promise.all([
      prisma.courseOperationGovernancePolicy.findMany({
        where: { courseAlias: { in: visibleCourseAliases } },
        take: GOVERNANCE_VIEW_LIMIT + 1,
        orderBy: courseOperationGovernanceListOrderBy()
      }),
      prisma.courseOperationGovernanceTransition.findMany({
        where: { courseAlias: { in: visibleCourseAliases } },
        take: GOVERNANCE_VIEW_LIMIT + 1,
        orderBy: [
          { courseAlias: "asc" },
          { createdAt: "desc" },
          { id: "desc" }
        ]
      })
    ]);
    const policiesTruncated = policyWindow.length > GOVERNANCE_VIEW_LIMIT;
    const transitionsTruncated = transitionWindow.length > GOVERNANCE_VIEW_LIMIT;
    const rows = policyWindow.slice(0, GOVERNANCE_VIEW_LIMIT);
    const transitionRows = transitionWindow.slice(0, GOVERNANCE_VIEW_LIMIT);
    const manifestHashes = new Map<string, string>();
    await Promise.all(
      manifests.map(async (manifestRow) => {
        try {
          const manifest = await loadCourseManifest(manifestRow.alias);
          if (
            manifest.alias === manifestRow.alias &&
            manifest.manifestHash === manifestRow.manifestHash &&
            manifestRow.realPublishEnabled === false &&
            manifest.realPublishEnabled === false
          ) {
            manifestHashes.set(manifestRow.alias, manifest.manifestHash);
          }
        } catch {
          // ignore
        }
      })
    );
    const currentHashes = currentCourseOperationGovernanceHashes(rows, now);
    const policies = rows.map((row) => ({
      ...safeCourseOperationGovernanceState({
        record: row,
        currentManifestHash: manifestHashes.get(row.courseAlias) ?? null,
        now
      }),
      isCurrent: currentHashes.has(row.governanceHash)
    }));
    const currentPolicies = policies.filter((row) => row.isCurrent);
    const transitions = transitionRows.map((row) =>
      safeCourseOperationGovernanceTransitionState(row)
    );
    return {
      ok: true,
      asOf: now.toISOString(),
      policies,
      transitions,
      pagination: {
        limit: GOVERNANCE_VIEW_LIMIT,
        policiesTruncated,
        transitionsTruncated,
        countsScope:
          policiesTruncated || transitionsTruncated ? "visible_window" : "complete"
      },
      counts: {
        total: policies.length,
        current: currentPolicies.length,
        history: policies.length - currentPolicies.length,
        transitions: transitions.length,
        active: currentPolicies.filter((r) => r.status === "active").length,
        paused: currentPolicies.filter((r) => r.status === "paused").length,
        revoked: currentPolicies.filter((r) => r.status === "revoked").length,
        expired: currentPolicies.filter((r) => r.status === "expired").length,
        emergencyHalt: currentPolicies.filter((r) => r.status === "emergency_halt").length,
        integrityInvalid: currentPolicies.filter((r) => r.status === "integrity_invalid").length,
        manifestStale: currentPolicies.filter((r) => r.status === "manifest_stale").length
      },
      flags: {
        courseAlias: "optional --course <alias> for single-course safeGovernanceSummary"
      },
      externalMutationAttempted: false,
      containsForumText: false
    };
  });
}

async function shadowBudgetRead(dirOverride?: string) {
  const ledgerDir = path.resolve(
    dirOverride || process.env.CMOOC_LEDGER_DIR || DEFAULT_LEDGER_DIR
  );
  if (!fs.existsSync(ledgerDir)) {
    return {
      ok: false,
      code: "ledger_dir_missing",
      ledgerDir,
      message: `Ledger dir not found: ${ledgerDir}`
    };
  }
  const names = (await fsp.readdir(ledgerDir))
    .filter((n) => /^budget-\d{4}-\d{2}-\d{2}\.md$/i.test(n))
    .sort()
    .reverse();
  if (names.length === 0) {
    return {
      ok: false,
      code: "budget_not_found",
      ledgerDir,
      message: "No budget-YYYY-MM-DD.md files"
    };
  }
  // Prefer today (America/Denver ≈ UTC-6); else latest
  const now = new Date();
  const denverMs = now.getTime() - 6 * 60 * 60 * 1000;
  const d = new Date(denverMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const todayName = `budget-${yyyy}-${mm}-${dd}.md`;
  const chosen = names.includes(todayName) ? todayName : names[0];
  const text = await fsp.readFile(path.join(ledgerDir, chosen), "utf8");
  return {
    ok: true,
    ledgerDir,
    file: chosen,
    isToday: chosen === todayName,
    todayDenver: `${yyyy}-${mm}-${dd}`,
    text,
    available: names.slice(0, 14)
  };
}

async function dispatch(op: string, flags: Map<string, string | boolean>) {
  switch (op) {
    case "list":
      return {
        ok: true,
        ops: CAPABILITIES.map((c) => c.op),
        count: CAPABILITIES.length
      };

    case "list_capabilities": {
      const controlPlane = [
        {
          name: "cmooc_manifest",
          needsNext: false,
          offline: true,
          mutatesLocal: false,
          via: "cmoocctl",
          description: "Control-plane capability manifest"
        },
        {
          name: "cmooc_status",
          needsNext: false,
          offline: true,
          mutatesLocal: false,
          via: "cmoocctl",
          description: "Desensitized control-plane status"
        },
        {
          name: "cmooc_adapter_doctor",
          needsNext: false,
          offline: true,
          mutatesLocal: false,
          via: "cmoocctl",
          description: "Adapter auth summary (no credential values)"
        }
      ];
      const bridgeTools = CAPABILITIES.filter((c) => c.mcpTools.length > 0).flatMap(
        (c) =>
          c.mcpTools.map((name) => ({
            name,
            op: c.op,
            needsNext: c.needsNext,
            offline: c.offline,
            mutatesLocal: c.mutatesLocal,
            via: "mcp-bridge",
            description: c.description,
            args: c.args ?? []
          }))
      );
      return {
        ok: true,
        appOrigin: APP_ORIGIN,
        tools: [...controlPlane, ...bridgeTools],
        count: controlPlane.length + bridgeTools.length,
        cutover: {
          tapeWritePath: "DecisionTapeEntry",
          tapeReadPrimary: "DecisionTapeEntry (+ AutonomyDecision when linkable)",
          r7Decisions: ["DRAFT", "WAIT", "YIELD", "ABSTAIN"],
          deprecatedReadCompat: "AgentPatrolLedger → deprecatedPatrolRows only",
          note: "MCP + cmooc助手 share the DecisionTape chain; AgentPatrolLedger is no longer the write path.",
          patrolLease: "cmooc_patrol_begin claims ScheduledInvocation under slim lease rules; cmooc_patrol_end completes it; tape_append still requires that real invocationId."
        },
        excluded: [
          "interventions authorize-publish / publish",
          "save-auth / cookie export",
          "realPublishEnabled=true",
          "unconstrained forum post"
        ]
      };
    }

    case "autonomy_status":
      await ensureSlimAutonomyTables();
      return withPrisma(async (prisma) => {
        const {
          getAutonomyRuntimeHealth,
          listDueAutonomyInvocations
        } = await import("../lib/autonomy/runtime-health");
        const now = new Date();
        const [health, due] = await Promise.all([
          getAutonomyRuntimeHealth({ prisma, now }),
          listDueAutonomyInvocations({ prisma, now })
        ]);
        return {
          ok: true,
          health,
          workerWake: health.workerWake,
          due,
          databaseRouting: "slim+autonomy-stubs",
          externalMutationAttempted: false,
          containsForumText: false
        };
      });

    case "soak_readiness":
      await ensureSlimAutonomyTables();
      return withPrisma(async (prisma) => {
        const { getAutonomyRuntimeHealth } = await import("../lib/autonomy/runtime-health");
        const health = await getAutonomyRuntimeHealth({ prisma, now: new Date() });
        return {
          ok: true,
          soakReadiness: health.soakReadiness,
          databaseRouting: "slim+autonomy-stubs",
          containsForumText: false
        };
      });

    case "governance_get":
      return governanceGet(flagStr(flags, "course"));

    case "course_graph_status": {
      const course = flagStr(flags, "course");
      if (!course || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(course)) {
        fail("COURSE_REQUIRED", "course_graph_status requires --course <alias>");
      }
      return courseGraphStatus(course);
    }

    case "execution_agents_status":
      return withPrisma(async (prisma) => {
        const { getSafeExecutionAccountPoolSummary } = await import(
          "../lib/autonomy/execution-account-pool-read-model"
        );
        try {
          const summary = await getSafeExecutionAccountPoolSummary({ prisma });
          return { ok: true, ...summary };
        } catch {
          return {
            ok: true,
            schemaVersion: "cmooc.execution-agent-pool-read-model.v1",
            configurationState: "unavailable",
            containsForumText: false
          };
        }
      });

    case "operator_manifest": {
      const { getOperatorManifest } = await import("../lib/operator-registry");
      return {
        ok: true,
        ...getOperatorManifest(),
        generatedAt: new Date().toISOString()
      };
    }

    case "operator_status": {
      // Operator console tables (AutoInterventionCandidate, AgentRun, …)
      // live on local prisma/dev.db — not on Nutstore slim. Keep ledger on slim.
      applyWorkbenchDatabaseEnv();
      const { getOperatorStatusPayload } = await import(
        "../lib/agent-console-operator-status"
      );
      const detail = flagStr(flags, "detail") === "full" ? "full" : "summary";
      const fresh = flagBool(flags, "fresh");
      return {
        ok: true,
        databaseRouting: "workbench-local",
        ...(await getOperatorStatusPayload({ detail, fresh }))
      };
    }

    case "operator_auth_status":
    case "auth_check": {
      const { getCmoocAuthStatus } = await import("../lib/forum/cmooc-auth-status");
      const status = await getCmoocAuthStatus();
      return { ok: true, ...status, cookiesExported: false };
    }

    case "platform_readiness": {
      const target = flagStr(flags, "target");
      const localAppData = process.env.LOCALAPPDATA || "";
      const evidenceDir = path.join(localAppData, "cmooc-research", "lift1", "evidence-v1");
      const meta = {
        ok: true,
        mode: target ? "inspect" : "meta",
        localAppDataConfigured: Boolean(localAppData),
        localAppData,
        evidenceDirExists: fs.existsSync(evidenceDir),
        appOrigin: APP_ORIGIN,
        containsForumText: false,
        externalMutationAttempted: false
      };
      if (!target) {
        return {
          ...meta,
          hint: "Pass --target <cMOOC course URL> to run inspectCmoocUiReadiness (playwright)."
        };
      }
      try {
        const { inspectCmoocUiReadiness } = await import(
          "../lib/platform-readiness/cmooc-ui-readiness"
        );
        const result = await inspectCmoocUiReadiness({ targetInput: target });
        return {
          ...meta,
          canonicalUrl: result.canonicalUrl,
          evidenceHash: result.evidenceHash,
          receipt: result.receipt
        };
      } catch (err) {
        // HTTP fallback if Next is up
        try {
          const http = await httpJson("POST", "/api/platform/readiness", {
            targetInput: target
          });
          return {
            ...meta,
            via: "http",
            httpStatus: http.status,
            result: http.json
          };
        } catch (httpErr) {
          return {
            ...meta,
            ok: false,
            code: "platform_readiness_failed",
            message: err instanceof Error ? err.message : String(err),
            httpError:
              httpErr instanceof Error ? httpErr.message : String(httpErr)
          };
        }
      }
    }

    case "platform_live_opportunities":
      return listLiveOpportunities({
        observation: flagStr(flags, "observation"),
        limit: flagInt(flags, "limit", 20)
      });

    case "settings_get":
      return withPrisma(async () => {
        const { getForumSettings } = await import("../lib/settings");
        const settings = await getForumSettings();
        return {
          ok: true,
          settings,
          note: "Read-only; bridge never flips realPublishEnabled",
          containsForumText: false
        };
      });

    case "workbench_runtime_get": {
      const { inspectCodexHarnessReadiness } = await import(
        "../lib/workbench/codex-app-server"
      );
      const readiness = await inspectCodexHarnessReadiness();
      if (readiness.ready) {
        return {
          ok: true,
          status: "ready",
          summary: "本机执行已连接。",
          canStartAuthorization: false
        };
      }
      if (readiness.code === "CODEX_AUTH_UNAVAILABLE") {
        return {
          ok: true,
          status: "auth-required",
          summary: readiness.summary,
          canStartAuthorization: true
        };
      }
      return {
        ok: true,
        status: "unavailable",
        summary: readiness.summary,
        canStartAuthorization: false
      };
    }

    case "workbench_runs_list": {
      const limit = flagInt(flags, "limit", 12);
      const { listPersistentWorkbenchRuns } = await import(
        "../lib/workbench/history-store"
      );
      try {
        const runs = await listPersistentWorkbenchRuns(
          Number.isFinite(limit) ? limit : 12
        );
        return {
          ok: true,
          schemaVersion: "cmooc.workbench-history.v1",
          runs,
          containsForumText: false
        };
      } catch (err) {
        return {
          ok: false,
          code: "WORKBENCH_RECOVERY_FAILED",
          message: err instanceof Error ? err.message : String(err)
        };
      }
    }

    case "workbench_run_get": {
      const id = flagStr(flags, "id");
      if (!id) fail("ID_REQUIRED", "workbench_run_get requires --id");
      const { isSafeRunId } = await import("../lib/workbench/contracts");
      if (!isSafeRunId(id)) {
        fail("WORKBENCH_INVALID_ID", "Invalid workbench run id");
      }
      const { getWorkbenchRun } = await import("../lib/workbench/run-store");
      const {
        loadPersistentWorkbenchRun,
        recoverInterruptedWorkbenchRuns
      } = await import("../lib/workbench/history-store");
      try {
        await recoverInterruptedWorkbenchRuns();
      } catch {
        // continue with best effort
      }
      const run = getWorkbenchRun(id) ?? (await loadPersistentWorkbenchRun(id));
      if (!run) {
        // Cross-process active run may only live in Next
        try {
          const http = await httpJson("GET", `/api/workbench/runs/${encodeURIComponent(id)}`);
          if (http.ok) return { ok: true, via: "http", run: http.json };
        } catch {
          // ignore
        }
        return { ok: false, code: "WORKBENCH_NOT_FOUND", id };
      }
      return { ok: true, run };
    }

    case "workbench_brief": {
      const courseAlias = flagStr(flags, "courseAlias");
      const invocationId = flagStr(flags, "invocationId");
      const snapshotId = flagStr(flags, "snapshotId");
      if (!courseAlias || !invocationId || !snapshotId) {
        fail(
          "BRIEF_ANCHOR_REQUIRED",
          "Requires --courseAlias --invocationId --snapshotId"
        );
      }
      const { getAnchoredCourseOpportunityBrief, CourseOpportunityBriefReadError } =
        await import("../lib/workbench/operator-read-model");
      try {
        const brief = await getAnchoredCourseOpportunityBrief({
          anchor: { courseAlias, invocationId, snapshotId }
        });
        return { ok: true, brief };
      } catch (err) {
        if (err instanceof CourseOpportunityBriefReadError) {
          return { ok: false, code: err.code, message: err.message };
        }
        return {
          ok: false,
          code: "BRIEF_UNAVAILABLE",
          message: err instanceof Error ? err.message : String(err)
        };
      }
    }

    case "workbench_evidence": {
      const courseAlias = flagStr(flags, "courseAlias");
      const invocationId = flagStr(flags, "invocationId");
      const snapshotId = flagStr(flags, "snapshotId");
      if (!courseAlias || !invocationId || !snapshotId) {
        fail(
          "EVIDENCE_ANCHOR_REQUIRED",
          "Requires --courseAlias --invocationId --snapshotId"
        );
      }
      const { getAnchoredCourseEvidenceWorkspace } = await import(
        "../lib/workbench/evidence-read-model"
      );
      const { CourseEvidenceWorkspaceReadError } = await import(
        "../lib/workbench/evidence-route-handler"
      );
      try {
        const workspace = await getAnchoredCourseEvidenceWorkspace({
          anchor: { courseAlias, invocationId, snapshotId }
        });
        return { ok: true, workspace };
      } catch (err) {
        if (err instanceof CourseEvidenceWorkspaceReadError) {
          return { ok: false, code: err.code, message: err.message };
        }
        return {
          ok: false,
          code: "EVIDENCE_UNAVAILABLE",
          message: err instanceof Error ? err.message : String(err)
        };
      }
    }

    case "workbench_run_stop": {
      const id = flagStr(flags, "id");
      if (!id) fail("ID_REQUIRED", "workbench_run_stop requires --id");
      const { isSafeRunId } = await import("../lib/workbench/contracts");
      if (!isSafeRunId(id)) {
        fail("WORKBENCH_INVALID_ID", "Invalid workbench run id");
      }
      // Prefer HTTP — active runs live in the Next process
      try {
        const http = await httpJson(
          "POST",
          `/api/workbench/runs/${encodeURIComponent(id)}/stop`,
          {}
        );
        return {
          ok: http.ok,
          via: "http",
          httpStatus: http.status,
          result: http.json,
          externalMutationAttempted: false
        };
      } catch (httpErr) {
        const { getWorkbenchRun, stopWorkbenchRun } = await import(
          "../lib/workbench/run-store"
        );
        if (!getWorkbenchRun(id)) {
          return {
            ok: false,
            code: "WORKBENCH_NOT_FOUND",
            message:
              "Run not in this process and Next HTTP unreachable. Start Next or pass a live run id.",
            httpError:
              httpErr instanceof Error ? httpErr.message : String(httpErr)
          };
        }
        const run = await stopWorkbenchRun(id);
        return { ok: true, via: "direct", run, externalMutationAttempted: false };
      }
    }

    case "maintenance_recover":
      return withPrisma(async (prisma) => {
        const { recoverExpiredInvocationLeases } = await import(
          "../lib/autonomy/runtime-health"
        );
        try {
          const result = await recoverExpiredInvocationLeases({ prisma });
          return {
            ok: true,
            result,
            externalMutationAttempted: false,
            containsForumText: false
          };
        } catch {
          return {
            ok: false,
            code: "autonomy_lease_recovery_failed",
            externalMutationAttempted: false,
            containsForumText: false
          };
        }
      });

    case "outcomes_reconcile":
      return withPrisma(async (prisma) => {
        const {
          observeDueProximalOutcomes,
          preflightDueProximalOutcomes,
          scheduleProximalOutcomes
        } = await import("../lib/autonomy/outcome-observer");
        try {
          const now = new Date();
          const scheduled = await scheduleProximalOutcomes({ prisma });
          const preflight = await preflightDueProximalOutcomes({ prisma, now });
          const readyOutcomeIds = preflight.outcomes
            .filter((o) => o.status === "ready")
            .map((o) => o.outcomeId);
          const observed =
            readyOutcomeIds.length > 0
              ? await observeDueProximalOutcomes({
                  prisma,
                  now,
                  outcomeIds: readyOutcomeIds,
                  readyOnly: true,
                  limit: readyOutcomeIds.length
                })
              : {
                  schemaVersion: preflight.schemaVersion,
                  asOf: preflight.asOf,
                  dueCount: 0,
                  observedCount: 0,
                  censoredCount: 0,
                  waitingForCoverageCount: 0,
                  containsForumText: false as const
                };
          return {
            ok: true,
            scheduled,
            observed,
            preflight: {
              schemaVersion: preflight.schemaVersion,
              asOf: preflight.asOf,
              counts: preflight.counts,
              outcomes: preflight.outcomes.map(
                ({
                  outcomeId,
                  courseAlias,
                  observationWindow,
                  status,
                  evidenceSource
                }) => ({
                  outcomeId,
                  courseAlias,
                  observationWindow,
                  status,
                  evidenceSource,
                  containsForumText: false as const
                })
              ),
              containsForumText: false
            },
            observationSource: "local_hmac_event_ledger_only",
            externalMutationAttempted: false,
            educationalEffectClaimed: false,
            containsForumText: false
          };
        } catch {
          return {
            ok: false,
            code: "proximal_outcome_reconciliation_failed",
            externalMutationAttempted: false,
            containsForumText: false
          };
        }
      });

    case "incident_ack":
    case "incident_resolve": {
      const id = flagStr(flags, "id");
      const expectedEvidenceHash = flagStr(flags, "expectedEvidenceHash");
      if (!id || !expectedEvidenceHash) {
        fail(
          "INCIDENT_ARGS_REQUIRED",
          `${op} requires --id and --expectedEvidenceHash`
        );
      }
      if (!/^[a-f0-9]{64}$/.test(expectedEvidenceHash)) {
        fail("INCIDENT_EVIDENCE_HASH_INVALID", "expectedEvidenceHash must be sha256 hex");
      }
      const action = op === "incident_ack" ? "acknowledge" : "resolve";
      return withPrisma(async (prisma) => {
        const { transitionAutonomyIncident } = await import(
          "../lib/autonomy/incident-governance"
        );
        try {
          const result = await transitionAutonomyIncident({
            prisma,
            incidentId: id,
            expectedEvidenceHash,
            action,
            now: new Date()
          });
          return {
            ok: true,
            status: result.status,
            changed: result.changed,
            transitionedAt: result.transitionedAt,
            containsForumText: false
          };
        } catch (err) {
          const code = err instanceof Error ? err.message : "incident_transition_failed";
          return {
            ok: false,
            code: code.toLowerCase(),
            message: err instanceof Error ? err.message : String(err),
            containsForumText: false
          };
        }
      });
    }

    case "shadow_budget_read":
      return shadowBudgetRead(flagStr(flags, "dir"));

    case "ledger_sync_status":
      return ledgerSyncStatus();

    case "ledger_use_mirror":
      return ledgerUseMirror({
        source: flagStr(flags, "source"),
        preferFull: flagBool(flags, "preferFull")
      });

    case "tape_get_by_post": {
      const forumPostId =
        flagStr(flags, "forumPostId") || flagStr(flags, "postId");
      if (!forumPostId) {
        fail("POST_ID_REQUIRED", "Provide --forumPostId or --postId");
      }
      return tapeGetByPost({
        forumPostId,
        limit: flagInt(flags, "limit", 50)
      });
    }


    case "patrol_begin": {
      const courseAlias = flagStr(flags, "courseAlias") || flagStr(flags, "course");
      if (!courseAlias) {
        fail("COURSE_ALIAS_REQUIRED", "Provide --courseAlias");
      }
      const leaseSeconds = flagInt(flags, "leaseSeconds", 900);
      return patrolBegin({ courseAlias, leaseSeconds });
    }

    case "patrol_end": {
      const invocationId = flagStr(flags, "invocationId");
      if (!invocationId) {
        fail("INVOCATION_ID_REQUIRED", "Provide --invocationId");
      }
      return patrolEnd({
        invocationId,
        leaseOwner: flagStr(flags, "leaseOwner")
      });
    }
    case "tape_append": {
      const invocationId = flagStr(flags, "invocationId");
      const forumPostId =
        flagStr(flags, "forumPostId") || flagStr(flags, "postId");
      const kind = flagStr(flags, "kind");
      if (!invocationId) {
        fail(
          "INVOCATION_ID_REQUIRED",
          "Provide --invocationId (real ScheduledInvocation). Fail closed — will not invent invocations or write AgentPatrolLedger."
        );
      }
      if (!kind) {
        fail(
          "KIND_REQUIRED",
          "Provide --kind (patrol_judgment|publish_receipt|decision_committed)"
        );
      }
      let payload: Record<string, unknown> | undefined;
      const payloadRaw = flagStr(flags, "payload");
      if (payloadRaw) {
        try {
          const parsed = JSON.parse(payloadRaw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            fail("PAYLOAD_INVALID", "--payload must be a JSON object");
          }
          payload = parsed as Record<string, unknown>;
        } catch {
          fail("PAYLOAD_INVALID", "--payload must be valid JSON");
        }
      }
      return tapeAppend({
        invocationId,
        forumPostId,
        kind,
        decision: flagStr(flags, "decision"),
        reasonCode: flagStr(flags, "reasonCode"),
        status: flagStr(flags, "status"),
        payload
      });
    }

    default:
      fail("UNKNOWN_OP", `Unknown op: ${op}`, {
        hint: "Run: npx tsx scripts/mcp-bridge.ts list"
      });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positionals } = parseArgs(argv);
  const op = positionals[0];
  if (!op) {
    fail("OP_REQUIRED", "Usage: npx tsx scripts/mcp-bridge.ts <op> [--flags]");
  }

  // list / list_capabilities / shadow_budget_read don't need full app env,
  // but ensureEnv is cheap and keeps LOCALAPPDATA consistent.
  const lightOps = new Set(["list", "ledger_sync_status", "tape_get_by_post", "tape_append", "patrol_begin", "patrol_end", "ledger_use_mirror", "list_capabilities", "shadow_budget_read"]);
  if (lightOps.has(op)) {
    applyMirrorDatabaseEnv();
  } else {
    await ensureEnv();
  }

  try {
    const result = await dispatch(op, flags);
    emit(result, (result as { ok?: boolean }).ok === false ? 1 : 0);
  } catch (err) {
    fail(
      "BRIDGE_FAILED",
      err instanceof Error ? err.message : String(err),
      {
        stack:
          err instanceof Error && process.env.CMOOC_BRIDGE_DEBUG === "1"
            ? err.stack ?? null
            : undefined
      }
    );
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
