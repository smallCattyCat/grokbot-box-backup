import {
  assertBasisPoints,
  assertSafeCount,
  assertSha256,
  protocolHash
} from "./contracts";
import {
  OASIS_SCENE_PACK_SCHEMA_VERSION,
  type OasisSceneArmId,
  type OasisScenePackV1,
  assertOasisScenePack
} from "./oasis-scene-pack";

export const OASIS_SIDECAR_SCHEMA_VERSIONS = {
  request: "cmooc.oasis-sidecar-request.v1",
  capabilities: "cmooc.oasis-sidecar-capabilities.v1",
  runOutput: "cmooc.oasis-sidecar-run-output.v1",
  previewReceipt: "cmooc.oasis-preview-receipt.v1",
  previewReport: "cmooc.oasis-preview-report.v1"
} as const;

export const OASIS_CONFORMANCE_RUNTIME_ID =
  "oasis_contract_reference_v1" as const;

export interface OasisCapabilitiesRequestV1 {
  schemaVersion: typeof OASIS_SIDECAR_SCHEMA_VERSIONS.request;
  operation: "capabilities";
  protocolVersion: "v1";
}

export interface OasisRunRequestV1 {
  schemaVersion: typeof OASIS_SIDECAR_SCHEMA_VERSIONS.request;
  operation: "run_conformance";
  protocolVersion: "v1";
  engineMode: "conformance_reference";
  scenePack: OasisScenePackV1;
}

export type OasisSidecarRequestV1 =
  | OasisCapabilitiesRequestV1
  | OasisRunRequestV1;

export interface OasisExecutionBoundaryClaimV1 {
  externalNetworkUsed: false;
  workspaceWriteCount: 0;
  scratchWriteCount: 0;
  evidenceMode: "sidecar_self_report";
  enforcementMode: "process_contract_only";
}

export interface OasisSidecarCapabilitiesV1 {
  schemaVersion: typeof OASIS_SIDECAR_SCHEMA_VERSIONS.capabilities;
  runtimeId: "oasis_sidecar_v1";
  protocolVersion: "v1";
  conformanceReferenceAvailable: true;
  nativeOasisAvailable: boolean;
  supportedScenePackSchemaVersions: [
    typeof OASIS_SCENE_PACK_SCHEMA_VERSION
  ];
  supportedOperations: ["capabilities", "run_conformance"];
  executionBoundary: OasisExecutionBoundaryClaimV1;
  capabilityHash: string;
}

export interface OasisDistributionV1 {
  p10: number;
  p50: number;
  p90: number;
}

export interface OasisArmSensitivitySummaryV1 {
  armId: OasisSceneArmId;
  dailyFacilitationBudget: 0 | 1 | 3 | 5;
  seedCount: 16;
  facilitatorActionCount: OasisDistributionV1;
  responseCoverageBps: OasisDistributionV1;
  supportGapBps: OasisDistributionV1;
  peerReplyEdgeCount: OasisDistributionV1;
}

export interface OasisSidecarRunOutputV1 {
  schemaVersion: typeof OASIS_SIDECAR_SCHEMA_VERSIONS.runOutput;
  runtimeId: typeof OASIS_CONFORMANCE_RUNTIME_ID;
  engineMode: "conformance_reference";
  validityClass: "synthetic_protocol_conformance";
  scenePackHash: string;
  sourceEvidenceHash: string;
  seedRunCount: 64;
  armSummaries: OasisArmSensitivitySummaryV1[];
  traceSetHash: string;
  executionBoundary: OasisExecutionBoundaryClaimV1;
  containsForumText: false;
  containsIdentity: false;
  containsRowLevelKeys: false;
  interventionEligible: false;
  outputHash: string;
}

export interface OasisPreviewReceiptV1 {
  schemaVersion: typeof OASIS_SIDECAR_SCHEMA_VERSIONS.previewReceipt;
  runtimeId: typeof OASIS_CONFORMANCE_RUNTIME_ID;
  sourceEvidenceHash: string;
  scenePackHash: string;
  capabilityHash: string;
  sidecarOutputHash: string;
  executionBoundary: OasisExecutionBoundaryClaimV1;
  transportPolicy: "bounded_jsonl_secret_free_env_v1";
  decisionUse: "research_only";
  interventionEligible: false;
  receiptHash: string;
}

export interface OasisPreviewReportV1 {
  schemaVersion: typeof OASIS_SIDECAR_SCHEMA_VERSIONS.previewReport;
  datasetRef: "p3a-2025-holdout-v1";
  sceneTemplateRef: "course-support-network-64-v1";
  seedSetRef: "courseworld-seeds-16-v1";
  evidenceClass: "synthetic_sensitivity";
  scenePack: OasisScenePackV1;
  capabilities: OasisSidecarCapabilitiesV1;
  output: OasisSidecarRunOutputV1;
  receipt: OasisPreviewReceiptV1;
  reportHash: string;
}

