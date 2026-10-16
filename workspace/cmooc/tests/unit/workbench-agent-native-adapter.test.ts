import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_NATIVE_WORKBENCH_SCHEMA_VERSION,
  type AgentNativeWorkbenchViewModel
} from "../../lib/workbench/agent-native-contracts";
import { buildAgentNativeWorkbenchViewModel } from "../../lib/workbench/agent-native-adapter";
import type {
  CourseOpportunityBrief,
  CourseOpportunityBriefItem
} from "../../lib/workbench/course-opportunity-brief";
import type { OperatorWorkspaceReadModel } from "../../lib/workbench/operator-read-model";

const AS_OF = "2026-08-31T10:00:00.000Z";

function briefItem(input: {
  id: string;
  kind: CourseOpportunityBriefItem["kind"];
  stateLabel: string;
  canHandoff: boolean;
}): CourseOpportunityBriefItem {
  return {
    id: input.id,
    kind: input.kind,
    priority: input.kind === "incident" ? "high" : "medium",
    stateLabel: input.stateLabel,
    headline: `${input.id} headline`,
    summary: `${input.id} summary`,
    observedFacts: [`${input.id} observed fact`],
    limitations: input.kind === "incident" ? ["incident boundary"] : [],
    gates: {
      admission: input.canHandoff ? "pass" : "blocked",
      review: input.canHandoff ? "pass" : "blocked",
      conditions: input.canHandoff ? "pass" : "blocked"
    },
    evidenceAsOf: AS_OF,
    evidenceCode: `${input.id}:evidence`,
    contextRef: `snapshot:${input.id}`,
    sourceHref: `/autonomy/world?course=safe-course&snapshot=${input.id}`,
    canHandoff: input.canHandoff,
    containsForumText: false,
    containsIdentity: false
  };
}

function operatorFixture(items: CourseOpportunityBriefItem[]): OperatorWorkspaceReadModel {
  const brief: CourseOpportunityBrief = {
    schemaVersion: "cmooc.course-opportunity-brief.v1",
    status: "ready",
    anchor: {
      courseAlias: "safe-course",
      courseName: "安全课程",
      invocationId: "invocation-01",
      snapshotId: "snapshot-01",
      manifestHash: "manifest-01",
      worldHash: "world-01",
      coverageHash: "coverage-01",
      worldAsOf: AS_OF,
      evidenceAsOf: AS_OF
    },
    headline: "当前关注事项",
    summaryLine: "可核验摘要",
    summary: {
      needsAttention: items.length,
      canYield: 0,
      dueOutcomes: 0,
      incompleteScopes: 0
    },
    items,
    containsForumText: false,
    containsIdentity: false
  };

  return {
    schemaVersion: "cmooc.operator-workspace.v3",
    courseBound: true,
    courseAlias: "safe-course",
    courseName: "安全课程",
    invocationId: "invocation-01",
    invocationStatus: "ready",
    invocationMode: "shadow",
    scheduledFor: AS_OF,
    coverage: {
      status: "complete",
      observedEventCount: 4,
      incompleteThreadCount: 0,
      failedTargetCount: 0
    },
    metrics: { events: 4, threads: 2, actors: 3, edges: 1 },
    decisions: { draft: 1, wait: 1, abstain: 0, yield: 0 },
    evidence: {
      decisionTapeEntryCount: 2,
      candidateCount: 1,
      graphCoverageStatus: "complete",
      openIncidentCount: 1
    },
    executionAgents: {
      configurationState: "unavailable",
      configuredAgentCount: 0,
      availableAgentCount: 0,
      activeAgentCount: 0,
      consumedLeaseCountToday: 0,
      roles: []
    },
    schedule: {} as OperatorWorkspaceReadModel["schedule"],
    brief,
    evidenceWorkspace: {} as OperatorWorkspaceReadModel["evidenceWorkspace"],
    learnerNetwork: {
      status: "unavailable",
      coverageStatus: "unavailable",
      totalLearnerCount: 0,
      visibleLearnerCount: 0,
      directInteractionCount: 0,
      reciprocalRelationCount: 0,
      communityCount: 0,
      weakBridgeCount: 0,
      truncated: false,
      nodes: [],
      edges: [],
      containsIdentity: false,
      containsForumText: false
    },
    networkTrend: [],
    opportunities: [],
    containsForumText: false,
    realPublishEnabled: false
  };
}

test("adapter projects a bounded Workbench view model with zero external writes", () => {
  const operator = operatorFixture([
    briefItem({
      id: "decision:ready",
      kind: "intervention_opportunity",
      stateLabel: "可继续",
      canHandoff: true
    }),
    briefItem({
      id: "decision:wait",
      kind: "wait",
      stateLabel: "等待",
      canHandoff: false
    }),
    briefItem({
      id: "incident:blocked",
      kind: "incident",
      stateLabel: "异常",
      canHandoff: false
    })
  ]);

  const viewModel = buildAgentNativeWorkbenchViewModel({
    operator,
    focusQuery: "brief:decision:ready",
    now: new Date("2026-08-31T10:01:00.000Z")
  });

  assert.equal(viewModel.schemaVersion, AGENT_NATIVE_WORKBENCH_SCHEMA_VERSION);
  assert.equal(viewModel.scope.writeMode, "SHADOW");
  assert.equal(viewModel.scope.courseId, null);
  assert.equal(viewModel.scope.courseAlias, "safe-course");
  assert.equal(viewModel.scope.externalWrites, 0);
  assert.equal(viewModel.focus?.id, "decision:ready");
  assert.equal(viewModel.decisionBrief?.disposition, "DRAFT");
  assert.equal(viewModel.actionPreview?.externalWrites, 0);
  assert.equal(viewModel.actionPreview?.allowed, true);
  assert.equal(viewModel.actionPreview?.executor.leaseStatus, "unavailable");
  assert.equal(viewModel.capsule.containsForumText, false);
  assert.equal(viewModel.capsule.containsIdentity, false);
  assert.equal(viewModel.capsule.externalWrites, 0);
  assert.match(viewModel.capsule.blockedActions.join("、"), /真实平台发布/);
  assert.equal(viewModel.attention.find((item) => item.id === "decision:wait")?.disposition, "WAIT");
  assert.equal(viewModel.attention.find((item) => item.id === "incident:blocked")?.systemState, "ERROR");
  assert.equal(JSON.stringify(viewModel.capsule).includes("containsForumText"), true);
  assert.equal(JSON.stringify(viewModel.capsule).includes("safe-course"), true);
});

test("invalid focus falls back without inventing a brief or action", () => {
  const viewModel: AgentNativeWorkbenchViewModel = buildAgentNativeWorkbenchViewModel({
    operator: operatorFixture([
      briefItem({
        id: "decision:ready",
        kind: "intervention_opportunity",
        stateLabel: "可继续",
        canHandoff: true
      })
    ]),
    focusQuery: "brief:decision%2Funsafe"
  });

  assert.equal(viewModel.focus, null);
  assert.equal(viewModel.decisionBrief, null);
  assert.equal(viewModel.actionPreview, null);
});
