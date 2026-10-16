import { prisma as defaultPrisma } from "@/lib/db";
import {
  assessCourseOperationGovernanceIntegrity,
  courseOperationGovernanceCurrentOrderBy,
  safeCourseOperationGovernanceState
} from "@/lib/autonomy/course-operation-governance";
import {
  buildCourseResearchExport,
  type CourseResearchExport
} from "@/lib/workbench/course-evidence-workspace";
import { getAnchoredCourseEvidenceWorkspace } from "@/lib/workbench/evidence-read-model";
import {
  buildOperatorScheduleSummary,
  OPERATOR_WORKER_WAKE_SCOPE,
  type OperatorScheduleSummary
} from "@/lib/workbench/operator-schedule";
import {
  createArtifactVersion as createWorkbenchArtifactVersion,
  type CreateArtifactVersionInput
} from "@/lib/workbench/artifact-store";
import {
  normalizeEvidenceRefs,
  serializeSafeDurableValue,
  type SafeJsonValue,
  type WorkbenchDb
} from "@/lib/workbench/durable-ledger";
import {
  COURSE_TOOL_SCHEMA_VERSION,
  CourseToolOperationError,
  assertEvidenceRefs,
  assertCourseToolJsonValue,
  createJsonCourseToolOutputSchema,
  createJsonCourseToolSchema,
  hashCourseToolValue,
  isIsoInstant,
  isSafeIdentifier,
  isSha256,
  sanitizeCourseToolSummary,
  type CourseToolBusinessInput,
  type CourseToolJsonValue,
  type CourseToolRegistration,
  type EvidenceRef,
  type ServerToolExecutionContext
} from "../contracts";
import { CourseToolRegistry, defineCourseTool } from "../registry";
import {
  CourseToolVerifierRegistry,
  type CourseToolVerifierRegistration,
  type CourseToolVerifierRegistryOptions,
  type CourseToolVerifierResult
} from "../verifier-registry";
import {
  CourseContextToolError,
  resolveCourseContext,
  type ResolvedCourseContext
} from "./course-context";

export const COURSE_OPERATIONS_TOOL_SCHEMA_VERSION =
  "cmooc.course-operations-tools.v1" as const;
export const RESEARCH_EVIDENCE_PACKAGE_OUTPUT_SCHEMA_VERSION =
  "cmooc.course-tool.research-evidence-package-output.v1" as const;
export const COURSE_SCHEDULE_READ_OUTPUT_SCHEMA_VERSION =
  "cmooc.course-tool.course-schedule-read-output.v1" as const;
export const SCHEDULE_REVIEW_BUNDLE_OUTPUT_SCHEMA_VERSION =
  "cmooc.course-tool.schedule-review-bundle-output.v1" as const;
export const RESEARCH_EVIDENCE_PACKAGE_ARTIFACT_SCHEMA_VERSION =
  "cmooc.research-evidence-package-artifact.v1" as const;
export const SCHEDULE_REVIEW_ARTIFACT_SCHEMA_VERSION =
  "cmooc.schedule-review-artifact.v1" as const;

const RESEARCH_EVIDENCE_PACKAGE_SAFE_SUMMARY =
  "Deterministic course research aggregate package prepared without source text or identity.";
const SCHEDULE_REVIEW_BUNDLE_SAFE_SUMMARY =
  "Deterministic schedule review bundle prepared from exact safe persisted state.";

export const RESEARCH_EVIDENCE_PACKAGE_VERIFIER = Object.freeze({
  name: "verification.research_evidence_package",
  version: "1"
} as const);
export const COURSE_SCHEDULE_READ_VERIFIER = Object.freeze({
  name: "verification.course_schedule_read",
  version: "1"
} as const);
export const SCHEDULE_REVIEW_BUNDLE_VERIFIER = Object.freeze({
  name: "verification.schedule_review_bundle",
  version: "1"
} as const);

type ExactContextInput = CourseToolBusinessInput & {
  readonly contextRef: string;
};

export type CourseOperationArtifactPointer = {
  readonly artifactId: string;
  readonly versionId: string;
  readonly artifactRef: string;
  readonly versionRef: string;
  readonly version: number;
  readonly contentHash: string;
};

export type CourseOperationArtifactVersionWrite = {
  readonly taskId: string;
  readonly runId: string;
  readonly createdByCallId: string;
  readonly artifactKey: string;
  readonly versionKey: string;
  readonly artifactKind:
    | "research_evidence_package"
    | "schedule_review_bundle";
  readonly contentHash: string;
  readonly safeSummary: string;
  readonly metadata: SafeJsonValue;
  readonly sourceRefs: readonly EvidenceRef[];
  readonly observedAt: string;
};

export type CreateCourseOperationArtifactVersion = (
  write: Readonly<CourseOperationArtifactVersionWrite>
) => Promise<CourseOperationArtifactPointer>;

type ExactAnchorProjection = {
  readonly courseAlias: string;
  readonly contextRef: string;
  readonly invocationRef: string;
  readonly snapshotRef: string;
  readonly baselineSnapshotRef: string | null;
  readonly worldAsOf: string;
  readonly manifestHash: string;
  readonly worldHash: string;
  readonly eventSetHash: string;
  readonly coverageHash: string;
  readonly candidateSetHash: string;
};

export type ResearchEvidencePackageOutput = {
  readonly schemaVersion: typeof RESEARCH_EVIDENCE_PACKAGE_OUTPUT_SCHEMA_VERSION;
  readonly status: "prepared";
  readonly anchor: ExactAnchorProjection;
  readonly exportSchemaVersion: CourseResearchExport["schemaVersion"];
  readonly exportSha256: string;
  readonly exportByteLength: number;
  readonly aggregateCounts: {
    readonly waterfallStageCount: number;
    readonly changeMetricCount: number;
    readonly limitationCount: number;
    readonly observedUnitCount: number;
    readonly eligibleCompleteUnitCount: number;
    readonly unsupportedUnitCount: number;
  };
  readonly artifact: CourseOperationArtifactPointer;
  readonly limitations: readonly string[];
  readonly deterministic: true;
  readonly evidenceRefCount: number;
};

type ScheduleState = OperatorScheduleSummary["state"];

type GovernanceBoundaryProjection = {
  readonly status:
    | "active"
    | "paused"
    | "revoked"
    | "expired"
    | "emergency_halt"
    | "not_yet_valid"
    | "missing";
  readonly integrityState: "valid" | "unavailable";
  readonly governanceRef: string | null;
  readonly version: string | null;
  readonly governanceHash: string | null;
  readonly baseManifestHash: string | null;
  readonly mode: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly emergencyHalt: boolean;
  readonly limits: {
    readonly dailySlotLimit: number;
    readonly perTickActionLimit: number;
    readonly authorTouchLimit30d: number;
    readonly minIntervalMinutes: number;
  } | null;
};

type ScheduleProjection = {
  readonly state: ScheduleState;
  readonly scheduleRef: string | null;
  readonly mode: string | null;
  readonly intervalMinutes: number | null;
  readonly timeZone: string | null;
  readonly nextWindowAt: string | null;
  readonly nextWindowState: "due" | "upcoming" | "unavailable";
  readonly upcomingWindows: readonly string[];
  readonly latestInvocation: {
    readonly invocationRef: string;
    readonly status: string;
    readonly scheduledFor: string;
  } | null;
  readonly latestWake: {
    readonly wakeRef: string;
    readonly status: string;
    readonly observedAt: string;
    readonly zeroWrite: boolean;
  } | null;
  readonly externalWritesLocked: true;
};

export type CourseScheduleReadOutput = {
  readonly schemaVersion: typeof COURSE_SCHEDULE_READ_OUTPUT_SCHEMA_VERSION;
  readonly status: "ready";
  readonly anchor: ExactAnchorProjection;
  readonly scheduleStateHash: string;
  readonly schedule: ScheduleProjection;
  readonly governanceBoundary: GovernanceBoundaryProjection;
  readonly zeroWriteStatus: "verified" | "failed" | "unavailable";
  readonly limitations: readonly string[];
  readonly observedAt: string;
  readonly evidenceRefCount: number;
};

export type ScheduleReviewBundleOutput = {
  readonly schemaVersion: typeof SCHEDULE_REVIEW_BUNDLE_OUTPUT_SCHEMA_VERSION;
  readonly status: "prepared";
  readonly anchor: ExactAnchorProjection;
  readonly scheduleStateHash: string;
  readonly reviewHash: string;
  readonly artifact: CourseOperationArtifactPointer;
  readonly scheduleState: ScheduleState;
  readonly nextWindows: readonly string[];
  readonly governanceBoundary: GovernanceBoundaryProjection;
  readonly zeroWriteStatus: "verified" | "failed" | "unavailable";
  readonly limitations: readonly string[];
  readonly deterministic: true;
  readonly observedAt: string;
  readonly evidenceRefCount: number;
};

export type ScheduleReviewArtifactDocument = {
  readonly schemaVersion: typeof SCHEDULE_REVIEW_ARTIFACT_SCHEMA_VERSION;
  readonly generatedFrom: "persisted_safe_schedule_state";
  readonly anchor: ExactAnchorProjection;
  readonly scheduleStateHash: string;
  readonly schedule: ScheduleProjection;
  readonly governanceBoundary: GovernanceBoundaryProjection;
  readonly zeroWriteStatus: CourseScheduleReadOutput["zeroWriteStatus"];
  readonly limitations: readonly string[];
  readonly reconstruction: {
    readonly deterministic: true;
    readonly sourceSchemaVersion: typeof COURSE_SCHEDULE_READ_OUTPUT_SCHEMA_VERSION;
  };
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
};

export interface CourseOperationsToolRegistrationDeps {
  readonly prisma?: typeof defaultPrisma;
  readonly createArtifactVersion?: CreateCourseOperationArtifactVersion;
}

export interface CourseOperationsVerifierRegistrationDeps {
  readonly prisma?: typeof defaultPrisma;
}

