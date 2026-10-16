export const PROTOCOL_SCHEMA_VERSIONS = {
  observationEnvelope: "cmooc.observation-envelope.v1",
  decisionEvidenceRef: "cmooc.decision-evidence-ref.v1",
  interventionIntent: "cmooc.intervention-intent.v1",
  facilitationMoveSpec: "cmooc.facilitation-move-spec.v1",
  boundTarget: "cmooc.bound-target.v1",
  reviewBundle: "cmooc.review-bundle.v1",
  capabilityRequest: "cmooc.capability-request.v1",
  executionCommand: "cmooc.execution-command.v1",
  executionReceipt: "cmooc.execution-receipt.v1",
  interventionEvent: "cmooc.intervention-event.v1"
} as const;

export const CANONICAL_HASH_ALGORITHM =
  "cmooc-canonical-json-sha256-v1" as const;

export const FACILITATION_FUNCTIONS = [
  "resource_connection",
  "cognitive_conflict",
  "emotional_support"
] as const;

export const TARGET_OBJECTS = [
  "thread_author",
  "specific_participant",
  "thread_participants"
] as const;

export const NEED_STATES = [
  "connection_gap",
  "conceptual_tension",
  "participation_barrier"
] as const;

export const MECHANISM_TARGETS = [
  "reduce_connection_cost",
  "surface_explanatory_tension",
  "lower_reentry_cost"
] as const;

export const FACILITATION_MOVES = [
  "connect_resource_and_invite_application",
  "pose_counterexample_and_request_explanation",
  "acknowledge_contribution_and_invite_return"
] as const;

export const OBSERVABLE_SUCCESS_CRITERIA = [
  "external_human_response",
  "original_author_return",
  "independent_responder_count",
  "reply_chain_extension",
  "resource_application_attempt",
  "explanatory_revision"
] as const;

export const PROHIBITED_MOVES = [
  "answer_on_behalf_of_learner",
  "identity_ranking",
  "stable_personality_judgment",
  "diagnostic_mental_state_claim",
  "unverifiable_learning_effect_claim"
] as const;

export const TEMPORAL_EVIDENCE_STATUSES = [
  "as_of_verified",
  "as_of_unverified",
  "source_censored"
] as const;

export const CONTENT_REVISION_STATUSES = [
  "not_included",
  "decision_time_version_verified",
  "final_export_revision_unknown"
] as const;

export const WITHDRAWAL_CONDITIONS = [
  "external_human_response",
  "source_censored",
  "candidate_expired",
  "budget_unavailable",
  "target_version_changed",
  "author_cooldown_active",
  "human_rejected"
] as const;

export const CAPABILITIES = [
  "system.inspect",
  "adapter.inspect_auth",
  "forum.observe",
  "intervention.preview",
  "forum.compose_draft",
  "research.decision.audit",
  "research.scheduler.benchmark",
  "review.open",
  "schedule.preview.configure",
  "schedule.preview.run",
  "events.read_redacted",
  "forum.execute_authorized"
] as const;

const HASH_PATTERN = "^[a-f0-9]{64}$";
const STABLE_KEY_PATTERN = "^[a-f0-9]{24}$";
const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const CONTROLLED_ID_PATTERN = "^[a-z][a-z0-9_]{1,63}$";
const ISO_DATETIME_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?(?:Z|[+-]\\d{2}:\\d{2})?$";

const strictObject = {
  type: "object",
  additionalProperties: false
} as const;

const hash = {
  type: "string",
  pattern: HASH_PATTERN
} as const;

const stableKey = {
  type: "string",
  pattern: STABLE_KEY_PATTERN
} as const;

const identifier = {
  type: "string",
  pattern: IDENTIFIER_PATTERN
} as const;

const controlledId = {
  type: "string",
  pattern: CONTROLLED_ID_PATTERN
} as const;

const isoDateTime = {
  type: "string",
  pattern: ISO_DATETIME_PATTERN
} as const;

const noForumText = {
  type: "boolean",
  const: false
} as const;

