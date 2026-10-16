import {
  CANONICAL_HASH_ALGORITHM,
  FACILITATION_FUNCTIONS,
  FACILITATION_MOVES,
  MECHANISM_TARGETS,
  NEED_STATES,
  OBSERVABLE_SUCCESS_CRITERIA,
  PROHIBITED_MOVES,
  PROTOCOL_SCHEMA_VERSIONS,
  TARGET_OBJECTS,
  WITHDRAWAL_CONDITIONS,
  assertMoveSpecMatchesIntent,
  canonicalProtocolHash,
  parseProtocolObject,
  type CanonicalJsonValue,
  type FacilitationMoveSpecV1,
  type InterventionIntentV1
} from "@/lib/facilitation-protocol";
import {
  hashTransientDraftBody,
  normalizeTransientDraftBody
} from "@/lib/live-runtime/draft-content";
import { LIVE_FACILITATION_POLICY_VERSION } from "@/lib/live-runtime/facilitation-kernel";
import {
  SEMANTIC_RENDERER_VERSION,
  rebuildDeterministicSemanticDraft
} from "@/lib/autonomy/semantic-renderer";
import type {
  ProtectedArtifactStore,
  ProtectedDraftHandle
} from "@/lib/workbench/protected-artifact-store";
import {
  COURSE_TOOL_SCHEMA_VERSION,
  CourseToolOperationError,
  assertCourseToolJsonValue,
  assertEvidenceRefs,
  createJsonCourseToolOutputSchema,
  createJsonCourseToolSchema,
  hashCourseToolValue,
  isIsoInstant,
  isSafeIdentifier,
  isSha256,
  type CourseToolBusinessInput,
  type CourseToolJsonValue,
  type CourseToolRegistration,
  type EvidenceRef,
  type ServerToolExecutionContext
} from "../contracts";
import { defineCourseTool } from "../registry";
import type {
  CourseToolVerifierRegistration,
  CourseToolVerifierResult
} from "../verifier-registry";

export const FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION =
  "cmooc.course-tool.facilitation-artifacts.v1" as const;
export const FACILITATION_INTENT_OUTPUT_SCHEMA_VERSION =
  "cmooc.course-tool.facilitation-intent-output.v2" as const;
export const REPLY_DRAFT_OUTPUT_SCHEMA_VERSION =
  "cmooc.course-tool.reply-draft-output.v2" as const;
export const DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION =
  "cmooc.course-tool.delivery-bundle-output.v1" as const;
export const FACILITATION_ARTIFACT_LINT_VERSION =
  "cmooc.facilitation-artifact-lint.v2" as const;
export const FACILITATION_DRAFT_METADATA_SCHEMA_VERSION =
  "cmooc.facilitation-draft-metadata.v2" as const;
export const FACILITATION_DRAFT_REGENERATION_RECIPE_SCHEMA_VERSION =
  "cmooc.facilitation-draft-regeneration-recipe.v2" as const;
export const FACILITATION_DRAFT_REGENERATION_MATERIAL_SCHEMA_VERSION =
  "cmooc.facilitation-draft-regeneration-material.v2" as const;
export const FACILITATION_DRAFT_MATERIAL_BINDING_SCHEMA_VERSION =
  "cmooc.facilitation-draft-material-binding.v2" as const;

export const FACILITATION_DRAFT_CONTENT_HASH_DOMAIN =
  "facilitation-reply-draft-artifact.v2" as const;
export const FACILITATION_DRAFT_REGENERATION_MATERIAL_HASH_DOMAIN =
  "facilitation-draft-regeneration-material.v2" as const;
export const FACILITATION_DRAFT_REGENERATION_RECIPE_HASH_DOMAIN =
  "facilitation-draft-regeneration-recipe.v2" as const;
export const FACILITATION_DRAFT_MATERIAL_BINDING_HASH_DOMAIN =
  "facilitation-draft-material-binding.v2" as const;

const INTENT_VERIFIER = {
  name: "verification.facilitation_intent",
  version: "1"
} as const;
export const FACILITATION_DRAFT_VERIFIER_CONTRACT = {
  name: "verification.facilitation_reply_draft",
  version: "1"
} as const;
const DRAFT_VERIFIER = FACILITATION_DRAFT_VERIFIER_CONTRACT;
const DELIVERY_VERIFIER = {
  name: "verification.facilitation_delivery_bundle",
  version: "1"
} as const;

export type ArtifactVersionPointer = {
  readonly artifactId: string;
  readonly versionId: string;
  readonly artifactRef: string;
  readonly versionRef: string;
  readonly version: number;
  readonly contentHash: string;
};

/** JSON-shaped copy used in transient tool outputs; core EvidenceRef remains
 * the stronger execution-boundary type accepted by handlers and stores. */
type JsonEvidenceRef = {
  readonly [key: string]: CourseToolJsonValue;
  readonly kind: EvidenceRef["kind"];
  readonly id: string;
  readonly hash: string;
  readonly observedAt: string;
};

export type FacilitationArtifactVersionWrite = {
  readonly taskId: string;
  readonly runId: string;
  readonly createdByCallId: string | null;
  /** Logical artifact grouping, chosen only from trusted server material. */
  readonly artifactKey: string;
  /** Stable idempotency binding supplied by the executor. */
  readonly versionKey: string;
  readonly previousVersionRef: string | null;
  readonly artifactKind:
    | "facilitation_intent"
    | "facilitation_reply_draft"
    | "facilitation_delivery_bundle";
  readonly contentClass:
    | "safe_generated"
    | "restricted_transient"
    | "safe_aggregate";
  readonly contentHash: string;
  readonly draftBodyHash: string | null;
  readonly safeSummary: string;
  readonly metadata: CourseToolJsonValue;
  readonly sourceRefs: readonly EvidenceRef[];
  readonly regenerationRecipe: CourseToolJsonValue | null;
  readonly expiresAt: string | null;
};

export type CreateFacilitationArtifactVersion = (
  write: Readonly<FacilitationArtifactVersionWrite>
) => Promise<ArtifactVersionPointer>;

export type VerifiedIntentCompositionMaterial = {
  readonly selectionRef: string;
  /** Selection-domain binding over the exact anchor, policy and selected item. */
  readonly selectionEvidenceBindingHash: string;
  readonly integrityVerificationRef: string;
  readonly integrityStatus: "passed";
  readonly intentPolicyVersion: typeof LIVE_FACILITATION_POLICY_VERSION;
  readonly toolPolicyVersion: string;
  /** Qualified-evidence hash used by the persisted InterventionIntent. */
  readonly evidenceBindingHash: string;
  readonly intent: InterventionIntentV1;
  readonly moveSpec: FacilitationMoveSpecV1;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
};

export type RenderedFacilitationDraftMaterial = {
  readonly compositionRef: string;
  readonly logicalDraftKey: string;
  readonly intent: InterventionIntentV1;
  readonly intentHash: string;
  readonly moveSpec: FacilitationMoveSpecV1;
  readonly moveSpecHash: string;
  readonly integrityVerificationRef: string;
  readonly intentPolicyVersion: typeof LIVE_FACILITATION_POLICY_VERSION;
  readonly toolPolicyVersion: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly renderer: {
    readonly version: string;
    readonly receiptRef: string;
    readonly receiptHash: string;
    readonly inputContainsForumText: false;
    readonly inputContainsIdentity: false;
    readonly inputContainsSecrets: false;
  };
  readonly body: string;
  readonly resolvedPriorVersionRef: string | null;
  readonly resolvedFeedbackRef: string | null;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
};

export type DeliveryBundleResolvedInputs = {
  readonly draft: {
    readonly versionRef: string;
    readonly artifactRef: string;
    readonly artifactId: string;
    readonly versionId: string;
    readonly version: number;
    readonly contentClass: "restricted_transient";
    readonly contentHash: string;
    readonly draftBodyHash: string;
    readonly status: "validated";
    readonly evidenceRefs: readonly EvidenceRef[];
  };
  readonly integrity: {
    readonly ref: string;
    readonly status: "passed";
    readonly evidenceRefs: readonly EvidenceRef[];
  };
  readonly stageVerification: {
    readonly ref: string;
    readonly status: "passed";
    readonly subjectType: "stage_transaction";
    readonly artifactVersionRef: string;
    readonly draftBodyHash: string;
    readonly clearVerified: true;
    readonly editorEmptyAfter: true;
    readonly submitMutationCount: 0;
    readonly sendMutationCount: 0;
    readonly realPublishEnabled: false;
    readonly bodyPersisted: false;
    readonly observedAt: string;
    readonly receiptEvidenceRef: EvidenceRef;
  };
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
};

export interface FacilitationArtifactToolDependencies {
  readonly composeIntent: (input: {
    readonly selectionRef: string;
    readonly integrityVerificationRef: string;
    readonly context: Readonly<ServerToolExecutionContext>;
  }) => Promise<VerifiedIntentCompositionMaterial>;
  /** Adapter around the existing semantic renderer and safe composition store. */
  readonly renderDraft: (input: {
    readonly compositionRef: string;
    readonly revisionKind: "initial" | "correction";
    readonly priorVersionRef: string | null;
    readonly feedbackRef: string | null;
    readonly context: Readonly<ServerToolExecutionContext>;
  }) => Promise<RenderedFacilitationDraftMaterial>;
  readonly resolveDeliveryInputs: (input: {
    readonly draftVersionRef: string;
    readonly integrityVerificationRef: string;
    readonly stageVerificationRef: string;
    readonly context: Readonly<ServerToolExecutionContext>;
  }) => Promise<DeliveryBundleResolvedInputs>;
  readonly protectedStore: ProtectedArtifactStore;
  readonly createArtifactVersion: CreateFacilitationArtifactVersion;
  /**
   * Server-only recovery source. The recovery tool has an empty model input;
   * persisted artifact/checkpoint references never cross the model schema.
   */
  readonly resolveVerifiedDraftRecoveryMaterial?: (input: {
    readonly context: Readonly<ServerToolExecutionContext>;
  }) => Promise<ReplyDraftRecoverySourceV2>;
  readonly protectedDraftTtlMs?: number;
}

export type FacilitationIntentComposeInput = CourseToolBusinessInput & {
  readonly selectionRef: string;
  readonly integrityVerificationRef: string;
};

export type ReplyDraftCreateInput = CourseToolBusinessInput & {
  readonly compositionRef: string;
  readonly revisionKind: "initial" | "correction";
  readonly priorVersionRef?: string;
  readonly feedbackRef?: string;
};

/** The closed runtime schema accepts exactly `{}`. */
export type ReplyDraftRegenerateInput = CourseToolBusinessInput;

export type DeliveryBundleCreateInput = CourseToolBusinessInput & {
  readonly draftVersionRef: string;
  readonly integrityVerificationRef: string;
  readonly stageVerificationRef: string;
};

export type FacilitationIntentComposeOutput = {
  readonly schemaVersion: typeof FACILITATION_INTENT_OUTPUT_SCHEMA_VERSION;
  readonly status: "composed";
  readonly compositionRef: string;
  readonly intent: InterventionIntentV1;
  readonly intentHash: string;
  readonly moveSpec: FacilitationMoveSpecV1;
  readonly moveSpecHash: string;
  readonly intentPolicyVersion: typeof LIVE_FACILITATION_POLICY_VERSION;
  readonly toolPolicyVersion: string;
  readonly selectionEvidenceBindingHash: string;
  readonly evidenceBindingHash: string;
  readonly integrityVerificationRef: string;
  readonly receiptRef: string;
  readonly receiptHash: string;
  readonly artifact: ArtifactVersionPointer;
  readonly evidenceRefs: readonly JsonEvidenceRef[];
  readonly observedAt: string;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
};

type DraftLintCheck = {
  readonly code:
    | "body_present"
    | "length_within_limit"
    | "prompt_injection_absent"
    | "pii_absent"
    | "secrets_absent"
    | "unsupported_claim_absent"
    | "source_text_unavailable_to_renderer";
  readonly status: "passed";
};

export type ReplyDraftRevisionBindingV2 = {
  readonly revisionKind: "initial" | "correction";
  readonly priorVersionRef: string | null;
  readonly feedbackRef: string | null;
};

export type ReplyDraftContentMaterialV2 =
  ReplyDraftRevisionBindingV2 & {
    readonly schemaVersion: typeof FACILITATION_DRAFT_METADATA_SCHEMA_VERSION;
    readonly compositionRef: string;
    readonly intent: InterventionIntentV1;
    readonly intentHash: string;
    readonly moveSpec: FacilitationMoveSpecV1;
    readonly moveSpecHash: string;
    readonly draftBodyHash: string;
    readonly rendererVersion: string;
    readonly rendererReceiptRef: string;
    readonly rendererReceiptHash: string;
    readonly lintVersion: typeof FACILITATION_ARTIFACT_LINT_VERSION;
    readonly lintReceiptRef: string;
    readonly lintReceiptHash: string;
    readonly integrityVerificationRef: string;
    readonly intentPolicyVersion: typeof LIVE_FACILITATION_POLICY_VERSION;
    readonly toolPolicyVersion: string;
    readonly recovery: "regenerate_and_reverify";
    readonly bodyPersisted: false;
    readonly containsForumText: false;
    readonly containsIdentity: false;
    readonly containsSecrets: false;
  };

/**
 * Closed, body-free material required to reproduce and compare one draft.
 * draftBodyHash is a one-way digest; the draft body and protected handle are
 * deliberately outside this contract.
 */
export type ReplyDraftRegenerationMaterialV2 =
  ReplyDraftRevisionBindingV2 & {
    readonly schemaVersion: typeof FACILITATION_DRAFT_REGENERATION_MATERIAL_SCHEMA_VERSION;
    readonly compositionRef: string;
    readonly intentHash: string;
    readonly moveSpecHash: string;
    readonly draftBodyHash: string;
    readonly contentHash: string;
    readonly rendererVersion: string;
    readonly rendererReceiptHash: string;
    readonly lintReceiptHash: string;
    readonly integrityVerificationRef: string;
    readonly intentPolicyVersion: typeof LIVE_FACILITATION_POLICY_VERSION;
    readonly toolPolicyVersion: string;
  };

export type ReplyDraftRegenerationRecipeV2 =
  ReplyDraftRevisionBindingV2 & {
    readonly schemaVersion: typeof FACILITATION_DRAFT_REGENERATION_RECIPE_SCHEMA_VERSION;
    readonly strategy: "reinvoke_semantic_renderer";
    readonly compositionRef: string;
    readonly intentHash: string;
    readonly moveSpecHash: string;
    readonly draftBodyHash: string;
    readonly contentHash: string;
    readonly rendererVersion: string;
    readonly rendererReceiptHash: string;
    readonly lintReceiptHash: string;
    readonly integrityVerificationRef: string;
    readonly intentPolicyVersion: typeof LIVE_FACILITATION_POLICY_VERSION;
    readonly toolPolicyVersion: string;
    readonly expiresAt: string;
    readonly regenerationMaterialHash: string;
    readonly requireReverification: true;
    readonly recovery: "regenerate_and_reverify";
    readonly bodyPersisted: false;
    readonly containsForumText: false;
    readonly containsIdentity: false;
    readonly containsSecrets: false;
  };

export type ReplyDraftMaterialBindingV2 = {
  readonly schemaVersion: typeof FACILITATION_DRAFT_MATERIAL_BINDING_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly draftBodyHash: string;
  readonly regenerationMaterialHash: string;
  readonly regenerationRecipeHash: string;
  readonly verifier: {
    readonly name: typeof FACILITATION_DRAFT_VERIFIER_CONTRACT.name;
    readonly version: typeof FACILITATION_DRAFT_VERIFIER_CONTRACT.version;
  };
  readonly expiresAt: string;
  readonly requireReverification: true;
  readonly recovery: "regenerate_and_reverify";
  readonly bodyPersisted: false;
};