const HASH_SCHEMA = {
  type: "string",
  pattern: "^[a-f0-9]{64}$"
} as const;
const SAFE_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 192,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
} as const;
const NULLABLE_SAFE_ID_SCHEMA = {
  type: ["string", "null"],
  minLength: 1,
  maxLength: 192,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
} as const;
const CONTEXT_REF_SCHEMA = {
  type: "string",
  minLength: 3,
  maxLength: 160,
  pattern:
    "^(invocation|snapshot|decision|outcome|incident):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
} as const;
const ISO_INSTANT_SCHEMA = {
  type: "string",
  minLength: 20,
  maxLength: 32,
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$"
} as const;
const COUNT_SCHEMA = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER
} as const;
const NULLABLE_COUNT_SCHEMA = {
  type: ["integer", "null"],
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER
} as const;
const NULLABLE_STRING_SCHEMA = {
  type: ["string", "null"],
  minLength: 1,
  maxLength: 192
} as const;
const LIMITATIONS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 8,
  items: { type: "string", minLength: 1, maxLength: 1000 }
} as const;
const ARTIFACT_POINTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "artifactId",
    "versionId",
    "artifactRef",
    "versionRef",
    "version",
    "contentHash"
  ],
  properties: {
    artifactId: SAFE_ID_SCHEMA,
    versionId: SAFE_ID_SCHEMA,
    artifactRef: SAFE_ID_SCHEMA,
    versionRef: SAFE_ID_SCHEMA,
    version: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    contentHash: HASH_SCHEMA
  }
} as const;
const EXACT_ANCHOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "courseAlias",
    "contextRef",
    "invocationRef",
    "snapshotRef",
    "baselineSnapshotRef",
    "worldAsOf",
    "manifestHash",
    "worldHash",
    "eventSetHash",
    "coverageHash",
    "candidateSetHash"
  ],
  properties: {
    courseAlias: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$"
    },
    contextRef: CONTEXT_REF_SCHEMA,
    invocationRef: SAFE_ID_SCHEMA,
    snapshotRef: SAFE_ID_SCHEMA,
    baselineSnapshotRef: NULLABLE_SAFE_ID_SCHEMA,
    worldAsOf: ISO_INSTANT_SCHEMA,
    manifestHash: HASH_SCHEMA,
    worldHash: HASH_SCHEMA,
    eventSetHash: HASH_SCHEMA,
    coverageHash: HASH_SCHEMA,
    candidateSetHash: HASH_SCHEMA
  }
} as const;
const GOVERNANCE_BOUNDARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "integrityState",
    "governanceRef",
    "version",
    "governanceHash",
    "baseManifestHash",
    "mode",
    "validFrom",
    "validUntil",
    "emergencyHalt",
    "limits"
  ],
  properties: {
    status: {
      type: "string",
      enum: [
        "active",
        "paused",
        "revoked",
        "expired",
        "emergency_halt",
        "not_yet_valid",
        "missing"
      ]
    },
    integrityState: { type: "string", enum: ["valid", "unavailable"] },
    governanceRef: NULLABLE_SAFE_ID_SCHEMA,
    version: NULLABLE_STRING_SCHEMA,
    governanceHash: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
    baseManifestHash: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
    mode: NULLABLE_STRING_SCHEMA,
    validFrom: { type: ["string", "null"], minLength: 20, maxLength: 32 },
    validUntil: { type: ["string", "null"], minLength: 20, maxLength: 32 },
    emergencyHalt: { type: "boolean" },
    limits: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "dailySlotLimit",
            "perTickActionLimit",
            "authorTouchLimit30d",
            "minIntervalMinutes"
          ],
          properties: {
            dailySlotLimit: COUNT_SCHEMA,
            perTickActionLimit: COUNT_SCHEMA,
            authorTouchLimit30d: COUNT_SCHEMA,
            minIntervalMinutes: { type: "integer", minimum: 1, maximum: 10080 }
          }
        }
      ]
    }
  }
} as const;
const SCHEDULE_PROJECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "state",
    "scheduleRef",
    "mode",
    "intervalMinutes",
    "timeZone",
    "nextWindowAt",
    "nextWindowState",
    "upcomingWindows",
    "latestInvocation",
    "latestWake",
    "externalWritesLocked"
  ],
  properties: {
    state: {
      type: "string",
      enum: ["active", "configured", "paused", "attention", "unavailable"]
    },
    scheduleRef: NULLABLE_SAFE_ID_SCHEMA,
    mode: NULLABLE_STRING_SCHEMA,
    intervalMinutes: NULLABLE_COUNT_SCHEMA,
    timeZone: NULLABLE_STRING_SCHEMA,
    nextWindowAt: { type: ["string", "null"], minLength: 20, maxLength: 32 },
    nextWindowState: {
      type: "string",
      enum: ["due", "upcoming", "unavailable"]
    },
    upcomingWindows: {
      type: "array",
      maxItems: 6,
      items: ISO_INSTANT_SCHEMA
    },
    latestInvocation: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["invocationRef", "status", "scheduledFor"],
          properties: {
            invocationRef: SAFE_ID_SCHEMA,
            status: { type: "string", minLength: 1, maxLength: 64 },
            scheduledFor: ISO_INSTANT_SCHEMA
          }
        }
      ]
    },
    latestWake: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["wakeRef", "status", "observedAt", "zeroWrite"],
          properties: {
            wakeRef: SAFE_ID_SCHEMA,
            status: { type: "string", minLength: 1, maxLength: 64 },
            observedAt: ISO_INSTANT_SCHEMA,
            zeroWrite: { type: "boolean" }
          }
        }
      ]
    },
    externalWritesLocked: { const: true }
  }
} as const;

const CONTEXT_INPUT_SCHEMA = createJsonCourseToolSchema<ExactContextInput>({
  schemaVersion: "cmooc.course-tool.course-operations-context-input.v1",
  modelJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["contextRef"],
    properties: { contextRef: CONTEXT_REF_SCHEMA }
  }
});

const RESEARCH_OUTPUT_SCHEMA =
  createJsonCourseToolOutputSchema<ResearchEvidencePackageOutput>({
    schemaVersion: RESEARCH_EVIDENCE_PACKAGE_OUTPUT_SCHEMA_VERSION,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "anchor",
        "exportSchemaVersion",
        "exportSha256",
        "exportByteLength",
        "aggregateCounts",
        "artifact",
        "limitations",
        "deterministic",
        "evidenceRefCount"
      ],
      properties: {
        schemaVersion: { const: RESEARCH_EVIDENCE_PACKAGE_OUTPUT_SCHEMA_VERSION },
        status: { const: "prepared" },
        anchor: EXACT_ANCHOR_SCHEMA,
        exportSchemaVersion: { const: "cmooc.course-research-export.v1" },
        exportSha256: HASH_SCHEMA,
        exportByteLength: COUNT_SCHEMA,
        aggregateCounts: {
          type: "object",
          additionalProperties: false,
          required: [
            "waterfallStageCount",
            "changeMetricCount",
            "limitationCount",
            "observedUnitCount",
            "eligibleCompleteUnitCount",
            "unsupportedUnitCount"
          ],
          properties: {
            waterfallStageCount: COUNT_SCHEMA,
            changeMetricCount: COUNT_SCHEMA,
            limitationCount: COUNT_SCHEMA,
            observedUnitCount: COUNT_SCHEMA,
            eligibleCompleteUnitCount: COUNT_SCHEMA,
            unsupportedUnitCount: COUNT_SCHEMA
          }
        },
        artifact: ARTIFACT_POINTER_SCHEMA,
        limitations: LIMITATIONS_SCHEMA,
        deterministic: { const: true },
        evidenceRefCount: COUNT_SCHEMA
      }
    }
  });

const SCHEDULE_READ_OUTPUT_SCHEMA =
  createJsonCourseToolOutputSchema<CourseScheduleReadOutput>({
    schemaVersion: COURSE_SCHEDULE_READ_OUTPUT_SCHEMA_VERSION,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "anchor",
        "scheduleStateHash",
        "schedule",
        "governanceBoundary",
        "zeroWriteStatus",
        "limitations",
        "observedAt",
        "evidenceRefCount"
      ],
      properties: {
        schemaVersion: { const: COURSE_SCHEDULE_READ_OUTPUT_SCHEMA_VERSION },
        status: { const: "ready" },
        anchor: EXACT_ANCHOR_SCHEMA,
        scheduleStateHash: HASH_SCHEMA,
        schedule: SCHEDULE_PROJECTION_SCHEMA,
        governanceBoundary: GOVERNANCE_BOUNDARY_SCHEMA,
        zeroWriteStatus: {
          type: "string",
          enum: ["verified", "failed", "unavailable"]
        },
        limitations: LIMITATIONS_SCHEMA,
        observedAt: ISO_INSTANT_SCHEMA,
        evidenceRefCount: COUNT_SCHEMA
      }
    }
  });

const SCHEDULE_REVIEW_OUTPUT_SCHEMA =
  createJsonCourseToolOutputSchema<ScheduleReviewBundleOutput>({
    schemaVersion: SCHEDULE_REVIEW_BUNDLE_OUTPUT_SCHEMA_VERSION,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "anchor",
        "scheduleStateHash",
        "reviewHash",
        "artifact",
        "scheduleState",
        "nextWindows",
        "governanceBoundary",
        "zeroWriteStatus",
        "limitations",
        "deterministic",
        "observedAt",
        "evidenceRefCount"
      ],
      properties: {
        schemaVersion: { const: SCHEDULE_REVIEW_BUNDLE_OUTPUT_SCHEMA_VERSION },
        status: { const: "prepared" },
        anchor: EXACT_ANCHOR_SCHEMA,
        scheduleStateHash: HASH_SCHEMA,
        reviewHash: HASH_SCHEMA,
        artifact: ARTIFACT_POINTER_SCHEMA,
        scheduleState: {
          type: "string",
          enum: ["active", "configured", "paused", "attention", "unavailable"]
        },
        nextWindows: {
          type: "array",
          maxItems: 6,
          items: ISO_INSTANT_SCHEMA
        },
        governanceBoundary: GOVERNANCE_BOUNDARY_SCHEMA,
        zeroWriteStatus: {
          type: "string",
          enum: ["verified", "failed", "unavailable"]
        },
        limitations: LIMITATIONS_SCHEMA,
        deterministic: { const: true },
        observedAt: ISO_INSTANT_SCHEMA,
        evidenceRefCount: COUNT_SCHEMA
      }
    }
  });

export function parseResearchEvidencePackageOutput(
  value: unknown
): ResearchEvidencePackageOutput {
  return RESEARCH_OUTPUT_SCHEMA.parse(value);
}

