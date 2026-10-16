import { prisma as defaultPrisma } from "@/lib/db";
import {
  COURSE_TOOL_SCHEMA_VERSION,
  type CourseToolBusinessInput,
  type CourseToolJsonValue,
  type EvidenceRef,
  createJsonCourseToolOutputSchema,
  createJsonCourseToolSchema
} from "../contracts";
import { CourseToolRegistry, defineCourseTool } from "../registry";
import { canonicalProtocolHash } from "@/lib/facilitation-protocol";
import {
  CourseToolVerifierRegistry,
  type CourseToolVerifierRegistration,
  type CourseToolVerifierRegistryOptions
} from "../verifier-registry";
import {
  CourseContextToolError,
  readCourseSnapshot,
  resolveCourseContext,
  type CourseSnapshotReadResult,
  type ResolvedCourseContext
} from "./course-context";
import {
  listOpportunities,
  readOpportunityEvidence,
  selectSupportGap,
  verifyOpportunityIntegrity,
  type OpportunityClaimKind,
  type OpportunityEvidenceStatus,
  type OpportunityListResult,
  type OpportunityPredicate,
  type SupportGapOpportunityEvidence,
  type SupportGapSelection
} from "./opportunity-evidence";

export const COURSE_EVIDENCE_REGISTRATION_SCHEMA_VERSION =
  "cmooc.course-evidence-tool-registration.v1" as const;
export const SUPPORT_GAP_SELECTION_POLICY_VERSION =
  "mature-support-gap.highest-age-then-candidate-key.v1" as const;
export const OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION =
  "cmooc.course-tool.opportunity-integrity-ref.v1" as const;
export const SUPPORT_GAP_EVIDENCE_BINDING_SCHEMA_VERSION =
  "cmooc.course-tool.support-gap-evidence-binding.v1" as const;
export const SUPPORT_GAP_SELECTION_REF_SCHEMA_VERSION =
  "cmooc.course-tool.support-gap-selection-ref.v1" as const;
export const OPPORTUNITY_INTEGRITY_VERIFIER_NAME =
  "verification.opportunity_integrity" as const;
export const OPPORTUNITY_INTEGRITY_VERIFIER_VERSION = "1" as const;

type ContextRefInput = CourseToolBusinessInput & {
  readonly contextRef: string;
};

type OpportunityRefInput = ContextRefInput & {
  readonly opportunityId: string;
  readonly claim?: OpportunityClaimKind;
};

type PredicateState = OpportunityPredicate["status"];
type IntegrityCheck = "passed" | "failed" | "unknown" | "not_required";

type ContextToolOutput = {
  readonly schemaVersion: "cmooc.course-tool.course-context-output.v1";
  readonly status: "resolved";
  readonly contextRef: string;
  readonly invocationRef: string;
  readonly snapshotRef: string;
  readonly asOf: string;
  readonly manifestHash: string;
  readonly worldHash: string;
  readonly eventSetHash: string;
  readonly coverageHash: string;
  readonly candidateSetHash: string;
  readonly evidenceRefCount: number;
};

type SnapshotToolOutput = {
  readonly schemaVersion: "cmooc.course-tool.course-snapshot-output.v1";
  readonly status: "ready";
  readonly contextRef: string;
  readonly snapshotRef: string;
  readonly asOf: string;
  readonly worldHash: string;
  readonly coverageHash: string;
  readonly eventCount: number;
  readonly threadCount: number;
  readonly actorCount: number;
  readonly edgeCount: number;
  readonly openGapCount: number;
  readonly freshnessBasis: "exact_world_snapshot";
  readonly evidenceRefCount: number;
};

type SafeOpportunityItem = {
  readonly opportunityId: string;
  readonly candidateRef: string;
  readonly targetVersionHash: string;
  readonly stateHash: string | null;
  readonly supportGapHours: number | null;
  readonly status: OpportunityEvidenceStatus;
  readonly qualificationStatus: "qualified" | "stopped" | "unknown";
  readonly policyDecision: "draft" | "wait" | "abstain" | "yield" | "unknown";
  readonly candidateTargetBound: PredicateState;
  readonly targetStateHashValid: PredicateState;
  readonly targetComplete: PredicateState;
  readonly supportGapMature: PredicateState;
  readonly noExternalHumanResponse: PredicateState;
  readonly noDistinctActorResponse: PredicateState;
  readonly noAuthorReturn: PredicateState;
  readonly noSystemResponse: PredicateState;
};

type OpportunityListToolOutput = {
  readonly schemaVersion: "cmooc.course-tool.opportunity-list-output.v1";
  readonly status: "ready";
  readonly outcome: OpportunityListResult["outcome"];
  readonly boundaryCode:
    | "eligible_opportunities_available"
    | "all_sources_checked_no_mature_support_gap"
    | "required_evidence_unavailable"
    | "anchored_policy_no_safe_action";
  readonly contextRef: string;
  readonly snapshotRef: string;
  readonly asOf: string;
  readonly candidateSetHash: string;
  readonly coverageReceiptVerified: boolean;
  readonly courseCoverageComplete: boolean;
  readonly candidateSetVerified: true;
  readonly allCandidateTargetsAccountedFor: boolean;
  readonly totalCandidateCount: number;
  readonly returnedItemCount: number;
  readonly items: readonly SafeOpportunityItem[];
};

type OpportunityReadToolOutput = SafeOpportunityItem & {
  readonly schemaVersion: "cmooc.course-tool.opportunity-read-output.v1";
  readonly contextRef: string;
  readonly snapshotRef: string;
  readonly asOf: string;
  readonly claim: OpportunityClaimKind;
  readonly contentGraphRequired: boolean;
  readonly decisionRef: string | null;
  readonly candidateSetIntegrity: "verified";
  readonly targetProjectionIntegrity: "verified" | "failed" | "unavailable";
  readonly qualificationIntegrity: "verified" | "failed" | "unavailable";
  readonly policyReasonCount: number;
  readonly graphIntegrityStatus: "verified" | "failed" | "unavailable";
  readonly contentGraphHash: string | null;
  readonly nodeSetHash: string | null;
  readonly edgeSetHash: string | null;
  readonly graphNodeCount: number | null;
  readonly graphEdgeCount: number | null;
  readonly learnerNodeCount: number | null;
  readonly evidenceRefCount: number;
};

export type OpportunityVerificationToolOutput = {
  readonly schemaVersion: "cmooc.course-tool.opportunity-verification-output.v1";
  readonly status: OpportunityEvidenceStatus;
  readonly contextRef: string;
  readonly snapshotRef: string;
  readonly opportunityId: string;
  readonly integrityVerificationRef: string;
  readonly claim: OpportunityClaimKind;
  readonly candidateSetCheck: "passed";
  readonly targetProjectionCheck: IntegrityCheck;
  readonly targetPredicatesCheck: IntegrityCheck;
  readonly qualificationCheck: IntegrityCheck;
  readonly graphCheck: IntegrityCheck;
  readonly policyCheck: IntegrityCheck;
  readonly limitationCode:
    | "none"
    | "target_evidence_unavailable"
    | "target_not_support_gap"
    | "qualification_or_graph_unavailable"
    | "policy_no_safe_action";
  readonly evidenceRefCount: number;
};