export type ReplyDraftPersistedMetadataV2 =
  ReplyDraftRevisionBindingV2 & {
    readonly schemaVersion: typeof FACILITATION_DRAFT_METADATA_SCHEMA_VERSION;
    readonly compositionRef: string;
    readonly intent: InterventionIntentV1;
    readonly intentHash: string;
    readonly moveSpec: FacilitationMoveSpecV1;
    readonly moveSpecHash: string;
    readonly draftBodyHash: string;
    readonly contentHash: string;
    readonly rendererVersion: string;
    readonly rendererReceiptRef: string;
    readonly rendererReceiptHash: string;
    readonly lintVersion: typeof FACILITATION_ARTIFACT_LINT_VERSION;
    readonly lintReceiptRef: string;
    readonly lintReceiptHash: string;
    readonly integrityVerificationRef: string;
    readonly intentPolicyVersion: typeof LIVE_FACILITATION_POLICY_VERSION;
    readonly toolPolicyVersion: string;
    readonly expiresAt: string;
    readonly regenerationMaterialHash: string;
    readonly regenerationRecipeHash: string;
    readonly materialBindingHash: string;
    readonly recovery: "regenerate_and_reverify";
    readonly bodyPersisted: false;
    readonly containsForumText: false;
    readonly containsIdentity: false;
    readonly containsSecrets: false;
  };

export type VerifiedReplyDraftPersistenceBindingV2 =
  ReplyDraftRevisionBindingV2 & {
    readonly schemaVersion: typeof FACILITATION_DRAFT_METADATA_SCHEMA_VERSION;
    readonly compositionRef: string;
    readonly intentHash: string;
    readonly moveSpecHash: string;
    readonly draftBodyHash: string;
    readonly contentHash: string;
    readonly rendererVersion: string;
    readonly rendererReceiptHash: string;
    readonly lintReceiptHash: string;
    readonly integrityVerificationRef: string;
    readonly intentPolicyVersion: typeof LIVE_FACILITATION_POLICY_VERSION;
    readonly toolPolicyVersion: string;
    readonly regenerationRecipeHash: string;
    readonly regenerationMaterialHash: string;
    readonly materialBindingHash: string;
    readonly expiresAt: string;
  };

/**
 * Fully checked, body-free material used by the deterministic recovery path.
 * The older public binding parser is a deliberately narrower projection of
 * this contract.
 */
export type VerifiedReplyDraftRecoveryMaterialV2 =
  VerifiedReplyDraftPersistenceBindingV2 & {
    readonly intent: InterventionIntentV1;
    readonly moveSpec: FacilitationMoveSpecV1;
    readonly rendererReceiptRef: string;
    readonly lintReceiptRef: string;
    readonly regenerationRecipe: ReplyDraftRegenerationRecipeV2;
  };

/**
 * Trusted, server-injected recovery source. It intentionally has no protected
 * handle or draft body. `metadata` and `regenerationRecipe` are parsed again at
 * the tool boundary even when the loader already verified them.
 */
export type ReplyDraftRecoverySourceV2 = Readonly<{
  metadata: CourseToolJsonValue;
  regenerationRecipe: CourseToolJsonValue;
  artifact: ArtifactVersionPointer & {
    readonly contentClass: "restricted_transient";
    readonly draftBodyHash: string;
    readonly expiresAt: string;
    readonly observedAt: string;
    readonly bodyPersisted: false;
  };
  composition: Readonly<{
    versionRef: string;
    intentHash: string;
    moveSpecHash: string;
    toolPolicyVersion: string;
  }>;
  logicalDraftKey: string;
  evidenceRefs: readonly EvidenceRef[];
  sourceVerification: Readonly<{
    subjectVersionRef: string;
    verifier: typeof FACILITATION_DRAFT_VERIFIER_CONTRACT;
    status: "passed";
    evidenceRef: EvidenceRef;
  }>;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

export type ReplyDraftCreateOutput = {
  readonly schemaVersion: typeof REPLY_DRAFT_OUTPUT_SCHEMA_VERSION;
  readonly status: "created";
  readonly compositionRef: string;
  readonly intentHash: string;
  readonly moveSpecHash: string;
  readonly intentPolicyVersion: typeof LIVE_FACILITATION_POLICY_VERSION;
  readonly toolPolicyVersion: string;
  readonly rendererReceiptRef: string;
  readonly rendererReceiptHash: string;
  readonly rendererVersion: string;
  readonly lint: {
    readonly version: typeof FACILITATION_ARTIFACT_LINT_VERSION;
    readonly receiptRef: string;
    readonly receiptHash: string;
    readonly status: "passed";
    readonly checks: readonly DraftLintCheck[];
  };
  readonly revisionKind: "initial" | "correction";
  readonly priorVersionRef: string | null;
  readonly feedbackRef: string | null;
  readonly regenerationRecipe: ReplyDraftRegenerationRecipeV2;
  readonly regenerationRecipeHash: string;
  readonly regenerationMaterialHash: string;
  readonly materialBindingHash: string;
  readonly artifact: ArtifactVersionPointer & {
    readonly contentClass: "restricted_transient";
    readonly draftBodyHash: string;
    /** In-process only. The trusted projector deliberately omits it. */
    readonly protectedRef: string;
    readonly expiresAt: string;
    readonly bodyPersisted: false;
    readonly recovery: "regenerate_and_reverify";
  };
  readonly integrityVerificationRef: string;
  readonly evidenceRefs: readonly JsonEvidenceRef[];
  readonly observedAt: string;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
};

export type DeliveryBundleCreateOutput = {
  readonly schemaVersion: typeof DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION;
  readonly status: "ready";
  readonly bundle: ArtifactVersionPointer;
  readonly draftVersionRef: string;
  readonly integrityVerificationRef: string;
  readonly stageVerificationRef: string;
  readonly stage: {
    readonly clearVerified: true;
    readonly editorEmptyAfter: true;
    readonly submitMutationCount: 0;
    readonly sendMutationCount: 0;
    readonly realPublishEnabled: false;
    readonly bodyPersisted: false;
    readonly published: false;
  };
  readonly limitationCodes: readonly [
    "stage_only_not_published",
    "not_intervention_or_effect_evidence"
  ];
  readonly evidenceRefs: readonly JsonEvidenceRef[];
  readonly observedAt: string;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
};

export type FacilitationArtifactToolRegistration =
  | CourseToolRegistration<
      FacilitationIntentComposeInput,
      FacilitationIntentComposeOutput
    >
  | CourseToolRegistration<ReplyDraftCreateInput, ReplyDraftCreateOutput>
  | CourseToolRegistration<ReplyDraftRegenerateInput, ReplyDraftCreateOutput>
  | CourseToolRegistration<
      DeliveryBundleCreateInput,
      DeliveryBundleCreateOutput
    >;

const SAFE_REF_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$";
const HASH_PATTERN = "^[a-f0-9]{64}$";
const ISO_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const VERSION_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$";

const strictObject = {
  type: "object",
  additionalProperties: false
} as const;

const evidenceRefSchema = {
  ...strictObject,
  required: ["kind", "id", "hash", "observedAt"],
  properties: {
    kind: {
      type: "string",
      enum: [
        "manifest",
        "invocation",
        "snapshot",
        "world",
        "coverage",
        "content_graph",
        "candidate",
        "decision",
        "outcome",
        "artifact",
        "stage_receipt",
        "verification"
      ]
    },
    id: { type: "string", pattern: SAFE_REF_PATTERN },
    hash: { type: "string", pattern: HASH_PATTERN },
    observedAt: { type: "string", pattern: ISO_PATTERN }
  }
} as const;

const artifactPointerSchema = {
  ...strictObject,
  required: [
    "artifactId",
    "versionId",
    "artifactRef",
    "versionRef",
    "version",
    "contentHash"
  ],
  properties: {
    artifactId: { type: "string", pattern: SAFE_REF_PATTERN },
    versionId: { type: "string", pattern: SAFE_REF_PATTERN },
    artifactRef: { type: "string", pattern: SAFE_REF_PATTERN },
    versionRef: { type: "string", pattern: SAFE_REF_PATTERN },
    version: { type: "integer", minimum: 1 },
    contentHash: { type: "string", pattern: HASH_PATTERN }
  }
} as const;

const intentSchema = {
  ...strictObject,
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
    evidenceRefHash: { type: "string", pattern: HASH_PATTERN },
    evidenceAsOf: { type: "string", pattern: ISO_PATTERN },
    intervene: { const: true },
    facilitationFunction: { type: "string", enum: FACILITATION_FUNCTIONS },
    targetObject: { type: "string", enum: TARGET_OBJECTS },
    workloadCost: { type: "integer", minimum: 1, maximum: 100 },
    candidateExpiresAt: { type: "string", pattern: ISO_PATTERN },
    withdrawalConditions: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: WITHDRAWAL_CONDITIONS }
    },
    policyVersion: { type: "string", pattern: VERSION_PATTERN },
    budgetVersion: { type: "string", pattern: VERSION_PATTERN },
    hashAlgorithm: { type: "string", const: CANONICAL_HASH_ALGORITHM },
    containsForumText: { const: false }
  }
} as const;

const moveSpecSchema = {
  ...strictObject,
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
    intentHash: { type: "string", pattern: HASH_PATTERN },
    needState: { type: "string", enum: NEED_STATES },
    mechanismTarget: { type: "string", enum: MECHANISM_TARGETS },
    facilitationMove: { type: "string", enum: FACILITATION_MOVES },
    targetObject: { type: "string", enum: TARGET_OBJECTS },
    requiredContentElements: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: VERSION_PATTERN }
    },
    prohibitedMoves: {
      type: "array",
      minItems: 2,
      uniqueItems: true,
      items: { type: "string", enum: PROHIBITED_MOVES }
    },
    observableSuccessCriteria: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: OBSERVABLE_SUCCESS_CRITERIA }
    },
    specVersion: { type: "string", pattern: VERSION_PATTERN },
    containsForumText: { const: false }
  }
} as const;

const nullableSafeRefSchema = {
  anyOf: [
    { type: "string", pattern: SAFE_REF_PATTERN },
    { type: "null" }
  ]
} as const;

const draftRegenerationRecipeSchema = {
  ...strictObject,
  required: [
    "schemaVersion",
    "strategy",
    "compositionRef",
    "intentHash",
    "moveSpecHash",
    "draftBodyHash",
    "contentHash",
    "rendererVersion",
    "rendererReceiptHash",
    "lintReceiptHash",
    "integrityVerificationRef",
    "intentPolicyVersion",
    "toolPolicyVersion",
    "revisionKind",
    "priorVersionRef",
    "feedbackRef",
    "expiresAt",
    "regenerationMaterialHash",
    "requireReverification",
    "recovery",
    "bodyPersisted",
    "containsForumText",
    "containsIdentity",
    "containsSecrets"
  ],
  properties: {
    schemaVersion: {
      const: FACILITATION_DRAFT_REGENERATION_RECIPE_SCHEMA_VERSION
    },
    strategy: { const: "reinvoke_semantic_renderer" },
    compositionRef: { type: "string", pattern: SAFE_REF_PATTERN },
    intentHash: { type: "string", pattern: HASH_PATTERN },
    moveSpecHash: { type: "string", pattern: HASH_PATTERN },
    draftBodyHash: { type: "string", pattern: HASH_PATTERN },
    contentHash: { type: "string", pattern: HASH_PATTERN },
    rendererVersion: { type: "string", pattern: VERSION_PATTERN },
    rendererReceiptHash: { type: "string", pattern: HASH_PATTERN },
    lintReceiptHash: { type: "string", pattern: HASH_PATTERN },
    integrityVerificationRef: {
      type: "string",
      pattern: SAFE_REF_PATTERN
    },
    intentPolicyVersion: { const: LIVE_FACILITATION_POLICY_VERSION },
    toolPolicyVersion: { type: "string", pattern: VERSION_PATTERN },
    revisionKind: { type: "string", enum: ["initial", "correction"] },
    priorVersionRef: nullableSafeRefSchema,
    feedbackRef: nullableSafeRefSchema,
    expiresAt: { type: "string", pattern: ISO_PATTERN },
    regenerationMaterialHash: { type: "string", pattern: HASH_PATTERN },
    requireReverification: { const: true },
    recovery: { const: "regenerate_and_reverify" },
    bodyPersisted: { const: false },
    containsForumText: { const: false },
    containsIdentity: { const: false },
    containsSecrets: { const: false }
  }
} as const;

function inputSchemas() {
  return {
    intent: createJsonCourseToolSchema<FacilitationIntentComposeInput>({
      schemaVersion: "cmooc.course-tool.facilitation-intent-input.v1",
      modelJsonSchema: {
        ...strictObject,
        required: ["selectionRef", "integrityVerificationRef"],
        properties: {
          selectionRef: { type: "string", pattern: SAFE_REF_PATTERN },
          integrityVerificationRef: {
            type: "string",
            pattern: SAFE_REF_PATTERN
          }
        }
      }
    }),
    draft: createJsonCourseToolSchema<ReplyDraftCreateInput>({
      schemaVersion: "cmooc.course-tool.reply-draft-input.v1",
      modelJsonSchema: {
        ...strictObject,
        required: ["compositionRef", "revisionKind"],
        properties: {
          compositionRef: { type: "string", pattern: SAFE_REF_PATTERN },
          revisionKind: {
            type: "string",
            enum: ["initial", "correction"]
          },
          priorVersionRef: { type: "string", pattern: SAFE_REF_PATTERN },
          feedbackRef: { type: "string", pattern: SAFE_REF_PATTERN }
        }
      }
    }),
    regenerateDraft: createJsonCourseToolSchema<ReplyDraftRegenerateInput>({
      schemaVersion: "cmooc.course-tool.reply-draft-regenerate-input.v1",
      modelJsonSchema: {
        ...strictObject,
        required: [],
        properties: {}
      }
    }),
    delivery: createJsonCourseToolSchema<DeliveryBundleCreateInput>({
      schemaVersion: "cmooc.course-tool.delivery-bundle-input.v1",
      modelJsonSchema: {
        ...strictObject,
        required: [
          "draftVersionRef",
          "integrityVerificationRef",
          "stageVerificationRef"
        ],
        properties: {
          draftVersionRef: { type: "string", pattern: SAFE_REF_PATTERN },
          integrityVerificationRef: {
            type: "string",
            pattern: SAFE_REF_PATTERN
          },
          stageVerificationRef: {
            type: "string",
            pattern: SAFE_REF_PATTERN
          }
        }
      }
    })
  };
}