export function parseCourseScheduleReadOutput(
  value: unknown
): CourseScheduleReadOutput {
  return SCHEDULE_READ_OUTPUT_SCHEMA.parse(value);
}

export function parseScheduleReviewBundleOutput(
  value: unknown
): ScheduleReviewBundleOutput {
  return SCHEDULE_REVIEW_OUTPUT_SCHEMA.parse(value);
}

function fail(
  safeCode: string,
  safeSummary: string,
  evidenceRefs: readonly EvidenceRef[] = []
): never {
  throw new CourseToolOperationError({
    outcome: "failed",
    safeCode,
    safeSummary,
    evidenceRefs
  });
}

function assertServerBoundContext(input: {
  resolved: ResolvedCourseContext;
  courseScope: Readonly<ServerToolExecutionContext["courseScope"]>;
}): void {
  if (
    input.resolved.anchor.courseAlias !== input.courseScope.alias ||
    (input.courseScope.manifestHash !== undefined &&
      input.resolved.anchor.manifestHash !== input.courseScope.manifestHash)
  ) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_CONFLICT",
      "Resolved context conflicts with the trusted server course scope."
    );
  }
}

async function resolveBoundContext(input: {
  contextRef: string;
  context: Readonly<ServerToolExecutionContext>;
  prisma: typeof defaultPrisma;
}): Promise<ResolvedCourseContext> {
  const resolved = await resolveCourseContext({
    courseAlias: input.context.courseScope.alias,
    contextRef: input.contextRef,
    prisma: input.prisma
  });
  assertServerBoundContext({
    resolved,
    courseScope: input.context.courseScope
  });
  return resolved;
}

function coreEvidenceRefs(context: ResolvedCourseContext): EvidenceRef[] {
  return context.evidenceRefs.map((ref) => ({
    kind: ref.kind,
    id: ref.id,
    hash: ref.hash,
    observedAt: ref.observedAt
  }));
}

function evidenceRefSetHash(refs: readonly EvidenceRef[]): string {
  return hashCourseToolValue(
    "course-operations-evidence-ref-set.v1",
    refs
      .map((ref) => ({
        kind: ref.kind,
        id: ref.id,
        hash: ref.hash,
        observedAt: ref.observedAt
      }))
      .sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          left.id.localeCompare(right.id) ||
          left.hash.localeCompare(right.hash) ||
          left.observedAt.localeCompare(right.observedAt)
      )
  );
}

function exactAnchorProjection(input: {
  context: ResolvedCourseContext;
  baselineSnapshotRef?: string | null;
}): ExactAnchorProjection {
  return {
    courseAlias: input.context.anchor.courseAlias,
    contextRef: `snapshot:${input.context.anchor.snapshotId}`,
    invocationRef: input.context.anchor.invocationId,
    snapshotRef: input.context.anchor.snapshotId,
    baselineSnapshotRef: input.baselineSnapshotRef ?? null,
    worldAsOf: input.context.anchor.worldAsOf,
    manifestHash: input.context.anchor.manifestHash,
    worldHash: input.context.anchor.worldHash,
    eventSetHash: input.context.anchor.eventSetHash,
    coverageHash: input.context.anchor.coverageHash,
    candidateSetHash: input.context.anchor.candidateSetHash
  };
}

function safeProjection<O extends CourseToolJsonValue>(
  output: O,
  safeSummary: string
) {
  return {
    model: output,
    safeSummary,
    containsForumText: false as const,
    containsIdentity: false as const,
    containsSecrets: false as const
  };
}

function artifactIdFor(write: CourseOperationArtifactVersionWrite): string {
  return `course-operation-artifact-${hashCourseToolValue(
    "course-operation-artifact-id.v1",
    {
      taskId: write.taskId,
      artifactKind: write.artifactKind,
      artifactKey: write.artifactKey
    }
  )}`;
}

function artifactVersionIdFor(
  write: CourseOperationArtifactVersionWrite
): string {
  return `course-operation-artifact-version-${hashCourseToolValue(
    "course-operation-artifact-version-id.v1",
    {
      taskId: write.taskId,
      runId: write.runId,
      artifactKind: write.artifactKind,
      versionKey: write.versionKey
    }
  )}`;
}

function pointerFromRecord(record: {
  id: string;
  artifactId: string;
  version: number;
  contentHash: string;
}): CourseOperationArtifactPointer {
  return Object.freeze({
    artifactId: record.artifactId,
    versionId: record.id,
    artifactRef: `artifact:${record.artifactId}`,
    versionRef: `artifact-version:${record.id}`,
    version: record.version,
    contentHash: record.contentHash
  });
}

type StoredArtifactRecord = {
  id: string;
  taskId: string;
  runId: string;
  artifactId: string;
  version: number;
  schemaVersion: string;
  artifactKind: string;
  contentClass: string;
  contentHash: string;
  draftBodyHash: string | null;
  contentRef: string | null;
  safeSummary: string;
  metadataJson: string;
  sourceRefsJson: string;
  regenerationRecipeJson: string | null;
  createdByCallId: string | null;
  expiresAt: Date | null;
};

function artifactWriteInput(
  write: Readonly<CourseOperationArtifactVersionWrite>
): {
  readonly artifactId: string;
  readonly versionId: string;
  readonly input: CreateArtifactVersionInput;
} {
  if (
    !isSafeIdentifier(write.taskId) ||
    !isSafeIdentifier(write.runId) ||
    !isSafeIdentifier(write.createdByCallId) ||
    !isSafeIdentifier(write.artifactKey) ||
    !isSafeIdentifier(write.versionKey) ||
    ![
      "research_evidence_package",
      "schedule_review_bundle"
    ].includes(write.artifactKind) ||
    !isIsoInstant(write.observedAt) ||
    !isSha256(write.contentHash) ||
    sanitizeCourseToolSummary(write.safeSummary) !== write.safeSummary
  ) {
    fail(
      "COURSE_OPERATION_ARTIFACT_WRITE_INVALID",
      "Course operation artifact write is not canonically bound."
    );
  }
  assertEvidenceRefs(write.sourceRefs);
  serializeSafeDurableValue(write.metadata, "metadata");
  normalizeEvidenceRefs(write.sourceRefs, "sourceRefs");
  const artifactId = artifactIdFor(write);
  const versionId = artifactVersionIdFor(write);
  return {
    artifactId,
    versionId,
    input: {
      id: versionId,
      taskId: write.taskId,
      runId: write.runId,
      artifactId,
      schemaVersion: COURSE_OPERATIONS_TOOL_SCHEMA_VERSION,
      artifactKind: write.artifactKind,
      contentClass: "safe_aggregate",
      contentHash: write.contentHash,
      draftBodyHash: null,
      contentRef: null,
      safeSummary: write.safeSummary,
      metadata: write.metadata,
      sourceRefs: write.sourceRefs,
      regenerationRecipe: null,
      createdByCallId: write.createdByCallId,
      createdAt: write.observedAt
    }
  };
}

function assertExistingArtifactMatches(input: {
  existing: StoredArtifactRecord;
  write: Readonly<CourseOperationArtifactVersionWrite>;
  artifactId: string;
  versionId: string;
}): void {
  const { existing, write, artifactId, versionId } = input;
  const metadataJson = serializeSafeDurableValue(write.metadata, "metadata");
  const sourceRefsJson = serializeSafeDurableValue(
    normalizeEvidenceRefs(write.sourceRefs, "sourceRefs"),
    "sourceRefs"
  );
  if (
    existing.id !== versionId ||
    existing.taskId !== write.taskId ||
    existing.runId !== write.runId ||
    existing.artifactId !== artifactId ||
    existing.schemaVersion !== COURSE_OPERATIONS_TOOL_SCHEMA_VERSION ||
    existing.artifactKind !== write.artifactKind ||
    existing.contentClass !== "safe_aggregate" ||
    existing.contentHash !== write.contentHash ||
    existing.draftBodyHash !== null ||
    existing.contentRef !== null ||
    existing.safeSummary !== write.safeSummary ||
    existing.metadataJson !== metadataJson ||
    existing.sourceRefsJson !== sourceRefsJson ||
    existing.regenerationRecipeJson !== null ||
    existing.createdByCallId !== write.createdByCallId ||
    existing.expiresAt !== null
  ) {
    fail(
      "COURSE_OPERATION_ARTIFACT_IDEMPOTENCY_CONFLICT",
      "Artifact version key is already bound to different immutable safe aggregates."
    );
  }
}

/**
 * Durable, deterministic adapter over the shared Workbench artifact ledger.
 * A repeated version key returns the same immutable version after checking all
 * safety-relevant fields; a changed payload fails closed.
 */
export function createDurableCourseOperationArtifactVersionAdapter(
  db: WorkbenchDb = defaultPrisma
): CreateCourseOperationArtifactVersion {
  return async (write) => {
    const { artifactId, versionId, input } = artifactWriteInput(write);
    const existing = (await db.workbenchArtifactVersionRecord.findUnique({
      where: { id: versionId }
    })) as StoredArtifactRecord | null;
    if (existing) {
      assertExistingArtifactMatches({
        existing,
        write,
        artifactId,
        versionId
      });
      return pointerFromRecord(existing);
    }
    try {
      const created = await createWorkbenchArtifactVersion(db, input);
      return pointerFromRecord(created);
    } catch (error) {
      const raced = (await db.workbenchArtifactVersionRecord.findUnique({
        where: { id: versionId }
      })) as StoredArtifactRecord | null;
      if (!raced) throw error;
      assertExistingArtifactMatches({
        existing: raced,
        write,
        artifactId,
        versionId
      });
      return pointerFromRecord(raced);
    }
  };
}

function assertArtifactPointer(
  pointer: CourseOperationArtifactPointer,
  expectedWrite: Readonly<CourseOperationArtifactVersionWrite>
): void {
  const expected = artifactWriteInput(expectedWrite);
  if (
    !pointer ||
    !isSafeIdentifier(pointer.artifactId) ||
    !isSafeIdentifier(pointer.versionId) ||
    !isSafeIdentifier(pointer.artifactRef) ||
    !isSafeIdentifier(pointer.versionRef) ||
    !Number.isSafeInteger(pointer.version) ||
    pointer.version < 1 ||
    pointer.artifactId !== expected.artifactId ||
    pointer.versionId !== expected.versionId ||
    pointer.artifactRef !== `artifact:${expected.artifactId}` ||
    pointer.versionRef !== `artifact-version:${expected.versionId}` ||
    pointer.contentHash !== expectedWrite.contentHash
  ) {
    fail(
      "COURSE_OPERATION_ARTIFACT_POINTER_INVALID",
      "Artifact ledger returned an invalid immutable version pointer."
    );
  }
}