export const observationEnvelopeV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.observationEnvelope,
  title: "ObservationEnvelopeV1",
  required: [
    "schemaVersion",
    "observationKey",
    "adapterId",
    "adapterVersion",
    "threadKey",
    "courseKey",
    "observedAt",
    "evidenceAsOf",
    "sourceObservedThrough",
    "timeBasis",
    "temporalEvidenceStatus",
    "contentRevisionStatus",
    "stateHash",
    "eventCount",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.observationEnvelope
    },
    observationKey: identifier,
    adapterId: identifier,
    adapterVersion: identifier,
    threadKey: identifier,
    courseKey: identifier,
    observedAt: isoDateTime,
    evidenceAsOf: isoDateTime,
    sourceObservedThrough: isoDateTime,
    timeBasis: {
      type: "string",
      enum: [
        "naive_platform_local_time_no_dst_adjustment",
        "utc",
        "platform_declared_timezone",
        "synthetic_virtual_clock"
      ]
    },
    temporalEvidenceStatus: {
      type: "string",
      enum: TEMPORAL_EVIDENCE_STATUSES
    },
    contentRevisionStatus: {
      type: "string",
      enum: CONTENT_REVISION_STATUSES
    },
    stateHash: hash,
    eventCount: {
      type: "integer",
      minimum: 0
    },
    containsForumText: noForumText
  }
} as const;

export const decisionEvidenceRefV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.decisionEvidenceRef,
  title: "DecisionEvidenceRefV1",
  required: [
    "schemaVersion",
    "snapshotKey",
    "threadKey",
    "courseKey",
    "authorKey",
    "year",
    "split",
    "decisionAt",
    "snapshotSchemaVersion",
    "temporalContractVersion",
    "temporalContractHash",
    "featureHash",
    "timeBasis",
    "temporalEvidenceStatus",
    "contentRevisionStatus",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.decisionEvidenceRef
    },
    snapshotKey: stableKey,
    threadKey: stableKey,
    courseKey: stableKey,
    authorKey: stableKey,
    year: {
      type: "integer",
      enum: [2024, 2025]
    },
    split: {
      type: "string",
      enum: ["development", "time_holdout"]
    },
    decisionAt: isoDateTime,
    snapshotSchemaVersion: {
      type: "string",
      const: "cmooc-decision-snapshot-v1"
    },
    temporalContractVersion: {
      type: "string",
      const: "cmooc-decision-snapshot-temporal-contract-v2"
    },
    temporalContractHash: hash,
    featureHash: hash,
    timeBasis: {
      type: "string",
      const: "naive_platform_local_time_no_dst_adjustment"
    },
    temporalEvidenceStatus: {
      type: "string",
      const: "as_of_verified"
    },
    contentRevisionStatus: {
      type: "string",
      const: "not_included"
    },
    containsForumText: noForumText
  }
} as const;

export const interventionIntentV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
  title: "InterventionIntentV1",
  required: [
    "schemaVersion",
    "evidenceRefHash",
    "evidenceAsOf",
    "intervene",
    "facilitationFunction",
    "targetObject",
    "workloadCost",
    "candidateExpiresAt",
    "withdrawalConditions",
    "policyVersion",
    "budgetVersion",
    "hashAlgorithm",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.interventionIntent
    },
    evidenceRefHash: hash,
    evidenceAsOf: isoDateTime,
    intervene: {
      type: "boolean"
    },
    facilitationFunction: {
      type: ["string", "null"],
      enum: [...FACILITATION_FUNCTIONS, null]
    },
    targetObject: {
      type: ["string", "null"],
      enum: [...TARGET_OBJECTS, null]
    },
    workloadCost: {
      type: "integer",
      minimum: 0,
      maximum: 100
    },
    candidateExpiresAt: isoDateTime,
    withdrawalConditions: {
      type: "array",
      items: {
        type: "string",
        enum: WITHDRAWAL_CONDITIONS
      },
      uniqueItems: true,
      minItems: 1
    },
    policyVersion: identifier,
    budgetVersion: identifier,
    hashAlgorithm: {
      type: "string",
      const: CANONICAL_HASH_ALGORITHM
    },
    containsForumText: noForumText
  },
  allOf: [
    {
      if: {
        properties: {
          intervene: { const: false }
        },
        required: ["intervene"]
      },
      then: {
        properties: {
          facilitationFunction: { const: null },
          targetObject: { const: null },
          workloadCost: { const: 0 }
        }
      },
      else: {
        properties: {
          facilitationFunction: {
            type: "string",
            enum: FACILITATION_FUNCTIONS
          },
          targetObject: {
            type: "string",
            enum: TARGET_OBJECTS
          },
          workloadCost: {
            type: "integer",
            minimum: 1,
            maximum: 100
          }
        }
      }
    }
  ]
} as const;