function outputSchemas() {
  const commonFlags = {
    containsForumText: { const: false },
    containsIdentity: { const: false },
    containsSecrets: { const: false }
  } as const;
  return {
    intent: createJsonCourseToolOutputSchema<FacilitationIntentComposeOutput>({
      schemaVersion: FACILITATION_INTENT_OUTPUT_SCHEMA_VERSION,
      jsonSchema: {
        ...strictObject,
        required: [
          "schemaVersion",
          "status",
          "compositionRef",
          "intent",
          "intentHash",
          "moveSpec",
          "moveSpecHash",
          "intentPolicyVersion",
          "toolPolicyVersion",
          "selectionEvidenceBindingHash",
          "evidenceBindingHash",
          "integrityVerificationRef",
          "receiptRef",
          "receiptHash",
          "artifact",
          "evidenceRefs",
          "observedAt",
          "containsForumText",
          "containsIdentity",
          "containsSecrets"
        ],
        properties: {
          schemaVersion: {
            const: FACILITATION_INTENT_OUTPUT_SCHEMA_VERSION
          },
          status: { const: "composed" },
          compositionRef: { type: "string", pattern: SAFE_REF_PATTERN },
          intent: intentSchema,
          intentHash: { type: "string", pattern: HASH_PATTERN },
          moveSpec: moveSpecSchema,
          moveSpecHash: { type: "string", pattern: HASH_PATTERN },
          intentPolicyVersion: {
            const: LIVE_FACILITATION_POLICY_VERSION
          },
          toolPolicyVersion: { type: "string", pattern: VERSION_PATTERN },
          selectionEvidenceBindingHash: {
            type: "string",
            pattern: HASH_PATTERN
          },
          evidenceBindingHash: { type: "string", pattern: HASH_PATTERN },
          integrityVerificationRef: {
            type: "string",
            pattern: SAFE_REF_PATTERN
          },
          receiptRef: { type: "string", pattern: SAFE_REF_PATTERN },
          receiptHash: { type: "string", pattern: HASH_PATTERN },
          artifact: artifactPointerSchema,
          evidenceRefs: {
            type: "array",
            minItems: 7,
            maxItems: 64,
            items: evidenceRefSchema
          },
          observedAt: { type: "string", pattern: ISO_PATTERN },
          ...commonFlags
        }
      }
    }),
    draft: createJsonCourseToolOutputSchema<ReplyDraftCreateOutput>({
      schemaVersion: REPLY_DRAFT_OUTPUT_SCHEMA_VERSION,
      jsonSchema: {
        ...strictObject,
        required: [
          "schemaVersion",
          "status",
          "compositionRef",
          "intentHash",
          "moveSpecHash",
          "intentPolicyVersion",
          "toolPolicyVersion",
          "rendererReceiptRef",
          "rendererReceiptHash",
          "rendererVersion",
          "lint",
          "revisionKind",
          "priorVersionRef",
          "feedbackRef",
          "regenerationRecipe",
          "regenerationRecipeHash",
          "regenerationMaterialHash",
          "materialBindingHash",
          "artifact",
          "integrityVerificationRef",
          "evidenceRefs",
          "observedAt",
          "containsForumText",
          "containsIdentity",
          "containsSecrets"
        ],
        properties: {
          schemaVersion: { const: REPLY_DRAFT_OUTPUT_SCHEMA_VERSION },
          status: { const: "created" },
          compositionRef: { type: "string", pattern: SAFE_REF_PATTERN },
          intentHash: { type: "string", pattern: HASH_PATTERN },
          moveSpecHash: { type: "string", pattern: HASH_PATTERN },
          intentPolicyVersion: {
            const: LIVE_FACILITATION_POLICY_VERSION
          },
          toolPolicyVersion: { type: "string", pattern: VERSION_PATTERN },
          rendererReceiptRef: { type: "string", pattern: SAFE_REF_PATTERN },
          rendererReceiptHash: { type: "string", pattern: HASH_PATTERN },
          rendererVersion: { type: "string", pattern: VERSION_PATTERN },
          lint: {
            ...strictObject,
            required: [
              "version",
              "receiptRef",
              "receiptHash",
              "status",
              "checks"
            ],
            properties: {
              version: { const: FACILITATION_ARTIFACT_LINT_VERSION },
              receiptRef: { type: "string", pattern: SAFE_REF_PATTERN },
              receiptHash: { type: "string", pattern: HASH_PATTERN },
              status: { const: "passed" },
              checks: {
                type: "array",
                minItems: 7,
                maxItems: 7,
                items: {
                  ...strictObject,
                  required: ["code", "status"],
                  properties: {
                    code: {
                      type: "string",
                      enum: [
                        "body_present",
                        "length_within_limit",
                        "prompt_injection_absent",
                        "pii_absent",
                        "secrets_absent",
                        "unsupported_claim_absent",
                        "source_text_unavailable_to_renderer"
                      ]
                    },
                    status: { const: "passed" }
                  }
                }
              }
            }
          },
          revisionKind: {
            type: "string",
            enum: ["initial", "correction"]
          },
          priorVersionRef: nullableSafeRefSchema,
          feedbackRef: nullableSafeRefSchema,
          regenerationRecipe: draftRegenerationRecipeSchema,
          regenerationRecipeHash: { type: "string", pattern: HASH_PATTERN },
          regenerationMaterialHash: {
            type: "string",
            pattern: HASH_PATTERN
          },
          materialBindingHash: { type: "string", pattern: HASH_PATTERN },
          artifact: {
            ...strictObject,
            required: [
              "artifactId",
              "versionId",
              "artifactRef",
              "versionRef",
              "version",
              "contentHash",
              "contentClass",
              "draftBodyHash",
              "protectedRef",
              "expiresAt",
              "bodyPersisted",
              "recovery"
            ],
            properties: {
              ...artifactPointerSchema.properties,
              contentClass: { const: "restricted_transient" },
              draftBodyHash: { type: "string", pattern: HASH_PATTERN },
              protectedRef: {
                type: "string",
                pattern: "^protected-draft:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$"
              },
              expiresAt: { type: "string", pattern: ISO_PATTERN },
              bodyPersisted: { const: false },
              recovery: { const: "regenerate_and_reverify" }
            }
          },
          integrityVerificationRef: {
            type: "string",
            pattern: SAFE_REF_PATTERN
          },
          evidenceRefs: {
            type: "array",
            minItems: 7,
            maxItems: 64,
            items: evidenceRefSchema
          },
          observedAt: { type: "string", pattern: ISO_PATTERN },
          ...commonFlags
        }
      }
    }),
    delivery: createJsonCourseToolOutputSchema<DeliveryBundleCreateOutput>({
      schemaVersion: DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION,
      jsonSchema: {
        ...strictObject,
        required: [
          "schemaVersion",
          "status",
          "bundle",
          "draftVersionRef",
          "integrityVerificationRef",
          "stageVerificationRef",
          "stage",
          "limitationCodes",
          "evidenceRefs",
          "observedAt",
          "containsForumText",
          "containsIdentity",
          "containsSecrets"
        ],
        properties: {
          schemaVersion: { const: DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION },
          status: { const: "ready" },
          bundle: artifactPointerSchema,
          draftVersionRef: { type: "string", pattern: SAFE_REF_PATTERN },
          integrityVerificationRef: {
            type: "string",
            pattern: SAFE_REF_PATTERN
          },
          stageVerificationRef: {
            type: "string",
            pattern: SAFE_REF_PATTERN
          },
          stage: {
            ...strictObject,
            required: [
              "clearVerified",
              "editorEmptyAfter",
              "submitMutationCount",
              "sendMutationCount",
              "realPublishEnabled",
              "bodyPersisted",
              "published"
            ],
            properties: {
              clearVerified: { const: true },
              editorEmptyAfter: { const: true },
              submitMutationCount: { const: 0 },
              sendMutationCount: { const: 0 },
              realPublishEnabled: { const: false },
              bodyPersisted: { const: false },
              published: { const: false }
            }
          },
          limitationCodes: {
            type: "array",
            prefixItems: [
              { const: "stage_only_not_published" },
              { const: "not_intervention_or_effect_evidence" }
            ],
            minItems: 2,
            maxItems: 2
          },
          evidenceRefs: {
            type: "array",
            minItems: 8,
            maxItems: 96,
            items: evidenceRefSchema
          },
          observedAt: { type: "string", pattern: ISO_PATTERN },
          ...commonFlags
        }
      }
    })
  };
}

const REQUIRED_EVIDENCE_KINDS = [
  "manifest",
  "invocation",
  "snapshot",
  "world",
  "coverage",
  "candidate",
  "verification"
] as const;

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

async function safely<T>(
  safeCode: string,
  safeSummary: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CourseToolOperationError) throw error;
    return fail(safeCode, safeSummary);
  }
}

function protocolHashes(input: {
  intent: InterventionIntentV1;
  moveSpec: FacilitationMoveSpecV1;
}): { intentHash: string; moveSpecHash: string } {
  const { intent, moveSpec } = assertMoveSpecMatchesIntent(
    input.intent,
    input.moveSpec
  );
  return {
    intentHash: canonicalProtocolHash(
      intent.schemaVersion,
      intent as CanonicalJsonValue
    ),
    moveSpecHash: canonicalProtocolHash(
      moveSpec.schemaVersion,
      moveSpec as CanonicalJsonValue
    )
  };
}

function hashClosedDraftMaterial(domain: string, value: unknown): string {
  assertCourseToolJsonValue(value, domain);
  return hashCourseToolValue(domain, value);
}

export function hashReplyDraftContentMaterialV2(
  material: Readonly<ReplyDraftContentMaterialV2>
): string {
  return hashClosedDraftMaterial(
    FACILITATION_DRAFT_CONTENT_HASH_DOMAIN,
    material
  );
}

export function hashReplyDraftRegenerationMaterialV2(
  material: Readonly<ReplyDraftRegenerationMaterialV2>
): string {
  return hashClosedDraftMaterial(
    FACILITATION_DRAFT_REGENERATION_MATERIAL_HASH_DOMAIN,
    material
  );
}

export function hashReplyDraftRegenerationRecipeV2(
  recipe: Readonly<ReplyDraftRegenerationRecipeV2>
): string {
  return hashClosedDraftMaterial(
    FACILITATION_DRAFT_REGENERATION_RECIPE_HASH_DOMAIN,
    recipe
  );
}

export function hashReplyDraftMaterialBindingV2(
  binding: Readonly<ReplyDraftMaterialBindingV2>
): string {
  return hashClosedDraftMaterial(
    FACILITATION_DRAFT_MATERIAL_BINDING_HASH_DOMAIN,
    binding
  );
}

function assertPrivacyFlags(value: {
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
}): void {
  if (
    value.containsForumText !== false ||
    value.containsIdentity !== false ||
    value.containsSecrets !== false
  ) {
    fail(
      "FACILITATION_ARTIFACT_RESTRICTED_DATA",
      "Facilitation artifact input crossed a restricted-data boundary."
    );
  }
}

function dedupeEvidenceRefs(
  refs: readonly EvidenceRef[]
): readonly EvidenceRef[] {
  const byKey = new Map<string, EvidenceRef>();
  for (const ref of refs) {
    byKey.set(`${ref.kind}\0${ref.id}\0${ref.hash}`, ref);
  }
  return Object.freeze(
    [...byKey.values()].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id) ||
        left.hash.localeCompare(right.hash)
    )
  );
}

function assertVerifiedEvidence(input: {
  refs: readonly EvidenceRef[];
  integrityVerificationRef: string;
  now: string;
  requireStageReceipt?: boolean;
}): readonly EvidenceRef[] {
  const refs = dedupeEvidenceRefs(input.refs);
  try {
    assertEvidenceRefs(refs);
  } catch {
    fail(
      "FACILITATION_EVIDENCE_INVALID",
      "Facilitation evidence references failed their safe structural contract."
    );
  }
  if (refs.length < (input.requireStageReceipt ? 8 : 7)) {
    fail(
      "FACILITATION_EVIDENCE_INCOMPLETE",
      "Facilitation evidence is missing a required verified anchor.",
      refs
    );
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) {
    fail(
      "FACILITATION_ARTIFACT_TIME_INVALID",
      "Server execution time is invalid."
    );
  }
  for (const ref of refs) {
    if (Date.parse(ref.observedAt) > now) {
      fail(
        "FACILITATION_EVIDENCE_FROM_FUTURE",
        "Facilitation evidence is later than the server execution time.",
        refs
      );
    }
  }
  const presentKinds = new Set(refs.map((ref) => ref.kind));
  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    if (!presentKinds.has(kind)) {
      fail(
        "FACILITATION_EVIDENCE_INCOMPLETE",
        "Facilitation evidence is missing a required verified anchor.",
        refs
      );
    }
  }
  if (
    !refs.some(
      (ref) =>
        ref.kind === "verification" &&
        ref.id === input.integrityVerificationRef
    )
  ) {
    fail(
      "FACILITATION_INTEGRITY_REF_UNBOUND",
      "Integrity verification is not bound to the evidence set.",
      refs
    );
  }
  if (
    input.requireStageReceipt &&
    !refs.some((ref) => ref.kind === "stage_receipt")
  ) {
    fail(
      "FACILITATION_STAGE_RECEIPT_MISSING",
      "Delivery requires a trusted stage receipt reference.",
      refs
    );
  }
  return refs;
}

function assertArtifactPointer(
  pointer: ArtifactVersionPointer,
  expectedContentHash: string
): void {
  if (
    !pointer ||
    !isSafeIdentifier(pointer.artifactId) ||
    !isSafeIdentifier(pointer.versionId) ||
    !isSafeIdentifier(pointer.artifactRef) ||
    !isSafeIdentifier(pointer.versionRef) ||
    !Number.isSafeInteger(pointer.version) ||
    pointer.version < 1 ||
    pointer.contentHash !== expectedContentHash
  ) {
    fail(
      "FACILITATION_ARTIFACT_VERSION_INVALID",
      "Artifact store did not return the expected immutable version binding."
    );
  }
}

function artifactKey(
  kind: FacilitationArtifactVersionWrite["artifactKind"],
  context: Readonly<ServerToolExecutionContext>,
  logicalKey: string
): string {
  return `${kind}:${hashCourseToolValue("facilitation-artifact-key.v1", {
    taskId: context.taskId,
    logicalKey
  })}`;
}

function assertRevisionInput(input: ReplyDraftCreateInput): {
  priorVersionRef: string | null;
  feedbackRef: string | null;
} {
  const priorVersionRef = input.priorVersionRef ?? null;
  const feedbackRef = input.feedbackRef ?? null;
  if (
    (input.revisionKind === "initial" &&
      (priorVersionRef !== null || feedbackRef !== null)) ||
    (input.revisionKind === "correction" &&
      (priorVersionRef === null || feedbackRef === null))
  ) {
    fail(
      "FACILITATION_DRAFT_REVISION_INVALID",
      "Draft revision references do not match the requested revision kind."
    );
  }
  return { priorVersionRef, feedbackRef };
}

type UnknownRecord = Record<string, unknown>;

const DRAFT_LINT_CHECK_CODES = [
  "body_present",
  "length_within_limit",
  "prompt_injection_absent",
  "pii_absent",
  "secrets_absent",
  "unsupported_claim_absent",
  "source_text_unavailable_to_renderer"
] as const;