export type OpportunitySelectionToolOutput = {
  readonly schemaVersion: "cmooc.course-tool.opportunity-selection-output.v1";
  readonly status:
    | "selected"
    | "no_action"
    | "evidence_unavailable"
    | "policy_no_safe_action";
  readonly contextRef: string;
  readonly snapshotRef: string;
  readonly asOf: string;
  readonly candidateSetHash: string;
  readonly selectionRef: string;
  readonly evidenceBindingHash: string;
  readonly selectionPolicyVersion: typeof SUPPORT_GAP_SELECTION_POLICY_VERSION;
  readonly selectedOpportunityId: string | null;
  readonly reasonCode:
    | "mature_support_gap_highest_age_then_candidate_key"
    | "all_sources_checked_no_mature_support_gap"
    | "qualified_candidates_blocked_by_policy"
    | "candidate_evidence_unknown_or_unavailable";
  readonly exclusions: readonly {
    readonly opportunityId: string;
    readonly status: OpportunityEvidenceStatus;
  }[];
};

type ResolveAdapter = (input: {
  courseAlias: string;
  contextRef: string;
  prisma: typeof defaultPrisma;
}) => Promise<ResolvedCourseContext>;

type SnapshotAdapter = (input: {
  context: ResolvedCourseContext;
  prisma: typeof defaultPrisma;
}) => Promise<CourseSnapshotReadResult>;

type ListAdapter = (input: {
  context: ResolvedCourseContext;
  prisma: typeof defaultPrisma;
}) => Promise<OpportunityListResult>;

type ReadOpportunityAdapter = (input: {
  context: ResolvedCourseContext;
  opportunityId: string;
  claim?: OpportunityClaimKind;
  prisma: typeof defaultPrisma;
}) => Promise<SupportGapOpportunityEvidence>;

export interface CourseEvidenceToolRegistrationDeps {
  readonly prisma?: typeof defaultPrisma;
  readonly resolveCourseContext?: ResolveAdapter;
  readonly readCourseSnapshot?: SnapshotAdapter;
  readonly listOpportunities?: ListAdapter;
  readonly readOpportunityEvidence?: ReadOpportunityAdapter;
  readonly verifyOpportunityIntegrity?: typeof verifyOpportunityIntegrity;
  readonly selectSupportGap?: typeof selectSupportGap;
}

export type CourseEvidenceVerifierRegistrationDeps = Pick<
  CourseEvidenceToolRegistrationDeps,
  | "prisma"
  | "resolveCourseContext"
  | "readOpportunityEvidence"
  | "verifyOpportunityIntegrity"
>;

const HASH_SCHEMA = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const NULLABLE_HASH_SCHEMA = {
  type: ["string", "null"],
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
const OPPORTUNITY_ID_SCHEMA = {
  type: "string",
  minLength: 13,
  maxLength: 192,
  pattern: "^support-gap:[A-Za-z0-9][A-Za-z0-9._:-]*$"
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
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER
} as const;
const PREDICATE_STATE_SCHEMA = {
  type: "string",
  enum: ["passed", "failed", "unknown"]
} as const;
const INTEGRITY_CHECK_SCHEMA = {
  type: "string",
  enum: ["passed", "failed", "unknown", "not_required"]
} as const;
const OPPORTUNITY_STATUS_SCHEMA = {
  type: "string",
  enum: [
    "eligible",
    "not_a_support_gap",
    "evidence_unavailable",
    "policy_no_safe_action"
  ]
} as const;
const CLAIM_SCHEMA = {
  type: "string",
  enum: ["mature_support_gap", "content_graph_structure"]
} as const;

const CONTEXT_INPUT_SCHEMA = createJsonCourseToolSchema<ContextRefInput>({
  schemaVersion: "cmooc.course-tool.context-ref-input.v1",
  modelJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["contextRef"],
    properties: { contextRef: CONTEXT_REF_SCHEMA }
  }
});

const OPPORTUNITY_INPUT_SCHEMA =
  createJsonCourseToolSchema<OpportunityRefInput>({
    schemaVersion: "cmooc.course-tool.opportunity-ref-input.v1",
    modelJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["contextRef", "opportunityId"],
      properties: {
        contextRef: CONTEXT_REF_SCHEMA,
        opportunityId: OPPORTUNITY_ID_SCHEMA,
        claim: CLAIM_SCHEMA
      }
    }
  });

const SAFE_OPPORTUNITY_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "opportunityId",
    "candidateRef",
    "targetVersionHash",
    "stateHash",
    "supportGapHours",
    "status",
    "qualificationStatus",
    "policyDecision",
    "candidateTargetBound",
    "targetStateHashValid",
    "targetComplete",
    "supportGapMature",
    "noExternalHumanResponse",
    "noDistinctActorResponse",
    "noAuthorReturn",
    "noSystemResponse"
  ],
  properties: {
    opportunityId: OPPORTUNITY_ID_SCHEMA,
    candidateRef: SAFE_ID_SCHEMA,
    targetVersionHash: HASH_SCHEMA,
    stateHash: NULLABLE_HASH_SCHEMA,
    supportGapHours: NULLABLE_COUNT_SCHEMA,
    status: OPPORTUNITY_STATUS_SCHEMA,
    qualificationStatus: {
      type: "string",
      enum: ["qualified", "stopped", "unknown"]
    },
    policyDecision: {
      type: "string",
      enum: ["draft", "wait", "abstain", "yield", "unknown"]
    },
    candidateTargetBound: PREDICATE_STATE_SCHEMA,
    targetStateHashValid: PREDICATE_STATE_SCHEMA,
    targetComplete: PREDICATE_STATE_SCHEMA,
    supportGapMature: PREDICATE_STATE_SCHEMA,
    noExternalHumanResponse: PREDICATE_STATE_SCHEMA,
    noDistinctActorResponse: PREDICATE_STATE_SCHEMA,
    noAuthorReturn: PREDICATE_STATE_SCHEMA,
    noSystemResponse: PREDICATE_STATE_SCHEMA
  }
} as const;

const CONTEXT_OUTPUT_SCHEMA =
  createJsonCourseToolOutputSchema<ContextToolOutput>({
    schemaVersion: "cmooc.course-tool.course-context-output.v1",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "contextRef",
        "invocationRef",
        "snapshotRef",
        "asOf",
        "manifestHash",
        "worldHash",
        "eventSetHash",
        "coverageHash",
        "candidateSetHash",
        "evidenceRefCount"
      ],
      properties: {
        schemaVersion: {
          const: "cmooc.course-tool.course-context-output.v1"
        },
        status: { const: "resolved" },
        contextRef: CONTEXT_REF_SCHEMA,
        invocationRef: SAFE_ID_SCHEMA,
        snapshotRef: SAFE_ID_SCHEMA,
        asOf: ISO_INSTANT_SCHEMA,
        manifestHash: HASH_SCHEMA,
        worldHash: HASH_SCHEMA,
        eventSetHash: HASH_SCHEMA,
        coverageHash: HASH_SCHEMA,
        candidateSetHash: HASH_SCHEMA,
        evidenceRefCount: COUNT_SCHEMA
      }
    }
  });