function researchArtifactMetadata(input: {
  document: CourseResearchExport;
  exportSha256: string;
  exportByteLength: number;
}) {
  return {
    schemaVersion: RESEARCH_EVIDENCE_PACKAGE_ARTIFACT_SCHEMA_VERSION,
    generatedFrom: "persisted_aggregate_evidence" as const,
    exportSha256: input.exportSha256,
    exportByteLength: input.exportByteLength,
    exportDocument: input.document as unknown as SafeJsonValue,
    deterministic: true as const,
    containsForumText: false as const,
    containsIdentity: false as const,
    containsSecrets: false as const
  };
}

function researchArtifactWrite(input: {
  resolved: ResolvedCourseContext;
  context: Readonly<ServerToolExecutionContext>;
  contentHash: string;
  metadata: SafeJsonValue;
  evidenceRefs: readonly EvidenceRef[];
}): CourseOperationArtifactVersionWrite {
  return {
    taskId: input.context.taskId,
    runId: input.context.runId,
    createdByCallId: input.context.callId,
    artifactKey: `research-evidence-package:${input.resolved.anchor.courseAlias}`,
    versionKey: input.context.idempotencyKey,
    artifactKind: "research_evidence_package",
    contentHash: input.contentHash,
    safeSummary: RESEARCH_EVIDENCE_PACKAGE_SAFE_SUMMARY,
    metadata: input.metadata,
    sourceRefs: input.evidenceRefs,
    observedAt: input.context.now
  };
}

async function prepareResearchEvidencePackage(input: {
  resolved: ResolvedCourseContext;
  context: Readonly<ServerToolExecutionContext>;
  prisma: typeof defaultPrisma;
  createArtifactVersion: CreateCourseOperationArtifactVersion;
}): Promise<{
  output: ResearchEvidencePackageOutput;
  evidenceRefs: EvidenceRef[];
  metadata: SafeJsonValue;
}> {
  const workspace = await getAnchoredCourseEvidenceWorkspace({
    anchor: {
      courseAlias: input.resolved.anchor.courseAlias,
      invocationId: input.resolved.anchor.invocationId,
      snapshotId: input.resolved.anchor.snapshotId
    },
    prisma: input.prisma
  });
  if (
    workspace.status !== "ready" ||
    !workspace.anchor ||
    workspace.anchor.courseAlias !== input.resolved.anchor.courseAlias ||
    workspace.anchor.invocationId !== input.resolved.anchor.invocationId ||
    workspace.anchor.snapshotId !== input.resolved.anchor.snapshotId ||
    workspace.containsForumText !== false ||
    workspace.containsIdentity !== false
  ) {
    fail(
      "RESEARCH_EVIDENCE_PACKAGE_ANCHOR_CONFLICT",
      "Research aggregates do not preserve the exact trusted course anchor."
    );
  }
  const researchExport = buildCourseResearchExport(workspace);
  if (
    researchExport.document.containsForumText !== false ||
    researchExport.document.containsIdentity !== false ||
    !isSha256(researchExport.sha256)
  ) {
    fail(
      "RESEARCH_EVIDENCE_PACKAGE_PRIVACY_BOUNDARY",
      "Research export did not satisfy the safe aggregate boundary."
    );
  }
  const exportByteLength = Buffer.byteLength(researchExport.json, "utf8");
  const evidenceRefs = coreEvidenceRefs(input.resolved);
  const metadata = researchArtifactMetadata({
    document: researchExport.document,
    exportSha256: researchExport.sha256,
    exportByteLength
  }) as unknown as SafeJsonValue;
  const write = researchArtifactWrite({
    resolved: input.resolved,
    context: input.context,
    contentHash: researchExport.sha256,
    metadata,
    evidenceRefs
  });
  artifactWriteInput(write);
  const pointer = await input.createArtifactVersion(write);
  assertArtifactPointer(pointer, write);
  const anchor = exactAnchorProjection({
    context: input.resolved,
    baselineSnapshotRef: workspace.anchor.baselineSnapshotId
  });
  const output: ResearchEvidencePackageOutput = {
    schemaVersion: RESEARCH_EVIDENCE_PACKAGE_OUTPUT_SCHEMA_VERSION,
    status: "prepared",
    anchor,
    exportSchemaVersion: researchExport.document.schemaVersion,
    exportSha256: researchExport.sha256,
    exportByteLength,
    aggregateCounts: {
      waterfallStageCount: researchExport.document.waterfall.stages.length,
      changeMetricCount: researchExport.document.change.metrics.length,
      limitationCount: researchExport.document.limitations.length,
      observedUnitCount: researchExport.document.portrait.allObservedUnitCount,
      eligibleCompleteUnitCount:
        researchExport.document.portrait.eligibleCompleteUnitCount,
      unsupportedUnitCount:
        researchExport.document.portrait.unsupportedUnitCount
    },
    artifact: pointer,
    limitations: researchExport.document.limitations,
    deterministic: true,
    evidenceRefCount: evidenceRefs.length
  };
  RESEARCH_OUTPUT_SCHEMA.parse(output);
  return { output, evidenceRefs, metadata };
}

type ScheduleRow = {
  id: string;
  courseAlias: string;
  enabled: boolean;
  mode: string;
  intervalMinutes: number;
  timeZone: string;
  nextRunAt: Date | null;
};

type GovernanceRow = {
  id: string;
  courseAlias: string;
  version: string;
  baseManifestHash: string;
  status: string;
  mode: string;
  dailySlotLimit: number;
  perTickActionLimit: number;
  authorTouchLimit30d: number;
  minIntervalMinutes: number;
  validFrom: Date;
  validUntil: Date;
  emergencyHalt: boolean;
  governanceHash: string;
  containsForumText: boolean;
};

type InvocationRow = {
  id: string;
  courseAlias: string;
  scheduleId: string | null;
  manifestHash: string;
  status: string;
  scheduledFor: Date;
};

type WakeRow = {
  id: string;
  status: string;
  startedAt: Date;
  editorWriteCount: number;
  publishAttemptCount: number;
  realPublishEnabled: boolean;
  containsForumText: boolean;
};

const TIME_ZONE_PATTERN = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/u;

function validDate(value: Date | null): boolean {
  return value === null || Number.isFinite(value.getTime());
}

function assertScheduleRows(
  rows: readonly ScheduleRow[],
  context: ResolvedCourseContext
): void {
  for (const row of rows) {
    if (
      row.courseAlias !== context.anchor.courseAlias ||
      !isSafeIdentifier(row.id) ||
      typeof row.enabled !== "boolean" ||
      typeof row.mode !== "string" ||
      !row.mode ||
      row.mode.length > 64 ||
      !Number.isSafeInteger(row.intervalMinutes) ||
      row.intervalMinutes < 1 ||
      row.intervalMinutes > 10080 ||
      typeof row.timeZone !== "string" ||
      !TIME_ZONE_PATTERN.test(row.timeZone) ||
      row.timeZone.length > 80 ||
      !validDate(row.nextRunAt)
    ) {
      fail(
        "COURSE_SCHEDULE_STATE_CONFLICT",
        "Persisted schedule rows do not satisfy the safe exact-course contract."
      );
    }
  }
  const enabled = rows.filter((row) => row.enabled);
  if (enabled.length > 1 || (enabled.length === 0 && rows.length > 1)) {
    fail(
      "COURSE_SCHEDULE_AMBIGUOUS",
      "Course schedule state is ambiguous and cannot be projected."
    );
  }
}

function governanceProjection(input: {
  row: GovernanceRow | null;
  manifestHash: string;
  now: Date;
}): GovernanceBoundaryProjection {
  if (!input.row) {
    return {
      status: "missing",
      integrityState: "unavailable",
      governanceRef: null,
      version: null,
      governanceHash: null,
      baseManifestHash: null,
      mode: null,
      validFrom: null,
      validUntil: null,
      emergencyHalt: false,
      limits: null
    };
  }
  const row = input.row;
  if (
    row.containsForumText !== false ||
    !isSafeIdentifier(row.id) ||
    !isSafeIdentifier(row.version) ||
    row.baseManifestHash !== input.manifestHash ||
    !isSha256(row.governanceHash)
  ) {
    fail(
      "COURSE_SCHEDULE_GOVERNANCE_CONFLICT",
      "Course governance does not match the exact manifest or privacy boundary."
    );
  }
  const integrity = assessCourseOperationGovernanceIntegrity({
    record: row,
    currentManifestHash: input.manifestHash
  });
  if (integrity.state !== "valid") {
    fail(
      "COURSE_SCHEDULE_GOVERNANCE_TAMPERED",
      "Course governance hash or manifest binding could not be verified."
    );
  }
  const safe = safeCourseOperationGovernanceState({
    record: row,
    currentManifestHash: input.manifestHash,
    now: input.now
  });
  if (
    ![
      "active",
      "paused",
      "revoked",
      "expired",
      "emergency_halt",
      "not_yet_valid"
    ].includes(safe.status)
  ) {
    fail(
      "COURSE_SCHEDULE_GOVERNANCE_STATE_INVALID",
      "Course governance state is outside the read-only schedule contract."
    );
  }
  return {
    status: safe.status as GovernanceBoundaryProjection["status"],
    integrityState: "valid",
    governanceRef: row.id,
    version: safe.version,
    governanceHash: safe.governanceHash,
    baseManifestHash: safe.baseManifestHash,
    mode: safe.mode,
    validFrom: safe.validFrom,
    validUntil: safe.validUntil,
    emergencyHalt: safe.emergencyHalt,
    limits: {
      dailySlotLimit: row.dailySlotLimit,
      perTickActionLimit: row.perTickActionLimit,
      authorTouchLimit30d: row.authorTouchLimit30d,
      minIntervalMinutes: row.minIntervalMinutes
    }
  };
}