type UnknownRecord = Record<string, unknown>;

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  code: string
): asserts value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    expected.some((key, index) => actual[index] !== key)
  ) {
    throw new Error(code);
  }
}

function assertExecutionBoundary(
  value: unknown
): asserts value is OasisExecutionBoundaryClaimV1 {
  assertExactRecord(
    value,
    [
      "externalNetworkUsed",
      "workspaceWriteCount",
      "scratchWriteCount",
      "evidenceMode",
      "enforcementMode"
    ],
    "OASIS_EXECUTION_BOUNDARY_CONTRACT_MISMATCH"
  );
  if (
    value.externalNetworkUsed !== false ||
    value.workspaceWriteCount !== 0 ||
    value.scratchWriteCount !== 0 ||
    value.evidenceMode !== "sidecar_self_report" ||
    value.enforcementMode !== "process_contract_only"
  ) {
    throw new Error("OASIS_EXECUTION_BOUNDARY_CONTRACT_MISMATCH");
  }
}

function assertDistribution(
  value: unknown,
  label: string,
  basisPoints: boolean
): asserts value is OasisDistributionV1 {
  assertExactRecord(
    value,
    ["p10", "p50", "p90"],
    "OASIS_DISTRIBUTION_CONTRACT_MISMATCH"
  );
  if (
    typeof value.p10 !== "number" ||
    typeof value.p50 !== "number" ||
    typeof value.p90 !== "number"
  ) {
    throw new Error("OASIS_DISTRIBUTION_CONTRACT_MISMATCH");
  }
  const values = [value.p10, value.p50, value.p90];
  if (basisPoints) {
    values.forEach((item) => assertBasisPoints(item, label));
  } else {
    values.forEach((item) => assertSafeCount(item, label));
  }
  if (value.p10 > value.p50 || value.p50 > value.p90) {
    throw new Error("OASIS_DISTRIBUTION_ORDER_INVALID");
  }
}

export function assertOasisCapabilities(
  value: unknown
): asserts value is OasisSidecarCapabilitiesV1 {
  assertExactRecord(
    value,
    [
      "schemaVersion",
      "runtimeId",
      "protocolVersion",
      "conformanceReferenceAvailable",
      "nativeOasisAvailable",
      "supportedScenePackSchemaVersions",
      "supportedOperations",
      "executionBoundary",
      "capabilityHash"
    ],
    "OASIS_CAPABILITY_CONTRACT_MISMATCH"
  );
  if (
    !Array.isArray(value.supportedScenePackSchemaVersions) ||
    !Array.isArray(value.supportedOperations)
  ) {
    throw new Error("OASIS_CAPABILITY_CONTRACT_MISMATCH");
  }
  assertExecutionBoundary(value.executionBoundary);
  if (typeof value.capabilityHash !== "string") {
    throw new Error("OASIS_CAPABILITY_CONTRACT_MISMATCH");
  }
  const { capabilityHash, ...body } = value;
  assertSha256(capabilityHash, "capabilityHash");
  if (
    value.schemaVersion !== OASIS_SIDECAR_SCHEMA_VERSIONS.capabilities ||
    value.runtimeId !== "oasis_sidecar_v1" ||
    value.protocolVersion !== "v1" ||
    value.conformanceReferenceAvailable !== true ||
    typeof value.nativeOasisAvailable !== "boolean" ||
    value.supportedScenePackSchemaVersions.join(",") !==
      OASIS_SCENE_PACK_SCHEMA_VERSION ||
    value.supportedOperations.join(",") !==
      "capabilities,run_conformance"
  ) {
    throw new Error("OASIS_CAPABILITY_CONTRACT_MISMATCH");
  }
  if (protocolHash(value.schemaVersion, body) !== capabilityHash) {
    throw new Error("OASIS_CAPABILITY_HASH_MISMATCH");
  }
}