export const facilitationMoveSpecV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.facilitationMoveSpec,
  title: "FacilitationMoveSpecV1",
  required: [
    "schemaVersion",
    "intentHash",
    "needState",
    "mechanismTarget",
    "facilitationMove",
    "targetObject",
    "requiredContentElements",
    "prohibitedMoves",
    "observableSuccessCriteria",
    "specVersion",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.facilitationMoveSpec
    },
    intentHash: hash,
    needState: {
      type: "string",
      enum: NEED_STATES
    },
    mechanismTarget: {
      type: "string",
      enum: MECHANISM_TARGETS
    },
    facilitationMove: {
      type: "string",
      enum: FACILITATION_MOVES
    },
    targetObject: {
      type: "string",
      enum: TARGET_OBJECTS
    },
    requiredContentElements: {
      type: "array",
      items: controlledId,
      minItems: 1,
      uniqueItems: true
    },
    prohibitedMoves: {
      type: "array",
      items: {
        type: "string",
        enum: PROHIBITED_MOVES
      },
      minItems: 2,
      uniqueItems: true
    },
    observableSuccessCriteria: {
      type: "array",
      items: {
        type: "string",
        enum: OBSERVABLE_SUCCESS_CRITERIA
      },
      minItems: 1,
      uniqueItems: true
    },
    specVersion: identifier,
    containsForumText: noForumText
  }
} as const;

export const boundTargetV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.boundTarget,
  title: "BoundTargetV1",
  required: [
    "schemaVersion",
    "adapterId",
    "adapterVersion",
    "threadKey",
    "targetType",
    "targetObject",
    "stableTargetRef",
    "targetVersionHash",
    "contentRevisionStatus",
    "boundAt",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.boundTarget
    },
    adapterId: identifier,
    adapterVersion: identifier,
    threadKey: identifier,
    targetType: {
      type: "string",
      enum: ["thread", "comment"]
    },
    targetObject: {
      type: "string",
      enum: TARGET_OBJECTS
    },
    stableTargetRef: identifier,
    targetVersionHash: hash,
    contentRevisionStatus: {
      type: "string",
      enum: [
        "not_included",
        "decision_time_version_verified",
        "final_export_revision_unknown"
      ]
    },
    boundAt: isoDateTime,
    containsForumText: noForumText
  }
} as const;

export const reviewBundleV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.reviewBundle,
  title: "ReviewBundleV1",
  required: [
    "schemaVersion",
    "taskRefHash",
    "evidenceRefHash",
    "intentHash",
    "moveSpecHash",
    "draftContentHash",
    "targetHash",
    "safetyResultHash",
    "policyVersion",
    "assembledAt",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.reviewBundle
    },
    taskRefHash: hash,
    evidenceRefHash: hash,
    intentHash: hash,
    moveSpecHash: hash,
    draftContentHash: hash,
    targetHash: hash,
    safetyResultHash: hash,
    policyVersion: identifier,
    assembledAt: isoDateTime,
    containsForumText: noForumText
  }
} as const;

export const capabilityRequestV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.capabilityRequest,
  title: "CapabilityRequestV1",
  required: [
    "schemaVersion",
    "principalType",
    "principalRef",
    "capability",
    "objectRefHash",
    "correlationId",
    "requestedAt",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.capabilityRequest
    },
    principalType: {
      type: "string",
      enum: ["local_ui", "local_cli", "agent_client"]
    },
    principalRef: identifier,
    capability: {
      type: "string",
      enum: CAPABILITIES
    },
    objectRefHash: {
      type: ["string", "null"],
      pattern: HASH_PATTERN
    },
    correlationId: identifier,
    requestedAt: isoDateTime,
    containsForumText: noForumText
  }
} as const;