function scheduleLimitations(input: {
  summary: OperatorScheduleSummary;
  governance: GovernanceBoundaryProjection;
  zeroWriteStatus: CourseScheduleReadOutput["zeroWriteStatus"];
}): string[] {
  const limitations = [
    "Schedule state is a read-only deterministic projection and creates no course or platform mutation.",
    "Projected windows are operational timing evidence, not proof of intervention or educational effect.",
    "The latest wake receipt is worker-scoped and is used only for a bounded zero-write status."
  ];
  if (input.governance.status === "missing") {
    limitations.push("No effective course-operation governance row was available.");
  } else if (input.governance.status !== "active") {
    limitations.push("Current governance is not active for autonomous execution.");
  }
  if (input.summary.state === "attention") {
    limitations.push("Schedule and governance require operator attention before execution.");
  }
  if (input.zeroWriteStatus === "unavailable") {
    limitations.push("No bounded wake receipt was available at this cutoff.");
  } else if (input.zeroWriteStatus === "failed") {
    limitations.push("The latest bounded wake receipt does not establish zero-write status.");
  }
  return limitations;
}

function scheduleStateMaterial(input: {
  anchor: ExactAnchorProjection;
  schedule: ScheduleProjection;
  governanceBoundary: GovernanceBoundaryProjection;
  zeroWriteStatus: CourseScheduleReadOutput["zeroWriteStatus"];
  limitations: readonly string[];
  observedAt: string;
}): CourseToolJsonValue {
  return {
    schemaVersion: COURSE_SCHEDULE_READ_OUTPUT_SCHEMA_VERSION,
    anchor: input.anchor,
    schedule: input.schedule,
    governanceBoundary: input.governanceBoundary,
    zeroWriteStatus: input.zeroWriteStatus,
    limitations: [...input.limitations],
    observedAt: input.observedAt
  };
}

function appendScheduleEvidence(input: {
  refs: readonly EvidenceRef[];
  scheduleStateHash: string;
  governance: GovernanceBoundaryProjection;
  latestInvocation: InvocationRow | null;
  observedAt: string;
}): EvidenceRef[] {
  const refs = [...input.refs];
  if (
    input.latestInvocation &&
    !refs.some(
      (ref) =>
        ref.kind === "invocation" &&
        ref.id === input.latestInvocation?.id
    )
  ) {
    refs.push({
      kind: "invocation",
      id: input.latestInvocation.id,
      hash: hashCourseToolValue("course-schedule-invocation-state.v1", {
        invocationRef: input.latestInvocation.id,
        scheduleRef: input.latestInvocation.scheduleId,
        manifestHash: input.latestInvocation.manifestHash,
        status: input.latestInvocation.status,
        scheduledFor: input.latestInvocation.scheduledFor.toISOString()
      }),
      observedAt: input.latestInvocation.scheduledFor.toISOString()
    });
  }
  if (input.governance.governanceHash && input.governance.governanceRef) {
    refs.push({
      kind: "verification",
      id: `governance:${input.governance.governanceRef}`,
      hash: input.governance.governanceHash,
      observedAt: input.observedAt
    });
  }
  refs.push({
    kind: "verification",
    id: `schedule-state:${input.scheduleStateHash}`,
    hash: input.scheduleStateHash,
    observedAt: input.observedAt
  });
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}\0${ref.id}\0${ref.hash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Read the current safe schedule projection for one already-resolved exact
 * course anchor. The query surface intentionally selects no budget JSON,
 * source body, identity, credential, URL, or mutable summary payload.
 */
export async function readAnchoredCourseScheduleState(input: {
  resolved: ResolvedCourseContext;
  now: string;
  prisma?: typeof defaultPrisma;
}): Promise<{
  readonly output: CourseScheduleReadOutput;
  readonly evidenceRefs: readonly EvidenceRef[];
}> {
  const db = input.prisma ?? defaultPrisma;
  if (
    !isIsoInstant(input.now) ||
    Date.parse(input.now) < Date.parse(input.resolved.anchor.worldAsOf)
  ) {
    fail(
      "COURSE_SCHEDULE_CUTOFF_INVALID",
      "Schedule read cutoff must be a valid server time at or after the evidence anchor."
    );
  }
  const now = new Date(input.now);
  const [schedules, governance, latestHostWake, latestWake] = await Promise.all([
    db.operationSchedule.findMany({
      where: { courseAlias: input.resolved.anchor.courseAlias },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
      select: {
        id: true,
        courseAlias: true,
        enabled: true,
        mode: true,
        intervalMinutes: true,
        timeZone: true,
        nextRunAt: true
      }
    }),
    db.courseOperationGovernancePolicy.findFirst({
      where: {
        courseAlias: input.resolved.anchor.courseAlias,
        validFrom: { lte: now }
      },
      orderBy: courseOperationGovernanceCurrentOrderBy(),
      select: {
        id: true,
        courseAlias: true,
        version: true,
        baseManifestHash: true,
        status: true,
        mode: true,
        dailySlotLimit: true,
        perTickActionLimit: true,
        authorTouchLimit30d: true,
        minIntervalMinutes: true,
        validFrom: true,
        validUntil: true,
        emergencyHalt: true,
        governanceHash: true,
        containsForumText: true
      }
    }),
    db.autonomyWorkerWakeReceipt.findFirst({
      where: {
        ...OPERATOR_WORKER_WAKE_SCOPE,
        startedAt: { lte: now }
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        startedAt: true,
        editorWriteCount: true,
        publishAttemptCount: true,
        realPublishEnabled: true,
        containsForumText: true
      }
    }),
    db.autonomyWorkerWakeReceipt.findFirst({
      where: { startedAt: { lte: now } },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        startedAt: true,
        editorWriteCount: true,
        publishAttemptCount: true,
        realPublishEnabled: true,
        containsForumText: true
      }
    })
  ]);
  const scheduleRows = schedules as ScheduleRow[];
  assertScheduleRows(scheduleRows, input.resolved);
  const enabled = scheduleRows.filter((row) => row.enabled);
  const selectedSchedule = enabled[0] ?? scheduleRows[0] ?? null;
  const latestInvocation = selectedSchedule
    ? ((await db.scheduledInvocation.findFirst({
        where: {
          courseAlias: input.resolved.anchor.courseAlias,
          scheduleId: selectedSchedule.id,
          scheduledFor: { lte: now }
        },
        orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
        select: {
          id: true,
          courseAlias: true,
          scheduleId: true,
          manifestHash: true,
          status: true,
          scheduledFor: true
        }
      })) as InvocationRow | null)
    : null;
  if (
    latestInvocation &&
    (latestInvocation.courseAlias !== input.resolved.anchor.courseAlias ||
      latestInvocation.scheduleId !== selectedSchedule?.id ||
      latestInvocation.manifestHash !== input.resolved.anchor.manifestHash ||
      !isSafeIdentifier(latestInvocation.id) ||
      !validDate(latestInvocation.scheduledFor))
  ) {
    fail(
      "COURSE_SCHEDULE_INVOCATION_CONFLICT",
      "Latest invocation is not exactly bound to the selected schedule and manifest."
    );
  }
  const hostWake = latestHostWake as WakeRow | null;
  const wake = latestWake as WakeRow | null;
  for (const receipt of [hostWake, wake]) {
    if (
      receipt &&
      (!isSafeIdentifier(receipt.id) ||
        !validDate(receipt.startedAt) ||
        !Number.isSafeInteger(receipt.editorWriteCount) ||
        receipt.editorWriteCount < 0 ||
        !Number.isSafeInteger(receipt.publishAttemptCount) ||
        receipt.publishAttemptCount < 0 ||
        receipt.containsForumText !== false)
    ) {
      fail(
        "COURSE_SCHEDULE_WAKE_PRIVACY_CONFLICT",
        "Latest wake receipt violates the safe zero-write projection boundary."
      );
    }
  }
  const governanceRow = governance as GovernanceRow | null;
  if (
    governanceRow &&
    governanceRow.courseAlias !== input.resolved.anchor.courseAlias
  ) {
    fail(
      "COURSE_SCHEDULE_GOVERNANCE_CONFLICT",
      "Course governance belongs to a different course."
    );
  }
  const governanceBoundary = governanceProjection({
    row: governanceRow,
    manifestHash: input.resolved.anchor.manifestHash,
    now
  });
  const summary = buildOperatorScheduleSummary({
    now,
    schedules: scheduleRows.map((row) => ({
      id: row.id,
      enabled: row.enabled,
      mode: row.mode,
      intervalMinutes: row.intervalMinutes,
      timeZone: row.timeZone,
      nextRunAt: row.nextRunAt
    })),
    governance: governanceRow
      ? {
          status: governanceRow.status,
          mode: governanceRow.mode,
          minIntervalMinutes: governanceRow.minIntervalMinutes,
          emergencyHalt: governanceRow.emergencyHalt,
          validFrom: governanceRow.validFrom,
          validUntil: governanceRow.validUntil
        }
      : null,
    latestInvocation: latestInvocation
      ? {
          scheduleId: latestInvocation.scheduleId,
          status: latestInvocation.status,
          scheduledFor: latestInvocation.scheduledFor
        }
      : null,
    latestHostWake: hostWake
      ? {
          status: hostWake.status,
          startedAt: hostWake.startedAt,
          editorWriteCount: hostWake.editorWriteCount,
          publishAttemptCount: hostWake.publishAttemptCount,
          realPublishEnabled: hostWake.realPublishEnabled,
          containsForumText: hostWake.containsForumText
        }
      : null,
    latestWake: wake
      ? {
          status: wake.status,
          startedAt: wake.startedAt,
          editorWriteCount: wake.editorWriteCount,
          publishAttemptCount: wake.publishAttemptCount,
          realPublishEnabled: wake.realPublishEnabled,
          containsForumText: wake.containsForumText
        }
      : null
  });
  const schedule: ScheduleProjection = {
    state: summary.state,
    scheduleRef: selectedSchedule?.id ?? null,
    mode: summary.mode,
    intervalMinutes: summary.intervalMinutes,
    timeZone: summary.timeZone,
    nextWindowAt: summary.nextWindowAt,
    nextWindowState: summary.nextWindowState,
    upcomingWindows: summary.upcomingWindows,
    latestInvocation:
      summary.latestInvocation && latestInvocation
        ? {
            invocationRef: latestInvocation.id,
            status: summary.latestInvocation.status,
            scheduledFor: summary.latestInvocation.scheduledFor
          }
        : null,
    latestWake:
      summary.latestWake && wake
        ? {
            wakeRef: wake.id,
            status: summary.latestWake.status,
            observedAt: summary.latestWake.observedAt,
            zeroWrite: summary.latestWake.zeroWrite
          }
        : null,
    externalWritesLocked: true
  };
  const zeroWriteStatus: CourseScheduleReadOutput["zeroWriteStatus"] =
    schedule.latestWake === null
      ? "unavailable"
      : schedule.latestWake.zeroWrite
        ? "verified"
        : "failed";
  const limitations = scheduleLimitations({
    summary,
    governance: governanceBoundary,
    zeroWriteStatus
  });
  const anchor = exactAnchorProjection({ context: input.resolved });
  const scheduleStateHash = hashCourseToolValue(
    "course-schedule-safe-state.v1",
    scheduleStateMaterial({
      anchor,
      schedule,
      governanceBoundary,
      zeroWriteStatus,
      limitations,
      observedAt: input.now
    })
  );
  const evidenceRefs = appendScheduleEvidence({
    refs: coreEvidenceRefs(input.resolved),
    scheduleStateHash,
    governance: governanceBoundary,
    latestInvocation,
    observedAt: input.now
  });
  const output: CourseScheduleReadOutput = {
    schemaVersion: COURSE_SCHEDULE_READ_OUTPUT_SCHEMA_VERSION,
    status: "ready",
    anchor,
    scheduleStateHash,
    schedule,
    governanceBoundary,
    zeroWriteStatus,
    limitations,
    observedAt: input.now,
    evidenceRefCount: evidenceRefs.length
  };
  SCHEDULE_READ_OUTPUT_SCHEMA.parse(output);
  return { output, evidenceRefs };
}