const SNAPSHOT_OUTPUT_SCHEMA =
  createJsonCourseToolOutputSchema<SnapshotToolOutput>({
    schemaVersion: "cmooc.course-tool.course-snapshot-output.v1",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "contextRef",
        "snapshotRef",
        "asOf",
        "worldHash",
        "coverageHash",
        "eventCount",
        "threadCount",
        "actorCount",
        "edgeCount",
        "openGapCount",
        "freshnessBasis",
        "evidenceRefCount"
      ],
      properties: {
        schemaVersion: {
          const: "cmooc.course-tool.course-snapshot-output.v1"
        },
        status: { const: "ready" },
        contextRef: CONTEXT_REF_SCHEMA,
        snapshotRef: SAFE_ID_SCHEMA,
        asOf: ISO_INSTANT_SCHEMA,
        worldHash: HASH_SCHEMA,
        coverageHash: HASH_SCHEMA,
        eventCount: COUNT_SCHEMA,
        threadCount: COUNT_SCHEMA,
        actorCount: COUNT_SCHEMA,
        edgeCount: COUNT_SCHEMA,
        openGapCount: COUNT_SCHEMA,
        freshnessBasis: { const: "exact_world_snapshot" },
        evidenceRefCount: COUNT_SCHEMA
      }
    }
  });

const OPPORTUNITY_LIST_OUTPUT_SCHEMA =
  createJsonCourseToolOutputSchema<OpportunityListToolOutput>({
    schemaVersion: "cmooc.course-tool.opportunity-list-output.v1",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "outcome",
        "boundaryCode",
        "contextRef",
        "snapshotRef",
        "asOf",
        "candidateSetHash",
        "coverageReceiptVerified",
        "courseCoverageComplete",
        "candidateSetVerified",
        "allCandidateTargetsAccountedFor",
        "totalCandidateCount",
        "returnedItemCount",
        "items"
      ],
      properties: {
        schemaVersion: {
          const: "cmooc.course-tool.opportunity-list-output.v1"
        },
        status: { const: "ready" },
        outcome: {
          type: "string",
          enum: [
            "opportunities_available",
            "no_action",
            "evidence_unavailable",
            "policy_no_safe_action"
          ]
        },
        boundaryCode: {
          type: "string",
          enum: [
            "eligible_opportunities_available",
            "all_sources_checked_no_mature_support_gap",
            "required_evidence_unavailable",
            "anchored_policy_no_safe_action"
          ]
        },
        contextRef: CONTEXT_REF_SCHEMA,
        snapshotRef: SAFE_ID_SCHEMA,
        asOf: ISO_INSTANT_SCHEMA,
        candidateSetHash: HASH_SCHEMA,
        coverageReceiptVerified: { type: "boolean" },
        courseCoverageComplete: { type: "boolean" },
        candidateSetVerified: { const: true },
        allCandidateTargetsAccountedFor: { type: "boolean" },
        totalCandidateCount: COUNT_SCHEMA,
        returnedItemCount: { type: "integer", minimum: 0, maximum: 5 },
        items: {
          type: "array",
          maxItems: 5,
          items: SAFE_OPPORTUNITY_ITEM_SCHEMA
        }
      }
    }
  });

const OPPORTUNITY_READ_OUTPUT_SCHEMA =
  createJsonCourseToolOutputSchema<OpportunityReadToolOutput>({
    schemaVersion: "cmooc.course-tool.opportunity-read-output.v1",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        ...SAFE_OPPORTUNITY_ITEM_SCHEMA.required,
        "schemaVersion",
        "contextRef",
        "snapshotRef",
        "asOf",
        "claim",
        "contentGraphRequired",
        "decisionRef",
        "candidateSetIntegrity",
        "targetProjectionIntegrity",
        "qualificationIntegrity",
        "policyReasonCount",
        "graphIntegrityStatus",
        "contentGraphHash",
        "nodeSetHash",
        "edgeSetHash",
        "graphNodeCount",
        "graphEdgeCount",
        "learnerNodeCount",
        "evidenceRefCount"
      ],
      properties: {
        ...SAFE_OPPORTUNITY_ITEM_SCHEMA.properties,
        schemaVersion: {
          const: "cmooc.course-tool.opportunity-read-output.v1"
        },
        contextRef: CONTEXT_REF_SCHEMA,
        snapshotRef: SAFE_ID_SCHEMA,
        asOf: ISO_INSTANT_SCHEMA,
        claim: CLAIM_SCHEMA,
        contentGraphRequired: { type: "boolean" },
        decisionRef: NULLABLE_SAFE_ID_SCHEMA,
        candidateSetIntegrity: { const: "verified" },
        targetProjectionIntegrity: {
          type: "string",
          enum: ["verified", "failed", "unavailable"]
        },
        qualificationIntegrity: {
          type: "string",
          enum: ["verified", "failed", "unavailable"]
        },
        policyReasonCount: COUNT_SCHEMA,
        graphIntegrityStatus: {
          type: "string",
          enum: ["verified", "failed", "unavailable"]
        },
        contentGraphHash: NULLABLE_HASH_SCHEMA,
        nodeSetHash: NULLABLE_HASH_SCHEMA,
        edgeSetHash: NULLABLE_HASH_SCHEMA,
        graphNodeCount: NULLABLE_COUNT_SCHEMA,
        graphEdgeCount: NULLABLE_COUNT_SCHEMA,
        learnerNodeCount: NULLABLE_COUNT_SCHEMA,
        evidenceRefCount: COUNT_SCHEMA
      }
    }
  });

const OPPORTUNITY_VERIFICATION_OUTPUT_SCHEMA =
  createJsonCourseToolOutputSchema<OpportunityVerificationToolOutput>({
    schemaVersion: "cmooc.course-tool.opportunity-verification-output.v1",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "contextRef",
        "snapshotRef",
        "opportunityId",
        "integrityVerificationRef",
        "claim",
        "candidateSetCheck",
        "targetProjectionCheck",
        "targetPredicatesCheck",
        "qualificationCheck",
        "graphCheck",
        "policyCheck",
        "limitationCode",
        "evidenceRefCount"
      ],
      properties: {
        schemaVersion: {
          const: "cmooc.course-tool.opportunity-verification-output.v1"
        },
        status: OPPORTUNITY_STATUS_SCHEMA,
        contextRef: CONTEXT_REF_SCHEMA,
        snapshotRef: SAFE_ID_SCHEMA,
        opportunityId: OPPORTUNITY_ID_SCHEMA,
        integrityVerificationRef: SAFE_ID_SCHEMA,
        claim: CLAIM_SCHEMA,
        candidateSetCheck: { const: "passed" },
        targetProjectionCheck: INTEGRITY_CHECK_SCHEMA,
        targetPredicatesCheck: INTEGRITY_CHECK_SCHEMA,
        qualificationCheck: INTEGRITY_CHECK_SCHEMA,
        graphCheck: INTEGRITY_CHECK_SCHEMA,
        policyCheck: INTEGRITY_CHECK_SCHEMA,
        limitationCode: {
          type: "string",
          enum: [
            "none",
            "target_evidence_unavailable",
            "target_not_support_gap",
            "qualification_or_graph_unavailable",
            "policy_no_safe_action"
          ]
        },
        evidenceRefCount: COUNT_SCHEMA
      }
    }
  });