export const executionCommandV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.executionCommand,
  title: "ExecutionCommandV1",
  required: [
    "schemaVersion",
    "commandId",
    "correlationId",
    "capability",
    "taskRefHash",
    "reviewBundleHash",
    "authorizationRefHash",
    "idempotencyKey",
    "budgetReservationRefHash",
    "expectedTargetHash",
    "contentHash",
    "gatewayPolicyVersion",
    "issuedAt",
    "expiresAt",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.executionCommand
    },
    commandId: identifier,
    correlationId: identifier,
    capability: {
      type: "string",
      const: "forum.execute_authorized"
    },
    taskRefHash: hash,
    reviewBundleHash: hash,
    authorizationRefHash: hash,
    idempotencyKey: hash,
    budgetReservationRefHash: hash,
    expectedTargetHash: hash,
    contentHash: hash,
    gatewayPolicyVersion: identifier,
    issuedAt: isoDateTime,
    expiresAt: isoDateTime,
    containsForumText: noForumText
  }
} as const;

export const executionReceiptV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.executionReceipt,
  title: "ExecutionReceiptV1",
  required: [
    "schemaVersion",
    "commandId",
    "correlationId",
    "adapterId",
    "adapterVersion",
    "outcome",
    "attemptedAt",
    "recordedAt",
    "remoteObjectRefHash",
    "evidenceHash",
    "messageCode",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.executionReceipt
    },
    commandId: identifier,
    correlationId: identifier,
    adapterId: identifier,
    adapterVersion: identifier,
    outcome: {
      type: "string",
      enum: [
        "verified_published",
        "confirmed_not_attempted",
        "outcome_unknown",
        "confirmed_not_published"
      ]
    },
    attemptedAt: {
      anyOf: [isoDateTime, { type: "null" }]
    },
    recordedAt: isoDateTime,
    remoteObjectRefHash: {
      type: ["string", "null"],
      pattern: HASH_PATTERN
    },
    evidenceHash: hash,
    messageCode: controlledId,
    containsForumText: noForumText
  }
} as const;

export const interventionEventV1Schema = {
  ...strictObject,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROTOCOL_SCHEMA_VERSIONS.interventionEvent,
  title: "InterventionEventV1",
  required: [
    "schemaVersion",
    "eventId",
    "aggregateType",
    "aggregateRefHash",
    "eventType",
    "occurredAt",
    "recordedAt",
    "correlationId",
    "causationId",
    "evidenceStatus",
    "payloadHash",
    "containsForumText"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      const: PROTOCOL_SCHEMA_VERSIONS.interventionEvent
    },
    eventId: identifier,
    aggregateType: {
      type: "string",
      enum: [
        "observation",
        "intent",
        "review",
        "execution",
        "schedule",
        "budget"
      ]
    },
    aggregateRefHash: hash,
    eventType: {
      type: "string",
      enum: [
        "observation_recorded",
        "intent_created",
        "intent_withdrawn",
        "draft_created",
        "review_required",
        "review_approved",
        "execution_claimed",
        "execution_dispatched",
        "execution_reconciled",
        "budget_reserved",
        "budget_released",
        "schedule_invoked"
      ]
    },
    occurredAt: isoDateTime,
    recordedAt: isoDateTime,
    correlationId: identifier,
    causationId: {
      anyOf: [identifier, { type: "null" }]
    },
    evidenceStatus: {
      type: "string",
      enum: [
        "observed",
        "verified",
        "confirmed_not_attempted",
        "outcome_unknown",
        "reconciled"
      ]
    },
    payloadHash: hash,
    containsForumText: noForumText
  }
} as const;

export const PROTOCOL_SCHEMAS = {
  observationEnvelope: observationEnvelopeV1Schema,
  decisionEvidenceRef: decisionEvidenceRefV1Schema,
  interventionIntent: interventionIntentV1Schema,
  facilitationMoveSpec: facilitationMoveSpecV1Schema,
  boundTarget: boundTargetV1Schema,
  reviewBundle: reviewBundleV1Schema,
  capabilityRequest: capabilityRequestV1Schema,
  executionCommand: executionCommandV1Schema,
  executionReceipt: executionReceiptV1Schema,
  interventionEvent: interventionEventV1Schema
} as const;

export type ProtocolSchemaName = keyof typeof PROTOCOL_SCHEMAS;