function scheduleReviewDocument(
  schedule: CourseScheduleReadOutput
): ScheduleReviewArtifactDocument {
  return {
    schemaVersion: SCHEDULE_REVIEW_ARTIFACT_SCHEMA_VERSION,
    generatedFrom: "persisted_safe_schedule_state",
    anchor: schedule.anchor,
    scheduleStateHash: schedule.scheduleStateHash,
    schedule: schedule.schedule,
    governanceBoundary: schedule.governanceBoundary,
    zeroWriteStatus: schedule.zeroWriteStatus,
    limitations: schedule.limitations,
    reconstruction: {
      deterministic: true,
      sourceSchemaVersion: COURSE_SCHEDULE_READ_OUTPUT_SCHEMA_VERSION
    },
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

function scheduleReviewHash(document: ScheduleReviewArtifactDocument): string {
  assertCourseToolJsonValue(document, "schedule review artifact");
  return hashCourseToolValue(
    SCHEDULE_REVIEW_ARTIFACT_SCHEMA_VERSION,
    document
  );
}

function scheduleReviewMetadata(input: {
  document: ScheduleReviewArtifactDocument;
  reviewHash: string;
}): SafeJsonValue {
  return {
    schemaVersion: SCHEDULE_REVIEW_ARTIFACT_SCHEMA_VERSION,
    reviewHash: input.reviewHash,
    reviewDocument: input.document as unknown as SafeJsonValue,
    deterministic: true,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

function scheduleReviewArtifactWrite(input: {
  resolved: ResolvedCourseContext;
  context: Readonly<ServerToolExecutionContext>;
  reviewHash: string;
  metadata: SafeJsonValue;
  evidenceRefs: readonly EvidenceRef[];
}): CourseOperationArtifactVersionWrite {
  return {
    taskId: input.context.taskId,
    runId: input.context.runId,
    createdByCallId: input.context.callId,
    artifactKey: `schedule-review-bundle:${input.resolved.anchor.courseAlias}`,
    versionKey: input.context.idempotencyKey,
    artifactKind: "schedule_review_bundle",
    contentHash: input.reviewHash,
    safeSummary: SCHEDULE_REVIEW_BUNDLE_SAFE_SUMMARY,
    metadata: input.metadata,
    sourceRefs: input.evidenceRefs,
    observedAt: input.context.now
  };
}

async function prepareScheduleReviewBundle(input: {
  resolved: ResolvedCourseContext;
  context: Readonly<ServerToolExecutionContext>;
  prisma: typeof defaultPrisma;
  createArtifactVersion: CreateCourseOperationArtifactVersion;
}): Promise<{
  output: ScheduleReviewBundleOutput;
  evidenceRefs: readonly EvidenceRef[];
  metadata: SafeJsonValue;
}> {
  const schedule = await readAnchoredCourseScheduleState({
    resolved: input.resolved,
    now: input.context.now,
    prisma: input.prisma
  });
  const document = scheduleReviewDocument(schedule.output);
  const reviewHash = scheduleReviewHash(document);
  const metadata = scheduleReviewMetadata({ document, reviewHash });
  const write = scheduleReviewArtifactWrite({
    resolved: input.resolved,
    context: input.context,
    reviewHash,
    metadata,
    evidenceRefs: schedule.evidenceRefs
  });
  artifactWriteInput(write);
  const pointer = await input.createArtifactVersion(write);
  assertArtifactPointer(pointer, write);
  const output: ScheduleReviewBundleOutput = {
    schemaVersion: SCHEDULE_REVIEW_BUNDLE_OUTPUT_SCHEMA_VERSION,
    status: "prepared",
    anchor: schedule.output.anchor,
    scheduleStateHash: schedule.output.scheduleStateHash,
    reviewHash,
    artifact: pointer,
    scheduleState: schedule.output.schedule.state,
    nextWindows: schedule.output.schedule.upcomingWindows,
    governanceBoundary: schedule.output.governanceBoundary,
    zeroWriteStatus: schedule.output.zeroWriteStatus,
    limitations: schedule.output.limitations,
    deterministic: true,
    observedAt: input.context.now,
    evidenceRefCount: schedule.evidenceRefs.length
  };
  SCHEDULE_REVIEW_OUTPUT_SCHEMA.parse(output);
  return { output, evidenceRefs: schedule.evidenceRefs, metadata };
}

const COMMON_PRECONDITIONS = [
  {
    code: "server_course_scope",
    safeDescription: "A trusted server course scope is required."
  },
  {
    code: "exact_context_ref",
    safeDescription: "An exact persisted context reference is required."
  }
] as const;

const COMMON_RETRY = {
  maxAttempts: 2,
  retryableStatuses: ["failed"],
  backoff: "exponential"
} as const;

/** Register three non-alias course-operation tools. */
export function createCourseOperationsToolRegistrations(
  deps: CourseOperationsToolRegistrationDeps = {}
): readonly CourseToolRegistration[] {
  const db = deps.prisma ?? defaultPrisma;
  const artifactWriter =
    deps.createArtifactVersion ??
    createDurableCourseOperationArtifactVersionAdapter(db);

  const research = defineCourseTool<
    ExactContextInput,
    ResearchEvidencePackageOutput
  >({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "research.evidence_package.prepare",
      version: "1",
      safeLabel: "Prepare research evidence package",
      safeDescription:
        "Builds and versions one deterministic aggregate research package from an exact persisted course evidence anchor.",
      capability: "L1_ARTIFACT",
      effect: "local_write",
      inputSchema: CONTEXT_INPUT_SCHEMA,
      outputSchema: RESEARCH_OUTPUT_SCHEMA,
      dataClasses: ["safe_aggregate", "opaque_evidence_ref"],
      preconditions: COMMON_PRECONDITIONS,
      idempotency: { strategy: "input_hash", scope: "task" },
      evidence: {
        required: true,
        minimumRefs: 5,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "coverage",
          "candidate"
        ]
      },
      verification: {
        required: true,
        subjectType: "artifact_version",
        verifiers: [
          { ...RESEARCH_EVIDENCE_PACKAGE_VERIFIER, required: true }
        ],
        mode: "all",
        onFailure: "failed"
      },
      retry: COMMON_RETRY
    },
    handler: async ({ input, context }) => {
      const resolved = await resolveBoundContext({
        contextRef: input.contextRef,
        context,
        prisma: db
      });
      const prepared = await prepareResearchEvidencePackage({
        resolved,
        context,
        prisma: db,
        createArtifactVersion: artifactWriter
      });
      return {
        output: prepared.output,
        evidenceRefs: prepared.evidenceRefs,
        verificationSubject: {
          type: "artifact_version",
          id: prepared.output.artifact.versionId
        },
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: () =>
      "Prepare one deterministic aggregate evidence package from an exact context.",
    projectOutput: (output) =>
      safeProjection(
        output,
        "Aggregate research evidence package was versioned with a deterministic hash and bounded counts."
      ),
    defaultForName: true
  });

  const scheduleRead = defineCourseTool<
    ExactContextInput,
    CourseScheduleReadOutput
  >({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "course.schedule.read",
      version: "1",
      safeLabel: "Read exact course schedule",
      safeDescription:
        "Reads the exact course schedule, governance boundary, latest bound invocation, and bounded zero-write wake status without mutation.",
      capability: "L0_READ",
      effect: "read",
      inputSchema: CONTEXT_INPUT_SCHEMA,
      outputSchema: SCHEDULE_READ_OUTPUT_SCHEMA,
      dataClasses: ["safe_aggregate", "opaque_evidence_ref"],
      preconditions: COMMON_PRECONDITIONS,
      idempotency: { strategy: "input_hash", scope: "step" },
      evidence: {
        required: true,
        minimumRefs: 5,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "coverage",
          "candidate",
          "verification"
        ]
      },
      verification: {
        required: true,
        subjectType: "tool_result",
        verifiers: [{ ...COURSE_SCHEDULE_READ_VERIFIER, required: true }],
        mode: "all",
        onFailure: "failed"
      },
      retry: COMMON_RETRY
    },
    handler: async ({ input, context }) => {
      const resolved = await resolveBoundContext({
        contextRef: input.contextRef,
        context,
        prisma: db
      });
      const read = await readAnchoredCourseScheduleState({
        resolved,
        now: context.now,
        prisma: db
      });
      return {
        output: read.output,
        evidenceRefs: read.evidenceRefs,
        verificationSubject: {
          type: "tool_result",
          id: `schedule-read:${read.output.scheduleStateHash}`
        },
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: () =>
      "Read one exact course schedule and zero-write governance projection.",
    projectOutput: (output) =>
      safeProjection(
        output,
        "Exact schedule state and zero-write boundary were read without mutation."
      ),
    defaultForName: true
  });

  const scheduleReview = defineCourseTool<
    ExactContextInput,
    ScheduleReviewBundleOutput
  >({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "schedule.review_bundle.create",
      version: "1",
      safeLabel: "Create schedule review bundle",
      safeDescription:
        "Rereads exact schedule state and versions a deterministic safe review artifact with next windows and zero-write boundaries.",
      capability: "L1_ARTIFACT",
      effect: "local_write",
      inputSchema: CONTEXT_INPUT_SCHEMA,
      outputSchema: SCHEDULE_REVIEW_OUTPUT_SCHEMA,
      dataClasses: ["safe_aggregate", "opaque_evidence_ref"],
      preconditions: COMMON_PRECONDITIONS,
      idempotency: { strategy: "input_hash", scope: "task" },
      evidence: {
        required: true,
        minimumRefs: 5,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "coverage",
          "candidate",
          "verification"
        ]
      },
      verification: {
        required: true,
        subjectType: "artifact_version",
        verifiers: [{ ...SCHEDULE_REVIEW_BUNDLE_VERIFIER, required: true }],
        mode: "all",
        onFailure: "failed"
      },
      retry: COMMON_RETRY
    },
    handler: async ({ input, context }) => {
      const resolved = await resolveBoundContext({
        contextRef: input.contextRef,
        context,
        prisma: db
      });
      const prepared = await prepareScheduleReviewBundle({
        resolved,
        context,
        prisma: db,
        createArtifactVersion: artifactWriter
      });
      return {
        output: prepared.output,
        evidenceRefs: prepared.evidenceRefs,
        verificationSubject: {
          type: "artifact_version",
          id: prepared.output.artifact.versionId
        },
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: () =>
      "Create one immutable review bundle from freshly reread schedule state.",
    projectOutput: (output) =>
      safeProjection(
        output,
        "Schedule review artifact was versioned with next windows and zero-write boundaries."
      ),
    defaultForName: true
  });

  return Object.freeze(
    [research, scheduleRead, scheduleReview].map(
      (registration) =>
        registration as unknown as CourseToolRegistration
    )
  );
}

export function createCourseOperationsToolRegistry(
  deps: CourseOperationsToolRegistrationDeps = {}
): CourseToolRegistry {
  const registrations = createCourseOperationsToolRegistrations(deps);
  return new CourseToolRegistry()
    .register(registrations[0]!)
    .register(registrations[1]!)
    .register(registrations[2]!)
    .seal();
}

function passed(code: string, safeSummary: string) {
  return { code, status: "passed" as const, safeSummary };
}

function failed(code: string, safeSummary: string) {
  return { code, status: "failed" as const, safeSummary };
}

function unknown(code: string, safeSummary: string) {
  return { code, status: "unknown" as const, safeSummary };
}

function verificationResult(input: {
  checks: Array<{
    code: string;
    status: "passed" | "failed" | "unknown";
    safeSummary: string;
  }>;
  evidenceRefs: readonly EvidenceRef[];
}): CourseToolVerifierResult {
  const status = input.checks.some((check) => check.status === "failed")
    ? "failed"
    : input.checks.some((check) => check.status === "unknown")
      ? "unknown"
      : "passed";
  return {
    status,
    checks: input.checks,
    evidenceRefs: input.evidenceRefs,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

async function readStoredArtifact(
  db: typeof defaultPrisma,
  versionId: string
): Promise<StoredArtifactRecord | null> {
  return (await db.workbenchArtifactVersionRecord.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      taskId: true,
      runId: true,
      artifactId: true,
      version: true,
      schemaVersion: true,
      artifactKind: true,
      contentClass: true,
      contentHash: true,
      draftBodyHash: true,
      contentRef: true,
      safeSummary: true,
      metadataJson: true,
      sourceRefsJson: true,
      regenerationRecipeJson: true,
      createdByCallId: true,
      expiresAt: true
    }
  })) as StoredArtifactRecord | null;
}

function artifactRecordMatches(input: {
  record: StoredArtifactRecord | null;
  pointer: CourseOperationArtifactPointer;
  write: Readonly<CourseOperationArtifactVersionWrite>;
}): { record: boolean; metadata: boolean; evidence: boolean } {
  const record = input.record;
  if (!record) return { record: false, metadata: false, evidence: false };
  const expected = artifactWriteInput(input.write);
  const pointerMatches =
    input.pointer.artifactId === expected.artifactId &&
    input.pointer.versionId === expected.versionId &&
    input.pointer.artifactRef === `artifact:${expected.artifactId}` &&
    input.pointer.versionRef === `artifact-version:${expected.versionId}` &&
    input.pointer.contentHash === input.write.contentHash;
  const recordMatches =
    pointerMatches &&
    record.id === expected.versionId &&
    record.artifactId === expected.artifactId &&
    record.version === input.pointer.version &&
    record.taskId === input.write.taskId &&
    record.runId === input.write.runId &&
    record.schemaVersion === COURSE_OPERATIONS_TOOL_SCHEMA_VERSION &&
    record.artifactKind === input.write.artifactKind &&
    record.contentClass === "safe_aggregate" &&
    record.contentHash === input.write.contentHash &&
    record.draftBodyHash === null &&
    record.contentRef === null &&
    record.safeSummary === input.write.safeSummary &&
    record.regenerationRecipeJson === null &&
    record.createdByCallId === input.write.createdByCallId &&
    record.expiresAt === null;
  const metadataMatches =
    record.metadataJson ===
    serializeSafeDurableValue(input.write.metadata, "metadata");
  const evidenceMatches =
    record.sourceRefsJson ===
    serializeSafeDurableValue(
      normalizeEvidenceRefs(input.write.sourceRefs, "sourceRefs"),
      "sourceRefs"
    );
  return {
    record: recordMatches,
    metadata: metadataMatches,
    evidence: evidenceMatches
  };
}

function outputHash(domain: string, output: CourseToolJsonValue): string {
  return hashCourseToolValue(domain, output);
}

/**
 * Replay verifiers reread the exact aggregate sources. Artifact verifiers also
 * reread the durable version row and compare its safe metadata and source refs.
 */
export function createCourseOperationsVerifierRegistrations(
  deps: CourseOperationsVerifierRegistrationDeps = {}
): readonly CourseToolVerifierRegistration[] {
  const db = deps.prisma ?? defaultPrisma;

  const research: CourseToolVerifierRegistration<
    ExactContextInput,
    ResearchEvidencePackageOutput
  > = {
    definition: {
      ...RESEARCH_EVIDENCE_PACKAGE_VERIFIER,
      safeLabel: "Replay research evidence package"
    },
    verify: async ({ definition, context, envelope, handlerResult }) => {
      if (
        definition.name !== "research.evidence_package.prepare" ||
        definition.version !== "1"
      ) {
        return verificationResult({
          checks: [failed("tool_binding", "Verifier was invoked for an unsupported tool.")],
          evidenceRefs: []
        });
      }
      let actual: ResearchEvidencePackageOutput;
      try {
        actual = parseResearchEvidencePackageOutput(handlerResult.output);
      } catch {
        return verificationResult({
          checks: [failed("output_schema", "Research package output failed its closed schema.")],
          evidenceRefs: []
        });
      }
      try {
        const businessInput = CONTEXT_INPUT_SCHEMA.parse(envelope.input);
        const resolved = await resolveBoundContext({
          contextRef: businessInput.contextRef,
          context,
          prisma: db
        });
        const workspace = await getAnchoredCourseEvidenceWorkspace({
          anchor: {
            courseAlias: resolved.anchor.courseAlias,
            invocationId: resolved.anchor.invocationId,
            snapshotId: resolved.anchor.snapshotId
          },
          prisma: db
        });
        const replay = buildCourseResearchExport(workspace);
        const exportByteLength = Buffer.byteLength(replay.json, "utf8");
        const expectedMetadata = researchArtifactMetadata({
          document: replay.document,
          exportSha256: replay.sha256,
          exportByteLength
        }) as unknown as SafeJsonValue;
        const expectedRefs = coreEvidenceRefs(resolved);
        const expectedWrite = researchArtifactWrite({
          resolved,
          context,
          contentHash: replay.sha256,
          metadata: expectedMetadata,
          evidenceRefs: expectedRefs
        });
        let record: StoredArtifactRecord | null;
        try {
          record = await readStoredArtifact(db, actual.artifact.versionId);
        } catch {
          return verificationResult({
            checks: [unknown("artifact_reread", "Durable artifact row could not be reread.")],
            evidenceRefs: expectedRefs
          });
        }
        const recordChecks = artifactRecordMatches({
          record,
          pointer: actual.artifact,
          write: expectedWrite
        });
        const expectedAnchor = exactAnchorProjection({
          context: resolved,
          baselineSnapshotRef: workspace.anchor?.baselineSnapshotId ?? null
        });
        const aggregateMatches =
          outputHash("research-evidence-anchor-replay.v1", actual.anchor) ===
            outputHash("research-evidence-anchor-replay.v1", expectedAnchor) &&
          actual.exportSchemaVersion === replay.document.schemaVersion &&
          actual.exportSha256 === replay.sha256 &&
          actual.artifact.contentHash === replay.sha256 &&
          actual.exportByteLength === exportByteLength &&
          actual.aggregateCounts.waterfallStageCount ===
            replay.document.waterfall.stages.length &&
          actual.aggregateCounts.changeMetricCount ===
            replay.document.change.metrics.length &&
          actual.aggregateCounts.limitationCount ===
            replay.document.limitations.length &&
          actual.aggregateCounts.observedUnitCount ===
            replay.document.portrait.allObservedUnitCount &&
          actual.aggregateCounts.eligibleCompleteUnitCount ===
            replay.document.portrait.eligibleCompleteUnitCount &&
          actual.aggregateCounts.unsupportedUnitCount ===
            replay.document.portrait.unsupportedUnitCount &&
          JSON.stringify(actual.limitations) ===
            JSON.stringify(replay.document.limitations);
        const evidenceMatches =
          evidenceRefSetHash(handlerResult.evidenceRefs) ===
          evidenceRefSetHash(expectedRefs) &&
          actual.evidenceRefCount === expectedRefs.length &&
          recordChecks.evidence;
        const subjectMatches =
          handlerResult.verificationSubject?.type === "artifact_version" &&
          handlerResult.verificationSubject.id === actual.artifact.versionId;
        return verificationResult({
          checks: [
            passed("server_scope_binding", "Replay used the trusted exact course scope."),
            aggregateMatches
              ? passed("fresh_aggregate_replay", "Research aggregates and export hash match a fresh exact replay.")
              : failed("fresh_aggregate_replay", "Research aggregates differ from a fresh exact replay."),
            recordChecks.record
              ? passed("artifact_record_binding", "Durable artifact row matches the task, run, kind, version and hash.")
              : failed("artifact_record_binding", "Durable artifact row does not match the output pointer."),
            recordChecks.metadata
              ? passed("artifact_metadata_binding", "Durable artifact metadata matches the replayed safe export document.")
              : failed("artifact_metadata_binding", "Durable artifact metadata differs from the replayed safe export document."),
            evidenceMatches
              ? passed("evidence_reference_binding", "Handler and artifact evidence refs match the exact replay.")
              : failed("evidence_reference_binding", "Evidence refs differ from the exact replay."),
            subjectMatches
              ? passed("verification_subject_binding", "Research artifact version is bound to the verification subject.")
              : failed("verification_subject_binding", "Research verification subject is not artifact-version bound.")
          ],
          evidenceRefs: expectedRefs
        });
      } catch {
        return verificationResult({
          checks: [unknown("fresh_aggregate_replay", "Fresh exact research aggregate replay was unavailable.")],
          evidenceRefs: []
        });
      }
    }
  };

  const scheduleRead: CourseToolVerifierRegistration<
    ExactContextInput,
    CourseScheduleReadOutput
  > = {
    definition: {
      ...COURSE_SCHEDULE_READ_VERIFIER,
      safeLabel: "Replay exact course schedule read"
    },
    verify: async ({ definition, context, envelope, handlerResult }) => {
      if (
        definition.name !== "course.schedule.read" ||
        definition.version !== "1"
      ) {
        return verificationResult({
          checks: [failed("tool_binding", "Verifier was invoked for an unsupported tool.")],
          evidenceRefs: []
        });
      }
      let actual: CourseScheduleReadOutput;
      try {
        actual = parseCourseScheduleReadOutput(handlerResult.output);
      } catch {
        return verificationResult({
          checks: [failed("output_schema", "Schedule read output failed its closed schema.")],
          evidenceRefs: []
        });
      }
      try {
        const businessInput = CONTEXT_INPUT_SCHEMA.parse(envelope.input);
        const resolved = await resolveBoundContext({
          contextRef: businessInput.contextRef,
          context,
          prisma: db
        });
        const replay = await readAnchoredCourseScheduleState({
          resolved,
          now: context.now,
          prisma: db
        });
        const outputMatches =
          outputHash("course-schedule-read-output-replay.v1", actual) ===
          outputHash(
            "course-schedule-read-output-replay.v1",
            replay.output
          );
        const evidenceMatches =
          evidenceRefSetHash(handlerResult.evidenceRefs) ===
          evidenceRefSetHash(replay.evidenceRefs);
        const subjectMatches =
          handlerResult.verificationSubject?.type === "tool_result" &&
          handlerResult.verificationSubject.id ===
            `schedule-read:${actual.scheduleStateHash}`;
        return verificationResult({
          checks: [
            passed("server_scope_binding", "Replay used the trusted exact course scope."),
            outputMatches
              ? passed("fresh_schedule_replay", "Schedule projection matches a fresh exact zero-write replay.")
              : failed("fresh_schedule_replay", "Schedule projection differs from a fresh exact replay."),
            evidenceMatches
              ? passed("evidence_reference_binding", "Schedule evidence refs match the fresh replay.")
              : failed("evidence_reference_binding", "Schedule evidence refs differ from the fresh replay."),
            subjectMatches
              ? passed("verification_subject_binding", "Schedule state hash is bound to the verification subject.")
              : failed("verification_subject_binding", "Schedule verification subject is not hash-bound.")
          ],
          evidenceRefs: replay.evidenceRefs
        });
      } catch {
        return verificationResult({
          checks: [unknown("fresh_schedule_replay", "Fresh exact schedule replay was unavailable.")],
          evidenceRefs: []
        });
      }
    }
  };

  const scheduleReview: CourseToolVerifierRegistration<
    ExactContextInput,
    ScheduleReviewBundleOutput
  > = {
    definition: {
      ...SCHEDULE_REVIEW_BUNDLE_VERIFIER,
      safeLabel: "Replay schedule review bundle"
    },
    verify: async ({ definition, context, envelope, handlerResult }) => {
      if (
        definition.name !== "schedule.review_bundle.create" ||
        definition.version !== "1"
      ) {
        return verificationResult({
          checks: [failed("tool_binding", "Verifier was invoked for an unsupported tool.")],
          evidenceRefs: []
        });
      }
      let actual: ScheduleReviewBundleOutput;
      try {
        actual = parseScheduleReviewBundleOutput(handlerResult.output);
      } catch {
        return verificationResult({
          checks: [failed("output_schema", "Schedule review output failed its closed schema.")],
          evidenceRefs: []
        });
      }
      try {
        const businessInput = CONTEXT_INPUT_SCHEMA.parse(envelope.input);
        const resolved = await resolveBoundContext({
          contextRef: businessInput.contextRef,
          context,
          prisma: db
        });
        const replay = await readAnchoredCourseScheduleState({
          resolved,
          now: context.now,
          prisma: db
        });
        const document = scheduleReviewDocument(replay.output);
        const expectedReviewHash = scheduleReviewHash(document);
        const expectedMetadata = scheduleReviewMetadata({
          document,
          reviewHash: expectedReviewHash
        });
        const expectedWrite = scheduleReviewArtifactWrite({
          resolved,
          context,
          reviewHash: expectedReviewHash,
          metadata: expectedMetadata,
          evidenceRefs: replay.evidenceRefs
        });
        let record: StoredArtifactRecord | null;
        try {
          record = await readStoredArtifact(db, actual.artifact.versionId);
        } catch {
          return verificationResult({
            checks: [unknown("artifact_reread", "Durable schedule review artifact could not be reread.")],
            evidenceRefs: replay.evidenceRefs
          });
        }
        const recordChecks = artifactRecordMatches({
          record,
          pointer: actual.artifact,
          write: expectedWrite
        });
        const outputMatches =
          outputHash("schedule-review-anchor-replay.v1", actual.anchor) ===
            outputHash(
              "schedule-review-anchor-replay.v1",
              replay.output.anchor
            ) &&
          actual.reviewHash === expectedReviewHash &&
          actual.artifact.contentHash === expectedReviewHash &&
          actual.scheduleStateHash === replay.output.scheduleStateHash &&
          actual.scheduleState === replay.output.schedule.state &&
          JSON.stringify(actual.nextWindows) ===
            JSON.stringify(replay.output.schedule.upcomingWindows) &&
          JSON.stringify(actual.governanceBoundary) ===
            JSON.stringify(replay.output.governanceBoundary) &&
          actual.zeroWriteStatus === replay.output.zeroWriteStatus &&
          JSON.stringify(actual.limitations) ===
            JSON.stringify(replay.output.limitations) &&
          actual.observedAt === replay.output.observedAt &&
          actual.evidenceRefCount === replay.evidenceRefs.length;
        const evidenceMatches =
          evidenceRefSetHash(handlerResult.evidenceRefs) ===
          evidenceRefSetHash(replay.evidenceRefs) &&
          recordChecks.evidence;
        const subjectMatches =
          handlerResult.verificationSubject?.type === "artifact_version" &&
          handlerResult.verificationSubject.id === actual.artifact.versionId;
        return verificationResult({
          checks: [
            passed("server_scope_binding", "Replay used the trusted exact course scope."),
            outputMatches
              ? passed("fresh_schedule_replay", "Schedule review hash matches a fresh exact replay.")
              : failed("fresh_schedule_replay", "Schedule review differs from a fresh exact replay."),
            recordChecks.record
              ? passed("artifact_record_binding", "Durable schedule review row matches the output pointer.")
              : failed("artifact_record_binding", "Durable schedule review row does not match the output pointer."),
            recordChecks.metadata
              ? passed("artifact_metadata_binding", "Durable schedule review metadata matches the recomputed document.")
              : failed("artifact_metadata_binding", "Durable schedule review metadata differs from the recomputed document."),
            evidenceMatches
              ? passed("evidence_reference_binding", "Schedule review source refs match the exact replay.")
              : failed("evidence_reference_binding", "Schedule review source refs differ from the exact replay."),
            subjectMatches
              ? passed("verification_subject_binding", "Schedule review artifact is bound to the verification subject.")
              : failed("verification_subject_binding", "Schedule review verification subject is not artifact-version bound.")
          ],
          evidenceRefs: replay.evidenceRefs
        });
      } catch {
        return verificationResult({
          checks: [unknown("fresh_schedule_replay", "Fresh exact schedule review replay was unavailable.")],
          evidenceRefs: []
        });
      }
    }
  };

  return Object.freeze(
    [research, scheduleRead, scheduleReview].map(
      (registration) =>
        registration as unknown as CourseToolVerifierRegistration
    )
  );
}

export function createCourseOperationsVerifierRegistry(
  deps: CourseOperationsVerifierRegistrationDeps = {},
  options: CourseToolVerifierRegistryOptions = {}
): CourseToolVerifierRegistry {
  const registrations = createCourseOperationsVerifierRegistrations(deps);
  return new CourseToolVerifierRegistry(options)
    .register(registrations[0]!)
    .register(registrations[1]!)
    .register(registrations[2]!)
    .seal();
}

export const COURSE_OPERATIONS_TOOL_REGISTRATIONS =
  createCourseOperationsToolRegistrations();
export const COURSE_OPERATIONS_VERIFIER_REGISTRATIONS =
  createCourseOperationsVerifierRegistrations();
export const COURSE_OPERATIONS_TOOL_DEFINITIONS = Object.freeze(
  COURSE_OPERATIONS_TOOL_REGISTRATIONS.map(
    (registration) => registration.definition
  )
);
export const COURSE_OPERATIONS_VERIFIER_DEFINITIONS = Object.freeze(
  COURSE_OPERATIONS_VERIFIER_REGISTRATIONS.map(
    (registration) => registration.definition
  )
);