const DRAFT_METADATA_V2_KEYS = [
  "schemaVersion",
  "compositionRef",
  "intent",
  "intentHash",
  "moveSpec",
  "moveSpecHash",
  "draftBodyHash",
  "contentHash",
  "rendererVersion",
  "rendererReceiptRef",
  "rendererReceiptHash",
  "lintVersion",
  "lintReceiptRef",
  "lintReceiptHash",
  "integrityVerificationRef",
  "intentPolicyVersion",
  "toolPolicyVersion",
  "revisionKind",
  "priorVersionRef",
  "feedbackRef",
  "expiresAt",
  "regenerationMaterialHash",
  "regenerationRecipeHash",
  "materialBindingHash",
  "recovery",
  "bodyPersisted",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const;

const DRAFT_RECIPE_V2_KEYS = [
  "schemaVersion",
  "strategy",
  "compositionRef",
  "intentHash",
  "moveSpecHash",
  "draftBodyHash",
  "contentHash",
  "rendererVersion",
  "rendererReceiptHash",
  "lintReceiptHash",
  "integrityVerificationRef",
  "intentPolicyVersion",
  "toolPolicyVersion",
  "revisionKind",
  "priorVersionRef",
  "feedbackRef",
  "expiresAt",
  "regenerationMaterialHash",
  "requireReverification",
  "recovery",
  "bodyPersisted",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const;

const DRAFT_OUTPUT_V2_KEYS = [
  "schemaVersion",
  "status",
  "compositionRef",
  "intentHash",
  "moveSpecHash",
  "intentPolicyVersion",
  "toolPolicyVersion",
  "rendererReceiptRef",
  "rendererReceiptHash",
  "rendererVersion",
  "lint",
  "revisionKind",
  "priorVersionRef",
  "feedbackRef",
  "regenerationRecipe",
  "regenerationRecipeHash",
  "regenerationMaterialHash",
  "materialBindingHash",
  "artifact",
  "integrityVerificationRef",
  "evidenceRefs",
  "observedAt",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const;

const DRAFT_OUTPUT_ARTIFACT_KEYS = [
  "artifactId",
  "versionId",
  "artifactRef",
  "versionRef",
  "version",
  "contentHash",
  "contentClass",
  "draftBodyHash",
  "protectedRef",
  "expiresAt",
  "bodyPersisted",
  "recovery"
] as const;

const DRAFT_OUTPUT_LINT_KEYS = [
  "version",
  "receiptRef",
  "receiptHash",
  "status",
  "checks"
] as const;

function closedRecord(
  value: unknown,
  expectedKeys: readonly string[]
): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as UnknownRecord;
  const actualKeys = Object.keys(record).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    return null;
  }
  return record;
}

function isNullableSafeRef(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isSafeIdentifier(value));
}

function isValidRevisionBinding(value: UnknownRecord): boolean {
  if (
    !["initial", "correction"].includes(String(value.revisionKind)) ||
    !isNullableSafeRef(value.priorVersionRef) ||
    !isNullableSafeRef(value.feedbackRef)
  ) {
    return false;
  }
  return value.revisionKind === "initial"
    ? value.priorVersionRef === null && value.feedbackRef === null
    : value.priorVersionRef !== null && value.feedbackRef !== null;
}

function regenerationMaterialFrom(
  input: UnknownRecord
): ReplyDraftRegenerationMaterialV2 | null {
  if (
    typeof input.compositionRef !== "string" ||
    !isSafeIdentifier(input.compositionRef) ||
    typeof input.intentHash !== "string" ||
    !isSha256(input.intentHash) ||
    typeof input.moveSpecHash !== "string" ||
    !isSha256(input.moveSpecHash) ||
    typeof input.draftBodyHash !== "string" ||
    !isSha256(input.draftBodyHash) ||
    typeof input.contentHash !== "string" ||
    !isSha256(input.contentHash) ||
    typeof input.rendererVersion !== "string" ||
    !isSafeIdentifier(input.rendererVersion) ||
    typeof input.rendererReceiptHash !== "string" ||
    !isSha256(input.rendererReceiptHash) ||
    typeof input.lintReceiptHash !== "string" ||
    !isSha256(input.lintReceiptHash) ||
    typeof input.integrityVerificationRef !== "string" ||
    !isSafeIdentifier(input.integrityVerificationRef) ||
    input.intentPolicyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
    typeof input.toolPolicyVersion !== "string" ||
    !isSafeIdentifier(input.toolPolicyVersion) ||
    !isValidRevisionBinding(input)
  ) {
    return null;
  }
  const revisionKind = input.revisionKind as "initial" | "correction";
  const priorVersionRef = input.priorVersionRef as string | null;
  const feedbackRef = input.feedbackRef as string | null;
  return Object.freeze({
    schemaVersion: FACILITATION_DRAFT_REGENERATION_MATERIAL_SCHEMA_VERSION,
    compositionRef: input.compositionRef as string,
    intentHash: input.intentHash as string,
    moveSpecHash: input.moveSpecHash as string,
    draftBodyHash: input.draftBodyHash as string,
    contentHash: input.contentHash as string,
    rendererVersion: input.rendererVersion as string,
    rendererReceiptHash: input.rendererReceiptHash as string,
    lintReceiptHash: input.lintReceiptHash as string,
    integrityVerificationRef: input.integrityVerificationRef as string,
    intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
    toolPolicyVersion: input.toolPolicyVersion as string,
    revisionKind,
    priorVersionRef,
    feedbackRef
  });
}

function parseRegenerationRecipeV2(
  value: unknown
): ReplyDraftRegenerationRecipeV2 | null {
  const recipe = closedRecord(value, DRAFT_RECIPE_V2_KEYS);
  if (
    !recipe ||
    recipe.schemaVersion !==
      FACILITATION_DRAFT_REGENERATION_RECIPE_SCHEMA_VERSION ||
    recipe.strategy !== "reinvoke_semantic_renderer" ||
    typeof recipe.expiresAt !== "string" ||
    !isIsoInstant(recipe.expiresAt) ||
    typeof recipe.regenerationMaterialHash !== "string" ||
    !isSha256(recipe.regenerationMaterialHash) ||
    recipe.requireReverification !== true ||
    recipe.recovery !== "regenerate_and_reverify" ||
    recipe.bodyPersisted !== false ||
    recipe.containsForumText !== false ||
    recipe.containsIdentity !== false ||
    recipe.containsSecrets !== false ||
    !regenerationMaterialFrom(recipe)
  ) {
    return null;
  }
  return recipe as ReplyDraftRegenerationRecipeV2;
}

function recipeMatchesMaterial(
  recipe: Readonly<ReplyDraftRegenerationRecipeV2>,
  material: Readonly<ReplyDraftRegenerationMaterialV2>,
  expiresAt: string
): boolean {
  return (
    recipe.compositionRef === material.compositionRef &&
    recipe.intentHash === material.intentHash &&
    recipe.moveSpecHash === material.moveSpecHash &&
    recipe.draftBodyHash === material.draftBodyHash &&
    recipe.contentHash === material.contentHash &&
    recipe.rendererVersion === material.rendererVersion &&
    recipe.rendererReceiptHash === material.rendererReceiptHash &&
    recipe.lintReceiptHash === material.lintReceiptHash &&
    recipe.integrityVerificationRef === material.integrityVerificationRef &&
    recipe.intentPolicyVersion === material.intentPolicyVersion &&
    recipe.toolPolicyVersion === material.toolPolicyVersion &&
    recipe.revisionKind === material.revisionKind &&
    recipe.priorVersionRef === material.priorVersionRef &&
    recipe.feedbackRef === material.feedbackRef &&
    recipe.expiresAt === expiresAt &&
    recipe.regenerationMaterialHash ===
      hashReplyDraftRegenerationMaterialV2(material)
  );
}

function materialBindingFrom(input: {
  contentHash: string;
  draftBodyHash: string;
  regenerationMaterialHash: string;
  regenerationRecipeHash: string;
  expiresAt: string;
}): ReplyDraftMaterialBindingV2 {
  return Object.freeze({
    schemaVersion: FACILITATION_DRAFT_MATERIAL_BINDING_SCHEMA_VERSION,
    contentHash: input.contentHash,
    draftBodyHash: input.draftBodyHash,
    regenerationMaterialHash: input.regenerationMaterialHash,
    regenerationRecipeHash: input.regenerationRecipeHash,
    verifier: FACILITATION_DRAFT_VERIFIER_CONTRACT,
    expiresAt: input.expiresAt,
    requireReverification: true,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false
  });
}

export type ReplyDraftPersistenceBindingInputV2 = Readonly<{
  metadata: unknown;
  regenerationRecipe: unknown;
  artifact: Readonly<{
    versionRef: string;
    contentHash: string;
    draftBodyHash: string;
    expiresAt: string;
  }>;
  composition: Readonly<{
    versionRef: string;
    intentHash: string;
    moveSpecHash: string;
    toolPolicyVersion: string;
  }>;
}>;

export function parseReplyDraftRecoveryMaterialV2(
  input: ReplyDraftPersistenceBindingInputV2
): VerifiedReplyDraftRecoveryMaterialV2 | null {
  const metadata = closedRecord(input.metadata, DRAFT_METADATA_V2_KEYS);
  const recipe = parseRegenerationRecipeV2(input.regenerationRecipe);
  if (
    !metadata ||
    !recipe ||
    metadata.schemaVersion !== FACILITATION_DRAFT_METADATA_SCHEMA_VERSION ||
    metadata.recovery !== "regenerate_and_reverify" ||
    metadata.bodyPersisted !== false ||
    metadata.containsForumText !== false ||
    metadata.containsIdentity !== false ||
    metadata.containsSecrets !== false ||
    metadata.lintVersion !== FACILITATION_ARTIFACT_LINT_VERSION ||
    typeof metadata.rendererReceiptRef !== "string" ||
    !isSafeIdentifier(metadata.rendererReceiptRef) ||
    typeof metadata.lintReceiptRef !== "string" ||
    !isSafeIdentifier(metadata.lintReceiptRef) ||
    typeof metadata.expiresAt !== "string" ||
    !isIsoInstant(metadata.expiresAt) ||
    typeof metadata.regenerationMaterialHash !== "string" ||
    !isSha256(metadata.regenerationMaterialHash) ||
    typeof metadata.regenerationRecipeHash !== "string" ||
    !isSha256(metadata.regenerationRecipeHash) ||
    typeof metadata.materialBindingHash !== "string" ||
    !isSha256(metadata.materialBindingHash) ||
    typeof input.artifact.versionRef !== "string" ||
    !isSafeIdentifier(input.artifact.versionRef) ||
    typeof input.artifact.contentHash !== "string" ||
    !isSha256(input.artifact.contentHash) ||
    typeof input.artifact.draftBodyHash !== "string" ||
    !isSha256(input.artifact.draftBodyHash) ||
    typeof input.artifact.expiresAt !== "string" ||
    !isIsoInstant(input.artifact.expiresAt)
  ) {
    return null;
  }
  let intent: InterventionIntentV1;
  let moveSpec: FacilitationMoveSpecV1;
  let protocol: { intentHash: string; moveSpecHash: string };
  try {
    intent = parseProtocolObject("interventionIntent", metadata.intent);
    moveSpec = parseProtocolObject("facilitationMoveSpec", metadata.moveSpec);
    protocol = protocolHashes({ intent, moveSpec });
  } catch {
    return null;
  }
  const material = regenerationMaterialFrom(metadata);
  if (
    !material ||
    protocol.intentHash !== metadata.intentHash ||
    protocol.moveSpecHash !== metadata.moveSpecHash ||
    intent.policyVersion !== metadata.intentPolicyVersion ||
    metadata.compositionRef !== input.composition.versionRef ||
    metadata.intentHash !== input.composition.intentHash ||
    metadata.moveSpecHash !== input.composition.moveSpecHash ||
    metadata.toolPolicyVersion !== input.composition.toolPolicyVersion ||
    metadata.contentHash !== input.artifact.contentHash ||
    metadata.draftBodyHash !== input.artifact.draftBodyHash ||
    metadata.expiresAt !== input.artifact.expiresAt
  ) {
    return null;
  }
  const contentMaterial: ReplyDraftContentMaterialV2 = {
    schemaVersion: FACILITATION_DRAFT_METADATA_SCHEMA_VERSION,
    compositionRef: material.compositionRef,
    intent,
    intentHash: material.intentHash,
    moveSpec,
    moveSpecHash: material.moveSpecHash,
    draftBodyHash: material.draftBodyHash,
    rendererVersion: material.rendererVersion,
    rendererReceiptRef: metadata.rendererReceiptRef as string,
    rendererReceiptHash: material.rendererReceiptHash,
    lintVersion: FACILITATION_ARTIFACT_LINT_VERSION,
    lintReceiptRef: metadata.lintReceiptRef as string,
    lintReceiptHash: material.lintReceiptHash,
    integrityVerificationRef: material.integrityVerificationRef,
    intentPolicyVersion: material.intentPolicyVersion,
    toolPolicyVersion: material.toolPolicyVersion,
    revisionKind: material.revisionKind,
    priorVersionRef: material.priorVersionRef,
    feedbackRef: material.feedbackRef,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  if (
    hashReplyDraftContentMaterialV2(contentMaterial) !== material.contentHash ||
    hashReplyDraftRegenerationMaterialV2(material) !==
      metadata.regenerationMaterialHash ||
    !recipeMatchesMaterial(recipe, material, metadata.expiresAt as string) ||
    hashReplyDraftRegenerationRecipeV2(recipe) !==
      metadata.regenerationRecipeHash
  ) {
    return null;
  }
  const binding = materialBindingFrom({
    contentHash: material.contentHash,
    draftBodyHash: material.draftBodyHash,
    regenerationMaterialHash: metadata.regenerationMaterialHash as string,
    regenerationRecipeHash: metadata.regenerationRecipeHash as string,
    expiresAt: metadata.expiresAt as string
  });
  if (
    hashReplyDraftMaterialBindingV2(binding) !== metadata.materialBindingHash
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: FACILITATION_DRAFT_METADATA_SCHEMA_VERSION,
    compositionRef: material.compositionRef,
    intent,
    intentHash: material.intentHash,
    moveSpec,
    moveSpecHash: material.moveSpecHash,
    draftBodyHash: material.draftBodyHash,
    contentHash: material.contentHash,
    rendererVersion: material.rendererVersion,
    rendererReceiptRef: metadata.rendererReceiptRef as string,
    rendererReceiptHash: material.rendererReceiptHash,
    lintReceiptRef: metadata.lintReceiptRef as string,
    lintReceiptHash: material.lintReceiptHash,
    integrityVerificationRef: material.integrityVerificationRef,
    intentPolicyVersion: material.intentPolicyVersion,
    toolPolicyVersion: material.toolPolicyVersion,
    revisionKind: material.revisionKind,
    priorVersionRef: material.priorVersionRef,
    feedbackRef: material.feedbackRef,
    regenerationRecipeHash: metadata.regenerationRecipeHash as string,
    regenerationMaterialHash: metadata.regenerationMaterialHash as string,
    materialBindingHash: metadata.materialBindingHash as string,
    expiresAt: metadata.expiresAt as string,
    regenerationRecipe: recipe
  });
}

export function parseReplyDraftPersistenceBindingV2(
  input: ReplyDraftPersistenceBindingInputV2
): VerifiedReplyDraftPersistenceBindingV2 | null {
  const recovered = parseReplyDraftRecoveryMaterialV2(input);
  if (!recovered) return null;
  return Object.freeze({
    schemaVersion: recovered.schemaVersion,
    compositionRef: recovered.compositionRef,
    intentHash: recovered.intentHash,
    moveSpecHash: recovered.moveSpecHash,
    draftBodyHash: recovered.draftBodyHash,
    contentHash: recovered.contentHash,
    rendererVersion: recovered.rendererVersion,
    rendererReceiptHash: recovered.rendererReceiptHash,
    lintReceiptHash: recovered.lintReceiptHash,
    integrityVerificationRef: recovered.integrityVerificationRef,
    intentPolicyVersion: recovered.intentPolicyVersion,
    toolPolicyVersion: recovered.toolPolicyVersion,
    revisionKind: recovered.revisionKind,
    priorVersionRef: recovered.priorVersionRef,
    feedbackRef: recovered.feedbackRef,
    regenerationRecipeHash: recovered.regenerationRecipeHash,
    regenerationMaterialHash: recovered.regenerationMaterialHash,
    materialBindingHash: recovered.materialBindingHash,
    expiresAt: recovered.expiresAt
  });
}

