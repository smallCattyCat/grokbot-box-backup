import assert from "node:assert/strict";
import test from "node:test";
import {
  OASIS_SIDECAR_SCHEMA_VERSIONS,
  type OasisSidecarCapabilitiesV1,
  type OasisSidecarRunOutputV1
} from "../../lib/scenario-lab/oasis-sidecar-contracts";
import {
  createOasisPreviewRunner,
  type OasisPreviewRequestV1
} from "../../lib/scenario-lab/oasis-preview";
import {
  SCENARIO_LAB_SCHEMA_VERSIONS,
  type CourseWorldFrozenEvidenceV1,
  protocolHash
} from "../../lib/scenario-lab/contracts";
import type { OasisScenePackV1 } from "../../lib/scenario-lab/oasis-scene-pack";

const HASH_A = "a".repeat(64);
const VALID_REQUEST = {
  datasetRef: "p3a-2025-holdout-v1",
  sceneTemplateRef: "course-support-network-64-v1",
  seedSetRef: "courseworld-seeds-16-v1",
  runtimeId: "oasis_contract_reference_v1"
} as const satisfies OasisPreviewRequestV1;

function frozenEvidence(): CourseWorldFrozenEvidenceV1 {
  const body = {
    schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.evidence,
    datasetRef: "p3a-2025-holdout-v1" as const,
    evidenceClass: "observed_frozen_aggregate" as const,
    cohortYear: 2025 as const,
    split: "time_holdout" as const,
    clock: {
      kind: "p3a_historical" as const,
      decisionLagHours: 22 as const,
      outcomeEndHours: 86 as const,
      outcomeWindowHours: 64 as const,
      schedulerTickMinutes: 30 as const,
      candidateTtlMinutes: 30 as const
    },
    counts: {
      snapshotCount: 2_702,
      ineligibleOrAnsweredAtDecisionCount: 2_085,
      eligibleUnansweredCount: 617,
      organicExternalResponseInWindowCount: 217,
      supportGapAtHorizonCount: 400
    },
    decisionCalendarYearCounts: [
      { year: 2025, count: 2_604 },
      { year: 2026, count: 98 }
    ],
    upstream: {
      snapshotSchemaVersion: "cmooc-decision-snapshot-v1" as const,
      benchmarkSchemaVersion: "cmooc-scheduler-benchmark-v2" as const,
      temporalContractHash: HASH_A,
      evidenceRefSetHash: HASH_A,
      benchmarkInputHash: HASH_A,
      metricsResultHash: HASH_A,
      actionLogHash: HASH_A,
      artifactFileHashes: {
        decisionSnapshotsCsvSha256: HASH_A,
        metricsJsonSha256: HASH_A,
        actionsCsvSha256: HASH_A
      }
    },
    privacy: {
      containsForumText: false as const,
      containsIdentity: false as const,
      containsRawPlatformIds: false as const,
      containsRowLevelKeys: false as const
    },
    networkUsed: false as const,
    writesPerformed: false as const,
    interventionEligible: false as const
  };
  return {
    ...body,
    evidenceHash: protocolHash(body.schemaVersion, body)
  };
}

function capabilities(): OasisSidecarCapabilitiesV1 {
  const body = {
    schemaVersion: OASIS_SIDECAR_SCHEMA_VERSIONS.capabilities,
    runtimeId: "oasis_sidecar_v1" as const,
    protocolVersion: "v1" as const,
    conformanceReferenceAvailable: true as const,
    nativeOasisAvailable: false,
    supportedScenePackSchemaVersions: [
      "cmooc.oasis-scene-pack.v1" as const
    ] as ["cmooc.oasis-scene-pack.v1"],
    supportedOperations: [
      "capabilities" as const,
      "run_conformance" as const
    ] as ["capabilities", "run_conformance"],
    executionBoundary: {
      externalNetworkUsed: false as const,
      workspaceWriteCount: 0 as const,
      scratchWriteCount: 0 as const,
      evidenceMode: "sidecar_self_report" as const,
      enforcementMode: "process_contract_only" as const
    }
  };
  return {
    ...body,
    capabilityHash: protocolHash(body.schemaVersion, body)
  };
}