export function assertOasisRunOutput(
  value: unknown,
  scenePack: OasisScenePackV1
): asserts value is OasisSidecarRunOutputV1 {
  assertOasisScenePack(scenePack);
  assertExactRecord(
    value,
    [
      "schemaVersion",
      "runtimeId",
      "engineMode",
      "validityClass",
      "scenePackHash",
      "sourceEvidenceHash",
      "seedRunCount",
      "armSummaries",
      "traceSetHash",
      "executionBoundary",
      "containsForumText",
      "containsIdentity",
      "containsRowLevelKeys",
      "interventionEligible",
      "outputHash"
    ],
    "OASIS_RUN_OUTPUT_CONTRACT_MISMATCH"
  );
  if (!Array.isArray(value.armSummaries)) {
    throw new Error("OASIS_RUN_OUTPUT_CONTRACT_MISMATCH");
  }
  assertExecutionBoundary(value.executionBoundary);
  if (
    typeof value.outputHash !== "string" ||
    typeof value.traceSetHash !== "string"
  ) {
    throw new Error("OASIS_RUN_OUTPUT_CONTRACT_MISMATCH");
  }
  const { outputHash, ...body } = value;
  assertSha256(outputHash, "outputHash");
  assertSha256(value.traceSetHash, "traceSetHash");
  if (
    value.schemaVersion !== OASIS_SIDECAR_SCHEMA_VERSIONS.runOutput ||
    value.runtimeId !== OASIS_CONFORMANCE_RUNTIME_ID ||
    value.engineMode !== "conformance_reference" ||
    value.validityClass !== "synthetic_protocol_conformance" ||
    value.scenePackHash !== scenePack.scenePackHash ||
    value.sourceEvidenceHash !== scenePack.sourceEvidenceHash ||
    value.seedRunCount !== 64 ||
    value.containsForumText !== false ||
    value.containsIdentity !== false ||
    value.containsRowLevelKeys !== false ||
    value.interventionEligible !== false
  ) {
    throw new Error("OASIS_RUN_OUTPUT_CONTRACT_MISMATCH");
  }
  if (value.armSummaries.length !== scenePack.arms.length) {
    throw new Error("OASIS_RUN_ARM_SET_MISMATCH");
  }
  value.armSummaries.forEach((summary, index) => {
    assertExactRecord(
      summary,
      [
        "armId",
        "dailyFacilitationBudget",
        "seedCount",
        "facilitatorActionCount",
        "responseCoverageBps",
        "supportGapBps",
        "peerReplyEdgeCount"
      ],
      "OASIS_RUN_ARM_SET_MISMATCH"
    );
    const arm = scenePack.arms[index];
    if (
      !arm ||
      summary.armId !== arm.armId ||
      summary.dailyFacilitationBudget !== arm.dailyFacilitationBudget ||
      summary.seedCount !== 16
    ) {
      throw new Error("OASIS_RUN_ARM_SET_MISMATCH");
    }
    assertDistribution(
      summary.facilitatorActionCount,
      `${summary.armId}.facilitatorActionCount`,
      false
    );
    assertDistribution(
      summary.responseCoverageBps,
      `${summary.armId}.responseCoverageBps`,
      true
    );
    assertDistribution(
      summary.supportGapBps,
      `${summary.armId}.supportGapBps`,
      true
    );
    assertDistribution(
      summary.peerReplyEdgeCount,
      `${summary.armId}.peerReplyEdgeCount`,
      false
    );
  });
  if (protocolHash(value.schemaVersion, body) !== outputHash) {
    throw new Error("OASIS_RUN_OUTPUT_HASH_MISMATCH");
  }
}

export function buildOasisPreviewReport(input: {
  scenePack: OasisScenePackV1;
  capabilities: OasisSidecarCapabilitiesV1;
  output: OasisSidecarRunOutputV1;
}): OasisPreviewReportV1 {
  assertOasisScenePack(input.scenePack);
  assertOasisCapabilities(input.capabilities);
  assertOasisRunOutput(input.output, input.scenePack);
  const receiptBody = {
    schemaVersion: OASIS_SIDECAR_SCHEMA_VERSIONS.previewReceipt,
    runtimeId: OASIS_CONFORMANCE_RUNTIME_ID,
    sourceEvidenceHash: input.scenePack.sourceEvidenceHash,
    scenePackHash: input.scenePack.scenePackHash,
    capabilityHash: input.capabilities.capabilityHash,
    sidecarOutputHash: input.output.outputHash,
    executionBoundary: input.output.executionBoundary,
    transportPolicy: "bounded_jsonl_secret_free_env_v1" as const,
    decisionUse: "research_only" as const,
    interventionEligible: false as const
  };
  const receipt: OasisPreviewReceiptV1 = {
    ...receiptBody,
    receiptHash: protocolHash(receiptBody.schemaVersion, receiptBody)
  };
  const body = {
    schemaVersion: OASIS_SIDECAR_SCHEMA_VERSIONS.previewReport,
    datasetRef: input.scenePack.datasetRef,
    sceneTemplateRef: input.scenePack.sceneTemplateRef,
    seedSetRef: input.scenePack.seedSetRef,
    evidenceClass: "synthetic_sensitivity" as const,
    scenePack: input.scenePack,
    capabilities: input.capabilities,
    output: input.output,
    receipt
  };
  return {
    ...body,
    reportHash: protocolHash(body.schemaVersion, body)
  };
}