/** Strict parser for the transient v2 output. It validates every closed field
 * and all body-free hashes while intentionally excluding protectedRef from the
 * hash material. */
export function parseReplyDraftCreateOutputV2(
  value: unknown
): ReplyDraftCreateOutput | null {
  const output = closedRecord(value, DRAFT_OUTPUT_V2_KEYS);
  if (!output) return null;
  const artifact = closedRecord(output.artifact, DRAFT_OUTPUT_ARTIFACT_KEYS);
  const lint = closedRecord(output.lint, DRAFT_OUTPUT_LINT_KEYS);
  const recipe = parseRegenerationRecipeV2(output.regenerationRecipe);
  const material = regenerationMaterialFrom({
    compositionRef: output.compositionRef,
    intentHash: output.intentHash,
    moveSpecHash: output.moveSpecHash,
    draftBodyHash: artifact?.draftBodyHash,
    contentHash: artifact?.contentHash,
    rendererVersion: output.rendererVersion,
    rendererReceiptHash: output.rendererReceiptHash,
    lintReceiptHash: lint?.receiptHash,
    integrityVerificationRef: output.integrityVerificationRef,
    intentPolicyVersion: output.intentPolicyVersion,
    toolPolicyVersion: output.toolPolicyVersion,
    revisionKind: output.revisionKind,
    priorVersionRef: output.priorVersionRef,
    feedbackRef: output.feedbackRef
  });
  if (
    !artifact ||
    !lint ||
    !recipe ||
    !material ||
    output.schemaVersion !== REPLY_DRAFT_OUTPUT_SCHEMA_VERSION ||
    output.status !== "created" ||
    typeof output.rendererReceiptRef !== "string" ||
    !isSafeIdentifier(output.rendererReceiptRef) ||
    lint.version !== FACILITATION_ARTIFACT_LINT_VERSION ||
    typeof lint.receiptRef !== "string" ||
    !isSafeIdentifier(lint.receiptRef) ||
    lint.status !== "passed" ||
    !Array.isArray(lint.checks) ||
    lint.checks.length !== DRAFT_LINT_CHECK_CODES.length ||
    lint.checks.some((check, index) => {
      const item = closedRecord(check, ["code", "status"]);
      return (
        !item ||
        item.code !== DRAFT_LINT_CHECK_CODES[index] ||
        item.status !== "passed"
      );
    }) ||
    artifact.contentClass !== "restricted_transient" ||
    artifact.bodyPersisted !== false ||
    artifact.recovery !== "regenerate_and_reverify" ||
    typeof artifact.protectedRef !== "string" ||
    !/^protected-draft:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(
      artifact.protectedRef
    ) ||
    typeof artifact.expiresAt !== "string" ||
    !isIsoInstant(artifact.expiresAt) ||
    typeof artifact.artifactId !== "string" ||
    !isSafeIdentifier(artifact.artifactId) ||
    typeof artifact.versionId !== "string" ||
    !isSafeIdentifier(artifact.versionId) ||
    typeof artifact.artifactRef !== "string" ||
    !isSafeIdentifier(artifact.artifactRef) ||
    typeof artifact.versionRef !== "string" ||
    !isSafeIdentifier(artifact.versionRef) ||
    !Number.isSafeInteger(artifact.version) ||
    (artifact.version as number) < 1 ||
    output.containsForumText !== false ||
    output.containsIdentity !== false ||
    output.containsSecrets !== false ||
    typeof output.observedAt !== "string" ||
    !isIsoInstant(output.observedAt) ||
    !Array.isArray(output.evidenceRefs)
  ) {
    return null;
  }
  try {
    assertEvidenceRefs(output.evidenceRefs as unknown as readonly EvidenceRef[]);
  } catch {
    return null;
  }
  if (
    output.evidenceRefs.length < 7 ||
    output.regenerationMaterialHash !==
      hashReplyDraftRegenerationMaterialV2(material) ||
    !recipeMatchesMaterial(recipe, material, artifact.expiresAt as string) ||
    output.regenerationRecipeHash !==
      hashReplyDraftRegenerationRecipeV2(recipe)
  ) {
    return null;
  }
  const binding = materialBindingFrom({
    contentHash: material.contentHash,
    draftBodyHash: material.draftBodyHash,
    regenerationMaterialHash: output.regenerationMaterialHash as string,
    regenerationRecipeHash: output.regenerationRecipeHash as string,
    expiresAt: artifact.expiresAt as string
  });
  if (output.materialBindingHash !== hashReplyDraftMaterialBindingV2(binding)) {
    return null;
  }
  return output as unknown as ReplyDraftCreateOutput;
}

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions?/iu,
  /system\s+(?:prompt|message)/iu,
  /developer\s+message/iu,
  /(?:call|invoke|execute)\s+(?:the\s+)?(?:tool|function)/iu,
  /<\/?(?:script|iframe|object|embed)\b/iu,
  /忽略(?:之前|以上|先前).{0,12}(?:指令|要求|规则)/u,
  /系统提示(?:词|消息)?/u
] as const;
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/u,
  /\b(?:\+?\d[\d .()-]{7,}\d)\b/u,
  /(?:用户名|真实姓名|身份证号|学号|手机号|邮箱)\s*[:：]/u,
  /@[A-Za-z0-9_]{2,32}\b/u
] as const;
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/iu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\b(?:api[_-]?key|token|password|passwd|cookie|authorization|auth[_-]?state)\b\s*[:=]/iu
] as const;
const UNSUPPORTED_CLAIM_PATTERNS = [
  /(?:已经|已)(?:发布|发送|通知|干预)/u,
  /(?:证明|证实).{0,12}(?:有效|提升|改善|导致)/u,
  /(?:显著|必然|一定)(?:提升|改善|促进)/u,
  /(?:caused?|proves?|demonstrates?)\s+(?:learning|effectiveness|improvement)/iu,
  /(?:published|sent|notified)\s+(?:successfully|already)/iu
] as const;

function lintDraft(
  bodyInput: string,
  renderer: RenderedFacilitationDraftMaterial["renderer"]
): { body: string; checks: readonly DraftLintCheck[] } {
  if (
    renderer.inputContainsForumText !== false ||
    renderer.inputContainsIdentity !== false ||
    renderer.inputContainsSecrets !== false
  ) {
    fail(
      "FACILITATION_RENDERER_INPUT_RESTRICTED",
      "Renderer input was not proven to exclude restricted source content."
    );
  }
  const body = normalizeTransientDraftBody(bodyInput).trim();
  if (!body.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, "")) {
    fail(
      "FACILITATION_DRAFT_EMPTY",
      "Renderer returned no substantive draft content."
    );
  }
  if (Array.from(body).length > 4_000) {
    fail(
      "FACILITATION_DRAFT_TOO_LONG",
      "Renderer draft exceeds the bounded artifact contract."
    );
  }
  const blocked = [
    [PROMPT_INJECTION_PATTERNS, "FACILITATION_DRAFT_PROMPT_INJECTION"],
    [PII_PATTERNS, "FACILITATION_DRAFT_PII"],
    [SECRET_PATTERNS, "FACILITATION_DRAFT_SECRET"],
    [UNSUPPORTED_CLAIM_PATTERNS, "FACILITATION_DRAFT_UNSUPPORTED_CLAIM"]
  ] as const;
  for (const [patterns, code] of blocked) {
    if (patterns.some((pattern) => pattern.test(body))) {
      fail(
        code,
        "Draft failed a restricted-content or unsupported-claim check."
      );
    }
  }
  return {
    body,
    checks: Object.freeze(
      DRAFT_LINT_CHECK_CODES.map((code) =>
        Object.freeze({ code, status: "passed" as const })
      ) as DraftLintCheck[]
    )
  };
}

function protectedExpiry(
  context: Readonly<ServerToolExecutionContext>,
  configuredTtlMs: number | undefined
): string {
  const ttl = configuredTtlMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 30 * 60_000) {
    fail(
      "FACILITATION_PROTECTED_TTL_INVALID",
      "Protected draft TTL is outside the bounded process-memory policy."
    );
  }
  return new Date(
    Math.min(Date.parse(context.deadlineAt), Date.parse(context.now) + ttl)
  ).toISOString();
}

function validateComposition(input: {
  material: VerifiedIntentCompositionMaterial;
  selectionRef: string;
  integrityVerificationRef: string;
  context: Readonly<ServerToolExecutionContext>;
}): {
  intent: InterventionIntentV1;
  moveSpec: FacilitationMoveSpecV1;
  intentHash: string;
  moveSpecHash: string;
  evidenceRefs: readonly EvidenceRef[];
} {
  const { material, context } = input;
  assertPrivacyFlags(material);
  if (
    material.selectionRef !== input.selectionRef ||
    material.integrityVerificationRef !== input.integrityVerificationRef ||
    material.integrityStatus !== "passed" ||
    material.intentPolicyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
    material.toolPolicyVersion !== context.policyVersion ||
    !isSha256(material.selectionEvidenceBindingHash) ||
    !isSha256(material.evidenceBindingHash)
  ) {
    fail(
      "FACILITATION_COMPOSITION_EVIDENCE_MISMATCH",
      "Intent composition did not preserve the verified selection binding."
    );
  }
  const hashes = protocolHashes(material);
  if (
    material.intent.evidenceRefHash !== material.evidenceBindingHash ||
    material.intent.policyVersion !== material.intentPolicyVersion ||
    material.intent.intervene !== true ||
    Date.parse(material.intent.evidenceAsOf) > Date.parse(context.now) ||
    Date.parse(material.intent.candidateExpiresAt) <= Date.parse(context.now)
  ) {
    fail(
      "FACILITATION_COMPOSITION_PROTOCOL_MISMATCH",
      "Intent composition is not bound to current verified evidence and policy."
    );
  }
  return {
    intent: material.intent,
    moveSpec: material.moveSpec,
    ...hashes,
    evidenceRefs: assertVerifiedEvidence({
      refs: material.evidenceRefs,
      integrityVerificationRef: input.integrityVerificationRef,
      now: context.now
    })
  };
}

function validateRenderedMaterial(input: {
  material: RenderedFacilitationDraftMaterial;
  request: ReplyDraftCreateInput;
  priorVersionRef: string | null;
  feedbackRef: string | null;
  context: Readonly<ServerToolExecutionContext>;
}): {
  intent: InterventionIntentV1;
  moveSpec: FacilitationMoveSpecV1;
  intentHash: string;
  moveSpecHash: string;
  evidenceRefs: readonly EvidenceRef[];
  body: string;
  checks: readonly DraftLintCheck[];
} {
  const { material, context } = input;
  assertPrivacyFlags(material);
  if (
    material.compositionRef !== input.request.compositionRef ||
    material.resolvedPriorVersionRef !== input.priorVersionRef ||
    material.resolvedFeedbackRef !== input.feedbackRef ||
    !isSafeIdentifier(material.logicalDraftKey) ||
    !isSafeIdentifier(material.renderer.version) ||
    !isSafeIdentifier(material.renderer.receiptRef) ||
    !isSha256(material.renderer.receiptHash) ||
    material.intentPolicyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
    material.toolPolicyVersion !== context.policyVersion ||
    material.intent.policyVersion !== material.intentPolicyVersion
  ) {
    fail(
      "FACILITATION_RENDER_BINDING_MISMATCH",
      "Semantic renderer did not preserve the trusted composition/revision binding."
    );
  }
  const hashes = protocolHashes(material);
  if (
    hashes.intentHash !== material.intentHash ||
    hashes.moveSpecHash !== material.moveSpecHash
  ) {
    fail(
      "FACILITATION_RENDER_PROTOCOL_MISMATCH",
      "Semantic renderer changed the bound Intent or MoveSpec."
    );
  }
  const evidenceRefs = assertVerifiedEvidence({
    refs: material.evidenceRefs,
    integrityVerificationRef: material.integrityVerificationRef,
    now: context.now
  });
  const linted = lintDraft(material.body, material.renderer);
  return {
    intent: material.intent,
    moveSpec: material.moveSpec,
    ...hashes,
    evidenceRefs,
    ...linted
  };
}

function asJsonEvidenceRefs(
  refs: readonly EvidenceRef[]
): readonly JsonEvidenceRef[] {
  return Object.freeze(
    refs.map((ref) =>
      Object.freeze({
        kind: ref.kind,
        id: ref.id,
        hash: ref.hash,
        observedAt: ref.observedAt
      })
    )
  );
}