const OPPORTUNITY_SELECTION_OUTPUT_SCHEMA =
  createJsonCourseToolOutputSchema<OpportunitySelectionToolOutput>({
    schemaVersion: "cmooc.course-tool.opportunity-selection-output.v1",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "contextRef",
        "snapshotRef",
        "asOf",
        "candidateSetHash",
        "selectionRef",
        "evidenceBindingHash",
        "selectionPolicyVersion",
        "selectedOpportunityId",
        "reasonCode",
        "exclusions"
      ],
      properties: {
        schemaVersion: {
          const: "cmooc.course-tool.opportunity-selection-output.v1"
        },
        status: {
          type: "string",
          enum: [
            "selected",
            "no_action",
            "evidence_unavailable",
            "policy_no_safe_action"
          ]
        },
        contextRef: CONTEXT_REF_SCHEMA,
        snapshotRef: SAFE_ID_SCHEMA,
        asOf: ISO_INSTANT_SCHEMA,
        candidateSetHash: HASH_SCHEMA,
        selectionRef: SAFE_ID_SCHEMA,
        evidenceBindingHash: HASH_SCHEMA,
        selectionPolicyVersion: {
          const: SUPPORT_GAP_SELECTION_POLICY_VERSION
        },
        selectedOpportunityId: {
          type: ["string", "null"],
          minLength: 13,
          maxLength: 192,
          pattern: "^support-gap:[A-Za-z0-9][A-Za-z0-9._:-]*$"
        },
        reasonCode: {
          type: "string",
          enum: [
            "mature_support_gap_highest_age_then_candidate_key",
            "all_sources_checked_no_mature_support_gap",
            "qualified_candidates_blocked_by_policy",
            "candidate_evidence_unknown_or_unavailable"
          ]
        },
        exclusions: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["opportunityId", "status"],
            properties: {
              opportunityId: OPPORTUNITY_ID_SCHEMA,
              status: OPPORTUNITY_STATUS_SCHEMA
            }
          }
        }
      }
    }
  });

/** Safe runtime parser for run-scoped protected verification material. */
export function parseOpportunityVerificationToolOutput(
  value: unknown
): OpportunityVerificationToolOutput {
  return OPPORTUNITY_VERIFICATION_OUTPUT_SCHEMA.parse(value);
}