function runOutput(scenePack: OasisScenePackV1): OasisSidecarRunOutputV1 {
  const distribution = { p10: 0, p50: 0, p90: 0 };
  const body = {
    schemaVersion: OASIS_SIDECAR_SCHEMA_VERSIONS.runOutput,
    runtimeId: "oasis_contract_reference_v1" as const,
    engineMode: "conformance_reference" as const,
    validityClass: "synthetic_protocol_conformance" as const,
    scenePackHash: scenePack.scenePackHash,
    sourceEvidenceHash: scenePack.sourceEvidenceHash,
    seedRunCount: 64 as const,
    armSummaries: scenePack.arms.map((arm) => ({
      armId: arm.armId,
      dailyFacilitationBudget: arm.dailyFacilitationBudget,
      seedCount: 16 as const,
      facilitatorActionCount: distribution,
      responseCoverageBps: distribution,
      supportGapBps: distribution,
      peerReplyEdgeCount: distribution
    })),
    traceSetHash: HASH_A,
    executionBoundary: {
      externalNetworkUsed: false as const,
      workspaceWriteCount: 0 as const,
      scratchWriteCount: 0 as const,
      evidenceMode: "sidecar_self_report" as const,
      enforcementMode: "process_contract_only" as const
    },
    containsForumText: false as const,
    containsIdentity: false as const,
    containsRowLevelKeys: false as const,
    interventionEligible: false as const
  };
  return {
    ...body,
    outputHash: protocolHash(body.schemaVersion, body)
  };
}

test("OASIS preview runner compiles frozen evidence and returns a deterministic safe report", async () => {
  const controller = new AbortController();
  const calls: Array<{ stage: string; signal?: AbortSignal }> = [];
  const runner = createOasisPreviewRunner({
    readEvidence: async () => {
      calls.push({ stage: "evidence" });
      return {
        evidence: frozenEvidence(),
        replayResults: [
          { shouldNeverEscape: "SECRET_ROW_LEVEL_VALUE" }
        ] as never
      };
    },
    readCapabilities: async (options) => {
      calls.push({ stage: "capabilities", signal: options.signal });
      return capabilities();
    },
    runConformance: async (scenePack, options) => {
      calls.push({ stage: "conformance", signal: options.signal });
      return runOutput(scenePack);
    }
  });

  const first = await runner(VALID_REQUEST, { signal: controller.signal });
  const second = await runner(VALID_REQUEST, { signal: controller.signal });

  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, "cmooc.oasis-preview-report.v1");
  assert.equal(first.evidenceClass, "synthetic_sensitivity");
  assert.equal(first.scenePack.governance.externalWritesAllowed, false);
  assert.equal(first.scenePack.governance.coursePlatformWritesAllowed, false);
  assert.equal(first.output.containsForumText, false);
  assert.equal(first.output.containsIdentity, false);
  assert.equal(first.output.containsRowLevelKeys, false);
  assert.equal(first.receipt.interventionEligible, false);
  assert.equal(first.receipt.transportPolicy, "bounded_jsonl_secret_free_env_v1");
  assert.deepEqual(
    calls.map((call) => call.stage),
    [
      "evidence",
      "capabilities",
      "conformance",
      "evidence",
      "capabilities",
      "conformance"
    ]
  );
  assert.equal(calls[1]?.signal, controller.signal);
  assert.equal(calls[2]?.signal, controller.signal);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("SECRET_ROW_LEVEL_VALUE"), false);
  assert.equal(serialized.includes("remoteCode"), false);
  assert.equal(serialized.includes("inputDirectory"), false);
  assert.equal(serialized.includes("scriptPath"), false);
});

test("OASIS preview runner rejects a non-exact request before reading evidence", async () => {
  let readCount = 0;
  const runner = createOasisPreviewRunner({
    readEvidence: async () => {
      readCount += 1;
      return { evidence: frozenEvidence(), replayResults: [] };
    }
  });
  const context = { signal: new AbortController().signal };

  await assert.rejects(
    runner({ ...VALID_REQUEST, extra: true } as never, context),
    /OASIS_PREVIEW_REQUEST_INVALID/u
  );
  await assert.rejects(
    runner({ ...VALID_REQUEST, runtimeId: "unknown" } as never, context),
    /OASIS_PREVIEW_RUNTIME_UNAVAILABLE/u
  );
  assert.equal(readCount, 0);
});