async function composeIntentHandler(
  deps: FacilitationArtifactToolDependencies,
  input: FacilitationIntentComposeInput,
  context: Readonly<ServerToolExecutionContext>
): Promise<FacilitationIntentComposeOutput> {
  const material = await safely(
    "FACILITATION_COMPOSITION_UNAVAILABLE",
    "Verified Intent composition could not be established.",
    () =>
      deps.composeIntent({
        selectionRef: input.selectionRef,
        integrityVerificationRef: input.integrityVerificationRef,
        context
      })
  );
  const validated = validateComposition({
    material,
    selectionRef: input.selectionRef,
    integrityVerificationRef: input.integrityVerificationRef,
    context
  });
  const receiptBody = {
    schemaVersion: "cmooc.facilitation-intent-compose-receipt.v2",
    selectionRef: input.selectionRef,
    selectionEvidenceBindingHash: material.selectionEvidenceBindingHash,
    integrityVerificationRef: input.integrityVerificationRef,
    evidenceBindingHash: material.evidenceBindingHash,
    intentPolicyVersion: material.intentPolicyVersion,
    toolPolicyVersion: material.toolPolicyVersion,
    intentHash: validated.intentHash,
    moveSpecHash: validated.moveSpecHash,
    policyVersionHash: hashCourseToolValue("policy-versions.v2", {
      intentPolicyVersion: material.intentPolicyVersion,
      toolPolicyVersion: material.toolPolicyVersion
    }),
    observedAt: context.now,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  } as const;
  const receiptHash = hashCourseToolValue(
    "facilitation-intent-compose-receipt.v2",
    receiptBody
  );
  const receiptRef = `intent-compose:${receiptHash}`;
  const contentHash = hashCourseToolValue(
    "facilitation-intent-artifact.v2",
    {
      schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
      intent: validated.intent as CanonicalJsonValue,
      intentHash: validated.intentHash,
      moveSpec: validated.moveSpec as CanonicalJsonValue,
      moveSpecHash: validated.moveSpecHash,
      receiptHash,
      intentPolicyVersion: material.intentPolicyVersion,
      toolPolicyVersion: material.toolPolicyVersion,
      selectionEvidenceBindingHash: material.selectionEvidenceBindingHash,
      evidenceBindingHash: material.evidenceBindingHash
    }
  );
  const pointer = await safely(
    "FACILITATION_INTENT_ARTIFACT_WRITE_FAILED",
    "Intent artifact metadata could not be versioned.",
    () =>
      deps.createArtifactVersion({
        taskId: context.taskId,
        runId: context.runId,
        createdByCallId: context.callId,
        artifactKey: artifactKey(
          "facilitation_intent",
          context,
          input.selectionRef
        ),
        versionKey: context.idempotencyKey,
        previousVersionRef: null,
        artifactKind: "facilitation_intent",
        contentClass: "safe_generated",
        contentHash,
        draftBodyHash: null,
        safeSummary: "Verified facilitation Intent and MoveSpec composed.",
        metadata: {
          schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
          receiptRef,
          receiptHash,
          selectionRef: input.selectionRef,
          selectionEvidenceBindingHash:
            material.selectionEvidenceBindingHash,
          integrityVerificationRef: input.integrityVerificationRef,
          evidenceBindingHash: material.evidenceBindingHash,
          intentPolicyVersion: material.intentPolicyVersion,
          toolPolicyVersion: material.toolPolicyVersion,
          intent: validated.intent as CanonicalJsonValue,
          intentHash: validated.intentHash,
          moveSpec: validated.moveSpec as CanonicalJsonValue,
          moveSpecHash: validated.moveSpecHash,
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        },
        sourceRefs: validated.evidenceRefs,
        regenerationRecipe: null,
        expiresAt: validated.intent.candidateExpiresAt
      })
  );
  assertArtifactPointer(pointer, contentHash);
  return {
    schemaVersion: FACILITATION_INTENT_OUTPUT_SCHEMA_VERSION,
    status: "composed",
    compositionRef: pointer.versionRef,
    intent: validated.intent,
    intentHash: validated.intentHash,
    moveSpec: validated.moveSpec,
    moveSpecHash: validated.moveSpecHash,
    intentPolicyVersion: material.intentPolicyVersion,
    toolPolicyVersion: material.toolPolicyVersion,
    selectionEvidenceBindingHash: material.selectionEvidenceBindingHash,
    evidenceBindingHash: material.evidenceBindingHash,
    integrityVerificationRef: input.integrityVerificationRef,
    receiptRef,
    receiptHash,
    artifact: pointer,
    evidenceRefs: asJsonEvidenceRefs(validated.evidenceRefs),
    observedAt: context.now,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

type CheckedDraftRecoverySource = Readonly<{
  source: ReplyDraftRecoverySourceV2;
  material: VerifiedReplyDraftRecoveryMaterialV2;
  evidenceRefs: readonly EvidenceRef[];
}>;

function checkDraftRecoverySource(
  source: ReplyDraftRecoverySourceV2,
  context: Readonly<ServerToolExecutionContext>
): CheckedDraftRecoverySource {
  if (
    !source ||
    !source.artifact ||
    !source.composition ||
    !source.sourceVerification ||
    !source.sourceVerification.verifier ||
    !source.sourceVerification.evidenceRef ||
    !Array.isArray(source.evidenceRefs) ||
    source.containsForumText !== false ||
    source.containsIdentity !== false ||
    source.containsSecrets !== false ||
    !isSafeIdentifier(source.logicalDraftKey) ||
    source.artifact.contentClass !== "restricted_transient" ||
    source.artifact.bodyPersisted !== false ||
    !isIsoInstant(source.artifact.observedAt) ||
    Date.parse(source.artifact.observedAt) > Date.parse(context.now) ||
    source.sourceVerification.status !== "passed" ||
    source.sourceVerification.subjectVersionRef !== source.artifact.versionRef ||
    source.sourceVerification.verifier.name !== DRAFT_VERIFIER.name ||
    source.sourceVerification.verifier.version !== DRAFT_VERIFIER.version ||
    source.sourceVerification.evidenceRef.kind !== "verification"
  ) {
    fail(
      "FACILITATION_DRAFT_RECOVERY_SOURCE_INVALID",
      "Server-provided draft recovery material is invalid or incomplete."
    );
  }
  assertArtifactPointer(source.artifact, source.artifact.contentHash);
  const material = parseReplyDraftRecoveryMaterialV2({
    metadata: source.metadata,
    regenerationRecipe: source.regenerationRecipe,
    artifact: {
      versionRef: source.artifact.versionRef,
      contentHash: source.artifact.contentHash,
      draftBodyHash: source.artifact.draftBodyHash,
      expiresAt: source.artifact.expiresAt
    },
    composition: source.composition
  });
  if (!material) {
    fail(
      "FACILITATION_DRAFT_RECOVERY_BINDING_INVALID",
      "Persisted draft recovery hashes or recipe do not form a verified v2 binding."
    );
  }
  if (
    material.revisionKind !== "initial" ||
    material.priorVersionRef !== null ||
    material.feedbackRef !== null
  ) {
    fail(
      "FACILITATION_DRAFT_RECOVERY_REVISION_UNSUPPORTED",
      "The first recovery slice supports only an initial deterministic draft."
    );
  }
  if (
    material.rendererVersion !== SEMANTIC_RENDERER_VERSION ||
    material.intentPolicyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
    material.toolPolicyVersion !== context.policyVersion ||
    material.intent.policyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
    Date.parse(material.intent.candidateExpiresAt) <= Date.parse(context.now)
  ) {
    fail(
      "FACILITATION_DRAFT_RECOVERY_STALE",
      "Draft recovery material is stale under the current renderer or policy."
    );
  }
  if (
    Date.parse(source.artifact.expiresAt) <=
    Date.parse(source.artifact.observedAt)
  ) {
    fail(
      "FACILITATION_DRAFT_RECOVERY_LIFETIME_INVALID",
      "Draft regeneration requires a valid prior protected-artifact lifetime."
    );
  }
  const sourceArtifactRef: EvidenceRef = {
    kind: "artifact",
    id: source.artifact.versionRef,
    hash: source.artifact.contentHash,
    observedAt: source.artifact.observedAt
  };
  const evidenceRefs = assertVerifiedEvidence({
    refs: dedupeEvidenceRefs([
      ...source.evidenceRefs,
      sourceArtifactRef,
      source.sourceVerification.evidenceRef
    ]),
    integrityVerificationRef: material.integrityVerificationRef,
    now: context.now
  });
  return Object.freeze({ source, material, evidenceRefs });
}

async function persistRenderedDraftV2(
  deps: FacilitationArtifactToolDependencies,
  input: ReplyDraftCreateInput,
  material: RenderedFacilitationDraftMaterial,
  context: Readonly<ServerToolExecutionContext>,
  recovery?: CheckedDraftRecoverySource,
  createdByCallId: string | null = context.callId
): Promise<ReplyDraftCreateOutput> {
  const revision = assertRevisionInput(input);
  const validated = validateRenderedMaterial({
    material,
    request: input,
    ...revision,
    context
  });
  const draftBodyHash = hashTransientDraftBody(validated.body);
  const lintReceiptBody = {
    schemaVersion: "cmooc.facilitation-draft-lint-receipt.v2",
    version: FACILITATION_ARTIFACT_LINT_VERSION,
    compositionRef: input.compositionRef,
    intentHash: validated.intentHash,
    moveSpecHash: validated.moveSpecHash,
    draftBodyHash,
    rendererReceiptHash: material.renderer.receiptHash,
    checks: validated.checks,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  } as const;
  const lintReceiptHash = hashCourseToolValue(
    "facilitation-draft-lint-receipt.v2",
    lintReceiptBody
  );
  const lintReceiptRef = `draft-lint:${lintReceiptHash}`;
  const contentMaterial: ReplyDraftContentMaterialV2 = {
    schemaVersion: FACILITATION_DRAFT_METADATA_SCHEMA_VERSION,
    compositionRef: input.compositionRef,
    intent: validated.intent,
    intentHash: validated.intentHash,
    moveSpec: validated.moveSpec,
    moveSpecHash: validated.moveSpecHash,
    draftBodyHash,
    rendererVersion: material.renderer.version,
    rendererReceiptRef: material.renderer.receiptRef,
    rendererReceiptHash: material.renderer.receiptHash,
    lintVersion: FACILITATION_ARTIFACT_LINT_VERSION,
    lintReceiptRef,
    lintReceiptHash,
    integrityVerificationRef: material.integrityVerificationRef,
    intentPolicyVersion: material.intentPolicyVersion,
    toolPolicyVersion: material.toolPolicyVersion,
    revisionKind: input.revisionKind,
    priorVersionRef: revision.priorVersionRef,
    feedbackRef: revision.feedbackRef,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  const contentHash = hashReplyDraftContentMaterialV2(contentMaterial);
  const expiresAt = protectedExpiry(context, deps.protectedDraftTtlMs);
  const regenerationMaterial: ReplyDraftRegenerationMaterialV2 = {
    schemaVersion: FACILITATION_DRAFT_REGENERATION_MATERIAL_SCHEMA_VERSION,
    compositionRef: input.compositionRef,
    intentHash: validated.intentHash,
    moveSpecHash: validated.moveSpecHash,
    draftBodyHash,
    contentHash,
    rendererVersion: material.renderer.version,
    rendererReceiptHash: material.renderer.receiptHash,
    lintReceiptHash,
    integrityVerificationRef: material.integrityVerificationRef,
    intentPolicyVersion: material.intentPolicyVersion,
    toolPolicyVersion: material.toolPolicyVersion,
    revisionKind: input.revisionKind,
    priorVersionRef: revision.priorVersionRef,
    feedbackRef: revision.feedbackRef
  };
  const regenerationMaterialHash = hashReplyDraftRegenerationMaterialV2(
    regenerationMaterial
  );
  if (
    recovery &&
    (draftBodyHash !== recovery.material.draftBodyHash ||
      contentHash !== recovery.material.contentHash ||
      material.renderer.version !== recovery.material.rendererVersion ||
      material.renderer.receiptRef !==
        recovery.material.rendererReceiptRef ||
      material.renderer.receiptHash !==
        recovery.material.rendererReceiptHash ||
      lintReceiptHash !== recovery.material.lintReceiptHash ||
      regenerationMaterialHash !==
        recovery.material.regenerationMaterialHash)
  ) {
    fail(
      "FACILITATION_DRAFT_RECOVERY_REBUILD_MISMATCH",
      "Deterministic draft reconstruction changed verified stable material."
    );
  }
  const regenerationRecipe: ReplyDraftRegenerationRecipeV2 = {
    schemaVersion: FACILITATION_DRAFT_REGENERATION_RECIPE_SCHEMA_VERSION,
    strategy: "reinvoke_semantic_renderer",
    compositionRef: input.compositionRef,
    intentHash: validated.intentHash,
    moveSpecHash: validated.moveSpecHash,
    draftBodyHash,
    contentHash,
    rendererVersion: material.renderer.version,
    rendererReceiptHash: material.renderer.receiptHash,
    lintReceiptHash,
    integrityVerificationRef: material.integrityVerificationRef,
    intentPolicyVersion: material.intentPolicyVersion,
    toolPolicyVersion: material.toolPolicyVersion,
    revisionKind: input.revisionKind,
    priorVersionRef: revision.priorVersionRef,
    feedbackRef: revision.feedbackRef,
    expiresAt,
    regenerationMaterialHash,
    requireReverification: true,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  const regenerationRecipeHash = hashReplyDraftRegenerationRecipeV2(
    regenerationRecipe
  );
  const materialBindingHash = hashReplyDraftMaterialBindingV2(
    materialBindingFrom({
      contentHash,
      draftBodyHash,
      regenerationMaterialHash,
      regenerationRecipeHash,
      expiresAt
    })
  );
  if (
    recovery &&
    (Date.parse(expiresAt) <= Date.parse(recovery.material.expiresAt) ||
      regenerationRecipeHash === recovery.material.regenerationRecipeHash ||
      materialBindingHash === recovery.material.materialBindingHash)
  ) {
    fail(
      "FACILITATION_DRAFT_RECOVERY_EXPIRY_INVALID",
      "Regenerated draft did not receive a fresh protected-material binding."
    );
  }
  const persistedMetadata: ReplyDraftPersistedMetadataV2 = {
    ...contentMaterial,
    contentHash,
    expiresAt,
    regenerationMaterialHash,
    regenerationRecipeHash,
    materialBindingHash
  };
  assertCourseToolJsonValue(persistedMetadata, "reply draft metadata v2");
  assertCourseToolJsonValue(regenerationRecipe, "reply draft recipe v2");
  const pointer = await safely(
    "FACILITATION_DRAFT_ARTIFACT_WRITE_FAILED",
    "Draft artifact metadata could not be versioned.",
    () =>
      deps.createArtifactVersion({
        taskId: context.taskId,
        runId: context.runId,
        createdByCallId,
        artifactKey: artifactKey(
          "facilitation_reply_draft",
          context,
          material.logicalDraftKey
        ),
        versionKey: context.idempotencyKey,
        previousVersionRef:
          recovery?.source.artifact.versionRef ?? revision.priorVersionRef,
        artifactKind: "facilitation_reply_draft",
        contentClass: "restricted_transient",
        contentHash,
        draftBodyHash,
        safeSummary: "Restricted transient facilitation reply draft validated.",
        metadata: persistedMetadata,
        sourceRefs: validated.evidenceRefs,
        regenerationRecipe,
        expiresAt
      })
  );
  assertArtifactPointer(pointer, contentHash);
  if (
    recovery &&
    (pointer.artifactId !== recovery.source.artifact.artifactId ||
      pointer.artifactRef !== recovery.source.artifact.artifactRef ||
      pointer.versionRef === recovery.source.artifact.versionRef ||
      pointer.version <= recovery.source.artifact.version)
  ) {
    fail(
      "FACILITATION_DRAFT_RECOVERY_VERSION_INVALID",
      "Recovered draft was not written as a new version of the source artifact."
    );
  }
  const protectedHandle = await safely(
    "FACILITATION_PROTECTED_DRAFT_WRITE_FAILED",
    "Draft body could not be placed in the process-memory protected store.",
    () =>
      deps.protectedStore.put({
        taskId: context.taskId,
        runId: context.runId,
        callId: context.callId,
        idempotencyKey: context.idempotencyKey,
        body: validated.body,
        draftBodyHash,
        storedAt: context.now,
        expiresAt
      })
  );
  assertProtectedHandle(protectedHandle, draftBodyHash, expiresAt);
  return {
    schemaVersion: REPLY_DRAFT_OUTPUT_SCHEMA_VERSION,
    status: "created",
    compositionRef: input.compositionRef,
    intentHash: validated.intentHash,
    moveSpecHash: validated.moveSpecHash,
    intentPolicyVersion: material.intentPolicyVersion,
    toolPolicyVersion: material.toolPolicyVersion,
    rendererReceiptRef: material.renderer.receiptRef,
    rendererReceiptHash: material.renderer.receiptHash,
    rendererVersion: material.renderer.version,
    lint: {
      version: FACILITATION_ARTIFACT_LINT_VERSION,
      receiptRef: lintReceiptRef,
      receiptHash: lintReceiptHash,
      status: "passed",
      checks: validated.checks
    },
    revisionKind: input.revisionKind,
    priorVersionRef: revision.priorVersionRef,
    feedbackRef: revision.feedbackRef,
    regenerationRecipe,
    regenerationRecipeHash,
    regenerationMaterialHash,
    materialBindingHash,
    artifact: {
      ...pointer,
      contentClass: "restricted_transient",
      draftBodyHash,
      protectedRef: protectedHandle.ref,
      expiresAt,
      bodyPersisted: false,
      recovery: "regenerate_and_reverify"
    },
    integrityVerificationRef: material.integrityVerificationRef,
    evidenceRefs: asJsonEvidenceRefs(validated.evidenceRefs),
    observedAt: context.now,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

async function createDraftHandler(
  deps: FacilitationArtifactToolDependencies,
  input: ReplyDraftCreateInput,
  context: Readonly<ServerToolExecutionContext>
): Promise<ReplyDraftCreateOutput> {
  const revision = assertRevisionInput(input);
  const material = await safely(
    "FACILITATION_RENDERER_UNAVAILABLE",
    "Bound semantic renderer could not produce a verified draft.",
    () =>
      deps.renderDraft({
        compositionRef: input.compositionRef,
        revisionKind: input.revisionKind,
        priorVersionRef: revision.priorVersionRef,
        feedbackRef: revision.feedbackRef,
        context
      })
  );
  return persistRenderedDraftV2(deps, input, material, context);
}

/**
 * Server-only correction entry point for a user-edited protected draft. It
 * reuses the exact v2 correction, lint, hashing, recipe and immutable-version
 * pipeline without manufacturing a course-tool execution outcome. The caller
 * must supply already parsed, verified prior material and a server-generated
 * feedback reference; neither the body nor that reference is projected by
 * this helper.
 */
export async function createTrustedReplyDraftCorrection(input: {
  readonly deps: FacilitationArtifactToolDependencies;
  readonly prior: VerifiedReplyDraftRecoveryMaterialV2;
  readonly priorVersionRef: string;
  readonly feedbackRef: string;
  readonly logicalDraftKey: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly correctedBody: string;
  readonly context: Readonly<ServerToolExecutionContext>;
}): Promise<ReplyDraftCreateOutput> {
  if (
    input.priorVersionRef === input.prior.priorVersionRef ||
    !isSafeIdentifier(input.priorVersionRef) ||
    !isSafeIdentifier(input.feedbackRef) ||
    !isSafeIdentifier(input.logicalDraftKey)
  ) {
    fail(
      "FACILITATION_DRAFT_CORRECTION_BINDING_INVALID",
      "Protected draft correction is not bound to one exact prior version."
    );
  }
  const draftBodyHash = hashTransientDraftBody(input.correctedBody);
  const rendererReceiptHash = hashCourseToolValue(
    "cmooc.protected-draft-correction-receipt.v1",
    {
      compositionRef: input.prior.compositionRef,
      priorVersionRef: input.priorVersionRef,
      feedbackRef: input.feedbackRef,
      draftBodyHash,
      priorContentHash: input.prior.contentHash
    }
  );
  const request: ReplyDraftCreateInput = Object.freeze({
    compositionRef: input.prior.compositionRef,
    revisionKind: "correction" as const,
    priorVersionRef: input.priorVersionRef,
    feedbackRef: input.feedbackRef
  });
  const material: RenderedFacilitationDraftMaterial = Object.freeze({
    compositionRef: input.prior.compositionRef,
    logicalDraftKey: input.logicalDraftKey,
    intent: input.prior.intent,
    intentHash: input.prior.intentHash,
    moveSpec: input.prior.moveSpec,
    moveSpecHash: input.prior.moveSpecHash,
    integrityVerificationRef: input.prior.integrityVerificationRef,
    intentPolicyVersion: input.prior.intentPolicyVersion,
    toolPolicyVersion: input.prior.toolPolicyVersion,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
    renderer: Object.freeze({
      version: "cmooc.protected-draft-correction.v1",
      receiptRef: `protected-correction-receipt:${rendererReceiptHash}`,
      receiptHash: rendererReceiptHash,
      inputContainsForumText: false as const,
      inputContainsIdentity: false as const,
      inputContainsSecrets: false as const
    }),
    body: input.correctedBody,
    resolvedPriorVersionRef: input.priorVersionRef,
    resolvedFeedbackRef: input.feedbackRef,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });
  return persistRenderedDraftV2(
    input.deps,
    request,
    material,
    input.context,
    undefined,
    null
  );
}

async function regenerateDraftHandler(
  deps: FacilitationArtifactToolDependencies,
  context: Readonly<ServerToolExecutionContext>
): Promise<ReplyDraftCreateOutput> {
  if (!deps.resolveVerifiedDraftRecoveryMaterial) {
    fail(
      "FACILITATION_DRAFT_RECOVERY_UNAVAILABLE",
      "No verified server-side draft recovery material is available."
    );
  }
  const source = await safely(
    "FACILITATION_DRAFT_RECOVERY_UNAVAILABLE",
    "Verified server-side draft recovery material could not be loaded.",
    () => deps.resolveVerifiedDraftRecoveryMaterial!({ context })
  );
  const recovery = checkDraftRecoverySource(source, context);
  const body = await safely(
    "FACILITATION_DRAFT_RECOVERY_REBUILD_MISMATCH",
    "Deterministic draft reconstruction did not match its verified body hash.",
    async () =>
      rebuildDeterministicSemanticDraft({
        intent: recovery.material.intent,
        moveSpec: recovery.material.moveSpec,
        intentHash: recovery.material.intentHash,
        moveSpecHash: recovery.material.moveSpecHash,
        expectedContentHash: recovery.material.draftBodyHash
      })
  );
  const rendered: RenderedFacilitationDraftMaterial = Object.freeze({
    compositionRef: recovery.material.compositionRef,
    logicalDraftKey: recovery.source.logicalDraftKey,
    intent: recovery.material.intent,
    intentHash: recovery.material.intentHash,
    moveSpec: recovery.material.moveSpec,
    moveSpecHash: recovery.material.moveSpecHash,
    integrityVerificationRef: recovery.material.integrityVerificationRef,
    intentPolicyVersion: recovery.material.intentPolicyVersion,
    toolPolicyVersion: recovery.material.toolPolicyVersion,
    evidenceRefs: recovery.evidenceRefs,
    renderer: Object.freeze({
      version: recovery.material.rendererVersion,
      receiptRef: recovery.material.rendererReceiptRef,
      receiptHash: recovery.material.rendererReceiptHash,
      inputContainsForumText: false,
      inputContainsIdentity: false,
      inputContainsSecrets: false
    }),
    body,
    resolvedPriorVersionRef: null,
    resolvedFeedbackRef: null,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });
  return persistRenderedDraftV2(
    deps,
    {
      compositionRef: recovery.material.compositionRef,
      revisionKind: "initial"
    },
    rendered,
    context,
    recovery
  );
}

function assertProtectedHandle(
  handle: ProtectedDraftHandle,
  expectedHash: string,
  expectedExpiresAt: string
): void {
  if (
    !handle ||
    !/^protected-draft:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(handle.ref) ||
    handle.draftBodyHash !== expectedHash ||
    handle.expiresAt !== expectedExpiresAt ||
    handle.bodyPersisted !== false ||
    handle.recovery !== "regenerate_and_reverify"
  ) {
    fail(
      "FACILITATION_PROTECTED_DRAFT_HANDLE_INVALID",
      "Protected draft store returned an invalid transient handle."
    );
  }
}

async function createDeliveryHandler(
  deps: FacilitationArtifactToolDependencies,
  input: DeliveryBundleCreateInput,
  context: Readonly<ServerToolExecutionContext>
): Promise<DeliveryBundleCreateOutput> {
  const resolved = await safely(
    "FACILITATION_DELIVERY_INPUTS_UNAVAILABLE",
    "Delivery references could not be resolved to verified server records.",
    () =>
      deps.resolveDeliveryInputs({
        draftVersionRef: input.draftVersionRef,
        integrityVerificationRef: input.integrityVerificationRef,
        stageVerificationRef: input.stageVerificationRef,
        context
      })
  );
  assertPrivacyFlags(resolved);
  if (
    resolved.draft.versionRef !== input.draftVersionRef ||
    resolved.draft.contentClass !== "restricted_transient" ||
    resolved.draft.status !== "validated" ||
    !isSha256(resolved.draft.contentHash) ||
    !isSha256(resolved.draft.draftBodyHash) ||
    resolved.integrity.ref !== input.integrityVerificationRef ||
    resolved.integrity.status !== "passed" ||
    resolved.stageVerification.ref !== input.stageVerificationRef ||
    resolved.stageVerification.status !== "passed" ||
    resolved.stageVerification.subjectType !== "stage_transaction" ||
    resolved.stageVerification.artifactVersionRef !== input.draftVersionRef ||
    resolved.stageVerification.draftBodyHash !== resolved.draft.draftBodyHash ||
    resolved.stageVerification.clearVerified !== true ||
    resolved.stageVerification.editorEmptyAfter !== true ||
    resolved.stageVerification.submitMutationCount !== 0 ||
    resolved.stageVerification.sendMutationCount !== 0 ||
    resolved.stageVerification.realPublishEnabled !== false ||
    resolved.stageVerification.bodyPersisted !== false ||
    !isIsoInstant(resolved.stageVerification.observedAt) ||
    Date.parse(resolved.stageVerification.observedAt) > Date.parse(context.now) ||
    resolved.stageVerification.receiptEvidenceRef.kind !== "stage_receipt" ||
    resolved.stageVerification.receiptEvidenceRef.id !==
      input.stageVerificationRef
  ) {
    fail(
      "FACILITATION_DELIVERY_INVARIANT_FAILED",
      "Delivery references do not prove a cleared, zero-publish STAGE transaction."
    );
  }
  const evidenceRefs = assertVerifiedEvidence({
    refs: [
      ...resolved.draft.evidenceRefs,
      ...resolved.integrity.evidenceRefs,
      resolved.stageVerification.receiptEvidenceRef
    ],
    integrityVerificationRef: input.integrityVerificationRef,
    now: context.now,
    requireStageReceipt: true
  });
  const contentHash = hashCourseToolValue(
    "facilitation-delivery-bundle-artifact.v1",
    {
      schemaVersion: DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION,
      draftVersionRef: input.draftVersionRef,
      draftContentHash: resolved.draft.contentHash,
      draftBodyHash: resolved.draft.draftBodyHash,
      integrityVerificationRef: input.integrityVerificationRef,
      stageVerificationRef: input.stageVerificationRef,
      clearVerified: true,
      editorEmptyAfter: true,
      submitMutationCount: 0,
      sendMutationCount: 0,
      realPublishEnabled: false,
      published: false,
      limitationCodes: [
        "stage_only_not_published",
        "not_intervention_or_effect_evidence"
      ]
    }
  );
  const pointer = await safely(
    "FACILITATION_DELIVERY_ARTIFACT_WRITE_FAILED",
    "Delivery bundle metadata could not be versioned.",
    () =>
      deps.createArtifactVersion({
        taskId: context.taskId,
        runId: context.runId,
        createdByCallId: context.callId,
        artifactKey: artifactKey(
          "facilitation_delivery_bundle",
          context,
          resolved.draft.artifactId
        ),
        versionKey: context.idempotencyKey,
        previousVersionRef: null,
        artifactKind: "facilitation_delivery_bundle",
        contentClass: "safe_aggregate",
        contentHash,
        draftBodyHash: null,
        safeSummary: "Draft and zero-publish STAGE verification bundle delivered.",
        metadata: {
          schemaVersion: DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION,
          draftArtifactRef: resolved.draft.artifactRef,
          draftVersionRef: input.draftVersionRef,
          draftContentHash: resolved.draft.contentHash,
          draftBodyHash: resolved.draft.draftBodyHash,
          integrityVerificationRef: input.integrityVerificationRef,
          stageVerificationRef: input.stageVerificationRef,
          clearVerified: true,
          editorEmptyAfter: true,
          submitMutationCount: 0,
          sendMutationCount: 0,
          realPublishEnabled: false,
          published: false,
          limitationCodes: [
            "stage_only_not_published",
            "not_intervention_or_effect_evidence"
          ],
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        },
        sourceRefs: evidenceRefs,
        regenerationRecipe: null,
        expiresAt: null
      })
  );
  assertArtifactPointer(pointer, contentHash);
  return {
    schemaVersion: DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION,
    status: "ready",
    bundle: pointer,
    draftVersionRef: input.draftVersionRef,
    integrityVerificationRef: input.integrityVerificationRef,
    stageVerificationRef: input.stageVerificationRef,
    stage: {
      clearVerified: true,
      editorEmptyAfter: true,
      submitMutationCount: 0,
      sendMutationCount: 0,
      realPublishEnabled: false,
      bodyPersisted: false,
      published: false
    },
    limitationCodes: [
      "stage_only_not_published",
      "not_intervention_or_effect_evidence"
    ],
    evidenceRefs: asJsonEvidenceRefs(evidenceRefs),
    observedAt: context.now,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

/**
 * Registers only L1 local artifact actions. Course scope, policy, idempotency,
 * lease and capability fields remain server-injected by the executor.
 */
export function createFacilitationArtifactToolRegistrations(
  deps: FacilitationArtifactToolDependencies
): readonly CourseToolRegistration[] {
  if (
    !deps ||
    typeof deps.composeIntent !== "function" ||
    typeof deps.renderDraft !== "function" ||
    typeof deps.resolveDeliveryInputs !== "function" ||
    typeof deps.createArtifactVersion !== "function" ||
    !deps.protectedStore ||
    typeof deps.protectedStore.put !== "function" ||
    typeof deps.protectedStore.getByRef !== "function"
  ) {
    throw new Error("Facilitation artifact tool dependencies are incomplete.");
  }
  const inputs = inputSchemas();
  const outputs = outputSchemas();
  const projectDraftOutput = (output: ReplyDraftCreateOutput) => ({
    model: {
      schemaVersion: output.schemaVersion,
      status: output.status,
      compositionRef: output.compositionRef,
      intentHash: output.intentHash,
      moveSpecHash: output.moveSpecHash,
      intentPolicyVersion: output.intentPolicyVersion,
      toolPolicyVersion: output.toolPolicyVersion,
      rendererReceiptRef: output.rendererReceiptRef,
      rendererReceiptHash: output.rendererReceiptHash,
      rendererVersion: output.rendererVersion,
      lint: output.lint,
      revisionKind: output.revisionKind,
      priorVersionRef: output.priorVersionRef,
      feedbackRef: output.feedbackRef,
      regenerationRecipeHash: output.regenerationRecipeHash,
      regenerationMaterialHash: output.regenerationMaterialHash,
      materialBindingHash: output.materialBindingHash,
      artifact: {
        artifactId: output.artifact.artifactId,
        versionId: output.artifact.versionId,
        artifactRef: output.artifact.artifactRef,
        versionRef: output.artifact.versionRef,
        version: output.artifact.version,
        contentHash: output.artifact.contentHash,
        contentClass: output.artifact.contentClass,
        draftBodyHash: output.artifact.draftBodyHash,
        expiresAt: output.artifact.expiresAt,
        bodyPersisted: false as const,
        recovery: "regenerate_and_reverify" as const
      },
      integrityVerificationRef: output.integrityVerificationRef,
      evidenceRefs: output.evidenceRefs,
      observedAt: output.observedAt,
      containsForumText: false as const,
      containsIdentity: false as const,
      containsSecrets: false as const
    },
    safeSummary:
      "Restricted transient reply draft metadata was versioned and verified; body was not persisted.",
    containsForumText: false as const,
    containsIdentity: false as const,
    containsSecrets: false as const
  });

  const intent = defineCourseTool({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "facilitation.intent.compose",
      version: "1",
      safeLabel: "Compose facilitation Intent",
      safeDescription:
        "Composes protocol-valid Intent and MoveSpec from one verified evidence selection.",
      capability: "L1_ARTIFACT",
      effect: "local_write",
      inputSchema: inputs.intent,
      outputSchema: outputs.intent,
      dataClasses: ["safe_generated", "verified_evidence_refs"],
      preconditions: [
        {
          code: "verified_evidence_selection",
          safeDescription:
            "Selection and integrity verification must resolve under the exact server course scope."
        },
        {
          code: "current_policy_binding",
          safeDescription:
            "Intent must bind the server policy and a non-expired candidate."
        }
      ],
      idempotency: { strategy: "input_hash", scope: "task" },
      evidence: {
        required: true,
        minimumRefs: 7,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "world",
          "coverage",
          "content_graph",
          "candidate",
          "decision",
          "verification"
        ]
      },
      verification: {
        required: true,
        subjectType: "artifact_version",
        verifiers: [{ ...INTENT_VERIFIER, required: true }],
        mode: "all",
        onFailure: "failed"
      },
      retry: {
        maxAttempts: 2,
        retryableStatuses: ["failed"],
        backoff: "exponential"
      }
    },
    handler: async ({ input, context }) => {
      const output = await composeIntentHandler(deps, input, context);
      return {
        output,
        evidenceRefs: output.evidenceRefs as readonly EvidenceRef[],
        verificationSubject: {
          type: "artifact_version",
          id: output.artifact.versionId
        },
        expiresAt: output.intent.candidateExpiresAt,
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: () =>
      "Compose one facilitation Intent from verified evidence references.",
    projectOutput: (output) => ({
      model: {
        schemaVersion: output.schemaVersion,
        status: output.status,
        compositionRef: output.compositionRef,
        intent: output.intent as CanonicalJsonValue,
        intentHash: output.intentHash,
        moveSpec: output.moveSpec as CanonicalJsonValue,
        moveSpecHash: output.moveSpecHash,
        intentPolicyVersion: output.intentPolicyVersion,
        toolPolicyVersion: output.toolPolicyVersion,
        selectionEvidenceBindingHash:
          output.selectionEvidenceBindingHash,
        evidenceBindingHash: output.evidenceBindingHash,
        integrityVerificationRef: output.integrityVerificationRef,
        receiptRef: output.receiptRef,
        receiptHash: output.receiptHash,
        artifact: output.artifact,
        evidenceRefs: output.evidenceRefs,
        observedAt: output.observedAt,
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      },
      safeSummary: "Facilitation Intent and MoveSpec were composed and verified.",
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    }),
    defaultForName: true
  });

  const draft = defineCourseTool({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "artifact.reply_draft.create",
      version: "1",
      safeLabel: "Create facilitation reply draft",
      safeDescription:
        "Renders and versions a restricted transient draft while persisting only hashes and a safe regeneration recipe.",
      capability: "L1_ARTIFACT",
      effect: "local_write",
      inputSchema: inputs.draft,
      outputSchema: outputs.draft,
      dataClasses: [
        "restricted_transient",
        "safe_generated",
        "verified_evidence_refs"
      ],
      preconditions: [
        {
          code: "verified_intent_composition",
          safeDescription:
            "Composition reference must resolve to the current protocol-valid Intent and MoveSpec."
        },
        {
          code: "restricted_body_boundary",
          safeDescription:
            "Draft body remains process-memory only and requires regeneration after process loss."
        }
      ],
      idempotency: { strategy: "input_hash", scope: "task" },
      evidence: {
        required: true,
        minimumRefs: 7,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "world",
          "coverage",
          "content_graph",
          "candidate",
          "decision",
          "artifact",
          "verification"
        ]
      },
      verification: {
        required: true,
        subjectType: "artifact_version",
        verifiers: [{ ...DRAFT_VERIFIER, required: true }],
        mode: "all",
        onFailure: "failed"
      },
      retry: {
        maxAttempts: 2,
        retryableStatuses: ["failed"],
        backoff: "exponential"
      }
    },
    handler: async ({ input, context }) => {
      const output = await createDraftHandler(deps, input, context);
      return {
        output,
        evidenceRefs: output.evidenceRefs as readonly EvidenceRef[],
        verificationSubject: {
          type: "artifact_version",
          id: output.artifact.versionId
        },
        expiresAt: output.artifact.expiresAt,
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: (input) =>
      input.revisionKind === "correction"
        ? "Create one corrected restricted transient facilitation draft."
        : "Create one restricted transient facilitation draft.",
    projectOutput: projectDraftOutput,
    defaultForName: true
  });

  const regenerateDraft = defineCourseTool({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "artifact.reply_draft.regenerate",
      version: "1",
      safeLabel: "Regenerate facilitation reply draft",
      safeDescription:
        "Rebuilds an unavailable restricted draft from a server-verified v2 checkpoint recipe, then versions and verifies a fresh protected handle.",
      capability: "L1_ARTIFACT",
      effect: "local_write",
      inputSchema: inputs.regenerateDraft,
      outputSchema: outputs.draft,
      dataClasses: [
        "restricted_transient",
        "safe_generated",
        "verified_evidence_refs"
      ],
      preconditions: [
        {
          code: "server_verified_recovery_material",
          safeDescription:
            "The server must inject one exact unavailable v2 draft and its passed verification binding."
        },
        {
          code: "deterministic_rebuild_and_reverification",
          safeDescription:
            "Stable body, renderer, lint and content hashes must be reproduced before a fresh protected handle is issued."
        }
      ],
      idempotency: { strategy: "input_hash", scope: "run" },
      evidence: {
        required: true,
        minimumRefs: 9,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "world",
          "coverage",
          "content_graph",
          "candidate",
          "decision",
          "artifact",
          "verification"
        ]
      },
      verification: {
        required: true,
        subjectType: "artifact_version",
        verifiers: [{ ...DRAFT_VERIFIER, required: true }],
        mode: "all",
        onFailure: "failed"
      },
      retry: {
        maxAttempts: 2,
        retryableStatuses: ["failed"],
        backoff: "exponential"
      }
    },
    handler: async ({ context }) => {
      const output = await regenerateDraftHandler(deps, context);
      return {
        output,
        evidenceRefs: output.evidenceRefs as readonly EvidenceRef[],
        verificationSubject: {
          type: "artifact_version" as const,
          id: output.artifact.versionId
        },
        expiresAt: output.artifact.expiresAt,
        containsForumText: false as const,
        containsIdentity: false as const,
        containsSecrets: false as const
      };
    },
    summarizeInput: () =>
      "Regenerate one unavailable restricted draft from server-verified checkpoint material.",
    projectOutput: projectDraftOutput,
    defaultForName: true
  });

  const delivery = defineCourseTool({
    definition: {
      schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
      name: "delivery.bundle.create",
      version: "1",
      safeLabel: "Create facilitation delivery bundle",
      safeDescription:
        "Creates a safe bundle only from a validated draft, passed evidence integrity and trusted zero-publish STAGE verification.",
      capability: "L1_ARTIFACT",
      effect: "local_write",
      inputSchema: inputs.delivery,
      outputSchema: outputs.delivery,
      dataClasses: ["safe_aggregate", "external_receipt"],
      preconditions: [
        {
          code: "validated_artifact_version",
          safeDescription:
            "Draft reference must resolve to an immutable validated restricted-transient version."
        },
        {
          code: "trusted_stage_verification",
          safeDescription:
            "Trusted STAGE receipt must prove clear, empty readback and zero publish mutations."
        }
      ],
      idempotency: { strategy: "input_hash", scope: "task" },
      evidence: {
        required: true,
        minimumRefs: 8,
        allowedKinds: [
          "manifest",
          "invocation",
          "snapshot",
          "world",
          "coverage",
          "content_graph",
          "candidate",
          "decision",
          "artifact",
          "stage_receipt",
          "verification"
        ]
      },
      verification: {
        required: true,
        subjectType: "artifact_version",
        verifiers: [{ ...DELIVERY_VERIFIER, required: true }],
        mode: "all",
        onFailure: "failed"
      },
      retry: {
        maxAttempts: 2,
        retryableStatuses: ["failed"],
        backoff: "exponential"
      }
    },
    handler: async ({ input, context }) => {
      const output = await createDeliveryHandler(deps, input, context);
      return {
        output,
        evidenceRefs: output.evidenceRefs as readonly EvidenceRef[],
        verificationSubject: {
          type: "artifact_version",
          id: output.bundle.versionId
        },
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: () =>
      "Create a delivery bundle from verified evidence, artifact and STAGE references.",
    projectOutput: (output) => ({
      model: {
        schemaVersion: output.schemaVersion,
        status: output.status,
        bundle: output.bundle,
        draftVersionRef: output.draftVersionRef,
        integrityVerificationRef: output.integrityVerificationRef,
        stageVerificationRef: output.stageVerificationRef,
        stage: output.stage,
        limitationCodes: output.limitationCodes,
        evidenceRefs: output.evidenceRefs,
        observedAt: output.observedAt,
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      },
      safeSummary:
        "Delivery bundle verified editor clear and zero publish mutations; no intervention or effect is claimed.",
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    }),
    defaultForName: true
  });

  // The core registry intentionally type-erases heterogeneous, already
  // validated registrations at this boundary (it performs the same erasure
  // internally). Runtime schemas retain the exact input/output contracts.
  return Object.freeze(
    [intent, draft, delivery, regenerateDraft].map(
      (registration) =>
        registration as unknown as CourseToolRegistration
    )
  );
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

function passed(code: string, safeSummary: string) {
  return { code, status: "passed" as const, safeSummary };
}

function failed(code: string, safeSummary: string) {
  return { code, status: "failed" as const, safeSummary };
}

/** Exact verifier shared by the course-tool path and the protected UI
 * correction path. Keeping this as one production function prevents the UI
 * path from merely asserting that lint/verification happened. */
export async function verifyReplyDraftCreateOutputV2(input: {
  readonly protectedStore: ProtectedArtifactStore;
  readonly taskId: string;
  readonly runId: string;
  readonly now: string;
  readonly output: unknown;
  readonly evidenceRefs: readonly EvidenceRef[];
}): Promise<CourseToolVerifierResult> {
  const output = parseReplyDraftCreateOutputV2(input.output);
  if (!output) {
    return verificationResult({
      checks: [
        failed(
          "protected_body_hash",
          "Draft output is not a closed mechanically verifiable v2 contract."
        ),
        failed(
          "restricted_transient_boundary",
          "Draft persistence or regeneration binding is invalid."
        ),
        failed(
          "privacy_claim_lint",
          "Draft lint receipt is incomplete or hash-mismatched."
        )
      ],
      evidenceRefs: input.evidenceRefs
    });
  }
  const body = await input.protectedStore
    .getByRef({
      ref: output.artifact.protectedRef,
      taskId: input.taskId,
      runId: input.runId,
      expectedDraftBodyHash: output.artifact.draftBodyHash,
      now: input.now
    })
    .catch(() => null);
  return verificationResult({
    checks: [
      body !== null &&
      hashTransientDraftBody(body) === output.artifact.draftBodyHash
        ? passed(
            "protected_body_hash",
            "Process-memory draft matches the canonical body hash."
          )
        : failed(
            "protected_body_hash",
            "Process-memory draft is unavailable or hash-mismatched."
          ),
      output.artifact.bodyPersisted === false &&
      output.artifact.recovery === "regenerate_and_reverify" &&
      output.regenerationRecipe.requireReverification === true
        ? passed(
            "restricted_transient_boundary",
            "Draft has a closed body-free v2 regeneration binding."
          )
        : failed(
            "restricted_transient_boundary",
            "Draft persistence or recovery boundary is invalid."
          ),
      output.lint.status === "passed" && output.lint.checks.length === 7
        ? passed(
            "privacy_claim_lint",
            "All bounded privacy and unsupported-claim checks passed."
          )
        : failed(
            "privacy_claim_lint",
            "Draft lint receipt is incomplete."
          )
    ],
    evidenceRefs: input.evidenceRefs
  });
}

/** Register these with the core verifier registry alongside the tool factory. */
export function createFacilitationArtifactVerifierRegistrations(
  deps: Pick<FacilitationArtifactToolDependencies, "protectedStore">
): readonly CourseToolVerifierRegistration[] {
  const intent: CourseToolVerifierRegistration = {
    definition: {
      ...INTENT_VERIFIER,
      safeLabel: "Facilitation Intent integrity"
    },
    verify: async ({ context, handlerResult }) => {
      const output = handlerResult.output as unknown as FacilitationIntentComposeOutput;
      const checks = [];
      try {
        const hashes = protocolHashes(output);
        checks.push(
          hashes.intentHash === output.intentHash &&
            hashes.moveSpecHash === output.moveSpecHash
            ? passed(
                "intent_movespec_hashes",
                "Intent and MoveSpec canonical hashes match."
              )
            : failed(
                "intent_movespec_hashes",
                "Intent or MoveSpec canonical hash does not match."
              )
        );
        const expectedContentHash = hashCourseToolValue(
          "facilitation-intent-artifact.v2",
          {
            schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
            intent: output.intent as CanonicalJsonValue,
            intentHash: output.intentHash,
            moveSpec: output.moveSpec as CanonicalJsonValue,
            moveSpecHash: output.moveSpecHash,
            receiptHash: output.receiptHash,
            intentPolicyVersion: output.intentPolicyVersion,
            toolPolicyVersion: output.toolPolicyVersion,
            selectionEvidenceBindingHash:
              output.selectionEvidenceBindingHash,
            evidenceBindingHash: output.evidenceBindingHash
          }
        );
        checks.push(
          output.artifact.contentHash === expectedContentHash
            ? passed(
                "artifact_content_hash",
                "Intent artifact object hash matches the protocol payload."
              )
            : failed(
                "artifact_content_hash",
                "Intent artifact object hash does not match."
              )
        );
        checks.push(
          output.intent.evidenceRefHash === output.evidenceBindingHash
            ? passed(
                "verified_evidence_binding",
                "Intent preserves the verified evidence binding."
              )
            : failed(
                "verified_evidence_binding",
                "Intent changed the verified evidence binding."
              )
        );
        checks.push(
          output.intent.policyVersion === output.intentPolicyVersion &&
            output.intentPolicyVersion === LIVE_FACILITATION_POLICY_VERSION &&
            output.toolPolicyVersion === context.policyVersion
            ? passed(
                "policy_domain_binding",
                "Intent and Course Tool policy domains are independently bound."
              )
            : failed(
                "policy_domain_binding",
                "Intent or Course Tool policy binding changed."
              )
        );
      } catch {
        checks.push(
          failed(
            "intent_protocol_parse",
            "Intent and MoveSpec protocol validation failed."
          )
        );
      }
      return verificationResult({
        checks,
        evidenceRefs: output.evidenceRefs as readonly EvidenceRef[]
      });
    }
  };

  const draft: CourseToolVerifierRegistration = {
    definition: {
      ...DRAFT_VERIFIER,
      safeLabel: "Facilitation reply draft integrity"
    },
    verify: async ({ context, handlerResult }) =>
      verifyReplyDraftCreateOutputV2({
        protectedStore: deps.protectedStore,
        taskId: context.taskId,
        runId: context.runId,
        now: context.now,
        output: handlerResult.output,
        evidenceRefs: handlerResult.evidenceRefs
      })
  };

  const delivery: CourseToolVerifierRegistration = {
    definition: {
      ...DELIVERY_VERIFIER,
      safeLabel: "Facilitation delivery bundle integrity"
    },
    verify: async ({ handlerResult }) => {
      const output = handlerResult.output as unknown as DeliveryBundleCreateOutput;
      return verificationResult({
        checks: [
          output.stage.clearVerified === true &&
          output.stage.editorEmptyAfter === true
            ? passed(
                "stage_safe_state",
                "Trusted STAGE receipt ends with a cleared empty editor."
              )
            : failed(
                "stage_safe_state",
                "Trusted STAGE safe-state proof is missing."
              ),
          output.stage.submitMutationCount === 0 &&
          output.stage.sendMutationCount === 0 &&
          output.stage.realPublishEnabled === false &&
          output.stage.published === false
            ? passed(
                "zero_publish_boundary",
                "Bundle proves zero submit/send mutations and no publication."
              )
            : failed(
                "zero_publish_boundary",
                "Bundle does not prove the zero-publish boundary."
              ),
          output.limitationCodes[1] ===
          "not_intervention_or_effect_evidence"
            ? passed(
                "evidence_claim_boundary",
                "Bundle does not claim intervention or educational effect."
              )
            : failed(
                "evidence_claim_boundary",
                "Bundle omitted the intervention/effect evidence limitation."
              )
        ],
        evidenceRefs: output.evidenceRefs as readonly EvidenceRef[]
      });
    }
  };

  return Object.freeze([intent, draft, delivery]);
}