/** Safe runtime parser for run-scoped protected selection material. */
export function parseOpportunitySelectionToolOutput(
  value: unknown
): OpportunitySelectionToolOutput {
  return OPPORTUNITY_SELECTION_OUTPUT_SCHEMA.parse(value);
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

const COMMON_IDEMPOTENCY = {
  strategy: "input_hash",
  scope: "step"
} as const;

const COMMON_VERIFICATION = {
  required: false,
  subjectType: "tool_result",
  verifiers: [],
  mode: "all",
  onFailure: "failed"
} as const;

const COMMON_RETRY = {
  maxAttempts: 2,
  retryableStatuses: ["failed"],
  backoff: "exponential"
} as const;

function coreEvidenceRefs(
  refs: readonly SupportGapOpportunityEvidence["evidenceRefs"][number][]
): EvidenceRef[] {
  const normalized = refs.map((ref): EvidenceRef => {
    const kind: EvidenceRef["kind"] =
      ref.kind === "target_projection"
        ? "candidate"
        : ref.kind === "qualification"
          ? "decision"
          : ref.kind;
    return {
      kind,
      id:
        ref.kind === "manifest"
          ? `manifest:${ref.hash}`
          : ref.kind === "target_projection"
            ? `${ref.id}:target`
            : ref.id,
      hash: ref.hash,
      observedAt: ref.observedAt
    };
  });
  return dedupeEvidenceRefs(normalized);
}

function contextEvidenceRefs(context: ResolvedCourseContext): EvidenceRef[] {
  return coreEvidenceRefs(context.evidenceRefs);
}

function listEvidenceRefs(result: OpportunityListResult): EvidenceRef[] {
  const itemRefs = result.items.flatMap((item) => item.evidenceRefs);
  if (itemRefs.length > 0) return coreEvidenceRefs(itemRefs);
  const anchor = result.exactAnchor;
  return [
    {
      kind: "manifest",
      id: `manifest:${anchor.manifestHash}`,
      hash: anchor.manifestHash,
      observedAt: anchor.worldAsOf
    },
    {
      kind: "invocation",
      id: anchor.invocationId,
      hash: anchor.manifestHash,
      observedAt: anchor.worldAsOf
    },
    {
      kind: "snapshot",
      id: anchor.snapshotId,
      hash: anchor.worldHash,
      observedAt: anchor.worldAsOf
    },
    {
      kind: "coverage",
      id: `${anchor.invocationId}:coverage`,
      hash: anchor.coverageHash,
      observedAt: anchor.worldAsOf
    },
    {
      kind: "candidate",
      id: `${anchor.invocationId}:candidate-set`,
      hash: anchor.candidateSetHash,
      observedAt: anchor.worldAsOf
    }
  ];
}

function dedupeEvidenceRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}\0${ref.id}\0${ref.hash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceRefSetHash(refs: readonly EvidenceRef[]): string {
  return canonicalProtocolHash(
    "cmooc.course-tool.evidence-ref-set.v1",
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

function verificationOutputHash(
  output: OpportunityVerificationToolOutput
): string {
  return canonicalProtocolHash(
    "cmooc.course-tool.opportunity-verification-replay.v1",
    { output }
  );
}

function exactSnapshotContextRef(context: ResolvedCourseContext): string {
  return `snapshot:${context.anchor.snapshotId}`;
}

function predicateState(
  evidence: SupportGapOpportunityEvidence,
  code: OpportunityPredicate["code"]
): PredicateState {
  return (
    evidence.target.predicates.find((predicate) => predicate.code === code)
      ?.status ?? "unknown"
  );
}

function safeOpportunityItem(
  evidence: SupportGapOpportunityEvidence
): SafeOpportunityItem {
  return {
    opportunityId: evidence.opportunityId,
    candidateRef: evidence.candidateKey,
    targetVersionHash: evidence.target.targetVersionHash,
    stateHash: evidence.target.stateHash,
    supportGapHours: evidence.target.supportGapHours,
    status: evidence.status,
    qualificationStatus: evidence.qualification.status,
    policyDecision: evidence.policy.decision,
    candidateTargetBound: predicateState(evidence, "candidate_target_bound"),
    targetStateHashValid: predicateState(
      evidence,
      "target_state_hash_valid"
    ),
    targetComplete: predicateState(evidence, "target_complete"),
    supportGapMature: predicateState(evidence, "support_gap_mature"),
    noExternalHumanResponse: predicateState(
      evidence,
      "no_external_human_response"
    ),
    noDistinctActorResponse: predicateState(
      evidence,
      "no_distinct_actor_response"
    ),
    noAuthorReturn: predicateState(evidence, "no_author_return"),
    noSystemResponse: predicateState(evidence, "no_system_response")
  };
}

function contextOutput(context: ResolvedCourseContext): ContextToolOutput {
  return {
    schemaVersion: "cmooc.course-tool.course-context-output.v1",
    status: "resolved",
    contextRef: exactSnapshotContextRef(context),
    invocationRef: context.anchor.invocationId,
    snapshotRef: context.anchor.snapshotId,
    asOf: context.anchor.worldAsOf,
    manifestHash: context.anchor.manifestHash,
    worldHash: context.anchor.worldHash,
    eventSetHash: context.anchor.eventSetHash,
    coverageHash: context.anchor.coverageHash,
    candidateSetHash: context.anchor.candidateSetHash,
    evidenceRefCount: context.evidenceRefs.length
  };
}

function snapshotOutput(result: CourseSnapshotReadResult): SnapshotToolOutput {
  return {
    schemaVersion: "cmooc.course-tool.course-snapshot-output.v1",
    status: "ready",
    contextRef: `snapshot:${result.anchor.snapshotId}`,
    snapshotRef: result.anchor.snapshotId,
    asOf: result.freshness.observedAt,
    worldHash: result.anchor.worldHash,
    coverageHash: result.anchor.coverageHash,
    eventCount: result.snapshot.eventCount,
    threadCount: result.snapshot.threadCount,
    actorCount: result.snapshot.actorCount,
    edgeCount: result.snapshot.edgeCount,
    openGapCount: result.snapshot.openGapCount,
    freshnessBasis: result.freshness.basis,
    evidenceRefCount: result.evidenceRefs.length
  };
}

function listBoundaryCode(
  outcome: OpportunityListResult["outcome"]
): OpportunityListToolOutput["boundaryCode"] {
  switch (outcome) {
    case "opportunities_available":
      return "eligible_opportunities_available";
    case "no_action":
      return "all_sources_checked_no_mature_support_gap";
    case "evidence_unavailable":
      return "required_evidence_unavailable";
    case "policy_no_safe_action":
      return "anchored_policy_no_safe_action";
  }
}

function listOutput(result: OpportunityListResult): OpportunityListToolOutput {
  const items = result.items.slice(0, 5).map(safeOpportunityItem);
  return {
    schemaVersion: "cmooc.course-tool.opportunity-list-output.v1",
    status: "ready",
    outcome: result.outcome,
    boundaryCode: listBoundaryCode(result.outcome),
    contextRef: `snapshot:${result.exactAnchor.snapshotId}`,
    snapshotRef: result.exactAnchor.snapshotId,
    asOf: result.exactAnchor.worldAsOf,
    candidateSetHash: result.exactAnchor.candidateSetHash,
    coverageReceiptVerified:
      result.sourceCompleteness.coverageReceiptVerified,
    courseCoverageComplete: result.sourceCompleteness.courseCoverageComplete,
    candidateSetVerified: true,
    allCandidateTargetsAccountedFor:
      result.sourceCompleteness.allCandidateTargetsAccountedFor,
    totalCandidateCount: result.totalCandidateCount,
    returnedItemCount: items.length,
    items
  };
}

function readOutput(
  evidence: SupportGapOpportunityEvidence
): OpportunityReadToolOutput {
  return {
    ...safeOpportunityItem(evidence),
    schemaVersion: "cmooc.course-tool.opportunity-read-output.v1",
    contextRef: `snapshot:${evidence.exactAnchor.snapshotId}`,
    snapshotRef: evidence.exactAnchor.snapshotId,
    asOf: evidence.exactAnchor.worldAsOf,
    claim: evidence.claim.kind,
    contentGraphRequired: evidence.claim.contentGraphRequired,
    decisionRef: evidence.qualification.decisionRef,
    candidateSetIntegrity: "verified",
    targetProjectionIntegrity: evidence.integrity.targetProjection,
    qualificationIntegrity: evidence.integrity.qualification,
    policyReasonCount: evidence.policy.reasonCodes.length,
    graphIntegrityStatus: evidence.graphIntegrity.status,
    contentGraphHash: evidence.graphIntegrity.contentGraphHash,
    nodeSetHash: evidence.graphIntegrity.nodeSetHash,
    edgeSetHash: evidence.graphIntegrity.edgeSetHash,
    graphNodeCount: evidence.graphIntegrity.nodeCount,
    graphEdgeCount: evidence.graphIntegrity.edgeCount,
    learnerNodeCount: evidence.graphIntegrity.learnerNodeCount,
    evidenceRefCount: evidence.evidenceRefs.length
  };
}

function integrityState(
  value: "verified" | "failed" | "unavailable"
): IntegrityCheck {
  return value === "verified"
    ? "passed"
    : value === "failed"
      ? "failed"
      : "unknown";
}

function predicateCheck(
  evidence: SupportGapOpportunityEvidence
): IntegrityCheck {
  if (evidence.target.predicates.some((item) => item.status === "unknown")) {
    return "unknown";
  }
  if (evidence.target.predicates.some((item) => item.status === "failed")) {
    return "failed";
  }
  return "passed";
}

function qualificationCheck(
  evidence: SupportGapOpportunityEvidence
): IntegrityCheck {
  if (evidence.integrity.qualification === "unavailable") return "unknown";
  if (
    evidence.integrity.qualification === "verified" &&
    evidence.qualification.status === "qualified"
  ) {
    return "passed";
  }
  return "failed";
}

function graphCheck(evidence: SupportGapOpportunityEvidence): IntegrityCheck {
  if (!evidence.claim.contentGraphRequired) return "not_required";
  return integrityState(evidence.graphIntegrity.status);
}

function policyCheck(evidence: SupportGapOpportunityEvidence): IntegrityCheck {
  if (evidence.policy.decision === "unknown") return "unknown";
  return evidence.policy.decision === "draft" &&
    evidence.policy.reasonCodes.length === 0
    ? "passed"
    : "failed";
}

function limitationCode(
  status: OpportunityEvidenceStatus,
  evidence: SupportGapOpportunityEvidence
): OpportunityVerificationToolOutput["limitationCode"] {
  if (status === "eligible") return "none";
  if (status === "not_a_support_gap") return "target_not_support_gap";
  if (status === "policy_no_safe_action") return "policy_no_safe_action";
  if (
    evidence.integrity.targetProjection !== "verified" ||
    evidence.target.predicates.some((item) => item.status === "unknown")
  ) {
    return "target_evidence_unavailable";
  }
  return "qualification_or_graph_unavailable";
}

function verificationOutput(input: {
  evidence: SupportGapOpportunityEvidence;
  status: OpportunityEvidenceStatus;
}): OpportunityVerificationToolOutput {
  const { evidence, status } = input;
  const integrityVerificationHash = canonicalProtocolHash(
    OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION,
    {
      schemaVersion: OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION,
      contextRef: `snapshot:${evidence.exactAnchor.snapshotId}`,
      invocationRef: evidence.exactAnchor.invocationId,
      snapshotRef: evidence.exactAnchor.snapshotId,
      worldHash: evidence.exactAnchor.worldHash,
      eventSetHash: evidence.exactAnchor.eventSetHash,
      coverageHash: evidence.exactAnchor.coverageHash,
      candidateSetHash: evidence.exactAnchor.candidateSetHash,
      opportunityId: evidence.opportunityId,
      claim: evidence.claim.kind,
      status,
      evidenceHashes: [...new Set(
        evidence.evidenceRefs.map((ref) => ref.hash)
      )].sort()
    }
  );
  return {
    schemaVersion: "cmooc.course-tool.opportunity-verification-output.v1",
    status,
    contextRef: `snapshot:${evidence.exactAnchor.snapshotId}`,
    snapshotRef: evidence.exactAnchor.snapshotId,
    opportunityId: evidence.opportunityId,
    integrityVerificationRef:
      `integrity-verification:${integrityVerificationHash}`,
    claim: evidence.claim.kind,
    candidateSetCheck: "passed",
    targetProjectionCheck: integrityState(evidence.integrity.targetProjection),
    targetPredicatesCheck: predicateCheck(evidence),
    qualificationCheck: qualificationCheck(evidence),
    graphCheck: graphCheck(evidence),
    policyCheck: policyCheck(evidence),
    limitationCode: limitationCode(status, evidence),
    evidenceRefCount: evidence.evidenceRefs.length
  };
}

function selectionOutput(input: {
  list: OpportunityListResult;
  selection: SupportGapSelection;
  toolPolicyVersion: string;
}): OpportunitySelectionToolOutput {
  const selectedOpportunityId =
    input.selection.selected?.opportunityId ?? null;
  const reasonCode: OpportunitySelectionToolOutput["reasonCode"] =
    input.selection.status === "selected"
      ? "mature_support_gap_highest_age_then_candidate_key"
      : input.selection.status === "no_action"
        ? "all_sources_checked_no_mature_support_gap"
        : input.selection.status === "policy_no_safe_action"
          ? "qualified_candidates_blocked_by_policy"
          : "candidate_evidence_unknown_or_unavailable";
  const contextRef = `snapshot:${input.list.exactAnchor.snapshotId}`;
  const evidenceBindingHash = canonicalProtocolHash(
    SUPPORT_GAP_EVIDENCE_BINDING_SCHEMA_VERSION,
    {
      schemaVersion: SUPPORT_GAP_EVIDENCE_BINDING_SCHEMA_VERSION,
      contextRef,
      invocationRef: input.list.exactAnchor.invocationId,
      snapshotRef: input.list.exactAnchor.snapshotId,
      worldHash: input.list.exactAnchor.worldHash,
      eventSetHash: input.list.exactAnchor.eventSetHash,
      coverageHash: input.list.exactAnchor.coverageHash,
      candidateSetHash: input.list.exactAnchor.candidateSetHash,
      toolPolicyVersion: input.toolPolicyVersion,
      selectionPolicyVersion: SUPPORT_GAP_SELECTION_POLICY_VERSION,
      selectedOpportunityId,
      reasonCode
    }
  );
  const exclusions = input.selection.exclusions.slice(0, 5);
  const selectionHash = canonicalProtocolHash(
    SUPPORT_GAP_SELECTION_REF_SCHEMA_VERSION,
    {
      schemaVersion: SUPPORT_GAP_SELECTION_REF_SCHEMA_VERSION,
      evidenceBindingHash,
      status: input.selection.status,
      selectedOpportunityId,
      reasonCode,
      exclusions
    }
  );
  return {
    schemaVersion: "cmooc.course-tool.opportunity-selection-output.v1",
    status: input.selection.status,
    contextRef,
    snapshotRef: input.list.exactAnchor.snapshotId,
    asOf: input.list.exactAnchor.worldAsOf,
    candidateSetHash: input.list.exactAnchor.candidateSetHash,
    selectionRef: `support-gap-selection:${selectionHash}`,
    evidenceBindingHash,
    selectionPolicyVersion: SUPPORT_GAP_SELECTION_POLICY_VERSION,
    selectedOpportunityId,
    reasonCode,
    exclusions
  };
}

function stripVerdict(evidence: SupportGapOpportunityEvidence): Omit<
  SupportGapOpportunityEvidence,
  "status" | "limitations"
> {
  const { status: _status, limitations: _limitations, ...base } = evidence;
  return base;
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

function assertServerBoundContext(input: {
  resolved: ResolvedCourseContext;
  courseAlias: string;
  manifestHash?: string;
}): void {
  if (
    input.resolved.anchor.courseAlias !== input.courseAlias ||
    (input.manifestHash !== undefined &&
      input.resolved.anchor.manifestHash !== input.manifestHash)
  ) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_CONFLICT",
      "Resolved context conflicts with the trusted server course scope."
    );
  }
}

export function createCourseEvidenceToolRegistrations(
  deps: CourseEvidenceToolRegistrationDeps = {}
) {
  const db = deps.prisma ?? defaultPrisma;
  const resolveAdapter = deps.resolveCourseContext ?? resolveCourseContext;
  const snapshotAdapter = deps.readCourseSnapshot ?? readCourseSnapshot;
  const listAdapter = deps.listOpportunities ?? listOpportunities;
  const readAdapter =
    deps.readOpportunityEvidence ?? readOpportunityEvidence;
  const verifyAdapter =
    deps.verifyOpportunityIntegrity ?? verifyOpportunityIntegrity;
  const selectAdapter = deps.selectSupportGap ?? selectSupportGap;

  const resolveBoundContext = async (
    input: Readonly<ContextRefInput>,
    courseScope: Readonly<{
      alias: string;
      manifestHash?: string;
    }>
  ): Promise<ResolvedCourseContext> => {
    const resolved = await resolveAdapter({
      courseAlias: courseScope.alias,
      contextRef: input.contextRef,
      prisma: db
    });
    assertServerBoundContext({
      resolved,
      courseAlias: courseScope.alias,
      manifestHash: courseScope.manifestHash
    });
    return resolved;
  };

  const contextRegistration = defineCourseTool<
    ContextRefInput,
    ContextToolOutput
  >({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "course.context.resolve",
      version: "1",
      safeLabel: "Resolve exact course context",
      safeDescription:
        "Resolves one explicit persisted context reference inside the trusted server course scope.",
      capability: "L0_READ",
      effect: "read",
      inputSchema: CONTEXT_INPUT_SCHEMA,
      outputSchema: CONTEXT_OUTPUT_SCHEMA,
      dataClasses: ["safe_aggregate", "opaque_evidence_ref"],
      preconditions: COMMON_PRECONDITIONS,
      idempotency: COMMON_IDEMPOTENCY,
      evidence: {
        required: true,
        minimumRefs: 1,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "coverage",
          "candidate"
        ]
      },
      verification: COMMON_VERIFICATION,
      retry: COMMON_RETRY
    },
    handler: async ({ input, context }) => {
      const resolved = await resolveBoundContext(input, context.courseScope);
      return {
        output: contextOutput(resolved),
        evidenceRefs: contextEvidenceRefs(resolved),
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: () => "Resolve one exact persisted course context reference.",
    projectOutput: (output) =>
      safeProjection(output, "Exact course context resolved."),
    defaultForName: true
  });

  const snapshotRegistration = defineCourseTool<
    ContextRefInput,
    SnapshotToolOutput
  >({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "course.snapshot.read",
      version: "1",
      safeLabel: "Read exact course snapshot",
      safeDescription:
        "Reads bounded aggregate counts from the exact resolved world snapshot without a latest fallback.",
      capability: "L0_READ",
      effect: "read",
      inputSchema: CONTEXT_INPUT_SCHEMA,
      outputSchema: SNAPSHOT_OUTPUT_SCHEMA,
      dataClasses: ["safe_aggregate", "opaque_evidence_ref"],
      preconditions: COMMON_PRECONDITIONS,
      idempotency: COMMON_IDEMPOTENCY,
      evidence: {
        required: true,
        minimumRefs: 1,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "coverage",
          "candidate"
        ]
      },
      verification: COMMON_VERIFICATION,
      retry: COMMON_RETRY
    },
    handler: async ({ input, context }) => {
      const resolved = await resolveBoundContext(input, context.courseScope);
      const snapshot = await snapshotAdapter({ context: resolved, prisma: db });
      return {
        output: snapshotOutput(snapshot),
        evidenceRefs: contextEvidenceRefs(resolved),
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: () => "Read bounded aggregates from one exact course snapshot.",
    projectOutput: (output) =>
      safeProjection(output, "Exact course snapshot aggregates read."),
    defaultForName: true
  });

  const listRegistration = defineCourseTool<
    ContextRefInput,
    OpportunityListToolOutput
  >({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "opportunity.list",
      version: "1",
      safeLabel: "List anchored support gaps",
      safeDescription:
        "Lists at most five exact support-gap candidates and preserves unavailable and policy boundaries.",
      capability: "L0_READ",
      effect: "read",
      inputSchema: CONTEXT_INPUT_SCHEMA,
      outputSchema: OPPORTUNITY_LIST_OUTPUT_SCHEMA,
      dataClasses: ["safe_aggregate", "opaque_evidence_ref"],
      preconditions: COMMON_PRECONDITIONS,
      idempotency: COMMON_IDEMPOTENCY,
      evidence: {
        required: true,
        minimumRefs: 1,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "coverage",
          "candidate",
          "decision"
        ]
      },
      verification: COMMON_VERIFICATION,
      retry: COMMON_RETRY
    },
    handler: async ({ input, context }) => {
      const resolved = await resolveBoundContext(input, context.courseScope);
      const opportunities = await listAdapter({ context: resolved, prisma: db });
      return {
        output: listOutput(opportunities),
        evidenceRefs: listEvidenceRefs(opportunities),
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: () => "List support-gap candidates at one exact evidence cutoff.",
    projectOutput: (output) =>
      safeProjection(output, "Anchored support-gap candidates classified."),
    defaultForName: true
  });

  const readRegistration = defineCourseTool<
    OpportunityRefInput,
    OpportunityReadToolOutput
  >({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "evidence.read_opportunity",
      version: "1",
      safeLabel: "Read opportunity evidence",
      safeDescription:
        "Reads bounded predicate, qualification, policy, and optional graph integrity state for one exact opportunity.",
      capability: "L0_READ",
      effect: "read",
      inputSchema: OPPORTUNITY_INPUT_SCHEMA,
      outputSchema: OPPORTUNITY_READ_OUTPUT_SCHEMA,
      dataClasses: ["safe_aggregate", "opaque_evidence_ref"],
      preconditions: COMMON_PRECONDITIONS,
      idempotency: COMMON_IDEMPOTENCY,
      evidence: {
        required: true,
        minimumRefs: 1,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "coverage",
          "candidate",
          "decision",
          "content_graph"
        ]
      },
      verification: COMMON_VERIFICATION,
      retry: COMMON_RETRY
    },
    handler: async ({ input, context }) => {
      const resolved = await resolveBoundContext(input, context.courseScope);
      const evidence = await readAdapter({
        context: resolved,
        opportunityId: input.opportunityId,
        claim: input.claim,
        prisma: db
      });
      return {
        output: readOutput(evidence),
        evidenceRefs: coreEvidenceRefs(evidence.evidenceRefs),
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: (input) =>
      `Read one exact opportunity for the ${input.claim ?? "mature_support_gap"} claim.`,
    projectOutput: (output) =>
      safeProjection(output, "Exact opportunity evidence read."),
    defaultForName: true
  });

  const verifyRegistration = defineCourseTool<
    OpportunityRefInput,
    OpportunityVerificationToolOutput
  >({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "evidence.verify_integrity",
      version: "1",
      safeLabel: "Verify opportunity integrity",
      safeDescription:
        "Rereads an exact opportunity and verifies target, qualification, policy, and claim-specific graph integrity.",
      capability: "L0_READ",
      effect: "read",
      inputSchema: OPPORTUNITY_INPUT_SCHEMA,
      outputSchema: OPPORTUNITY_VERIFICATION_OUTPUT_SCHEMA,
      dataClasses: ["safe_aggregate", "opaque_evidence_ref"],
      preconditions: COMMON_PRECONDITIONS,
      idempotency: COMMON_IDEMPOTENCY,
      evidence: {
        required: true,
        minimumRefs: 1,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "coverage",
          "candidate",
          "decision",
          "content_graph"
        ]
      },
      verification: {
        required: true,
        subjectType: "tool_result",
        verifiers: [
          {
            name: OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
            version: OPPORTUNITY_INTEGRITY_VERIFIER_VERSION,
            required: true
          }
        ],
        mode: "all",
        onFailure: "failed"
      },
      retry: COMMON_RETRY
    },
    handler: async ({ input, context }) => {
      const resolved = await resolveBoundContext(input, context.courseScope);
      const evidence = await readAdapter({
        context: resolved,
        opportunityId: input.opportunityId,
        claim: input.claim,
        prisma: db
      });
      const verdict = verifyAdapter({ evidence: stripVerdict(evidence) });
      const output = verificationOutput({
        evidence,
        status: verdict.status
      });
      return {
        output,
        evidenceRefs: coreEvidenceRefs(evidence.evidenceRefs),
        verificationSubject: {
          type: "tool_result",
          id: output.integrityVerificationRef
        },
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: (input) =>
      `Verify one exact opportunity for the ${input.claim ?? "mature_support_gap"} claim.`,
    projectOutput: (output) =>
      safeProjection(output, "Exact opportunity integrity classified."),
    defaultForName: true
  });

  const selectRegistration = defineCourseTool<
    ContextRefInput,
    OpportunitySelectionToolOutput
  >({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "opportunity.select_support_gap",
      version: "1",
      safeLabel: "Select anchored support gap",
      safeDescription:
        "Rereads the exact candidate set and applies the versioned deterministic support-gap ranking policy.",
      capability: "L0_READ",
      effect: "read",
      inputSchema: CONTEXT_INPUT_SCHEMA,
      outputSchema: OPPORTUNITY_SELECTION_OUTPUT_SCHEMA,
      dataClasses: ["safe_aggregate", "opaque_evidence_ref"],
      preconditions: COMMON_PRECONDITIONS,
      idempotency: COMMON_IDEMPOTENCY,
      evidence: {
        required: true,
        minimumRefs: 1,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "coverage",
          "candidate",
          "decision"
        ]
      },
      verification: COMMON_VERIFICATION,
      retry: COMMON_RETRY
    },
    handler: async ({ input, context }) => {
      const resolved = await resolveBoundContext(input, context.courseScope);
      const opportunities = await listAdapter({ context: resolved, prisma: db });
      const selection = selectAdapter(opportunities);
      return {
        output: selectionOutput({
          list: opportunities,
          selection,
          toolPolicyVersion: context.policyVersion
        }),
        evidenceRefs: listEvidenceRefs(opportunities),
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: () =>
      "Select one support gap from an exact persisted candidate set.",
    projectOutput: (output) =>
      safeProjection(output, "Deterministic support-gap selection completed."),
    defaultForName: true
  });

  return Object.freeze([
    contextRegistration,
    snapshotRegistration,
    listRegistration,
    readRegistration,
    verifyRegistration,
    selectRegistration
  ] as const);
}

export function createCourseEvidenceToolRegistry(
  deps: CourseEvidenceToolRegistrationDeps = {}
): CourseToolRegistry {
  const registrations = createCourseEvidenceToolRegistrations(deps);
  return new CourseToolRegistry()
    .register(registrations[0])
    .register(registrations[1])
    .register(registrations[2])
    .register(registrations[3])
    .register(registrations[4])
    .register(registrations[5])
    .seal();
}

/**
 * Independent read-only replay verifier for evidence.verify_integrity@1.
 * When installed in the executor's CourseToolVerifierRegistry, the executor
 * persists its receipt before committing the tool receipt.
 */
export function createCourseEvidenceVerifierRegistrations(
  deps: CourseEvidenceVerifierRegistrationDeps = {}
) {
  const db = deps.prisma ?? defaultPrisma;
  const resolveAdapter = deps.resolveCourseContext ?? resolveCourseContext;
  const readAdapter =
    deps.readOpportunityEvidence ?? readOpportunityEvidence;
  const verifyAdapter =
    deps.verifyOpportunityIntegrity ?? verifyOpportunityIntegrity;

  const registration: CourseToolVerifierRegistration<
    OpportunityRefInput,
    OpportunityVerificationToolOutput
  > = {
    definition: {
      name: OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
      version: OPPORTUNITY_INTEGRITY_VERIFIER_VERSION,
      safeLabel: "Replay opportunity integrity"
    },
    verify: async ({ definition, context, envelope, handlerResult }) => {
      if (
        definition.name !== "evidence.verify_integrity" ||
        definition.version !== "1"
      ) {
        return {
          status: "failed",
          checks: [
            {
              code: "tool_binding",
              status: "failed",
              safeSummary: "Verifier was invoked for an unsupported tool."
            }
          ],
          evidenceRefs: [],
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        };
      }

      let actual: OpportunityVerificationToolOutput;
      try {
        actual = parseOpportunityVerificationToolOutput(
          handlerResult.output
        );
      } catch {
        return {
          status: "failed",
          checks: [
            {
              code: "output_schema",
              status: "failed",
              safeSummary: "Integrity output failed its closed schema."
            }
          ],
          evidenceRefs: [],
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        };
      }

      try {
        const businessInput = OPPORTUNITY_INPUT_SCHEMA.parse(envelope.input);
        const resolved = await resolveAdapter({
          courseAlias: context.courseScope.alias,
          contextRef: businessInput.contextRef,
          prisma: db
        });
        assertServerBoundContext({
          resolved,
          courseAlias: context.courseScope.alias,
          manifestHash: context.courseScope.manifestHash
        });
        const evidence = await readAdapter({
          context: resolved,
          opportunityId: businessInput.opportunityId,
          claim: businessInput.claim,
          prisma: db
        });
        const verdict = verifyAdapter({ evidence: stripVerdict(evidence) });
        const expected = verificationOutput({
          evidence,
          status: verdict.status
        });
        const expectedEvidenceRefs = coreEvidenceRefs(evidence.evidenceRefs);
        const outputMatches =
          verificationOutputHash(actual) ===
          verificationOutputHash(expected);
        const integrityReferenceMatches =
          actual.integrityVerificationRef ===
          expected.integrityVerificationRef;
        const evidenceReferencesMatch =
          evidenceRefSetHash(handlerResult.evidenceRefs) ===
          evidenceRefSetHash(expectedEvidenceRefs);
        const status =
          outputMatches &&
          integrityReferenceMatches &&
          evidenceReferencesMatch
            ? "passed"
            : "failed";
        return {
          status,
          checks: [
            {
              code: "server_scope_binding",
              status: "passed",
              safeSummary: "Replay used the trusted server course scope."
            },
            {
              code: "fresh_evidence_replay",
              status: outputMatches ? "passed" : "failed",
              safeSummary: outputMatches
                ? "Integrity classification matches a fresh exact replay."
                : "Integrity classification differs from a fresh exact replay."
            },
            {
              code: "integrity_reference",
              status: integrityReferenceMatches ? "passed" : "failed",
              safeSummary: integrityReferenceMatches
                ? "Integrity reference matches the replayed evidence binding."
                : "Integrity reference does not match the replayed evidence binding."
            },
            {
              code: "evidence_reference_binding",
              status: evidenceReferencesMatch ? "passed" : "failed",
              safeSummary: evidenceReferencesMatch
                ? "Handler evidence references match the replayed evidence set."
                : "Handler evidence references differ from the replayed evidence set."
            }
          ],
          evidenceRefs: expectedEvidenceRefs,
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        };
      } catch {
        return {
          status: "unknown",
          checks: [
            {
              code: "fresh_evidence_replay",
              status: "unknown",
              safeSummary: "Fresh exact evidence replay was unavailable."
            }
          ],
          evidenceRefs: [],
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        };
      }
    }
  };
  return Object.freeze([registration] as const);
}

export function createCourseEvidenceVerifierRegistry(
  deps: CourseEvidenceVerifierRegistrationDeps = {},
  options: CourseToolVerifierRegistryOptions = {}
): CourseToolVerifierRegistry {
  const registrations = createCourseEvidenceVerifierRegistrations(deps);
  return new CourseToolVerifierRegistry(options)
    .register(registrations[0])
    .seal();
}

export const COURSE_EVIDENCE_TOOL_REGISTRATIONS =
  createCourseEvidenceToolRegistrations();

export const COURSE_EVIDENCE_VERIFIER_REGISTRATIONS =
  createCourseEvidenceVerifierRegistrations();

export const COURSE_EVIDENCE_TOOL_DEFINITIONS = Object.freeze(
  COURSE_EVIDENCE_TOOL_REGISTRATIONS.map(
    (registration) => registration.definition
  )
);
